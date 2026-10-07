/**
 * Trusted desktop wheel + fast tool-stream stress against the real webview.
 * Usage: node test/scroll-stream-stress.test.mjs
 * Optional historical source: SCROLL_STRESS_SOURCE_REF=11ba0a0 node test/scroll-stream-stress.test.mjs
 * Optional scenario filter: SCROLL_STRESS_ONLY='result pane' node test/scroll-stream-stress.test.mjs
 *
 * Bundle TypeScript/CSS in memory. Never write media/main.js, start a daemon,
 * launch an agent, or spend model tokens. The preview supplies only the host shim.
 * All reader gestures under test use page.mouse.wheel, not synthetic WheelEvents.
 * scrollTop assignments are confined to nested-pane fixture preparation.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRef = process.env.SCROLL_STRESS_SOURCE_REF;
const only = process.env.SCROLL_STRESS_ONLY && new RegExp(process.env.SCROLL_STRESS_ONLY);
const git = promisify(execFile);
async function source(path) {
 if (!sourceRef) return readFile(path);
 const { stdout } = await git("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
 return Buffer.from(stdout);
}
const bundle = await build({
 absWorkingDir: root, entryPoints: ["webview/main.ts"], bundle: true, write: false,
 format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("scroll-stream-stress-test") },
 plugins: sourceRef ? [{ name: "historical-source", setup(api) {
  api.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({ contents: (await source(path)).toString(), loader: "ts" }));
 }}] : [],
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
let scenarios = 0;
let trustedWheels = 0;
const reports = [];
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
 cost: { input: .001, output: .002, cacheRead: 0, cacheWrite: 0, total: .003 } };
const lines = (prefix, count = 120) => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n");
function history(count = 40) {
 return Array.from({ length: count }, (_, i) => i % 2 ? {
  role: "assistant", timestamp: 1000 + i, responseId: `history-response-${i}`, stopReason: "stop",
  content: [{ type: "text", text: `History reply ${i}. ` + "Stable earlier words for the desktop reader. ".repeat(14) }],
 } : { role: "user", timestamp: 1000 + i, content: `History question ${i}` });
}
const frames = (page, count = 4) => page.evaluate(async n => {
 for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
}, count);
const metrics = page => page.$eval(".messages", e => ({ top: e.scrollTop, max: e.scrollHeight - e.clientHeight,
 gap: e.scrollHeight - e.clientHeight - e.scrollTop, rows: e.querySelectorAll(":scope > .row").length }));
const indicator = page => page.evaluate(() => {
 const e = document.querySelector(".jump-to-latest");
 return !!e && e.classList.contains("visible") && getComputedStyle(e).display !== "none";
});
async function hoverOuter(page) {
 const box = await page.locator(".messages").boundingBox();
 // Padding avoids nested scrolling panes even when a tool fills the viewport.
 await page.mouse.move(box.x + 3, box.y + box.height * .48);
}
async function seed(page, messages = history()) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.evaluate(({ messages, usage }) => {
  const outer = document.querySelector(".messages");
  window.__durable = messages;
  window.__status = { ...baseStatus, sessionId: "trusted-wheel-stress-session", streaming: true };
  window.__tick = 0; window.__seq = 0; window.__phase = 0; window.__live = null; window.__lastFinal = null;
  window.__stats = { events: 0, snapshots: 0, starts: 0, deltas: 0, results: 0, empties: 0, replays: 0 };
  window.__trace = []; window.__wheelAudit = []; window.__anchor = null; window.__watchFrames = false;
  window.__sample = label => {
   const anchor = window.__anchor;
   const value = { label, tick: window.__tick, top: outer.scrollTop, max: outer.scrollHeight - outer.clientHeight,
    gap: outer.scrollHeight - outer.clientHeight - outer.scrollTop,
    connected: !!anchor?.isConnected,
    anchor: anchor?.isConnected ? anchor.getBoundingClientRect().top - outer.getBoundingClientRect().top : null };
   window.__trace.push(value); return value;
  };
  window.__markAnchor = () => {
   const b = outer.getBoundingClientRect();
   window.__anchor = [...outer.children].filter(r => r.dataset.messageKey).find(r => {
    const rb = r.getBoundingClientRect(); return rb.bottom > b.top + 3 && rb.top < b.bottom;
   });
   if (!window.__anchor) throw new Error("Fixture needs an actual visible history row");
   window.__trace.length = 0; return window.__sample("anchor-mark");
  };
  window.__event = event => {
   window.__stats.events++;
   host({ type: "event", event });
   if (window.__anchor) window.__sample(`event:${event.type}`);
  };
  window.__snapshot = ({ includeLive = true, changeAbove = false } = {}) => {
   if (changeAbove) window.__durable[0].content += " Resync growth above the reading anchor. ".repeat(8);
   const messages = [...window.__durable, ...(includeLive && window.__live ? [window.__live] : [])];
   window.__stats.snapshots++;
   host({ type: "snapshot", messages: structuredClone(messages), state: null, status: { ...window.__status } });
   if (window.__anchor) window.__sample(`snapshot:${includeLive ? "with-live" : "omitted-live"}`);
  };
  window.__replay = () => {
   if (window.__lastFinal) {
    window.__stats.replays++;
    window.__event({ type: "message_start", message: window.__lastFinal });
    window.__event({ type: "message_update", message: { ...window.__lastFinal, stopReason: undefined, usage: undefined } });
    window.__event({ type: "message_end", message: window.__lastFinal });
   }
   if (window.__live) {
    window.__event({ type: "message_start", message: window.__live });
    window.__event({ type: "message_update", message: window.__live });
   }
  };
  window.__step = () => {
   const n = ++window.__tick;
   if (window.__phase === 0) {
    const id = `stress-tool-${++window.__seq}`;
    window.__live = { role: "assistant", timestamp: 100000 + window.__seq * 10,
     responseId: `stress-response-${window.__seq}`, content: [] };
    window.__toolId = id; window.__code = ""; window.__output = "";
    window.__stats.empties++;
    window.__event({ type: "message_start", message: window.__live });
   } else if (window.__phase === 1) {
    window.__live.content = [{ type: "toolCall", id: window.__toolId, name: "ipython", arguments: {} }];
    window.__stats.starts++;
    window.__event({ type: "message_update", message: window.__live,
     assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
    window.__event({ type: "tool_execution_start", toolCallId: window.__toolId, toolName: "ipython", args: {} });
   } else if (window.__phase < 6) {
    window.__code += `value_${n} = compute(${n})\n` + `# streamed input ${n}\n`.repeat(5);
    window.__output += `result ${n}: streaming output below reader\n`.repeat(8);
    window.__live.content[0].arguments = { code: window.__code };
    window.__stats.deltas++;
    window.__event({ type: "message_update", message: window.__live,
     assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: `chunk ${n}` } });
    window.__event({ type: "tool_execution_update", toolCallId: window.__toolId, toolName: "ipython",
     args: { code: window.__code }, partialResult: { output: window.__output } });
   } else {
    const final = { ...window.__live, stopReason: "toolUse", usage };
    window.__lastFinal = structuredClone(final);
    window.__event({ type: "message_end", message: final });
    window.__event({ type: "tool_execution_end", toolCallId: window.__toolId, toolName: "ipython",
     result: { output: window.__output + "Final result complete\n" }, isError: false });
    window.__stats.results++;
    window.__durable.push(structuredClone(final), { role: "toolResult", timestamp: final.timestamp + 1,
     toolCallId: window.__toolId, toolName: "ipython", content: [{ type: "text", text: window.__output + "Final result complete\n" }], isError: false });
    window.__live = null;
    window.__event({ type: "turn_end" });
   }
   window.__phase = (window.__phase + 1) % 7;
  };
  window.__burst = (count = 28, snapshots = true) => {
   for (let i = 0; i < count; i++) {
    window.__step();
    if (snapshots && i % 5 === 4) {
     window.__snapshot({ includeLive: i % 2 === 0 }); window.__replay();
    }
   }
  };
  window.__custom = count => {
   for (let i = 0; i < count; i++) {
    const message = { role: "custom", customType: "agent_message", display: true,
     timestamp: 200000 + ++window.__tick, content: `Worker notice ${window.__tick}. ` + "Durable output below reader. ".repeat(5) };
    window.__durable.push(message); window.__event({ type: "message_start", message });
   }
  };
  // This listener runs AFTER the production scroller/pane wheel listeners and
  // still in the SAME trusted event task. No frame or native scroll notification
  // can rescue a guard which follows during any event in the burst.
  window.addEventListener("wheel", event => {
   if (!outer.contains(event.target)) return;
   const before = window.__sample("wheel-before");
   const start = window.__trace.length;
   const pane = event.target.closest("pre");
   const paneBefore = pane?.scrollTop ?? null;
   window.__onWheel?.(event);
   const after = window.__sample("wheel-after");
   window.__wheelAudit.push({ trusted: event.isTrusted, delta: event.deltaY,
    target: event.target.tagName, before, after, taskSamples: window.__trace.slice(start),
    paneBefore, paneAfter: pane?.scrollTop ?? null });
  }, { passive: true });
  // Capture before the production target listener, inspect in a later target
  // listener. Native DOM events can run a microtask checkpoint between listeners,
  // so queueMicrotask from capture would inspect too early.
  window.__loads = []; window.__loadStart = null; window.__scrollAudit = [];
  outer.addEventListener("scroll", event => {
   const jump = document.querySelector(".jump-to-latest");
   window.__scrollAudit.push({trusted:event.isTrusted,top:outer.scrollTop,max:outer.scrollHeight-outer.clientHeight,
    gap:outer.scrollHeight-outer.clientHeight-outer.scrollTop,tick:window.__tick,
    jump:!!jump?.classList.contains("visible"),anchor:window.__anchor?.isConnected?
     window.__anchor.getBoundingClientRect().top-outer.getBoundingClientRect().top:null});
  });
  window.addEventListener("scroll", event => {
   if (event.target !== outer) return;
   const top = outer.getBoundingClientRect().top;
   const anchor = [...outer.querySelectorAll(":scope > .row")].find(r => r.getBoundingClientRect().bottom > top + 3);
   window.__loadStart = { rows: outer.querySelectorAll(":scope > .row").length, anchor,
    before: anchor?.getBoundingClientRect().top - top };
  }, true);
  outer.addEventListener("scroll", event => {
   const { rows, anchor, before } = window.__loadStart ?? {};
   const nextRows = outer.querySelectorAll(":scope > .row").length;
   if (nextRows > rows) window.__loads.push({ trusted: event.isTrusted, rows, nextRows, before,
    after: anchor?.isConnected ? anchor.getBoundingClientRect().top - outer.getBoundingClientRect().top : null });
  });
  window.__snapshot(); window.__event({ type: "agent_start" });
 }, { messages, usage });
 await frames(page);
 assert.ok((await metrics(page)).max > 1500, "fixture must overflow by multiple desktop screens");
 assert.ok((await metrics(page)).gap <= 2, "new session must start at tail");
}
async function markAnchor(page) { return page.evaluate(() => window.__markAnchor()); }
async function watchFrames(page) {
 await page.evaluate(() => {
  window.__watchFrames = true;
  const sample = () => { if (!window.__watchFrames) return; window.__sample("rAF"); requestAnimationFrame(sample); };
  requestAnimationFrame(sample);
 });
}
async function readTrace(page) { return page.evaluate(() => { window.__watchFrames = false; return window.__trace; }); }
function assertHeld(trace, before, label, { growth = true } = {}) {
 assert.ok(trace.length > 10, `${label}: need per-event and per-frame samples`);
 assert.ok(trace.every(s => s.connected && s.anchor !== null), `${label}: actual visible row reference was lost`);
 const drift = Math.max(...trace.map(s => Math.abs(s.anchor - before.anchor)));
 assert.ok(drift < 2, `${label}: visible history anchor drift ${drift}px; first bad sample ${JSON.stringify(trace.find(s => Math.abs(s.anchor - before.anchor) >= 2))}`);
 if (growth) assert.ok(trace.at(-1).max > before.max + 100, `${label}: output must really grow the outer transcript`);
 return drift;
}
async function detach(page, delta = -300) {
 await hoverOuter(page); await page.mouse.wheel(0, delta); await frames(page);
 const after = await metrics(page);
 assert.ok(after.gap >= Math.abs(delta) - 2, `trusted wheel must really detach: ${JSON.stringify(after)}`);
 assert.equal(await indicator(page), true, "detached reader sees New messages");
 return after;
}
async function frameBurst(page, count = 18, batch = 5, changeAbove = false) {
 await page.evaluate(async ({ count, batch, changeAbove }) => {
  for (let i = 0; i < count; i++) {
   await new Promise(requestAnimationFrame); window.__burst(batch);
   if (i % 3 === 0) window.__snapshot({ includeLive: i % 2 === 0, changeAbove });
   window.__sample("stream-frame");
  }
 }, { count, batch, changeAbove });
 await frames(page);
}
async function wheelAudit(page) { return page.evaluate(() => window.__wheelAudit); }
function assertWheelTaskHeld(audit, label) {
 assert.equal(audit.trusted, true, `${label}: actual Chromium input, not dispatchEvent`);
 assert.ok(audit.delta < 0, `${label}: upward wheel intent`);
 assert.ok(audit.taskSamples.length >= 15, `${label}: rapid stream must run in that wheel task`);
 assert.ok(audit.before.connected && audit.taskSamples.every(s => s.connected && s.anchor !== null),
  `${label}: a snapshot must not disconnect the actual visible reading anchor during wheel delivery`);
 const drift = Math.max(...audit.taskSamples.map(s => Math.abs(s.anchor - audit.before.anchor)));
 assert.ok(drift < 2, `${label}: same trusted wheel task moved anchor ${drift}px before rAF; ${JSON.stringify(audit.taskSamples.find(s => Math.abs(s.anchor - audit.before.anchor) >= 2))}`);
 assert.ok(Math.abs(audit.after.top - audit.before.top) < 2, `${label}: following must stop before native wheel scroll arrives`);
 return drift;
}
async function hoverPane(page, selector) {
 const point = await page.$eval(selector, pane => {
  let r = pane.getBoundingClientRect();
  let left = r.left, right = r.right, top = r.top, bottom = r.bottom;
  for (let node = pane.parentElement; node; node = node.parentElement) {
   const s = getComputedStyle(node);
   if (s.overflowY !== "visible" || s.overflowX !== "visible") {
    r = node.getBoundingClientRect(); left = Math.max(left, r.left); right = Math.min(right, r.right);
    top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
   }
  }
  if (bottom - top < 10 || right - left < 10) throw new Error("Nested pane must be genuinely visible to receive a mouse wheel");
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
 });
 await page.mouse.move(point.x, point.y);
}
async function nestedSeed(page, paneKind) {
 await seed(page);
 await page.evaluate(({ code, output, paneKind }) => {
  window.__nested = { role: "assistant", timestamp: 500000, responseId: "nested-live-response",
   content: [{ type: "toolCall", id: "nested-live-tool", name: "ipython", arguments: { code } }] };
  window.__nestedCode = code; window.__nestedOutput = output;
  window.__event({ type: "message_start", message: window.__nested });
  window.__event({ type: "tool_execution_start", toolCallId: "nested-live-tool", toolName: "ipython", args: { code } });
  window.__event({ type: "tool_execution_update", toolCallId: "nested-live-tool", partialResult: { output } });
  const card = document.querySelector('[data-part="tool-nested-live-tool"]');
  card.querySelector(".tool-toggle").click();
  window.__pane = paneKind === "input" ? card.querySelector(".tool-body pre") : card.querySelector(".tool-result pre");
  window.__nestedBody = card.querySelector(".tool-body");
  // Fixture preparation only. All detaching/resuming after this uses real input.
  window.__nestedBody.scrollTop = paneKind === "result" ? window.__nestedBody.scrollHeight : 0;
  window.__pane.scrollTop = window.__pane.scrollHeight;
  window.__nestedGrow = () => {
   window.__nestedCode += `\n# new input line ${++window.__tick}`;
   window.__nestedOutput += `\nnew output line ${window.__tick}`;
   window.__nested.content[0].arguments.code = window.__nestedCode;
   window.__event({ type: "message_update", message: window.__nested });
   window.__event({ type: "tool_execution_update", toolCallId: "nested-live-tool", partialResult: { output: window.__nestedOutput } });
  };
 }, { code: lines("# nested input"), output: lines("nested output"), paneKind });
 await frames(page);
 const state = await page.evaluate(() => ({ top: window.__pane.scrollTop,
  max: window.__pane.scrollHeight - window.__pane.clientHeight, outer: document.querySelector(".messages").scrollTop }));
 assert.ok(state.max > 600 && Math.abs(state.top - state.max) < 2, "nested fixture overflows and starts at its tail");
 return state;
}
async function run(name, test, viewport = { width: 420, height: 620 }) {
 if (only && !only.test(name)) return;
 scenarios++;
 const page = await browser.newPage({ viewport }); page.setDefaultTimeout(6000);
 const errors = []; page.on("pageerror", error => errors.push(String(error)));
 try {
  const details = await test(page) ?? {};
  assert.deepEqual(errors, [], "no page errors");
  console.log(`PASS  ${name} ${JSON.stringify(details)}`);
  reports.push({ name, pass: true, details });
 } catch (error) {
  failures++;
  console.error(`FAIL  ${name}\n  ${error.stack}`);
  const diagnostic = await page.evaluate(() => ({
   metrics: (e => ({top:e.scrollTop,max:e.scrollHeight-e.clientHeight,gap:e.scrollHeight-e.clientHeight-e.scrollTop,rows:e.querySelectorAll(":scope > .row").length}))(document.querySelector(".messages")),
   wheels: window.__wheelAudit?.map(({trusted,delta,target,before,after,paneBefore,paneAfter})=>({trusted,delta,target,before,after,paneBefore,paneAfter})),
   traceFirst:window.__trace?.slice(0,3),traceLast:window.__trace?.slice(-3),loads:window.__loads,
   fullTrace:window.__trace,scrolls:window.__scrollAudit,
   productionAnchor:window.__anchor?.dataset.messageKey,
   pane:window.__pane?{top:window.__pane.scrollTop,max:window.__pane.scrollHeight-window.__pane.clientHeight,follow:window.__pane.dataset.follow}:null,
  })).catch(()=>null);
  if(process.env.SCROLL_STRESS_DIAGNOSTICS)await writeFile(process.env.SCROLL_STRESS_DIAGNOSTICS,
   JSON.stringify([...reports.filter(r=>!r.pass),{name,pass:false,error:String(error),diagnostic}],null,2));
  const {fullTrace,...preview}=diagnostic??{};
  console.error(`  diagnostic=${JSON.stringify(preview)}`);
  reports.push({ name, pass: false, error: String(error), diagnostic });
 } finally {
  const audit = await wheelAudit(page).catch(() => []);
  trustedWheels += audit.filter(w => w.trusted).length;
  const stats = await page.evaluate(() => window.__stats ?? {}).catch(() => ({}));
  console.log(`  input=${audit.filter(w => w.trusted).length} trusted wheel(s), stats=${JSON.stringify(stats)}`);
  await page.close();
 }
}
try {
 browser = await chromium.launch();
 for (const magnitude of [24, 49, 51]) await run(`trusted upward ${magnitude}px wheel wins tool args + snapshot in the same task`, async page => {
  await seed(page); await markAnchor(page);
  await page.evaluate(() => { window.__onWheel = event => { if (event.deltaY < 0) window.__burst(28); }; });
  await hoverOuter(page); await page.mouse.wheel(0, -magnitude); await frames(page);
  const audit = (await wheelAudit(page)).at(-1);
  const taskDrift = assertWheelTaskHeld(audit, "tiny outer wheel");
  const initial = await page.evaluate(() => window.__trace[0]);
  assert.ok((await metrics(page)).top <= initial.top - magnitude + 2, "native wheel must move up, not merely detach the lock");
  await page.evaluate(() => { window.__onWheel = null; });
  const before = await markAnchor(page); await watchFrames(page);
  await frameBurst(page, 12, 6, true);
  const drift = assertHeld(await readTrace(page), before, "off-tail stream after tiny wheel");
  assert.equal(await indicator(page), true, "a wheel up within 50px does NOT resume itself on growth");
  return { taskDrift, heldDrift: drift, trusted: audit.trusted, wheel: audit.delta };
 });
 for (const viewport of [{ width: 420, height: 620 }, { width: 900, height: 720 }]) {
  await run(`continuous upward desktop wheel stays monotonic during tool transitions (${viewport.width}px)`, async page => {
   await seed(page); const before = await markAnchor(page); await watchFrames(page);
   await page.evaluate(() => {
    window.__onWheel = event => { if (event.deltaY < 0) window.__burst(7); };
    window.__pumpActive = true; window.__pumpFrames = 0;
    const pump = () => {
     if (!window.__pumpActive || ++window.__pumpFrames > 100) return;
     window.__burst(3); window.__sample("pump-frame"); requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
   });
   await hoverOuter(page);
   for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -72); await frames(page, 2); }
   await page.evaluate(() => { window.__pumpActive = false; window.__onWheel = null; }); await frames(page);
   const trace = await readTrace(page), audit = await wheelAudit(page);
   const afterFirstWheel = trace.slice(trace.findIndex(s => s.label === "wheel-before"));
   assert.ok(afterFirstWheel.every(s => s.connected && s.anchor !== null), "stream/resync must preserve the actual row being scrolled upward");
   const down = Math.max(0, ...afterFirstWheel.slice(1).map((s, i) => s.top - afterFirstWheel[i].top));
   const visualDown = Math.max(0, ...afterFirstWheel.slice(1).map((s, i) => afterFirstWheel[i].anchor - s.anchor));
   assert.ok(down < 2 && visualDown < 2, `negative wheels fought by output: scroll down=${down}px, visible anchor down=${visualDown}px`);
   // Chromium may apply the first compositor scroll before DOM wheel delivery.
   // The first audited wheel-before can therefore already include its 72px.
   assert.ok(afterFirstWheel.at(-1).anchor >= afterFirstWheel[0].anchor + 640, "remaining nine native wheels must move the actual visible content upward");
   for (const w of audit) assertWheelTaskHeld(w, "continuous wheel");
   assert.equal(await indicator(page), true);
   return { trusted: audit.length, downDrift: down, visualDownDrift: visualDown, upwardMovement: afterFirstWheel.at(-1).anchor - afterFirstWheel[0].anchor,
    outerGrowth: trace.at(-1).max - before.max };
  }, viewport);
 }
 await run("detached visible row stays within 2px through fast lifecycle, catchup, and changed-above replay", async page => {
  await seed(page); await detach(page, -480); const before = await markAnchor(page); await watchFrames(page);
  await frameBurst(page, 28, 7, true);
  const trace = await readTrace(page); const drift = assertHeld(trace, before, "tool lifecycle/catchup");
  const stats = await page.evaluate(() => window.__stats);
  assert.ok(stats.empties >= 28 && stats.results >= 28 && stats.snapshots > 30 && stats.replays > 25, "all real transitions must render");
  assert.equal(await indicator(page), true);
  return { heldDrift: drift, events: stats.events, snapshots: stats.snapshots, completedTools: stats.results };
 });
 for (const paneKind of ["input", "result"]) for (const magnitude of [2, 24]) await run(`nested ${paneKind} pane upward ${magnitude}px wheel beats immediate streaming before scroll notification`, async page => {
  const initial = await nestedSeed(page, paneKind); await markAnchor(page);
  await page.evaluate(() => { window.__onWheel = event => { if (event.deltaY < 0) for (let i = 0; i < 8; i++) window.__nestedGrow(); }; });
  const selector = paneKind === "input" ? '[data-part="tool-nested-live-tool"] .tool-body pre' : '[data-part="tool-nested-live-tool"] .tool-result pre';
  await hoverPane(page, selector); await page.mouse.wheel(0, -magnitude); await frames(page);
  const audit = (await wheelAudit(page)).at(-1);
  assert.equal(audit.trusted, true, "nested scroll comes from real browser input");
  assert.equal(audit.target, "PRE", "pointer must hit the intended nested pane, not outer padding");
  assert.ok(Math.abs(audit.paneAfter - audit.paneBefore) < 2,
   `upward intent must stop nested auto-follow synchronously: ${audit.paneBefore} -> ${audit.paneAfter} before native scroll`);
  const state = await page.evaluate(() => ({ pane: window.__pane.scrollTop, outer: document.querySelector(".messages").scrollTop }));
  assert.ok(state.pane <= initial.top - magnitude + 1, "actual nested wheel moves code/output up");
  assert.ok(Math.abs(state.outer - audit.before.top) < 2, "nested pane absorbs the wheel without outer scroll");
  await page.evaluate(() => { window.__onWheel = null; });
  const held = state.pane;
  await page.evaluate(async () => {
   for (let i = 0; i < 18; i++) { await new Promise(requestAnimationFrame); window.__nestedGrow(); }
  }); await frames(page);
  const end = await page.evaluate(() => window.__pane.scrollTop);
  assert.ok(Math.abs(end - held) < 2, `nested ${paneKind} scroll must hold during subsequent live updates: ${held} -> ${end}`);
  return { taskPaneDrift: audit.paneAfter - audit.paneBefore, heldPaneDrift: end - held, trusted: audit.trusted };
 });
 for (const paneKind of ["input", "result"]) await run(`nested ${paneKind} pane tiny upward wheel stays detached after native scroll then delayed output`, async page => {
  const initial=await nestedSeed(page,paneKind);
  const selector=paneKind==="input"?'[data-part="tool-nested-live-tool"] .tool-body pre':'[data-part="tool-nested-live-tool"] .tool-result pre';
  await hoverPane(page,selector);
  // Do not grow during wheel delivery. Let the browser's own scroll event run
  // while the 2px user movement is still inside the geometric 4px tail margin.
  await page.mouse.wheel(0,-2);await frames(page,5);
  const before=await page.evaluate(()=>({top:window.__pane.scrollTop,max:window.__pane.scrollHeight-window.__pane.clientHeight,follow:window.__pane.dataset.follow}));
  assert.ok(Math.abs(before.top-(initial.top-2))<1,"trusted tiny wheel must really scroll the nested pane before delayed output");
  const audit=(await wheelAudit(page)).at(-1);
  assert.equal(audit.trusted,true);assert.equal(audit.target,"PRE");
  const positions=await page.evaluate(async()=>{
   const positions=[];
   for(let i=0;i<12;i++){
    await new Promise(requestAnimationFrame);window.__nestedGrow();
    positions.push({top:window.__pane.scrollTop,follow:window.__pane.dataset.follow});
   }
   return positions;
  });await frames(page);
  const drift=Math.max(...positions.map(p=>Math.abs(p.top-before.top)));
  assert.ok(drift<2,`upward pane intent must survive native scroll notification at <=4px, not resume on delayed stream: before=${JSON.stringify(before)} first=${JSON.stringify(positions[0])} maxDrift=${drift}px`);
  // A later deliberate downward return must still re-enable pane following.
  // Use exactly its current gap so this does not overscroll into the outer view.
  const gap=await page.evaluate(()=>window.__pane.scrollHeight-window.__pane.clientHeight-window.__pane.scrollTop);
  await page.mouse.wheel(0,gap);await frames(page,4);
  await page.evaluate(async()=>{for(let i=0;i<6;i++){await new Promise(requestAnimationFrame);window.__nestedGrow();}});await frames(page);
  const resumed=await page.evaluate(()=>window.__pane.scrollHeight-window.__pane.clientHeight-window.__pane.scrollTop);
  assert.ok(resumed<2,"explicit downward pane return must resume live following");
  assert.equal(await indicator(page),true,"pane return is still not an outer return to latest");
  return {heldPaneDrift:drift,trusted:audit.trusted,tailGapBeforeGrowth:before.max-before.top,resumedPaneGap:resumed};
 });
 await run("nested native scroll does not re-enable the detached outer reader on downward pane wheel", async page => {
  await nestedSeed(page, "input"); await markAnchor(page);
  const selector = '[data-part="tool-nested-live-tool"] .tool-body pre';
  await hoverPane(page, selector); await page.mouse.wheel(0, -120); await frames(page);
  const before = await markAnchor(page);
  await page.evaluate(() => { window.__onWheel = event => { if (event.deltaY > 0) window.__custom(6); }; });
  await page.mouse.wheel(0, 40); await frames(page);
  const audit = (await wheelAudit(page)).at(-1);
  assert.equal(audit.target, "PRE"); assert.equal(audit.trusted, true);
  const drift = Math.abs(audit.after.anchor - audit.before.anchor);
  assert.ok(drift < 2, `scrolling DOWN inside code must not make outer follow new messages: anchor moved ${drift}px`);
  assert.equal(await indicator(page), true, "nested scroll is not an explicit outer return to latest");
  return { heldDrift: drift, outerGrowth: audit.after.max - before.max };
 });
 await run("long history native upward wheel lazy-loads with visual anchor compensation and survives resync", async page => {
  await seed(page, history(720));
  assert.equal((await metrics(page)).rows, 150, "initial tail window must be real");
  await hoverOuter(page); await page.mouse.wheel(0, -1000000); await frames(page, 6);
  const loads = await page.evaluate(() => window.__loads);
  assert.ok(loads.length >= 1 && loads.some(l => l.nextRows === 250), "trusted wheel must actually trigger lazy history loading");
  for (const load of loads) {
   assert.equal(load.trusted, true, "native scroll event, not assigned top + synthetic scroll");
   assert.notEqual(load.after, null, "visible loaded-window anchor survives");
   assert.ok(Math.abs(load.after - load.before) < 2, `older-load moved visible content ${load.after - load.before}px`);
  }
  const before = await markAnchor(page); await watchFrames(page);
  await frameBurst(page, 14, 5, true);
  const drift = assertHeld(await readTrace(page), before, "loaded long history");
  assert.ok((await metrics(page)).rows > 250, "loaded rows remain present while tools append");
  assert.equal(await indicator(page), true);
  return { loads: loads.length, loadDrift: Math.max(...loads.map(l => Math.abs(l.after - l.before))), heldDrift: drift };
 });
 await run("pruned long-running history never drops the detached visible anchor or resumes from growth", async page => {
  await seed(page, history(320));
  await page.evaluate(() => window.__custom(630)); await frames(page);
  assert.equal(await page.locator(".pruned-bar").count(), 1, "fixture must really prune old rendered rows at tail");
  assert.ok((await metrics(page)).gap <= 2, "tail follows through legitimate pruning");
  await detach(page, -380); const before = await markAnchor(page); await watchFrames(page);
  await page.evaluate(() => { window.__custom(230); window.__snapshot(); });
  await frameBurst(page, 12, 7);
  const drift = assertHeld(await readTrace(page), before, "pruned off-tail history");
  const rendered = await page.locator(".messages > [data-message-key]").count();
  assert.ok(rendered > 600, "detached reader must postpone pruning rather than delete their anchor");
  assert.equal(await indicator(page), true);
  return { heldDrift: drift, renderedRows: rendered, marker: await page.locator(".pruned-bar").textContent() };
 });
 await run("authoritative shrink/clamp keeps detachment; growth cannot return until real downward wheel", async page => {
  await seed(page); await page.evaluate(() => window.__custom(12)); await frames(page);
  await detach(page, -300);
  await page.evaluate(() => { window.__durable = window.__durable.slice(0, -5); window.__snapshot(); }); await frames(page);
  assert.ok((await metrics(page)).gap <= 2, "removing tail rows must physically clamp to the new bottom");
  assert.equal(await indicator(page), true, "layout clamp is not reader intent to return");
  const before = await markAnchor(page); await watchFrames(page); await frameBurst(page, 12, 7);
  const drift = assertHeld(await readTrace(page), before, "growth after forced clamp");
  assert.equal(await indicator(page), true, "new output after clamp must NOT resume following by itself");
  await hoverOuter(page); await page.mouse.wheel(0, (await metrics(page)).gap - 40); await frames(page);
  assert.ok((await metrics(page)).gap <= 50, "native downward wheel explicitly returns near tail");
  await frameBurst(page, 8, 7);
  assert.ok((await metrics(page)).gap <= 2, "following resumes only after deliberate downward return");
  assert.equal(await indicator(page), false);
  return { growthHeldDrift: drift, trusted: (await wheelAudit(page)).length };
 });
 for (const gap of [49, 50, 51]) await run(`explicit downward outer wheel to ${gap}px tail ${gap <= 50 ? "resumes" : "stays detached"}`, async page => {
  await seed(page); await detach(page, -300);
  await hoverOuter(page); await page.mouse.wheel(0, (await metrics(page)).gap - gap); await frames(page);
  const reached = await metrics(page);
  assert.ok(Math.abs(reached.gap - gap) < 2, `real wheel must land at requested boundary: ${JSON.stringify(reached)}`);
  const before = await markAnchor(page); await watchFrames(page); await frameBurst(page, 10, 7);
  const trace = await readTrace(page);
  if (gap <= 50) {
   assert.ok((await metrics(page)).gap <= 2, `explicit downward return <=50px must resume tail following`);
   assert.equal(await indicator(page), false);
  } else {
   assertHeld(trace, before, "51px downward return remains off-tail");
   assert.equal(await indicator(page), true);
  }
  return { actualGapBeforeGrowth: reached.gap, finalGap: (await metrics(page)).gap, trusted: (await wheelAudit(page)).length };
 });
 await run("600 loaded rows and large tool payload stay responsive during trusted upward wheel", async page => {
  await seed(page, history(600)); await hoverOuter(page);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -1000000); await frames(page, 4); }
  assert.equal((await metrics(page)).rows, 600, "all 600 history rows must actually be rendered, not only held as data");
  // Move into the settled 600-row transcript with native input. Leave enough
  // rows above/below that repeated upward wheels cannot clamp during this run.
  await page.mouse.wheel(0, 3000); await frames(page);
  const before = await markAnchor(page); await watchFrames(page);
  await page.evaluate(({code,output})=>{
   window.__perfMessage={role:"assistant",timestamp:700000,responseId:"perf-live-response",
    content:[{type:"toolCall",id:"perf-live-tool",name:"ipython",arguments:{code}}]};
   window.__perfCode=code;window.__perfOutput=output;window.__timings=[];window.__frameGaps=[];
   window.__perfHost=(label,data)=>{
    const started=performance.now();host(data);const ms=performance.now()-started;
    window.__timings.push({label,ms});
   };
   window.__perfHost("initial-large-message",{type:"event",event:{type:"message_start",message:window.__perfMessage}});
   window.__perfHost("initial-large-start",{type:"event",event:{type:"tool_execution_start",toolCallId:"perf-live-tool",toolName:"ipython",args:{code}}});
   window.__perfHost("initial-large-result",{type:"event",event:{type:"tool_execution_update",toolCallId:"perf-live-tool",partialResult:{output}}});
   document.querySelector('[data-part="tool-perf-live-tool"] .tool-toggle').click();
   window.__perfUpdate=()=>{
    const n=++window.__tick;
    window.__perfCode+=`\necho 'new decorated input ${n}'`;
    window.__perfOutput+=`\nnew large result line ${n}`;
    window.__perfMessage.content[0].arguments.code=window.__perfCode;
    window.__perfHost("stream-args",{type:"event",event:{type:"message_update",message:window.__perfMessage}});
    window.__perfHost("stream-output",{type:"event",event:{type:"tool_execution_update",toolCallId:"perf-live-tool",partialResult:{output:window.__perfOutput}}});
    window.__perfHost("600-row-rehydrate",{type:"snapshot",messages:structuredClone([...window.__durable,window.__perfMessage]),state:null,status:{...window.__status}});
    window.__sample("perf-update");
   };
   window.__onWheel=event=>{if(event.deltaY<0)window.__perfUpdate();};
   window.__perfActive=true;window.__perfFrames=0;window.__lastPerfFrame=null;
   const pump=timestamp=>{
    if(!window.__perfActive||++window.__perfFrames>24)return;
    if(window.__lastPerfFrame!==null)window.__frameGaps.push(timestamp-window.__lastPerfFrame);
    window.__lastPerfFrame=timestamp;window.__perfUpdate();requestAnimationFrame(pump);
   };
   requestAnimationFrame(pump);
  },{code:"%%bash\n"+lines("echo 'large decorated input line'",1500),output:lines("large multiline output",2000)});
  for(let i=0;i<10;i++){await page.mouse.wheel(0,-48);await frames(page,2);}
  await page.evaluate(()=>{window.__perfActive=false;window.__onWheel=null;});await frames(page);
  const got=await page.evaluate(()=>({timings:window.__timings,frames:window.__frameGaps,decorated:document.querySelectorAll('[data-part="tool-perf-live-tool"] .term-line').length,
   input:window.__perfCode.length,output:window.__perfOutput.length}));
  assert.ok(got.decorated>=1500,"large input must actually build the production shell-decorated spans");
  const recurring=got.timings.filter(t=>!t.label.startsWith("initial"));
  const slow=recurring.filter(t=>t.ms>100);
  const worst=Math.max(...recurring.map(t=>t.ms)),worstFrame=Math.max(...got.frames);
  console.log(`  responsiveness=${JSON.stringify({inputBytes:got.input,outputBytes:got.output,decoratedLines:got.decorated,samples:recurring.length,worstHostMs:worst,worstFrameMs:worstFrame,over100ms:slow})}`);
  assert.ok(slow.length<2,`recurring main-thread stream/rehydrate >100ms (${slow.length} calls): ${JSON.stringify(slow)}`);
  const trace=await readTrace(page);
  const down=Math.max(0,...trace.slice(1).map((s,i)=>s.top-trace[i].top));
  assert.ok(down<2,"large-payload output cannot fight upward wheels");
  assert.equal(await indicator(page),true);
  return {worstHostMs:worst,worstFrameMs:worstFrame,over100ms:slow.length,trusted:(await wheelAudit(page)).length,rows:(await metrics(page)).rows,
   anchorBefore:before.anchor,downDrift:down};
 });
} finally {
 await browser?.close();
 await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log(`\n${failures ? `${failures}/${scenarios} failing` : `All ${scenarios} passing`} trusted-wheel streaming browser scenarios (${trustedWheels} trusted wheels)${sourceRef ? ` source=${sourceRef}` : " latest-source"}`);
process.exitCode = failures ? 1 : 0;
