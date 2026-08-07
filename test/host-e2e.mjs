/**
 * Host-side end-to-end test: drives the real SessionController (the extension
 * host code that sits between webviews and the RPC subprocess) against a real
 * `prime-agent --mode rpc` process with a stubbed vscode module.
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(process.cwd() + "/");
require("./test/vscode-stub.cjs");

const { SessionController } = require("./dist/controller.cjs");
const { vscodeStub } = require("./test/vscode-stub.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-host-e2e-"));
process.env.PRIME_AGENT_ARGS = `--session-dir ${path.join(workdir, "sessions")}`;
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir, scheme: "file" }, name: "e2e", index: 0 }];

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

async function waitFor(predicate, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

const received = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ownIds = new Set();
const sink = { post: (message) => received.push(message) };
const outputLines = [];
const _mem = new Map();
const _state = { get: (k, d) => (_mem.has(k) ? _mem.get(k) : d), update: (k, v) => { if (v === undefined) _mem.delete(k); else _mem.set(k, v); return Promise.resolve(); } };
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() }, globalState: _state, workspaceState: _state },
	{ append: (c) => outputLines.push(c), appendLine: (l) => outputLines.push(l) },
);
controller.attach(sink);

try {
	await controller.ensureStarted();
	const snapshot = await waitFor(() => received.find((m) => m.type === "snapshot"), 30_000, "initial snapshot");
	check("initial snapshot received", !!snapshot);
	check("snapshot connected", snapshot.status?.connected === true, snapshot.status?.modelLabel ?? "");

	// Simulate the webview sending a prompt.
	const events = [];
	sink.post = (m) => {
		received.push(m);
		if (m.type === "event") events.push(m.event);
	};
	await controller.prompt({ text: "Reply with exactly: PONG. Do not use any tools.", images: [], selections: [], streamingBehavior: "steer" });
	await waitFor(() => events.find((e) => e.type === "agent_end"), 180_000, "agent_end");
	check("prompt accepted broadcast", received.some((m) => m.type === "promptAccepted"));
	check("agent_start event streamed", events.some((e) => e.type === "agent_start"));
	check("assistant message streamed", events.some((e) => e.type === "message_start" && e.message?.role === "assistant"));

	await controller.refreshSnapshot();
	const snap2 = [...received].reverse().find((m) => m.type === "snapshot");
	const assistantMessages = (snap2?.messages ?? []).filter((m) => m.role === "assistant");
	const lastText = assistantMessages
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n");
	check("transcript contains PONG reply", /pong/i.test(lastText), lastText.slice(0, 60));

	// -----------------------------------------------------------------
	// Daemon-attached live session: a third-party client writes; the
	// extension must stream it to the webview transcript (dual-use).
	// -----------------------------------------------------------------
	{
		const { createRequire } = await import("node:module");
		const sidecarRequire = createRequire(import.meta.url);
		const { DaemonSidecar } = sidecarRequire("../dist/daemon-sidecar.cjs");
		const marker = `HOT-E2E-${Date.now() % 100_000}`;
		const driver = new DaemonSidecar();
		await driver.connect();
		// Fresh resident session owned by the daemon (NOT by this extension's RPC client).
		const residentName = `host-e2e-live-${Date.now()}`;
		const createRes = await driver.request(
			{ type: "create", lifecycle: "resident", name: residentName, config: { cwd: workdir } },
			20_000,
		);
		check("resident session created for attach", createRes?.id != null, `id=${createRes?.id ?? "<none>"}`);
		ownIds.add(createRes.id);
		let sessionFile = createRes.sessionFile;
		for (let i = 0; i < 20 && !sessionFile; i += 1) {
			await new Promise((r) => setTimeout(r, 250));
			const listed = await driver.list(true);
			sessionFile = listed.find((s) => s.id === createRes.id)?.sessionFile;
		}
		check("resident session file surfaced", typeof sessionFile === "string" && sessionFile.length > 0, String(sessionFile ?? "<none>"));

		const promptCountBefore = received.length;
		// Attach through the same channel the righ-observe parity uses.
		const attachOk = await controller.attachViaDaemon(createRes.id, sessionFile);
		check("attachViaDaemon accepted", attachOk === true);
		check("attached-mode notice went out", received.some((m) => m.type === "notice" && /attached to the live session/i.test(m.text ?? "")), received.filter((m) => m.type === "notice").slice(-3).map((m) => m.text).join(" | "));

		const watcher = new DaemonSidecar();
		await watcher.connect();
		const watcherEvents = [];
		watcher.onEvent = (msg) => {
			if (msg.activeSessionId === createRes.id && msg.type === "session_event") watcherEvents.push(String((msg.event ?? {}).type ?? "?"));
		};
		await watcher.attach(createRes.id);
		await driver.request(
			{ type: "prompt", activeSessionId: createRes.id, message: `Reply with exactly: ${marker}. Do not use any tools.`, streamingBehavior: "steer", queueIfBusy: true },
			30_000,
		);
		const started = Date.now();
		let extSawEvent = null;
		let snapAssistant = "";
		while (Date.now() - started < 90_000) {
			const later = received.slice(promptCountBefore);
			extSawEvent =
				later.find((m) => m.type === "event" && JSON.stringify(m.event ?? {}).includes(marker)) ??
				later.find((m) => m.type === "event" && (m.event?.type ?? "").startsWith("message"));
			const snapshots = received.filter((m) => m.type === "snapshot");
			const lastSnap = snapshots[snapshots.length - 1];
			snapAssistant = (lastSnap?.messages ?? [])
				.filter((mm) => mm?.role === "assistant")
				.flatMap((mm) => (Array.isArray(mm.content) ? mm.content : []))
				.filter((p) => p?.type === "text")
				.map((p) => p.text)
				.join("\n");
			if (extSawEvent || (snapAssistant && snapAssistant.includes(marker))) break;
			await sleep(750);
		}
		check(
			"extension streams third-party client traffic while attached",
			extSawEvent != null || snapAssistant.includes(marker),
			extSawEvent == null
				? `received=${received.length - promptCountBefore} msgs after attach, watcherEvents=${watcherEvents.length}, lastExcerpt=${snapAssistant.slice(-80) || "<none>"}`
				: String(extSawEvent?.type),
		);
		check(
			"watcher client saw the same streamed turn",
			watcherEvents.some((e) => e.startsWith("message_")),
			`${watcherEvents.length} watcher events`,
		);
		watcher.dispose();
		driver.dispose();
	}

	// Selection composition: snippet + attachment markers land in the outgoing text.
	const composed = controller.composeMessageText({
		text: "what does this do?",
		images: [],
		selections: [{ path: "src/a.ts", startLine: 3, endLine: 7, text: "const x = 1;", languageId: "typescript" }],
	});
	check(
		"selection snippet embedded in prompt text",
		composed.includes('file="src/a.ts"') && composed.includes("const x = 1;") && composed.startsWith("what does this do?"),
	);

	await controller.newSession();
	const snap3 = await waitFor(() => {
		const snaps = received.filter((m) => m.type === "snapshot");
		return snaps.length >= 2 ? snaps[snaps.length - 1] : null;
	}, 30_000, "post-new-session snapshot");
	check("new session snapshot has empty transcript", (snap3?.messages ?? []).length === 0);

	check("no protocol error notices", !received.some((m) => m.type === "notice" && m.level === "error"), 
		received.filter((m) => m.type === "notice").map((m) => m.text).slice(0, 2).join(" | "));
} finally {
	for (const id of ownIds) {
		try {
			const { createRequire } = await import("node:module");
		const sidecarRequire = createRequire(import.meta.url);
		const { DaemonSidecar } = sidecarRequire("../dist/daemon-sidecar.cjs");
			const killer = new DaemonSidecar();
			await killer.connect();
			await killer.request({ type: "kill", activeSessionId: id }, 15_000);
			killer.dispose();
		} catch {
			// best effort
		}
	}
	controller.dispose();
	fs.rmSync(workdir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nPASS host e2e" : `\n${failed} host e2e checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
