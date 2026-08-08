/**
 * Daemon parity harness: verifies end-to-end, without VS Code, that a client
 * speaking only the daemon protocol (prime-agent.daemon v7, unix socket) can
 * drive a resident session the same way the terminal client does:
 *
 *   create (lifecycle: "resident") -> visible to a second client via list ->
 *   attach -> prompt -> session_event stream -> get_messages shows the
 *   assistant reply -> detach + kill cleanup.
 *
 * This is the flow SessionController.attachViaDaemon uses when RPC
 * switch_session reports "Session is already active".
 *
 * DaemonSidecar is bundled from src/daemon-sidecar.ts with esbuild into a
 * temp CJS file (same approach as test/export-md.test.mjs), so the test
 * exercises real socket-discovery and protocol code, not a copy.
 *
 * Safety: only ever creates/attaches/prompts/kills sessions IT created,
 * rooted in an isolated mkdtemp directory (cwd + sessionDir inside it).
 * Sessions from `list` are never touched.
 *
 * No daemon running? The whole test SKIP-exits 0 so CI never hangs — unless
 * PA_REQUIRE_DAEMON=1 / --require-daemon, which turns the skip into a failure
 * (npm run test:live passes the flag: a silently-unrun C9 gate is worse than
 * no gate).
 * Hard watchdog: the process exits well inside 3 minutes regardless.
 *
 * Model selection: DAEMON_PARITY_MODEL (default "chutes/zai-org/GLM-4.7";
 * set to "" to always use the daemon's default model). If the requested
 * model fails provider-side (stopReason "error" / exhausted auto-retries),
 * the harness retries once on a fresh resident session WITHOUT a model
 * override (daemon default) and reports which path produced the result.
 *
 * Run: node test/daemon-parity.mjs
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const PROMPT_TEXT = "Reply with exactly: PARITY-OK";
const EXPECTED_TEXT = "PARITY-OK";
const REQUESTED_MODEL = process.env.DAEMON_PARITY_MODEL ?? "chutes/zai-org/GLM-4.7";
const CONNECT_TIMEOUT_MS = 8_000;
const CREATE_TIMEOUT_MS = 45_000;
const TURN_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;
const WATCHDOG_MS = 170_000;

let failed = 0;
let total = 0;
function check(name, condition, detail = "") {
	total += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
	return condition;
}
function skip(reason) {
	// Exit 0 on a skip makes an unrun suite indistinguishable from a pass inside
	// an `&&` chain. Where C9 is supposed to be gated (release.sh, npm run
	// test:live) PA_REQUIRE_DAEMON=1 turns "no daemon" into a red run instead.
	if (process.env.PA_REQUIRE_DAEMON === "1" || process.argv.includes("--require-daemon")) {
		console.log(`FAIL  daemon-parity SKIPPED — C9 (dual client / attach) UNVERIFIED: ${reason}`);
		console.log("      Start the daemon (`prime-agent --mode daemon`) or unset PA_REQUIRE_DAEMON to allow the skip.");
		process.exit(1);
	}
	console.log(`SKIP  daemon-parity — ${reason} (C9 UNVERIFIED; set PA_REQUIRE_DAEMON=1 to make this fatal)`);
	process.exit(0);
}
function info(message) {
	console.log(`INFO  ${message}`);
}
// Hard watchdog: nothing below may park the process past this.
const watchdog = setTimeout(() => {
	console.log(`FAIL  watchdog — exceeded ${WATCHDOG_MS}ms; aborting`);
	process.exit(2);
}, WATCHDOG_MS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Global budget: leave headroom for cleanup before the watchdog fires.
const globalDeadline = Date.now() + (WATCHDOG_MS - 15_000);
const budgetMs = () => Math.max(0, globalDeadline - Date.now());

/** Extract visible text from a message, tolerant of content shapes. */
function messageText(message) {
	if (!message || typeof message !== "object") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}
function assistantText(messages) {
	return messages.filter((m) => m && m.role === "assistant").map(messageText).join("\n");
}

// mkdtemp must not crash a broken TMPDIR before we can print a clean SKIP.
const tmpBase = fs.existsSync(os.tmpdir()) ? os.tmpdir() : "/tmp";
const workRoot = fs.mkdtempSync(path.join(tmpBase, "daemon-parity-"));
let sidecar = null;
/** ids of sessions THIS test created — the only ones we may touch. */
const ownIds = new Set();
let cleaned = false;

async function killOwnSessions() {
	if (!sidecar?.connected) return;
	for (const id of ownIds) {
		try { await sidecar.request({ type: "kill", activeSessionId: id }, 15_000); }
		catch { /* best effort */ }
	}
}
async function cleanup() {
	if (cleaned) return;
	cleaned = true;
	await killOwnSessions();
	try { sidecar?.dispose(); } catch { /* ignore */ }
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try { fs.rmSync(workRoot, { recursive: true, force: true }); break; }
		catch { await sleep(400); }
	}
}
process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

// Per-own-session event journal.
const eventsById = new Map(); // id -> string[] event types
const agentEndResolvers = new Map(); // id -> () => void
function journalEvent(message) {
	const id = message.activeSessionId;
	if (typeof id !== "string" || !ownIds.has(id)) return;
	if (message.type !== "session_event") return;
	const type = message.event?.type ?? "?";
	let list = eventsById.get(id);
	if (!list) { list = []; eventsById.set(id, list); }
	list.push(type);
	if (type === "message_end" || type === "turn_end") {
		const stopReason = message.event?.message?.stopReason;
		if (stopReason === "error") list.push(`error:${message.event?.message?.errorMessage ?? "unknown"}`);
	}
	if (type === "auto_retry_start") list.push(`retry:${message.event?.errorMessage ?? ""}`);
	if (type === "auto_retry_end" && message.event?.success === false) list.push(`gaveup:${message.event?.finalError ?? ""}`);
	if (type === "agent_end") agentEndResolvers.get(id)?.();
}
function eventSummary(id) {
	return (eventsById.get(id) ?? []).join(",");
}
function providerGaveUp(id) {
	return (eventsById.get(id) ?? []).some((t) => t.startsWith("gaveup:"));
}

let createCount = 0;

/** Create our own resident session, sandboxed in workRoot. */
async function createResidentSession(model) {
	createCount += 1;
	const sessionDir = path.join(workRoot, `sessions-${createCount}`);
	fs.mkdirSync(sessionDir, { recursive: true });
	const config = { cwd: workRoot, sessionDir };
	if (model) config.model = model;
	const summary = await sidecar.request(
		{ type: "create", lifecycle: "resident", config },
		Math.min(CREATE_TIMEOUT_MS, Math.max(5_000, budgetMs() - 20_000)),
	);
	const id = summary?.activeSessionId ?? summary?.id;
	if (typeof id !== "string" || !id) throw new Error(`create returned no session id: ${JSON.stringify(summary)}`);
	ownIds.add(id);
	return { id, summary };
}

/**
 * Attach + prompt + observe until agent_end / PARITY-OK / provider give-up /
 * deadline. Returns which conditions were met plus diagnostics.
 */
async function runParityTurn(id, deadlineMs) {
	const attachResult = await sidecar.attach(id);
	const snapshot = attachResult?.snapshot;
	const snapshotOk = snapshot != null && Array.isArray(snapshot.messages);

	let agentEndResolve;
	const agentEnd = new Promise((resolve) => { agentEndResolve = resolve; });
	agentEndResolvers.set(id, () => agentEndResolve(true));

	const turnStart = Date.now();
	deadlineMs = Math.min(deadlineMs, Math.max(1_000, budgetMs() - 5_000));
	await sidecar.prompt(id, PROMPT_TEXT, "steer");

	let sawAgentEnd = false;
	let parityFound = false;
	let lastAssistantExcerpt = "";
	let pollError = "";
	while (Date.now() - turnStart < deadlineMs && !parityFound && !providerGaveUp(id)) {
		const remaining = deadlineMs - (Date.now() - turnStart);
		if (!sawAgentEnd) await Promise.race([agentEnd, sleep(Math.min(POLL_INTERVAL_MS, remaining))]);
		else await sleep(Math.min(POLL_INTERVAL_MS, remaining));
		sawAgentEnd = sawAgentEnd || (eventsById.get(id) ?? []).includes("agent_end");
		try {
			const messages = await sidecar.getMessages(id);
			const text = assistantText(messages);
			if (text) lastAssistantExcerpt = text.slice(-200);
			if (text.includes(EXPECTED_TEXT)) parityFound = true;
		} catch (error) {
			pollError = error instanceof Error ? error.message : String(error);
		}
	}
	try { await sidecar.detach(id); } catch { /* fine */ }
	return {
		snapshotOk,
		snapshotMessageCount: Array.isArray(snapshot?.messages) ? snapshot.messages.length : -1,
		attachedOk: (attachResult?.activeSessionId ?? snapshot?.activeSessionId) === id,
		sawAgentEnd,
		parityFound,
		gaveUp: providerGaveUp(id),
		sawError: (eventsById.get(id) ?? []).some((t) => t.startsWith("error:") || t.startsWith("retry:")),
		elapsedMs: Date.now() - turnStart,
		eventCount: (eventsById.get(id) ?? []).length,
		lastAssistantExcerpt,
		pollError,
	};
}

try {
	// ---------------------------------------------------------------
	// Build DaemonSidecar from actual src (no stale dist artifacts).
	// ---------------------------------------------------------------
	const srcPath = new URL("../src/daemon-sidecar.ts", import.meta.url).pathname;
	const outFile = path.join(workRoot, "daemon-sidecar.cjs");
	esbuild.buildSync({
		entryPoints: [srcPath],
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "node18",
		outfile: outFile,
		logLevel: "silent",
	});
	const require = createRequire(import.meta.url);
	const { DaemonSidecar } = require(outFile);
	check("sidecar bundles from src/daemon-sidecar.ts", typeof DaemonSidecar === "function");

	sidecar = new DaemonSidecar();
	sidecar.onEvent = journalEvent;

	// ---------------------------------------------------------------
	// 1. Socket discovery (same helper the extension relies on).
	// ---------------------------------------------------------------
	const sockPath = sidecar.socketPath();
	check("daemon socket path discovered", typeof sockPath === "string" && sockPath.length > 0, sockPath);
	if (os.platform() !== "win32" && !fs.existsSync(sockPath)) skip(`no daemon socket at ${sockPath}`);

	// ---------------------------------------------------------------
	// 2. Connect. No daemon / unreachable -> SKIP (never hang CI).
	// ---------------------------------------------------------------
	try {
		await sidecar.connect(CONNECT_TIMEOUT_MS);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/unavailable|timed out|ENOENT|ECONNREFUSED/i.test(message)) skip(`daemon not reachable: ${message}`);
		check("daemon connect + hello", false, message);
		throw new Error("aborting after failed connect");
	}
	check(
		"daemon hello is prime-agent.daemon v7+",
		sidecar.connected && sidecar.isSupported(),
		JSON.stringify({ protocol: sidecar.hello?.protocol, schemaRevision: sidecar.hello?.schemaRevision }),
	);

	// ---------------------------------------------------------------
	// 3. Create OUR OWN resident session (cwd + sessionDir sandboxed).
	// ---------------------------------------------------------------
	let session;
	const primaryModel = REQUESTED_MODEL || undefined;
	try {
		session = await createResidentSession(primaryModel);
	} catch (error) {
		check("create resident session", false, error instanceof Error ? error.message : String(error));
		throw error;
	}
	check(
		"create resident session returns an id",
		true,
		`id=${session.id} model=${primaryModel ?? "<daemon default>"}`,
	);
	check(
		"fresh session is a draft (no messages yet)",
		session.summary?.lifecycle === "draft",
		`lifecycle=${String(session.summary?.lifecycle)}`,
	);
	check(
		"session file rooted inside the isolated tmpdir",
		typeof session.summary?.sessionFile !== "string" || session.summary.sessionFile.startsWith(workRoot),
		String(session.summary?.sessionFile ?? "<none yet>"),
	);

	// Parity witness: a SECOND, independent client connection must see the
	// same daemon-resident session via `list` (never prompt/attach it).
	{
		const observer = new DaemonSidecar();
		try {
			await observer.connect(CONNECT_TIMEOUT_MS);
			const listed = await observer.list(true);
			const mine = listed.find((s) => (s.activeSessionId ?? s.id) === session.id);
			check(
				"session visible to a second client via list (daemon-brokered)",
				mine != null,
				mine ? `attachedClients=${String(mine.attachedClients)} lifecycle=${String(mine.lifecycle)}` : `${listed.length} sessions listed, ours absent`,
			);
		} catch (error) {
			check("session visible to a second client via list (daemon-brokered)", false, error instanceof Error ? error.message : String(error));
		} finally {
			observer.dispose();
		}
	}

	// ---------------------------------------------------------------
	// 4+5. Attach, prompt, observe the stream, poll for the reply.
	//      Provider-side model failure -> retry once on daemon default.
	// ---------------------------------------------------------------
	let turn = await runParityTurn(session.id, TURN_DEADLINE_MS);
	let servedBy = primaryModel ?? "<daemon default>";
	if (!turn.parityFound && (turn.gaveUp || turn.sawError) && primaryModel && budgetMs() > 60_000) {
		info(`model ${primaryModel} failed provider-side (${eventSummary(session.id)}); retrying on daemon default model`);
		session = await createResidentSession(undefined);
		servedBy = "<daemon default>";
		turn = await runParityTurn(session.id, TURN_DEADLINE_MS);
	}

	check("attach snapshot present for our session", turn.attachedOk);
	check("attach snapshot has messages[] (fresh: empty)", turn.snapshotOk, `messages=${turn.snapshotMessageCount}`);
	check(
		"session_event stream observed",
		turn.eventCount > 0,
		`${turn.eventCount} events (${eventSummary(session.id).slice(-160)})`,
	);
	check(
		"agent_end or provider give-up within deadline",
		turn.sawAgentEnd || turn.gaveUp,
		`elapsed=${turn.elapsedMs}ms, events=${turn.eventCount}${turn.gaveUp ? `, gave up: ${eventSummary(session.id)}` : ""}`,
	);
	check(
		`assistant reply contains ${EXPECTED_TEXT}`,
		turn.parityFound,
		turn.parityFound
			? `served by ${servedBy}, elapsed=${turn.elapsedMs}ms`
			: `elapsed=${turn.elapsedMs}ms, events=${turn.eventCount} [${eventSummary(session.id).slice(-160)}], ` +
				`last assistant text: ${turn.lastAssistantExcerpt || "<none>"}${turn.pollError ? `, poll error: ${turn.pollError}` : ""}`,
	);

	// ---------------------------------------------------------------
	// 6. Dual-client parity: one writer + one viewer attached to the same
	//    live session — both see the prompt and the assistant answer.
	// ---------------------------------------------------------------
	const viewer = new DaemonSidecar();
	const viewerEvents = [];
	let viewerSawUser = false;
	let viewerSawReply = false;
	const dualText = "DUAL-CLIENT-77";
	try {
		await viewer.connect(CONNECT_TIMEOUT_MS);
		viewer.onEvent = (message) => {
			if (message.type !== "session_event") return;
			if (message.activeSessionId !== session.id) return;
			const inner = message.event ?? {};
			const innerType = String(inner.type ?? "?");
			viewerEvents.push(innerType);
			const role = inner.message?.role;
			const text = JSON.stringify(inner.message ?? {});
			if (text.includes(dualText)) {
				if (role === "user") viewerSawUser = true;
				if (role === "assistant") viewerSawReply = true;
			}
			if (innerType === "turn_end" || innerType === "agent_end") viewerSawReply = true;
		};
		// Attach viewer BEFORE the main writer prompts, then re-attach writer and prompt.
		await viewer.attach(session.id);
		const writerReattach = await sidecar.attach(session.id);
		check(
			"viewer + writer both attached to the live session",
			(writerReattach.snapshot?.activeSessionId ?? session.id) === session.id,
			"attach returned a snapshot",
		);
		await sidecar.request(
			{ type: "prompt", activeSessionId: session.id, message: `Reply with exactly: ${dualText}. Do not use any tools.`, streamingBehavior: "steer", queueIfBusy: true },
			30_000,
		);
		const deadline = Date.now() + Math.min(budgetMs(), TURN_DEADLINE_MS);
		while (Date.now() < deadline && !viewerSawReply) {
			await sleep(500);
		}
		check(
			"viewer saw the writer's prompt in its event stream",
			viewerSawUser,
			`${viewerEvents.length} viewer events (${viewerEvents.slice(-6).join(",") || "none"})`,
		);
		check(
			"viewer saw the assistant reply while writer and viewer were both attached",
			viewerSawReply,
			`${viewerEvents.length} viewer events`,
		);
		const viewerMessages = await viewer.getMessages(session.id);
		check(
			"viewer's message history contains the dual-client reply",
			JSON.stringify(viewerMessages).includes(dualText),
			`${viewerMessages.length} messages via the viewer connection`,
		);
	} catch (error) {
		check("dual-client phase failed unexpectedly", false, error instanceof Error ? error.message : String(error));
	} finally {
		try { await viewer.detach(session.id); } catch {}
		viewer.dispose();
	}

	// ---------------------------------------------------------------
	// 7. Kill every session we created (releases locks, stops workers).
	// ---------------------------------------------------------------
	let killOk = true;
	let killDetail = "";
	for (const id of ownIds) {
		try { await sidecar.request({ type: "kill", activeSessionId: id }, 15_000); }
		catch (error) { killOk = false; killDetail = error instanceof Error ? error.message : String(error); }
	}
	check("resident session(s) killed", killOk, killDetail || `${ownIds.size} session(s) killed`);
} catch (error) {
	// Steps log their own FAIL lines; this catches unexpected throw paths.
	if (failed === 0) check("unexpected harness error", false, error instanceof Error ? error.message : String(error));
	else info(`aborted early: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	await cleanup();
	clearTimeout(watchdog);
}

console.log(failed === 0 ? `\nPASS daemon-parity (${total} checks)` : `\n${failed}/${total} daemon-parity checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
