/**
 * prime-agent v0.9 roster/closing parity regressions.
 *
 * v0.9 changed the daemon's behavior, not its wire shapes: rows now carry the
 * shared classifier's verdict (rosterStatus/statusLabel), daemon_closing
 * announces shutdowns and updates before the socket dies, roster_update offers
 * push instead of polling, and attach can transiently fail while a worker
 * recovers. Each of these got a dedicated host behavior, and each behavior is
 * one regression away from silently disagreeing with the CLI again.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-roster-parity-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "roster-parity", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const memory = new Map();
const state = { get: (key, fallback) => (memory.has(key) ? memory.get(key) : fallback), update: (key, value) => { memory.set(key, value); return Promise.resolve(); } };
const posts = [];
function makeController() {
	const controller = new SessionController(
		{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: state, workspaceState: state },
		{ append: () => {}, appendLine: () => {} },
	);
	controller.attach({ post: (message) => posts.push(message) });
	return controller;
}
const controller = makeController();
const notices = () => posts.filter((p) => p.type === "notice").map((p) => p.text);

// --- rosterStatus: the daemon's verdict wins over local recomputation --------
const rosterStatus = SessionController.rosterStatus ?? controller.constructor.rosterStatus;
check("rosterStatus is reachable for the probe", typeof rosterStatus === "function");
// v0.9 row: lease held but session quiet -> the CLI says "idle"; the old mirror
// said "running". Trusting the row fixes the strip disagreeing with the CLI.
check(
	"a v0.9 row's advertised idle wins over a held lease",
	rosterStatus({ activeSessionId: "h1", rosterStatus: "idle", isSessionActive: true, activity: "idle" }) === "idle",
);
check(
	"a v0.9 row's advertised running stands on its own",
	rosterStatus({ activeSessionId: "h2", rosterStatus: "running", activity: "idle" }) === "running",
);
check(
	"advertised inactive beats busy-looking legacy bits",
	rosterStatus({ activeSessionId: "h3", rosterStatus: "inactive", isSessionActive: true, hasRunningRlmChildren: true }) === "inactive",
);
// Fallback (pre-v0.9 daemon, no rosterStatus on the wire): unchanged mirror.
check(
	"fallback still counts a held lease as running",
	rosterStatus({ activeSessionId: "h4", isSessionActive: true, activity: "idle" }) === "running",
);
check("fallback still calls a quiet resident idle", rosterStatus({ activeSessionId: "h5", activity: "idle" }) === "idle");
check("fallback still calls the registry row inactive", rosterStatus({}) === "inactive");

// --- transient worker-recovery attach errors ---------------------------------
const isTransient = SessionController.isTransientWorkerAttachError ?? controller.constructor.isTransientWorkerAttachError;
check("isTransientWorkerAttachError is reachable", typeof isTransient === "function");
for (const message of [
	'Session "/tmp/x.jsonl" worker recovery was interrupted; retry opening the session',
	'Session "/tmp/x.jsonl" worker is stopping',
	'Session "/tmp/x.jsonl" worker is recovering',
	'Session "/tmp/x.jsonl" worker is unavailable for reuse: assigned root session is missing',
	'Session "/tmp/x.jsonl" is registered to a failed worker that could not be safely reclaimed',
	"Session worker is not connected",
]) {
	check(`transient: ${message.slice(0, 60)}`, isTransient(message) === true);
}
for (const message of [
	"Unknown active session", // foreign-owned: NOT retryable, the observe fallback belongs here
	"Session is already active in abc123: /tmp/x.jsonl",
	"daemon command timed out: attach", // unknown outcome: never auto-retry a maybe-committed attach
	"daemon socket closed",
]) {
	check(`not transient: ${message.slice(0, 50)}`, isTransient(message) === false);
}

// --- runReattach keeps the attempt across a transient failure ---------------
posts.length = 0;
const failingSidecar = {
	connected: true,
	connect: async () => {},
	list: async () => [],
	dispose: () => {},
	detach: async () => {},
	attach: async () => {
		throw new Error('Session "/tmp/x.jsonl" worker recovery was interrupted; retry opening the session');
	},
};
controller.sidecar = failingSidecar;
controller.attached = null;
controller.attachedEpoch = null;
controller.attachAttempt = { activeSessionId: "h-T", sessionPath: path.join(workdir, "t.jsonl"), sessionId: "t" };
controller.attachAttemptEpoch = controller.viewEpoch;
await controller.ensureSidecar();
check("a transient worker-recovery attach failure keeps the reconnect intent", controller.attachAttempt !== null);
check("a transient failure never restores over the queued view", controller.observationRestoring === false);
controller.clearReattachTimer?.();

// ...but a genuine failure still ends the attempt, exactly as before.
failingSidecar.attach = async () => {
	throw new Error("Unknown active session");
};
controller.attachAttempt = { activeSessionId: "h-T", sessionPath: path.join(workdir, "t.jsonl"), sessionId: "t" };
controller.attachAttemptEpoch = controller.viewEpoch;
await controller.ensureSidecar();
check("a genuine attach failure still drops the reconnect intent", controller.attachAttempt === null);
controller.clearReattachTimer?.();
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;

// --- daemon_closing is heard even with no attachment -------------------------
posts.length = 0;
controller.onDaemonEvent({ type: "daemon_closing", reason: "update" });
check("daemon_closing update is recorded", controller.daemonClosingReason === "update");
check(
	"daemon_closing update explains the view will come back",
	notices().some((text) => /updating/i.test(text)),
	JSON.stringify(notices().slice(-2)),
);
controller.onDaemonEvent({ type: "daemon_closing", reason: "shutdown" });
check("daemon_closing shutdown is recorded", controller.daemonClosingReason === "shutdown");
check(
	"daemon_closing shutdown names the shutdown",
	notices().some((text) => /shutting down/i.test(text)),
);
controller.daemonClosingReason = null;

// --- roster_update drives refreshes without an attachment --------------------
controller.onDaemonEvent({ type: "roster_update", changed: [], removed: [], resync: true });
check("roster_update schedules a history refresh", controller.historyRefreshTimer !== null);
check("roster_update schedules a children refresh", controller.childrenTimer !== null || controller.childrenRefreshInFlight === true);
clearTimeout(controller.historyRefreshTimer);
controller.historyRefreshTimer = null;
if (controller.childrenTimer) clearTimeout(controller.childrenTimer);
controller.childrenTimer = null;

// --- roster subscription is capability-gated and fake-safe -------------------
const rosterSidecar = {
	connected: true,
	hello: { protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: ["agent_roster"] },
	hasServerCapability(name) {
		return this.hello.serverCapabilities.includes(name);
	},
	subscribed: 0,
	async rosterSubscribe() {
		this.subscribed += 1;
		return [];
	},
};
await controller.setupRosterSubscription(rosterSidecar);
check("a capable daemon gets a roster subscription", controller.rosterSubscribedSidecar === rosterSidecar);
check("the subscribe command ran exactly once", rosterSidecar.subscribed === 1);
await controller.setupRosterSubscription(rosterSidecar);
check("a repeated setup does not double-subscribe", rosterSidecar.subscribed === 1);

const legacySidecar = { connected: true, hello: { protocol: { name: "prime-agent.daemon", version: 7 } } /* no probe at all */ };
controller.rosterSubscribedSidecar = null;
await controller.setupRosterSubscription(legacySidecar);
check("a sidecar without the capability probe is a safe no-op", controller.rosterSubscribedSidecar === null);

const oldDaemonSidecar = {
	connected: true,
	hello: { protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: [] },
	hasServerCapability(name) {
		return this.hello.serverCapabilities.includes(name);
	},
	subscribed: 0,
	async rosterSubscribe() {
		this.subscribed += 1;
		return [];
	},
};
controller.rosterSubscribedSidecar = null;
await controller.setupRosterSubscription(oldDaemonSidecar);
check("a pre-roster daemon is never asked to subscribe", oldDaemonSidecar.subscribed === 0 && controller.rosterSubscribedSidecar === null);

// A daemon that advertises but then refuses (mid-update) must not wedge future refreshes.
const refusingSidecar = {
	connected: true,
	hello: { protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: ["agent_roster"] },
	hasServerCapability(name) {
		return this.hello.serverCapabilities.includes(name);
	},
	async rosterSubscribe() {
		throw new Error("Daemon supervisor generation 3 is shutting down; retry the command");
	},
};
controller.rosterSubscribedSidecar = null;
await controller.setupRosterSubscription(refusingSidecar);
check("a refused subscribe keeps the pull model without throwing", controller.rosterSubscribedSidecar === null);


// --- switchSession: a recovering worker queues only from a plain view --------
const TRANSIENT = 'Session "/tmp/b.jsonl" worker recovery was interrupted; retry opening the session';
function armSwitchFakes(target) {
	target.resolveHistorySession = async (sessionPath, sessionId) => ({ path: sessionPath, id: sessionId });
	target.ensureStarted = async () => {};
	target.client = {
		request: async (cmd) =>
			cmd.type === "switch_session"
				? { success: false, error: "Session is already active in bbb: /tmp/b.jsonl" }
				: { success: true, data: {} },
	};
	target.sidecar = {
		connected: true,
		connect: async () => {},
		dispose: () => {},
		detach: async () => {},
		list: async () => [],
		attach: async () => {
			throw new Error(TRANSIENT);
		},
	};
}

const bPath = path.join(workdir, "b.jsonl");
// 1. Plain own-RPC view: the ladder arms and the wait is announced.
armSwitchFakes(controller);
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
posts.length = 0;
await controller.switchSession(bPath, "b");
check("plain view: the recovery wait is queued", controller.attachAttempt?.activeSessionId === "b");
check("plain view: the queue owns the current epoch", controller.attachAttemptEpoch === controller.viewEpoch);
check("plain view: the wait is announced", notices().some((t) => /attach automatically/i.test(t)));
controller.clearReattachTimer();
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;

// 2. From an attached view the queue could never arm (isReattaching() needs
// attached === null) — keep the view and say so instead of promising a retry
// that will not happen.
armSwitchFakes(controller);
const aRef = { activeSessionId: "h-A", sessionPath: path.join(workdir, "a.jsonl"), sessionId: "a" };
controller.attached = aRef;
controller.attachedEpoch = controller.viewEpoch;
posts.length = 0;
await controller.switchSession(bPath, "b");
check("attached view: no unarmable queue is left behind", controller.attachAttempt === null);
check("attached view: the previous attachment is restored", controller.attached?.activeSessionId === "h-A");
check("attached view: the restored view owns the epoch", controller.attachedEpoch === controller.viewEpoch);
check("attached view: the operator is told to retry", notices().some((t) => /try again in a moment/i.test(t)));
check("attached view: no reattach timer is armed", controller.reattachTimer === null);
controller.attached = null;
controller.attachedEpoch = null;

// 3. While observing, a queued re-attach would succeed and then be rolled back
// as stale (observingId guard) forever — refuse the queue there too.
armSwitchFakes(controller);
controller.observingId = "h-C";
posts.length = 0;
await controller.switchSession(bPath, "b");
check("observing view: no queue while an observation holds the display", controller.attachAttempt === null);
check("observing view: the observation itself is untouched", controller.observingId === "h-C");
check("observing view: the operator is told to retry", notices().some((t) => /try again in a moment/i.test(t)));
controller.observingId = null;

// --- onSidecarClosed: shutdown vs update, attached and mid-ladder ------------
const closer = makeController();
closer.ensureStarted = async () => {};

// attached + update: the attachment converts to a reconnect intent on the ladder.
closer.attached = { activeSessionId: "h-U", sessionPath: path.join(workdir, "u.jsonl"), sessionId: "u" };
closer.attachedEpoch = closer.viewEpoch;
closer.daemonClosingReason = "update";
posts.length = 0;
closer.onSidecarClosed();
check("close after update: the attachment converts to a reconnect intent", closer.attachAttempt?.activeSessionId === "h-U");
check("close after update: the restart is named", notices().some((t) => /restarted for its update/i.test(t)));
check("close after update: the reason is consumed", closer.daemonClosingReason === null);
closer.clearReattachTimer();

// mid-ladder + shutdown: stop chasing a daemon that is not coming back.
closer.attached = null;
closer.attachedEpoch = null;
closer.attachAttempt = { activeSessionId: "h-M", sessionPath: path.join(workdir, "m.jsonl"), sessionId: "m" };
closer.attachAttemptEpoch = closer.viewEpoch;
closer.daemonClosingReason = "shutdown";
closer.onSidecarClosed();
check("shutdown mid-ladder: the wait is abandoned", closer.attachAttempt === null);
check("shutdown mid-ladder: the view goes home", closer.observationRestoring === true);
closer.clearReattachTimer();
closer.observationRestoring = false;

// mid-ladder + plain drop (no daemon_closing): the ladder keeps riding.
closer.attachAttempt = { activeSessionId: "h-L", sessionPath: path.join(workdir, "l.jsonl"), sessionId: "l" };
closer.attachAttemptEpoch = closer.viewEpoch;
closer.daemonClosingReason = null;
closer.onSidecarClosed();
check("plain drop mid-ladder: the wait survives", closer.attachAttempt?.activeSessionId === "h-L");
closer.clearReattachTimer();
closer.attachAttempt = null;
closer.attachAttemptEpoch = null;

// attached + shutdown: full stop, the view goes home to its own session.
closer.attached = { activeSessionId: "h-S", sessionPath: path.join(workdir, "s.jsonl"), sessionId: "s" };
closer.attachedEpoch = closer.viewEpoch;
closer.daemonClosingReason = "shutdown";
closer.onSidecarClosed();
check("shutdown while attached: no reconnect intent survives", closer.attachAttempt === null && closer.attached === null);
check("shutdown while attached: the view goes home", closer.observationRestoring === true);

// --- daemon_closing wording matches whether a view is following --------------
const bystander = makeController();
posts.length = 0;
bystander.onDaemonEvent({ type: "daemon_closing", reason: "update" });
check("a bystander view is not promised a re-attach", notices().some((t) => /back on its own/i.test(t)));
bystander.attached = { activeSessionId: "h-F", sessionPath: path.join(workdir, "f.jsonl"), sessionId: "f" };
bystander.attachedEpoch = bystander.viewEpoch;
posts.length = 0;
bystander.onDaemonEvent({ type: "daemon_closing", reason: "update" });
check("a following view is promised the re-attach", notices().some((t) => /re-attach automatically/i.test(t)));
bystander.daemonClosingReason = null;

console.log(failed === 0 ? "\nPASS roster-parity" : `\nFAIL roster-parity (${failed} checks)`);
process.exit(failed === 0 ? 0 : 1);
