/**
 * Owner-identity resolution for client-owned daemon workers.
 *
 * The daemon hides a client-owned worker (and every RLM subagent under it) from
 * `list` unless the caller names the worker's `ownerClientId`. That id is only
 * available from the worker descriptor on disk, so this gate pins the exact
 * descriptor shape we depend on and every reason we must decline to use one:
 * a stopping worker, a dead worker, or a worker that is already visible.
 *
 * Synthetic descriptors only — no daemon required. The live counterpart is
 * test/owned-roster.live.mjs.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { resolveOwnerClientId, agentDirForSessionFile } = require("../dist/daemon-sidecar.cjs");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-owner-"));
const agentDir = path.join(root, "agent");
const sessionsDir = path.join(agentDir, "sessions");
const workersDir = path.join(agentDir, "daemon-workers");
fs.mkdirSync(sessionsDir, { recursive: true });

const sessionFile = path.join(sessionsDir, "01a02488-d25f-74a9-a39d-54057075d46c.jsonl");
const DEAD_PID = 2147480000; // far above any live pid on a normal machine

let workerSeq = 0;
function writeDescriptor(fields, { dir = "wk", name } = {}) {
	const workerDir = path.join(workersDir, dir);
	fs.mkdirSync(workerDir, { recursive: true });
	const workerId = name ?? `worker${(workerSeq += 1)}`;
	fs.writeFileSync(path.join(workerDir, `${workerId}.json`), JSON.stringify({ version: 1, workerId, ...fields }, null, 2));
	return workerId;
}

function reset() {
	fs.rmSync(workersDir, { recursive: true, force: true });
}

// --- no registry at all: a miss, never a throw -------------------------------
check("missing daemon-workers dir resolves to undefined", resolveOwnerClientId({ sessionFile, agentDir }) === undefined);

// --- the happy path: our own live client-owned worker ------------------------
reset();
writeDescriptor({
	pid: process.pid,
	rootActiveSessionId: "3beee2ef7b2f",
	ownerClientId: "daemon-client:owner-1",
	updatedAt: "2026-08-21T13:44:15.181Z",
	lifecycle: "ready",
	createCommand: { type: "create", sessionPath: sessionFile, config: { agentDir, executionMode: "rpc" } },
});
check("matches our worker by session path", resolveOwnerClientId({ sessionFile, agentDir }) === "daemon-client:owner-1");
check(
	"matches our worker by active session id alone",
	resolveOwnerClientId({ activeSessionId: "3beee2ef7b2f", agentDir }) === "daemon-client:owner-1",
);
check("another session's file does not borrow our identity", resolveOwnerClientId({ sessionFile: path.join(sessionsDir, "other.jsonl"), agentDir }) === undefined);
check("a lookup with no keys resolves to undefined", resolveOwnerClientId({ agentDir }) === undefined);

// --- workers we must decline to impersonate ---------------------------------
reset();
writeDescriptor({
	pid: process.pid,
	ownerClientId: undefined,
	updatedAt: "2026-08-21T13:44:15.181Z",
	createCommand: { sessionPath: sessionFile },
});
check("a visible worker (no ownerClientId) needs no identity", resolveOwnerClientId({ sessionFile, agentDir }) === undefined);

reset();
writeDescriptor({
	pid: process.pid,
	ownerClientId: "daemon-client:stopping",
	stopRequestedAt: "2026-08-21T13:44:16.000Z",
	updatedAt: "2026-08-21T13:44:15.181Z",
	createCommand: { sessionPath: sessionFile },
});
check("a worker with a stop intent is never claimed", resolveOwnerClientId({ sessionFile, agentDir }) === undefined);

reset();
writeDescriptor({
	pid: DEAD_PID,
	ownerClientId: "daemon-client:dead",
	updatedAt: "2026-08-21T13:44:15.181Z",
	createCommand: { sessionPath: sessionFile },
});
check("a dead worker is never claimed", resolveOwnerClientId({ sessionFile, agentDir }) === undefined);

// --- a reused session file: newest live descriptor wins ----------------------
reset();
writeDescriptor(
	{ pid: process.pid, ownerClientId: "daemon-client:older", updatedAt: "2026-08-20T10:00:00.000Z", createCommand: { sessionPath: sessionFile } },
	{ dir: "wk-a", name: "older" },
);
writeDescriptor(
	{ pid: process.pid, ownerClientId: "daemon-client:newer", updatedAt: "2026-08-21T10:00:00.000Z", createCommand: { sessionPath: sessionFile } },
	{ dir: "wk-b", name: "newer" },
);
check("the newest live descriptor wins for a reused session file", resolveOwnerClientId({ sessionFile, agentDir }) === "daemon-client:newer");

// --- sibling journals and damaged files must not derail the scan -------------
reset();
const wk = path.join(workersDir, "wk");
fs.mkdirSync(wk, { recursive: true });
fs.writeFileSync(path.join(wk, "live.recovery.jsonl"), '{"not":"a descriptor"}\n');
fs.writeFileSync(path.join(wk, "live.orphans.jsonl"), "\n");
fs.writeFileSync(path.join(wk, "damaged.json"), "{ this is not json");
fs.writeFileSync(path.join(wk, "empty.json"), "");
writeDescriptor(
	{ pid: process.pid, ownerClientId: "daemon-client:survivor", updatedAt: "2026-08-21T10:00:00.000Z", createCommand: { sessionPath: sessionFile } },
	{ dir: "wk", name: "live" },
);
check("journals and damaged descriptors are skipped, not fatal", resolveOwnerClientId({ sessionFile, agentDir }) === "daemon-client:survivor");

// --- agentDir derivation -----------------------------------------------------
check("agentDir is derived from a default-layout session file", agentDirForSessionFile(sessionFile) === agentDir);
check("a non-default session layout yields no derived agentDir", agentDirForSessionFile(path.join(root, "elsewhere", "s.jsonl")) === undefined);
check("no session file yields no derived agentDir", agentDirForSessionFile(undefined) === undefined);

// --- the claim's lifecycle on the sidecar ------------------------------------
// The identity is what lets us reach our own client-owned worker, and it is also
// what stops the daemon reaping that worker. Both directions are load-bearing.
require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");
const memory = new Map();
const memoryState = {
	get: (key, fallback) => (memory.has(key) ? memory.get(key) : fallback),
	update: (key, value) => { memory.set(key, value); return Promise.resolve(); },
};
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: memoryState, workspaceState: memoryState },
	{ append: () => {}, appendLine: () => {} },
);

function fakeSidecar(claim) {
	return { impersonateClientId: claim, connected: true, disposed: false, dispose() { this.disposed = true; } };
}

// Releasing on agent exit must drop the socket: that is the only thing that
// tells the daemon nobody answers to the owner id any more.
const claimed = fakeSidecar("daemon-client:owner-1");
controller.sidecar = claimed;
controller.ownerIdCache = { sessionFile, id: "daemon-client:owner-1", at: Date.now() };
controller.releaseOwnerIdentity();
check("releasing a claim disposes the sidecar", claimed.disposed === true);
check("releasing a claim drops the connection", controller.sidecar === null);
check("releasing a claim forgets the cached id", controller.ownerIdCache === null);

// A connection that never claimed anything is not holding a worker open, so
// tearing it down would only cost the operator their attachment.
const unclaimed = fakeSidecar(null);
controller.sidecar = unclaimed;
controller.ownerIdCache = { sessionFile, id: undefined, at: Date.now() };
controller.releaseOwnerIdentity();
check("releasing without a claim keeps the connection", unclaimed.disposed === false && controller.sidecar === unclaimed);
check("releasing without a claim still forgets the cache", controller.ownerIdCache === null);

// A descriptor caught mid-rewrite resolves to nothing. That must never be read
// as "drop the claim": it would tear down a live attachment for no reason.
const held = fakeSidecar("daemon-client:owner-1");
controller.sidecar = held;
controller.state = null; // no session file -> the lookup cannot resolve anything
await controller.ensureSidecar({ reattach: false });
check("an unresolvable lookup keeps the existing claim", held.disposed === false && controller.sidecar === held);

controller.dispose();

fs.rmSync(root, { recursive: true, force: true });

console.log(failed === 0 ? "\nPASS owner-visibility" : `\nFAIL owner-visibility (${failed})`);
process.exit(failed === 0 ? 0 : 1);
