/**
 * End-to-end smoke test of the extension's RPC client against a real
 * `prime-agent --mode rpc` subprocess. Exercises protocol framing, request/
 * response correlation, event streaming, prompt round-trip, and restart.
 *
 * Run: node test/smoke.mjs   (build first: node esbuild.config.mjs)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// esbuild inlines this import from ../src/rpc-client.ts
import { RpcClient } from "../src/rpc-client.ts";

const results = [];
function check(name, condition, detail = "") {
	results.push({ name, ok: condition, detail });
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
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

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-vs-ext-smoke-"));
const client = new RpcClient({ command: process.env.PRIME_AGENT_COMMAND ?? "prime-agent", cwd: workdir });

const events = [];
const seenTypes = new Set();
client.on("event", (event) => {
	events.push(event);
	if (event?.type) seenTypes.add(event.type);
});
client.on("stderr", () => {});
client.on("protocolError", (line) => {
	console.error("PROTOCOL ERROR:", String(line).slice(0, 200));
});

let failed = false;
try {
	client.start();
	await new Promise((r) => setTimeout(r, 400));
	check("process starts", client.running, workdir);

	// --- get_state ---
	const state = await client.request({ type: "get_state" }, 30_000);
	check("get_state succeeds", state.success);
	const modelLabel = state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : "none";
	console.log(`  model: ${modelLabel}  thinking: ${state.data?.thinkingLevel}`);

	// --- get_commands ---
	const commandsRes = await client.request({ type: "get_commands" }, 30_000);
	check("get_commands succeeds", commandsRes.success);
	console.log(`  commands available: ${commandsRes.data?.commands?.length ?? 0}`);

	// --- get_available_models ---
	const modelsRes = await client.request({ type: "get_available_models" }, 60_000);
	check("get_available_models succeeds", modelsRes.success);
	console.log(`  models available: ${modelsRes.data?.models?.length ?? 0}`);

	// --- bash RPC command ---
	const bashRes = await client.request({ type: "bash", command: "echo hello-from-smoke" }, 30_000);
	check("bash command succeeds", bashRes.success && String(bashRes.data?.output ?? "").includes("hello-from-smoke"));

	// --- parallel request correlation ---
	const [s1, s2] = await Promise.all([client.request({ type: "get_state" }, 30_000), client.request({ type: "get_session_stats" }, 30_000)]);
	check("parallel requests correlate by id", s1.success && s2.success);

	// --- prompt round-trip with streaming events ---
	const promptRes = await client.request({ type: "prompt", message: "Reply with exactly: PONG. Do not use any tools." }, 60_000);
	check("prompt accepted", promptRes.success, promptRes.error ?? "");
	await waitFor(() => events.find((e) => e.type === "agent_end"), 180_000, "agent_end");
	check("agent_start seen", seenTypes.has("agent_start"));
	check("message_start seen", seenTypes.has("message_start"));
	check("message_update seen", seenTypes.has("message_update"));
	check("message_end seen", seenTypes.has("message_end"));
	check("agent_end seen", seenTypes.has("agent_end"));

	const lastText = await client.request({ type: "get_last_assistant_text" }, 30_000);
	check(
		"assistant replied PONG",
		lastText.success && /pong/i.test(lastText.data?.text ?? ""),
		String(lastText.data?.text ?? "").slice(0, 60),
	);

	// --- stats after run ---
	const stats = await client.request({ type: "get_session_stats" }, 30_000);
	check("get_session_stats succeeds", stats.success && stats.data?.tokens?.total > 0, JSON.stringify(stats.data?.tokens ?? {}));

	// --- new_session ---
	const ns = await client.request({ type: "new_session" }, 30_000);
	check("new_session succeeds", ns.success);
	const messages = await client.request({ type: "get_messages" }, 30_000);
	check("messages cleared after new_session", messages.success && (messages.data?.messages?.length ?? 0) === 0);

	// --- restart cycle ---
	client.stop();
	await new Promise((r) => setTimeout(r, 300));
	check("process stops", !client.running);
	const client2 = new RpcClient({ command: process.env.PRIME_AGENT_COMMAND ?? "prime-agent", cwd: workdir });
	client2.start();
	await new Promise((r) => setTimeout(r, 300));
	const s3 = await client2.request({ type: "get_state" }, 30_000);
	check("restart works", s3.success);
	client2.stop();
} catch (err) {
	failed = true;
	console.error("SMOKE ERROR:", err);
} finally {
	client.stop();
	fs.rmSync(workdir, { recursive: true, force: true });
}

const failures = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failures}/${results.length} checks passed${failed ? " (aborted early)" : ""}`);
process.exit(failures > 0 || failed ? 1 : 0);
