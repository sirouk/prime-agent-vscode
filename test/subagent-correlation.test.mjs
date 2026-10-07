/**
 * Subagent card/tree/current-view correlation in real Chromium.
 * All TypeScript and normal preview HTML/CSS are bundled/read in memory.
 * No generated assets, daemon, RPC worker, agent/model call, or userFocus post.
 *
 * Current:  node test/subagent-correlation.test.mjs
 * Baseline: SOURCE_REF=v1.0.50 node test/subagent-correlation.test.mjs
 * Artifacts: /tmp/prime-subagent-correlation/{current|source-ref}/
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { relative, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRef = process.env.SOURCE_REF ?? process.env.SUBAGENT_CORRELATION_SOURCE_REF;
const output = process.env.SUBAGENT_CORRELATION_OUTPUT ?? join("/tmp/prime-subagent-correlation", sourceRef ? sourceRef.replace(/[^a-z0-9_.-]/gi, "_") : "current");
const exec = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = {};
const sourceCache = new Map();
async function source(path) {
 if (!sourceCache.has(path)) sourceCache.set(path, (async () => {
  const bytes = sourceRef
   ? Buffer.from((await exec("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout)
   : await readFile(path);
  sourceHashes[relative(root, path)] = sha256(bytes);
  return bytes;
 })());
 return sourceCache.get(path);
}
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("subagent-correlation-test") },
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
await mkdir(output, { recursive: true });
const testHash = sha256(await readFile(fileURLToPath(import.meta.url)));
const reports = [], postChecks = [];
let browser, failures = 0, currentCase = "";
const T0 = Date.parse("2026-10-01T10:00:00Z");
const SESSION = "01a11351-bbf4-7594-9f5a-2a6d8fdd1ca6";
const UUIDS = [
 "01a1166a-7654-7784-844a-1a2e84988deb", "01a11667-2864-7cd2-83d1-9212b4680d40",
 "01a1165c-bb63-7300-b424-d11b1a2d31c0", "01a115ff-cc14-7a43-9c19-40a1b96efdd0",
 "01a1148b-72a1-7493-8361-e12b44edaa31", "01a11299-4b65-73cb-b6a2-0a43a5cd3f21",
];
function agent(index, patch = {}) {
 return { id: `sub-fixture-${index}`, activeSessionId: `livehandle${String(index).padStart(2, "0")}`,
  sessionId: UUIDS[index], browseRef: `opaque-capability-${index}-initial`, name: ["Verifier", "Navigator", "Scribe", "Researcher", "Reviewer", "Legacy worker"][index],
  runtimeKind: "subagent", rlmDepth: 1, created: new Date(T0 + 1_000_000 + index * 1000).toISOString(),
  status: "running", isStreaming: true, attachedClients: 0, ...patch };
}
const ROOT_AGENT = { id: SESSION, sessionId: SESSION, activeSessionId: "parenthandle", name: "Parent fixture", runtimeKind: "root", status: "idle" };
function history(count = 24) {
 return Array.from({ length: count }, (_, i) => i % 2
  ? { role: "assistant", timestamp: T0 + i * 10_000, stopReason: "stop", content: [{ type: "text", text: `Earlier reply ${i}. ` + "Stable transcript words for a detached reader. ".repeat(12) }] }
  : { role: "user", timestamp: T0 + i * 10_000, content: `Earlier prompt ${i}` });
}
const frames = (page, count = 4) => page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, count);
async function snapshot(page, messages = history(), status = {}) {
 await page.evaluate(({ messages, status, sessionId }) => {
  window.__messages = structuredClone(messages);
  window.__status = { ...baseStatus, sessionId, sessionName: "Parent fixture", ...status };
  host({ type: "snapshot", messages: window.__messages, state: null, status: window.__status });
 }, { messages, status, sessionId: SESSION });
 await frames(page);
}
async function seed(page, messages = history(), status = {}) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await snapshot(page, messages, status);
 await page.waitForSelector(".boot-splash", { state: "detached" });
}
async function roster(page, children, { announce = false, spawned, ...context } = {}) {
 const announcements = spawned ?? (announce ? children.map(({ activeSessionId, sessionId, browseRef, name, created }) => ({ activeSessionId, sessionId, browseRef, name, created })) : []);
 await page.evaluate(message => host(message), { type: "sessionChildren", children, spawned: announcements, ...context });
 await frames(page);
}
const card = (page, name) => page.locator(".spawned-card").filter({ has: page.locator(".spawned-label", { hasText: name }) });
const row = (page, name) => page.locator(".subagent-row").filter({ has: page.locator(".subagent-name", { hasText: name }) });
async function showTree(page) {
 if (await page.locator(".subagent-row").count() === 0) await page.locator(".subagents-header").click();
 const historical = page.locator(".subagents-subhead");
 if (await historical.count() && await page.locator(".subagents-list.historical .subagent-row").count() === 0) await historical.click();
 await frames(page);
}
const clearPosts = page => page.evaluate(() => { postedMessages.length = 0; });
async function onlyBrowse(page, browseRef, label) {
 const posts = await page.evaluate(() => structuredClone(postedMessages));
 postChecks.push({ case: currentCase, label, posts });
 assert.deepEqual(posts, [{ type: "browseChild", browseRef }], `${label}: exactly one current opaque capability, no raw ID, userFocus, or prompt`);
}
async function noPosts(page, label) {
 const posts = await page.evaluate(() => structuredClone(postedMessages));
 postChecks.push({ case: currentCase, label, posts });
 assert.deepEqual(posts, [], label);
}
async function identity(locator, swatchSelector) {
 return locator.evaluate((node, swatchSelector) => {
  const swatch = node.querySelector(swatchSelector);
  return { key: node.dataset.agentKey ?? null, dark: node.style.getPropertyValue("--agent-color-dark"), light: node.style.getPropertyValue("--agent-color-light"),
   color: getComputedStyle(node).getPropertyValue("--agent-color").trim(), swatch: swatch ? getComputedStyle(swatch).backgroundColor : null };
 }, swatchSelector);
}
function identified(value, key, label) {
 assert.equal(value.key, key, `${label}: canonical display identity`);
 assert.ok(value.dark && value.light && value.color && value.swatch, `${label}: theme-aware, visible identity accent`);
}
async function palettes(page) {
 return page.locator(".spawned-card").evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.agentKey ?? "missing", {
  dark: node.style.getPropertyValue("--agent-color-dark"), light: node.style.getPropertyValue("--agent-color-light"),
  swatch: getComputedStyle(node.querySelector(".spawned-dot")).backgroundColor,
 }])));
}
async function run(name, test) {
 currentCase = name;
 const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
 page.setDefaultTimeout(3500);
 const errors = [];
 page.on("pageerror", error => errors.push(String(error)));
 page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
 const report = { name, pass: false };
 reports.push(report);
 try {
  report.evidence = await test(page);
  assert.deepEqual(errors, [], "no webview errors");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no host message handler errors");
  report.pass = true;
  console.log(`PASS ${name}`);
 } catch (error) {
  failures++;
  report.error = error.stack ?? String(error);
  console.error(`FAIL ${name}\n${report.error}`);
 } finally {
  report.runtimeErrors = errors;
  await page.screenshot({ path: join(output, `${report.pass ? "" : "failed-"}${name}.png`) }).catch(() => {});
  report.finalDOM = await page.evaluate(() => ({
   cards: [...document.querySelectorAll(".spawned-card")].map(c => ({ tag: c.tagName, key: c.dataset.agentKey, disabled: c.disabled, text: c.textContent })),
   tree: document.querySelector(".subagents-strip")?.textContent,
   headerKey: document.querySelector(".session-title-wrap")?.dataset.agentKey,
   scroll: (() => { const e = document.querySelector(".messages"); return e && { top: e.scrollTop, max: e.scrollHeight - e.clientHeight }; })(),
  })).catch(() => null);
  await page.close();
 }
}

// Decode browser-resolved CSS colors (including color-mix) and composite alpha
// through real ancestors. This measures visible pixels, not palette constants.
async function visualMetrics(page) {
 return page.evaluate(() => {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
  const blend = (front, back, opacity = 1) => {
   const alpha = front[3] / 255 * opacity;
   return front.slice(0, 3).map((v, i) => v * alpha + back[i] * (1 - alpha));
  };
  const surface = node => {
   const ancestors = []; for (let n = node; n; n = n.parentElement) ancestors.unshift(n);
   return ancestors.reduce((background, n) => blend(rgba(getComputedStyle(n).backgroundColor), background), [255, 255, 255]);
  };
  const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const swatches = [...document.querySelectorAll(".spawned-dot, .subagent-identity, .session-agent-mark")].filter(n => n.getBoundingClientRect().width > 0).map(n => {
   const style = getComputedStyle(n), bg = surface(n.parentElement), foreground = blend(rgba(style.backgroundColor), bg, Number(style.opacity));
   return { selector: n.className, key: n.closest("[data-agent-key]")?.dataset.agentKey, color: style.backgroundColor, background: bg, contrast: ratio(foreground, bg), width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height };
  });
  const focused = document.activeElement, focusStyle = getComputedStyle(focused), focusSurface = surface(focused);
  const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
  const messages = document.querySelector(".messages"), strip = document.querySelector(".subagents-strip");
  return { width: innerWidth, rootWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
   messages: { width: messages.clientWidth, scrollWidth: messages.scrollWidth, ...bounds(messages) },
   strip: { width: strip.clientWidth, scrollWidth: strip.scrollWidth, ...bounds(strip) },
   cards: [...document.querySelectorAll(".spawned-card")].map(bounds), rows: [...document.querySelectorAll(".subagent-row")].map(bounds), swatches,
   focus: { card: focused.classList.contains("spawned-card"), visible: focused.matches(":focus-visible"), style: focusStyle.outlineStyle, width: parseFloat(focusStyle.outlineWidth), color: focusStyle.outlineColor, contrast: ratio(blend(rgba(focusStyle.outlineColor), focusSurface), focusSurface) } };
 });
}

try {
 browser = await chromium.launch();
 await run("01-explicit-card-opens-tree-and-historical-stream", async page => {
  await seed(page, history(8));
  const active = agent(0), finished = agent(1, { status: "inactive", isStreaming: false });
  await roster(page, [active, finished], { announce: true });
  assert.equal(await page.locator(".subagent-row").count(), 0, "initial roster seeds cards without opening the tree");
  await page.evaluate(() => host({ type: "draft", text: "Unsent draft must not become a prompt" }));
  await clearPosts(page);
  await card(page, active.name).locator(".spawned-label").click(); await frames(page);
  await onlyBrowse(page, active.browseRef, "full message label click");
  assert.equal(await row(page, active.name).isVisible(), true, "full-card click expands Subagents");
  assert.equal(await page.locator("textarea").inputValue(), "Unsent draft must not become a prompt");
  await page.locator(".subagents-header").click();
  const ended = { ...active, status: "inactive", isStreaming: false, browseRef: "opaque-capability-finished-current" };
  const newWorker = agent(2);
  await roster(page, [ended, finished, newWorker], { spawned: [{ activeSessionId: newWorker.activeSessionId, sessionId: newWorker.sessionId, name: newWorker.name, created: newWorker.created }] });
  assert.equal(await page.locator(".subagent-row").count(), 0, "manual suppression survives genuine new activity");
  await clearPosts(page);
  await card(page, ended.name).locator(".spawned-label").click(); await frames(page);
  await onlyBrowse(page, ended.browseRef, "explicit finished-card click overrides suppression");
  assert.equal(await page.locator(".subagents-list.historical .subagent-row").count(), 2, "finished target opens Historical as well as Subagents");
  await page.locator(".subagents-subhead").click();
  await clearPosts(page);
  await card(page, ended.name).locator(".spawned-view").click(); await frames(page);
  await onlyBrowse(page, ended.browseRef, "view text is part of the same full-card action");
  assert.equal(await row(page, ended.name).isVisible(), true, "explicit action reopens a manually folded Historical group");
  // Simulate the normal host-confirmed attach, followed by a live child event.
  await snapshot(page, [{ role: "assistant", timestamp: T0 + 2_000_000, stopReason: "stop", content: [{ type: "text", text: "Matching child stream history" }] }], { sessionId: ended.sessionId, sessionName: ended.name, streaming: true });
  await roster(page, [], { parent: ROOT_AGENT, siblings: [ended, finished, newWorker], viewedActiveSessionId: ended.activeSessionId, viewedSession: { ...ended, browseRef: undefined } });
  await page.evaluate(timestamp => host({ type: "event", event: { type: "message_start", message: { role: "assistant", timestamp, responseId: "matching-child-stream", content: [{ type: "text", text: "Fresh output from the matching child stream" }] } } }), T0 + 2_001_000);
  await frames(page);
  assert.equal(await page.getByText("Fresh output from the matching child stream", { exact: true }).count(), 1);
  assert.equal(await row(page, ended.name).isVisible(), true, "matching child remains visible after host navigation");
  const posts = await page.evaluate(() => postedMessages);
  assert.equal(posts.filter(m => m.type === "browseChild").length, 1, "host response does not emit another browse");
  assert.equal(posts.some(m => ["userFocus", "prompt"].includes(m.type)), false);
  return { finalViewedName: ended.name, finalBrowseRef: ended.browseRef };
 });

 await run("02-native-full-card-enter-space-single-action", async page => {
  await seed(page, history(6)); const child = agent(0);
  await roster(page, [child], { announce: true });
  const target = card(page, child.name);
  assert.equal(await target.evaluate(n => n.tagName), "BUTTON", "the whole spawned message is a native button");
  assert.equal(await target.getAttribute("type"), "button");
  assert.equal(await target.locator("button, [role=button]").count(), 0, "no nested buttons or duplicate keyboard action");
  assert.equal(await target.locator(".spawned-view").evaluate(n => n.tagName), "SPAN");
  assert.equal(await page.getByRole("button", { name: new RegExp(`Open subagent ${child.name}`) }).count(), 1, "native accessible name describes the action and matching child");
  for (const key of ["Enter", "Space"]) {
   if (await page.locator(".subagent-row").count()) await page.locator(".subagents-header").click();
   await clearPosts(page); await target.focus(); await target.press(key); await frames(page);
   await onlyBrowse(page, child.browseRef, `native ${key}`);
   assert.equal(await row(page, child.name).isVisible(), true, `${key} explicitly opens the tree`);
  }
  return { nativeButton: true, keys: ["Enter", "Space"] };
 });

 await run("03-mounted-card-refreshes-name-and-current-capability", async page => {
  await seed(page); const child = agent(0);
  await roster(page, [child], { announce: true });
  const before = await identity(card(page, child.name), ".spawned-dot"); identified(before, child.sessionId, "spawn card");
  await page.evaluate(() => { window.__card = document.querySelector(".spawned-card"); window.__parts = [...window.__card.children]; });
  const renamed = { ...child, name: "Renamed verifier", status: "idle", isStreaming: false, browseRef: "opaque-new-current-reference" };
  await roster(page, [renamed]);
  assert.equal(await page.evaluate(() => window.__card === document.querySelector(".spawned-card") && window.__card.isConnected && window.__parts.every((part, i) => part === window.__card.children[i])), true, "roster patches the existing card and all its parts");
  assert.ok((await card(page, renamed.name).textContent()).includes(renamed.name));
  assert.deepEqual(await identity(card(page, renamed.name), ".spawned-dot"), before, "rename/status leave identity color unchanged");
  await clearPosts(page); await card(page, renamed.name).click(); await frames(page);
  await onlyBrowse(page, renamed.browseRef, "refreshed mounted-card action");
  assert.equal(await row(page, renamed.name).locator(".subagent-badge").textContent(), "idle");
  const withoutCanonical = { ...renamed, sessionId: undefined, browseRef: "opaque-known-uuid-omitted-reference" };
  await roster(page, [withoutCanonical]);
  assert.deepEqual(await identity(card(page, renamed.name), ".spawned-dot"), before, "temporary UUID omission retains the known canonical card identity");
  assert.deepEqual(await identity(row(page, renamed.name), ".subagent-identity"), before, "current tree retains the same known identity when the optional UUID is omitted");
  await clearPosts(page); await card(page, renamed.name).click(); await frames(page);
  await onlyBrowse(page, withoutCanonical.browseRef, "display alias cannot replace the current roster capability");
  const latest = { ...renamed, browseRef: "opaque-third-current-reference" };
  await roster(page, [latest], { spawned: [{ activeSessionId: latest.activeSessionId, sessionId: latest.sessionId, browseRef: child.browseRef, name: "Stale announcement name", created: latest.created }] });
  assert.equal(await page.locator(".spawned-card").count(), 1);
  assert.equal(await card(page, latest.name).count(), 1, "current roster name outranks a stale announcement");
  await clearPosts(page); await card(page, latest.name).locator(".spawned-view").click(); await frames(page);
  await onlyBrowse(page, latest.browseRef, "current roster capability outranks stale spawned delta");
  const replacement = agent(1, { activeSessionId: latest.activeSessionId, name: "Replacement using a reused handle", browseRef: "opaque-reused-handle-new-identity", status: "idle", isStreaming: false });
  await roster(page, [replacement]);
  assert.equal(await card(page, latest.name).isDisabled(), true, "a reused active handle cannot retarget an old canonical card");
  assert.deepEqual(await identity(card(page, latest.name), ".spawned-dot"), before, "contradictory canonical UUID does not change old card identity");
  await clearPosts(page); await card(page, latest.name).evaluate(n => n.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await noPosts(page, "old card fails closed when a new UUID reuses its daemon handle");
  await roster(page, [replacement], { announce: true });
  assert.equal(await page.locator(".spawned-card").count(), 2, "new canonical identity gets its own announced card");
  assert.equal(await card(page, latest.name).isDisabled(), true);
  identified(await identity(card(page, replacement.name), ".spawned-dot"), replacement.sessionId, "replacement identity");
  await clearPosts(page); await card(page, replacement.name).click(); await frames(page);
  await onlyBrowse(page, replacement.browseRef, "only the new identity card can browse the replacement");
  const replacementIdentity = await identity(card(page, replacement.name), ".spawned-dot");
  for (let refresh = 0; refresh < 2; refresh++) {
   const omittedReplacement = { ...replacement, sessionId: undefined, browseRef: `opaque-replacement-uuid-omitted-${refresh}` };
   await roster(page, [omittedReplacement], { announce: true });
   assert.equal(await card(page, latest.name).isDisabled(), true, "old UUID card stays unavailable when the replacement later omits its UUID");
   assert.equal(await page.locator(".spawned-card").count(), 2, "display alias never duplicates or retargets either canonical card");
   assert.deepEqual(await identity(card(page, latest.name), ".spawned-dot"), before);
   assert.deepEqual(await identity(card(page, replacement.name), ".spawned-dot"), replacementIdentity);
   assert.deepEqual(await identity(row(page, replacement.name), ".subagent-identity"), replacementIdentity, "replacement tree agrees with the known current canonical alias");
   await clearPosts(page); await card(page, replacement.name).click(); await frames(page);
   await onlyBrowse(page, omittedReplacement.browseRef, "UUID omission still uses only the fresh replacement capability");
  }
  return { before, currentReference: latest.browseRef, mounted: true, reusedHandleFailsClosed: true };
 });

 await run("04-unavailable-and-expired-card-reenable-in-place", async page => {
  await seed(page); const child = agent(0); await roster(page, [child], { announce: true });
  const before = await identity(card(page, child.name), ".spawned-dot");
  await page.evaluate(() => { window.__unavailableCard = document.querySelector(".spawned-card"); });
  await roster(page, []);
  assert.equal(await page.locator(".spawned-card").isDisabled(), true, "disappeared child invalidates its old capability");
  await clearPosts(page);
  await page.locator(".spawned-card").evaluate(n => { n.click(); n.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await noPosts(page, "unavailable card cannot browse through a cached reference");
  await roster(page, [], { spawned: [{ activeSessionId: child.activeSessionId, sessionId: child.sessionId, browseRef: child.browseRef, name: child.name, created: child.created }] });
  assert.equal(await page.locator(".spawned-card").isDisabled(), true, "standalone spawn delta is not current navigation authority");
  const expired = { ...child, status: "inactive", isStreaming: false, browseRef: undefined };
  await roster(page, [expired]);
  assert.equal(await page.locator(".spawned-card").isDisabled(), true, "present child without a current capability is also unavailable");
  await clearPosts(page); await page.locator(".spawned-card").evaluate(n => n.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await noPosts(page, "expired capability does not post raw IDs or an old browseRef");
  const restored = { ...child, name: "Restored verifier", status: "idle", isStreaming: false, browseRef: "opaque-restored-current-reference" };
  await roster(page, [restored]);
  assert.equal(await page.locator(".spawned-card").isEnabled(), true, "a new current capability reenables the card");
  assert.equal(await page.evaluate(() => window.__unavailableCard === document.querySelector(".spawned-card") && window.__unavailableCard.isConnected), true);
  assert.deepEqual(await identity(card(page, restored.name), ".spawned-dot"), before);
  await clearPosts(page); await card(page, restored.name).click(); await frames(page);
  await onlyBrowse(page, restored.browseRef, "reenabled card uses only the restored current capability");
  return { identity: before, disabledWithoutAuthority: true, restoredRef: restored.browseRef };
 });

 await run("05-passivation-rename-reorder-resume-reload-stable-palette", async page => {
  await seed(page);
  const children = UUIDS.map((_, i) => agent(i, i === 5 ? { sessionId: undefined } : {}));
  await roster(page, children, { announce: true });
  assert.equal(await page.locator(".spawned-card").count(), children.length);
  const before = await palettes(page);
  assert.equal(Object.keys(before).length, children.length, "each card has an identity key");
  for (const child of children) identified(await identity(card(page, child.name), ".spawned-dot"), child.sessionId ?? child.activeSessionId, child.name);
  assert.equal(new Set(children.slice(0, 4).map(child => before[child.sessionId].swatch)).size, 4, "four fixed, differently named identities have distinct samples (not a universal collision claim)");
  await page.evaluate(() => { window.__passivatingCard = [...document.querySelectorAll(".spawned-card")].find(n => n.textContent.includes("Verifier")); });
  const passivated = children.map((child, i) => ({ ...child, name: `Renamed worker ${i}`, browseRef: `opaque-after-reorder-${i}`, ...(i === 0 ? { id: child.sessionId, activeSessionId: child.sessionId, status: "inactive", isStreaming: false } : { status: i % 2 ? "idle" : "running", isStreaming: i % 2 === 0 }) }));
  await roster(page, [...passivated].reverse());
  await roster(page, [...passivated].reverse(), { spawned: [{ activeSessionId: passivated[0].activeSessionId, sessionId: passivated[0].sessionId, name: passivated[0].name, created: passivated[0].created }] });
  assert.equal(await page.locator(".spawned-card").count(), children.length, "resident handle to UUID passivation never duplicates a marker");
  assert.equal(await page.evaluate(() => window.__passivatingCard.isConnected && window.__passivatingCard === [...document.querySelectorAll(".spawned-card")].find(n => n.textContent.includes("Renamed worker 0"))), true, "passivation preserves the mounted card");
  assert.deepEqual(await palettes(page), before, "rename, reorder, status and passivation retain the palette");
  await showTree(page);
  for (const child of passivated) {
   const actual = await identity(row(page, child.name), ".subagent-identity");
   identified(actual, child.sessionId ?? child.activeSessionId, `${child.name} tree`);
   assert.equal(actual.swatch, before[child.sessionId ?? child.activeSessionId].swatch, "tree matches card identity");
  }
  await clearPosts(page); await card(page, passivated[0].name).click(); await frames(page);
  await onlyBrowse(page, passivated[0].browseRef, "passivated card uses the current UUID-target capability, not the old handle");
  await snapshot(page, history(), { sessionId: "different-session-for-resume", sessionName: "Other thread" });
  await roster(page, []);
  await snapshot(page); await roster(page, passivated, { announce: true });
  assert.deepEqual(await palettes(page), before, "resuming the original thread rebuilds the same palette");
  await page.reload(); await page.waitForSelector(".messages");
  await snapshot(page); await roster(page, [...passivated].reverse(), { announce: true });
  await page.waitForSelector(".boot-splash", { state: "detached" });
  assert.deepEqual(await palettes(page), before, "fresh webview document needs no saved random palette state");
  await page.evaluate(() => { window.__lateCanonicalCard = [...document.querySelectorAll(".spawned-card")].find(n => n.textContent.includes("Renamed worker 5")); });
  const discovered = passivated.map((child, i) => i === 5 ? { ...child, sessionId: UUIDS[5], browseRef: "opaque-canonical-discovery" } : child);
  await roster(page, discovered, { announce: true });
  assert.equal(await page.locator(".spawned-card").count(), children.length, "late canonical discovery migrates rather than duplicates the existing card");
  assert.equal(await page.evaluate(() => window.__lateCanonicalCard.isConnected && window.__lateCanonicalCard === [...document.querySelectorAll(".spawned-card")].find(n => n.textContent.includes("Renamed worker 5"))), true);
  const canonicalColor = await identity(card(page, discovered[5].name), ".spawned-dot");
  identified(canonicalColor, UUIDS[5], "late canonical discovery");
  await showTree(page);
  assert.deepEqual(await identity(row(page, discovered[5].name), ".subagent-identity"), canonicalColor, "all current locations adopt the discovered canonical color together");
  const settled = discovered.map((child, i) => i === 5 ? { ...child, id: child.sessionId, activeSessionId: child.sessionId, status: "inactive", isStreaming: false, browseRef: "opaque-discovered-passivated-reference" } : child);
  await roster(page, settled, { announce: true });
  assert.equal(await page.locator(".spawned-card").count(), children.length);
  assert.deepEqual(await identity(card(page, settled[5].name), ".spawned-dot"), canonicalColor, "once known, the UUID identity survives its own passivation");
  return { samples: before, canonicalPassivationKey: passivated[0].sessionId, legacyFallbackKey: children[5].activeSessionId, lateCanonicalColor: canonicalColor, reload: true };
 });

 await run("06-current-header-tree-identity-and-semantic-status", async page => {
  await seed(page);
  const children = [agent(0), agent(1, { status: "idle", isStreaming: false }), agent(2, { status: "inactive", isStreaming: false, statusLabel: "failed" }), agent(3, { status: "idle", isStreaming: false, statusLabel: "queued" })];
  await roster(page, children, { announce: true }); await showTree(page);
  const before = await identity(card(page, children[0].name), ".spawned-dot"); identified(before, children[0].sessionId, "root transcript marker");
  // The current status id need not be the daemon's canonical session UUID.
  await snapshot(page, history(6), { sessionId: "current-view-transport-handle", sessionName: children[0].name });
  await roster(page, [], { parent: ROOT_AGENT, siblings: children, viewedActiveSessionId: children[0].activeSessionId, viewedSession: { ...children[0], browseRef: undefined } });
  await showTree(page);
  assert.equal(await page.locator(".subagent-row.viewing").count(), 1);
  assert.equal(await row(page, children[0].name).evaluate(n => n.classList.contains("viewing")), true);
  const currentRow = await identity(row(page, children[0].name), ".subagent-identity");
  const header = await identity(page.locator(".session-title-wrap"), ".session-agent-mark");
  assert.deepEqual(currentRow, before, "viewed tree row matches the original transcript marker");
  assert.deepEqual(header, before, "current-view header matches canonical roster identity, not status transport id");
  const highlight = await row(page, children[0].name).evaluate(n => ({ border: getComputedStyle(n).borderLeftColor, background: getComputedStyle(n).backgroundColor, text: getComputedStyle(n.querySelector(".subagent-name")).color }));
  assert.equal(highlight.border, before.swatch, "current row highlight uses the matching identity; text keeps readable foreground");
  assert.notEqual(highlight.background, "rgba(0, 0, 0, 0)", "current row has a visible highlight");
  const expected = [["active", "running"], ["idle", "idle"], ["done", "failed"], ["idle", "queued"]];
  for (let i = 0; i < children.length; i++) {
   const target = row(page, children[i].name);
   assert.equal(await target.locator(".subagent-dot").evaluate((n, cls) => n.classList.contains(cls), expected[i][0]), true, "semantic status dot remains separate from identity square");
   assert.equal(await target.locator(".subagent-badge").textContent(), expected[i][1]);
   assert.equal(await target.locator(".subagent-identity").count(), 1);
  }
  assert.match(await row(page, children[2].name).locator(".subagent-dot").getAttribute("title"), /failed.*worker failed/i);
  assert.match(await row(page, children[3].name).locator(".subagent-dot").getAttribute("title"), /queued.*spawn accepted/i);
  assert.match(await page.locator(".subagents-header").textContent(), /1 running.*2 idle.*1 finished/);
  await roster(page, [], { parent: ROOT_AGENT, viewedActiveSessionId: children[0].activeSessionId, viewedSession: { ...children[0], name: "Renamed current view", browseRef: undefined } });
  assert.deepEqual(await identity(page.locator(".session-title-wrap"), ".session-agent-mark"), before, "viewedSession keeps header identity even without siblings");
  return { card: before, currentRow, header, highlight, retainedStatusLabels: ["failed", "queued"] };
 });

 await run("07-dark-light-highcontrast-narrow-focus-and-contrast", async page => {
  await seed(page, history(8));
  const children = [0, 1, 2, 3].map(i => agent(i, { name: `A very long unbroken-worker-name-${i}-abcdefghijklmnopqrstuvwxyz0123456789`, ...(i === 2 ? { status: "inactive", isStreaming: false, statusLabel: "failed" } : {}) }));
  const viewed = agent(4, { name: "Current subagent view", browseRef: undefined });
  await roster(page, children, { announce: true, viewedActiveSessionId: viewed.activeSessionId, viewedSession: viewed }); await showTree(page);
  const measurements = []; reports.at(-1).evidence = measurements;
  for (const theme of ["vscode-dark", "vscode-light", "vscode-high-contrast"]) {
   await page.evaluate(theme => {
    document.body.className = theme;
    const light = theme === "vscode-light", high = theme === "vscode-high-contrast";
    for (const [key, value] of Object.entries({ "--vscode-sideBar-background": light ? "#f3f3f3" : high ? "#000000" : "#0f0f0f", "--vscode-foreground": light ? "#333333" : "#f5f7f8", "--vscode-descriptionForeground": light ? "#616161" : "#aaaaaa", "--vscode-focusBorder": high ? "#ffffff" : light ? "#005fb8" : "#85ed75", "--vscode-contrastBorder": high ? "#ffffff" : "transparent" })) document.body.style.setProperty(key, value);
   }, theme);
   for (const width of [360, 280]) {
    await page.setViewportSize({ width, height: 760 }); await frames(page);
    await page.keyboard.press("Tab"); await card(page, children[0].name).focus(); await frames(page);
    const metrics = await visualMetrics(page); measurements.push({ theme, ...metrics });
    assert.ok(metrics.rootWidth <= width + 1 && metrics.bodyWidth <= width + 1, `${theme}/${width}: no document horizontal overflow`);
    assert.ok(metrics.messages.scrollWidth <= metrics.messages.width + 1, `${theme}/${width}: no transcript horizontal overflow`);
    assert.ok(metrics.strip.scrollWidth <= metrics.strip.width + 1, `${theme}/${width}: no tree horizontal overflow`);
    for (const box of [...metrics.cards, ...metrics.rows]) assert.ok(box.left >= -1 && box.right <= width + 1, `${theme}/${width}: full card/row fits narrow view`);
    assert.equal(metrics.swatches.length, children.length * 2 + 1, "card, tree and current header accents all paint");
    for (const swatch of metrics.swatches) {
     assert.ok(swatch.width >= 6 && swatch.height >= 6, "identity swatch remains visible");
     assert.ok(swatch.contrast >= 3, `${theme}/${width}: ${swatch.selector} ${swatch.key} identity contrast ${swatch.contrast.toFixed(2)} < 3:1`);
    }
    assert.equal(metrics.focus.card, true); assert.equal(metrics.focus.visible, true, "keyboard focus-visible is retained");
    assert.ok(metrics.focus.style !== "none" && metrics.focus.width >= 1, "full-card action has a visible focus outline");
    assert.ok(metrics.focus.contrast >= 3, `${theme}/${width}: focus outline contrast ${metrics.focus.contrast.toFixed(2)} < 3:1`);
   }
   await page.screenshot({ path: join(output, `07-${theme}-280.png`) });
  }
  return measurements;
 });

 await run("08-detached-reader-pane-selection-and-mount-survive-roster", async page => {
  const messages = history(60);
  messages[31] = { role: "assistant", timestamp: T0 + 310_000, stopReason: "toolUse", content: [{ type: "text", text: "Read this stable tool while the roster changes." }, { type: "toolCall", id: "correlation-reader-tool", name: "ipython", arguments: { code: Array.from({ length: 160 }, (_, i) => `reader_line_${i} = calculate(${i})  # retained code selection`).join("\n") } }] };
  await seed(page, messages, { streaming: true });
  const child = agent(0, { created: new Date(T0 + 315_000).toISOString() });
  const finished = agent(1, { status: "inactive", isStreaming: false });
  await roster(page, [child, finished], { announce: true });
  await page.locator(".subagents-header").click(); await page.locator(".subagents-header").click();
  const toolSelector = '[data-part="tool-correlation-reader-tool"]';
  await page.locator(`${toolSelector} .tool-toggle`).click(); await frames(page);
  await page.evaluate(selector => {
   const messages = document.querySelector(".messages"), tool = document.querySelector(selector);
   messages.scrollTop += tool.getBoundingClientRect().top - messages.getBoundingClientRect().top - 30;
   messages.dispatchEvent(new Event("scroll"));
  }, toolSelector); await frames(page);
  const outer = await page.locator(".messages").boundingBox();
  await page.mouse.move(outer.x + 3, outer.y + 20); await page.mouse.wheel(0, -70); await frames(page);
  const pane = page.locator(`${toolSelector} .tool-section pre`).first();
  assert.ok(await pane.evaluate(n => n.scrollHeight - n.clientHeight) > 500, "inner code pane genuinely overflows");
  await pane.evaluate(n => { n.scrollTop = 220; n.dispatchEvent(new Event("scroll")); }); await frames(page);
  await pane.hover(); await page.mouse.wheel(0, -60); await frames(page);
  const before = await page.evaluate(selector => {
   const messages = document.querySelector(".messages"), tool = document.querySelector(selector), pre = tool.querySelector(".tool-section pre");
   const text = pre.firstChild, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(42, text.textContent.length));
   const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
   window.__reader = { card: document.querySelector(".spawned-card"), tool, row: tool.closest(".row"), pre, start: text, startOffset: range.startOffset, end: text, endOffset: range.endOffset };
   window.__readerRemoved = [];
   window.__readerObserver = new MutationObserver(records => {
    for (const record of records) for (const removed of record.removedNodes) for (const [name, node] of Object.entries(window.__reader)) if (node instanceof Node && (removed === node || removed.contains(node))) window.__readerRemoved.push(name);
   });
   window.__readerObserver.observe(messages, { childList: true, subtree: true });
   const jump = document.querySelector(".jump-to-latest");
   return { outerTop: messages.scrollTop, gap: messages.scrollHeight - messages.clientHeight - messages.scrollTop,
    rowOffset: window.__reader.row.getBoundingClientRect().top - messages.getBoundingClientRect().top, paneTop: pre.scrollTop,
    selection: selection.toString(), jumpVisible: jump?.classList.contains("visible"), jumpLabel: jump?.textContent.trim() };
  }, toolSelector);
  assert.ok(before.gap > 500, "outer reader is genuinely detached from live tail");
  assert.ok(before.paneTop > 0, "inner reader is parked away from its tail"); assert.ok(before.selection.length > 10);
  assert.equal(before.jumpVisible, true, "detached reader has a way back to latest");
  await clearPosts(page);
  await roster(page, [{ ...child, name: "Renamed while reading", browseRef: "opaque-reader-current-reference", status: "idle", isStreaming: false }, { ...finished, name: "Finished renamed while reading" }]);
  await roster(page, [{ ...finished, name: "Finished renamed while reading" }, { ...child, name: "Renamed while reading", browseRef: "opaque-reader-next-reference", status: "idle", isStreaming: false }]);
  const after = await page.evaluate(selector => {
   const messages = document.querySelector(".messages"), tool = document.querySelector(selector), pre = tool.querySelector(".tool-section pre"), selection = getSelection(), range = selection.rangeCount ? selection.getRangeAt(0) : null;
   window.__readerObserver.disconnect(); const jump = document.querySelector(".jump-to-latest");
   return { outerTop: messages.scrollTop, gap: messages.scrollHeight - messages.clientHeight - messages.scrollTop,
    rowOffset: window.__reader.row.getBoundingClientRect().top - messages.getBoundingClientRect().top, paneTop: pre.scrollTop,
    selection: selection.toString(), selectionNodes: !!range && range.startContainer === window.__reader.start && range.endContainer === window.__reader.end && range.startOffset === window.__reader.startOffset && range.endOffset === window.__reader.endOffset,
    sameCard: window.__reader.card.isConnected && window.__reader.card === [...document.querySelectorAll(".spawned-card")].find(n => n.textContent.includes("Renamed while reading")),
    sameTool: tool === window.__reader.tool && window.__reader.row.isConnected, samePane: pre === window.__reader.pre,
    toolOpen: tool.classList.contains("open"), removed: window.__readerRemoved,
    jumpVisible: jump?.classList.contains("visible"), jumpLabel: jump?.textContent.trim(), treeRows: document.querySelectorAll(".subagent-row").length };
  }, toolSelector);
  assert.ok(Math.abs(after.outerTop - before.outerTop) <= 1, "roster update does not move the detached outer reader");
  assert.ok(Math.abs(after.rowOffset - before.rowOffset) <= 1, "visible tool anchor stays fixed");
  assert.ok(Math.abs(after.paneTop - before.paneTop) <= 1, "held inner code scroll is retained");
  assert.equal(after.selection, before.selection); assert.equal(after.selectionNodes, true, "selection keeps its original nodes and endpoints");
  assert.equal(after.sameCard && after.sameTool && after.samePane && after.toolOpen, true, "card, tool and open inner pane remain mounted");
  assert.deepEqual(after.removed, [], "none of the held DOM was transiently detached");
  assert.equal(after.treeRows, 0, "ordinary roster refresh never autoopens a manually suppressed tree");
  assert.equal(after.jumpVisible, before.jumpVisible); assert.equal(after.jumpLabel, before.jumpLabel);
  await noPosts(page, "roster refresh cannot navigate, focus, or send a prompt");
  return { before, after };
 });

 await run("09-native-mouseback-returns-one-parent-per-gesture", async page => {
  await seed(page, history(6));
  const levelOne = agent(0, { name: "Depth one child", status: "idle", isStreaming: false });
  const levelTwo = agent(1, { name: "Depth two child", rlmDepth: 2, status: "idle", isStreaming: false });
  const mouseEvidence = []; reports.at(-1).evidence = mouseEvidence;
  await page.evaluate(() => {
   history.pushState({ fixture: "older" }, "", "#older");
   history.pushState({ fixture: "reader" }, "", "#reader");
   window.__mouseEvents = [];
   for (const type of ["mousedown", "mouseup", "auxclick"]) window.addEventListener(type, event => {
    if (event.button === 3 || event.button === 4) window.__mouseEvents.push({ type, button: event.button, prevented: event.defaultPrevented, trusted: event.isTrusted });
   }, { capture: true });
  });
  const cdp = await page.context().newCDPSession(page);
  const point = await page.locator(".messages").boundingBox();
  const buttonEvent = (type, button = "back") => cdp.send("Input.dispatchMouseEvent", {
   type, button, buttons: type === "mousePressed" ? (button === "back" ? 8 : 16) : 0,
   x: point.x + Math.min(30, point.width / 2), y: point.y + Math.min(30, point.height / 2), clickCount: 1,
  });
  const clearMouse = () => page.evaluate(() => { window.__mouseEvents = []; postedMessages.length = 0; });
  const captureMouse = async (label, expectedActions, prevented, button = 3) => {
   const evidence = await page.evaluate(label => ({ label, events: structuredClone(window.__mouseEvents), posts: structuredClone(postedMessages), hash: location.hash }), label);
   mouseEvidence.push(evidence);
   // Host-confirmed navigation re-requests its normal model/command catalogs.
   // They are not user intents and may arrive between press and release.
   const actions = evidence.posts.filter(post => !["requestCommands", "requestModels"].includes(post.type));
   assert.deepEqual(actions, expectedActions, `${label}: one parent action at most, never browse/abort/prompt/userFocus`);
   const phases = evidence.events.map(event => event.type);
   assert.ok(phases.length >= 2 && phases[0] === "mousedown" && phases[1] === "mouseup" && phases.slice(2).every(type => type === "auxclick"), `${label}: real complete Chromium press/release (auxclick is browser-dependent)`);
   for (const event of evidence.events) {
    assert.equal(event.button, button); assert.equal(event.trusted, true, "CDP emits native trusted input");
    assert.equal(event.prevented, prevented, `${label}: correct browser default ownership through release`);
   }
   return evidence;
  };
  try {
   await snapshot(page, history(6), { sessionId: levelTwo.sessionId, sessionName: levelTwo.name });
   await roster(page, [], { parent: levelOne, siblings: [levelTwo], viewedActiveSessionId: levelTwo.activeSessionId, viewedSession: { ...levelTwo, browseRef: undefined } });
   await clearMouse(); await buttonEvent("mousePressed"); await frames(page);
   assert.deepEqual(await page.evaluate(() => postedMessages), [{ type: "backToParent" }], "nested Back claims exactly one parent on press");
   await buttonEvent("mouseReleased"); await frames(page);
   const nested = await captureMouse("depth two to depth one", [{ type: "backToParent" }], true);
   assert.deepEqual(nested.events.map(event => event.type), ["mousedown", "mouseup", "auxclick"], "an unchanged target emits a trusted auxclick that the same gesture latch claims without a second post");
   assert.equal(nested.hash, "#reader", "claimed Back cannot navigate the webview's browser history");
   await snapshot(page, history(6), { sessionId: levelOne.sessionId, sessionName: levelOne.name });
   await roster(page, [levelTwo], { parent: ROOT_AGENT, siblings: [levelOne], viewedActiveSessionId: levelOne.activeSessionId, viewedSession: { ...levelOne, browseRef: undefined } });
   assert.equal(await page.locator(".session-title").textContent(), levelOne.name);
   assert.ok((await page.locator(".subagents-back-name").textContent()).includes(ROOT_AGENT.name));

   await clearMouse(); await buttonEvent("mousePressed"); await frames(page);
   assert.deepEqual(await page.evaluate(() => postedMessages), [{ type: "backToParent" }]);
   // Root may become effective while the physical button is still held down.
   await snapshot(page, history(6)); await roster(page, [levelOne], { viewedActiveSessionId: ROOT_AGENT.activeSessionId, viewedSession: ROOT_AGENT });
   await buttonEvent("mouseReleased"); await frames(page);
   const rootAck = await captureMouse("depth one to root before release", [{ type: "backToParent" }], true);
   assert.equal(rootAck.hash, "#reader", "root acknowledgment cannot release the already-claimed browser Back");
   assert.equal(await page.locator(".subagents-back-row").count(), 0, "two gestures return exactly two parent levels");

   // Forward remains the browser's control even while viewing a child.
   await roster(page, [], { parent: ROOT_AGENT, siblings: [levelOne], viewedActiveSessionId: levelOne.activeSessionId, viewedSession: { ...levelOne, browseRef: undefined } });
   await clearMouse(); await buttonEvent("mousePressed", "forward"); await buttonEvent("mouseReleased", "forward"); await frames(page);
   await captureMouse("Forward inside subagent", [], false, 4);

   // Root with child cards is not the same as being inside a child.
   await roster(page, [levelOne], { viewedActiveSessionId: ROOT_AGENT.activeSessionId, viewedSession: ROOT_AGENT });
   await clearMouse(); await buttonEvent("mousePressed"); await buttonEvent("mouseReleased"); await frames(page);
   await captureMouse("Back at root with children", [], false);

   await page.evaluate(() => { history.pushState({ fixture: "empty-root" }, "", "#empty-root"); });
   await roster(page, [], { viewedActiveSessionId: ROOT_AGENT.activeSessionId, viewedSession: ROOT_AGENT });
   await clearMouse(); await buttonEvent("mousePressed"); await buttonEvent("mouseReleased"); await frames(page);
   await captureMouse("Back with no child context", [], false);

   await page.evaluate(() => { history.pushState({ fixture: "read-only" }, "", "#read-only"); });
   await snapshot(page, history(6), { sessionId: levelOne.sessionId, sessionName: levelOne.name, observingId: "other-client-read-only" });
   await roster(page, [], { parent: ROOT_AGENT, siblings: [levelOne], viewedActiveSessionId: levelOne.activeSessionId, viewedSession: { ...levelOne, browseRef: undefined } });
   await clearMouse(); await buttonEvent("mousePressed"); await buttonEvent("mouseReleased"); await frames(page);
   await captureMouse("Back in observed read-only view", [], false);
   assert.equal(await page.locator(".observe-banner").isVisible(), true, "observed view stays read-only without mutating its parent stack");
  } finally { await cdp.detach(); }
  return mouseEvidence;
 });
} finally {
 await writeFile(join(output, "results.json"), JSON.stringify({ sourceRef: sourceRef ?? null, testHash, bundleHash: sha256(bundle.outputFiles[0].contents), sourceHashes, cases: reports.length, failures, reports, postChecks }, null, 2));
 await browser?.close(); await new Promise(resolve => server.close(resolve));
}
console.log(`\n${reports.length - failures}/${reports.length} subagent correlation browser cases passing (${sourceRef ?? "current source"})`);
console.log(`Test SHA256 ${testHash}\nArtifacts ${output}`);
process.exitCode = failures ? 1 : 0;
