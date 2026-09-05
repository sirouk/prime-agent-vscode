/**
 * Attach/restore lifecycle regressions for the host controller.
 *
 * These all share one failure shape: a view that LOOKS live but is not. A
 * duplicated re-attach that detaches its own registration, a half-installed
 * attachment left behind by a superseded navigation, and a restore lock that
 * nothing ever clears each leave the panel accepting input for a session it no
 * longer receives events for — or refusing every action with no way back.
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
const { SessionController, GitHeadContentProvider } = require("../dist/controller.cjs");
const { DaemonSidecar } = require("../dist/daemon-sidecar.cjs");
const { isSessionActive } = require("../dist/session-actions.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-attach-lifecycle-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "lifecycle", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const memory = new Map();
const state = { get: (key, fallback) => (memory.has(key) ? memory.get(key) : fallback), update: (key, value) => { memory.set(key, value); return Promise.resolve(); } };
const posts = [];
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: state, workspaceState: state },
	{ append: () => {}, appendLine: () => {} },
);
controller.attach({ post: (message) => posts.push(message) });

// --- the re-attach after a socket drop is serialized ------------------------
let attaches = 0;
let detaches = [];
const sidecar = {
	connected: true,
	connect: async () => {},
	list: async () => [],
	dispose: () => {},
	detach: async (id) => { detaches.push(id); },
	attach: async () => { attaches += 1; await new Promise((r) => setTimeout(r, 25)); return { snapshot: { messages: [], state: {} } }; },
};
controller.sidecar = sidecar;
controller.attachAttempt = { activeSessionId: "handle-R", sessionPath: path.join(workdir, "r.jsonl"), sessionId: "r" };
controller.attachAttemptEpoch = controller.viewEpoch;
await Promise.all([controller.ensureSidecar(), controller.ensureSidecar(), controller.ensureSidecar()]);
check("concurrent ensureSidecar() calls issue exactly one re-attach", attaches === 1, String(attaches));
check("a re-attach never detaches the handle it just installed", detaches.length === 0, JSON.stringify(detaches));
check("the re-attach installs the view", controller.attached?.activeSessionId === "handle-R", String(controller.attached?.activeSessionId));

// A re-attach superseded WHILE the daemon answers must release its own viewer.
attaches = 0;
detaches = [];
controller.attached = null;
controller.attachedEpoch = null;
controller.attachAttempt = { activeSessionId: "handle-S", sessionPath: path.join(workdir, "s.jsonl"), sessionId: "s" };
controller.attachAttemptEpoch = controller.viewEpoch;
sidecar.attach = async () => {
	attaches += 1;
	controller.viewEpoch += 1; // a newer navigation takes the view mid-flight
	await new Promise((r) => setTimeout(r, 10));
	return { snapshot: { messages: [], state: {} } };
};
await controller.ensureSidecar();
check("a superseded re-attach releases its own daemon viewer", detaches.includes("handle-S"), JSON.stringify(detaches));
check("a superseded re-attach does not claim the view", controller.attached === null, String(controller.attached?.activeSessionId));
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;

// --- a half-installed attachment is rolled back, never left behind ----------
detaches = [];
const attachment = { activeSessionId: "handle-A", sessionPath: path.join(workdir, "a.jsonl"), sessionId: "a" };
controller.attached = attachment;
controller.attachedEpoch = 7;
controller.attachAttempt = { ...attachment };
controller.attachAttemptEpoch = 7;
check("rollback reports attach failure", (await controller.rollbackAttachment(sidecar, attachment)) === false);
check("rollback clears the stale attachment", controller.attached === null && controller.attachedEpoch === null);
check("rollback drops the reconnect intent with it", controller.attachAttempt === null);
check("rollback releases the daemon viewer", detaches.includes("handle-A"), JSON.stringify(detaches));

detaches = [];
const newer = { activeSessionId: "handle-A", sessionPath: "elsewhere", sessionId: "a" };
controller.attached = newer;
controller.attachedEpoch = 9;
await controller.rollbackAttachment(sidecar, attachment);
check("rollback never releases a handle the current view holds", detaches.length === 0, JSON.stringify(detaches));
check("rollback leaves a newer attachment intact", controller.attached === newer);
controller.attached = null;
controller.attachedEpoch = null;

// --- the restore lock is never latched --------------------------------------
let relaunched = 0;
controller.client = null; // refreshSnapshot() cannot succeed
controller.ensureStarted = async () => { relaunched += 1; };
controller.observationRestoring = true;
const restored = await controller.restoreOwnRpcView(controller.viewEpoch);
check("a failed RPC restore reports failure", restored === false);
check("a failed RPC restore retries the subprocess once", relaunched === 1, String(relaunched));
check("a failed RPC restore releases the lock instead of disabling the panel forever", controller.observationRestoring === false);

controller.observingId = "obs-1";
controller.observationRestoring = false;
const realClearObservation = controller.clearObservation.bind(controller);
controller.clearObservation = async () => { controller.observingId = null; return false; };
await controller.stopObserving();
check("a refused stop-observing hand-off releases the lock too", controller.observationRestoring === false);
controller.clearObservation = realClearObservation;
controller.observingId = null;

// --- every id-bearing extension UI request is answered ----------------------
const sent = [];
const client = { running: true, sendRaw: (message) => sent.push(message) };
controller.client = client;
await controller.onExtensionUiRequest(client, { type: "extension_ui_request", id: "req-9", method: "setWidget", widgetKey: "k" });
check("an unrendered extension UI request is explicitly cancelled", sent.some((m) => m.id === "req-9" && m.cancelled === true), JSON.stringify(sent));
controller.client = null;

// --- a stale search failure must not repaint (or re-authorize) a newer list --
controller.lastHistory = [];
controller.actionHistory = [{ id: "current", path: path.join(workdir, "current.jsonl"), cwd: workdir, timestamp: "", inWorkspace: true }];
controller.collectHistory = async () => [{ id: "stale", path: path.join(workdir, "stale.jsonl"), cwd: workdir, timestamp: "", inWorkspace: true }];
controller.savedSessionCatalog = async () => { controller.historyRequestGeneration += 1; throw new Error("daemon down"); };
posts.length = 0;
await controller.searchHistory("abc");
check("a stale catalog failure does not repaint a newer query", !posts.some((m) => m.type === "history"), JSON.stringify(posts.map((p) => p.type)));
check("a stale catalog failure does not re-authorize the old row set", controller.actionHistory?.[0]?.id === "current", String(controller.actionHistory?.[0]?.id));

// --- a browsed child with no session file must not disable diff harvesting ---
const parentFile = path.join(workdir, "parent.jsonl");
const childFile = path.join(workdir, "child.jsonl");
fs.writeFileSync(parentFile, "{}\n");
fs.writeFileSync(childFile, "{}\n");
controller.attached = { activeSessionId: "h", sessionPath: "", sessionId: "p" };
controller.state = { sessionFile: parentFile };
// The guard now lives on the tracker; going through it also proves the
// controller's currentSessionFile() wiring still resolves the same three
// sources in the same order.
check("an empty attachment path falls through to the RPC session file", (await controller.threadDiffs.validChildSessionFile(childFile)) === childFile);
check("a path outside the transcript directory is still refused", (await controller.threadDiffs.validChildSessionFile(path.join(os.tmpdir(), "elsewhere.jsonl"))) === null);
controller.attached = null;

// --- a success with no payload is "empty", not a crash ----------------------
const bare = new DaemonSidecar();
bare.connected = true;
bare.request = async () => undefined;
check("list() tolerates a payload-less success", JSON.stringify(await bare.list()) === "[]");
check("getMessages() tolerates a payload-less success", JSON.stringify(await bare.getMessages("x")) === "[]");
check("getState() tolerates a payload-less success", JSON.stringify(await bare.getState("x")) === "{}");
check("attach() tolerates a payload-less success", JSON.stringify(await bare.attach("x")) === "{}");

// --- a lease held by another user is ACTIVE, not stale -----------------------
const probe = path.join(os.tmpdir(), `pa-lease-probe-${process.pid}.jsonl`);
const key = createHash("sha256").update(`${fs.realpathSync(path.dirname(probe))}/${path.basename(probe)}`).digest("hex");
const lockDir = path.join(os.homedir(), ".prime", "agent", "session-leases", `${key}.lock`);
fs.mkdirSync(lockDir, { recursive: true });
try {
	let foreign = false;
	try { process.kill(1, 0); } catch (err) { foreign = err.code === "EPERM"; }
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 1 }));
	const active = await isSessionActive(probe);
	check("a lease owned by another user's live process reads as active", foreign ? active === true : true, `eperm=${foreign} active=${active}`);
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 4194303 }));
	check("a dead owner still reads as a stale lock", (await isSessionActive(probe)) === false);
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid }));
	check("our own live pid reads as active", (await isSessionActive(probe)) === true);
} finally {
	fs.rmSync(lockDir, { recursive: true, force: true });
}

// --- git HEAD content: empty means "new file", not "we failed" ---------------
const untracked = path.join(workdir, "untracked.txt");
fs.writeFileSync(untracked, "x");
const head = await new GitHeadContentProvider().provideTextDocumentContent({ with: () => ({ fsPath: untracked }) });
check("a path outside any repository yields an empty HEAD side", head === "", JSON.stringify(head).slice(0, 48));

// --- the slash catalog answers for the session on screen, whatever it is ------
// It describes the agent build, not the session, and the webview asks for it
// again after every boundary — which is exactly when the view is attached,
// observing, or restoring. The old guards refused in all three, and
// guardObservedReadOnly() additionally popped a read-only warning at the
// operator for what is a harmless catalog query.
posts.length = 0;
const commandClient = {
	running: true,
	request: async (command) =>
		command.type === "get_commands"
			? { success: true, data: { commands: [{ name: "compact" }, { name: "security-pipeline" }] } }
			: { success: false, error: "unexpected" },
	sendRaw: () => {},
};
controller.client = commandClient;
controller.ensureStarted = async () => {};
controller.attached = { activeSessionId: "handle-C", sessionPath: path.join(workdir, "c.jsonl"), sessionId: "c" };
controller.attachedEpoch = controller.viewEpoch;
await controller.listCommands();
check("attached view still gets the slash catalog",
	posts.some((m) => m.type === "commands" && m.commands.length === 2),
	JSON.stringify(posts.map((m) => m.type)));

posts.length = 0;
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = "obs-2";
controller.observationRestoring = true;
await controller.listCommands();
check("observing/restoring view still gets the slash catalog",
	posts.some((m) => m.type === "commands" && m.commands.length === 2),
	JSON.stringify(posts.map((m) => m.type)));
check("asking for the catalog never warns the operator",
	!posts.some((m) => m.type === "notice"),
	JSON.stringify(posts.filter((m) => m.type === "notice").map((m) => m.text)));
controller.observingId = null;
controller.observationRestoring = false;
controller.client = null;

// --- a daemon reply timeout is not a failed compaction ----------------------
// prime-agent's own daemon client gives up at 30s (daemon-client.js
// `request(command, timeoutMs = 30000)`, no case for `compact`), and compaction
// on a long thread outlives that routinely. Relaying it as "Compaction failed"
// told the operator their still-running compaction had died.
const TIMEOUT_ERROR = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "compact". Socket: /tmp/prime-agent-0/daemon.sock.';
posts.length = 0;
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.compacting = true;
controller.client = {
	running: true,
	sendRaw: () => {},
	request: async (command) => {
		if (command.type === "compact") throw new Error(TIMEOUT_ERROR);
		if (command.type === "get_state") return { success: true, data: { isCompacting: true } };
		return { success: true, data: {} };
	},
};
controller.ensureStarted = async () => {};
await controller.compact();
const stillRunning = posts.filter((m) => m.type === "notice");
check("a timeout while compaction is still running is not reported as a failure",
	!stillRunning.some((m) => m.level === "error"), JSON.stringify(stillRunning.map((m) => `${m.level}:${m.text.slice(0, 40)}`)));
check("...and the operator is told it is still going",
	stillRunning.some((m) => m.level === "info" && /still running/i.test(m.text)),
	JSON.stringify(stillRunning.map((m) => m.text.slice(0, 60))));

// A genuine failure — the session is NOT compacting — must still be reported.
posts.length = 0;
controller.compacting = false;
controller.client = {
	running: true,
	sendRaw: () => {},
	request: async (command) => {
		if (command.type === "compact") throw new Error("provider rejected the compaction");
		if (command.type === "get_state") return { success: true, data: { isCompacting: false } };
		return { success: true, data: {} };
	},
};
await controller.compact();
check("a real compaction failure is still surfaced as an error",
	posts.some((m) => m.type === "notice" && m.level === "error" && /provider rejected/.test(m.text)),
	JSON.stringify(posts.filter((m) => m.type === "notice").map((m) => `${m.level}:${m.text.slice(0, 40)}`)));

// compaction_end refreshes the transcript on its own, so a lost reply cannot
// leave a stale view — and a compaction another client ran also lands.
let refreshed = 0;
controller.refreshSnapshot = async () => { refreshed += 1; return true; };
controller.onAgentEvent({ type: "compaction_end", reason: "manual" });
check("compaction_end refreshes the transcript regardless of who asked for it", refreshed === 1, String(refreshed));
controller.client = null;

// --- going back to the parent from a browsed subagent -----------------------
// Browsing from this window's own session into a subagent pushes an "rpc"
// breadcrumb and leaves the CHILD attached. Requiring no attachment before
// unwinding made "‹ parent" a silent no-op for the commonest path there is.
{
	posts.length = 0;
	const detached = [];
	const originalDetachSession = controller.detachDaemonSession;
	const originalRestore = controller.restoreOwnRpcView;
	const originalReset = controller.resetChildrenBaseline;
	const originalChildren = controller.scheduleChildrenRefresh;
	let restored = 0;
	controller.detachDaemonSession = async (_sidecar, id) => { detached.push(id); };
	controller.restoreOwnRpcView = async () => { restored += 1; return true; };
	controller.resetChildrenBaseline = () => {};
	controller.scheduleChildrenRefresh = () => {};
	controller.sidecar = { connected: true, impersonateClientId: null, dispose() {} };

	controller.attached = { activeSessionId: "child-handle", sessionPath: path.join(workdir, "child.jsonl"), sessionId: "child" };
	controller.attachedEpoch = controller.viewEpoch;
	controller.returnTargets = [{ kind: "rpc" }];

	await controller.backToParent();
	check("back from a subagent releases the child attachment", controller.attached === null, JSON.stringify(controller.attached));
	check("back from a subagent detaches the child by handle", detached.includes("child-handle"), JSON.stringify(detached));
	check("back from a subagent restores this window's own session", restored === 1, String(restored));
	check("back from a subagent consumes its breadcrumb", controller.returnTargets.length === 0, JSON.stringify(controller.returnTargets));

	controller.detachDaemonSession = originalDetachSession;
	controller.restoreOwnRpcView = originalRestore;
	controller.resetChildrenBaseline = originalReset;
	controller.scheduleChildrenRefresh = originalChildren;
	controller.sidecar = null;
	controller.attached = null;
}

// --- "\u2039 parent" goes UP, not BACK ---------------------------------------
// The strip offers children of the session on screen and its siblings. Stepping
// to a sibling is a lateral move — B has the same parent A did — so it must not
// deepen the trail. Pushing a breadcrumb there made "\u2039 parent" walk back
// through the siblings the operator had visited instead of going up.
{
	posts.length = 0;
	const originals = {
		ensureSidecar: controller.ensureSidecar,
		listSessions: controller.listSessions,
		attachViaDaemon: controller.attachViaDaemon,
		detachDaemonSession: controller.detachDaemonSession,
		restoreOwnRpcView: controller.restoreOwnRpcView,
		resetChildrenBaseline: controller.resetChildrenBaseline,
		scheduleChildrenRefresh: controller.scheduleChildrenRefresh,
	};
	let restored = 0;
	controller.sidecar = { connected: true, impersonateClientId: null, dispose() {} };
	controller.ensureSidecar = async () => controller.sidecar;
	// kid-a and kid-b are siblings under this window's own session; grand is a
	// child of kid-b, so browsing into it is a genuine descent.
	controller.listSessions = async () => [
		{ activeSessionId: "kid-a", sessionFile: path.join(workdir, "kid-a.jsonl"), runtimeKind: "subagent", parentActiveSessionId: "root-handle" },
		{ activeSessionId: "kid-b", sessionFile: path.join(workdir, "kid-b.jsonl"), runtimeKind: "subagent", parentActiveSessionId: "root-handle" },
		{ activeSessionId: "grand", sessionFile: path.join(workdir, "grand.jsonl"), runtimeKind: "subagent", parentActiveSessionId: "kid-b" },
	];
	controller.attachViaDaemon = async (activeSessionId, sessionPath) => {
		controller.attached = { activeSessionId, sessionPath, sessionId: activeSessionId };
		controller.attachedEpoch = controller.viewEpoch;
		return true;
	};
	controller.detachDaemonSession = async () => {};
	controller.restoreOwnRpcView = async () => { restored += 1; return true; };
	controller.resetChildrenBaseline = () => {};
	controller.scheduleChildrenRefresh = () => {};

	const offer = (ref, activeSessionId, parentId) => {
		controller.browseableChildren.set(ref, { activeSessionId, parentId, contextId: controller.childrenContext });
		return ref;
	};
	const trail = () => controller.returnTargets.map((t) => (t.kind === "rpc" ? "rpc" : t.activeSessionId));

	controller.returnTargets = [];
	controller.attached = null;
	// The stubbed restore above never runs the real code that clears this, and a
	// view still marked "restoring" refuses to browse at all.
	controller.observationRestoring = false;

	check("browsing into a subagent attaches to it", await controller.browseChild(offer("to-a", "kid-a", "root-handle")) && controller.attached?.activeSessionId === "kid-a",
		JSON.stringify(controller.attached));
	check("descending from the own session leaves one way back", JSON.stringify(trail()) === '["rpc"]', JSON.stringify(trail()));

	check("stepping to a sibling attaches to it", await controller.browseChild(offer("to-b", "kid-b", "root-handle")) && controller.attached?.activeSessionId === "kid-b",
		JSON.stringify(controller.attached));
	check("...and does NOT deepen the trail behind it", JSON.stringify(trail()) === '["rpc"]', JSON.stringify(trail()));

	// The bug as reported: from the second subagent, up must reach the parent,
	// not the sibling that was on screen a moment ago.
	await controller.backToParent();
	check("up from a sibling reaches the parent, not the previously viewed sibling",
		controller.attached === null && restored === 1, `attached=${JSON.stringify(controller.attached)} restored=${restored}`);
	check("and the trail is spent", JSON.stringify(trail()) === "[]", JSON.stringify(trail()));

	// A real descent still records its own way back.
	controller.returnTargets = [];
	controller.attached = null;
	// beginRpcRestore() re-armed the restore lock that the stubbed restore never
	// clears; the browse above would be refused again without this.
	controller.observationRestoring = false;
	await controller.browseChild(offer("to-b2", "kid-b", "root-handle"));
	await controller.browseChild(offer("to-grand", "grand", "kid-b"));
	check("a genuine descent still records the session it came from", JSON.stringify(trail()) === '["rpc","kid-b"]', JSON.stringify(trail()));
	await controller.backToParent();
	check("up from a grandchild lands on its own parent", controller.attached?.activeSessionId === "kid-b", JSON.stringify(controller.attached));
	check("...and pops only that step", JSON.stringify(trail()) === '["rpc"]', JSON.stringify(trail()));

	Object.assign(controller, originals);
	controller.sidecar = null;
	controller.attached = null;
	controller.attachedEpoch = null;
	controller.returnTargets = [];
	controller.browseableChildren.clear();
}

// --- the install prompt points at the installer, not a repo doc page --------
posts.length = 0;
controller.maybeShowInstallPrompt("test reason");
const installPost = posts.find((m) => m.type === "installPrompt");
check("install prompt targets Prime Intellect's installer page",
	installPost?.url === "https://app.primeintellect.ai/prime-agent", String(installPost?.url));

controller.dispose();
console.log(failed === 0 ? "\nPASS attach-lifecycle" : `\nFAIL attach-lifecycle (${failed})`);
process.exit(failed === 0 ? 0 : 1);
