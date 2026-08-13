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
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, open, readFile, realpath, rm, unlink } from "node:fs/promises";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DeleteSessionResult {
	ok: boolean;
	method?: "trash" | "unlink";
	error?: string;
}

async function canonicalSessionPath(sessionPath: string): Promise<string> {
	const resolvedPath = resolve(sessionPath);
	try {
		return await realpath(resolvedPath);
	} catch {
		try {
			return join(await realpath(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

async function leaseLockDir(sessionPath: string): Promise<string> {
	const key = createHash("sha256").update(await canonicalSessionPath(sessionPath)).digest("hex");
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
async function processStartId(pid: number): Promise<string | undefined> {
	if (process.platform === "win32") return undefined; // no cheap equivalent; treat as alive
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (startTime) return `proc:${startTime}`;
	} catch {
		// not Linux — fall through to ps, which is what macOS/BSD use
	}
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 1_000, maxBuffer: 8 * 1024 });
		const startTime = stdout.trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort check whether a resident session currently holds this session. */
export async function isSessionActive(sessionPath: string): Promise<boolean> {
	const lockDir = await leaseLockDir(sessionPath);
	const ownerPath = join(lockDir, "owner.json");
	try {
		const owner = JSON.parse(await readFile(ownerPath, "utf8")) as LeaseOwner;
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
			const current = await processStartId(owner.pid);
			return current === undefined || current === owner.processStartId;
		}
		return true;
	} catch {
		try {
			await lstat(ownerPath);
			return true; // unreadable owner: assume active
		} catch {
			return false;
		}
	}
}

function validSessionFileName(sessionPath: string, sessionId: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(sessionId) && basename(sessionPath) === `${sessionId}.jsonl`;
}

/**
 * Keep destructive/offline mutations constrained even if a future caller skips
 * SessionController's catalog-capability check. Symlinks are refused because a
 * session action must never follow a webview-controlled path outside its file.
 */
async function verifySessionFile(sessionPath: string, sessionId: string): Promise<string> {
	if (!validSessionFileName(sessionPath, sessionId)) {
		throw new Error("Invalid session file reference");
	}
	const stat = await lstat(sessionPath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Session reference is not a regular .jsonl file");
	}
	return resolve(sessionPath);
}

async function removeSessionFile(sessionPath: string, sessionId: string): Promise<DeleteSessionResult> {
	let verifiedPath: string;
	try {
		verifiedPath = await verifySessionFile(sessionPath, sessionId);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	const trashArgs = verifiedPath.startsWith("-") ? ["--", verifiedPath] : [verifiedPath];
	let trashError = "";
	try {
		await execFileAsync("trash", trashArgs, { timeout: 10_000, maxBuffer: 64 * 1024 });
		try {
			await lstat(verifiedPath);
		} catch {
			return { ok: true, method: "trash" };
		}
	} catch (err) {
		trashError = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim().split("\n")[0] : "";
	}
	try {
		// Re-check immediately before unlink: the earlier lstat is a validation
		// gate, not proof a concurrently replaced path is still safe.
		await verifySessionFile(verifiedPath, sessionId);
		await unlink(verifiedPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: trashError ? `${message} (trash: ${trashError})` : message };
	}
}

async function deleteSessionArtifacts(sessionId: string): Promise<void> {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
		throw new Error("Invalid session artifact identifier");
	}
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
const APPEND_TAIL_BYTES = 256 * 1024;

/** Read only the final complete JSONL record; historic transcripts can be huge. */
async function readAppendParent(sessionPath: string): Promise<{ parentId: string | null; needsLeadingNewline: boolean }> {
	const handle = await open(sessionPath, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0) throw new Error("Empty session file");
		const start = Math.max(0, size - APPEND_TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const tail = buffer.toString("utf8");
		const needsLeadingNewline = !tail.endsWith("\n");
		const lines = tail.split("\n");
		if (start > 0) lines.shift(); // first record may be a truncated prefix
		if (needsLeadingNewline) {
			const final = lines.pop();
			if (!final?.trim()) throw new Error("Session file ends with an incomplete record");
			try {
				const entry = JSON.parse(final) as { id?: unknown };
				return { parentId: typeof entry.id === "string" ? entry.id : null, needsLeadingNewline };
			} catch {
				throw new Error("Session file ends with an incomplete record");
			}
		}
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as { id?: unknown };
				return { parentId: typeof entry.id === "string" ? entry.id : null, needsLeadingNewline };
			} catch {
				throw new Error("Session file ends with an invalid record");
			}
		}
		throw new Error("Empty session file");
	} finally {
		await handle.close();
	}
}

async function appendEntry(sessionPath: string, sessionId: string, entry: Record<string, unknown>): Promise<void> {
	const verifiedPath = await verifySessionFile(sessionPath, sessionId);
	const { parentId, needsLeadingNewline } = await readAppendParent(verifiedPath);
	const id = randomBytes(16).toString("hex");
	const full = {
		...entry,
		id,
		parentId,
		timestamp: new Date().toISOString(),
	};
	// The tail read can take long enough for a concurrent actor to replace the
	// pathname. Revalidate immediately before the write; this is not a lease,
	// but it prevents an obvious symlink/file-type swap from becoming a write.
	await verifySessionFile(verifiedPath, sessionId);
	await appendFile(verifiedPath, `${needsLeadingNewline ? "\n" : ""}${JSON.stringify(full)}\n`, { encoding: "utf-8" });
}

/**
 * Rename an OFFLINE session file (trash-constraint identical to delete: active sessions are refused).
 * Appends a `session_info` entry matching packages/coding-agent/src/core/session-manager.ts
 * (SessionInfoEntry): {type:"session_info", id, parentId, timestamp, name}.
 */
export async function renameSessionOffline(sessionPath: string, sessionId: string, name: string): Promise<RenameSessionResult> {
	if (await isSessionActive(sessionPath)) {
		return { ok: false, error: "Session is live in another process — rename it from that client." };
	}
	const trimmed = name.trim();
	try {
		// An explicit empty string is the durable "clear title" record. Undefined
		// disappears from JSON and leaves the prior title as the latest one.
		await appendEntry(sessionPath, sessionId, { type: "session_info", name: trimmed });
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
export async function archiveSessionFile(sessionPath: string, sessionId: string): Promise<RenameSessionResult> {
	if (await isSessionActive(sessionPath)) {
		return { ok: false, error: "Session is live in another process — archive it after it becomes inactive." };
	}
	try {
		await appendEntry(sessionPath, sessionId, { type: "session_state", state: { status: "archived" } });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Delete session file (trash-first) and its artifacts — same semantics as the CLI. */
export async function deleteSession(sessionPath: string, sessionId: string): Promise<DeleteSessionResult> {
	if (await isSessionActive(sessionPath)) {
		return { ok: false, error: "Session is live in another process" };
	}
	const result = await removeSessionFile(sessionPath, sessionId);
	if (result.ok) {
		await deleteSessionArtifacts(sessionId);
	}
	return result;
}
