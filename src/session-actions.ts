/**
 * Client-side session file management mirroring the CLI's conventions
 * (packages/coding-agent/src/core/session-file-actions.ts and session-lease.ts):
 * - Delete moves the session .jsonl to Trash when the `trash` CLI is available,
 *   falling back to unlink, then permanently removes session artifacts.
 * - "Archive" does not exist as a separate primitive: Trash is the recoverable
 *   path, artifacts are gone for good. Active (leased) sessions are refusable.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
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
				return true;
			} catch {
				return false; // stale lock
			}
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

/** Delete session file (trash-first) and its artifacts — same semantics as the CLI. */
export async function deleteSession(sessionPath: string): Promise<DeleteSessionResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}
