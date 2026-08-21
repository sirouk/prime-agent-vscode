/**
 * Owner identity for client-owned daemon workers.
 *
 * The daemon only lists a worker's sessions when the worker is "visible"
 * (`ownerClientId === undefined`) or when the caller passes
 * `includeClientOwned: true` AND is the exact daemon client that owns it
 * (daemon-supervisor.ts `handleList` / `isVisibleWorker` /
 * `isWorkerAccessibleToClient`).
 *
 * RPC-mode sessions — which is what this extension spawns — are created with
 * `lifecycle: "client_owned"`, so the worker hosting our own root and every RLM
 * subagent under it carries an `ownerClientId`. Our sidecar is a SEPARATE
 * socket connection with a different protocol client id, so a plain
 * `{type:"list", all:true}` returns neither our live root nor any subagent: the
 * root falls back to a stale on-disk row (isSessionActive:false) and the
 * subagent strip is always empty.
 *
 * The daemon has no command that hands a client its own worker's owner id, and
 * the id is a per-connection `daemon-client:${randomUUID()}` with no env
 * override. It is, however, written to the worker descriptor on disk, which is
 * where we read it from.
 *
 * Nothing here mutates daemon state: this is a read of our OWN worker's
 * descriptor so a roster read can name the identity it already has.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The subset of `<agentDir>/daemon-workers/<dir>/<workerId>.json` we rely on. */
export interface WorkerDescriptorRef {
	workerId?: string;
	pid?: number;
	rootActiveSessionId?: string;
	ownerClientId?: string;
	updatedAt?: string;
	createdAt?: string;
	lifecycle?: string;
	stopRequestedAt?: string;
	createCommand?: {
		sessionPath?: string;
		config?: { agentDir?: string; executionMode?: string };
	};
}

export interface OwnerLookup {
	/** Our RPC session's on-disk file (`state.sessionFile`). The strongest key. */
	sessionFile?: string;
	/** Our root's 12-char daemon handle, when the host happens to know it. */
	activeSessionId?: string;
	/** Overridable for tests; defaults to the dir implied by `sessionFile`. */
	agentDir?: string;
}

/**
 * `<agentDir>/sessions/<uuid>.jsonl` -> `<agentDir>`. Derived from the session
 * file rather than assumed, so a custom `--session-dir`/`PRIME_AGENT_DIR`
 * layout resolves to the same worker registry the daemon actually wrote to.
 */
export function agentDirForSessionFile(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const sessionsDir = path.dirname(path.resolve(sessionFile));
	if (path.basename(sessionsDir) !== "sessions") return undefined;
	return path.dirname(sessionsDir);
}

/** Last-resort location when no session file is known yet. */
export function defaultAgentDir(): string {
	const configured = process.env.PRIME_AGENT_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(os.homedir(), ".prime", "agent");
}

/** A worker whose process is gone must never lend its identity to a roster read. */
function processAlive(pid: number | undefined): boolean {
	if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function readDescriptor(file: string): WorkerDescriptorRef | undefined {
	try {
		const raw = fs.readFileSync(file, "utf8");
		if (!raw.trim()) return undefined;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed as WorkerDescriptorRef;
	} catch {
		// A descriptor being rewritten, removed, or unreadable is normal. The
		// caller degrades to the un-owned roster read, never to an exception.
		return undefined;
	}
}

function samePath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = path.resolve(a);
	const right = path.resolve(b);
	if (left === right) return true;
	// macOS/Windows session dirs are case-insensitive in practice.
	return process.platform !== "linux" && left.toLowerCase() === right.toLowerCase();
}

function descriptorFiles(agentDir: string): string[] {
	const root = path.join(agentDir, "daemon-workers");
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		let entries: string[];
		try {
			entries = fs.readdirSync(path.join(root, dir.name));
		} catch {
			continue;
		}
		for (const entry of entries) {
			// Sibling journals share the stem: `<workerId>.recovery.jsonl`,
			// `<workerId>.orphans.jsonl`. Only the bare `.json` is a descriptor.
			if (!entry.endsWith(".json") || entry.includes(".recovery.") || entry.includes(".orphans.")) continue;
			files.push(path.join(root, dir.name, entry));
		}
	}
	return files;
}

function timeOf(descriptor: WorkerDescriptorRef): number {
	const stamp = Date.parse(descriptor.updatedAt ?? descriptor.createdAt ?? "");
	return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * The `ownerClientId` of the live worker hosting our own session, or undefined
 * when there is nothing to impersonate — no descriptor, no match, a stopping or
 * dead worker, or a worker that is already visible to every client.
 *
 * Undefined is a normal answer and means "read the roster as ourselves".
 */
export function resolveOwnerClientId(lookup: OwnerLookup): string | undefined {
	if (!lookup.sessionFile && !lookup.activeSessionId) return undefined;
	// The worker registry lives under the daemon's agentDir, which only equals
	// the session file's parent when the default layout is in use. A configured
	// `--session-dir` puts sessions elsewhere, so the default dir stays in the
	// candidate set rather than being silently replaced.
	const candidates = lookup.agentDir
		? [lookup.agentDir]
		: [agentDirForSessionFile(lookup.sessionFile), defaultAgentDir()].filter((dir): dir is string => !!dir);
	const roots = [...new Set(candidates.map((dir) => path.resolve(dir)))];
	const files = roots.flatMap((dir) => descriptorFiles(dir));
	let best: { descriptor: WorkerDescriptorRef; at: number } | undefined;
	for (const file of files) {
		const descriptor = readDescriptor(file);
		if (!descriptor?.ownerClientId) continue;
		// A worker with a stop intent is on its way out; claiming its identity
		// would only cancel the cleanup the daemon already decided to run.
		if (descriptor.stopRequestedAt) continue;
		const matches =
			samePath(descriptor.createCommand?.sessionPath, lookup.sessionFile) ||
			(!!lookup.activeSessionId && descriptor.rootActiveSessionId === lookup.activeSessionId);
		if (!matches) continue;
		if (!processAlive(descriptor.pid)) continue;
		const at = timeOf(descriptor);
		// A session file can be reused across runs (`--continue`), so the newest
		// live descriptor is the one hosting us now.
		if (!best || at > best.at) best = { descriptor, at };
	}
	return best?.descriptor.ownerClientId;
}
