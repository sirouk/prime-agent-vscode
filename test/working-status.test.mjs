/**
 * Compact Working timer against a native Chromium webview built in memory.
 * Only source/CSS are read. No generated assets, user settings, daemon, model,
 * extension activation, or userFocus calls are used or changed.
 *
 * SOURCE_REF=v1.0.53 WORKING_STATUS_OUTPUT=/tmp/prime-working-status-strip/browser/red node test/working-status.test.mjs
 * WORKING_STATUS_OUTPUT=/tmp/prime-working-status-strip/browser/green node test/working-status.test.mjs
 *
 * Seven bounded scenarios (<90s). Actual interval ticks prove lifecycle and
 * continuity. Only the digit-reservation scenario offsets Date.now; intervals,
 * Chromium layout, requestAnimationFrame, and all native input stay real.
 */
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRef = process.env.SOURCE_REF;
const output = process.env.WORKING_STATUS_OUTPUT ?? "/tmp/prime-working-status-strip/browser/current";
const git = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const began = performance.now();
async function gitText(args) {
 const { stdout } = await git("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 8000 });
 return stdout;
}
async function walk(directory) {
 let entries;
 try { entries = await readdir(join(root, directory), { withFileTypes: true }); }
 catch (error) { if (error.code === "ENOENT") return []; throw error; }
 return (await Promise.all(entries.map(e => e.isDirectory() ? walk(`${directory}/${e.name}`) : [`${directory}/${e.name}`]))).flat();
}
async function sourceInputs() {
 const directories = ["webview", "src", "media", "agent-extension"];
 const paths = sourceRef
  ? (await gitText(["ls-tree", "-r", "--name-only", sourceRef, "--", ...directories])).trim().split("\n")
  : (await Promise.all(directories.map(walk))).flat();
 const selected = paths.filter(path => /\.(ts|css|html)$/.test(path)).sort();
 return new Map(await Promise.all(selected.map(async path => [path, sourceRef
  ? Buffer.from(await gitText(["show", `${sourceRef}:${path}`]))
  : await readFile(join(root, path))])));
}
function manifest(inputs) {
 const hash = createHash("sha256");
 const files = Object.fromEntries([...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => {
  hash.update(path).update("\0").update(String(bytes.length)).update("\0").update(bytes).update("\0");
  return [path, sha(bytes)];
 }));
 return { sha256: hash.digest("hex"), files };
}
async function generatedInputs() {
 const paths = (await walk("dist")).concat(["media/main.js", "media/main.js.map"]);
 return new Map(await Promise.all(paths.sort().map(async path => {
  try { return [path, await readFile(join(root, path))]; }
  catch (error) { if (error.code === "ENOENT") return [path, Buffer.from("MISSING")]; throw error; }
 })));
}
await mkdir(output, { recursive: true });
const inputs = await sourceInputs();
const sourceBefore = manifest(inputs);
const generatedBefore = manifest(await generatedInputs());
const testBefore = sha(await readFile(fileURLToPath(import.meta.url)));
const resolvedRef = sourceRef ? (await gitText(["rev-parse", `${sourceRef}^{commit}`])).trim() : null;
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("working-status-source-test") },
 plugins: [{ name: "frozen-source-inputs", setup(api) {
  api.onLoad({ filter: /\.ts$/ }, ({ path }) => {
   const key = relative(root, path).replaceAll("\\", "/");
   const bytes = inputs.get(key);
   if (!bytes) throw new Error(`Missing frozen TypeScript input ${key}; refusing mixed source`);
   return { contents: bytes.toString(), loader: "ts" };
  });
 }}],
});
const assets = new Map([...inputs].filter(([path]) => path.startsWith("media/") && /\.(css|html)$/.test(path))
 .map(([path, bytes]) => [`/${path.slice("media/".length)}`, [/\.css$/.test(path) ? "text/css" : "text/html", bytes]]));
assets.set("/main.js", ["text/javascript", bundle.outputFiles[0].contents]);
const server = createServer((req, res) => {
 const asset = assets.get(new URL(req.url, "http://localhost").pathname);
 res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
 res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [];
let browser;
let failures = 0;
let timedOut = false;
// This is a suite guard, not a wait or a fake clock. Closing our owned browser
// rejects any unfinished native operation and prevents a hung proof process.
const deadline = setTimeout(() => {
 timedOut = true; failures++;
 console.error("FAIL: native working-status suite exceeded its 80s browser budget");
 void browser?.close();
}, 80_000);
const frames = (page, n = 3) => page.evaluate(async n => {
 for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
}, n);
const observeFramesFor = (page, ms) => page.evaluate(async ms => {
 const start = performance.now();
 while (performance.now() - start < ms) await new Promise(requestAnimationFrame);
 return performance.now() - start;
}, ms);
const history = Array.from({ length: 24 }, (_, i) => i % 2 ? {
 role: "assistant", timestamp: 1000 + i, responseId: `working-history-${i}`, stopReason: "stop",
 content: [{ type: "text", text: `Earlier reply ${i}. ` + "Stable readable transcript words. ".repeat(18) }],
} : { role: "user", timestamp: 1000 + i, content: `Earlier question ${i}` });
const toolCode = Array.from({ length: 100 }, (_, i) => `value_${i} = compute(${i})`).join("\n");

async function seed(page, { streaming = true, open = false } = {}) {
 await page.addInitScript(() => {
  window.__workingClockOffset = 0;
  const nativeNow = Date.now.bind(Date);
  Date.now = () => nativeNow() + window.__workingClockOffset;
 });
 await page.goto(`${origin}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.waitForSelector(".boot-splash", { state: "detached" });
 await page.evaluate(({ history, toolCode, streaming, open }) => {
  document.body.style.setProperty("--vscode-font-size", "14px");
  const f = window.__working = {
   history, live: null, result: null, trailing: [], outputLines: 120, run: 0,
   status: { ...baseStatus, sessionId: "working-status-session", sessionName: "Working status test", streaming: false },
   events: [], samples: [], ticks: [], wheels: [], clicks: [], held: null,
   row: null, label: null, mark: null, jump: null, hostNode: null, runStartedAt: 0,
  };
  f.event = event => {
   f.events.push({ type: event.type, toolCallId: event.toolCallId, time: performance.now() });
   host({ type: "event", event: structuredClone(event) });
  };
  f.snapshot = () => {
   f.events.push({ type: "snapshot", streaming: f.status.streaming, time: performance.now() });
   host({ type: "snapshot", state: null, status: structuredClone(f.status), messages: structuredClone([
    ...f.history, ...(f.live ? [f.live] : []), ...(f.result ? [f.result] : []), ...f.trailing,
   ]) });
  };
  f.statusUpdate = patch => {
   Object.assign(f.status, patch);
   f.events.push({ type: "status", streaming: f.status.streaming, time: performance.now() });
   host({ type: "status", status: structuredClone(f.status) });
  };
  f.begin = () => {
   f.run++; f.status.streaming = true; f.result = null;
   f.runStartedAt = Date.now();
   f.event({ type: "agent_start" });
   f.live = { role: "assistant", timestamp: 9000 + f.run, responseId: `working-live-${f.run}`, content: [
    { type: "text", text: "A live tool is producing output while I read earlier replies." },
    { type: "toolCall", id: "working-tool", name: "ipython", arguments: { code: toolCode } },
   ] };
   f.event({ type: "message_start", message: f.live });
   f.event({ type: "tool_execution_start", toolCallId: "working-tool", toolName: "ipython", args: { code: toolCode } });
   f.event({ type: "tool_execution_update", toolCallId: "working-tool", toolName: "ipython", args: { code: toolCode },
    partialResult: { output: Array.from({ length: f.outputLines }, (_, i) => `Streamed result line ${i}`).join("\n") } });
  };
  f.text = () => {
   f.live.content[0].text += " Continued text without ending the run.";
   f.event({ type: "message_update", message: f.live, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " Continued text without ending the run." } });
  };
  f.grow = () => {
   f.outputLines += 6;
   f.event({ type: "tool_execution_update", toolCallId: "working-tool", toolName: "ipython", args: { code: toolCode },
    partialResult: { output: Array.from({ length: f.outputLines }, (_, i) => `Streamed result line ${i}`).join("\n") } });
   const message = { role: "custom", customType: "working-probe", timestamp: 10000 + f.trailing.length,
    display: true, content: `New live continuation ${f.trailing.length}.` };
   f.trailing.push(message); f.event({ type: "message_start", message });
  };
  f.finish = (reason = "stop") => {
   if (f.live) {
    f.live.stopReason = reason;
    f.event({ type: "message_end", message: f.live });
    const output = Array.from({ length: f.outputLines }, (_, i) => `Streamed result line ${i}`).join("\n");
    f.event({ type: "tool_execution_end", toolCallId: "working-tool", toolName: "ipython", result: { output }, isError: reason === "aborted" });
    f.result = { role: "toolResult", timestamp: 9500 + f.run, toolCallId: "working-tool", toolName: "ipython", content: [{ type: "text", text: output }] };
   }
   f.status.streaming = false;
   // This is the host's completion/abort lifecycle, not a Stop/model call.
   f.event({ type: "agent_end", messages: [] });
  };
  f.seconds = () => Number(document.querySelector(".working-label")?.textContent.match(/(\d+)s/)?.[1] ?? -1);
  f.remember = () => {
   f.row = document.querySelector(".working-row"); f.label = f.row?.querySelector(".working-label");
   f.mark = f.row?.querySelector(".working-mark"); f.jump = document.querySelector(".jump-to-latest");
   f.hostNode = document.querySelector(".status-working");
  };
  f.rect = e => {
   const r = e?.getBoundingClientRect();
   return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
  };
  f.geometry = () => {
   const rect = f.rect;
   const strip = document.querySelector(".status-strip"), scroller = document.querySelector(".messages");
   const rail = document.querySelector(".chat-activity"), row = document.querySelector(".working-row");
   const label = row?.querySelector(".working-label"), mark = row?.querySelector(".working-mark");
   const workingHost = document.querySelector(".status-working"), jump = document.querySelector(".jump-to-latest");
   const state = strip.querySelector(".live-label"), stats = strip.querySelector(".stats-label"), copy = strip.querySelector(".strip-icon");
   const style = e => e && getComputedStyle(e);
   const rowCSS = style(row), railCSS = style(rail), stateCSS = style(state), markCSS = style(mark);
   return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    chat: rect(document.querySelector(".chat-view")), composer: rect(document.querySelector(".composer-dock")),
    roster: rect(document.querySelector(".subagents-strip")), status: { ...rect(strip), scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth,
     flexWrap: style(strip).flexWrap, overflowX: style(strip).overflowX },
    messages: { ...rect(scroller), scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight,
     scrollHeight: scroller.scrollHeight, topOffset: scroller.scrollTop, gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop },
    host: workingHost ? { ...rect(workingHost), inStrip: workingHost.parentElement === strip, same: !f.hostNode || f.hostNode === workingHost } : null,
    rowCount: document.querySelectorAll(".working-row").length, floatingWorkingCount: rail.querySelectorAll(".working-row, .working-label, .working-mark").length,
    working: row ? { ...rect(row), active: row.classList.contains("active"), visible: rowCSS.visibility === "visible" && rowCSS.display !== "none",
     inStrip: strip.contains(row), inHost: row.parentElement === workingHost, inTranscript: scroller.contains(row), same: !f.row || f.row === row,
     ariaHidden: row.getAttribute("aria-hidden"), role: row.getAttribute("role"), name: row.getAttribute("aria-label"), live: row.getAttribute("aria-live"),
     tabIndex: row.tabIndex, pointerEvents: rowCSS.pointerEvents, borderWidths: [rowCSS.borderTopWidth, rowCSS.borderRightWidth, rowCSS.borderBottomWidth, rowCSS.borderLeftWidth],
     background: rowCSS.backgroundColor, backgroundImage: rowCSS.backgroundImage, label: label?.textContent, labelRect: rect(label),
     labelSame: !f.label || f.label === label, labelWhiteSpace: style(label)?.whiteSpace, labelScrollWidth: label?.scrollWidth, labelClientWidth: label?.clientWidth,
     markSame: !f.mark || f.mark === mark, markTag: mark?.tagName, markHidden: mark?.getAttribute("aria-hidden"), markTabIndex: mark?.tabIndex,
     markAnimation: markCSS?.animationName, markAnimationState: markCSS?.animationPlayState,
     animations: row.getAnimations({ subtree: true }).map(a => ({ state: a.playState, name: a.animationName })),
     focusTargets: row.querySelectorAll('button,a[href],input,textarea,select,[tabindex="0"]').length,
     liveAncestors: (() => { const a = []; for (let n = row; n; n = n.parentElement) {
      if (n.getAttribute("aria-live") && n.getAttribute("aria-live") !== "off") a.push(n.getAttribute("aria-live"));
     } return a; })(),
    } : null,
    stats: { ...rect(stats), text: stats.textContent, visible: style(stats).visibility === "visible" && style(stats).display !== "none" },
    state: { ...rect(state), text: state.textContent, title: state.title, overflow: stateCSS.overflowX, ellipsis: stateCSS.textOverflow,
     scrollWidth: state.scrollWidth, clientWidth: state.clientWidth, whiteSpace: stateCSS.whiteSpace },
    copy: { ...rect(copy), title: copy.title, visible: style(copy).visibility === "visible" && style(copy).display !== "none", disabled: copy.disabled },
    sessionId: { ...rect(strip.querySelector(".session-id")), display: style(strip.querySelector(".session-id")).display },
    rail: { ...rect(rail), position: railCSS.position, opacity: Number(railCSS.opacity), pointerEvents: railCSS.pointerEvents,
     transitionDuration: railCSS.transitionDuration, readingUp: rail.classList.contains("reading-up") },
    jumpCount: document.querySelectorAll(".jump-to-latest").length,
    jump: jump ? { ...rect(jump), visible: jump.classList.contains("visible") && style(jump).display !== "none", same: !f.jump || f.jump === jump,
     inRail: jump.parentElement === rail, name: jump.getAttribute("aria-label"), label: jump.textContent.trim(), tag: jump.tagName,
     pointerEvents: style(jump).pointerEvents, focused: document.activeElement === jump, focusVisible: jump.matches(":focus-visible"),
     outline: style(jump).outlineStyle, outlineWidth: style(jump).outlineWidth } : null,
   };
  };
  f.hold = () => {
   const scroller = document.querySelector(".messages"), top = scroller.getBoundingClientRect().top;
   const anchor = [...scroller.children].find(row => row.dataset.messageKey && row.getBoundingClientRect().bottom > top);
   const prose = [...scroller.querySelectorAll(".row-assistant .md")].filter(e => e.textContent.startsWith("Earlier reply ")).at(-1);
   const text = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT).nextNode();
   const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(18, text.textContent.length));
   getSelection().removeAllRanges(); getSelection().addRange(range);
   const tool = document.querySelector('[data-part="tool-working-tool"]');
   const input = tool.querySelector(".tool-section:not(.tool-result) pre"), result = tool.querySelector(".tool-result pre");
   input.scrollTop = 121; result.scrollTop = 87;
   f.held = { anchor, offset: anchor.getBoundingClientRect().top - top, tool, input, result, text, selection: getSelection().toString() };
   f.remember();
  };
  f.state = () => {
   const held = f.held, scroller = document.querySelector(".messages"), tool = document.querySelector('[data-part="tool-working-tool"]');
   return held ? { anchorConnected: held.anchor.isConnected, anchorOffset: held.anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    toolSame: held.tool === tool, inputSame: held.input === tool?.querySelector(".tool-section:not(.tool-result) pre"),
    resultSame: held.result === tool?.querySelector(".tool-result pre"), open: tool?.classList.contains("open"),
    inputTop: held.input.scrollTop, resultTop: held.result.scrollTop, selection: getSelection().toString(),
    selectionNodeSame: getSelection().anchorNode === held.text } : null;
  };
  f.sample = phase => {
   const s = { phase, time: performance.now(), seconds: f.seconds(), geometry: f.geometry(), state: f.state() };
   f.samples.push(s); return s;
  };
  new MutationObserver(() => {
   const label = document.querySelector(".working-label");
   if (label) {
    const text = label.textContent;
    if (f.ticks.at(-1)?.text !== text) f.ticks.push({ text, seconds: f.seconds(), time: performance.now(), labelSame: !f.label || f.label === label });
   }
  }).observe(document.querySelector("#app"), { subtree: true, childList: true, characterData: true });
  document.querySelector(".messages").addEventListener("wheel", event => f.wheels.push({ trusted: event.isTrusted, deltaY: event.deltaY }), { passive: true });
  document.addEventListener("click", event => f.clicks.push({ trusted: event.isTrusted, inJump: !!event.target.closest(".jump-to-latest") }), true);
  f.snapshot();
  if (streaming) f.begin();
  if (streaming && open) document.querySelector('[data-part="tool-working-tool"] .tool-toggle').click();
 }, { history, toolCode, streaming, open });
 await frames(page);
 const g = await geometry(page);
 assert.ok(g.messages.scrollHeight - g.messages.clientHeight > 1000, "fixture has a real overflowing transcript");
 assert.ok(g.messages.gap <= 1, "fixture starts at its real tail");
}
const geometry = page => page.evaluate(() => window.__working.geometry());
const sample = (page, phase) => page.evaluate(phase => window.__working.sample(phase), phase);
const waitSeconds = (page, seconds) => page.waitForFunction(seconds => window.__working.seconds() >= seconds, seconds);
function fits(inner, outer, label) {
 assert.ok(inner && outer, `${label}: both bounds exist`);
 assert.ok(inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1, `${label}: stays contained`);
}
function noOverlap(a, b, label) {
 const area = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
 assert.equal(area, 0, `${label}: does not overlap`);
}
function placed(g, label) {
 assert.ok(g.host?.inStrip, `${label}: stable .status-working host belongs to bottom status strip`);
 assert.equal(g.rowCount, 1, `${label}: exactly one Working timer`);
 assert.equal(g.floatingWorkingCount, 0, `${label}: no floating Working duplicate`);
 assert.ok(g.working?.inStrip && g.working.inHost && !g.working.inTranscript, `${label}: timer paints in status, not transcript`);
 fits(g.working, g.status, `${label}: compact timer`);
 fits(g.stats, g.status, `${label}: token count`);
 fits(g.copy, g.status, `${label}: conversation-copy action`);
 fits(g.state, g.status, `${label}: current state`);
 assert.equal(g.stats.visible, true, `${label}: tokens remain visible`);
 assert.match(g.stats.text, /tok/, `${label}: real token count is present`);
 assert.ok(g.copy.visible && !g.copy.disabled && g.copy.width > 0, `${label}: copy action stays usable`);
 assert.equal(g.status.flexWrap, "nowrap", `${label}: status never creates a new bottom row`);
 assert.equal(g.working.labelWhiteSpace, "nowrap", `${label}: compact seconds never wrap`);
 assert.ok(g.working.labelScrollWidth <= g.working.labelClientWidth + 1, `${label}: seconds fit their reservation`);
 for (const [a, b, name] of [[g.working, g.stats, "timer/tokens"], [g.working, g.state, "timer/state"], [g.working, g.copy, "timer/copy"], [g.stats, g.state, "tokens/state"], [g.copy, g.state, "copy/state"]]) noOverlap(a, b, `${label}: ${name}`);
}
function sameTimer(g, label) {
 for (const key of ["same", "labelSame", "markSame"]) assert.equal(g.working[key], true, `${label}: preserve timer ${key}`);
 assert.equal(g.host.same, true, `${label}: preserve status host`);
}
function stableGeometry(before, after, label) {
 for (const key of ["chat", "composer", "roster", "status", "host", "stats", "state", "copy"]) {
  for (const edge of ["left", "right", "top", "bottom", "width", "height"]) assert.equal(after[key][edge], before[key][edge], `${label}: no ${key}.${edge} drift`);
 }
 for (const edge of ["left", "right", "top", "bottom", "width", "height", "clientHeight", "scrollHeight", "topOffset", "gap"]) {
  assert.equal(after.messages[edge], before.messages[edge], `${label}: no transcript ${edge} drift`);
 }
 if (before.working && after.working) {
  assert.deepEqual(after.working.labelRect, before.working.labelRect, `${label}: timer digit reservation is fixed`);
  for (const edge of ["left", "right", "top", "bottom", "width", "height"]) assert.equal(after.working[edge], before.working[edge], `${label}: no timer ${edge} drift`);
 }
}
async function detach(page, amount = -460) {
 const b = await page.locator(".messages").boundingBox();
 await page.mouse.move(b.x + 3, b.y + b.height / 2);
 await page.mouse.wheel(0, amount);
 await page.waitForFunction(() => {
  const e = document.querySelector(".messages");
  return e.scrollHeight - e.clientHeight - e.scrollTop > 100 && document.querySelector(".jump-to-latest")?.classList.contains("visible");
 });
 await frames(page);
 assert.ok(await page.evaluate(() => window.__working.wheels.some(e => e.trusted && e.deltaY < 0)), "detachment uses native trusted upward wheel input");
}
function retained(before, after, label) {
 assert.equal(after.anchorConnected, true, `${label}: reading anchor stays mounted`);
 assert.ok(Math.abs(after.anchorOffset - before.anchorOffset) <= 1, `${label}: reading anchor does not move`);
 for (const key of ["toolSame", "inputSame", "resultSame", "open", "selectionNodeSame"]) assert.equal(after[key], true, `${label}: preserve ${key}`);
 for (const key of ["inputTop", "resultTop", "selection"]) assert.equal(after[key], before[key], `${label}: preserve ${key}`);
}
async function focusJumpByTab(page) {
 await page.evaluate(() => {
  // Preservation was already checked while reading. Deliberate keyboard
  // navigation now clears the selection's independent browser tab origin.
  getSelection().removeAllRanges();
  const jump = document.querySelector(".jump-to-latest");
  const focusable = [...document.querySelectorAll('button,a[href],input,textarea,summary,[tabindex]')].filter(e =>
   e.tabIndex >= 0 && !e.disabled && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().height > 0);
  const index = focusable.indexOf(jump);
  if (index <= 0) throw new Error("Missing sequential tab predecessor for native jump test");
  focusable[index - 1].focus({ preventScroll: true });
 });
 // Chromium also makes overflowing native code panes sequential focus
 // targets. Traverse those real stops, instead of inventing tabindex values.
 let reached = false;
 for (let i = 0; i < 8; i++) {
  await page.keyboard.press("Tab");
  reached = await page.evaluate(() => {
   const active = document.activeElement;
   (window.__working.tabTargets ??= []).push({ tag: active?.tagName, className: active?.className });
   return active?.classList.contains("jump-to-latest");
  });
  if (reached) break;
 }
 assert.equal(reached, true, "bounded native Tab traversal reaches floating New messages");
 await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-activity")).opacity) >= .99);
 const g = await geometry(page);
 assert.ok(g.jump.focusVisible && g.jump.outline !== "none" && parseFloat(g.jump.outlineWidth) > 0, "native Tab exposes a real visible jump focus ring");
 fits(g.jump, g.chat, "focused native jump");
}
async function following(page, label) {
 await frames(page);
 let g = await geometry(page);
 assert.ok(g.messages.gap <= 1 && !g.jump.visible, `${label}: deliberate return resumes following at real bottom`);
 assert.equal(g.jump.same, true, `${label}: deliberate return keeps the native button node`);
 await page.evaluate(() => {
  const f = window.__working;
  const message = { role: "user", timestamp: 20000 + f.trailing.length, content: "Following after deliberate return. ".repeat(30) };
  f.trailing.push(message); f.event({ type: "message_start", message }); f.snapshot();
 });
 await frames(page); g = await geometry(page);
 assert.ok(g.messages.gap <= 1 && !g.jump.visible, `${label}: subsequent host growth still follows`);
 sameTimer(g, label);
}
async function run(name, config, test) {
 if (timedOut) return;
 const page = await browser.newPage({ viewport: config.viewport ?? { width: 460, height: 660 }, deviceScaleFactor: config.dpr ?? 1,
  reducedMotion: config.reducedMotion ?? "no-preference" });
 page.setDefaultTimeout(3500);
 const errors = [], unexpectedRequests = [];
 page.on("pageerror", error => errors.push(String(error)));
 await page.route("**/*", route => {
  const url = route.request().url();
  if (url.startsWith(`${origin}/`) || url.startsWith("data:")) return route.continue();
  unexpectedRequests.push(url); return route.abort();
 });
 let error = null;
 try {
  await seed(page, config);
  await test(page);
  assert.deepEqual(errors, [], "no uncaught webview errors");
  assert.deepEqual(unexpectedRequests, [], "only the in-memory local preview is accessed");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no caught host dispatch errors");
  const forbidden = await page.evaluate(() => postedMessages.filter(m => [
   "userFocus", "send", "prompt", "stop", "abort", "setModel", "setThinking", "setCompactThreshold", "setSteerDefault", "setSetting", "configure", "restart", "newSession",
  ].includes(m.type)));
  assert.deepEqual(forbidden, [], "no userFocus, daemon, model, settings, or run-control messages");
  console.log(`PASS ${name}`);
 } catch (caught) {
  failures++; error = String(caught.stack); console.error(`FAIL ${name}\n${error}`);
 } finally {
  const detail = await page.evaluate(() => window.__working ? {
   geometry: window.__working.geometry(), state: window.__working.state(), events: window.__working.events,
   wheels: window.__working.wheels, clicks: window.__working.clicks, ticks: window.__working.ticks, samples: window.__working.samples,
   tabTargets: window.__working.tabTargets, logicalClockOffset: window.__workingClockOffset, postedMessages,
  } : null).catch(() => null);
  await page.screenshot({ path: join(output, `${name}${error ? "-failed" : ""}.png`), timeout: 3500 }).catch(() => {});
  const artifact = join(output, `${name}.json`);
  reports.push({ name, pass: !error, error, artifact });
  await writeFile(artifact, JSON.stringify({ name, pass: !error, error, errors, unexpectedRequests, ...detail }, null, 2));
  await page.close();
 }
}
try {
 browser = await chromium.launch();
 await run("status-placement-compact-accessibility", {}, async page => {
  const g = await geometry(page); placed(g, "active initial timer");
  assert.equal(g.working.visible, true, "streaming timer is visible");
  assert.match(g.working.label, /^\d+s$/, "visible label is exactly elapsed seconds, not Working or a separator");
  assert.equal(g.working.role, "timer", "compact elapsed timer has timer semantics");
  assert.ok(g.working.name?.trim().length > 0, "timer has a meaningful accessible name");
  assert.equal(g.working.live, "off", "seconds do not create per-second announcements");
  assert.deepEqual(g.working.liveAncestors, [], "no live ancestor re-announces each timer tick");
  assert.equal(g.working.markHidden, "true", "decorative butterfly is hidden from assistive technology");
  assert.equal(g.working.markTag.toLowerCase(), "svg", "butterfly is the vector mark, not visible text or emoji");
  assert.equal(g.working.tabIndex, -1, "timer is not a focus target");
  assert.ok(g.working.markTabIndex < 0 && g.working.focusTargets === 0, "butterfly and seconds expose no focus targets");
  assert.equal(g.working.pointerEvents, "none", "timer is noninteractive");
  assert.ok(g.working.borderWidths.every(v => parseFloat(v) === 0), "no visible pill border");
  assert.equal(g.working.background, "rgba(0, 0, 0, 0)", "no pill background");
  assert.equal(g.working.backgroundImage, "none", "no background image replaces the pill");
  assert.ok(g.working.width < 80 && g.working.height <= g.status.height, "compact butterfly and seconds fit one existing status row");
  assert.notEqual(g.working.markAnimation, "none", "ordinary motion animates the working butterfly");
  assert.ok(g.working.animations.some(a => a.state === "running"), "native browser runs the butterfly animation");
  assert.equal(g.rail.position, "absolute", "only New messages keeps the existing floating rail");
  assert.equal(g.messages.clientHeight, Math.round(g.chat.height), "no new activity row consumes transcript height");
  const aria = await page.locator(".working-row").ariaSnapshot();
  assert.match(aria, /timer/, "native accessibility snapshot exposes the named timer");
  await sample(page, "compact-accessibility");
 });
 await run("continuous-native-timer-deliveries", {}, async page => {
  await page.evaluate(() => window.__working.remember());
  await waitSeconds(page, 1);
  const before = await sample(page, "first-native-second");
  assert.ok(before.seconds >= 1, "timer has advanced through a real one-second interval");
  for (const phase of ["text", "tool", "tool-end", "status", "snapshot", "repeat-start", "turn-end"]) {
   await page.evaluate(phase => {
    const f = window.__working;
    if (phase === "text") f.text();
    if (phase === "tool") f.grow();
    if (phase === "tool-end") f.event({ type: "tool_execution_end", toolCallId: "working-tool", toolName: "ipython", result: { output: "Completed tool output" }, isError: false });
    if (phase === "status") f.statusUpdate({ streaming: true, statusText: "Continuing the same run" });
    if (phase === "snapshot") { f.snapshot(); f.snapshot(); }
    if (phase === "repeat-start") { f.event({ type: "agent_start" }); f.event({ type: "agent_start" }); }
    if (phase === "turn-end") f.event({ type: "turn_end", message: f.live, toolResults: [] });
    f.sample(`delivery-${phase}`);
   }, phase);
   await frames(page);
   const s = await sample(page, `paint-${phase}`); placed(s.geometry, phase); sameTimer(s.geometry, phase);
   assert.ok(s.seconds >= before.seconds, `${phase}: elapsed time never restarts`);
   assert.ok(s.geometry.working.active && s.geometry.working.visible, `${phase}: timer stays continuously visible`);
  }
  await waitSeconds(page, before.seconds + 1);
  const after = await sample(page, "second-native-tick-after-deliveries");
  assert.ok(after.time - before.time >= 700, "continuity spans a further native tick, not only synchronous samples");
  assert.ok(after.seconds > before.seconds, "the original native interval continues after all delivery kinds");
  const ticks = await page.evaluate(() => window.__working.ticks);
  assert.ok(ticks.every(t => t.labelSame), "all recorded native timer mutations retain the seconds element");
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].seconds >= ticks[i - 1].seconds, "every observed delivery/tick remains monotonic");
 });
 await run("idle-start-end-abort-session-reset", { streaming: false }, async page => {
  // Keep the state word fixed here so first-mount reservation is measured
  // independently of the legitimate live -> running label-width change.
  await page.evaluate(() => window.__working.statusUpdate({ statusText: "Lifecycle fixture" }));
  await frames(page);
  const idle = await geometry(page);
  assert.ok(idle.host?.inStrip, "first idle mount reserves the status host without inventing an active run");
  assert.ok(!idle.working || !idle.working.visible, "first idle view has no visible working timer");
  await page.evaluate(() => {
   const f = window.__working; f.hostNode = document.querySelector(".status-working");
   f.status.streaming = true; f.event({ type: "agent_start" }); f.remember();
  });
  await frames(page);
  const start = await geometry(page); placed(start, "first run");
  assert.equal(start.working.label, "0s", "first run starts at zero elapsed seconds");
  stableGeometry(idle, start, "first start has no status/composer/transcript layout cost");
  await waitSeconds(page, 1);
  await page.evaluate(() => { const f = window.__working; f.finish(); f.snapshot(); f.snapshot(); });
  await frames(page);
  const ended = await sample(page, "completed-paused"); sameTimer(ended.geometry, "completed run");
  assert.equal(ended.geometry.working.visible, false, "completion hides the timer");
  assert.equal(ended.geometry.working.ariaHidden, "true", "completed timer is hidden from assistive technology");
  assert.ok(ended.geometry.working.animations.every(a => a.state !== "running"), "completion pauses butterfly motion");
  await observeFramesFor(page, 1150);
  assert.equal((await sample(page, "completed-after-native-interval-opportunity")).seconds, ended.seconds, "hidden completed timer does not tick");
  await page.evaluate(() => window.__working.begin()); await frames(page);
  let g = await geometry(page); sameTimer(g, "next run in the same session");
  assert.equal(g.working.label, "0s", "next run resets the same seconds element to zero");
  await waitSeconds(page, 1);
  await page.evaluate(() => { const f = window.__working; f.finish("aborted"); f.statusUpdate({ streaming: false }); f.snapshot(); });
  await frames(page); const aborted = await sample(page, "host-abort-paused");
  assert.equal(aborted.geometry.working.visible, false, "host abort lifecycle hides the timer");
  sameTimer(aborted.geometry, "host abort");
  await observeFramesFor(page, 1150);
  assert.equal((await sample(page, "aborted-after-native-interval-opportunity")).seconds, aborted.seconds, "aborted run does not tick");
  await page.evaluate(() => {
   const f = window.__working; f.status.sessionId = "working-status-new-session"; f.status.sessionName = "Fresh session";
   f.history = []; f.live = null; f.result = null; f.trailing = []; f.snapshot();
  });
  await frames(page); g = await geometry(page);
  assert.ok(!g.working || !g.working.visible, "new idle session never inherits a previous working run");
  assert.equal(g.host.same, true, "new session retains the bottom status host");
  await page.evaluate(() => { window.__working.begin(); window.__working.remember(); }); await frames(page);
  g = await geometry(page); placed(g, "new session run");
  assert.equal(g.working.label, "0s", "new session elapsed time starts at zero");
 });
 await run("reserved-geometry-native-digit-rollovers", {}, async page => {
  await page.evaluate(() => window.__working.remember());
  await waitSeconds(page, 1);
  const before = await sample(page, "geometry-one-native-second"); placed(before.geometry, "reserved status slot");
  for (const seconds of [9, 10, 99, 100, 999, 1000]) {
   // Advance wall-clock elapsed time, never the interval or the DOM. The next
   // actual browser interval renders the requested digit-width boundary.
   await page.evaluate(seconds => { window.__workingClockOffset += (seconds - window.__working.seconds() - 1) * 1000; }, seconds);
   await waitSeconds(page, seconds); await frames(page);
   const s = await sample(page, `native-digit-${seconds}`);
   assert.equal(s.seconds, seconds, `${seconds}: real interval rendered exact requested elapsed label`);
   assert.equal(s.geometry.working.label, `${seconds}s`, `${seconds}: compact label stays exact`);
   placed(s.geometry, `${seconds}s`); sameTimer(s.geometry, `${seconds}s`);
   stableGeometry(before.geometry, s.geometry, `${seconds}s native timer tick`);
  }
 });
 await run("detached-reader-native-floating-jump", { open: true }, async page => {
  await detach(page);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-activity")).opacity) < .25);
  await page.evaluate(() => window.__working.hold());
  await waitSeconds(page, 1);
  const before = await sample(page, "detached-reading-held");
  assert.ok(before.state.inputTop > 50 && before.state.resultTop > 50 && before.state.selection.length > 0, "fixture holds real selection and two native inner scroll panes");
  for (let i = 0; i < 4; i++) {
   await page.evaluate(i => {
    const f = window.__working; f.text(); f.grow(); f.statusUpdate({ streaming: true }); f.snapshot(); f.snapshot(); f.sample(`reader-delivery-${i}`);
   }, i);
   await frames(page);
   const s = await sample(page, `reader-paint-${i}`); retained(before.state, s.state, `reader ${i}`);
   placed(s.geometry, `reader ${i}`); sameTimer(s.geometry, `reader ${i}`);
   assert.ok(s.geometry.messages.gap > 100 && s.geometry.rail.opacity < .25, "host traffic cannot cancel detached faded reading intent");
   assert.equal(s.geometry.working.visible, true, "bottom timer remains visible even while floating New messages is faded");
   assert.ok(s.geometry.jump.same && s.geometry.jump.inRail && s.geometry.jump.visible, "exact native New messages node stays floating");
  }
  let g = await geometry(page);
  assert.equal(g.jumpCount, 1, "only one native New messages button exists");
  assert.equal(g.jump.tag, "BUTTON", "floating return control remains a native button");
  assert.equal(g.jump.label, "New messages", "floating return keeps its visible label");
  assert.equal(g.jump.name, "New messages — jump to bottom", "floating return keeps its accessible name");
  assert.ok(g.messages.scrollHeight > before.geometry.messages.scrollHeight + 50, "host fixture really grew while reading stayed detached");
  assert.equal(g.rail.position, "absolute", "return control remains floating");
  assert.equal(g.rail.pointerEvents, "none", "floating rail never intercepts transcript inspection");
  assert.equal(g.jump.pointerEvents, "auto", "only the native jump button receives floating input");
  await focusJumpByTab(page);
  const focused = await sample(page, "native-jump-focused");
  await page.evaluate(() => { const f = window.__working; f.grow(); f.snapshot(); f.snapshot(); }); await frames(page);
  g = await geometry(page);
  assert.ok(g.jump.focused && g.jump.same && g.rail.opacity >= .99, "host deliveries preserve focused native button and full focus visibility");
  assert.equal(g.working.visible, true, "native focus does not alter working status visibility");
  await page.keyboard.press("Enter"); await following(page, "native keyboard return");
  await detach(page); await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-activity")).opacity) < .25);
  await page.locator(".jump-to-latest").click(); await following(page, "native pointer return");
  assert.ok(await page.evaluate(() => window.__working.clicks.some(e => e.trusted && e.inJump)), "pointer return is a trusted native click");
  assert.ok(focused.geometry.jump.focusVisible, "focus verification recorded the keyboard affordance");
 });
 await run("narrow-theme-scaled-font-dense-containment", { dpr: 2 }, async page => {
  await page.evaluate(() => window.__working.remember());
  const variants = [
   { name: "narrow-dark", theme: "vscode-dark", width: 280, height: 640, font: 14 },
   { name: "narrow-light", theme: "vscode-light", width: 320, height: 640, font: 16 },
   { name: "highcontrast-scaled", theme: "vscode-high-contrast", width: 280, height: 680, font: 20 },
   { name: "large-vscode-font", theme: "vscode-dark", width: 420, height: 720, font: 24 },
   { name: "dense-embedded-panel", theme: "vscode-light", width: 920, panelWidth: 280, height: 620, font: 18, dense: true },
  ];
  for (const variant of variants) {
   await page.setViewportSize({ width: variant.width, height: variant.height });
   await page.evaluate(variant => {
    const light = variant.theme === "vscode-light";
    document.body.className = variant.theme;
    for (const [name, value] of Object.entries({ "--vscode-font-size": `${variant.font}px`, "--vscode-sideBar-background": light ? "#f3f3f3" : variant.theme === "vscode-high-contrast" ? "#000000" : "#181818",
     "--vscode-foreground": light ? "#333333" : "#eeeeee", "--vscode-descriptionForeground": light ? "#616161" : "#aaaaaa" })) document.body.style.setProperty(name, value);
    document.querySelector("#app").style.width = variant.panelWidth ? `${variant.panelWidth}px` : "";
    const f = window.__working;
    f.statusUpdate({ statusText: "Still running while a long tool/provider status is available in full. ".repeat(4) });
    if (variant.dense) {
     host({ type: "draft", text: Array.from({ length: 8 }, (_, i) => `Unsent composer line ${i}`).join("\n") });
     host({ type: "sessionChildren", children: Array.from({ length: 16 }, (_, i) => ({ id: `dense-child-${i}`, activeSessionId: `dense-session-${i}`, name: `Worker ${i}`, status: "idle", isStreaming: false })) });
     document.querySelector(".subagents-header")?.click();
     host({ type: "installPrompt", url: "https://example.invalid/install", reason: "Dense-panel fixture" });
    }
   }, variant);
   await frames(page);
   const s = await sample(page, variant.name); placed(s.geometry, variant.name); sameTimer(s.geometry, variant.name);
   const g = s.geometry;
   assert.equal(g.pageOverflow, 0, `${variant.name}: no horizontal page scroll`);
   assert.ok(g.status.scrollWidth <= g.status.clientWidth + 1, `${variant.name}: status children stay contained`);
   assert.ok(g.messages.scrollWidth <= g.messages.clientWidth + 1, `${variant.name}: transcript stays contained`);
   fits(g.status, { left: 0, right: variant.panelWidth ?? variant.width, top: 0, bottom: variant.height }, `${variant.name}: bottom status row remains visible`);
   assert.ok(g.sessionId.display === "none" || g.sessionId.width <= 1, `${variant.name}: session id yields first in narrow panel`);
   assert.equal(g.state.title, g.state.text, `${variant.name}: full long state is available in its title`);
   assert.equal(g.state.ellipsis, "ellipsis", `${variant.name}: long state ellipsizes`);
   assert.equal(g.state.overflow, "hidden", `${variant.name}: long state cannot escape its slot`);
   assert.equal(g.state.whiteSpace, "nowrap", `${variant.name}: state does not create another bottom row`);
   assert.ok(g.state.scrollWidth > g.state.clientWidth, `${variant.name}: fixture actually exercises truncated long state`);
   assert.equal(g.viewport.dpr, 2, `${variant.name}: scaled native pixels are exercised`);
  }
 });
 await run("reduced-motion-static-butterfly", { reducedMotion: "reduce" }, async page => {
  const before = await sample(page, "reduced-motion-active"); placed(before.geometry, "reduced-motion active timer");
  assert.equal(before.geometry.working.markAnimation, "none", "reduced motion removes the working butterfly animation");
  assert.deepEqual(before.geometry.working.animations, [], "native reduced-motion timer subtree has no animations");
  assert.ok(before.geometry.rail.transitionDuration.split(",").every(v => parseFloat(v) === 0), "reduced motion also leaves floating jump opacity changes static");
  await waitSeconds(page, 1);
  const after = await sample(page, "reduced-motion-native-tick");
  assert.ok(after.seconds >= 1, "static butterfly does not stop the real elapsed timer");
  assert.equal(after.geometry.working.markAnimation, "none", "native timer tick never restarts reduced-motion animation");
  assert.deepEqual(after.geometry.working.animations, [], "no tick creates hidden motion under reduced motion");
 });
} finally {
 clearTimeout(deadline);
 const sourceAfter = manifest(await sourceInputs());
 const generatedAfter = manifest(await generatedInputs());
 const testAfter = sha(await readFile(fileURLToPath(import.meta.url)));
 const proof = { sourceRef: sourceRef ?? "working-tree", resolvedRef, testFile: relative(root, fileURLToPath(import.meta.url)),
  testHashBefore: testBefore, testHashAfter: testAfter, sourceBefore, sourceAfter,
  sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
  generatedBefore, generatedAfter, generatedUnchanged: JSON.stringify(generatedBefore) === JSON.stringify(generatedAfter),
  testUnchanged: testBefore === testAfter, bundleHash: sha(bundle.outputFiles[0].contents), browser: browser?.version(),
  durationMs: Math.round(performance.now() - began), timedOut, reports };
 await writeFile(join(output, "source-proof.json"), JSON.stringify(proof, null, 2));
 await browser?.close();
 await new Promise(resolve => server.close(resolve));
 if (!proof.sourceUnchanged || !proof.generatedUnchanged || !proof.testUnchanged) {
  failures++; console.error("FAIL: source, test, or generated asset hashes changed during proof; see source-proof.json");
 }
 console.log(`SOURCE ${sourceBefore.sha256} -> ${sourceAfter.sha256}; TEST ${testBefore}; artifacts ${output}`);
}
console.log(`${reports.filter(r => r.pass).length}/${reports.length} native working status scenarios passed`);
process.exitCode = failures ? 1 : 0;
