/**
 * Provider lifecycle regressions in the normal preview and an in-memory source bundle.
 * No daemon, model request, generated dist asset, SDK install, or /tmp fixture read.
 *
 * GREEN: PROVIDER_LIFECYCLE_ARTIFACTS=/tmp/provider-lifecycle-green node test/provider-stream-lifecycle.test.mjs
 * RED: PROVIDER_LIFECYCLE_SOURCE_REF=d6e0d2c node test/provider-stream-lifecycle.test.mjs
 * Intermediate RED: PROVIDER_LIFECYCLE_TRANSCRIPT_SOURCE=/tmp/prime-live-tail-pre-lifecycle-8d3d02cd.ts node test/provider-stream-lifecycle.test.mjs
 * The transcript override wins over the optional historical source ref.
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = process.env.PROVIDER_LIFECYCLE_ARTIFACTS ?? "/tmp/prime-provider-stream-lifecycle";
const sourceRef = process.env.PROVIDER_LIFECYCLE_SOURCE_REF;
const transcriptSource = process.env.PROVIDER_LIFECYCLE_TRANSCRIPT_SOURCE;
const git = promisify(execFile);
await mkdir(dir, { recursive: true });
async function source(path) {
 if (transcriptSource && relative(root, path) === "webview/transcript.ts") return readFile(transcriptSource);
 if (!sourceRef) return readFile(path);
 const { stdout } = await git("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
 return Buffer.from(stdout);
}
const sourceHash = createHash("sha256").update(await source(join(root, "webview/transcript.ts"))).digest("hex");
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("provider-stream-lifecycle-test") },
 plugins: sourceRef || transcriptSource ? [{ name: "captured-source", setup(api) {
  api.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ contents: (await source(path)).toString(), loader: "ts" }));
 } }] : [],
});
const assets = new Map([
 ["/preview.html", ["text/html", await source(join(root, "media/preview.html"))]],
 ["/main.css", ["text/css", await source(join(root, "media/main.css"))]],
 ["/main.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
const server = createServer((req, res) => {
 const asset = assets.get(new URL(req.url, "http://localhost").pathname);
 res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
 res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

// Compact lossless assistant-only fixtures. Unrelated custom/harness and user
// records are deliberately excluded. Metadata, timestamps, response IDs, costs,
// content, and assistantMessageEvent payloads below retain the captured values.
const provenance = {
 pong: { source: "prime-live-tail-final-validation/prime-0.9.8-rpc-events.json", version: "0.9.8", sha256: "f25f7db1b317001ccc5af0cb3e10cb0fb8e4b53109a2ac2d4239425cc51c1cde" },
 native: { source: "pa-final-review-native-provider-events.json", version: "0.9.8 native SDK, offline SSE", sha256: "a8cb195d5d88ce2c48d20cb65d70e4feb707826bd94f1a6a5b75f8143b408f9d" },
 tool: { source: "pa-final-review-installed-tool-wire/stdout.jsonl", version: "0.9.8 installed RPC, offline SSE", sha256: "06024e043c91ce1b7ce218b0b09cc314c8e78b3d622a811a3f29af4a1b2d55ac" },
 anthropic: { source: "pa-final-review-installed-anthropic-wire/stdout.jsonl", version: "0.9.8 installed RPC, offline Anthropic SSE", sha256: "ed82401b0bb7ebb12fa9d8411ff0d3b5b9d96db638e3913ea852371887b0eef2" },
};
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const usage = (input, output) => ({ ...structuredClone(zeroUsage), input, output, totalTokens: input + output });
const text = value => ({ type: "text", text: value });
const capturedMessage = (base, content, patch = {}) => structuredClone({ ...base, content, ...patch });
const wire = (type, message, assistantMessageEvent) => ({ type, message, ...(assistantMessageEvent ? { assistantMessageEvent } : {}) });
const pongBase = { role: "assistant", api: "openai-completions", provider: "chutes", model: "zai-org/GLM-5.2-TEE",
 usage: zeroUsage, stopReason: "stop", timestamp: 1791335385232 };
const pongFinal = capturedMessage(pongBase, [text("PONG")], {
 responseId: "c07d48c409094363b5ffc36dbc9dc062",
 usage: { input: 8604, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 8608,
  cost: { input: 0.010755, output: 0.0000158, cacheRead: 0, cacheWrite: 0, total: 0.0107708 } },
});
const pongEvents = [
 wire("message_start", capturedMessage(pongBase, [])),
 wire("message_update", capturedMessage(pongBase, [text("")]), { type: "text_start", contentIndex: 0 }),
 wire("message_update", capturedMessage(pongBase, [text("PONG")]), { type: "text_delta", contentIndex: 0, delta: "PONG" }),
 wire("message_update", capturedMessage(pongBase, [text("PONG")]), { type: "text_end", contentIndex: 0, content: "PONG" }),
 wire("message_end", pongFinal),
];
const nativeBase = { role: "assistant", api: "openai-completions", provider: "offline", model: "offline-native",
 usage: zeroUsage, stopReason: "stop", timestamp: 1791335051455 };
const nativePartial = (value, finalUsage = false) => capturedMessage(nativeBase, [text(value)], {
 responseId: "offline-native-response", ...(finalUsage ? { usage: usage(10, 3) } : {}),
});
const nativeEvents = [
 { type: "start", partial: capturedMessage(nativeBase, []) },
 { type: "text_start", contentIndex: 0, partial: nativePartial("Hello") },
 { type: "text_delta", contentIndex: 0, delta: "Hello", partial: nativePartial("Hello") },
 { type: "text_delta", contentIndex: 0, delta: " native partial", partial: nativePartial("Hello native partial") },
 { type: "text_end", contentIndex: 0, content: "Hello native partial", partial: nativePartial("Hello native partial", true) },
 { type: "done", reason: "stop", message: nativePartial("Hello native partial", true) },
];
// Map the captured SDK envelopes to the daemon's assistant RPC envelopes only.
// Do not normalize stopReason, strip usage, or fabricate a post-start message.
const nativeRpcEvents = nativeEvents.map(event => {
 if (event.type === "start") return wire("message_start", event.partial);
 if (event.type === "done") return wire("message_end", event.message);
 const { partial, ...assistantMessageEvent } = event;
 return wire("message_update", partial, assistantMessageEvent);
});
const toolBase = { role: "assistant", api: "openai-completions", provider: "offline-wire", model: "offline-wire-model",
 usage: zeroUsage, stopReason: "stop", timestamp: 1791335516484 };
const openingThinking = "Inspect the source carefully. ".repeat(4);
const fullThinking = openingThinking + "Now grow known thinking. ".repeat(12);
const thought = value => ({ type: "thinking", thinking: value, thinkingSignature: "reasoning_content" });
const capturedTool = (args, partial = true) => ({ type: "toolCall", id: "offline-display-tool", name: "offline_display_only", arguments: args,
 ...(partial ? { partialArgs: '{"code":"print', streamIndex: 0 } : {}) });
const toolContent = (value = fullThinking, prose, args, partial = true) => [thought(value),
 ...(prose !== undefined ? [text(prose)] : []), ...(args !== undefined ? [capturedTool(args, partial)] : [])];
const toolMessage = (content, patch) => capturedMessage(toolBase, content, patch);
const beforeTool = "Known prose before the tool. ";
const fullToolContent = toolContent(fullThinking, beforeTool, { code: "print(1)" });
const toolEvents = [
 wire("message_start", toolMessage(toolContent(openingThinking))),
 wire("message_update", toolMessage(toolContent("")), { type: "thinking_start", contentIndex: 0 }),
 wire("message_update", toolMessage(toolContent(openingThinking)), { type: "thinking_delta", contentIndex: 0, delta: openingThinking }),
 wire("message_update", toolMessage(toolContent(fullThinking)), { type: "thinking_delta", contentIndex: 0, delta: "Now grow known thinking. ".repeat(12) }),
 wire("message_update", toolMessage(toolContent(fullThinking, "")), { type: "text_start", contentIndex: 1 }),
 wire("message_update", toolMessage(toolContent(fullThinking, beforeTool)), { type: "text_delta", contentIndex: 1, delta: beforeTool }),
 wire("message_update", toolMessage(toolContent(fullThinking, beforeTool, {})), { type: "toolcall_start", contentIndex: 2 }),
 wire("message_update", toolMessage(toolContent(fullThinking, beforeTool, { code: "print" })), { type: "toolcall_delta", contentIndex: 2, delta: '{"code":"print' }),
 wire("message_update", toolMessage(fullToolContent), { type: "toolcall_delta", contentIndex: 2, delta: '(1)"}' }),
 wire("message_update", toolMessage(fullToolContent), { type: "thinking_end", contentIndex: 0, content: fullThinking }),
 wire("message_update", toolMessage(fullToolContent), { type: "text_end", contentIndex: 1, content: beforeTool }),
 wire("message_update", toolMessage(toolContent(fullThinking, beforeTool, { code: "print(1)" }, false)),
  { type: "toolcall_end", contentIndex: 2, toolCall: capturedTool({ code: "print(1)" }, false) }),
 wire("message_end", toolMessage(toolContent(fullThinking, beforeTool, { code: "print(1)" }, false),
  { usage: usage(10, 5), stopReason: "toolUse", responseId: "installed-098-local-tool-response" })),
];
const anthropicBase = { role: "assistant", api: "anthropic-messages", provider: "offline-wire", model: "offline-wire-model",
 usage: usage(10, 0), stopReason: "stop", timestamp: 1791335587688, responseId: "installed-098-local-anthropic" };
const anthropicText = value => ({ ...text(value), index: 0 });
const anthropicMessage = value => capturedMessage(anthropicBase, [anthropicText(value)]);
const anthropicEvents = [
 wire("message_start", capturedMessage(anthropicBase, [])),
 wire("message_update", anthropicMessage(""), { type: "text_start", contentIndex: 0 }),
 wire("message_update", anthropicMessage("Hello"), { type: "text_delta", contentIndex: 0, delta: "Hello" }),
 wire("message_update", anthropicMessage("Hello actual Anthropic partial"), { type: "text_delta", contentIndex: 0, delta: " actual Anthropic partial" }),
 wire("message_update", anthropicMessage("Hello actual Anthropic partial"), { type: "text_end", contentIndex: 0, content: "Hello actual Anthropic partial" }),
 wire("message_end", capturedMessage(anthropicBase, [text("Hello actual Anthropic partial")], { usage: usage(10, 5) })),
];
const finalUsage = { input: 1640, output: 519, cacheRead: 0, cacheWrite: 0, totalTokens: 2159,
 cost: { input: 0.004, output: 0.006, total: 0.010 } };
const history = Array.from({ length: 18 }, (_, i) => i % 2 ? {
 role: "assistant", timestamp: 1000 + i, responseId: `lifecycle-history-${i}`, stopReason: "stop",
 content: [text(`Earlier response ${i}. ` + "Stable prior transcript content. ".repeat(12))],
} : { role: "user", timestamp: 1000 + i, content: `Earlier prompt ${i}` });
history.push({ role: "user", timestamp: 2000, content: "PONG — display the latest provider reply." });

const frames = page => page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
const compactTokens = value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
let browser;
const reports = [];
async function seed(page) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.waitForSelector(".boot-splash", { state: "detached" });
 await page.evaluate(history => {
  window.__history = history;
  window.__status = { ...baseStatus, streaming: true, sessionId: "provider-lifecycle-session" };
  window.__trace = []; window.__events = []; window.__phase = "seed";
  window.__ids = new WeakMap(); window.__nextId = 0;
  window.__tracked = {}; window.__watch = true;
  const outer = document.querySelector(".messages");
  const id = node => { if (!node) return null; if (!window.__ids.has(node)) window.__ids.set(node, ++window.__nextId); return window.__ids.get(node); };
  const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { id: id(node), connected: node.isConnected, top: r.top, bottom: r.bottom, height: r.height }; };
  window.__sample = label => {
   const rows = [...outer.querySelectorAll(":scope > .row-assistant")].filter(row => Number(row.dataset.ts) > 2000);
   const row = rows.at(-1), card = row?.querySelector(".tool"), footer = outer.querySelector(".row-user:last-of-type .user-footer") ?? [...outer.querySelectorAll(".user-footer")].at(-1);
   const activity = rect(document.querySelector(".working-row"));
   const value = { label, phase: window.__phase, time: performance.now(), gap: outer.scrollHeight - outer.clientHeight - outer.scrollTop,
    max: outer.scrollHeight - outer.clientHeight, jump: document.querySelector(".jump-to-latest")?.classList.contains("visible") ?? false,
    row: rect(row), rows: rows.length, settled: row?.dataset.settled === "true",
    text: [...(row?.querySelectorAll('.md[data-part^="text-"]') ?? [])].map(node => node.textContent.trim()).join("\n\n"),
    textSources: [...(row?.querySelectorAll('.md[data-part^="text-"]') ?? [])].map(node => node.dataset.src),
    thinking: row?.querySelector(".thinking-body")?.textContent ?? "", usage: row?.querySelector('[data-part="usage"]')?.textContent ?? null,
    usageError: row?.querySelector('[data-part="usage"]')?.classList.contains("error") ?? false,
    usageCount: row?.querySelectorAll('[data-part="usage"]').length ?? 0, footer: rect(footer), cost: footer?.querySelector(".uf-cost")?.textContent ?? null,
    costCount: footer?.querySelectorAll(".uf-cost").length ?? 0,
    card: rect(card), input: card?.querySelector(".tool-section:not(.tool-result) pre")?.textContent ?? null,
    result: card?.querySelector(".tool-result pre")?.textContent ?? null, toolState: card?.querySelector(".tool-dot")?.className ?? null,
    open: card?.classList.contains("open") ?? false, summary: card?.querySelector(".tool-summary")?.textContent ?? null,
    activity, working: document.querySelector(".working-row")?.classList.contains("active") ?? false,
    stopVisible: getComputedStyle(document.querySelector(".send-btn.stop")).display !== "none",
    tracked: Object.fromEntries(Object.entries(window.__tracked).map(([name, node]) => [name, rect(node)])),
   };
   value.overlay = !!card && !!activity && value.working && value.card.bottom > activity.top && value.card.top < activity.bottom;
   window.__trace.push(value); return value;
  };
  window.__event = event => { window.__events.push(structuredClone(event)); host({ type: "event", event: structuredClone(event) }); window.__sample(`event:${event.type}`); };
  window.__snapshot = (messages, streaming = true, durableMessages = false) => {
   window.__status = { ...window.__status, streaming };
   window.__events.push({ type: "snapshot", messages: structuredClone(messages), streaming, durableMessages });
   host({ type: "snapshot", messages: structuredClone(messages), state: null, status: window.__status, durableMessages }); window.__sample("snapshot");
  };
  window.__snapshot(history);
  window.__event({ type: "agent_start" });
  window.__tracked.footer = [...outer.querySelectorAll(".user-footer")].at(-1);
  const watch = () => { if (!window.__watch) return; window.__sample("rAF"); requestAnimationFrame(watch); }; requestAnimationFrame(watch);
 }, history);
 await frames(page);
 assert.ok((await sample(page)).max > 1000, "the normal preview has a real overflowing transcript");
}
async function sample(page) { return page.evaluate(() => window.__sample("inspect")); }
async function send(page, event, phase = event.assistantMessageEvent?.type ?? event.type) {
 await page.evaluate(({ event, phase }) => { window.__phase = phase; window.__event(event); }, { event, phase });
 await frames(page); return sample(page);
}
async function snapshot(page, messages, phase, streaming = true, durableMessages = false) {
 await page.evaluate(({ messages, phase, streaming, durableMessages }) => {
  window.__phase = phase; window.__snapshot(messages, streaming, durableMessages);
 }, { messages, phase, streaming, durableMessages });
 await frames(page); return sample(page);
}
function assertLive(value, expected, label) {
 assert.equal(value.text, expected.trim(), `${label}: latest cumulative text is visible, not frozen at the first chunk`);
 assert.equal(value.settled, false, `${label}: provider stopReason=stop is not a settled message`);
 assert.equal(value.usageCount, 0, `${label}: no final token/error line on a live partial`);
 assert.equal(value.cost, null, `${label}: no final user-turn input cost on a live partial`);
 assert.equal(value.working, true, `${label}: the real run remains active`);
 assert.equal(value.stopVisible, true, `${label}: Stop remains available until agent_end`);
}
function assertFinal(value, message, label, extra = "") {
 const expected = message.content.filter(part => part.type === "text").map(part => part.text.trim()).filter(Boolean).join("\n\n");
 assert.equal(value.text, expected, `${label}: final text is not lost`);
 assert.equal(value.settled, true, `${label}: authoritative final settles its own row`);
 const parts = [`${compactTokens(message.usage.totalTokens)} tokens`];
 if (message.usage.cost.total) parts.push(`$${message.usage.cost.total.toFixed(4)}`);
 if (extra) parts.push(extra);
 assert.equal(value.usage, parts.join(" · "), `${label}: exact final usage/error receipt`);
 assert.equal(value.usageCount, 1, `${label}: one usage receipt`);
 assert.equal(value.cost, `$${message.usage.cost.input.toFixed(4)} input`, `${label}: exact final user-turn cost`);
 assert.equal(value.costCount, 1, `${label}: one cost receipt`);
}
async function finish(page) {
 const value = await send(page, { type: "agent_end" }, "agent-end");
 assert.equal(value.working, false, "agent_end retires Working");
 assert.equal(value.stopVisible, false, "agent_end retires Stop");
}
async function run(name, test) {
 const page = await browser.newPage({ viewport: { width: 420, height: 620 } });
 page.setDefaultTimeout(5000);
 const errors = []; page.on("pageerror", error => errors.push(String(error)));
 let detail = null, failure = null;
 try {
  await seed(page); detail = await test(page);
  assert.deepEqual(errors, [], "no page errors");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no caught host-message handler errors");
  const painted = await page.evaluate(() => window.__trace.filter(value => value.label === "rAF"));
  assert.ok(painted.every(value => value.gap <= 1 && !value.jump), "every painted frame stays FOLLOWING at the actual tail");
  assert.ok(painted.every(value => !value.overlay), "Working does not cover a visible retained tool card");
  assert.ok(painted.every(value => value.tracked.footer.connected && value.footer.id === value.tracked.footer.id), "the exact user footer remains mounted");
 } catch (error) { failure = String(error.stack); console.error(`FAIL ${name}\n${failure}`); }
 const trace = await page.evaluate(() => { window.__watch = false; return window.__trace; });
 const events = await page.evaluate(() => window.__events);
 const report = { name, pass: failure === null, error: failure, detail, sourceRef: sourceRef ?? null,
  transcriptSource: transcriptSource ?? null, sourceHash, artifact: join(dir, `${name}.json`),
  paintedFrames: trace.filter(value => value.label === "rAF").length };
 await writeFile(report.artifact, JSON.stringify({ report, provenance, events, trace }, null, 2));
 await page.screenshot({ path: join(dir, `${name}.png`) });
 reports.push(report); if (!failure) console.log(`PASS ${name}`);
 await page.close();
}
const longCode = "import json\nfrom pathlib import Path\n" + Array.from({ length: 100 }, (_, i) => `value_${i} = {'file': 'src/item_${i}.ts', 'count': ${i}}\n`).join("") + "print(json.dumps({'ok': True}))\n";
try {
 browser = await chromium.launch();
 await run("captured-098-pong-wire", async page => {
  for (const event of pongEvents) {
   const value = await send(page, event);
   if (event.type === "message_end") assertFinal(value, event.message, "captured PONG end");
   else assertLive(value, event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n"), event.assistantMessageEvent?.type ?? event.type);
  }
  const rowId = (await sample(page)).row.id;
  await send(page, { type: "turn_end", message: pongFinal, toolResults: [] });
  await send(page, pongEvents[2], "replayed-PONG-partial-after-end");
  const value = await sample(page); assertFinal(value, pongFinal, "PONG replay");
  assert.equal(value.row.id, rowId, "final responseId enriches the timestamp row without replacing it");
  assert.equal(value.rows, 1); await finish(page);
  return { fixture: provenance.pong, events: pongEvents.length };
 });
 await run("captured-native-sdk-multichunk", async page => {
  const seen = [];
  for (const event of nativeRpcEvents) {
   const value = await send(page, event);
   if (event.type === "message_end") assertFinal(value, event.message, "native SDK done");
   else { assertLive(value, event.message.content.map(part => part.text).join("\n\n"), event.assistantMessageEvent?.type ?? event.type); seen.push(value.text); }
  }
  assert.ok(seen.includes("Hello") && seen.includes("Hello native partial"), "both actual native SDK chunks must paint before done");
  assert.equal((await sample(page)).rows, 1); await finish(page);
  return { fixture: provenance.native, partialTexts: seen };
 });
 await run("captured-098-tool-wire", async page => {
  let expectedThinking = "", cardId = null;
  for (const event of toolEvents) {
   const value = await send(page, event);
   if (event.type === "message_end") assertFinal(value, event.message, "installed tool wire end");
   else {
    assertLive(value, event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n"), event.assistantMessageEvent?.type ?? event.type);
    const nextThinking = event.message.content.find(part => part.type === "thinking")?.thinking ?? "";
    if (nextThinking.length >= expectedThinking.length) expectedThinking = nextThinking;
    assert.equal(value.thinking, expectedThinking, "captured empty thinking_start cannot roll back a nonempty first start");
   }
   const call = event.message.content.find(part => part.type === "toolCall");
   if (call) {
    cardId ??= value.card.id; assert.equal(value.card.id, cardId, "real growing args retain their own mounted card");
    const expectedInput = call.arguments.code ?? JSON.stringify(call.arguments, null, 2);
    assert.equal(value.input, expectedInput, "exact real tool arguments paint cumulatively");
    assert.equal(value.toolState, "tool-dot running", "assistant end does not invent execution completion");
   }
  }
  const end = toolEvents.at(-1).message;
  await send(page, { type: "tool_execution_start", toolCallId: "offline-display-tool", toolName: "offline_display_only", args: { code: "print(1)" } });
  let value = await send(page, { type: "tool_execution_update", toolCallId: "offline-display-tool", partialResult: { output: "1\n" } });
  assert.equal(value.toolState, "tool-dot running"); assert.equal(value.result, "1\n");
  value = await send(page, { type: "tool_execution_end", toolCallId: "offline-display-tool", result: { output: "1\n" }, isError: false });
  assert.equal(value.toolState, "tool-dot done"); assert.equal(value.card.id, cardId); assertFinal(value, end, "executed real-shape card");
  await finish(page); return { fixture: provenance.tool, events: toolEvents.length, cardId };
 });
 await run("captured-anthropic-rolling-usage-snapshot", async page => {
  let rowId = null;
  for (const event of anthropicEvents) {
   const value = await send(page, event);
   if (event.type === "message_end") assertFinal(value, event.message, "Anthropic final output usage");
   else assertLive(value, event.message.content.map(part => part.text).join("\n\n"), event.assistantMessageEvent?.type ?? event.type);
   if (value.row) { rowId ??= value.row.id; assert.equal(value.row.id, rowId); }
   if (event.assistantMessageEvent?.delta === "Hello") {
    let snap = await snapshot(page, [...history, event.message], "captured-input-10-same-live-snapshot");
    assertLive(snap, "Hello", "real Anthropic nonzero input usage snapshot"); assert.equal(snap.row.id, rowId);
    // Same real envelope, larger rolling input usage: not a new finality signal.
    const rolling101 = { ...structuredClone(event.message), usage: usage(101, 0) };
    snap = await snapshot(page, [...history, rolling101], "rolling-input-101-same-live-snapshot");
    assertLive(snap, "Hello", "rolling usage 101 snapshot"); assert.equal(snap.row.id, rowId);
   }
  }
  const value = await sample(page);
  assert.equal(value.text, "Hello actual Anthropic partial", "the chunk after the rolling snapshot must not freeze");
  assert.equal(value.usage, "15 tokens", "final usage wins over the input-only snapshot's 101 tokens");
  await finish(page); return { fixture: provenance.anthropic, rowId, rollingInput: [10, 101] };
 });
 await run("real-shape-tool-live-snapshot-nonregress", async page => {
  const make = (code, prose = "Preparing the source check. ", thinking = "Inspect the source carefully. ".repeat(8)) => capturedMessage(nativeBase,
   [{ type: "thinking", thinking }, text(prose), { type: "toolCall", id: "lifecycle-tool", name: "ipython", arguments: { code } }],
   { timestamp: 1791335600000, responseId: "lifecycle-growing-tool" });
  let current = make(longCode.slice(0, 60));
  assertLive(await send(page, wire("message_start", current)), "Preparing the source check.", "first real-shape tool start");
  await page.evaluate(() => {
   document.querySelector('[data-part="tool-lifecycle-tool"] .tool-toggle').click();
   window.__tracked.card = document.querySelector('[data-part="tool-lifecycle-tool"]');
   window.__tracked.owner = window.__tracked.card.closest(".row");
  });
  await frames(page);
  const first = await sample(page);
  for (const length of [350, 1000]) {
   current = make(longCode.slice(0, length));
   const value = await send(page, wire("message_update", current, { type: "toolcall_delta", contentIndex: 2, delta: "captured-shape argument growth" }));
   assertLive(value, "Preparing the source check.", `growing code ${length}`); assert.equal(value.input, longCode.slice(0, length));
  }
  current = make(longCode, "Preparing the source check. Full input is now visible. ");
  let value = await snapshot(page, [...history, current], "full-known-live-snapshot");
  assertLive(value, current.content[1].text, "full known-live snapshot"); assert.equal(value.input, longCode);
  const full = value;
  value = await send(page, wire("message_update", make(longCode.slice(0, 70), "Preparing", "Inspect"), { type: "toolcall_delta", contentIndex: 2, delta: "older" }), "older-partial-after-full-snapshot");
  assertLive(value, current.content[1].text, "older partial cannot regress snapshot text");
  assert.equal(value.input, longCode, "older args cannot regress full snapshot input");
  assert.equal(value.thinking, current.content[0].thinking, "older thinking cannot regress full snapshot");
  assert.equal(value.card.id, first.card.id); assert.equal(value.row.id, first.row.id);
  assert.equal(value.footer.id, first.footer.id); assert.equal(value.open, true);
  assert.ok(Math.abs(value.card.top - full.card.top) <= 0.5 && Math.abs(value.card.height - full.card.height) <= 0.5, "older frame cannot shrink/reverse retained card geometry");
  const final = { ...structuredClone(current), stopReason: "toolUse", usage: finalUsage };
  value = await send(page, wire("message_end", final), "tool-message-end");
  assertFinal(value, final, "real-shape tool final"); assert.equal(value.toolState, "tool-dot running");
  await send(page, { type: "tool_execution_start", toolCallId: "lifecycle-tool", toolName: "ipython", args: { code: longCode } });
  value = await send(page, { type: "tool_execution_update", toolCallId: "lifecycle-tool", partialResult: { output: "Checking source files\n".repeat(30) } });
  assert.equal(value.toolState, "tool-dot running"); assert.ok(value.result.includes("Checking source files"));
  const result = "Checking source files\n".repeat(30) + "All done";
  value = await send(page, { type: "tool_execution_end", toolCallId: "lifecycle-tool", result: { output: result }, isError: false });
  assert.equal(value.toolState, "tool-dot done"); assert.equal(value.result, result); assertFinal(value, final, "real execution done");
  const receipt = value;
  await send(page, wire("message_start", make("")), "replayed-empty-tool-start");
  value = await send(page, wire("message_update", make("print")), "replayed-short-tool-partial");
  assert.equal(value.card.id, first.card.id); assert.equal(value.footer.id, first.footer.id);
  assert.equal(value.input, longCode); assert.equal(value.result, result); assert.equal(value.toolState, "tool-dot done");
  assert.equal(value.usage, receipt.usage); assert.equal(value.cost, receipt.cost);
  const painted = await page.evaluate(() => window.__trace.filter(value => value.label === "rAF" && value.tracked.card));
  assert.ok(painted.every(value => value.tracked.card.connected && value.card.id === first.card.id && value.tracked.owner.connected), "card and owner stay mounted throughout snapshots and execution");
  const down = painted.slice(1).filter((value, index) => value.card.top > painted[index].card.top + 0.5);
  assert.deepEqual(down.map(value => ({ phase: value.phase, top: value.card.top })), [], "append-only provider/tool lifecycle never moves a mounted card down");
  await finish(page); return { cardId: first.card.id, footerId: first.footer.id, fullInputLength: longCode.length, paintedFrames: painted.length };
 });
 await run("empty-error-final-is-authoritative", async page => {
  const start = capturedMessage(nativeBase, [], { timestamp: 1791335600100, responseId: "lifecycle-error" });
  assertLive(await send(page, wire("message_start", start)), "", "empty error stream opening");
  const final = { ...structuredClone(start), usage: usage(10, 3), stopReason: "error", errorMessage: "offline fixture request failed" };
  let value = await send(page, wire("message_end", final));
  assertFinal(value, final, "genuine error final", "request failed — offline fixture request failed");
  assert.equal(value.usageError, true); assert.equal(value.rows, 1); const rowId = value.row.id;
  await send(page, wire("message_start", start), "replayed-error-start");
  value = await send(page, wire("message_update", capturedMessage(start, [text("stale pre-error text")])), "replayed-error-partial");
  assertFinal(value, final, "error replay", "request failed — offline fixture request failed");
  assert.equal(value.row.id, rowId); assert.equal(value.usageError, true); await finish(page);
  return { rowId, error: final.errorMessage };
 });
 await run("shorter-text-end-only-own-part", async page => {
  const base = { ...nativeBase, timestamp: 1791335600200, responseId: "own-part-A" };
  const make = (first, sibling = "Long current second text part.") => capturedMessage(base,
   [text(first), { type: "thinking", thinking: "Current thinking remains intact." }, text(sibling),
    { type: "toolCall", id: "own-part-tool", name: "ipython", arguments: { code: "print('retained')" } }]);
  const opening = make("Long provisional first text part to reconcile.");
  let value = await send(page, wire("message_start", opening));
  assertLive(value, "Long provisional first text part to reconcile.\n\nLong current second text part.", "provisional multi-part start");
  const shorter = make("Corrected first.");
  value = await send(page, wire("message_update", shorter, { type: "text_delta", contentIndex: 0, delta: "older" }));
  assert.deepEqual(value.textSources, [opening.content[0].text, opening.content[2].text], "ordinary shorter partial is rejected");
  value = await send(page, wire("message_update", shorter, { type: "text_end", contentIndex: 0, content: "Corrected first." }));
  assertLive(value, "Corrected first.\n\nLong current second text part.", "genuine shorter text_end");
  assert.equal(value.thinking, opening.content[1].thinking); assert.equal(value.input, "print('retained')");
  const own = value;
  value = await send(page, wire("message_update", make("Even shorter.", "stale sibling"), { type: "text_end", contentIndex: 0, content: "Even shorter." }), "text-end-with-older-sibling");
  assert.deepEqual(value.textSources, own.textSources, "text_end for part 0 does not authorize shrinking unrelated part 2");
  value = await send(page, wire("message_update", make("Tiny."), { type: "text_end", content: "Tiny." }), "unindexed-end-with-shorter-text");
  assert.deepEqual(value.textSources, own.textSources, "unindexed block end cannot bypass the partial watermark");
  const aId = value.row.id;
  const b = capturedMessage(nativeBase, [text("Current response B")], { timestamp: 1791335600201, responseId: "own-part-B" });
  value = await send(page, wire("message_start", b)); const bId = value.row.id;
  value = await send(page, wire("message_update", make("A final block correction."), { type: "text_end", contentIndex: 0, content: "A final block correction." }), "late-A-block-end-while-B-live");
  assertLive(value, "Current response B", "late A block end cannot overwrite or settle B"); assert.equal(value.row.id, bId);
  const nextB = { ...structuredClone(b), content: [text("Current response B continues")] };
  value = await send(page, wire("message_update", nextB, { type: "text_delta", contentIndex: 0, delta: " continues" }));
  assertLive(value, "Current response B continues", "B remains usable after late A block end"); assert.equal(value.rows, 2);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.row-assistant')].filter(row => Number(row.dataset.ts) > 2000).map(row => ({
   id: window.__ids.get(row), text: row.querySelector('[data-part="text-0"]')?.dataset.src, settled: row.dataset.settled === "true",
  })));
  assert.deepEqual(rows, [{ id: aId, text: "A final block correction.", settled: false }, { id: bId, text: "Current response B continues", settled: false }]);
  await finish(page); return { aId, bId, rows };
 });
 await run("idle-durable-snapshot-final-correction", async page => {
  const opening = capturedMessage(nativeBase, [text("Long provisional snapshot reply that will be corrected.")],
   { timestamp: 1791335600300, responseId: "durable-lifecycle-final" });
  let value = await send(page, wire("message_start", opening)); assertLive(value, opening.content[0].text, "durable stream opening");
  const rowId = value.row.id;
  const final = { ...structuredClone(opening), content: [text("Corrected durable reply.")], usage: usage(10, 3) };
  delete final.stopReason; // Older persisted records can omit this field.
  value = await snapshot(page, [...history, final], "idle-authoritative-durable-snapshot", false, true);
  assertFinal(value, final, "proven durable correction without stopReason"); assert.equal(value.row.id, rowId);
  value = await send(page, wire("message_update", opening), "older-delta-after-durable-correction");
  assertFinal(value, final, "settled durable record ignores older delta"); assert.equal(value.row.id, rowId); assert.equal(value.rows, 1);
  await finish(page); return { rowId, finalText: final.content[0].text };
 });
 await run("missed-message-end-durable-final-while-busy", async page => {
  // Native get_messages is a durable-only list. It can finish a known response
  // even while the parent run remains busy, with no message_end delivered here.
  const opening = capturedMessage(anthropicBase,
   [anthropicText("Long provisional Anthropic prose that the final durable record corrects.")],
   { timestamp: 1791335600400, responseId: "missed-end-anthropic" });
  let value = await send(page, wire("message_start", opening));
  assertLive(value, opening.content[0].text, "missed-end opening with nonzero input usage");
  const rowId = value.row.id, footerId = value.footer.id;
  const final = { ...structuredClone(opening), content: [text("Correct final.")], usage: {
   ...usage(10, 5), cost: { input: 0.004, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.007 },
  } };
  value = await snapshot(page, [...history, final], "durable-final-snapshot-while-agent-busy", true, true);
  assertFinal(value, final, "durable-only list replaces a missed message_end");
  assert.equal(value.row.id, rowId); assert.equal(value.footer.id, footerId);
  assert.equal(value.rows, 1); assert.equal(value.working, true); assert.equal(value.stopVisible, true);
  const receipt = value;
  await send(page, wire("message_start", opening), "replayed-opening-after-durable-final");
  value = await send(page, wire("message_update", opening, { type: "text_delta", contentIndex: 0, delta: "older partial" }), "older-partial-after-durable-final");
  assertFinal(value, final, "late partial cannot regress proven durable final");
  assert.equal(value.row.id, rowId); assert.equal(value.footer.id, footerId);
  assert.equal(value.usage, receipt.usage); assert.equal(value.cost, receipt.cost);
  await finish(page); assertFinal(await sample(page), final, "agent_end retains the recovered final receipt");
  return { rowId, footerId, finalTokens: 15, durableMessages: true, deliveredMessageEnd: false };
 });
} finally {
 await browser?.close();
 await new Promise(resolve => server.close(resolve));
}
await writeFile(join(dir, "summary.json"), JSON.stringify({ sourceRef: sourceRef ?? null, transcriptSource: transcriptSource ?? null,
 sourceHash, provenance, passed: reports.filter(report => report.pass).length, failed: reports.filter(report => !report.pass).length, reports }, null, 2));
console.log(`Provider lifecycle: ${reports.filter(report => report.pass).length} passed, ${reports.filter(report => !report.pass).length} failed (transcript ${sourceHash}; artifacts ${dir})`);
if (reports.some(report => !report.pass)) process.exitCode = 1;
