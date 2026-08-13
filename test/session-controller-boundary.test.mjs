/**
 * Host-side authority regressions. The webview may be compromised, so syntactic
 * message validation is not enough: session actions must still resolve against
 * host-issued catalog/child capabilities before they touch disk or the daemon.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-controller-boundary-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "boundary", index: 0 }];

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

const validPath = path.join(workdir, "valid-session.jsonl");
const forgedPath = path.join(workdir, "forged-session.jsonl");
fs.writeFileSync(validPath, '{"type":"session","id":"root"}\n');
fs.writeFileSync(forgedPath, '{"type":"session","id":"forged"}\n');
controller.actionHistory = [{
	id: "valid-session",
	path: validPath,
	cwd: workdir,
	timestamp: new Date().toISOString(),
	inWorkspace: true,
}];

let abortedId = null;
const sidecar = {
	connected: true,
	list: async () => [{
		id: "valid-session",
		sessionId: "valid-session",
		activeSessionId: "daemon-live-handle",
		sessionFile: validPath,
		cwd: workdir,
		lifecycle: "live",
	}],
	abort: async (id) => { abortedId = id; },
	dispose: () => {},
};
controller.sidecar = sidecar;

await controller.stopSession(validPath, "valid-session");
check("history Stop resolves UUID to the daemon active handle", abortedId === "daemon-live-handle", String(abortedId));

// Recent daemon builds expose a runtime/session UUID that can differ from the
// JSONL filename stem. The capability must retain the runtime identity for
// routing but derive the stem for an offline mutation, rather than rejecting a
// perfectly valid catalog row as a forged path.
const differingPath = path.join(workdir, "file-stem.jsonl");
fs.writeFileSync(differingPath, '{"type":"session","id":"root"}\n');
controller.actionHistory = [{
	id: "runtime-session-uuid",
	path: differingPath,
	cwd: workdir,
	timestamp: new Date().toISOString(),
	inWorkspace: true,
}];
controller.lastHistory = controller.actionHistory;
controller.sidecar = {
	connected: true,
	request: async () => { throw new Error("offline row"); },
	list: async () => [],
	dispose: () => {},
};
await controller.renameHistorySession(differingPath, "runtime-session-uuid", "renamed from catalog");
check(
	"history actions accept a daemon UUID that differs from the JSONL filename",
	fs.readFileSync(differingPath, "utf8").includes('"name":"renamed from catalog"'),
	fs.readFileSync(differingPath, "utf8"),
);
controller.actionHistory = [{
	id: "valid-session",
	path: validPath,
	cwd: workdir,
	timestamp: new Date().toISOString(),
	inWorkspace: true,
}];
controller.lastHistory = controller.actionHistory;

posts.length = 0;
let switchRequests = 0;
controller.attached = { activeSessionId: "daemon-live-handle", sessionPath: validPath, sessionId: "valid-session" };
controller.attachedEpoch = controller.viewEpoch;
controller.client = { running: true, request: async () => { switchRequests += 1; return { success: true }; } };
await controller.switchSession(validPath, "valid-session");
check("resuming the already attached history row leaves its daemon attachment intact", switchRequests === 0 && controller.attached?.activeSessionId === "daemon-live-handle", JSON.stringify(posts));
controller.attached = null;
controller.attachedEpoch = null;
controller.client = null;

let resolveReattach;
const reattachPromise = new Promise((resolve) => { resolveReattach = resolve; });
controller.attachAttempt = { activeSessionId: "stale-live-handle", sessionPath: validPath, sessionId: "valid-session" };
controller.sidecar = {
	connected: true,
	attach: async () => reattachPromise,
	detach: async () => {},
	dispose: () => {},
};
const reconnect = controller.ensureSidecar();
await Promise.resolve();
controller.viewEpoch += 1; // a newer navigation landed while attach was in flight
controller.attachAttempt = null;
resolveReattach({ snapshot: { messages: [] } });
await reconnect;
check("late reattach cannot overwrite a newer navigation", controller.attached === null);

// A failed attach can fall back to a read-only observe view while the socket's
// prior reconnect is already awaiting its attach reply. Observation owns the
// display: it must cancel that reconnect, and the late reply must release its
// daemon registration instead of installing a writable attachment underneath.
const originalObserveDetach = controller.detachFromDaemon;
let releaseObserveRaceAttach;
const observeRaceAttach = new Promise((resolve) => { releaseObserveRaceAttach = resolve; });
let observeRaceDetachCalls = 0;
const observeRaceAttempt = { activeSessionId: "observe-race-live", sessionPath: validPath, sessionId: "observe-race-session" };
controller.attached = null;
controller.attachedEpoch = null;
controller.attachAttempt = observeRaceAttempt;
controller.attachAttemptEpoch = controller.viewEpoch;
controller.observingId = null;
controller.observedSession = null;
controller.observationRestoring = false;
controller.sidecar = {
	connected: true,
	attach: async () => observeRaceAttach,
	detach: async () => { observeRaceDetachCalls += 1; },
	dispose: () => {},
};
controller.client = {
	running: true,
	request: async (command) => command.type === "observe" ? { success: true, data: { messages: [] } } : { success: true, data: {} },
};
const observeRaceReconnect = controller.ensureSidecar();
await new Promise((resolve) => setImmediate(resolve));
const priorAttachment = { activeSessionId: "prior-live", sessionPath: validPath, sessionId: "valid-session" };
controller.attached = priorAttachment;
controller.attachedEpoch = controller.viewEpoch;
controller.detachFromDaemon = async () => {
	controller.attached = null;
	controller.attachedEpoch = null;
	return true;
};
const observed = await controller.startObserving("observe-race-live", priorAttachment, controller.viewEpoch, validPath, null);
controller.detachFromDaemon = originalObserveDetach;
check(
	"successful observation cancels its pending reconnect intent",
	observed === true && controller.attachAttempt === null && controller.attachAttemptEpoch === null,
	JSON.stringify({ observed, attachAttempt: controller.attachAttempt, attachAttemptEpoch: controller.attachAttemptEpoch }),
);
releaseObserveRaceAttach({ snapshot: { messages: [] } });
await observeRaceReconnect;
check(
	"a late reconnect cannot install an attachment beneath an observed session",
	controller.attached === null && controller.observingId === "observe-race-live" && observeRaceDetachCalls === 1,
	JSON.stringify({ attached: controller.attached, observingId: controller.observingId, observeRaceDetachCalls }),
);

// Cancellation is necessary but not sufficient: an attach reply already in
// flight must independently check the observed mode before it claims the view.
let releaseObservedReattach;
const observedReattach = new Promise((resolve) => { releaseObservedReattach = resolve; });
let observedReattachDetaches = 0;
const observedAttempt = { activeSessionId: "observed-reconnect-live", sessionPath: validPath, sessionId: "observed-reconnect-session" };
controller.attached = null;
controller.attachedEpoch = null;
controller.attachAttempt = observedAttempt;
controller.attachAttemptEpoch = controller.viewEpoch;
controller.sidecar = {
	connected: true,
	attach: async () => observedReattach,
	detach: async () => { observedReattachDetaches += 1; },
	dispose: () => {},
};
const observedReconnect = controller.ensureSidecar();
await new Promise((resolve) => setImmediate(resolve));
releaseObservedReattach({ snapshot: { messages: [] } });
await observedReconnect;
check(
	"reattach completion refuses to claim a read-only observed view",
	controller.attached === null && controller.observingId === "observe-race-live" && observedReattachDetaches === 1,
	JSON.stringify({ attached: controller.attached, observingId: controller.observingId, observedReattachDetaches }),
);
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.observingId = null;
controller.observedSession = null;
controller.observationRestoring = false;
controller.client = null;

posts.length = 0;
controller.attached = { activeSessionId: "closed-live-handle", sessionPath: validPath, sessionId: "valid-session" };
controller.attachedEpoch = controller.viewEpoch;
controller.sidecar = { connected: true, dispose: () => {} };
controller.client = { running: true, request: async (command) => {
	if (command.type === "get_messages") return { success: true, data: { messages: [] } };
	if (command.type === "get_state") return { success: true, data: {} };
	if (command.type === "get_session_stats") return { success: true, data: {} };
	return { success: true };
} };
controller.onDaemonEvent({ type: "session_closed", activeSessionId: "closed-live-handle" });
check("closed attached session keeps controls restoring until the RPC snapshot replaces it", controller.observationRestoring === true);
await new Promise((resolve) => setTimeout(resolve, 0));
check("closed attached session restores the background snapshot before controls re-enable", controller.observationRestoring === false && posts.some((message) => message.type === "snapshot"));
controller.client = null;

posts.length = 0;
await controller.deleteSessionByPath(forgedPath, "forged-session");
check("forged matching JSONL path is not deleted", fs.existsSync(forgedPath));
check("forged history action reports an unavailable capability", posts.some((message) => message.type === "notice" && /no longer available/.test(message.text)), JSON.stringify(posts));

posts.length = 0;
await controller.browseChild("forged-child-reference");
check("forged child handle is rejected before daemon attach", posts.some((message) => message.type === "notice" && /Invalid subagent reference/.test(message.text)), JSON.stringify(posts));

posts.length = 0;
controller.observingId = "another-client-session";
await controller.abort();
await controller.prompt({ text: "do not route this", images: [], selections: [], streamingBehavior: "steer", clientRequestId: "prompt-boundary" });
check("observed session cannot be aborted through a stale webview", abortedId === "daemon-live-handle");
check("observed prompt is rejected with its exact client request id", posts.some((message) => message.type === "promptRejected" && message.clientRequestId === "prompt-boundary"), JSON.stringify(posts));

// Pickers must source attached-session data from the daemon, never from the
// hidden background RPC session. They also stay bound to the view that opened
// the native picker while a user may navigate before choosing an item.
const originalQuickPick = vscodeStub.window.showQuickPick;
const pickerCommands = [];
const hiddenRpcCommands = [];
const attachedPicker = { activeSessionId: "attached-picker-A", sessionPath: validPath, sessionId: "valid-session" };
controller.observingId = null;
controller.observationRestoring = false;
controller.attached = attachedPicker;
controller.attachedEpoch = controller.viewEpoch;
controller.rentedState = {
	model: { provider: "attached-provider", id: "attached-model", thinkingLevelMap: { off: "off", low: "low", high: "high" } },
	thinkingLevel: "high",
};
controller.client = {
	running: true,
	request: async (command) => {
		hiddenRpcCommands.push(command);
		throw new Error("attached picker must not query the hidden RPC session");
	},
};
controller.sidecar = {
	connected: true,
	request: async (command) => {
		pickerCommands.push(command);
		if (command.type === "get_available_models") {
			return { models: [{ provider: "attached-provider", id: "attached-model", name: "Attached model" }] };
		}
		if (command.type === "set_model" || command.type === "set_thinking_level") return {};
		throw new Error(`unexpected attached picker command: ${command.type}`);
	},
	getState: async () => ({
		model: { provider: "attached-provider", id: "attached-model", thinkingLevelMap: { off: "off", low: "low", high: "high" } },
		thinkingLevel: "high",
	}),
	dispose: () => {},
};
vscodeStub.window.showQuickPick = async (items) => items.find((item) => item.label === "low") ?? items[0];
await controller.pickModelQuickPick();
await controller.pickThinkingQuickPick();
check(
	"attached pickers query and mutate only the attached daemon session",
	hiddenRpcCommands.length === 0 &&
		pickerCommands.some((command) => command.type === "get_available_models" && command.activeSessionId === attachedPicker.activeSessionId) &&
		pickerCommands.some((command) => command.type === "set_model" && command.activeSessionId === attachedPicker.activeSessionId) &&
		pickerCommands.some((command) => command.type === "set_thinking_level" && command.activeSessionId === attachedPicker.activeSessionId && command.level === "low"),
	JSON.stringify(pickerCommands),
);

pickerCommands.length = 0;
let releaseAttachedPicker;
vscodeStub.window.showQuickPick = () => new Promise((resolve) => { releaseAttachedPicker = resolve; });
const staleAttachedPick = controller.pickModelQuickPick();
await new Promise((resolve) => setImmediate(resolve));
controller.attached = { activeSessionId: "attached-picker-B", sessionPath: validPath, sessionId: "other-session" };
controller.attachedEpoch = controller.viewEpoch;
releaseAttachedPicker({ model: { provider: "attached-provider", id: "attached-model" } });
await staleAttachedPick;
check(
	"attached picker discards a selection after navigation",
	!pickerCommands.some((command) => command.type === "set_model"),
	JSON.stringify(pickerCommands),
);

let releaseRpcPicker;
const rpcPickerCommands = [];
controller.attached = null;
controller.attachedEpoch = null;
controller.state = { sessionId: "rpc-picker-A", model: { provider: "rpc-provider", id: "rpc-model" } };
controller.client = {
	running: true,
	request: async (command) => {
		rpcPickerCommands.push(command);
		if (command.type === "get_available_models") return { success: true, data: { models: [{ provider: "rpc-provider", id: "rpc-model" }] } };
		if (command.type === "set_model") return { success: true };
		return { success: true, data: {} };
	},
};
vscodeStub.window.showQuickPick = () => new Promise((resolve) => { releaseRpcPicker = resolve; });
const staleRpcPick = controller.pickModelQuickPick();
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 1;
controller.state = { sessionId: "rpc-picker-B", model: { provider: "rpc-provider", id: "new-model" } };
releaseRpcPicker({ model: { provider: "rpc-provider", id: "rpc-model" } });
await staleRpcPick;
check(
	"RPC picker discards a selection after navigation",
	!rpcPickerCommands.some((command) => command.type === "set_model"),
	JSON.stringify(rpcPickerCommands),
);

let observedPickerCalls = 0;
controller.observingId = "observed-picker-session";
controller.client = { running: true, request: async () => { observedPickerCalls += 1; return { success: true, data: {} }; } };
await controller.pickModelQuickPick();
await controller.pickThinkingQuickPick();
check("observed pickers remain read-only and do not query the hidden RPC session", observedPickerCalls === 0);
vscodeStub.window.showQuickPick = originalQuickPick;
controller.client = null;
controller.observingId = null;

// A lexical workspace-prefix check is not an authority boundary: VS Code will
// open a symlink target outside the folder. Selection forwarding is especially
// sensitive because it reads the target and sends the text back to the webview.
if (process.platform !== "win32") {
	const secretPath = path.join(os.tmpdir(), `prime-agent-secret-${process.pid}.txt`);
	const linkedPath = path.join(workdir, "workspace-link.txt");
	fs.writeFileSync(secretPath, "TOP-SECRET\n");
	fs.symlinkSync(secretPath, linkedPath);
	const priorEditor = vscodeStub.window.activeTextEditor;
	vscodeStub.window.activeTextEditor = {
		document: { uri: { fsPath: linkedPath, scheme: "file" }, getText: () => "TOP-SECRET\n", languageId: "plaintext" },
		selection: { isEmpty: false, start: { line: 0 }, end: { line: 0 } },
	};
	check("workspace symlink selections cannot expose an external target", controller.getActiveSelection() === null);
	check("workspace symlink paths cannot be opened from a webview message", (await controller.resolveWorkspaceUri("workspace-link.txt")) === null);
	vscodeStub.window.activeTextEditor = priorEditor;
	fs.unlinkSync(secretPath);
}

// Every operation that waits for process startup must remain owned by the view
// that initiated it. Otherwise a prompt begun on A can be delivered to B when
// an explicit navigation happens while startup is still pending.
posts.length = 0;
const originalEnsureStarted = controller.ensureStarted;
let releaseStartup;
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.client = null;
controller.ensureStarted = () => new Promise((resolve) => { releaseStartup = resolve; });
const staleStartupPrompt = controller.prompt({
	text: "must stay on the original view",
	images: [],
	selections: [],
	streamingBehavior: "steer",
	clientRequestId: "startup-race-prompt",
});
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 1;
const newViewPromptCommands = [];
controller.client = {
	running: true,
	request: async (command) => {
		newViewPromptCommands.push(command);
		return { success: true, data: {} };
	},
};
releaseStartup();
await staleStartupPrompt;
check(
	"a startup-delayed prompt cannot target a newer RPC view",
	newViewPromptCommands.length === 0 && posts.some((message) => message.type === "promptRejected" && message.clientRequestId === "startup-race-prompt"),
	JSON.stringify({ commands: newViewPromptCommands, posts }),
);
controller.ensureStarted = originalEnsureStarted;

// Restart must not merely await the startup it just stopped. The old coalesced
// promise has to settle first, then a fresh ensureStarted call creates the
// replacement process.
const originalStop = controller.stop;
const originalRestartEnsureStarted = controller.ensureStarted;
let releaseRetiringStartup;
controller.startingPromise = new Promise((resolve) => { releaseRetiringStartup = resolve; });
let restartStops = 0;
let replacementStarts = 0;
controller.stop = () => { restartStops += 1; };
controller.ensureStarted = async () => { replacementStarts += 1; };
const restartDuringStartup = controller.restart();
await new Promise((resolve) => setImmediate(resolve));
check("restart waits for the retiring startup before starting a replacement", restartStops === 1 && replacementStarts === 0);
releaseRetiringStartup();
await restartDuringStartup;
check("restart starts a fresh process after the retiring startup settles", replacementStarts === 1, String(replacementStarts));
controller.startingPromise = null;
controller.stop = originalStop;
controller.ensureStarted = originalRestartEnsureStarted;

// Extension UI requests are also native dialogs. Once the foreground changes,
// an approval must turn into a cancellation for the original RPC session.
const originalShowInformationMessage = vscodeStub.window.showInformationMessage;
let releaseConfirmDialog;
const dialogResponses = [];
const dialogClient = {
	running: true,
	sendRaw: (message) => dialogResponses.push(message),
};
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.client = dialogClient;
vscodeStub.window.showInformationMessage = () => new Promise((resolve) => { releaseConfirmDialog = resolve; });
const pendingDialog = controller.onExtensionUiRequest(dialogClient, {
	type: "extension_ui_request",
	id: "dialog-race",
	method: "confirm",
	title: "Confirm",
	message: "Do the original-session action?",
});
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch += 1;
releaseConfirmDialog("Yes");
await pendingDialog;
check(
	"an extension dialog approval is cancelled after navigation",
	dialogResponses.length === 1 && dialogResponses[0].cancelled === true && dialogResponses[0].confirmed === undefined,
	JSON.stringify(dialogResponses),
);
vscodeStub.window.showInformationMessage = originalShowInformationMessage;

// Native dialogs are another await boundary. An HTML export must not operate
// on whichever session happens to be current after the picker closes.
posts.length = 0;
const originalShowSaveDialog = vscodeStub.window.showSaveDialog;
const exportStartEpoch = controller.viewEpoch;
let releaseSaveDialog;
const oldViewExportCommands = [];
const newViewExportCommands = [];
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = null;
controller.attachAttemptEpoch = null;
controller.client = {
	running: true,
	request: async (command) => {
		oldViewExportCommands.push(command);
		return { success: true };
	},
};
vscodeStub.window.showSaveDialog = () => new Promise((resolve) => { releaseSaveDialog = resolve; });
const staleExport = controller.exportHtml();
await new Promise((resolve) => setImmediate(resolve));
controller.viewEpoch = exportStartEpoch + 1;
controller.client = {
	running: true,
	request: async (command) => {
		newViewExportCommands.push(command);
		return { success: true };
	},
};
releaseSaveDialog({ fsPath: path.join(workdir, "stale-export.html"), scheme: "file" });
await staleExport;
check(
	"an export dialog response is discarded after navigation",
	oldViewExportCommands.length === 0 && newViewExportCommands.length === 0,
	JSON.stringify({ oldViewExportCommands, newViewExportCommands }),
);
vscodeStub.window.showSaveDialog = originalShowSaveDialog;

// An old attach may need a second RPC to fetch its transcript. If that RPC
// rejects after B has become current, its catch path must not blank B's cache.
const originalEnsureSidecar = controller.ensureSidecar;
const originalRefreshAttachedState = controller.refreshAttachedState;
const originalFetchAttachedStats = controller.fetchAttachedStats;
const originalScheduleChildrenRefresh = controller.scheduleChildrenRefresh;
let rejectOldAttachMessages;
const oldAttachMessages = new Promise((_resolve, reject) => { rejectOldAttachMessages = reject; });
const oldAttachSidecar = {
	connected: true,
	list: async () => [],
	attach: async () => ({ snapshot: { state: { sessionId: "old-attach-session" } } }),
	detach: async () => {},
	getMessages: async () => oldAttachMessages,
	getState: async () => ({}),
	getSessionStats: async () => ({}),
	dispose: () => {},
};
controller.ensureSidecar = async () => oldAttachSidecar;
controller.refreshAttachedState = async () => {};
controller.fetchAttachedStats = async () => "";
controller.scheduleChildrenRefresh = () => {};
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
const oldAttachEpoch = controller.viewEpoch;
const staleAttach = controller.attachViaDaemon("old-attach-active", validPath, oldAttachEpoch);
await new Promise((resolve) => setImmediate(resolve));
const newerAttachment = { activeSessionId: "new-attach-active", sessionPath: validPath, sessionId: "new-attach-session" };
const newerTranscript = [{ role: "assistant", text: "newer transcript must survive" }];
controller.attached = newerAttachment;
controller.cachedMessages = newerTranscript;
controller.viewEpoch += 1;
controller.attachedEpoch = controller.viewEpoch;
rejectOldAttachMessages(new Error("old attach transcript unavailable"));
const staleAttachResult = await staleAttach;
check(
	"a stale attach transcript failure cannot clear the newer view",
	staleAttachResult === false && controller.attached === newerAttachment && controller.cachedMessages === newerTranscript,
	JSON.stringify({ staleAttachResult, attached: controller.attached, cachedMessages: controller.cachedMessages }),
);
controller.ensureSidecar = originalEnsureSidecar;
controller.refreshAttachedState = originalRefreshAttachedState;
controller.fetchAttachedStats = originalFetchAttachedStats;
controller.scheduleChildrenRefresh = originalScheduleChildrenRefresh;

// A navigation begins before its history lookup finishes. That intent must
// invalidate a reconnect attempt from a socket drop, so a timer cannot
// resurrect the old attached session beneath the newly selected view.
const originalResolveHistorySession = controller.resolveHistorySession;
let releaseHistoryResolution;
const pendingHistoryResolution = new Promise((resolve) => { releaseHistoryResolution = resolve; });
let staleReconnectAttaches = 0;
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.attachAttempt = { activeSessionId: "reconnect-old-active", sessionPath: validPath, sessionId: "valid-session" };
controller.attachAttemptEpoch = controller.viewEpoch;
controller.sidecar = {
	connected: true,
	attach: async () => {
		staleReconnectAttaches += 1;
		return { snapshot: { messages: [] } };
	},
	detach: async () => {},
	dispose: () => {},
};
controller.resolveHistorySession = () => pendingHistoryResolution;
const explicitNavigation = controller.switchSession(validPath, "valid-session");
await new Promise((resolve) => setImmediate(resolve));
await controller.ensureSidecar();
check(
	"explicit navigation cancels a stale reconnect attempt",
	controller.attachAttempt === null && controller.attachAttemptEpoch === null && staleReconnectAttaches === 0,
	JSON.stringify({ attachAttempt: controller.attachAttempt, attachAttemptEpoch: controller.attachAttemptEpoch, staleReconnectAttaches }),
);
controller.viewEpoch += 1;
releaseHistoryResolution({ id: "valid-session", path: validPath, cwd: workdir, timestamp: new Date().toISOString(), inWorkspace: true });
await explicitNavigation;
controller.resolveHistorySession = originalResolveHistorySession;

// A parent release begun by Browse must finish before Back can re-attach that
// same daemon handle. Otherwise the late release unregisters the fresh parent.
const originalQueuedEnsureSidecar = controller.ensureSidecar;
const originalQueuedFetchStats = controller.fetchAttachedStats;
const originalQueuedRefreshState = controller.refreshAttachedState;
const originalQueuedChildrenRefresh = controller.scheduleChildrenRefresh;
let releaseParentDetach;
let parentAttachCalls = 0;
const queuedSidecar = {
	connected: true,
	list: async () => [],
	detach: async () => new Promise((resolve) => { releaseParentDetach = resolve; }),
	attach: async () => {
		parentAttachCalls += 1;
		return { snapshot: { state: { sessionId: "parent-session" }, messages: [] } };
	},
	getState: async () => ({ sessionId: "parent-session" }),
	getSessionStats: async () => ({}),
	dispose: () => {},
};
controller.sidecar = queuedSidecar;
controller.ensureSidecar = async () => queuedSidecar;
controller.fetchAttachedStats = async () => "";
controller.refreshAttachedState = async () => {};
controller.scheduleChildrenRefresh = () => {};
controller.attached = null;
controller.attachedEpoch = null;
controller.pendingDaemonDetaches.clear();
const releasingParent = controller.detachDaemonSession(queuedSidecar, "parent-live-handle");
await new Promise((resolve) => setImmediate(resolve));
const waitingParentAttach = controller.attachViaDaemon("parent-live-handle", validPath, controller.viewEpoch);
await new Promise((resolve) => setImmediate(resolve));
check("a parent attach waits for an in-flight release of the same daemon handle", parentAttachCalls === 0, String(parentAttachCalls));
releaseParentDetach();
await releasingParent;
await waitingParentAttach;
check("the parent attach proceeds only after the old release completes", parentAttachCalls === 1, String(parentAttachCalls));
controller.ensureSidecar = originalQueuedEnsureSidecar;
controller.fetchAttachedStats = originalQueuedFetchStats;
controller.refreshAttachedState = originalQueuedRefreshState;
controller.scheduleChildrenRefresh = originalQueuedChildrenRefresh;

// Attach snapshots may omit a UUID and reveal it later in get_state. The
// displayed identity must stay fixed so the webview does not clear a draft in
// the middle of that one attached session.
const originalIdentityEnsureSidecar = controller.ensureSidecar;
const originalIdentityFetchStats = controller.fetchAttachedStats;
const originalIdentityRefreshState = controller.refreshAttachedState;
const originalIdentityChildrenRefresh = controller.scheduleChildrenRefresh;
const identitySidecar = {
	connected: true,
	list: async () => [],
	attach: async () => ({ snapshot: { state: {}, messages: [] } }),
	getState: async () => ({ sessionId: "late-daemon-uuid" }),
	getSessionStats: async () => ({}),
	detach: async () => {},
	dispose: () => {},
};
controller.sidecar = identitySidecar;
controller.ensureSidecar = async () => identitySidecar;
controller.fetchAttachedStats = async () => "";
controller.refreshAttachedState = async function () {
	const attached = this.attached;
	const state = await identitySidecar.getState(attached.activeSessionId);
	if (this.isCurrentAttachment(attached)) this.rentedState = state;
};
controller.scheduleChildrenRefresh = () => {};
controller.attached = null;
controller.attachedEpoch = null;
const identityEpoch = controller.viewEpoch;
await controller.attachViaDaemon("identity-live-handle", validPath, identityEpoch);
await new Promise((resolve) => setImmediate(resolve));
check("an attached session keeps one stable webview identity when get_state reveals its UUID", controller.attached?.sessionId === "valid-session", JSON.stringify(controller.attached));
controller.ensureSidecar = originalIdentityEnsureSidecar;
controller.fetchAttachedStats = originalIdentityFetchStats;
controller.refreshAttachedState = originalIdentityRefreshState;
controller.scheduleChildrenRefresh = originalIdentityChildrenRefresh;

// The last lifecycle fixture intentionally leaves a lightweight RPC stand-in
// installed; dispose() owns a real client's stop() method, so remove it first.
controller.client = null;
controller.dispose();
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? "\nPASS session-controller boundary" : `\n${failed} session-controller boundary checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
