/**
 * Client-side session file management mirroring the CLI's conventions
 * (packages/coding-agent/src/core/session-file-actions.ts and session-lease.ts):
 * - Delete moves the session .jsonl to Trash when the `trash` CLI is available,
 *   falling back to unlink, then permanently removes session artifacts.
 * - Archive is the CLI's other primitive, bound to the same key on a live row
 *   ("stop/deactivate", agents-view-mode.ts): kill the agent, then append
 *   {status:"archived"} to the jsonl. The transcript survives; the session just
 *   leaves the roster. Delete is the destructive one.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, rm, unlink } from "node:fs/promises";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface DeleteSessionResult {
	ok: boolean;
	method?: "trash" | "unlink";
	error?: string;
}

function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function leaseLockDir(sessionPath: string): string {
	const key = createHash("sha256").update(canonicalSessionPath(sessionPath)).digest("hex");
	return join(os.homedir(), ".prime", "agent", "session-leases", `${key}.lock`);
}

interface LeaseOwner {
	pid?: number;
	/** Process start stamp recorded by the CLI, e.g. "ps:Fri Aug  7 11:52:57 2026". */
	processStartId?: string;
}

/**
 * Process start stamp in the format session-lease.ts writes, so a recycled pid
 * can be told apart from the process that actually took the lease.
 */
function processStartId(pid: number): string | undefined {
	if (process.platform === "win32") return undefined; // no cheap equivalent; treat as alive
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// not Linux — fall through to ps, which is what macOS/BSD use
	}
	try {
		const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8" });
		const startTime = out.stdout?.trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort check whether a resident session currently holds this session. */
export function isSessionActive(sessionPath: string): boolean {
	const lockDir = leaseLockDir(sessionPath);
	const ownerPath = join(lockDir, "owner.json");
	if (!existsSync(ownerPath)) return false;
	try {
		const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LeaseOwner;
		if (typeof owner.pid === "number" && owner.pid > 0) {
			try {
				process.kill(owner.pid, 0);
			} catch {
				return false; // stale lock
			}
			// The pid being alive is not enough: after a crash + reboot the OS hands
			// that number to an unrelated process and the lease would block delete
			// and rename forever. isLeaseOwnerAlive (session-lease.ts) compares the
			// start stamp; an absent/unknown stamp counts as alive there too.
			if (!owner.processStartId) return true;
			const current = processStartId(owner.pid);
			return current === undefined || current === owner.processStartId;
		}
		return true;
	} catch {
		return true; // unreadable owner: assume active
	}
}

async function removeSessionFile(sessionPath: string): Promise<DeleteSessionResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stderr = trashResult.stderr?.trim().split("\n")[0];
		return { ok: false, error: stderr ? `${message} (trash: ${stderr})` : message };
	}
}

async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
	if (!sessionId) return;
	const artifactDir = join(os.homedir(), ".prime", "agent", "session-artifacts", sessionId);
	await rm(artifactDir, { recursive: true, force: true });
}

export interface RenameSessionResult {
	ok: boolean;
	error?: string;
}

/**
 * Append one entry to a session jsonl the way SessionManager._persist does:
 * `JSON.stringify(entry) + "\n"`, chained to the current leaf. The trailing
 * newline is not cosmetic — the CLI appends without one of its own, so an entry
 * written without it gets concatenated onto the next line the daemon writes.
 */
async function appendEntry(sessionPath: string, entry: Record<string, unknown>): Promise<void> {
	const lines = readFileSync(sessionPath, "utf-8").split("\n").filter((l) => l.trim());
	if (lines.length === 0) throw new Error("Empty session file");
	const taken = new Set<string>();
	for (const line of lines) {
		try {
			const id = (JSON.parse(line) as { id?: string }).id;
			if (id) taken.add(id);
		} catch {
			// ignore malformed lines
		}
	}
	let id = "";
	do {
		id = createHash("sha256").update(`${sessionPath}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8);
	} while (taken.has(id));
	const full = {
		...entry,
		id,
		parentId: (JSON.parse(lines[lines.length - 1]) as { id?: string }).id ?? null,
		timestamp: new Date().toISOString(),
	};
	await appendFile(sessionPath, `${JSON.stringify(full)}\n`, { encoding: "utf-8" });
}

/**
 * Rename an OFFLINE session file (trash-constraint identical to delete: active sessions are refused).
 * Appends a `session_info` entry matching packages/coding-agent/src/core/session-manager.ts
 * (SessionInfoEntry): {type:"session_info", id, parentId, timestamp, name}.
 */
export async function renameSessionOffline(sessionPath: string, name: string): Promise<RenameSessionResult> {
	if (isSessionActive(sessionPath)) {
		return { ok: false, error: "Session is live in another process — rename it from that client." };
	}
	const trimmed = name.trim();
	try {
		await appendEntry(sessionPath, { type: "session_info", name: trimmed.length > 0 ? trimmed : undefined });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Archive a session file: append `{type:"session_state", state:{status:"archived"}}`,
 * exactly what the CLI persists after killing an agent (agents-view-mode.ts
 * deactivatePendingAgent). The transcript is untouched; the session simply drops
 * out of the roster. Callers must kill a resident session FIRST — otherwise the
 * daemon rewrites the file from its own entry list and drops this entry.
 */
export async function archiveSessionFile(sessionPath: string): Promise<RenameSessionResult> {
	try {
		await appendEntry(sessionPath, { type: "session_state", state: { status: "archived" } });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Delete session file (trash-first) and its artifacts — same semantics as the CLI. */
export async function deleteSession(sessionPath: string): Promise<DeleteSessionResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}
