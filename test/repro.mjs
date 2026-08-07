/**
 * Reproduce the exact "ready" path the webview triggers, against a real CLI,
 * and print exactly what the webview would receive.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(process.cwd() + "/");
require("./test/vscode-stub.cjs");
const { SessionController } = require("./dist/controller.cjs");
const { vscodeStub } = require("./test/vscode-stub.cjs");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-repro-"));
process.env.PRIME_AGENT_ARGS = `--session-dir ${path.join(workdir, "sessions")}`;
vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workdir }, name: "repro", index: 0 }];

const received = [];
const stateStore = new Map();
const controller = new SessionController(
	{
		subscriptions: [],
		extensionUri: { fsPath: process.cwd() },
		globalState: {
			get: (key, fallback) => (stateStore.has(key) ? stateStore.get(key) : fallback),
			update: async (key, value) => void stateStore.set(key, value),
		},
	},
	{ append: () => {}, appendLine: (l) => console.log("[out]", l) },
);
controller.attach({ post: (m) => received.push(m) });

async function waitFor(pred, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const v = pred();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	console.log(`TIMEOUT waiting for ${label}`);
	return null;
}

process.on("unhandledRejection", (err) => console.log("UNHANDLED REJECTION:", String(err?.message ?? err)));

// --- the webview "ready" handler, verbatim ---
await controller.ensureStarted();
await controller.refreshSnapshot();
await controller.listModels();
await controller.listCommands();
controller.sendFavorites();

const modelsMsg = await waitFor(() => received.find((m) => m.type === "models"), 90_000, "models broadcast");
console.log("MODELS BROADCAST:", modelsMsg ? JSON.stringify(modelsMsg.models?.length ?? "no-field") : "NEVER ARRIVED");
if (modelsMsg) console.log("  first model:", JSON.stringify(modelsMsg.models?.[0] ?? null));
console.log("  notices:", JSON.stringify(received.filter((m) => m.type === "notice")));

// --- switch_session round-trip: prompt -> new session -> resume original ---
const sessionBefore = received.filter((m) => m.type === "snapshot").at(-1);
const originalFile = sessionBefore?.status?.sessionFile;
await controller.prompt({ text: "Reply with exactly: PONG", images: [], selections: [] });
await waitFor(() => received.filter((m) => m.type === "event").some((m) => m.event?.type === "agent_end"), 180_000, "agent_end");
await controller.newSession();
await waitFor(() => received.length > 0, 1, "noop");
if (originalFile && fs.existsSync(originalFile)) {
	await controller.switchSession(originalFile);
	const snap = await waitFor(() => received.filter((m) => m.type === "snapshot").at(-1)?.messages?.some((mm) => mm.role === "user"), 30_000, "resumed snapshot");
	console.log("RESUME:", snap ? "WORKS" : "FAILED messages empty");
	const errNotices = received.filter((m) => m.type === "notice" && m.level === "error").map((m) => m.text);
	console.log("  error notices:", JSON.stringify(errNotices));
} else {
	console.log("RESUME: could not locate original session file", originalFile);
}
console.log("---");
process.exit(0);
