/**
 * Daemon parity harness: verifies end-to-end, without VS Code, that a client
 * speaking only the daemon protocol (prime-agent.daemon v7, unix socket) can
 * drive a resident session the same way the terminal client does:
 *
 *   create (lifecycle: "resident") -> attach -> prompt -> session_event stream
 *   -> get_messages shows the assistant reply -> detach + kill cleanup.
 *
 * This is the same flow SessionController.attachViaDaemon uses in the
 * extension when RPC switch_session reports "Session is already active".
 *
 * The DaemonSidecar client is bundled from src/daemon-sidecar.ts with esbuild
 * into a temp CJS file (same approach as test/export-md.test.mjs), so the
 * test exercises the real socket-discovery and protocol code, not a copy.
 *
 * Safety: the test only ever creates/attaches/kills its OWN freshly created
 * session, rooted in an isolated mkdtemp directory (cwd + sessionDir both
 * point inside it). It never prompts or attaches sessions from `list`.
 *
 * No daemon running? The whole test SKIP-exits 0 so CI never hangs.
 * Hard watchdog: the process exits no later than ~170s regardless.
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
const MODEL = process.env.DAEMON_PARITY_MODEL ?? "chutes/zai-org/GLM-4.7";
const CONNECT_TIMEOUT_MS = 8_000;
const CREATE_TIMEOUT_MS = 45_000;
const TURN_DEADLINE_MS = 90_000; // agent_end + PARITY-OK polling budget
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
	console.log(`SKIP  daemon-parity — ${reason}`);
	process.exit(0);
}
// Hard watchdog: nothing below may ever park the event loop longer than this.
const watchdog = setTimeout(() => {
	console.log(`FAIL  watchdog — exceeded ${WATCHDOG_MS}ms; aborting (event counts lost)`);
	process.exit(2);
}, WATCHDOG_MS);

/** Extract visible text from an assistant/tool message, tolerant of shapes. */
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
	return messages
		.filter((m) => m && m.role === "assistant")
		.map(messageText)
		.join("\n");
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-parity-"));
let sidecar = null;
let activeSessionId = null;
let killed = false;
let disposed = false;

async function cleanup() {
	if (disposed) return;
	disposed = true;
	if (sidecar?.connected && activeSessionId) {
		if (!killed) {
			try { await sidecar.request({ type: "kill", activeSessionId }, 15_000); killed = true; }
			catch { /* best effort */ }
		}
		try { await sidecar.detach(activeSessionId); } catch { /* best effort */ }
	}
	try { sidecar?.dispose(); } catch { /* ignore */ }
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try { fs.rmSync(workRoot, { recursive: true, force: true }); break; }
		catch {
			// worker may still be flushing right after kill; brief backoff
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
		}
	}
}
process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

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

	// ---------------------------------------------------------------
	// 1. Socket discovery (same logic the sidecar itself uses).
	// ---------------------------------------------------------------
	const sockPath = sidecar.socketPath();
	check("socket path discovered", typeof sockPath === "string" && sockPath.length > 0, sockPath);
	if (os.platform() !== "win32" && !fs.existsSync(sockPath)) {
		skip(`no daemon socket at ${sockPath}`);
	}

	// ---------------------------------------------------------------
	// 2. Connect. No daemon / unreachable -> SKIP (never hang CI).
	// ---------------------------------------------------------------
	try {
		await sidecar.connect(CONNECT_TIMEOUT_MS);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/unavailable|timed out|ENOENT|ECONNREFUSED/i.test(message)) skip(`daemon not reachable: ${message}`);
		check("daemon connect + hello", false, message);
		throw new Error(`unreachable after failed connect: ${message}`);
	}
	check(
		"daemon hello is prime-agent.daemon v7+",
		sidecar.connected && sidecar.isSupported(),
		JSON.stringify({ protocol: sidecar.hello?.protocol, schemaRevision: sidecar.hello?.schemaRevision }),
	);

	// Events are collected for OUR session only.
	const eventTypes = [];
	let agentEndResolve;
	let sawAgentEnd = new Promise((resolve) => { agentEndResolve = resolve; });
	sidecar.onEvent = (message) => {
		if (message.activeSessionId !== activeSessionId) return;
		if (message.type === "session_event") {
			const type = message.event?.type ?? "?";
			eventTypes.push(type);
			if (type === "agent_end") agentEndResolve(true);
		}
	};

	// ---------------------------------------------------------------
	// 3. Create OUR OWN resident session, fully sandboxed in workRoot.
	//    (`cwd`/`sessionDir` are AgentSessionRuntimeConfig fields; the
	//    create envelope itself only takes config/lifecycle/name/...).
	// ---------------------------------------------------------------
	const sessionDir = path.join(workRoot, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	let summary;
	try {
		summary = await sidecar.request(
			{
				type: "create",
				lifecycle: "resident",
				config: { cwd: workRoot, sessionDir, model: MODEL },
			},
			CREATE_TIMEOUT_MS,
		);
	} catch (error) {
		check("create resident session", false, error instanceof Error ? error.message : String(error));
		throw error;
	}
	activeSessionId = summary?.activeSessionId ?? summary?.id ?? null;
	const createOk = check(
		"create resident session returns an id",
		typeof activeSessionId === "string" && activeSessionId.length > 0,
		`id=${String(activeSessionId)} lifecycle=${String(summary?.lifecycle)} cwd=${String(summary?.cwd)}`,
	);
	if (!createOk) throw new Error("create returned no usable session id");
	check(
		"session is daemon-resident (not client-owned)",
		summary?.lifecycle === "resident",
		`lifecycle=${String(summary?.lifecycle)}`,
	);

	// Wait for the initial agent_end synchronously via event OR timeout.
	const waitAgentEnd = async (deadlineMs) => {
		const timeout = new Promise((resolve) => setTimeout(() => resolve(false), deadlineMs));
		return Promise.race([sawAgentEnd, timeout]);
	};

	// ---------------------------------------------------------------
	// 4. Attach; snapshot must expose a messages array.
	// ---------------------------------------------------------------
	let attachResult;
	try {
		attachResult = await sidecar.attach(activeSessionId);
	} catch (error) {
		check("attach to resident session", false, error instanceof Error ? error.message : String(error));
		throw error;
	}
	const snapshot = attachResult?.snapshot;
	check(
		"attach snapshot present",
		snapshot != null && (snapshot.activeSessionId ?? attachResult.activeSessionId) != null,
	);
	check(
		"attach snapshot has messages[] (fresh session: empty)",
		Array.isArray(snapshot?.messages),
		`messages=${Array.isArray(snapshot?.messages) ? snapshot.messages.length : "missing"}`,
	);

	// ---------------------------------------------------------------
	// 5. Prompt, then observe the session_event stream until agent_end.
	// ---------------------------------------------------------------
	const turnStart = Date.now();
	try {
		await sidecar.prompt(activeSessionId, PROMPT_TEXT, "steer");
		check("prompt accepted by daemon", true);
	} catch (error) {
		check("prompt accepted by daemon", false, error instanceof Error ? error.message : String(error));
		throw error;
	}

	// Poll get_messages for the expected reply until the deadline; tolerant
	// of provider retries. agent_end arrival is tracked in parallel.
	let sawEnd = false;
	let parityFound = false;
	let lastAssistantExcerpt = "";
	while (Date.now() - turnStart < TURN_DEADLINE_MS && !parityFound) {
		const remaining = TURN_DEADLINE_MS - (Date.now() - turnStart);
		if (!sawEnd) sawEnd = Boolean(await waitAgentEnd(Math.min(POLL_INTERVAL_MS, remaining)));
		else await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
		try {
			const messages = await sidecar.getMessages(activeSessionId);
			const text = assistantText(messages);
			if (text) lastAssistantExcerpt = text.slice(-200);
			if (text.includes(EXPECTED_TEXT)) parityFound = true;
		} catch (error) {
			lastAssistantExcerpt = `get_messages failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	check(
		"session_event stream observed",
		eventTypes.length > 0,
		`${eventTypes.length} events (last: ${eventTypes.slice(-5).join(",") || "none"})`,
	);
	check("agent_end within deadline", sawEnd, `${eventTypes.length} events, elapsed=${Date.now() - turnStart}ms`);
	check(
		`assistant reply contains ${EXPECTED_TEXT}`,
		parityFound,
		parityFound ? "" : `elapsed=${Date.now() - turnStart}ms, events=${eventTypes.length}, last assistant text: ${lastAssistantExcerpt || "<none>"}`,
	);

	// ---------------------------------------------------------------
	// 6. Cleanup: detach + kill (session files live under workRoot).
	//    Never touch sessions from `list` that we did not create.
	// ---------------------------------------------------------------
	await sidecar.detach(activeSessionId);
	try {
		await sidecar.request({ type: "kill", activeSessionId }, 15_000);
		killed = true;
	} catch (error) {
		check("kill resident session", false, error instanceof Error ? error.message : String(error));
	}
	check("resident session killed", killed);
} catch (error) {
	// Steps log their own FAIL lines; this catches unexpected throw paths.
	if (failed === 0) check("unexpected harness error", false, error instanceof Error ? error.message : String(error));
	else console.log(`INFO  aborted early: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	await cleanup();
	clearTimeout(watchdog);
}

console.log(failed === 0 ? `\nPASS daemon-parity (${total} checks)` : `\n${failed}/${total} daemon-parity checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
