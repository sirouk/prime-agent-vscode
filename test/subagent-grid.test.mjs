/**
 * Responsive Subagents grid in real Chromium. Use normal preview HTML/CSS and
 * TypeScript bundled in memory. Never read generated assets or contact a daemon.
 *
 * Current:  node test/subagent-grid.test.mjs
 * Baseline: SOURCE_REF=v1.0.51 node test/subagent-grid.test.mjs
 * Artifacts: /tmp/prime-subagent-grid/{current|source-ref}/
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
const sourceRef = process.env.SOURCE_REF;
const output = process.env.SUBAGENT_GRID_OUTPUT ?? join("/tmp/prime-subagent-grid", sourceRef ? sourceRef.replace(/[^a-z0-9_.-]/gi, "_") : "current");
const exec = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const testPath = fileURLToPath(import.meta.url);
const testHashBefore = sha256(await readFile(testPath));
const sourceHashesBefore = {}, sourceCache = new Map();
async function readSource(path) {
 return sourceRef
  ? Buffer.from((await exec("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout)
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
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("subagent-grid-test") },
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
const reports = [], postChecks = [];
let browser, failures = 0, currentCase = "";
const T0 = Date.parse("2026-10-01T10:00:00Z");
const SESSION = "01a11351-bbf4-7594-9f5a-2a6d8fdd1ca6";
const ROOT_AGENT = { id: SESSION, sessionId: SESSION, activeSessionId: "parenthandle", name: "Parent fixture", runtimeKind: "root", status: "idle" };
const LIVE = ".subagents-list:not(.siblings):not(.historical)";
function agent(index, patch = {}) {
 return { id: `sub-grid-${index}`, sessionId: `01a1166a-7654-7784-844a-${index.toString(16).padStart(12, "0")}`,
  activeSessionId: `gridhandle${String(index).padStart(2, "0")}`, browseRef: `opaque-grid-capability-${index}-initial`,
  name: `Worker ${String(index).padStart(2, "0")}`, runtimeKind: "subagent", rlmDepth: 1,
  created: new Date(T0 + 1_000_000 + index * 1000).toISOString(), status: "running", isStreaming: true, attachedClients: 0, ...patch };
}
const children17 = () => Array.from({ length: 17 }, (_, i) => agent(i));
const newest = children => [...children].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
const row = (page, child) => page.locator(`.subagent-row[data-agent-key="${child.sessionId}"]`);
const card = (page, child) => page.locator(`.spawned-card[data-agent-key="${child.sessionId}"]`);
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
 await page.waitForSelector(".messages"); await snapshot(page, messages, status);
 await page.waitForSelector(".boot-splash", { state: "detached" });
}
async function roster(page, children, { announce = false, spawned, ...context } = {}) {
 const announcements = spawned ?? (announce ? children.map(({ activeSessionId, sessionId, browseRef, name, created }) => ({ activeSessionId, sessionId, browseRef, name, created })) : []);
 await page.evaluate(message => host(message), { type: "sessionChildren", children, spawned: announcements, ...context });
 await frames(page);
}
async function showTree(page, historical = true) {
 if (await page.locator(".subagent-row").count() === 0) await page.locator(".subagents-header").click();
 if (historical && await page.locator(".subagents-subhead").count() && await page.locator(".subagents-list.historical").count() === 0) await page.locator(".subagents-subhead").click();
 await frames(page);
}
const clearPosts = page => page.evaluate(() => { postedMessages.length = 0; });
async function postsEqual(page, expected, label) {
 const posts = await page.evaluate(() => structuredClone(postedMessages));
 postChecks.push({ case: currentCase, label, posts });
 assert.deepEqual(posts, expected, `${label}: no duplicate action, raw ID, userFocus, prompt, or other mutation`);
}
const onlyBrowse = (page, child, label) => postsEqual(page, [{ type: "browseChild", browseRef: child.browseRef }], label);
function evidence(value) { reports.at(-1).evidence = value; return value; }
async function layout(page) {
 return page.evaluate(() => {
  const box = n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const strip = document.querySelector(".subagents-strip"), messages = document.querySelector(".messages");
  const style = getComputedStyle(strip);
  const headers = [...strip.children].filter(n => n.matches(".subagents-header, .subagents-back-row, .subagents-sibling-header, .subagents-subhead"));
  const scrollables = [strip, ...strip.querySelectorAll("*")].filter(n => /^(auto|scroll)$/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1 && n.clientHeight > 0).map(n => n.className);
  return { viewport: innerWidth, rootWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
   strip: { ...box(strip), clientWidth: strip.clientWidth, clientHeight: strip.clientHeight, scrollWidth: strip.scrollWidth, scrollHeight: strip.scrollHeight, scrollTop: strip.scrollTop,
    contentWidth: strip.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), overflowX: style.overflowX, overflowY: style.overflowY },
   messages: { ...box(messages), clientWidth: messages.clientWidth, scrollWidth: messages.scrollWidth }, scrollables,
   childOrder: [...strip.children].map(n => n.className), headers: headers.map(n => ({ className: n.className, ...box(n) })),
   lists: [...strip.querySelectorAll(".subagents-list")].map(n => ({ className: n.className, ...box(n), columns: getComputedStyle(n).gridTemplateColumns, display: getComputedStyle(n).display,
    rows: [...n.querySelectorAll(".subagent-row")].map(r => ({ key: r.dataset.agentKey, name: r.querySelector(".subagent-name").textContent, ...box(r), clientWidth: r.clientWidth, scrollWidth: r.scrollWidth })) })) };
 });
}
function noOverflow(m, label) {
 assert.ok(m.rootWidth <= m.viewport + 1 && m.bodyWidth <= m.viewport + 1, `${label}: no document horizontal overflow`);
 assert.ok(m.messages.scrollWidth <= m.messages.clientWidth + 1, `${label}: no transcript horizontal overflow`);
 assert.ok(m.strip.scrollWidth <= m.strip.clientWidth + 1, `${label}: no roster horizontal overflow`);
 for (const list of m.lists) for (const r of list.rows) {
  assert.ok(r.left >= m.strip.left - 1 && r.right <= m.strip.right + 1, `${label}: row fits actual panel`);
  assert.ok(r.scrollWidth <= r.clientWidth + 1, `${label}: row has no hidden horizontal overflow`);
 }
 assert.ok(m.strip.height <= 180.1, `${label}: the whole roster, including headers, stays within 180px`);
}
function grid(list, columns, children, label, maxRowHeight = 28) {
 assert.equal(list.display, "grid", `${label}: the group is a CSS grid`);
 assert.equal(list.columns.trim().split(/\s+/).length, columns, `${label}: ${columns} column(s)`);
 assert.deepEqual(list.rows.map(r => r.key), newest(children).map(c => c.sessionId), `${label}: DOM order is newest first`);
 assert.equal(new Set(list.rows.map(r => Math.round(r.top * 2) / 2)).size, Math.ceil(children.length / columns), `${label}: compact row-major tracks`);
 const width = list.rows[0]?.width;
 for (let i = 0; i < list.rows.length; i++) {
  const r = list.rows[i];
  assert.ok(r.height >= 24 && r.height <= maxRowHeight, `${label}: compact, non-collapsed row height ${r.height}`);
  assert.ok(Math.abs(r.width - width) <= 1, `${label}: equal-width cells`);
  if (columns === 2 && i % 2) {
   assert.ok(Math.abs(r.top - list.rows[i - 1].top) <= .5, `${label}: paired cells share a track`);
   assert.ok(r.left > list.rows[i - 1].left, `${label}: DOM order reads left to right`);
  }
  if (i >= columns) assert.ok(r.top >= list.rows[i - columns].bottom - .5, `${label}: tracks never overlap`);
 }
}
function singleScrollbar(m, label) {
 assert.deepEqual(m.scrollables, ["subagents-strip visible"], `${label}: exactly one vertical roster scrollbar, not one per group`);
}
async function run(name, test) {
 currentCase = name;
 const page = await browser.newPage({ viewport: { width: 840, height: 760 } });
 page.setDefaultTimeout(3500); page.setDefaultNavigationTimeout(5000);
 const errors = [], report = { name, pass: false }; reports.push(report);
 page.on("pageerror", error => errors.push(String(error)));
 page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
 try {
  const value = await test(page); if (value !== undefined) report.evidence = value;
  assert.deepEqual(errors, [], "no webview errors");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no host message handler errors");
  report.pass = true; console.log(`PASS ${name}`);
 } catch (error) {
  failures++; report.error = error.stack ?? String(error); console.error(`FAIL ${name}\n${report.error}`);
 } finally {
  report.runtimeErrors = errors;
  await page.screenshot({ path: join(output, `${report.pass ? "" : "failed-"}${name}.png`) }).catch(() => {});
  report.finalLayout = await layout(page).catch(() => null);
  await page.close();
 }
}
// Read browser-resolved colors and composite alpha through real ancestors.
async function visualMetrics(page) {
 return page.evaluate(() => {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
  const blend = (front, back, opacity = 1) => front.slice(0, 3).map((v, i) => v * front[3] / 255 * opacity + back[i] * (1 - front[3] / 255 * opacity));
  const surface = node => { const ancestors = []; for (let n = node; n; n = n.parentElement) ancestors.unshift(n); return ancestors.reduce((bg, n) => blend(rgba(getComputedStyle(n).backgroundColor), bg), [255, 255, 255]); };
  const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  const swatches = [...document.querySelectorAll(".spawned-dot, .subagent-identity, .session-agent-mark")].map(n => {
   const s = getComputedStyle(n), bg = surface(n.parentElement), r = n.getBoundingClientRect();
   return { key: n.closest("[data-agent-key]")?.dataset.agentKey, selector: n.className, color: s.backgroundColor, width: r.width, height: r.height, contrast: ratio(blend(rgba(s.backgroundColor), bg, Number(s.opacity)), bg) };
  });
  const rows = [...document.querySelectorAll(".subagent-row")].map(n => {
   const name = n.querySelector(".subagent-name"), badge = n.querySelector(".subagent-badge"), ns = getComputedStyle(name), bs = getComputedStyle(badge);
   const range = document.createRange(); range.selectNodeContents(badge);
   return { key: n.dataset.agentKey, tag: n.tagName, type: n.type, aria: n.getAttribute("aria-label"), title: name.title || n.title, name: name.textContent,
    viewing: n.classList.contains("viewing"), disabled: n.disabled, badge: badge.textContent, badgeWidth: badge.getBoundingClientRect().width, textWidth: range.getBoundingClientRect().width,
    badgeHeight: badge.getBoundingClientRect().height, textHeight: range.getBoundingClientRect().height, badgeVerticalPadding: parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom),
    badgeContrast: ratio(blend(rgba(bs.color), surface(badge), Number(bs.opacity)), surface(badge)), nameFontSize: parseFloat(ns.fontSize), badgeFontSize: parseFloat(bs.fontSize),
    badgePadding: parseFloat(bs.paddingLeft) + parseFloat(bs.paddingRight), badgeShrink: bs.flexShrink, badgeWhiteSpace: bs.whiteSpace,
    ellipsis: ns.textOverflow, nameWhiteSpace: ns.whiteSpace, nameClipped: name.scrollWidth > name.clientWidth, nestedButtons: n.querySelectorAll("button, [role=button]").length,
    dark: n.style.getPropertyValue("--agent-color-dark"), light: n.style.getPropertyValue("--agent-color-light") };
  });
  const focus = document.activeElement, fs = getComputedStyle(focus), bg = surface(focus);
  return { rows, swatches, focus: { key: focus.dataset.agentKey, visible: focus.matches(":focus-visible"), style: fs.outlineStyle, width: parseFloat(fs.outlineWidth), contrast: ratio(blend(rgba(fs.outlineColor), bg), bg) } };
 });
}
async function readerState(page) {
 return page.evaluate(() => {
  const messages = document.querySelector(".messages"), strip = document.querySelector(".subagents-strip"), jump = document.querySelector(".jump-to-latest"), focus = document.activeElement;
  const r = focus.getBoundingClientRect(), s = strip.getBoundingClientRect();
  const anchor = window.__gridReader;
  return { outerTop: messages.scrollTop, gap: messages.scrollHeight - messages.clientHeight - messages.scrollTop,
   stripTop: strip.scrollTop, stripMax: strip.scrollHeight - strip.clientHeight, focusKey: focus.dataset.agentKey,
   focusVisible: focus.matches(":focus-visible"), focusInStrip: strip.contains(focus), focusTop: r.top, focusBottom: r.bottom, stripBounds: { top: s.top, bottom: s.bottom },
   anchorMounted: !!anchor?.isConnected, anchorOffset: anchor ? anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top : null,
   jumpVisible: jump?.classList.contains("visible"), jumpLabel: jump?.textContent.trim() };
 });
}

try {
 browser = await chromium.launch({ timeout: 15000 });
 await run("01-wide-840-seventeen-rows-two-equal-compact-columns", async page => {
  await seed(page, history(8)); const children = children17();
  await roster(page, children); await showTree(page);
  const m = evidence(await layout(page));
  assert.equal(m.strip.contentWidth, 840, "wide fixture measures the actual roster width");
  assert.equal(m.lists.length, 1); grid(m.lists[0], 2, children, "840px/17 workers");
  noOverflow(m, "wide"); singleScrollbar(m, "wide");
  assert.ok(m.strip.scrollHeight < 270, "two columns compact 17 workers instead of a 17-track single column");
  await clearPosts(page); await postsEqual(page, [], "layout does not navigate");
  return m;
 });

 await run("02-narrow-280-360-420-single-column", async page => {
  await seed(page, history(8)); const children = children17();
  await roster(page, children); await showTree(page);
  const measurements = evidence([]);
  for (const width of [280, 360, 420]) {
   await page.setViewportSize({ width, height: 760 }); await frames(page);
   const m = await layout(page); measurements.push(m);
   assert.ok(m.strip.contentWidth < 560, "narrow actual panel");
   grid(m.lists[0], 1, children, `${width}px`); noOverflow(m, `${width}px`); singleScrollbar(m, `${width}px`);
   await page.screenshot({ path: join(output, `02-narrow-${width}.png`) });
  }
  return measurements;
 });

 await run("03-resize-actual-container-559-560-561-not-viewport", async page => {
  await seed(page, history(8)); const children = children17();
  await roster(page, children); await showTree(page);
  const measurements = evidence([]);
  for (const width of [420, 559, 560, 561, 840, 559, 560]) {
   // Change only the real editor/sidebar root width; never inject a grid style.
   await page.evaluate(width => { document.querySelector(".chat-root").style.width = `${width}px`; }, width); await frames(page);
   const initial = await layout(page);
   // Account for any real border/padding/scrollbar gutter in the query box.
   if (Math.abs(initial.strip.contentWidth - width) > .1) {
    await page.evaluate(({ width, inset }) => { document.querySelector(".chat-root").style.width = `${width + inset}px`; }, { width, inset: initial.strip.width - initial.strip.contentWidth });
    await frames(page);
   }
   const m = await layout(page); measurements.push({ requestedContentWidth: width, ...m });
   assert.equal(m.viewport, 840, "viewport does not drive the breakpoint");
   assert.ok(Math.abs(m.strip.contentWidth - width) <= .1, "measured query-container content width");
   grid(m.lists[0], width >= 560 ? 2 : 1, children, `actual ${width}px / viewport 840px`);
   noOverflow(m, `resized ${width}px`); singleScrollbar(m, `resized ${width}px`);
  }
  return measurements;
 });

 await run("04-theme-long-names-status-accessibility-and-identity", async page => {
  await seed(page, history(8));
  const children = Array.from({ length: 6 }, (_, i) => agent(i, { name: `A-very-long-unbroken-worker-name-${i}-` + "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4),
   ...(i === 1 ? { status: "idle", isStreaming: false } : i === 2 ? { status: "inactive", isStreaming: false, statusLabel: "failed" } : i === 3 ? { statusLabel: "recovering" } : i === 4 ? { status: "idle", isStreaming: false, statusLabel: "queued" } : i === 5 ? { browseRef: undefined } : {}) }));
  await roster(page, children, { announce: true, viewedActiveSessionId: children[0].activeSessionId, viewedSession: { ...children[0], browseRef: undefined } }); await showTree(page);
  const measurements = evidence([]), identity = new Map();
  for (const theme of ["vscode-dark", "vscode-light", "vscode-high-contrast"]) {
   await page.evaluate(theme => {
    document.body.className = theme;
    const light = theme === "vscode-light", high = theme === "vscode-high-contrast";
    for (const [key, value] of Object.entries({ "--vscode-sideBar-background": light ? "#f3f3f3" : high ? "#000000" : "#0f0f0f", "--vscode-foreground": light ? "#333333" : "#f5f7f8", "--vscode-descriptionForeground": light ? "#616161" : "#aaaaaa", "--vscode-focusBorder": high ? "#ffffff" : light ? "#005fb8" : "#85ed75", "--vscode-contrastBorder": high ? "#ffffff" : "transparent" })) document.body.style.setProperty(key, value);
   }, theme);
   for (const width of [840, 280]) {
    await page.setViewportSize({ width, height: 760 }); await frames(page);
    await page.keyboard.press("Tab"); await row(page, children[0]).focus(); await frames(page);
    const m = await layout(page), visual = await visualMetrics(page); measurements.push({ theme, ...m, visual });
    noOverflow(m, `${theme}/${width}`);
    for (const list of m.lists) grid(list, width >= 560 ? 2 : 1, children.filter(c => list.className.includes("historical") ? c.status === "inactive" : c.status !== "inactive"), `${theme}/${width}/${list.className}`);
    assert.equal(await page.locator(".subagent-go").count(), 0, "repeated view text is removed; the whole row remains the action");
    assert.equal(visual.rows.length, children.length);
    for (const r of visual.rows) {
     const child = children.find(c => c.sessionId === r.key), status = child.statusLabel ?? (child.status === "inactive" ? "finished" : child.status);
     assert.equal(r.tag, "BUTTON"); assert.equal(r.type, "button"); assert.equal(r.nestedButtons, 0);
     assert.ok(r.title.includes(child.name), "full name is available on the ellipsized name or native row title");
     assert.ok(r.aria?.includes(child.name) && r.aria.toLowerCase().includes(status), "accessible row name includes full identity and semantic status");
     if (r.viewing) assert.match(r.aria, /viewing/i); else if (r.disabled) assert.match(r.aria, /unavailable/i);
     assert.equal(r.badge, status); assert.equal(r.badgeShrink, "0"); assert.equal(r.badgeWhiteSpace, "nowrap");
     assert.ok(r.textWidth + r.badgePadding <= r.badgeWidth + 1, "status label is visible, not compressed or clipped");
     assert.ok(r.textHeight + r.badgeVerticalPadding <= r.badgeHeight + 1, "status text has unclipped vertical space");
     assert.ok(r.badgeContrast >= 4.5, `${theme}/${width}: status text contrast ${r.badgeContrast.toFixed(2)} < 4.5:1`);
     assert.equal(r.ellipsis, "ellipsis"); assert.equal(r.nameWhiteSpace, "nowrap"); assert.equal(r.nameClipped, true);
     const palette = { dark: r.dark, light: r.light }; assert.ok(r.dark && r.light);
     if (identity.has(r.key)) assert.deepEqual(palette, identity.get(r.key), "theme/width never changes display identity"); else identity.set(r.key, palette);
     const rowSwatch = visual.swatches.find(s => s.key === r.key && s.selector === "subagent-identity");
     const cardSwatch = visual.swatches.find(s => s.key === r.key && s.selector === "spawned-dot");
     assert.equal(rowSwatch.color, cardSwatch.color, "tree and card retain the matching identity swatch");
    }
    assert.equal(visual.swatches.length, children.length * 2 + 1, "card, tree and current-view header accents all paint");
    for (const s of visual.swatches) { assert.ok(s.width >= 6 && s.height >= 6, "swatch cannot shrink away"); assert.ok(s.contrast >= 3, `${theme}/${width}: identity ${s.key} contrast ${s.contrast.toFixed(2)} < 3:1`); }
    assert.equal(visual.focus.key, children[0].sessionId); assert.equal(visual.focus.visible, true);
    assert.ok(visual.focus.style !== "none" && visual.focus.width >= 1, "keyboard row has a visible outline");
    assert.ok(visual.focus.contrast >= 3, "keyboard outline remains visible against the row");
    await page.screenshot({ path: join(output, `04-${theme}-${width}.png`) });
   }
  }
  // Operator font scaling must grow the cells, not clip the status or identity.
  await page.evaluate(() => document.body.style.setProperty("--vscode-font-size", "24px"));
  for (const width of [840, 280]) {
   await page.setViewportSize({ width, height: 760 }); await frames(page);
   const m = await layout(page), visual = await visualMetrics(page); measurements.push({ theme: "vscode-high-contrast", operatorFontSize: 24, ...m, visual });
   noOverflow(m, `font24/${width}`);
   for (const list of m.lists) {
    grid(list, width >= 560 ? 2 : 1, children.filter(c => list.className.includes("historical") ? c.status === "inactive" : c.status !== "inactive"), `font24/${width}/${list.className}`, 40);
    for (const r of list.rows) assert.ok(r.height > 28, "operator font enlargement grows the row beyond the default 24px cell");
   }
   for (const r of visual.rows) {
    assert.ok(r.nameFontSize >= 20 && r.badgeFontSize >= 16, "name and badge honor operator font size");
    assert.ok(r.textWidth + r.badgePadding <= r.badgeWidth + 1 && r.textHeight + r.badgeVerticalPadding <= r.badgeHeight + 1, "large status text is never clipped");
    assert.equal(r.badgeShrink, "0"); assert.equal(r.badgeWhiteSpace, "nowrap");
   }
   for (const s of visual.swatches) assert.ok(s.width >= 6 && s.height >= 6, "operator font scaling never hides identity swatches");
   await page.screenshot({ path: join(output, `04-font24-${width}.png`) });
  }
  return measurements;
 });

 await run("05-groups-full-width-headers-and-independent-historical-grid", async page => {
  const liveChildren = [agent(0), agent(1), agent(2)], liveSiblings = [agent(3), agent(4), agent(5), agent(6)];
  const oldChildren = [agent(7, { status: "inactive", isStreaming: false }), agent(8, { status: "inactive", isStreaming: false })];
  const oldSiblings = [agent(9, { status: "inactive", isStreaming: false }), agent(10, { status: "inactive", isStreaming: false })];
  await seed(page, history(8), { sessionId: liveSiblings[0].sessionId, sessionName: liveSiblings[0].name });
  await roster(page, [...liveChildren, ...oldChildren], { parent: ROOT_AGENT, siblings: [...liveSiblings, ...oldSiblings], viewedActiveSessionId: liveSiblings[0].activeSessionId, viewedSession: liveSiblings[0] }); await showTree(page);
  const m = evidence({ expanded: await layout(page) }).expanded;
  assert.deepEqual(m.childOrder, ["subagents-back-row", "subagents-header", "subagents-list", "subagents-sibling-header", "subagents-list siblings", "subagents-subhead", "subagents-list historical"], "each header stays outside its independent row grid");
  grid(m.lists[0], 2, liveChildren, "children"); grid(m.lists[1], 2, liveSiblings, "siblings"); grid(m.lists[2], 2, [...oldChildren, ...oldSiblings], "historical");
  for (const h of m.headers) { assert.ok(Math.abs(h.left - m.strip.left) <= 1, "header starts at panel edge"); assert.ok(Math.abs(h.width - m.strip.clientWidth) <= 1, "header/back row spans both columns"); }
  for (let i = 1; i < m.lists.length; i++) assert.ok(m.lists[i].top >= m.lists[i - 1].bottom, "groups cannot interleave into a combined grid");
  noOverflow(m, "grouped"); singleScrollbar(m, "grouped");
  await page.locator(".subagents-subhead").click(); await frames(page);
  const folded = await layout(page); reports.at(-1).evidence.folded = folded;
  assert.equal(await page.locator(".subagents-list.historical").count(), 0, "Historical folds independently");
  grid(folded.lists[0], 2, liveChildren, "children after historical fold"); grid(folded.lists[1], 2, liveSiblings, "siblings after historical fold");
  await page.locator(".subagents-subhead").click(); await frames(page);
  const reopened = await layout(page); reports.at(-1).evidence.reopened = reopened;
  grid(reopened.lists[2], 2, [...oldChildren, ...oldSiblings], "historical reopened");
  await clearPosts(page); await postsEqual(page, [], "folding groups is not navigation");
 });

 await run("06-row-major-tab-native-keys-capabilities-and-parent-back", async page => {
  await seed(page, history(8)); const children = children17();
  await roster(page, children); await showTree(page);
  const keyboard = evidence({ layout: await layout(page), tabs: [], mouse: null });
  await page.keyboard.press("Tab"); await page.locator(".subagents-header").focus();
  for (const child of newest(children)) {
   await page.keyboard.press("Tab"); await frames(page, 2);
   const focused = await page.evaluate(() => ({ key: document.activeElement.dataset.agentKey, tag: document.activeElement.tagName, visible: document.activeElement.matches(":focus-visible") }));
   keyboard.tabs.push(focused); assert.equal(focused.key, child.sessionId, "Tab follows newest-first DOM row-major order"); assert.equal(focused.tag, "BUTTON"); assert.equal(focused.visible, true);
  }
  const target = children[0], refreshed = children.map(c => ({ ...c, browseRef: `opaque-keyboard-current-${c.id}` }));
  await roster(page, refreshed); const current = refreshed[0];
  for (const key of ["Enter", "Space"]) {
   await clearPosts(page); await row(page, current).focus(); await row(page, current).press(key); await frames(page);
   await onlyBrowse(page, current, `native row ${key} uses current capability`);
  }
  assert.notEqual(current.browseRef, target.browseRef, "the fixture tests a refreshed capability, not a captured original");
  await snapshot(page, history(8), { sessionId: current.sessionId, sessionName: current.name });
  const siblings = refreshed.map(c => c.id === refreshed[1].id ? { ...c, browseRef: undefined } : c);
  await roster(page, [], { parent: ROOT_AGENT, siblings, viewedActiveSessionId: current.activeSessionId, viewedSession: { ...current, browseRef: undefined } });
  await clearPosts(page); await row(page, current).focus(); await row(page, current).press("Enter"); await frames(page);
  await postsEqual(page, [], "viewing row is not a second navigation");
  assert.equal(await row(page, siblings[1]).isDisabled(), true);
  await row(page, siblings[1]).evaluate(n => { n.click(); n.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await postsEqual(page, [], "unavailable row cannot browse with a stale or raw identity");
  await page.locator(".subagents-back-row").click(); await frames(page);
  await postsEqual(page, [{ type: "backToParent" }], "existing parent row action");
  await clearPosts(page);
  await page.evaluate(() => {
   history.pushState({ fixture: "older" }, "", "#older"); history.pushState({ fixture: "reader" }, "", "#reader");
   window.__mouseEvents = [];
   for (const type of ["mousedown", "mouseup", "auxclick"]) window.addEventListener(type, e => { if (e.button === 3) window.__mouseEvents.push({ type, button: e.button, prevented: e.defaultPrevented, trusted: e.isTrusted }); }, { capture: true });
  });
  const cdp = await page.context().newCDPSession(page), point = await page.locator(".messages").boundingBox();
  try {
   const mouse = type => cdp.send("Input.dispatchMouseEvent", { type, button: "back", buttons: type === "mousePressed" ? 8 : 0, x: point.x + 30, y: point.y + 30, clickCount: 1 });
   await mouse("mousePressed"); await frames(page); await onlyParent();
   // A root acknowledgment during the held gesture must not release browser Back.
   await snapshot(page, history(8)); await roster(page, children, { viewedActiveSessionId: ROOT_AGENT.activeSessionId, viewedSession: ROOT_AGENT });
   await mouse("mouseReleased"); await frames(page);
   keyboard.mouse = await page.evaluate(() => ({ events: structuredClone(window.__mouseEvents), posts: structuredClone(postedMessages), hash: location.hash }));
   const actions = keyboard.mouse.posts.filter(p => !["requestCommands", "requestModels"].includes(p.type));
   assert.deepEqual(actions, [{ type: "backToParent" }], "one parent navigation through the complete native mouse gesture");
   assert.equal(keyboard.mouse.hash, "#reader", "claimed Back never moves browser history");
   assert.ok(keyboard.mouse.events.length >= 2 && keyboard.mouse.events[0].type === "mousedown" && keyboard.mouse.events[1].type === "mouseup");
   for (const e of keyboard.mouse.events) { assert.equal(e.trusted, true); assert.equal(e.prevented, true); }
   async function onlyParent() { await postsEqual(page, [{ type: "backToParent" }], "native mouse Back press"); }
  } finally { await cdp.detach(); }
  // Layout is checked last so baseline still produces complete keyboard evidence.
  grid(keyboard.layout.lists[0], 2, children, "keyboard grid");
  return keyboard;
 });

 await run("07-scrolled-roster-refresh-retains-focus-and-detached-reader", async page => {
  await seed(page, history(60), { streaming: true }); const children = children17();
  await roster(page, children); await showTree(page);
  const point = await page.locator(".messages").boundingBox();
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2); await page.mouse.wheel(0, -1300); await frames(page);
  await page.evaluate(() => {
   const messages = document.querySelector(".messages"), bounds = messages.getBoundingClientRect();
   window.__gridReader = [...messages.querySelectorAll(".row")].find(n => { const r = n.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= bounds.bottom; });
  });
  await page.keyboard.press("Tab"); await page.locator(".subagents-header").focus();
  for (let i = 0; i < children.length; i++) await page.keyboard.press("Tab");
  await frames(page);
  const before = await readerState(page), result = evidence({ before, after: null, layout: await layout(page) });
  assert.ok(before.gap > 500 && before.jumpVisible, "reader is genuinely detached with a visible return-to-latest control");
  assert.ok(before.anchorMounted, "a visible transcript row is held");
  assert.ok(before.stripTop > 1, "keyboard reaches the last row by scrolling the roster");
  assert.equal(before.focusKey, children[0].sessionId); assert.equal(before.focusVisible, true);
  assert.ok(before.focusTop >= before.stripBounds.top - 1 && before.focusBottom <= before.stripBounds.bottom + 1, "last focused row is revealed inside the roster");
  await clearPosts(page);
  const updated = children.map((c, i) => ({ ...c, status: i % 2 ? "idle" : "running", isStreaming: i % 2 === 0, browseRef: `opaque-reader-updated-${i}`, ...(i === 0 ? { statusLabel: "recovering" } : {}) }));
  await roster(page, [...updated].reverse()); await roster(page, updated);
  const after = await readerState(page); result.after = after;
  assert.ok(Math.abs(after.outerTop - before.outerTop) <= 1, "ordinary roster refresh never moves detached transcript scroll");
  assert.ok(after.anchorMounted && Math.abs(after.anchorOffset - before.anchorOffset) <= 1, "held transcript row stays mounted and fixed");
  assert.equal(after.jumpVisible, before.jumpVisible); assert.equal(after.jumpLabel, before.jumpLabel);
  assert.equal(after.focusKey, before.focusKey, "ordinary status refresh retains keyboard focus on the same identity");
  assert.equal(after.focusVisible && after.focusInStrip, true, "restored native keyboard focus stays visible in the roster");
  assert.ok(Math.abs(after.stripTop - before.stripTop) <= 1, "roster status refresh never resets nonzero roster scroll");
  await postsEqual(page, [], "status refresh cannot navigate, focus the host, or send a prompt");
  grid(result.layout.lists[0], 2, children, "scrolled grid");
  return result;
 });

 await run("08-card-reveals-bottom-grid-row-before-host-ack", async page => {
  const children = children17(); children[0] = { ...children[0], created: new Date(T0 + 315_000).toISOString() };
  const target = children[0]; await seed(page, history(60), { streaming: true });
  await roster(page, children, { spawned: [{ activeSessionId: target.activeSessionId, sessionId: target.sessionId, browseRef: target.browseRef, name: target.name, created: target.created }] });
  assert.equal(await page.locator(".subagent-row").count(), 0, "cards seed without opening the roster");
  const updated = children.map((c, i) => ({ ...c, browseRef: `opaque-card-current-${i}` })); await roster(page, updated);
  await card(page, target).scrollIntoViewIfNeeded(); await frames(page);
  const point = await card(page, target).boundingBox(); await page.mouse.move(point.x + 4, point.y + 4); await page.mouse.wheel(0, -40); await frames(page);
  await page.evaluate(() => { window.__parentCard = document.querySelector(".spawned-card"); window.__gridReader = window.__parentCard.closest(".row"); });
  const before = await readerState(page), result = evidence({ before, afterClick: null, layout: null, acknowledged: null });
  assert.ok(before.gap > 500, "parent reader is detached when the explicit card action starts");
  await clearPosts(page); await card(page, target).locator(".spawned-label").click(); await frames(page);
  await onlyBrowse(page, updated[0], "card routes exactly one latest roster capability");
  const m = await layout(page), after = await readerState(page); result.layout = m; result.afterClick = after;
  const targetBox = await row(page, target).boundingBox();
  assert.ok(m.strip.scrollTop > 0, "oldest matching target requires a real roster reveal");
  assert.ok(targetBox.y >= m.strip.top - 1 && targetBox.y + targetBox.height <= m.strip.bottom + 1, "card reveals matching row in the bottom grid track");
  assert.ok(Math.abs(after.outerTop - before.outerTop) <= 1 && Math.abs(after.anchorOffset - before.anchorOffset) <= 1, "roster-only reveal does not jump detached parent history");
  assert.equal(await page.locator(".session-title").textContent(), ROOT_AGENT.name, "parent transcript remains authoritative until host acknowledgment");
  assert.equal(await page.evaluate(() => window.__parentCard.isConnected && window.__parentCard === document.querySelector(".spawned-card")), true, "parent card remains mounted while awaiting host");
  assert.ok((await page.locator(".messages").textContent()).includes("Earlier reply"));
  grid(m.lists[0], 2, updated, "card-opened grid");
  await snapshot(page, [{ role: "assistant", timestamp: T0 + 2_000_000, stopReason: "stop", content: [{ type: "text", text: "Matching child stream history" }] }], { sessionId: target.sessionId, sessionName: target.name, streaming: true });
  await roster(page, [], { parent: ROOT_AGENT, siblings: updated, viewedActiveSessionId: target.activeSessionId, viewedSession: { ...updated[0], browseRef: undefined } });
  await page.evaluate(timestamp => host({ type: "event", event: { type: "message_start", message: { role: "assistant", timestamp, responseId: "matching-grid-child-stream", content: [{ type: "text", text: "Fresh output from the matching grid child" }] } } }), T0 + 2_001_000); await frames(page);
  assert.equal(await page.getByText("Fresh output from the matching grid child", { exact: true }).count(), 1);
  assert.equal(await row(page, target).evaluate(n => n.classList.contains("viewing")), true, "host selects the same canonical identity");
  result.acknowledged = await page.evaluate(() => ({ title: document.querySelector(".session-title").textContent, headerKey: document.querySelector(".session-title-wrap").dataset.agentKey, posts: structuredClone(postedMessages) }));
  assert.equal(result.acknowledged.headerKey, target.sessionId);
  assert.deepEqual(result.acknowledged.posts.filter(p => p.type === "browseChild"), [{ type: "browseChild", browseRef: updated[0].browseRef }], "host stream acknowledgment cannot duplicate navigation");
  assert.equal(result.acknowledged.posts.some(p => ["userFocus", "prompt", "abort", "newSession"].includes(p.type)), false);
  return result;
 });
} finally {
 const testHashAfter = sha256(await readFile(testPath)), sourceHashesAfter = {};
 for (const path of sourceCache.keys()) sourceHashesAfter[relative(root, path)] = sha256(await readSource(path));
 const frozen = testHashBefore === testHashAfter && Object.keys(sourceHashesBefore).every(path => sourceHashesBefore[path] === sourceHashesAfter[path]);
 if (!frozen) { failures++; console.error("FAIL frozen input hashes changed during this run"); }
 await writeFile(join(output, "results.json"), JSON.stringify({ sourceRef: sourceRef ?? null, testHash: testHashBefore, testHashBefore, testHashAfter, frozen,
  bundleHash: sha256(bundle.outputFiles[0].contents), sourceHashes: sourceHashesBefore, sourceHashesBefore, sourceHashesAfter, cases: reports.length, failures, reports, postChecks }, null, 2));
 await browser?.close(); await new Promise(resolve => server.close(resolve));
}
console.log(`\n${reports.filter(r => r.pass).length}/${reports.length} subagent grid browser cases passing (${sourceRef ?? "current source"})`);
console.log(`Test SHA256 ${testHashBefore}\nArtifacts ${output}`);
process.exitCode = failures ? 1 : 0;
