/**
 * Host behaviour specific to the Rust agent generation, driven through the real
 * SessionController with a stubbed vscode module and no agent at all:
 * the login offer after a credentials failure, following a re-issued handle,
 * roster-driven refresh of a shared session, promotion before following another
 * window's session, the changed-files attribution flag, thinking levels from the
 * agent's own list, and the install command that must not pretend.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { realTempDir, removeDir } from "./isolated-agent.mjs";

const require = createRequire(import.meta.url);
require("./vscode-stub.cjs");
const { vscodeStub } = require("./vscode-stub.cjs");
const { SessionController } = require("../dist/controller.cjs");

const work = realTempDir("pa-controller-rust-");
const agentHome = realTempDir("pa-controller-rust-agent-");
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentHome;
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: work, scheme: "file" }, name: "rust", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const memory = new Map();
const store = { get: (key, fallback) => (memory.has(key) ? memory.get(key) : fallback), update: (key, value) => { memory.set(key, value); return Promise.resolve(); } };
const posts = [];
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: store, workspaceState: store },
	{ append: () => {}, appendLine: () => {} },
);
controller.attach({ post: (message) => posts.push(message) });
const notices = () => posts.filter((message) => message.type === "notice");

// ---- a credentials failure offers the way out --------------------------------------------
controller.agentLaunch = { command: "/opt/prime/bin/prime-agent", env: { PATH: "/opt/prime/bin:/usr/bin" } };
controller.onAgentEvent({ type: "turn_end", error: "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key." });
const offer = notices().find((notice) => notice.action);
check("a credentials failure offers an action, not just a message", !!offer && /cannot run \/login/.test(offer.text), JSON.stringify(offer));
await controller.runNoticeAction(offer.action.id);
const terminal = vscodeStub.window.terminalsCreated.at(-1);
check("the action opens a terminal running the agent itself", terminal?.shellPath === "/opt/prime/bin/prime-agent" && terminal?.cwd === work && terminal?.env?.PATH === "/opt/prime/bin:/usr/bin", JSON.stringify(terminal));
const before = notices().length;
controller.onAgentEvent({ type: "turn_end", error: "Model \"x/y\" not found. Use \"prime-agent model list\" to see available models." });
check("an unrelated failure does not offer a login", notices().length === before);
controller.onAgentEvent({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
check("an ordinary turn end offers nothing", notices().length === before);

// ---- the install command does not pretend on a build that cannot load it ------------------------
controller.agentIsRust = true;
const installTarget = path.join(agentHome, "extensions", "background-jobs");
await controller.installBackgroundJobsExtension();
check("on the Rust agent the install command explains instead of installing", notices().at(-1)?.text.includes("does not load TypeScript agent extensions") && !fs.existsSync(installTarget), notices().at(-1)?.text);
controller.agentIsRust = false;

// ---- the changed-files strip claims "other" only when it could subtract ----------------------------
controller.changedFiles = new Set(["a.ts"]);
controller.agentIsRust = true;
posts.length = 0;
controller.pushChangedFiles();
check("Rust agent, no published diffs: the strip is unattributed", posts.at(-1)?.type === "changedFiles" && posts.at(-1).attributed === false, JSON.stringify(posts.at(-1)));
controller.agentIsRust = false;
controller.pushChangedFiles();
check("an agent that publishes diffs keeps the attributed strip", posts.at(-1)?.attributed === true);

// ---- thinking levels: the agent's own list beats a map it does not send ------------------------------
controller.state = { model: { provider: "p", id: "m" }, thinkingLevel: "low", availableThinkingLevels: ["off", "low"] };
check("advertised levels are what the menu offers", JSON.stringify(controller.buildStatus().availableThinkingLevels) === JSON.stringify(["off", "low"]));
controller.state = { model: { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" } }, thinkingLevel: "low" };
check("without them the model's own map is still honoured", JSON.stringify(controller.buildStatus().availableThinkingLevels) === JSON.stringify(["low", "medium", "high", "xhigh"]), JSON.stringify(controller.buildStatus().availableThinkingLevels));
controller.state = null;

// ---- a re-issued handle is followed in place ----------------------------------------------------------
{
	const states = [];
	controller.sidecar = {
		connected: true,
		connect: async () => {},
		dispose: () => {},
		getState: async () => (states.push(Date.now()), { model: { provider: "p", id: "m" }, thinkingLevel: "off" }),
		getMessages: async () => [],
		getSessionStats: async () => ({}),
		list: async () => [],
		request: async () => ({}),
	};
	const attachment = { activeSessionId: "old-handle", sessionPath: path.join(work, "s.jsonl"), sessionId: "s" };
	controller.attached = attachment;
	controller.attachedEpoch = controller.viewEpoch;
	controller.attachAttempt = { ...attachment };
	controller.attachAttemptEpoch = controller.viewEpoch;
	controller.onDaemonEvent({ type: "session_binding", previousActiveSessionId: "old-handle", activeSessionId: "new-handle" });
	check("the attached view moves to the new handle, in place", controller.attached === attachment && attachment.activeSessionId === "new-handle");
	check("a pending re-attach attempt follows it too", controller.attachAttempt.activeSessionId === "new-handle");
	controller.attachAttempt = null;
	// The binding started a snapshot refresh of its own; let it land before counting.
	await sleep(400);

	// ---- a roster push refreshes a shared session's header, coalesced --------------------------------------
	states.length = 0;
	for (let i = 0; i < 6; i += 1) controller.onRosterUpdate({ type: "roster_update" });
	await sleep(1_000);
	check("six roster pushes in a burst cost one state refresh", states.length === 1, `${states.length}`);

	controller.attached = null;
	controller.attachedEpoch = null;
	controller.sidecar = null;
}

// ---- a configured --session-dir reaches every listing --------------------------------------------------
{
	const asked = [];
	const stub = {
		list: async (all, options) => (asked.push(["list", options?.sessionDir]), []),
		listSavedSessions: async (cwd, scope, sessionDir) => (asked.push(["saved", sessionDir]), []),
		connected: true,
		connect: async () => {},
		dispose: () => {},
	};
	controller.sidecar = stub;
	controller.sessionDirOverride = undefined;
	await controller.listSessions(stub);
	await controller.savedSessionCatalog();
	check("with no --session-dir the daemon is asked for its default directory", asked.every(([, dir]) => dir === undefined), JSON.stringify(asked));
	asked.length = 0;
	controller.savedCatalog = null;
	controller.sessionDirOverride = "/ops/sessions";
	await controller.listSessions(stub);
	await controller.savedSessionCatalog();
	check("with one, both the roster and the saved-session catalog are told where to look", asked.length === 2 && asked.every(([, dir]) => dir === "/ops/sessions"), JSON.stringify(asked));
	controller.sessionDirOverride = undefined;
	controller.sidecar = null;
}

// ---- a saved session is not a resident one --------------------------------------------------------
{
	const resident = { activeSessionId: "a1b2c3d4e5f6", sessionId: "01a16187-eb9e-7186-a3b0-3b1a9333927e" };
	const saved = { activeSessionId: "01a16187-eb9e-7186-a3b0-3b1a9333927e", sessionId: "01a16187-eb9e-7186-a3b0-3b1a9333927e", id: "01a16187-eb9e-7186-a3b0-3b1a9333927e" };
	check("a row whose handle is its own UUID has no worker to attach to", SessionController.isResidentRow(saved) === false);
	check("a row with a distinct attach handle is resident", SessionController.isResidentRow(resident) === true);
	check("a row with a handle and no UUID is trusted (older rosters)", SessionController.isResidentRow({ activeSessionId: "a1b2c3d4e5f6" }) === true);
	check("a row with no handle at all is not", SessionController.isResidentRow({ id: "x" }) === false);
}

// ---- following another window's session promotes it first ----------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: { promote_owned_session: () => undefined } });
	process.env.PRIME_AGENT_DAEMON_SOCKET = daemon.socketPath;
	const workers = path.join(agentHome, "daemon-workers", "key");
	fs.mkdirSync(workers, { recursive: true });
	const sessionFile = path.join(work, "foreign.jsonl");
	fs.writeFileSync(
		path.join(workers, "w1.json"),
		JSON.stringify({ workerId: "w1", pid: process.pid, rootActiveSessionId: "foreign-handle", ownerClientId: "other-window", sessionFile, createdAt: new Date().toISOString() }),
	);
	await controller.promoteIfForeignOwned("foreign-handle", sessionFile);
	const promoted = daemon.commands("promote_owned_session")[0];
	check("a session owned by another window is promoted before it is followed", promoted?.clientId === "other-window" && promoted?.command.activeSessionId === "foreign-handle", JSON.stringify(promoted && { as: promoted.clientId, id: promoted.command.activeSessionId }));

	const count = daemon.commands("promote_owned_session").length;
	controller.state = { sessionFile };
	await controller.promoteIfForeignOwned("foreign-handle", sessionFile);
	check("this window's own session is never promoted by looking at it", daemon.commands("promote_owned_session").length === count);
	controller.state = null;

	await controller.promoteIfForeignOwned("unowned-handle", path.join(work, "nobody.jsonl"));
	check("a session with no readable owner is left alone", daemon.commands("promote_owned_session").length === count);
	delete process.env.PRIME_AGENT_DAEMON_SOCKET;
	await daemon.stop();
}

// ---- hosted-session lifecycle edges, against a controller and client bundled together -----------------------
// (dist/ cannot lend the DaemonRpcClient class the controller tests with `instanceof`.)
{
	const { bundle } = await import("./bundle.mjs");
	const os = await import("node:os");
	const entry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pa-entry-")), "entry.ts");
	const root = process.cwd();
	fs.writeFileSync(entry, `export { SessionController } from ${JSON.stringify(path.join(root, "src/session-controller.ts"))};\nexport { DaemonRpcClient } from ${JSON.stringify(path.join(root, "src/daemon-rpc-client.ts"))};\n`);
	const { mod, dispose } = bundle(entry);
	const hosted = new mod.SessionController(
		{ subscriptions: [], extensionUri: { fsPath: root }, globalState: store, workspaceState: store },
		{ append: () => {}, appendLine: () => {} },
	);
	const hostedPosts = [];
	hosted.attach({ post: (message) => hostedPosts.push(message) });
	const daemon = await startFakeDaemon({
		handlers: {
			create: () => ({ id: "h1", activeSessionId: "h1" }),
			attach: () => ({ activeSessionId: "h1", snapshot: {} }),
			kill: () => undefined,
		},
	});

	// A dead hosted client lends no owner identity (the daemon could never reap what it names).
	const hostedClient = new mod.DaemonRpcClient({ socketPath: daemon.socketPath, config: { cwd: work } });
	await hostedClient.open();
	hosted.client = hostedClient;
	check("a live hosted session's owner identity is the client's own", hosted.ownedRosterClientId() === hostedClient.ownerClientId && !!hostedClient.ownerClientId);
	await hostedClient.stop();
	check("once it has ended it lends none", hosted.ownedRosterClientId() === undefined);
	hosted.client = null;

	// A prompt whose client was replaced mid-send is rejected visibly, not dropped.
	{
		const replies = [];
		const stub = Object.assign(new (await import("node:events")).EventEmitter(), {
			running: true,
			request: async () => {
				hosted.client = {};
				throw new Error("socket closed");
			},
		});
		hosted.client = stub;
		await hosted.prompt({ text: "hello", images: [], selections: [], streamingBehavior: "steer", clientRequestId: "c-1" }, (message) => replies.push(message));
		const rejection = replies.find((message) => message.type === "promptRejected");
		check("a prompt whose client was replaced mid-send is rejected, so its echo is settled", rejection?.clientRequestId === "c-1" && /session changed/.test(rejection.error) && !replies.some((message) => message.type === "promptAccepted"), JSON.stringify(replies));
		hosted.client = null;
	}

	// The sidecar being replaced while its socket is located must not leave a connection behind.
	{
		hosted.resolveDaemonSocket = async () => {
			hosted.sidecar?.dispose();
			hosted.sidecar = null;
			return daemon.socketPath;
		};
		await sleep(100);
		const before = daemon.connectionCount();
		const outcome = await hosted.ensureSidecar().then(() => "resolved", (error) => error);
		await sleep(100);
		check("ensureSidecar rejects when the connection it was making was released meanwhile", outcome instanceof Error && /replaced/.test(outcome.message), String(outcome?.message ?? outcome));
		check("and opens no connection for the released sidecar", daemon.connectionCount() === before && hosted.sidecar === null, `connections ${before} -> ${daemon.connectionCount()}, sidecar ${hosted.sidecar ? "set" : "null"}`);
		delete hosted.resolveDaemonSocket;
	}

	hosted.dispose();
	await daemon.stop();
	dispose();
	fs.rmSync(path.dirname(entry), { recursive: true, force: true });
}

controller.dispose();
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
await removeDir(work);
await removeDir(agentHome);
console.log(failed === 0 ? "\nPASS controller-rust" : `\n${failed} controller-rust checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
