/**
 * Late strong-response frames must never overwrite or freeze the current reply.
 * Source bundle stays in memory; no daemon, paid model, or generated asset.
 * Usage: node test/live-tail-response-order.test.mjs
 * Baseline: RESPONSE_ORDER_SOURCE_REF=d6e0d2c node test/live-tail-response-order.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRef = process.env.RESPONSE_ORDER_SOURCE_REF;
const git = promisify(execFile);
async function source(path) {
 if (!sourceRef) return readFile(path);
 const { stdout } = await git("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
 return Buffer.from(stdout);
}
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("response-order-test") },
 plugins: sourceRef ? [{ name: "historical-source", setup(api) {
  api.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ contents: (await source(path)).toString(), loader: "ts" }));
 } }] : [],
});
const assets = new Map([
 ["/preview.html", ["text/html", await source(`${root}media/preview.html`)]],
 ["/main.css", ["text/css", await source(`${root}media/main.css`)]],
 ["/main.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
const server = createServer((req, res) => {
 const asset = assets.get(new URL(req.url, "http://localhost").pathname);
 res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
 res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
let browser;
let failures = 0;
const frames = page => page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
async function seed(page) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.waitForSelector(".boot-splash", { state: "detached" });
 await page.evaluate(() => {
  window.__history = [{ role: "user", timestamp: 1, content: "Review source response ordering" }];
  window.__status = { ...baseStatus, sessionId: "response-order-session", streaming: true };
  window.__event = event => host({ type: "event", event: structuredClone(event) });
  window.__snapshot = messages => host({ type: "snapshot", messages: structuredClone(messages), state: null, status: window.__status });
  window.__snapshot(window.__history);
  window.__event({ type: "agent_start" });
  window.__text = (responseId, timestamp, text) => ({ role: "assistant", responseId, timestamp, content: [{ type: "text", text }] });
  window.__a = window.__text("response-A", 2, "Older response A began");
  window.__b = window.__text("response-B", 3, "Current response B");
  window.__lateA = window.__text("response-A", 2, "Older source analysis now replayed. ".repeat(8));
  window.__nextB = window.__text("response-B", 3, "Current response B continues");
 });
 await frames(page);
}
async function run(name, test) {
 const page = await browser.newPage({ viewport: { width: 420, height: 620 } });
 page.setDefaultTimeout(5000);
 const errors = []; page.on("pageerror", error => errors.push(String(error)));
 try {
  await seed(page); await test(page); await frames(page);
  assert.deepEqual(errors, [], "no page errors");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no caught handler errors");
  console.log(`PASS ${name}`);
 } catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
 finally { await page.close(); }
}
try {
 browser = await chromium.launch();
 await run("late longer A update cannot overwrite B or freeze its next cumulative delta", async page => {
  const result = await page.evaluate(() => {
   window.__event({ type: "message_start", message: window.__a });
   window.__rowA = document.querySelector(".row-assistant");
   window.__event({ type: "message_start", message: window.__b });
   window.__rowB = document.querySelectorAll(".row-assistant")[1];
   const beforeB = window.__rowB.textContent;
   window.__event({ type: "message_update", message: window.__lateA });
   const afterLate = window.__rowB.textContent;
   window.__event({ type: "message_update", message: window.__nextB });
   const afterNext = window.__rowB.textContent;
   // A same-session snapshot cannot find a poisoned B through A's response map.
   window.__snapshot([...window.__history, window.__lateA, window.__nextB]);
   return { beforeB, afterLate, afterNext, aSame: document.querySelectorAll(".row-assistant")[0] === window.__rowA,
    bSame: document.querySelectorAll(".row-assistant")[1] === window.__rowB, rows: document.querySelectorAll(".row-assistant").length,
    bAfterSnapshot: window.__rowB.textContent };
  });
  assert.equal(result.afterLate, result.beforeB, "late known response A must not touch active response B");
  assert.equal(result.afterNext, "Current response B continues", "genuine B delta must still render after the late A frame");
  assert.equal(result.aSame, true, "response A keeps its exact own row after snapshot");
  assert.equal(result.bSame, true, "response B keeps its exact own row after snapshot");
  assert.equal(result.rows, 2, "no duplicate response row is created");
  assert.equal(result.bAfterSnapshot, "Current response B continues");
 });
 await run("late A final correction settles its own row and leaves live B usable", async page => {
  const result = await page.evaluate(() => {
   window.__event({ type: "message_start", message: window.__a });
   const a = document.querySelector(".row-assistant");
   window.__event({ type: "message_start", message: window.__b });
   const b = document.querySelectorAll(".row-assistant")[1];
   const beforeB = b.textContent;
   window.__event({ type: "message_start", message: window.__a });
   const afterReplayStartB = b.textContent;
   window.__event({ type: "message_end", message: { ...window.__a, content: [{ type: "text", text: "A corrected final" }],
    stopReason: "stop", usage: { totalTokens: 175, cost: { input: 0.004, total: 0.007 } } } });
   const afterFinalB = b.textContent;
   const aText = a.querySelector('[data-part="text-0"]')?.textContent;
   const aUsage = a.querySelector('[data-part="usage"]')?.textContent;
   window.__event({ type: "message_update", message: window.__nextB });
   return { beforeB, afterReplayStartB, afterFinalB, aText, aUsage, afterNextB: b.textContent, aConnected: a.isConnected, bConnected: b.isConnected,
    rows: document.querySelectorAll(".row-assistant").length };
  });
  assert.equal(result.afterReplayStartB, result.beforeB, "replayed A start must not take over B");
  assert.equal(result.afterFinalB, result.beforeB, "late final A must not settle or repaint active B");
  assert.equal(result.aText, "A corrected final", "authoritative A correction must not be lost");
  assert.ok(result.aUsage?.includes("175 tokens") && result.aUsage.includes("$0.0070"), "A final usage is preserved on A");
  assert.equal(result.afterNextB, "Current response B continues", "B still accepts its own next delta");
  assert.equal(result.aConnected, true); assert.equal(result.bConnected, true); assert.equal(result.rows, 2);
 });
 await run("missing strong response ID enriches the current timestamp row without duplication", async page => {
  const result = await page.evaluate(() => {
   const start = window.__text(undefined, 4, "Timestamp-only opening");
   window.__event({ type: "message_start", message: start });
   const row = document.querySelector(".row-assistant");
   const enriched = window.__text("enriched-response", 4, "Timestamp-only opening with a known response ID");
   window.__event({ type: "message_update", message: enriched });
   window.__snapshot([...window.__history, enriched]);
   return { same: document.querySelector(".row-assistant") === row, text: row.textContent, rows: document.querySelectorAll(".row-assistant").length };
  });
  assert.equal(result.same, true); assert.equal(result.rows, 1);
  assert.equal(result.text, "Timestamp-only opening with a known response ID");
 });
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
console.log(`Response order: ${3 - failures} passed, ${failures} failed${sourceRef ? ` (source ${sourceRef})` : ""}`);
if (failures) process.exitCode = 1;
