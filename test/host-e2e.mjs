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
const sink = { post: (message) => received.push(message) };
const outputLines = [];
const controller = new SessionController(
	{ subscriptions: [], extensionUri: { fsPath: process.cwd() } },
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
	controller.dispose();
	fs.rmSync(workdir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nPASS host e2e" : `\n${failed} host e2e checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
