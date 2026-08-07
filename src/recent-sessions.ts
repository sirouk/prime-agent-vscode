/**
 * Scans ~/.prime/agent/sessions for persisted sessions belonging to the current
 * workspace. Session files are JSONL with a `type: "session"` header containing
 * the cwd, so the current workspace's history can be listed cheaply without
 * asking the daemon.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { realpathSync } from "node:fs";
import type { RecentSession } from "./protocol.js";

const MAX_SCAN = 400;

function sessionsDir(): string {
	return path.join(os.homedir(), ".prime", "agent", "sessions");
}

interface SessionHeader {
	cwd?: string;
	timestamp?: string;
	id?: string;
}

async function readHeader(filePath: string): Promise<{ header: SessionHeader; name?: string; firstPrompt?: string }> {
	const stream = fs.createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let header: SessionHeader = {};
	let name: string | undefined;
	let firstPrompt: string | undefined;
	let lines = 0;
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
			if (lines > 60 || (name && firstPrompt)) break;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (!name && (entry.type === "session_name" || entry.type === "session_info")) {
					const candidate = (entry.name ?? entry.sessionName) as string | undefined;
					if (candidate) name = candidate;
				}
				if (!firstPrompt && entry.type === "message") {
					const message = entry.message as { role?: string; content?: unknown } | undefined;
					if (message?.role === "user") {
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
	const tailName = await readTailName(filePath);
	return { header, name: tailName ?? name, firstPrompt };
}

/**
 * Session renames append `session_info` entries at the END of the file. The
 * head scan caps at 60 lines, so late renames would be invisible — read the
 * tail and let the latest entry win.
 */
async function readTailName(filePath: string): Promise<string | undefined> {
	const CHUNK = 16_384;
	let handle: fs.promises.FileHandle | null = null;
	try {
		handle = await fs.promises.open(filePath, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - CHUNK);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const tail = buffer.toString("utf8");
		const lines = tail.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]) as Record<string, unknown>;
				if (entry.type === "session_info" || entry.type === "session_name") {
					const name = (entry.name ?? entry.sessionName) as string | undefined;
					if (name && name.trim()) return name.trim();
					// An empty name explicitly clears the title.
					if (name !== undefined && !name.trim()) return undefined;
				}
			} catch {
				// ignore malformed lines
			}
		}
		return undefined;
	} catch {
		return undefined;
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

/**
 * List recent sessions, newest first. Sessions matching the workspace root are
 * flagged `inWorkspace`; all others are included too — prime-agent sessions are
 * resumable from any cwd, and the group header makes the distinction visible.
 */
export async function listRecentSessions(workspaceRoot: string, limit = 40): Promise<RecentSession[]> {
	const dir = sessionsDir();
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = entries
		.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
		.map((e) => path.join(dir, e.name))
		.slice(0, MAX_SCAN);

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

	const sorted = withMtime
		.filter((x): x is { file: string; mtime: number } => x !== null)
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, 80);

	const normalizedRoot = normalizePath(workspaceRoot);
	const results: RecentSession[] = [];
	for (const { file, mtime } of sorted) {
		if (results.length >= limit) break;
		const { header, name, firstPrompt } = await readHeader(file);
		if (!header.cwd) continue;
		const inWorkspace = normalizePath(header.cwd) === normalizedRoot;
		results.push({
			id: path.basename(file, ".jsonl"),
			path: file,
			cwd: header.cwd,
			timestamp: header.timestamp ?? new Date().toISOString(),
			modifiedMs: mtime,
			name,
			firstPrompt,
			inWorkspace,
		});
	}
	// Workspace sessions first, then everything else, both newest-first.
	results.sort((a, b) => Number(b.inWorkspace) - Number(a.inWorkspace));
	return results;
}

function normalizePath(p: string): string {
	let resolved = path.resolve(p);
	try {
		resolved = realpathSync.native(resolved);
	} catch {
		// path may not exist; keep resolved form
	}
	if (process.platform === "darwin") resolved = resolved.toLowerCase();
	return resolved.replace(/[/\\]+$/, "");
}
