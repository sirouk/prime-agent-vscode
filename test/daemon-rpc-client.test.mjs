/**
 * DaemonRpcClient (src/daemon-rpc-client.ts): a session hosted by the background
 * service, driven through the RpcClient interface. Exercised against a fake
 * daemon that records every envelope, so what the client SENDS (create shape,
 * owner identity, verb mapping) is asserted as hard as what it returns.
 */
import { bundle } from "./bundle.mjs";
import { refusal, startFakeDaemon } from "./fake-daemon.mjs";

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await sleep(20);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

const { mod, dispose } = bundle("src/daemon-rpc-client.ts");
const { DaemonRpcClient } = mod;

const CONNECTION_STATE = {
	activeSessionId: "h1",
	model: { provider: "p", id: "from-connection" },
	thinkingLevel: "low",
	availableThinkingLevels: ["off", "low"],
	isStreaming: false,
	steeringMode: "all",
	sessionFile: "/s/1.jsonl",
	sessionId: "uuid-1",
	autoCompactionEnabled: true,
	contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 },
};
const SUMMARY = { id: "h1", activeSessionId: "h1", sessionName: "named", model: { provider: "p", id: "from-summary" }, messageCount: 3, lifecycle: "live" };

function handlers(extra = {}) {
	return {
		create: () => ({ id: "h1", activeSessionId: "h1", sessionId: "uuid-1", sessionFile: "/s/1.jsonl" }),
		attach: () => ({ activeSessionId: "h1", snapshot: {} }),
		get_connection_state: () => CONNECTION_STATE,
		get_state: () => SUMMARY,
		prompt: () => undefined,
		abort: () => undefined,
		get_user_messages_for_forking: () => ({ messages: [{ entryId: "e1", text: "hi" }] }),
		fork: () => ({ cancelled: false, selectedText: "the forked text" }),
		set_thinking_level: () => {
			throw refusal('Invalid thinking level "bogus"');
		},
		new_session: () => ({ cancelled: false }),
		reload: () => undefined,
		kill: () => undefined,
		...extra,
	};
}

async function open(daemon, options = {}) {
	const client = new DaemonRpcClient({
		socketPath: daemon.socketPath,
		config: { cwd: "/work", executionMode: "rpc", model: "p/m" },
		launchEnv: { PATH: "/usr/bin", MARK: "yes" },
		...options,
	});
	const events = [];
	const exits = [];
	const resyncs = [];
	client.on("event", (e) => events.push(e));
	client.on("exit", (code, reason) => exits.push({ code, reason }));
	client.on("resync", () => resyncs.push(Date.now()));
	await client.open();
	return { client, events, exits, resyncs };
}

// ---- open: what is sent ---------------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client } = await open(daemon, { telemetryDisabled: true });
	const create = daemon.commands("create")[0]?.command;
	check("the session is created client-owned, so it ends with the window", create?.lifecycle === "client_owned");
	check("the create carries the translated config and the client's environment", create?.config?.model === "p/m" && create?.config?.cwd === "/work" && create?.launchEnv?.MARK === "yes", JSON.stringify(create));
	check("an environment opt-out rides the create", create?.telemetryDisabled === true);
	const attach = daemon.commands("attach")[0]?.command;
	check("then it attaches to what it created, with the snapshot capabilities", attach?.activeSessionId === "h1" && attach?.capabilities?.includes("attach_snapshot"), JSON.stringify(attach));
	check("the owner identity is the connection's own client id", client.ownerClientId === daemon.commands("create")[0].connection && client.ownerClientId?.startsWith("fake-client-"), String(client.ownerClientId));
	check("the handle is exposed, and the client reports running", client.activeSessionId === "h1" && client.running === true);
	client.stop();
	await waitFor(() => daemon.commands("kill").length === 1, 3_000, "kill on stop");
	await daemon.stop();
}

// ---- requests: verb mapping and shapes ---------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client, events } = await open(daemon);

	const state = await client.request({ type: "get_state" });
	check("get_state merges the roster summary with the full connection state", state.success && state.data.sessionName === "named" && state.data.availableThinkingLevels?.length === 2 && state.data.steeringMode === "all", JSON.stringify(Object.keys(state.data)));
	check("where the two overlap the fuller connection state wins", state.data.model.id === "from-connection");

	const prompt = await client.request({ type: "prompt", message: "hello", images: [], streamingBehavior: "steer", id: "ignored-by-wire" });
	const sent = daemon.commands("prompt")[0].command;
	check("a prompt reaches the session by handle, queued if busy, without the caller's request id", prompt.success && sent.activeSessionId === "h1" && sent.message === "hello" && sent.streamingBehavior === "steer" && sent.queueIfBusy === true && !("id" in sent), JSON.stringify(sent));

	const forkList = await client.request({ type: "get_fork_messages" });
	check("get_fork_messages is the daemon's get_user_messages_for_forking", forkList.success && forkList.data.messages[0].entryId === "e1" && daemon.commands("get_user_messages_for_forking").length === 1);
	const fork = await client.request({ type: "fork", entryId: "e1" });
	check("fork answers with `text`, as RPC does, from the daemon's `selectedText`", fork.success && fork.data.text === "the forked text" && fork.data.cancelled === false, JSON.stringify(fork.data));

	const refused = await client.request({ type: "set_thinking_level", level: "bogus" });
	check("a refused command resolves success:false with the daemon's words", refused.success === false && /Invalid thinking level/.test(refused.error), JSON.stringify(refused));

	const observed = await client.request({ type: "observe", activeSessionId: "other" });
	check("observe is declined, by name, without a round trip", observed.success === false && /attach/.test(observed.error) && daemon.commands("observe").length === 0);
	check("unobserve is a harmless success", (await client.request({ type: "unobserve" })).success === true);

	const fresh = await client.request({ type: "new_session" });
	check("new_session keeps the same handle", fresh.success && fresh.data.cancelled === false && client.activeSessionId === "h1");
	check("reload is passed through", (await client.request({ type: "reload" })).success === true);

	// ---- events ------------------------------------------------------------------------
	daemon.push({ type: "session_event", activeSessionId: "h1", event: { type: "agent_start" }, meta: { sequence: 1 } });
	daemon.push({ type: "session_event", activeSessionId: "someone-else", event: { type: "agent_start", other: true } });
	daemon.push({ type: "session_event", activeSessionId: "h1", event: { type: "message_update", n: 2 } });
	await waitFor(() => events.length >= 2, 2_000, "events");
	await sleep(100);
	check("this session's events are re-emitted untouched, in order", events.length === 2 && events[0].type === "agent_start" && events[1].n === 2, JSON.stringify(events));
	check("another session's events are not ours", !events.some((e) => e.other));

	client.stop();
	await daemon.stop();
}

// ---- the daemon replaces the worker and re-issues the handle ---------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client, events, resyncs } = await open(daemon);
	daemon.push({ type: "session_binding", previousActiveSessionId: "h1", activeSessionId: "h2" });
	await waitFor(() => client.activeSessionId === "h2", 2_000, "rebind");
	daemon.push({ type: "session_event", activeSessionId: "h2", event: { type: "agent_start" } });
	await waitFor(() => events.some((e) => e.type === "agent_start"), 2_000, "event under the new handle");
	await client.request({ type: "abort" });
	check("the new handle is adopted, its events flow, and commands address it", client.activeSessionId === "h2" && daemon.commands("abort").at(-1).command.activeSessionId === "h2");
	check("the binding itself is not leaked as an agent event, but asks for a resync", !events.some((e) => e.type === "session_binding") && resyncs.length === 1);
	client.stop();
	await daemon.stop();
}

// ---- the session ends --------------------------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client, exits } = await open(daemon);
	daemon.push({ type: "session_closed", activeSessionId: "h1", reason: "update" });
	await sleep(150);
	check("a handover (reason: update) is not an end", exits.length === 0 && client.running === true);
	daemon.push({ type: "session_closed", activeSessionId: "h1", reason: "killed" });
	await waitFor(() => exits.length === 1, 2_000, "exit on kill");
	check("a killed session reports exit once and stops running", exits[0].reason === "session killed" && client.running === false);
	let rejected = false;
	await client.request({ type: "get_state" }).catch(() => (rejected = true));
	check("requests on an ended session reject, as on a dead process", rejected);
	await daemon.stop();
}

// ---- stop ------------------------------------------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client, exits } = await open(daemon);
	await client.stop();
	check("stop() settles only once the daemon has the kill, so a closing window can wait for it", daemon.commands("kill").length === 1, String(daemon.commands("kill").length));
	await waitFor(() => daemon.commands("kill").length === 1, 3_000, "kill");
	check("stop ends the session on the daemon (an empty draft disappears)", daemon.commands("kill")[0].command.activeSessionId === "h1");
	await sleep(100);
	check("an intentional stop is not reported as an exit", exits.length === 0 && client.running === false);
	await daemon.stop();
}

// ---- stop while the session is still being created ------------------------------------------------------
{
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const daemon = await startFakeDaemon({ handlers: handlers({ create: async () => { await gate; return { id: "h9", activeSessionId: "h9" }; } }) });
	const client = new DaemonRpcClient({ socketPath: daemon.socketPath, config: { cwd: "/work" } });
	const opening = client.open().catch((error) => error);
	await waitFor(() => daemon.commands("create").length === 1, 2_000, "create in flight");
	client.stop();
	release();
	const outcome = await opening;
	check("a stop that lands mid-create fails the open", outcome instanceof Error);
	await sleep(300);
	check("and the session that was created anyway is killed, not left for the daemon to reap", daemon.commands("kill").some((entry) => entry.command.activeSessionId === "h9") && daemon.commands("attach").length === 0, JSON.stringify(daemon.received.map((e) => e.command.type)));
	await daemon.stop();
}

// ---- open failure --------------------------------------------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers({ create: () => { throw refusal("Invalid thinking level \"zzz\""); } }) });
	const client = new DaemonRpcClient({ socketPath: daemon.socketPath, config: { cwd: "/work", thinking: "zzz" } });
	const error = await client.open().then(() => null, (e) => e);
	check("a refused create rejects open with the daemon's reason", error instanceof Error && /Invalid thinking level/.test(error.message), error?.message);
	check("and leaves nothing running", client.running === false);
	await daemon.stop();
}

// ---- a dropped connection: rebind as the same owner ------------------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client, exits, resyncs } = await open(daemon);
	const owner = client.ownerClientId;
	daemon.dropAll();
	await waitFor(() => resyncs.length === 1, 8_000, "reconnect + resync");
	const reattach = daemon.commands("attach").at(-1);
	check("it reconnects, claims the same owner identity, and re-attaches the same session", daemon.commands("attach").length === 2 && reattach.clientId === owner && reattach.command.activeSessionId === "h1", JSON.stringify({ owner, claimed: reattach.clientId }));
	check("no exit is reported for a blip", exits.length === 0 && client.running === true);
	const after = await client.request({ type: "get_state" });
	check("requests work again afterwards", after.success === true);
	client.stop();
	await daemon.stop();
}

// ---- a daemon that says it is shutting down is not waited for ------------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers() });
	const { client, exits } = await open(daemon);
	daemon.push({ type: "daemon_closing", reason: "shutdown" });
	await sleep(80);
	daemon.dropAll();
	await waitFor(() => exits.length === 1, 3_000, "exit after announced shutdown");
	check("an announced shutdown ends the session instead of chasing the daemon", exits[0].reason === "daemon shutdown" && client.running === false);
	await daemon.stop();
}

// ---- a request that dies with the socket rejects (it is not an answer) ---------------------------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers({ get_session_stats: () => new Promise(() => {}) }) });
	const { client } = await open(daemon);
	const pending = client.request({ type: "get_session_stats" }, 5_000).then(() => "resolved", () => "rejected");
	await waitFor(() => daemon.commands("get_session_stats").length === 1, 2_000, "stats in flight");
	daemon.dropAll();
	check("a dead socket rejects the request rather than inventing a failure answer", (await pending) === "rejected");
	client.stop();
	await daemon.stop();
}

// ---- a daemon that is restarting says "later"; one that forgot the session does not ----------------------------------------
{
	let attaches = 0;
	const daemon = await startFakeDaemon({
		handlers: handlers({
			attach: () => {
				attaches += 1;
				if (attaches === 2) throw refusal("daemon restarting", { code: "update_restarting", message: "daemon restarting" });
				return { activeSessionId: "h1", snapshot: {} };
			},
		}),
	});
	const { client, exits, resyncs } = await open(daemon);
	daemon.dropAll();
	await waitFor(() => resyncs.length === 1, 12_000, "resync after a retryable refusal");
	check("a retryable refusal (update_restarting) is waited out, not taken for the end", attaches === 3 && exits.length === 0 && client.running === true, `attaches=${attaches}`);
	client.stop();
	await daemon.stop();
}
{
	let attaches = 0;
	const daemon = await startFakeDaemon({
		handlers: handlers({
			attach: () => {
				attaches += 1;
				if (attaches >= 2) throw refusal("Unknown active session: h1", { code: "unknown_session", message: "Unknown active session: h1" });
				return { activeSessionId: "h1", snapshot: {} };
			},
		}),
	});
	const { client, exits } = await open(daemon);
	daemon.dropAll();
	await waitFor(() => exits.length === 1, 5_000, "exit when the daemon no longer knows the session");
	check("a daemon that no longer knows the session ends it at once, with one exit", attaches === 2 && exits[0].reason === "daemon connection lost" && client.running === false, `attaches=${attaches}`);
	await daemon.stop();
}

// ---- a worker replaced while the socket was down answers with its current handle -----------------------------------------------
{
	let attaches = 0;
	const daemon = await startFakeDaemon({
		handlers: handlers({
			attach: () => {
				attaches += 1;
				return { activeSessionId: attaches === 1 ? "h1" : "h7", snapshot: {} };
			},
		}),
	});
	const { client, resyncs } = await open(daemon);
	daemon.dropAll();
	await waitFor(() => resyncs.length === 1, 8_000, "resync");
	await client.request({ type: "abort" });
	check("the handle the daemon answers with is adopted, and commands address it", client.activeSessionId === "h7" && daemon.commands("abort").at(-1).command.activeSessionId === "h7", String(client.activeSessionId));
	client.stop();
	await daemon.stop();
}

// ---- stop while the daemon is too slow to create: bounded, never hangs Restart or exit ---------------------------------------
{
	const daemon = await startFakeDaemon({ handlers: handlers({ create: () => new Promise(() => {}) }) });
	const client = new DaemonRpcClient({ socketPath: daemon.socketPath, config: { cwd: "/work" } });
	const opening = client.open().then(() => "opened", (error) => error);
	await waitFor(() => daemon.commands("create").length === 1, 2_000, "create in flight");
	const started = Date.now();
	await client.stop();
	const elapsed = Date.now() - started;
	check("stop() during a create that never answers returns within its grace, not the create timeout", elapsed < 4_000, `${elapsed}ms`);
	const outcome = await Promise.race([opening, sleep(3_000).then(() => "still pending")]);
	check("and the open fails rather than hanging", outcome instanceof Error, String(outcome));
	check("and the client is not running", client.running === false);
	await daemon.stop();
}

dispose();
console.log(failed === 0 ? "\nPASS daemon-rpc-client" : `\n${failed} daemon-rpc-client checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
