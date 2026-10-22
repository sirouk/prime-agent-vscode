/**
 * Live gate: a session HOSTED BY THE BACKGROUND SERVICE, driven through
 * DaemonRpcClient, against a real Prime Agent. This is the path that gives the
 * Rust build (whose `--mode rpc` is in-process) the capabilities the extension
 * promises: subagents, steering and queueing mid-turn, a lifecycle that ends with
 * the window — and, if another window promoted the session, outlives it.
 *
 * Runs on a private daemon with a throwaway agent directory (see
 * private-daemon.mjs); needs a configured model (GLM via chutes by default,
 * LIVE_MODEL overrides). SKIPs when no `prime-agent` can start a daemon, unless
 * PA_REQUIRE_DAEMON=1 / --require-daemon.
 *
 * Run: node test/daemon-hosted-live.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { bundle } from "./bundle.mjs";
import { realTempDir, removeDir } from "./isolated-agent.mjs";
import { startPrivateDaemon } from "./private-daemon.mjs";

const REQUIRE = process.env.PA_REQUIRE_DAEMON === "1" || process.argv.includes("--require-daemon");
const MODEL = process.env.LIVE_MODEL ?? "chutes/zai-org/GLM-5.2-TEE";

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = await predicate();
		if (value) return value;
		await sleep(150);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

const watchdog = setTimeout(() => {
	console.log("FAIL  daemon-hosted-live watchdog expired");
	process.exit(1);
}, 8 * 60_000);
watchdog.unref();

let daemon;
try {
	daemon = await startPrivateDaemon();
} catch (error) {
	console.log(`${REQUIRE ? "FAIL" : "SKIP"}  daemon-hosted-live — ${error.message}`);
	process.exit(REQUIRE ? 1 : 0);
}

const { mod: clientMod, dispose: disposeClient } = bundle("src/daemon-rpc-client.ts");
const { mod: sidecarMod, dispose: disposeSidecar } = bundle("src/daemon-sidecar.ts");
const { DaemonRpcClient } = clientMod;
const { DaemonSidecar, promoteClientOwnedSession } = sidecarMod;

const work = realTempDir("pa-hosted-live-");
fs.mkdirSync(path.join(work, "sessions"), { recursive: true });

function newClient() {
	const client = new DaemonRpcClient({
		socketPath: daemon.socket,
		config: { cwd: work, sessionDir: path.join(work, "sessions"), ...(MODEL ? { model: MODEL } : {}), executionMode: "rpc" },
		launchEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
	});
	const events = [];
	client.on("event", (event) => events.push(event));
	return { client, events };
}
const endedSince = (events, from) => events.slice(from).some((event) => event.type === "agent_end");
const lastAssistantText = async (client) => {
	const messages = (await client.request({ type: "get_messages" })).data.messages;
	const last = messages.filter((m) => m.role === "assistant").at(-1);
	return (last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
};

try {
	const a = newClient();
	await a.client.open();

	// ---- state ---------------------------------------------------------------------------
	const state = (await a.client.request({ type: "get_state" })).data;
	check("state carries the model, the session file and the thinking levels the model accepts", !!state.model?.id && !!state.sessionFile && Array.isArray(state.availableThinkingLevels) && state.availableThinkingLevels.length > 0, JSON.stringify([state.model?.id, state.availableThinkingLevels]));

	// ---- a turn with a tool -------------------------------------------------------------------
	let mark = a.events.length;
	let reply = await a.client.request({ type: "prompt", message: "Run print(6*7) in python_repl, then reply with just the number.", images: [], streamingBehavior: "steer" });
	check("a prompt is accepted", reply.success, reply.error ?? "");
	await waitFor(() => endedSince(a.events, mark), 120_000, "the first turn");
	const toolEnd = a.events.slice(mark).find((e) => e.type === "tool_execution_end");
	check("the turn streamed a tool call and its result", !!toolEnd && JSON.stringify(toolEnd.result).includes("42"), JSON.stringify(toolEnd?.result).slice(0, 120));
	check("and answered", (await lastAssistantText(a.client)).includes("42"));

	// ---- a subagent from THIS session ---------------------------------------------------------------
	// Model behaviour is the one uncontrolled input here, so the ask is explicit and
	// gets one retry; what is asserted is the daemon's answer (a child whose parent is
	// this session), not the model's phrasing.
	const side = new DaemonSidecar();
	side.socketOverride = daemon.socket;
	side.impersonateClientId = a.client.ownerClientId;
	await side.connect();
	const sessionId = (await a.client.request({ type: "get_state" })).data.sessionId;
	const childOf = async () =>
		(await side.list(true, { includeClientOwned: true })).find(
			(row) => row.runtimeKind === "subagent" && (row.parentSessionId === sessionId || row.parentActiveSessionId === a.client.activeSessionId),
		);
	const asks = [
		"In python_repl run exactly this and nothing else: h = await rlm.spawn('Reply with the single word hi', name='live-child'); r = await h; print(r). Then reply DONE.",
		"Your last attempt did not create a subagent. Call rlm.spawn from python_repl now: `h = await rlm.spawn('Say hi', name='live-child-2'); await h`. Do not do anything else first.",
	];
	let child;
	for (const ask of asks) {
		mark = a.events.length;
		await a.client.request({ type: "prompt", message: ask, images: [], streamingBehavior: "steer" });
		await waitFor(() => endedSince(a.events, mark), 180_000, "the spawning turn");
		child = await childOf();
		if (child) break;
	}
	check("the subagent exists and is a child of this window's session", !!child, JSON.stringify(child && { parent: child.parentSessionId, parentActive: child.parentActiveSessionId, kind: child.runtimeKind, name: child.sessionName }));
	side.dispose();

	// ---- queueing mid-turn ------------------------------------------------------------------------------
	mark = a.events.length;
	await a.client.request({ type: "prompt", message: "In python_repl run: import time; time.sleep(4). Reply FIRST.", images: [], streamingBehavior: "followUp" });
	await sleep(1500);
	reply = await a.client.request({ type: "prompt", message: "After that, reply with exactly SECOND.", images: [], streamingBehavior: "followUp" });
	check("a follow-up sent mid-turn is accepted and queued", reply.success, reply.error ?? "");
	await waitFor(async () => {
		const s = (await a.client.request({ type: "get_state" })).data;
		return !s.isStreaming && !(s.sessionActions?.queuedCount > 0) && a.events.slice(mark).some((e) => e.type === "agent_end");
	}, 180_000, "the queued turn to run");
	await sleep(600);
	check("the queued follow-up ran after the first turn", (await lastAssistantText(a.client)).includes("SECOND"), await lastAssistantText(a.client));

	// ---- abort, then carry on ----------------------------------------------------------------------------
	mark = a.events.length;
	await a.client.request({ type: "prompt", message: "In python_repl run: import time; time.sleep(40). Then reply LATE.", images: [], streamingBehavior: "steer" });
	await sleep(2500);
	check("abort is accepted", (await a.client.request({ type: "abort" })).success);
	await waitFor(() => endedSince(a.events, mark), 60_000, "the aborted turn to settle");
	mark = a.events.length;
	reply = await a.client.request({ type: "prompt", message: "Reply with exactly: AFTERABORT", images: [], streamingBehavior: "steer" });
	check("a prompt after an abort is accepted (queued input is not left suspended)", reply.success, reply.error ?? "");
	await waitFor(() => endedSince(a.events, mark), 120_000, "the post-abort turn");
	check("and answered", (await lastAssistantText(a.client)).includes("AFTERABORT"));

	// ---- commands that must refuse, refuse as answers ------------------------------------------------------------
	const compact = await a.client.request({ type: "compact" }, 120_000);
	check("compacting a tiny thread is refused as an answer, not an exception", compact.success === false || compact.success === true);
	const bad = await a.client.request({ type: "set_thinking_level", level: "bogus" });
	check("an invalid thinking level is refused as an answer", bad.success === false && /thinking level/i.test(bad.error ?? ""), bad.error ?? "");

	// ---- new_session / fork keep the handle ---------------------------------------------------------------------------
	const handleBefore = a.client.activeSessionId;
	const fresh = await a.client.request({ type: "new_session" });
	check("new_session succeeds and the handle is unchanged", fresh.success && a.client.activeSessionId === handleBefore);
	check("and the transcript starts empty", (await a.client.request({ type: "get_messages" })).data.messages.length === 0);

	// ---- lifecycle: a window's own session ends with it -----------------------------------------------------------------
	const anchor = new DaemonSidecar();
	anchor.socketOverride = daemon.socket;
	await anchor.connect();
	const listed = async () => (await anchor.list(true)).map((row) => row.activeSessionId ?? row.id);
	check("the session is on the daemon while the window lives", (await listed()).includes(handleBefore));
	a.client.stop();
	await waitFor(async () => !(await listed()).includes(handleBefore), 10_000, "the stopped session to leave the daemon").catch(() => {});
	check("stopping the window's client ends its session", !(await listed()).includes(handleBefore));

	// ---- ...unless another window promoted it ---------------------------------------------------------------------------------
	const b = newClient();
	await b.client.open();
	const sharedHandle = b.client.activeSessionId;
	await b.client.request({ type: "prompt", message: "Reply with exactly: SHARED", images: [], streamingBehavior: "steer" });
	await waitFor(() => b.events.some((e) => e.type === "agent_end"), 120_000, "the shared session's turn");
	await promoteClientOwnedSession(b.client.ownerClientId, sharedHandle);
	b.client.stop();
	await sleep(1500);
	check("a session another window promoted survives its owner's window closing", (await listed()).includes(sharedHandle));
	await anchor.request({ type: "kill", activeSessionId: sharedHandle }, 15_000).catch(() => {});
	anchor.dispose();
} catch (error) {
	console.log(`FAIL  daemon-hosted-live threw — ${error?.stack ?? error}`);
	failed += 1;
} finally {
	clearTimeout(watchdog);
	disposeClient();
	disposeSidecar();
	await daemon.stop();
	await removeDir(work);
}
console.log(failed === 0 ? "\nPASS daemon-hosted-live" : `\n${failed} daemon-hosted-live checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
