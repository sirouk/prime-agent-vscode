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

controller.dispose();
console.log(failed === 0 ? "\nPASS attach-lifecycle" : `\nFAIL attach-lifecycle (${failed})`);
process.exit(failed === 0 ? 0 : 1);
