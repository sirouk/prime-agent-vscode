/**
 * Cross-session send guard.
 *
 * A prompt is delivered by two different mechanisms: the attached path names
 * its session on the wire, but the own-RPC path names NO session — it lands on
 * whichever thread the hidden child currently holds. So if the panel's view
 * moves between typing and Enter, the operator's words can land in a different
 * conversation. That is not hypothetical: a repaint that fails after
 * switch_session leaves the host's cached `state` naming the previous thread
 * while the child has already moved.
 *
 * The composer therefore stamps every prompt with the thread it was composed
 * in, and the host refuses to deliver it anywhere else.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-crosswire-"));
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "crosswire", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const memory = new Map();
const state = { get: (k, d) => (memory.has(k) ? memory.get(k) : d), update: (k, v) => { memory.set(k, v); return Promise.resolve(); } };
const posts = [];
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: state, workspaceState: state },
	{ append: () => {}, appendLine: () => {} },
);
controller.attach({ post: (m) => posts.push(m) });
const rejections = () => posts.filter((p) => p.type === "promptRejected");
const payload = (text, sessionId) => ({ text, images: [], selections: [], streamingBehavior: "steer", clientRequestId: "req-1", ...(sessionId ? { sessionId } : {}) });

// --- own-RPC path: the child is asked, not the cached belief ------------------
// The scenario the probe reproduced: switch_session moved the child to TRADING,
// the repaint failed, so the host still believes DEV and the composer still
// shows DEV. The words must not land in TRADING.
const DEV = "01a05fe1-944a-7365-87b0-747f31bc9cf4";
const TRADING = "01a060ae-4ca7-75cf-a765-8dddb8a0193f";
let sent = [];
let liveSessionId = TRADING;
controller.client = {
	running: true,
	request: async (cmd) => {
		if (cmd.type === "get_state") return { success: true, data: { sessionId: liveSessionId, sessionFile: path.join(workdir, `${liveSessionId}.jsonl`) } };
		if (cmd.type === "get_messages") return { success: true, data: { messages: [] } };
		// Only prompts matter here; status/stats chatter must not pollute the count.
		if (cmd.type === "prompt") sent.push(cmd);
		return { success: true, data: {} };
	},
};
controller.ensureStarted = async () => {};
controller.state = { sessionId: DEV, sessionFile: path.join(workdir, `${DEV}.jsonl`) };  // stale belief
controller.attached = null;
controller.attachedEpoch = null;
controller.observingId = null;
controller.observationRestoring = false;
controller.reachable = true;

posts.length = 0;
sent = [];
await controller.prompt(payload("How is this going? ... our PRs and issues", DEV));
check("a prompt for another thread is NOT delivered to the child", sent.length === 0, `${sent.length} command(s) reached the agent`);
check("the operator is told nothing was sent", rejections().some((r) => /nothing was sent/i.test(r.error)), JSON.stringify(rejections().map((r) => r.error).slice(0, 1)));
check("the rejection is correlated so the text is restored", rejections()[0]?.clientRequestId === "req-1");

// The same send, once the view and the child agree, goes through untouched.
posts.length = 0;
sent = [];
liveSessionId = DEV;
await controller.prompt(payload("legitimate message", DEV));
check("a prompt for the thread on screen is delivered", sent.length === 1 && sent[0].type === "prompt");
check("the delivered text is unchanged", sent[0]?.message === "legitimate message");
check("no rejection for a matching thread", rejections().length === 0);

// An unstamped prompt (older webview build) keeps working — no regression.
posts.length = 0;
sent = [];
liveSessionId = TRADING;
controller.state = { sessionId: TRADING, sessionFile: path.join(workdir, `${TRADING}.jsonl`) };
await controller.prompt(payload("unstamped still works"));
check("an unstamped prompt is still delivered", sent.length === 1);

// --- attached path: the stamp must match the attachment ----------------------
posts.length = 0;
const attachSent = [];
controller.attached = { activeSessionId: "h-TRADING", sessionPath: path.join(workdir, `${TRADING}.jsonl`), sessionId: TRADING };
controller.attachedEpoch = controller.viewEpoch;
controller.sidecar = {
	connected: true,
	connect: async () => {},
	dispose: () => {},
	hasServerCapability: () => false,
	prompt: async (id, text) => { attachSent.push({ id, text }); },
};
await controller.prompt(payload("typed while looking at DEV", DEV));
check("an attached send for another thread is refused", attachSent.length === 0);
check("the attached refusal explains itself", rejections().some((r) => /different session/i.test(r.error)));

posts.length = 0;
await controller.prompt(payload("meant for this attachment", TRADING));
check("an attached send for the attached thread goes through", attachSent.length === 1 && attachSent[0].id === "h-TRADING");
check("no rejection when the attached thread matches", rejections().length === 0);

console.log(failed === 0 ? "\nPASS crosswire" : `\nFAIL crosswire (${failed} checks)`);
process.exit(failed === 0 ? 0 : 1);
