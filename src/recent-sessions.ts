/**
 * On-disk fallback catalog. Session files are JSONL with a `type: "session"`
 * header containing the cwd, so history can be listed without the daemon.
 *
 * This is the FALLBACK only: SessionController prefers the daemon's own
 * `list all` catalog, which has already read every file end to end and knows
 * each session's current name, message count and lifecycle exactly. A file scan
 * cannot afford that (see TAIL_BYTES), so it approximates — and the two must
 * agree on which sessions count as history, or the list changes shape depending
 * on whether the daemon happened to answer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { realpathSync } from "node:fs";
import type { RecentSession } from "./protocol.js";

/** Files whose heads we are willing to open on one refresh, newest-mtime first. */
const MAX_SCAN = 400;
/**
 * How far back we look for late `session_info` (rename) and `session_state`
 * (archive) entries. Both are appended at the then-current end of file, so a
 * rename buried under more than this much later traffic is invisible here — the
 * daemon catalog is the only exact source for those, which is why it is tried
 * first.
 */
const TAIL_BYTES = 128 * 1024;

function sessionsDir(): string {
	return path.join(os.homedir(), ".prime", "agent", "sessions");
}

interface SessionHeader {
	cwd?: string;
	timestamp?: string;
	id?: string;
}

interface SessionRow {
	header: SessionHeader;
	name?: string;
	firstPrompt?: string;
	/** False only when we reached EOF without seeing a message — i.e. a real draft. */
	hasMessage: boolean;
	archived: boolean;
}

async function readSessionRow(filePath: string): Promise<SessionRow> {
	const stream = fs.createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let header: SessionHeader = {};
	let name: string | undefined;
	let firstPrompt: string | undefined;
	let hasMessage = false;
	let lines = 0;
	// A draft is a session with no message at all; those files are a handful of
	// lines long, so "we read to EOF and saw none" is exact. Hitting the head cap
	// first means the file is big enough that we must not call it empty.
	let cappedEarly = false;
	try {
		for await (const line of rl) {
			lines += 1;
			if (lines === 1) {
				try {
					header = JSON.parse(line) as SessionHeader;
				} catch {
					break;
				}
				continue;
			}
			if (lines > 60 || (name && firstPrompt && hasMessage)) {
				cappedEarly = true;
				break;
			}
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (!name && (entry.type === "session_name" || entry.type === "session_info")) {
					const candidate = (entry.name ?? entry.sessionName) as string | undefined;
					if (candidate) name = candidate;
				}
				if (entry.type === "message") {
					hasMessage = true;
					const message = entry.message as { role?: string; content?: unknown } | undefined;
					if (!firstPrompt && message?.role === "user") {
						firstPrompt = extractUserText(message.content);
					}
				}
			} catch {
				// ignore malformed lines
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	const tail = await readTail(filePath);
	return {
		header,
		name: tail.name ?? name,
		firstPrompt,
		hasMessage: hasMessage || cappedEarly,
		archived: tail.archived,
	};
}

/**
 * Renames and lifecycle transitions append entries at the END of the file, so
 * the head scan never sees them. Read the tail and let the latest entry win.
 */
async function readTail(filePath: string): Promise<{ name?: string; archived: boolean }> {
	let handle: fs.promises.FileHandle | null = null;
	try {
		handle = await fs.promises.open(filePath, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		// Short reads are legal: decode only what was actually read, or the NUL
		// padding turns the final (most authoritative) record into garbage.
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
		let name: string | undefined;
		let nameResolved = false;
		let archived: boolean | undefined;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			// Cheap gate: the tail is mostly multi-KB message rows and parsing them
			// all would cost more than the read did.
			if (!line.includes('"session_info"') && !line.includes('"session_name"') && !line.includes('"session_state"')) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // the first line of the window is usually truncated
			}
			if (!nameResolved && (entry.type === "session_info" || entry.type === "session_name")) {
				const candidate = (entry.name ?? entry.sessionName) as string | undefined;
				// An empty name explicitly clears the title.
				if (candidate !== undefined) {
					name = candidate.trim() || undefined;
					nameResolved = true;
				}
			}
			if (archived === undefined && entry.type === "session_state") {
				const status = (entry.state as { status?: string } | undefined)?.status;
				if (status) archived = status === "archived" || status === "crash";
			}
			if (nameResolved && archived !== undefined) break;
		}
		return { name, archived: archived === true };
	} catch {
		return { archived: false };
	} finally {
		if (handle) await handle.close();
	}
}

function extractUserText(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content.slice(0, 120);
	}
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const text = (part as { text?: string }).text;
				if (text) return text.slice(0, 120);
			}
		}
	}
	return undefined;
}

export interface RecentSessionsOptions {
	/** Rows kept for the current workspace. Filled independently so it can't be starved. */
	workspaceLimit?: number;
	/** Rows kept for every other folder combined. */
	otherLimit?: number;
	/** Sessions directory override — the CLI calls the same knob `sessionDir`. */
	sessionsDir?: string;
}

/**
 * List recent sessions, newest first, workspace bucket first. The two buckets
 * have SEPARATE quotas and are filled in the same pass: a single global cap
 * applied before bucketing let 20-odd throwaway sessions from other folders
 * push this workspace's own history off the list entirely.
 *
 * Zero-message drafts and archived sessions are omitted, matching the CLI's
 * inactiveLifecycleForSession/shouldShowAgentsViewSession.
 */
export async function listRecentSessions(workspaceRoot: string, options: RecentSessionsOptions = {}): Promise<RecentSession[]> {
	const workspaceLimit = options.workspaceLimit ?? 60;
	const otherLimit = options.otherLimit ?? 25;
	const dir = options.sessionsDir ?? sessionsDir();
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name));

	const withMtime = await Promise.all(
		files.map(async (file) => {
			try {
				const stat = await fs.promises.stat(file);
				return { file, mtime: stat.mtimeMs };
			} catch {
				return null;
			}
		}),
	);

	// Cap AFTER sorting: slicing in readdir order picked an arbitrary subset of a
	// large store and then called it "recent".
	const sorted = withMtime
		.filter((x): x is { file: string; mtime: number } => x !== null)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, MAX_SCAN);

	const normalizedRoot = normalizeFsPath(workspaceRoot);
	const inWorkspaceRows: RecentSession[] = [];
	const otherRows: RecentSession[] = [];
	for (const { file, mtime } of sorted) {
		if (inWorkspaceRows.length >= workspaceLimit && otherRows.length >= otherLimit) break;
		// One unreadable file (deleted between the scan and the read, permissions,
		// a truncated write) must not cost the operator the other 399 rows.
		let row: SessionRow;
		try {
			row = await readSessionRow(file);
		} catch {
			continue;
		}
		if (!row.header.cwd) continue;
		// Archived is not a reason to hide a session — see rowsFromCatalog. A scan
		// cannot know liveness, so every row it produces is "inactive"; the daemon
		// catalog is what promotes one to idle or running when it answers.
		if (!row.hasMessage) continue;
		const inWorkspace = normalizeFsPath(row.header.cwd) === normalizedRoot;
		const bucket = inWorkspace ? inWorkspaceRows : otherRows;
		if (bucket.length >= (inWorkspace ? workspaceLimit : otherLimit)) continue;
		bucket.push({
			id: path.basename(file, ".jsonl"),
			path: file,
			cwd: row.header.cwd,
			timestamp: row.header.timestamp ?? new Date().toISOString(),
			modifiedMs: mtime,
			name: row.name,
			firstPrompt: row.firstPrompt,
			inWorkspace,
			status: "inactive",
		});
	}
	// Both buckets inherit the mtime-descending scan order.
	return [...inWorkspaceRows, ...otherRows];
}

/** Case/symlink-normalized absolute path, so cwd comparisons survive /var vs /private/var. */
export function normalizeFsPath(p: string): string {
	let resolved = path.resolve(p);
	try {
		resolved = realpathSync.native(resolved);
	} catch {
		// path may not exist; keep resolved form
	}
	if (process.platform === "darwin") resolved = resolved.toLowerCase();
	return resolved.replace(/[/\\]+$/, "");
}
