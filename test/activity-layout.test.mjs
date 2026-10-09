/**
 * Real Chromium activity-layout regressions. Bundle source in memory, never
 * overwrite media/main.js, launch an agent, or connect to a daemon.
 *
 * Usage: node test/activity-layout.test.mjs
 * Exact release baseline: ACTIVITY_LAYOUT_SOURCE_REF=v1.0.47 node test/activity-layout.test.mjs
 * Asset-mix diagnosis only (expected overlay, not a release gate):
 * ACTIVITY_LAYOUT_SOURCE_REF=v1.0.47 ACTIVITY_LAYOUT_CSS_REF=11ba0a0 ACTIVITY_LAYOUT_EXPECT_OVERLAY=1 node test/activity-layout.test.mjs
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { relative, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRef = process.env.ACTIVITY_LAYOUT_SOURCE_REF;
const cssRef = process.env.ACTIVITY_LAYOUT_CSS_REF ?? sourceRef;
const expectedOverlay = process.env.ACTIVITY_LAYOUT_EXPECT_OVERLAY === "1";
const output = process.env.ACTIVITY_LAYOUT_OUTPUT ?? "/tmp/prime-activity-layout-test";
const git = promisify(execFile);
async function source(path, ref = sourceRef) {
 if (!ref) return readFile(path);
 const { stdout } = await git("git", ["show", `${ref}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
 return Buffer.from(stdout);
}
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("activity-layout-test") },
 plugins: sourceRef ? [{ name: "historical-source", setup(api) {
  api.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ contents: (await source(path)).toString(), loader: "ts" }));
 }}] : [],
});
const assets = new Map([
 ["/preview.html", ["text/html", await source(join(root, "media/preview.html"))]],
 ["/main.css", ["text/css", await source(join(root, "media/main.css"), cssRef)]],
 ["/panels.css", ["text/css", await source(join(root, "media/panels.css"), cssRef)]],
 ["/main.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
const server = createServer((req, res) => {
 const asset = assets.get(new URL(req.url, "http://localhost").pathname);
 res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
 res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
await mkdir(output, { recursive: true });
const reports = [];
const frames = page => page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
async function seed(page, { font = 14, theme = "vscode-dark", extremes = false } = {}) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.evaluate(({ font, theme, extremes }) => {
  document.body.className = theme;
  document.body.style.setProperty("--vscode-font-size", `${font}px`);
  document.body.style.setProperty("--vscode-sideBar-background", theme === "vscode-light" ? "#f3f3f3" : theme === "vscode-high-contrast" ? "#000000" : "#181818");
  document.body.style.setProperty("--vscode-foreground", theme === "vscode-light" ? "#333333" : "#cccccc");
  document.body.style.setProperty("--vscode-descriptionForeground", theme === "vscode-light" ? "#616161" : "#9d9d9d");
  const history = Array.from({ length: 24 }, (_, i) => i % 2 ? {
   role: "assistant", timestamp: 1000 + i, stopReason: "stop",
   content: [{ type: "text", text: `Earlier reply ${i}. ` + "Stable transcript words. ".repeat(20) }],
  } : { role: "user", timestamp: 1000 + i, content: `Earlier question ${i}` });
  window.__activityStatus = { ...baseStatus, sessionId: "activity-layout-session", sessionName: "A long narrow-pane session title", streaming: true };
  host({ type: "snapshot", messages: history, state: null, status: window.__activityStatus, steerDefault: "steer" });
  host({ type: "event", event: { type: "agent_start" } });
  const message = { role: "assistant", timestamp: 9000, responseId: "activity-response", content: [
   { type: "toolCall", id: "activity-tool", name: "ipython", arguments: { code: "print('Working must not cover this tool')" } },
  ] };
  host({ type: "event", event: { type: "message_start", message } });
  host({ type: "event", event: { type: "tool_execution_start", toolCallId: "activity-tool", toolName: "ipython", args: message.content[0].arguments } });
  if (extremes) {
   host({ type: "draft", text: Array.from({ length: 20 }, (_, i) => `Unsent composer line ${i}`).join("\n") });
   host({ type: "sessionChildren", children: Array.from({ length: 16 }, (_, i) => ({ id: `child-${i}`, activeSessionId: `active-${i}`, name: `Worker ${i}`, status: "idle", isStreaming: false })) });
   document.querySelector(".subagents-header")?.click();
   host({ type: "installPrompt", url: "https://example.invalid/install", reason: "Probe the large fixed toolbar stack" });
   document.querySelector('[data-part="tool-activity-tool"] .tool-toggle')?.click();
  }
  const outer = document.querySelector(".messages");
  outer.scrollTop = outer.scrollHeight;
 }, { font, theme, extremes });
 await page.waitForSelector(".boot-splash", { state: "detached", timeout: 2500 });
 await frames(page);
}
async function geometry(page) {
 return page.evaluate(() => {
  const rect = e => { const b = e?.getBoundingClientRect(); return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } : null; };
  const intersection = (a, b) => a && b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;
  const clip = (a, b) => {
   if (!a || !b) return null;
   const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right), top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
   return right > left && bottom > top ? { left, right, top, bottom, width: right - left, height: bottom - top } : null;
  };
  const messages = document.querySelector(".messages"), slot = document.querySelector(".chat-activity"), working = document.querySelector(".working-row"), label = working?.querySelector(".working-label");
  const chat = document.querySelector(".chat-view"), composer = document.querySelector(".composer-dock"), subagents = document.querySelector(".subagents-strip");
  const tool = document.querySelector('[data-part="tool-activity-tool"]'), header = tool?.querySelector(".tool-header");
  const m = rect(messages), w = rect(working), l = rect(label), t = rect(tool), c = rect(chat), cb = rect(composer), sa = rect(subagents);
  const viewport = { left: 0, right: innerWidth, top: 0, bottom: innerHeight, width: innerWidth, height: innerHeight };
  const css = working ? getComputedStyle(working) : null, chatCSS = getComputedStyle(chat);
  const clipsChat = chatCSS.overflowX === "hidden" && chatCSS.overflowY === "hidden";
  const messagePaint = clip(clipsChat ? clip(m, c) : m, viewport);
  const status = document.querySelector(".status-strip"), statusRect = rect(status);
  const workingPaint = css?.visibility === "visible" ? clip(clip(w, statusRect), viewport) : null;
  const labelPaint = css?.visibility === "visible" ? clip(clip(l, statusRect), viewport) : null;
  const toolPaint = clip(clip(t, messagePaint), viewport);
  const hitInfo = point => {
   const hit = point ? document.elementFromPoint(point.x, point.y) : null;
   return hit ? { x: point.x, y: point.y, tagName: hit.tagName, className: hit.className, text: hit.textContent?.slice(0,100), inWorking: !!working?.contains(hit), inTool: !!hit.closest(".tool"), inComposer: !!hit.closest(".composer-dock"), inSubagents: !!hit.closest(".subagents-strip") } : null;
  };
  const middle = box => box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  // Keep the raw label point for the deliberate previous-CSS diagnostic.
  const point = l && l.top >= 0 && l.bottom < innerHeight ? { x: l.left + Math.min(20, l.width / 2), y: l.top + l.height / 2 } : null;
  const rawLabelPointOutsideChat = !!point && (point.x < c.left || point.x >= c.right || point.y < c.top || point.y >= c.bottom);
  return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
   bodyFont: getComputedStyle(document.body).fontSize, messages: { ...m, clientHeight: messages.clientHeight },
   slot: rect(slot), chat: c, composer: cb, subagents: sa, topbar: rect(document.querySelector(".topbar")), status: rect(document.querySelector(".status-strip")), install: rect(document.querySelector(".install-banner")), working: w, label: l, tool: t, header: rect(header),
   sibling: slot?.parentElement === messages.parentElement, contained: !!status?.contains(working), floatingWorking: !!slot?.contains(working),
   position: css?.position, slotPosition: getComputedStyle(slot).position, slotPointerEvents: getComputedStyle(slot).pointerEvents,
   workingPointerEvents: css?.pointerEvents, visibility: css?.visibility, border: css?.borderTopWidth, chatOverflowX: chatCSS.overflowX, chatOverflowY: chatCSS.overflowY,
   transcriptOverlap: intersection(w, m), visibleToolOverlap: intersection(w, clip(t, m)), labelHeaderOverlap: intersection(l, rect(header)),
   workingPaint, labelPaint, messagePaint, toolPaint, clippedWorking: intersection(workingPaint, w) < (w?.width ?? 0) * (w?.height ?? 0),
   paintedTranscriptOverlap: intersection(workingPaint, messagePaint), paintedToolOverlap: intersection(workingPaint, toolPaint), paintedComposerOverlap: intersection(workingPaint, cb), paintedSubagentOverlap: intersection(workingPaint, sa),
   hit: hitInfo(point), rawLabelPointOutsideChat, workingPaintHit: hitInfo(middle(workingPaint)), labelPaintHit: hitInfo(middle(labelPaint)) };
 });
}
function fits(inner, outer, label) {
 if (!inner) return;
 assert.ok(inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1, label);
}
function noOverlay(g, label) {
 assert.equal(g.sibling, true, `${label}: floating activity is a messages sibling`);
 assert.equal(g.contained, true, `${label}: elapsed timer belongs to the bottom status strip`);
 assert.equal(g.floatingWorking, false, `${label}: no elapsed timer floats over the transcript`);
 assert.equal(g.slotPosition, "absolute", `${label}: activity reserves no separate row`);
 assert.equal(g.slotPointerEvents, "none", `${label}: strip background passes input through`);
 assert.equal(g.workingPointerEvents, "none", `${label}: Working cannot intercept tool interactions`);
 assert.equal(g.position, "static", `${label}: timer flows in its reserved status slot`);
 assert.equal(g.visibility, "visible", `${label}: run activity has visible styling`);
 assert.equal(g.chatOverflowX, "hidden", `${label}: chat clips horizontal overflow`);
 assert.equal(g.chatOverflowY, "hidden", `${label}: chat clips vertical overflow`);
 fits(g.working, g.status, `${label}: compact timer fits in the status strip`);
 assert.equal(g.paintedComposerOverlap, 0, `${label}: painted Working does not overlap composer`);
 assert.equal(g.paintedSubagentOverlap, 0, `${label}: painted Working does not overlap subagents`);
 fits(g.workingPaint, g.status, `${label}: all painted timer pixels are inside status`);
 assert.equal(g.paintedTranscriptOverlap, 0, `${label}: timer never paints over transcript`);
 fits(g.messagePaint, g.chat, `${label}: all painted transcript pixels are inside chat`);
 if (g.chat.height >= 54 - 0.01) {
  assert.equal(g.paintedToolOverlap, 0, `${label}: tail clearance keeps Working off the latest tool when space is available`);
  assert.ok(g.slot.top >= g.chat.top - 1 && g.slot.bottom <= g.chat.bottom + 1, `${label}: full activity fits in chat when space is available`);
  assert.ok(g.messages.bottom >= g.chat.bottom - 1, `${label}: transcript uses the space behind floating controls`);
 }
 // A short or zero-height chat clips only New messages; the timer stays in the
 // same bottom status strip instead of leaking through the composer stack.
 assert.equal(g.clippedWorking, false, `${label}: timer remains fully readable outside a compressed chat`);
 // Intentional floating paint is not an input obstruction: every visible
 // Working point must reach the transcript underneath, never the status pill.
 if (g.hit) assert.equal(g.hit.inWorking, false, `${label}: label point passes input through`);
 if (g.workingPaintHit) assert.equal(g.workingPaintHit.inWorking, false, `${label}: visible Working is not an input target`);
 if (g.labelPaintHit) assert.equal(g.labelPaintHit.inWorking, false, `${label}: visible label does not intercept input`);
}
async function unchangedChrome(page, clipped, label) {
 // Paint clipping must not move the composer/footer. Compare exactly the same
 // nodes with the old overflow behavior, in memory only; restore before return.
 const control = await page.addStyleTag({ content: ".chat-view { overflow: visible; }" });
 try {
  await frames(page); const oldPaint = await geometry(page);
  for (const member of ["chat", "messages", "composer", "subagents", "topbar", "status", "install", "slot", "working"])
   assert.deepEqual(clipped[member], oldPaint[member], `${label}: clipping does not change ${member} geometry`);
  return { oldChatOverflow: oldPaint.chatOverflowY, oldWorkingComposerPaint: oldPaint.paintedComposerOverlap, oldWorkingSubagentPaint: oldPaint.paintedSubagentOverlap };
 } finally { await control.evaluate(e => e.remove()); await frames(page); }
}
let browser;
let failures = 0;
async function run(name, config, dimensions) {
 const page = await browser.newPage({ viewport: dimensions[0], deviceScaleFactor: config.dpr ?? 1 });
 const errors = [];
 page.on("pageerror", error => errors.push(String(error)));
 try {
  await seed(page, config);
  for (const size of dimensions) {
   await page.setViewportSize(size); await page.$eval(".messages", e => { e.scrollTop = e.scrollHeight; }); await frames(page);
   const g = await geometry(page); const report = { name, ...g }; reports.push(report);
   noOverlay(g, `${name} ${size.width}x${size.height}`);
   report.chromeControl = await unchangedChrome(page, g, `${name} ${size.width}x${size.height}`);
  }
  const active = await geometry(page);
  await page.screenshot({ path: join(output, `${name}.png`) });
  await page.evaluate(() => host({ type: "event", event: { type: "agent_end" } })); await frames(page);
  const idle = await geometry(page);
  assert.equal(idle.visibility, "hidden", `${name}: idle hides Working`);
  assert.equal(idle.slot.height, active.slot.height, `${name}: idle keeps the same floating strip bounds`);
  assert.equal(idle.messages.clientHeight, active.messages.clientHeight, `${name}: idle never resizes the transcript`);
  assert.deepEqual(errors, [], `${name}: no runtime errors`);
  console.log(`PASS ${name}: ${dimensions.length} viewport checks, active/idle geometry and hit tests`);
 } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); await page.screenshot({ path: join(output, `failed-${name}.png`) }); }
 finally { await page.close(); }
}
try {
 browser = await chromium.launch();
 if (expectedOverlay) {
  const page = await browser.newPage({ viewport: { width: 580, height: 320 } });
  await seed(page); const g = await geometry(page); reports.push({ name: "mixed-css-diagnostic", ...g });
  assert.equal(g.position, "absolute", "previous CSS positions Working absolutely");
  assert.equal(g.border, "0px", "previous CSS renders a borderless Working label");
  assert.ok(g.labelHeaderOverlap > 0, "deliberate CSS mismatch overlays the label on a tool header");
  assert.equal(g.hit.inTool, true, "previous pointer-events:none exposes the underlying tool at the label point");
  await page.screenshot({ path: join(output, "mixed-css-diagnostic.png") });
  console.log(`PASS diagnostic-only: label overlaps tool by ${g.labelHeaderOverlap.toFixed(2)} CSS px²`);
  await page.close();
 } else {
  await run("desktop-dark", { font: 14 }, [180, 240, 320, 480, 760, 1100].map(height => ({ width: 580, height })));
  await run("zoom175-narrow", { font: 14, dpr: 1.75 }, [240, 320, 480, 760].map(height => ({ width: 332, height })));
  await run("font20-light-narrow", { font: 20, theme: "vscode-light" }, [180, 280, 420, 580].map(width => ({ width, height: 480 })));
  // Keep the original compressed-pane checks. Floating activity must not
  // spill outside chat or cover composer/subagent rows.
  await run("highcontrast-max-composer-panels", { font: 20, theme: "vscode-high-contrast", extremes: true }, [240, 320, 480, 760].map(height => ({ width: 280, height })));
 }
} finally {
 await writeFile(join(output, "geometry.json"), JSON.stringify({ sourceRef, cssRef, expectedOverlay, reports }, null, 2));
 await browser?.close(); await new Promise(resolve => server.close(resolve));
}
if (failures) process.exitCode = 1;
