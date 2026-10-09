/**
 * Large plain-text paste and rejected-send recovery in native Chromium.
 * TypeScript, preview HTML and CSS are loaded/bundled in memory. No generated
 * assets, system clipboard, system focus, daemon, RPC worker or model calls.
 * A real ClipboardEvent/DataTransfer fixture exercises paste handling. Chromium
 * does not perform the default insertion for constructed paste events, so only
 * unclaimed fixtures receive setRangeText + input as the browser default action.
 * Enter, Shift+Enter and chip buttons use native Playwright input.
 * Trusted-host stage acknowledgments always describe real private UTF-8 files.
 *
 * Current:  node test/large-paste.test.mjs
 * Baseline: SOURCE_REF=v1.0.52 node test/large-paste.test.mjs
 * Artifacts: /tmp/prime-large-paste/browser/{current|v1.0.52}/
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { relative, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRef = process.env.SOURCE_REF;
const output = process.env.LARGE_PASTE_OUTPUT ?? join("/tmp/prime-large-paste/browser", sourceRef ? sourceRef.replace(/[^a-z0-9_.-]/gi, "_") : "current");
const exec = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const testPath = fileURLToPath(import.meta.url);
const testHashBefore = sha256(await readFile(testPath));
const sourceHashesBefore = {}, sourceCache = new Map();
async function readSource(path) {
 return sourceRef
  ? Buffer.from((await exec("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout)
  : readFile(path);
}
async function source(path) {
 if (!sourceCache.has(path)) sourceCache.set(path, (async () => {
  const bytes = await readSource(path);
  sourceHashesBefore[relative(root, path)] = sha256(bytes);
  return bytes;
 })());
 return sourceCache.get(path);
}
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("large-paste-test") },
 plugins: [{ name: "in-memory-source", setup(api) {
  api.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ contents: (await source(path)).toString(), loader: "ts" }));
 }}],
});
const assets = new Map([
 ["/preview.html", ["text/html", await source(join(root, "media/preview.html"))]],
 ["/main.css", ["text/css", await source(join(root, "media/main.css"))]],
 ["/panels.css", ["text/css", await source(join(root, "media/panels.css"))]],
 ["/main.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
const server = createServer((req, res) => {
 const asset = assets.get(new URL(req.url, "http://localhost").pathname);
 res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
 res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
await mkdir(output, { recursive: true, mode: 0o700 });
const stagedDir = join(output, "staged");
await mkdir(stagedDir, { recursive: true, mode: 0o700 });

// Contract constants are independent of the code under test.
const INLINE_LIMIT = 200_000, PASTE_THRESHOLD = 32_000, FILE_LIMIT = 8 * 1024 * 1024, FILE_COUNT = 4;
const CONTROL_LIMIT = 384 * 1024;
const SESSION = "01a11351-bbf4-7594-9f5a-2a6d8fdd1ca6";
const NEXT_SESSION = "01a1166a-7654-7784-844a-1a2e84988deb";
const TEXTAREA = ".composer-dock textarea", CHIP = ".compose-chip.text-file";
const SEND = '.composer-rail .send-btn[title="Send (Enter)"]';
const reports = [], postChecks = [], stagedFiles = [];
let browser, failures = 0, currentCase = "", stagedCounter = 0;
const runId = randomUUID();
const frames = (page, count = 3) => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, count);
// One bounded wait for the real 300ms draft debounce. It is not a polling loop.
const settleDraft = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 360)));
const input = page => page.locator(TEXTAREA);
const chip = (page, ref) => page.locator(`${CHIP}[data-ref="${ref}"]`);
const host = async (page, message) => { await page.evaluate(message => host(message), message); await frames(page); };
const posts = page => page.evaluate(() => structuredClone(postedMessages));
const messagesOf = async (page, type) => (await posts(page)).filter(p => p.type === type);
const promptPosts = page => messagesOf(page, "prompt");
const stages = page => page.evaluate(() => [...new Set(postedMessages.filter(p => p.type === "stageTextAttachment" || p.type === "stageTextAttachmentChunk").map(p => p.requestId))]);

function textMetric(text) { return { utf16Length: text.length, utf8Bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) }; }
function summarizeMessage(message) {
 const copy = structuredClone(message);
 if (typeof copy.text === "string") copy.text = textMetric(copy.text);
 if (copy.payload) {
  if (typeof copy.payload.text === "string") copy.payload.text = textMetric(copy.payload.text);
  if (copy.payload.images) copy.payload.images = copy.payload.images.map(({ data, ...image }) => ({ ...image, data: textMetric(data) }));
 }
 return copy;
}
async function audit(page, label) {
 const all = await posts(page);
 const invalidDrafts = all.filter(p => p.type === "draftChanged" && (typeof p.text !== "string" || p.text.length > INLINE_LIMIT || p.text.includes("\0")));
 const invalidPrompts = all.filter(p => p.type === "prompt" && (typeof p.payload?.text !== "string" || p.payload.text.length > INLINE_LIMIT || p.payload.text.includes("\0") || (p.payload.textFiles ?? []).some(ref => typeof ref !== "string")));
 const oversizedControls = all.filter(p => Buffer.byteLength(JSON.stringify(p)) > CONTROL_LIMIT);
 const check = { case: currentCase, label, posts: all.map(summarizeMessage), invalidDrafts: invalidDrafts.length, invalidPrompts: invalidPrompts.length, oversizedControls: oversizedControls.length };
 postChecks.push(check);
 assert.equal(invalidDrafts.length, 0, `${label}: no oversized or NUL draft transport`);
 assert.equal(invalidPrompts.length, 0, `${label}: no invalid inline prompt or raw text-file body`);
 assert.equal(oversizedControls.length, 0, `${label}: every control message stays within 384 KiB serialized UTF-8`);
 return check;
}
async function seed(page, { sessionId = SESSION, vision = false } = {}) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.evaluate(({ sessionId, vision }) => {
  window.__status = { ...baseStatus, sessionId, sessionName: "Large-paste fixture", modelLabel: "fixture/text", modelProvider: "fixture", modelId: "text" };
  host({ type: "models", models: [{ provider: "fixture", id: "text", contextWindow: 262144, reasoning: false, input: vision ? ["text", "image"] : ["text"] }] });
  host({ type: "snapshot", messages: [], state: { model: { provider: "fixture", id: "text" } }, status: window.__status });
 }, { sessionId, vision });
 await page.waitForSelector(".boot-splash", { state: "detached" });
 assert.equal(await input(page).isEnabled(), true, "host-confirmed live session arms the composer");
 await frames(page);
}
async function paste(page, text, range) {
 await input(page).focus();
 const result = await page.evaluate(({ selector, text, range }) => {
  const textarea = document.querySelector(selector);
  if (range) textarea.setSelectionRange(range[0], range[1]);
  const before = textarea.value, selection = [textarea.selectionStart, textarea.selectionEnd];
  const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
  const fixture = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  textarea.dispatchEvent(fixture);
  if (!fixture.defaultPrevented) {
   textarea.setRangeText(text, selection[0], selection[1], "end");
   textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  }
  return { nativeClipboardEvent: fixture instanceof ClipboardEvent, nativeDataTransfer: clipboardData instanceof DataTransfer, prevented: fixture.defaultPrevented, trusted: fixture.isTrusted, exactClipboard: clipboardData.getData("text/plain") === text, beforeLength: before.length, afterLength: textarea.value.length, selection, afterSelection: [textarea.selectionStart, textarea.selectionEnd] };
 }, { selector: TEXTAREA, text, range });
 assert.equal(result.nativeClipboardEvent && result.nativeDataTransfer && result.exactClipboard, true, "plain-text fixture uses native clipboard classes and exact clipboard data");
 assert.equal(result.trusted, false, "constructed paste is a fixture, not a claim of system-clipboard input");
 await frames(page);
 return result;
}
async function enter(page, key = "Enter") {
 await input(page).focus(); await page.keyboard.press(key); await frames(page);
 const entry = await page.evaluate(() => window.__largePasteKeys.at(-1));
 assert.equal(entry?.key, "Enter", "native keyboard event reaches the real textarea");
 assert.equal(entry?.trusted, true, "Enter is native trusted Chromium input, not dispatchEvent");
 assert.equal(entry?.shift, key === "Shift+Enter");
}
async function waitStage(page, ordinal = 0) {
 await page.waitForFunction(ordinal => new Set(postedMessages.filter(p => p.type === "stageTextAttachment" || p.type === "stageTextAttachmentChunk").map(p => p.requestId)).size > ordinal, ordinal, { timeout: 3000 });
 const first = await page.evaluate(ordinal => {
  const all = postedMessages.filter(p => p.type === "stageTextAttachment" || p.type === "stageTextAttachmentChunk");
  const id = [...new Set(all.map(p => p.requestId))][ordinal];
  return structuredClone(all.find(p => p.requestId === id));
 }, ordinal);
 assert.equal(typeof first.requestId, "number", "stage uses a correlated numeric request id");
 assert.equal(first.sessionId, await page.evaluate(() => window.__status.sessionId), "stage names the host-confirmed session");
 assert.match(first.name, /\.txt$/, "visible attachment has a text-file name");
 assert.equal("path" in first || "ref" in first, false, "webview staging never nominates a host write path or capability");
 const packets = [];
 if (first.type === "stageTextAttachment") packets.push(first);
 else {
  assert.ok(Number.isSafeInteger(first.totalChunks) && first.totalChunks > 0 && first.totalChunks <= 256, "chunk count is bounded");
  for (let index = 0; index < first.totalChunks; index++) {
   await page.waitForFunction(({ requestId, index }) => postedMessages.some(p => p.type === "stageTextAttachmentChunk" && p.requestId === requestId && p.index === index), { requestId: first.requestId, index }, { timeout: 3000 });
   const packet = await page.evaluate(({ requestId, index }) => structuredClone(postedMessages.find(p => p.type === "stageTextAttachmentChunk" && p.requestId === requestId && p.index === index)), { requestId: first.requestId, index });
   assert.equal(packet.totalChunks, first.totalChunks); assert.equal(packet.sessionId, first.sessionId); assert.equal(packet.name, first.name);
   assert.ok(packet.text.length <= 65536, "staging never sends a huge clipboard as one control packet");
   packets.push(packet);
   if (index + 1 < first.totalChunks) await page.evaluate(({ requestId, index }) => host({ type: "textAttachmentChunkAccepted", requestId, index }), { requestId: first.requestId, index });
  }
 }
 for (const packet of packets) assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= CONTROL_LIMIT, "stage control packet is bounded by serialized UTF-8 bytes");
 return { type: first.type, requestId: first.requestId, sessionId: first.sessionId, name: first.name, text: packets.map(p => p.text).join(""), packetCount: packets.length };
}
async function ready(page, stage, exactText, { attach = true } = {}) {
 assert.equal(stage.text, exactText, "staging preserves exact clipboard/input, without trimming or normalizing newlines/NUL/Unicode");
 const bytes = Buffer.from(stage.text, "utf8");
 const path = join(stagedDir, `${runId}-${++stagedCounter}.txt`);
 await writeFile(path, bytes, { mode: 0o600 });
 assert.deepEqual(await readFile(path), Buffer.from(exactText, "utf8"), "trusted-host fixture is a genuine exact UTF-8 file");
 const attachment = { ref: `text-fixture-${runId}-${stagedCounter}`, name: stage.name, byteLength: bytes.length, path };
 const record = { case: currentCase, requestId: stage.requestId, packetCount: stage.packetCount, ...attachment, ...textMetric(stage.text) };
 stagedFiles.push(record);
 await host(page, { type: "textAttachmentStaged", requestId: stage.requestId, attachment });
 if (attach) {
  assert.equal(await chip(page, attachment.ref).count(), 1, "trusted staged file becomes one visible opaque-ref chip");
  assert.equal(await chip(page, attachment.ref).isVisible(), true);
  assert.equal(await chip(page, attachment.ref).locator(".text-file-open").textContent(), stage.name);
  assert.equal(await chip(page, attachment.ref).locator('.text-file-status[role="status"]').count(), 1, "preparing/ready status is semantic, not color only");
  assert.equal(await chip(page, attachment.ref).locator(".text-file-open").isEnabled(), true);
  assert.match(await chip(page, attachment.ref).locator(".text-file-status").textContent(), /bytes|KiB|MiB/, "ready chip shows a meaningful byte size");
 }
 return attachment;
}
async function noPrompt(page, label) { assert.equal((await promptPosts(page)).length, 0, label); }
function validPrompt(prompt, text, attachments) {
 assert.equal(prompt.type, "prompt");
 assert.equal(prompt.payload.text, text, "prompt contains only accompanying inline instructions");
 assert.deepEqual(prompt.payload.textFiles ?? [], attachments.map(a => a.ref), "prompt contains opaque references, not host paths or raw file bodies");
 assert.equal(typeof prompt.payload.clientRequestId, "string");
 assert.equal(prompt.payload.sessionId, SESSION);
 for (const attachment of attachments) assert.equal(JSON.stringify(prompt).includes(attachment.path), false, "raw host paths do not cross the untrusted prompt boundary");
}
const evidence = value => { reports.at(-1).evidence = value; return value; };
async function run(name, test) {
 currentCase = name;
 const page = await browser.newPage({ viewport: { width: 840, height: 760 } });
 page.setDefaultTimeout(3500); page.setDefaultNavigationTimeout(5000);
 const errors = [], network = [], report = { name, pass: false }; reports.push(report);
 page.on("pageerror", error => errors.push(String(error)));
 page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
 await page.route("**/*", route => {
  const url = new URL(route.request().url());
  if (url.origin === `http://127.0.0.1:${server.address().port}` || ["data:", "blob:"].includes(url.protocol)) return route.continue();
  network.push(url.href); return route.abort();
 });
 await page.addInitScript(() => {
  window.__largePasteKeys = [];
  window.addEventListener("keydown", event => {
   if (event.key === "Enter" && event.target?.matches?.(".composer-dock textarea")) window.__largePasteKeys.push({ key: event.key, trusted: event.isTrusted, shift: event.shiftKey });
  }, true);
 });
 try {
  const result = await test(page); if (result !== undefined) report.evidence = result;
  await audit(page, "final transport");
  assert.deepEqual(errors, [], "no webview runtime errors");
  assert.deepEqual(network, [], "fixture cannot make external/daemon/model requests");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no host-message handler errors");
  report.pass = true; console.log(`PASS ${name}`);
 } catch (error) {
  failures++; report.error = error.stack ?? String(error); console.error(`FAIL ${name}\n${report.error}`);
 } finally {
  report.runtimeErrors = errors; report.externalRequests = network;
  // Record failing transport too; reporting never stores megabytes of raw text.
  if (!postChecks.some(p => p.case === name && p.label === "final transport")) await audit(page, "failure transport").catch(error => { report.transportError = String(error); });
  await page.screenshot({ path: join(output, `${report.pass ? "" : "failed-"}${name}.png`) }).catch(() => {});
  const finalState = await page.evaluate(() => ({ text: document.querySelector(".composer-dock textarea")?.value ?? "", chips: [...document.querySelectorAll(".compose-chip")].map(n => ({ className: n.className, ref: n.dataset.ref, requestId: n.dataset.requestId, title: n.title, text: n.textContent })), hint: document.querySelector(".composer-hint.visible")?.textContent, echoes: document.querySelectorAll(".row-user").length, sendDisabled: document.querySelector('.send-btn[title="Send (Enter)"]')?.disabled, keys: window.__largePasteKeys }));
  report.finalState = { ...finalState, text: textMetric(finalState.text) };
  await page.close();
 }
}

try {
 browser = await chromium.launch({ timeout: 15000 });
 await run("01-paste-threshold-and-selected-companion-preserved", async page => {
  await seed(page);
  const short = "s".repeat(PASTE_THRESHOLD - 1), shortPaste = await paste(page, short);
  assert.equal(shortPaste.prevented, false, "31999 UTF-16 plain paste remains inline");
  assert.equal(await input(page).inputValue(), short);
  assert.equal((await stages(page)).length, 0); assert.equal(await page.locator(CHIP).count(), 0);
  const companion = "Before selected companion After";
  await input(page).fill(companion);
  const exact = "😀".repeat(PASTE_THRESHOLD / 2), promotedPaste = await paste(page, exact, [7, 25]);
  assert.equal(exact.length, PASTE_THRESHOLD);
  assert.equal(promotedPaste.prevented, true, "32000 UTF-16, not UTF-8 bytes, promotes to a text file");
  assert.equal(await input(page).inputValue(), companion, "neither preceding nor succeeding companion instructions are absorbed/replaced");
  assert.deepEqual(promotedPaste.afterSelection, promotedPaste.selection, "promotion leaves the existing selection/caret in place");
  const stage = await waitStage(page); await noPrompt(page, "paste never sends automatically");
  const attachment = await ready(page, stage, exact); await noPrompt(page, "stage success still needs explicit Send/Enter");
  await page.locator(SEND).click(); await frames(page); const sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], companion, [attachment]);
  return { shortPaste, promotedPaste, clipboard: textMetric(exact), attachment };
 });

 await run("02-large-paste-pending-native-keys-status-refresh", async page => {
  await seed(page); const companion = "Explain this log, but do not run any commands.";
  await input(page).fill(companion);
  const exact = "  FIRST\r\n" + "Long pasted diagnostics.\n".repeat(12_000) + "LAST\n  ";
  assert.ok(exact.length > INLINE_LIMIT);
  await paste(page, exact); const stage = await waitStage(page);
  assert.equal(await input(page).inputValue(), companion);
  assert.equal(await page.locator(`${CHIP}.preparing`).count(), 1);
  assert.match(await page.locator(`${CHIP} .text-file-status`).textContent(), /prepar/i);
  assert.equal(await page.locator(SEND).isDisabled(), true, "pending stage visibly blocks Send");
  await page.evaluate(selector => document.querySelector(selector).click(), SEND);
  await enter(page); await noPrompt(page, "native disabled Send and trusted Enter cannot send a preparing file");
  await page.evaluate(() => { window.__status = { ...window.__status, streaming: true, usageTotal: 220000 }; host({ type: "status", status: window.__status }); }); await frames(page);
  assert.equal(await input(page).isEnabled(), true, "staging does not lock the editable companion");
  assert.equal(await page.locator(SEND).isDisabled(), true, "routine live status cannot re-enable a pending send");
  await enter(page, "Shift+Enter"); assert.equal(await input(page).inputValue(), companion + "\n", "native newline editing still works while staging");
  await input(page).fill(companion + " Keep the source exact."); await settleDraft(page); await audit(page, "staging drafts");
  const attachment = await ready(page, stage, exact);
  assert.equal(await page.locator(SEND).isEnabled(), true, "ready metadata re-arms Send"); await noPrompt(page, "status/ready never auto-send");
  await enter(page); const sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], companion + " Keep the source exact.", [attachment]);
  return { clipboard: textMetric(exact), packetCount: stage.packetCount, attachment, trustedKeys: await page.evaluate(() => window.__largePasteKeys) };
 });

 await run("03-stage-failure-exact-unicode-nul-crlf-keyboard-retry", async page => {
  await seed(page); const companion = "Inspect the attached mixed-encoding fixture."; await input(page).fill(companion);
  const exact = "  BEGIN\r\n" + "😀 café e\u0301 漢字\t\0\r\n".repeat(2500) + "END\r\n  ";
  await paste(page, exact); const first = await waitStage(page); assert.equal(first.text, exact);
  await host(page, { type: "textAttachmentStaged", requestId: first.requestId, error: "Fixture storage is temporarily unavailable. Retry this text file." });
  assert.equal(await page.locator(`${CHIP}.failed`).count(), 1, "failure stays visible instead of discarding the paste");
  assert.match(await page.locator(`${CHIP}`).getAttribute("title"), /unavailable/i);
  assert.equal(await page.locator(SEND).isDisabled(), true); await enter(page); await noPrompt(page, "failed chip blocks trusted Enter");
  assert.equal(await input(page).inputValue(), companion, "stage failure cannot erase companion text");
  const retry = page.locator(`${CHIP} .text-file-retry`);
  assert.match(await retry.getAttribute("aria-label"), /Retry .*\.txt/); await retry.focus(); await page.keyboard.press("Enter"); await frames(page);
  const second = await waitStage(page, 1); assert.notEqual(second.requestId, first.requestId, "retry has a fresh correlation id");
  assert.equal(second.text, exact, "retry uses retained raw clipboard, not the short composer or a trimmed echo");
  const attachment = await ready(page, second, exact);
  await enter(page); const sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], companion, [attachment]);
  return { clipboard: textMetric(exact), attempts: [first.requestId, second.requestId], attachment };
 });

 await run("04-stale-stage-ack-cannot-attach-after-navigation", async page => {
  await seed(page); await input(page).fill("Thread A companion");
  const exact = "Thread A private paste.\n".repeat(2500); await paste(page, exact); const stage = await waitStage(page);
  await page.evaluate(sessionId => { window.__status = { ...window.__status, sessionId, sessionName: "Thread B" }; host({ type: "snapshot", messages: [], state: null, status: window.__status }); host({ type: "draft", text: "Thread B draft stays mine" }); }, NEXT_SESSION); await frames(page);
  assert.equal(await page.locator(CHIP).count(), 0, "navigation drops outgoing staged/pending chips");
  const attachment = await ready(page, stage, exact, { attach: false });
  assert.equal(await page.locator(CHIP).count(), 0, "late trusted host reply cannot attach another thread's file");
  assert.equal(await input(page).inputValue(), "Thread B draft stays mine"); await noPrompt(page, "late stage acknowledgment never sends");
  await enter(page); const sent = await promptPosts(page); assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.sessionId, NEXT_SESSION); assert.equal(sent[0].payload.text, "Thread B draft stays mine"); assert.deepEqual(sent[0].payload.textFiles ?? [], []);
  return { originatingSession: stage.sessionId, displayedSession: NEXT_SESSION, discardedAttachment: attachment };
 });

 await run("05-send-time-huge-input-stages-before-second-enter", async page => {
  await seed(page);
  const exact = "  " + "M".repeat(INLINE_LIMIT - 1) + "\n  "; assert.ok(exact.length > INLINE_LIMIT);
  // Bypass the normal input event on purpose: this simulates host/programmatic
  // text that reaches the textarea without the early input-time conversion.
  await page.evaluate(({ selector, text }) => { document.querySelector(selector).value = text; }, { selector: TEXTAREA, text: exact });
  assert.equal((await stages(page)).length, 0, "fixture reaches the send-time fallback, not input-time conversion");
  await settleDraft(page); await audit(page, "oversized manual draft");
  await enter(page); const stage = await waitStage(page);
  assert.equal(stage.text, exact, "send-time conversion captures exact untrimmed textarea");
  assert.equal(await input(page).inputValue(), "", "whole oversized input becomes visible file context");
  assert.equal(await page.locator(`${CHIP}.preparing`).count(), 1); await noPrompt(page, "first Enter only prepares; no invalid inline prompt");
  const attachment = await ready(page, stage, exact); await noPrompt(page, "host ready does not send on the operator's behalf");
  await input(page).fill("Summarize this exact manual input."); await enter(page);
  const sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], "Summarize this exact manual input.", [attachment]);
  return { input: textMetric(exact), attachment };
 });

 await run("06-inline-200000-boundary-and-unsafe-draft-guard", async page => {
  await seed(page); const boundary = "B".repeat(INLINE_LIMIT);
  await input(page).fill(boundary); await settleDraft(page);
  assert.ok((await messagesOf(page, "draftChanged")).some(p => p.text === boundary), "200000 UTF-16 draft remains legal inline");
  assert.equal((await stages(page)).length, 0); await enter(page);
  const sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], boundary, []);
  await host(page, { type: "promptRejected", clientRequestId: sent[0].payload.clientRequestId, error: "Fixture rejection at the inline boundary" });
  assert.equal(await input(page).inputValue(), boundary, "boundary rejection restores text and clears its local echo"); assert.equal(await page.locator(".row-user").count(), 0);
  const oversized = boundary + "!"; await input(page).fill(oversized); await settleDraft(page); await audit(page, "200001 draft suppressed");
  const oversizedStage = await waitStage(page), oversizedAttachment = await ready(page, oversizedStage, oversized);
  assert.equal(await input(page).inputValue(), "", "unsafe input is retained as visible exact file context, not lost or sent");
  assert.equal((await promptPosts(page)).length, 1, "input-time conversion cannot send on its own");
  const nulInput = "A\0B";
  await page.evaluate(({ selector, text }) => { const textarea = document.querySelector(selector); textarea.value = text; textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); }, { selector: TEXTAREA, text: nulInput });
  await settleDraft(page); await audit(page, "NUL draft suppressed");
  const nulStage = await waitStage(page, 1), nulAttachment = await ready(page, nulStage, nulInput);
  assert.equal(await input(page).inputValue(), ""); assert.equal(await page.locator(CHIP).count(), 2, "NUL input is retained separately, not grafted into invalid draft transport");
  return { boundary: textMetric(boundary), oversized: textMetric(oversized), nulInput: textMetric(nulInput), attachments: [oversizedAttachment, nulAttachment] };
 });

 await run("07-text-only-model-file-only-reject-restore-and-accept", async page => {
  await seed(page); assert.match(await page.locator(".rail-pill.model").getAttribute("title"), /text-only/);
  const exact = "tiny\0😀\r\n"; assert.ok(exact.length < PASTE_THRESHOLD);
  const pasted = await paste(page, exact); assert.equal(pasted.prevented, true, "even a small NUL-containing paste is file context");
  const stage = await waitStage(page), attachment = await ready(page, stage, exact);
  assert.equal(await input(page).inputValue(), ""); assert.equal(await page.locator(SEND).isEnabled(), true, "text-only model accepts text files without a vision gate");
  await enter(page); let sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], "", [attachment]);
  assert.equal(await page.locator(CHIP).count(), 0, "file-only send clears composer chip");
  const echoCount = await page.locator(".row-user").count();
  await host(page, { type: "promptRejected", clientRequestId: sent[0].payload.clientRequestId, error: "Fixture file-only refusal" });
  assert.equal(await chip(page, attachment.ref).count(), 1, "file-only rejected send restores its retained attachment even without a text echo");
  assert.equal(await input(page).inputValue(), ""); assert.equal(await page.locator(".row-user").count(), 0, "rejected local echo is not left pending");
  await enter(page); sent = await promptPosts(page); assert.equal(sent.length, 2); validPrompt(sent[1], "", [attachment]);
  await host(page, { type: "promptAccepted", clientRequestId: sent[1].payload.clientRequestId });
  await host(page, { type: "promptRejected", clientRequestId: sent[1].payload.clientRequestId, error: "Late verdict for an already accepted fixture" });
  assert.equal(await page.locator(CHIP).count(), 0, "accepted file-only payload is no longer retained for late restoration");
  return { pasted, clipboard: textMetric(exact), attachment, initialEchoCount: echoCount };
 });

 await run("08-rejection-restores-all-context-not-intervening-draft", async page => {
  await seed(page, { vision: true }); const companion = "Review these diagnostics, image and selected lines."; await input(page).fill(companion);
  const selection = { path: "/fixture/selected.ts", startLine: 3, endLine: 4, text: "const chosen = 1;\nreturn chosen;", languageId: "typescript" };
  await host(page, { type: "insertSelection", selection });
  await page.locator('.composer-rail .icon-btn[title^="Attach"]').click();
  await page.locator(".dropdown-item").filter({ hasText: /^Image/ }).click();
  const imageRequest = (await messagesOf(page, "pickImage")).at(-1); assert.equal(typeof imageRequest?.requestId, "number");
  const image = { mimeType: "image/png", name: "fixture.png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6uUAAAAASUVORK5CYII=" };
  await host(page, { type: "imagePicked", requestId: imageRequest.requestId, images: [image] });
  const exact = "Diagnostic line\n".repeat(2300); await paste(page, exact); const stage = await waitStage(page), attachment = await ready(page, stage, exact);
  const originalChips = await page.locator(".compose-chip").count(); assert.equal(originalChips, 3);
  await enter(page); let sent = await promptPosts(page); assert.equal(sent.length, 1); validPrompt(sent[0], companion, [attachment]);
  assert.deepEqual(sent[0].payload.images, [image]); assert.deepEqual(sent[0].payload.selections, [selection]); assert.equal(await page.locator(".row-user").count(), 1);
  await host(page, { type: "promptRejected", clientRequestId: sent[0].payload.clientRequestId, error: "Fixture controller.prompt failure" });
  assert.equal(await input(page).inputValue(), companion); assert.equal(await page.locator(".compose-chip").count(), originalChips); assert.equal(await chip(page, attachment.ref).count(), 1);
  assert.equal(await page.locator(".row-user").count(), 0, "rejected local echo clears immediately");
  await enter(page); sent = await promptPosts(page); assert.equal(sent.length, 2); validPrompt(sent[1], companion, [attachment]);
  assert.deepEqual(sent[1].payload.images, [image]); assert.deepEqual(sent[1].payload.selections, [selection]);
  const intervening = "This newer draft is mine. Do not replace it."; await input(page).fill(intervening);
  await host(page, { type: "promptRejected", clientRequestId: sent[1].payload.clientRequestId, error: "Later fixture refusal" });
  assert.equal(await input(page).inputValue(), intervening, "a delayed rejection cannot overwrite intervening user input");
  assert.equal(await page.locator(".compose-chip").count(), 0, "old attachments are not grafted onto a newer draft"); assert.equal(await page.locator(".row-user").count(), 0);
  return { attachment, restoredChipCount: originalChips, interveningDraft: textMetric(intervening), requests: sent.map(p => p.payload.clientRequestId) };
 });

 await run("09-remove-releases-ref-four-files-and-utf8-total-cap", async page => {
  await seed(page); const companion = "Keep these independent file contexts."; await input(page).fill(companion);
  const attachments = []; let ordinal = 0;
  for (let index = 0; index < FILE_COUNT; index++) {
   const exact = `${index}:` + "x".repeat(PASTE_THRESHOLD);
   await paste(page, exact); const stage = await waitStage(page, ordinal++); attachments.push(await ready(page, stage, exact));
  }
  assert.equal(await page.locator(CHIP).count(), FILE_COUNT);
  const extra = "refused fifth file\n".repeat(2000), countRefusal = await paste(page, extra);
  assert.equal(countRefusal.prevented, true); assert.equal((await stages(page)).length, FILE_COUNT, "fifth file is not staged");
  assert.equal(await page.locator(CHIP).count(), FILE_COUNT); assert.equal(await input(page).inputValue(), companion);
  assert.match(await page.locator(".composer-hint.visible").textContent(), /4 text files.*8 MiB|maximum 4/i);
  const remove = chip(page, attachments[0].ref).locator(".chip-remove"); assert.match(await remove.getAttribute("aria-label"), /Remove .*\.txt/);
  await remove.focus(); await page.keyboard.press("Enter"); await frames(page);
  assert.deepEqual((await messagesOf(page, "releaseTextAttachment")).map(p => p.ref), [attachments[0].ref], "native Remove releases exactly the opaque owned ref");
  const replacement = "r".repeat(PASTE_THRESHOLD); await paste(page, replacement); const replacementStage = await waitStage(page, ordinal++); const replacementAttachment = await ready(page, replacementStage, replacement);
  assert.equal(await page.locator(CHIP).count(), FILE_COUNT, "removed capacity is reusable");
  while (await page.locator(CHIP).count()) await page.locator(`${CHIP} .chip-remove`).first().click();
  const released = (await messagesOf(page, "releaseTextAttachment")).map(p => p.ref);
  assert.deepEqual([...released].sort(), [...attachments, replacementAttachment].map(a => a.ref).sort()); assert.equal(new Set(released).size, released.length, "each removed ref is released once");
  const half = "😀".repeat(FILE_LIMIT / 8); assert.equal(Buffer.byteLength(half), FILE_LIMIT / 2, "UTF-8 budget is not a UTF-16 character budget");
  const totals = [];
  for (let index = 0; index < 2; index++) { await paste(page, half); const stage = await waitStage(page, ordinal++); totals.push(await ready(page, stage, half)); }
  assert.equal(totals.reduce((sum, file) => sum + file.byteLength, 0), FILE_LIMIT, "exact 8 MiB total is legal");
  const stagesBefore = (await stages(page)).length, totalRefusal = await paste(page, "\0");
  assert.equal(totalRefusal.prevented, true); assert.equal((await stages(page)).length, stagesBefore, "even one extra UTF-8 byte is refused before staging");
  assert.equal(await page.locator(CHIP).count(), 2); assert.equal(await input(page).inputValue(), companion);
  assert.match(await page.locator(".composer-hint.visible").textContent(), /8 MiB.*UTF-8|UTF-8.*8 MiB/);
  await chip(page, totals[0].ref).locator(".chip-remove").click(); await paste(page, "\0"); const recoveredStage = await waitStage(page, ordinal++), recovered = await ready(page, recoveredStage, "\0");
  assert.equal(await page.locator(CHIP).count(), 2, "released aggregate capacity can be used immediately"); await noPrompt(page, "caps/removal never send automatically");
  return { countRefusal, totalRefusal, released, totalByteLimit: FILE_LIMIT, totalAttachments: totals, recovered };
 });

 await run("10-over-8mib-smoke-preserves-input-no-invalid-transport", async page => {
  await seed(page); const companion = "Current short draft must survive a refused clipboard."; await input(page).fill(companion);
  const exact = "é".repeat(FILE_LIMIT / 2 + 1); assert.equal(Buffer.byteLength(exact), FILE_LIMIT + 2);
  const refused = await paste(page, exact);
  assert.equal(refused.prevented, true, "oversized paste does not dump megabytes into the textarea"); assert.equal(await input(page).inputValue(), companion);
  assert.equal((await stages(page)).length, 0); assert.equal(await page.locator(CHIP).count(), 0);
  assert.match(await page.locator(".composer-hint.visible").textContent(), /8 MiB.*UTF-8|UTF-8.*8 MiB/);
  // Assign a manual-input fixture directly to avoid a multi-megabyte native
  // clipboard insertion; the real input handler and trusted Enter still run.
  await page.evaluate(({ selector, text }) => { const textarea = document.querySelector(selector); textarea.value = text; textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); }, { selector: TEXTAREA, text: exact });
  await settleDraft(page); await enter(page);
  assert.equal(await input(page).inputValue(), exact, "send-time 8 MiB refusal preserves the exact editable input");
  assert.equal((await stages(page)).length, 0); assert.equal(await page.locator(CHIP).count(), 0); await noPrompt(page, "over-limit input cannot emit a generic-invalid prompt or optimistic echo");
  assert.equal(await page.locator(".row-user").count(), 0); await audit(page, "over-8MiB smoke");
  return { refusedPaste: refused, retainedInput: textMetric(exact) };
 });
} finally {
 const testHashAfter = sha256(await readFile(testPath)), sourceHashesAfter = {};
 for (const path of sourceCache.keys()) sourceHashesAfter[relative(root, path)] = sha256(await readSource(path));
 const frozen = testHashBefore === testHashAfter && Object.keys(sourceHashesBefore).every(path => sourceHashesBefore[path] === sourceHashesAfter[path]);
 if (!frozen) { failures++; console.error("FAIL frozen test/source hashes changed during this run"); }
 const manifest = { sourceRef: sourceRef ?? null, testHashBefore, testHashAfter, frozen, bundleHash: sha256(bundle.outputFiles[0].contents), sourceHashesBefore, sourceHashesAfter };
 await writeFile(join(output, "source-manifest.json"), JSON.stringify(manifest, null, 2));
 await writeFile(join(output, "results.json"), JSON.stringify({ ...manifest, testHash: testHashBefore, cases: reports.length, failures, reports, postChecks, stagedFiles }, null, 2));
 await browser?.close(); await new Promise(resolve => server.close(resolve));
}
console.log(`\n${reports.filter(r => r.pass).length}/${reports.length} large-paste browser cases passing (${sourceRef ?? "current source"})`);
console.log(`Test SHA256 ${testHashBefore}\nArtifacts ${output}`);
process.exitCode = failures ? 1 : 0;
