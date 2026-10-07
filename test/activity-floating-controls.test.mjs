/**
 * Floating activity controls against a real Chromium webview source bundle.
 * No generated bundle is overwritten. No daemon, model, or userFocus is used.
 *
 * node test/activity-floating-controls.test.mjs
 * SOURCE_REF=v1.0.48 ACTIVITY_FLOATING_OUTPUT=/tmp/prime-inline-activity/red node test/activity-floating-controls.test.mjs
 * ACTIVITY_FLOATING_OUTPUT=/tmp/prime-inline-activity/green node test/activity-floating-controls.test.mjs
 *
 * Seven bounded scenarios. The existing scroll suites own the full 49/50/51px
 * near-tail matrix; this suite tests the controls, not another follow engine.
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
const output = process.env.ACTIVITY_FLOATING_OUTPUT ?? "/tmp/prime-inline-activity";
const git = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function gitText(args) {
 const { stdout } = await git("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
 return stdout;
}
async function walk(directory) {
 const entries = await readdir(join(root, directory), { withFileTypes: true });
 const paths = await Promise.all(entries.map(e => e.isDirectory() ? walk(`${directory}/${e.name}`) : [`${directory}/${e.name}`]));
 return paths.flat();
}
async function sourceInputs() {
 const directories = ["webview", "src", "media", "agent-extension"];
 const paths = sourceRef
  ? (await gitText(["ls-tree", "-r", "--name-only", sourceRef, "--", ...directories])).trim().split("\n")
  : (await Promise.all(directories.map(walk))).flat();
 const selected = paths.filter(path => /\.(ts|css|html)$/.test(path)).sort();
 const entries = await Promise.all(selected.map(async path => [path, sourceRef
  ? Buffer.from(await gitText(["show", `${sourceRef}:${path}`]))
  : await readFile(join(root, path))]));
 return new Map(entries);
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
 const entries = await Promise.all(paths.sort().map(async path => {
  try { return [path, await readFile(join(root, path))]; }
  catch (error) { if (error.code === "ENOENT") return [path, Buffer.from("MISSING")]; throw error; }
 }));
 return new Map(entries);
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
 define: { PRIME_AGENT_BUILD_REV: JSON.stringify("activity-floating-source-test") },
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
const frames = (page, n = 3) => page.evaluate(async n => {
 for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
}, n);
const history = Array.from({ length: 24 }, (_, i) => i % 2 ? {
 role: "assistant", timestamp: 1000 + i, responseId: `floating-history-${i}`, stopReason: "stop",
 content: [{ type: "text", text: `Earlier reply ${i}. ` + "Stable readable transcript words. ".repeat(18) }],
} : { role: "user", timestamp: 1000 + i, content: `Earlier question ${i}` });
const toolCode = Array.from({ length: 100 }, (_, i) => `value_${i} = compute(${i})`).join("\n");

async function seed(page, { theme = "vscode-dark", streaming = true, open = false } = {}) {
 await page.goto(`${origin}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.waitForSelector(".boot-splash", { state: "detached" });
 await page.evaluate(({ history, toolCode, theme, streaming, open }) => {
  document.body.className = theme;
  document.body.style.setProperty("--vscode-font-size", "14px");
  document.body.style.setProperty("--vscode-sideBar-background", theme === "vscode-light" ? "#f3f3f3" : theme === "vscode-high-contrast" ? "#000000" : "#181818");
  document.body.style.setProperty("--vscode-foreground", theme === "vscode-light" ? "#333333" : "#eeeeee");
  document.body.style.setProperty("--vscode-descriptionForeground", theme === "vscode-light" ? "#616161" : "#aaaaaa");
  const scroller = document.querySelector(".messages");
  const fixture = window.__floating = {
   history, live: null, trailing: [], result: null, outputLines: 120,
   status: { ...baseStatus, sessionId: "floating-controls-session", sessionName: "Floating activity test", streaming },
   events: [], wheels: [], clicks: [], samples: [], jump: null, working: null, held: null,
  };
  fixture.event = event => {
   fixture.events.push({ type: event.type, toolCallId: event.toolCallId });
   host({ type: "event", event: structuredClone(event) });
  };
  fixture.snapshot = () => {
   fixture.events.push({ type: "snapshot", streaming: fixture.status.streaming });
   host({ type: "snapshot", state: null, status: fixture.status, messages: structuredClone([
    ...fixture.history, ...(fixture.live ? [fixture.live] : []), ...(fixture.result ? [fixture.result] : []), ...fixture.trailing,
   ]) });
  };
  fixture.grow = i => {
   fixture.outputLines += 6;
   fixture.event({ type: "tool_execution_update", toolCallId: "floating-tool", partialResult: {
    output: Array.from({ length: fixture.outputLines }, (_, j) => `Streamed result line ${j}`).join("\n"),
   } });
   const message = { role: "custom", customType: "floating-probe", timestamp: 10000 + i, display: true, content: `New live continuation ${i}.` };
   fixture.trailing.push(message);
   fixture.event({ type: "message_start", message });
  };
  fixture.finish = () => {
   if (fixture.live) {
    fixture.live.stopReason = "toolUse";
    fixture.event({ type: "message_end", message: fixture.live });
    const text = Array.from({ length: fixture.outputLines }, (_, i) => `Streamed result line ${i}`).join("\n");
    fixture.event({ type: "tool_execution_end", toolCallId: "floating-tool", result: { output: text }, isError: false });
    fixture.result = { role: "toolResult", timestamp: 9001, toolCallId: "floating-tool", toolName: "ipython", content: [{ type: "text", text }] };
   }
   fixture.status.streaming = false;
   fixture.event({ type: "agent_end" });
  };
  fixture.rect = e => {
   const r = e?.getBoundingClientRect();
   return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null;
  };
  fixture.geometry = () => {
   const rect = fixture.rect;
   const scroller = document.querySelector(".messages"), chat = document.querySelector(".chat-view");
   const rail = document.querySelector(".chat-activity"), working = document.querySelector(".working-row"), jump = document.querySelector(".jump-to-latest");
   const railCSS = getComputedStyle(rail), jumpCSS = jump && getComputedStyle(jump), workCSS = working && getComputedStyle(working);
   const clip = (a, b) => {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right), top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, right, top, bottom, width: right - left, height: bottom - top } : null;
   };
   const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
   const visibleChat = clip(rect(chat), viewport);
   const jumpVisible = !!jump && jump.classList.contains("visible") && jumpCSS.display !== "none";
   const workingVisible = !!working && workCSS.visibility === "visible";
   const paintJump = jumpVisible ? clip(rect(jump), visibleChat) : null;
   const paintWorking = workingVisible ? clip(rect(working), visibleChat) : null;
   const middle = box => box && ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
   const hit = point => {
    const node = point && document.elementFromPoint(point.x, point.y);
    return node ? { point, tag: node.tagName, className: node.className, inChat: chat.contains(node), inRail: rail.contains(node),
     inWorking: !!working?.contains(node), inJump: !!jump?.contains(node), inComposer: !!node.closest(".composer-dock"), inRoster: !!node.closest(".subagents-strip") } : null;
   };
   const rawJump = rect(jump), rawWork = rect(working);
   return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    chat: { ...rect(chat), clientHeight: chat.clientHeight, overflowX: getComputedStyle(chat).overflowX, overflowY: getComputedStyle(chat).overflowY },
    messages: { ...rect(scroller), clientHeight: scroller.clientHeight, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
     scrollHeight: scroller.scrollHeight, topOffset: scroller.scrollTop, gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop },
    composer: rect(document.querySelector(".composer-dock")), roster: rect(document.querySelector(".subagents-strip")),
    topbar: rect(document.querySelector(".topbar")), status: rect(document.querySelector(".status-strip")), install: rect(document.querySelector(".install-banner")),
    rail: { ...rect(rail), position: railCSS.position, display: railCSS.display, opacity: Number(railCSS.opacity), pointerEvents: railCSS.pointerEvents,
     transitionDuration: railCSS.transitionDuration, label: rail.getAttribute("aria-label"), hovered: rail.matches(":hover"),
     scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth },
    working: working ? { ...rawWork, visible: workingVisible, position: workCSS.position, pointerEvents: workCSS.pointerEvents,
     label: working.querySelector(".working-label")?.textContent, whiteSpace: getComputedStyle(working.querySelector(".working-label")).whiteSpace,
     ariaHidden: working.getAttribute("aria-hidden"), same: !fixture.working || fixture.working === working } : null,
    jump: jump ? { ...rawJump, visible: jumpVisible, position: jumpCSS.position, pointerEvents: jumpCSS.pointerEvents, whiteSpace: jumpCSS.whiteSpace,
     label: jump.textContent.trim(), ariaLabel: jump.getAttribute("aria-label"), title: jump.title, tag: jump.tagName, tabIndex: jump.tabIndex,
     focused: document.activeElement === jump, focusVisible: jump.matches(":focus-visible"), outlineStyle: jumpCSS.outlineStyle, outlineWidth: jumpCSS.outlineWidth,
     same: !fixture.jump || fixture.jump === jump } : null,
    count: document.querySelectorAll(".jump-to-latest").length,
    shared: !!jump && jump.parentElement === rail && (!working || working.parentElement === rail),
    workingFirst: !working || (working.parentElement === rail && rail.firstElementChild === working),
    paintJump, paintWorking, visibleChat, jumpHit: hit(middle(paintJump)), workingHit: hit(middle(paintWorking)),
    rawJumpHit: rawJump && rawJump.top >= 0 && rawJump.bottom <= innerHeight ? hit(middle(rawJump)) : null,
    rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
   };
  };
  fixture.hold = () => {
   const scroller = document.querySelector(".messages"), top = scroller.getBoundingClientRect().top;
   const anchor = [...scroller.children].find(row => row.dataset.messageKey && row.getBoundingClientRect().bottom > top);
   const prose = [...scroller.querySelectorAll(".row-assistant .md")].filter(e => !e.closest('[data-part="tool-floating-tool"]')).at(-1);
   const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
   const text = walker.nextNode();
   const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(18, text.textContent.length));
   getSelection().removeAllRanges(); getSelection().addRange(range);
   const tool = document.querySelector('[data-part="tool-floating-tool"]'), input = tool.querySelector(".tool-section:not(.tool-result) pre"), result = tool.querySelector(".tool-result pre");
   input.scrollTop = 121; result.scrollTop = 87;
   fixture.held = { anchor, offset: anchor.getBoundingClientRect().top - top, tool, input, result, text, selection: getSelection().toString() };
   fixture.jump = document.querySelector(".jump-to-latest"); fixture.working = document.querySelector(".working-row");
  };
  fixture.state = () => {
   const held = fixture.held, scroller = document.querySelector(".messages"), tool = document.querySelector('[data-part="tool-floating-tool"]');
   return held ? { anchorConnected: held.anchor.isConnected, anchorOffset: held.anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    toolSame: held.tool === tool, inputSame: held.input === tool?.querySelector(".tool-section:not(.tool-result) pre"),
    resultSame: held.result === tool?.querySelector(".tool-result pre"), open: tool?.classList.contains("open"),
    inputTop: held.input.scrollTop, resultTop: held.result.scrollTop, selection: getSelection().toString(),
    selectionNodeSame: getSelection().anchorNode === held.text, workingSeconds: Number(document.querySelector(".working-label")?.textContent.match(/(\d+)s/)?.[1] ?? -1) } : null;
  };
  fixture.sample = phase => fixture.samples.push({ phase, geometry: fixture.geometry(), state: fixture.state() });
  scroller.addEventListener("wheel", event => fixture.wheels.push({ trusted: event.isTrusted, deltaY: event.deltaY }), { passive: true });
  document.addEventListener("click", event => {
   const target = event.target;
   fixture.clicks.push({ trusted: event.isTrusted, className: target.className, inRail: !!target.closest(".chat-activity"), inJump: !!target.closest(".jump-to-latest"), inChat: !!target.closest(".chat-view") });
  }, true);
  fixture.snapshot();
  if (streaming) {
   fixture.event({ type: "agent_start" });
   fixture.live = { role: "assistant", timestamp: 9000, responseId: "floating-live-response", content: [
    { type: "text", text: "A live tool is still producing output." },
    { type: "toolCall", id: "floating-tool", name: "ipython", arguments: { code: toolCode } },
   ] };
   fixture.event({ type: "message_start", message: fixture.live });
   fixture.event({ type: "tool_execution_start", toolCallId: "floating-tool", toolName: "ipython", args: fixture.live.content[1].arguments });
   fixture.event({ type: "tool_execution_update", toolCallId: "floating-tool", partialResult: { output: Array.from({ length: fixture.outputLines }, (_, i) => `Streamed result line ${i}`).join("\n") } });
   if (open) document.querySelector('[data-part="tool-floating-tool"] .tool-toggle').click();
  }
 }, { history, toolCode, theme, streaming, open });
 await frames(page);
 const g = await geometry(page);
 assert.ok(g.messages.scrollHeight - g.messages.clientHeight > 1000, "fixture has a real overflowing transcript");
 assert.ok(g.messages.gap <= 1, "initial session lands at its real tail");
}
const geometry = page => page.evaluate(() => window.__floating.geometry());
async function sample(page, phase) {
 return page.evaluate(phase => {
  window.__floating.sample(phase);
  return window.__floating.samples.at(-1);
 }, phase);
}
async function detach(page, amount = -380) {
 const box = await page.locator(".messages").boundingBox();
 assert.ok(box.height > 100, "trusted wheel fixture has a usable chat viewport");
 // Use outer padding, never a nested code/output pane or the floating button.
 await page.mouse.move(box.x + 3, box.y + box.height / 2);
 await page.mouse.wheel(0, amount);
 await page.waitForFunction(() => {
  const e = document.querySelector(".messages");
  return e.scrollHeight - e.clientHeight - e.scrollTop > 100;
 });
 await frames(page);
 assert.ok((await geometry(page)).jump?.visible, "trusted upward input detaches and offers New messages");
 assert.ok(await page.evaluate(() => window.__floating.wheels.some(e => e.trusted && e.deltaY < 0)), "upward input is a real trusted Chromium wheel");
}
async function faded(page) {
 await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-activity")).opacity) < .25);
 await frames(page);
}
async function normal(page) {
 await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-activity")).opacity) > .8);
 await frames(page);
}
function fits(inner, outer, message) {
 if (!inner) return;
 assert.ok(inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1, message);
}
function overlap(a, b) {
 return a && b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0;
}
function floating(g, label, { working = true, clipped = false } = {}) {
 assert.equal(g.count, 1, `${label}: exactly one persistent New messages button`);
 assert.equal(g.shared, true, `${label}: New messages and Working share .chat-activity`);
 assert.equal(g.workingFirst, true, `${label}: Working stays left, including idle-before-start order`);
 assert.equal(g.rail.position, "absolute", `${label}: activity floats without an extra layout row`);
 assert.equal(g.rail.pointerEvents, "none", `${label}: rail does not intercept transcript clicks`);
 assert.equal(g.jump.position, "static", `${label}: jump flows within the shared floating row`);
 assert.equal(g.jump.pointerEvents, "auto", `${label}: only the visible jump button is interactive`);
 assert.equal(g.jump.same, true, `${label}: preserve the exact jump node`);
 assert.equal(g.jump.visible, true, `${label}: detached reader can jump`);
 assert.equal(g.jump.label, "New messages", `${label}: readable jump label`);
 assert.equal(g.jump.ariaLabel, "New messages — jump to bottom", `${label}: accessible jump name`);
 assert.equal(g.rail.label, "Agent activity", `${label}: accessible activity name`);
 assert.equal(g.chat.overflowX, "hidden", `${label}: clipped horizontal activity paint`);
 assert.equal(g.chat.overflowY, "hidden", `${label}: clipped vertical activity paint`);
 if (working) {
  assert.ok(g.working, `${label}: Working exists`);
  assert.equal(g.working.position, "static", `${label}: Working flows in the same rail`);
  assert.equal(g.working.pointerEvents, "none", `${label}: Working allows inspection underneath`);
  assert.equal(g.working.same, true, `${label}: preserve the exact Working node`);
  assert.ok(Math.abs((g.working.top + g.working.bottom) / 2 - (g.jump.top + g.jump.bottom) / 2) <= 1, `${label}: same Working/jump centerline`);
  assert.ok(g.working.right + 1 <= g.jump.left, `${label}: labels do not collide`);
  assert.equal(g.working.whiteSpace, "nowrap", `${label}: Working never wraps`);
 }
 assert.equal(g.jump.whiteSpace, "nowrap", `${label}: New messages never wraps`);
 for (const paint of [g.paintJump, g.paintWorking]) {
  fits(paint, g.chat, `${label}: painted controls stay inside chat`);
  assert.equal(overlap(paint, g.composer), 0, `${label}: paint does not cover composer`);
  assert.equal(overlap(paint, g.roster), 0, `${label}: paint does not cover roster`);
 }
 if (!clipped) {
  fits(g.jump, g.chat, `${label}: full jump fits available chat`);
  if (working) fits(g.working, g.chat, `${label}: full Working fits available chat`);
  assert.ok(overlap(g.rail, g.messages) > 0, `${label}: rail floats inside the transcript viewport`);
  assert.equal(g.messages.clientHeight, g.chat.clientHeight, `${label}: no 30px activity row consumes viewport`);
  assert.ok(Math.abs(g.messages.bottom - g.chat.bottom) <= 1, `${label}: transcript viewport reaches chat bottom`);
  assert.equal(g.jumpHit?.inJump, true, `${label}: visible jump is unobstructed and usable`);
  if (g.working?.visible) assert.equal(g.workingHit?.inRail, false, `${label}: Working lets pointer hit transcript underneath`);
 }
}
async function withoutRail(page, before, label) {
 // A display:none control proves this rail consumes no flex height. Compare
 // the same rendered source, not a hand-coded approximation of its layout.
 const style = await page.addStyleTag({ content: ".chat-activity { display: none !important; }" });
 try {
  await frames(page);
  const hidden = await geometry(page);
  for (const member of ["chat", "composer", "roster", "topbar", "status", "install"])
   assert.deepEqual(hidden[member], before[member], `${label}: removing floating paint does not displace ${member}`);
  for (const member of ["left", "right", "top", "bottom", "width", "height", "clientHeight", "scrollHeight"])
   assert.equal(hidden.messages[member], before.messages[member], `${label}: no activity layout cost in messages.${member}`);
 } finally { await style.evaluate(e => e.remove()); await frames(page); }
}
function held(before, after, label) {
 assert.equal(after.anchorConnected, true, `${label}: visible history anchor remains mounted`);
 assert.ok(Math.abs(after.anchorOffset - before.anchorOffset) <= 1, `${label}: visible history anchor does not move`);
 for (const key of ["toolSame", "inputSame", "resultSame", "open", "selectionNodeSame"])
  assert.equal(after[key], true, `${label}: preserve ${key}`);
 for (const key of ["inputTop", "resultTop", "selection"])
  assert.equal(after[key], before[key], `${label}: preserve ${key}`);
 assert.ok(after.workingSeconds >= before.workingSeconds, `${label}: working timer never restarts on host delivery`);
}
async function streamAndSnapshot(page, phase, count = 6) {
 await page.evaluate(async ({ phase, count }) => {
  const f = window.__floating;
  for (let i = 0; i < count; i++) {
   await new Promise(requestAnimationFrame);
   f.grow(f.trailing.length);
   f.sample(`${phase}-event-${i}`);
   f.snapshot(); f.snapshot();
   f.sample(`${phase}-snapshots-${i}`);
   await new Promise(requestAnimationFrame);
   f.sample(`${phase}-paint-${i}`);
  }
 }, { phase, count });
 await frames(page);
}
async function focusByTab(page) {
 await page.evaluate(() => {
  const jump = document.querySelector(".jump-to-latest");
  const focusable = [...document.querySelectorAll('button, a[href], input, textarea, [tabindex]')].filter(e =>
   e.tabIndex >= 0 && !e.disabled && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().height > 0);
  const index = focusable.indexOf(jump);
  if (index <= 0) throw new Error("Missing sequential tab predecessor for jump");
  focusable[index - 1].focus({ preventScroll: true });
 });
 await page.keyboard.press("Tab");
 await page.waitForFunction(() => document.activeElement?.classList.contains("jump-to-latest"));
 // Wait for the real 140ms transition to finish, not just its .8 crossing.
 await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".chat-activity")).opacity) >= .99);
 await frames(page);
 const g = await geometry(page);
 assert.equal(g.jump.focusVisible, true, "real Tab gives the jump a visible keyboard focus state");
 assert.notEqual(g.jump.outlineStyle, "none", "jump has a focus outline");
 assert.ok(parseFloat(g.jump.outlineWidth) > 0, "jump focus outline has visible width");
 assert.ok(g.rail.opacity >= .99, "focus-within restores full activity visibility");
 fits(g.jump, g.chat, "focused jump is not obscured");
 return g;
}
async function following(page, label) {
 await frames(page);
 let g = await geometry(page);
 assert.ok(g.messages.gap <= 1, `${label}: resumes following at the real bottom`);
 assert.equal(g.jump.visible, false, `${label}: hides the same jump node`);
 assert.equal(g.jump.same, true, `${label}: hiding does not recreate the jump`);
 await page.evaluate(() => {
  const f = window.__floating;
  const message = { role: "user", timestamp: 20000 + f.trailing.length, content: "New message after deliberate jump. " + "Following content. ".repeat(35) };
  f.trailing.push(message); f.event({ type: "message_start", message }); f.snapshot();
 });
 await frames(page); g = await geometry(page);
 assert.ok(g.messages.gap <= 1, `${label}: later host growth still follows`);
 assert.equal(g.jump.visible, false, `${label}: later growth does not restore detached control`);
}
async function run(name, config, test) {
 const page = await browser.newPage({ viewport: config.viewport ?? { width: 420, height: 620 }, deviceScaleFactor: config.dpr ?? 1,
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
  assert.deepEqual(errors, [], "no webview runtime errors");
  assert.deepEqual(unexpectedRequests, [], "only the in-memory local preview is accessed");
  assert.equal(await page.locator(".pa-handler-error").count(), 0, "no caught host handler errors");
  const forbidden = await page.evaluate(() => postedMessages.filter(m => ["userFocus", "send", "prompt", "stop"].includes(m.type)));
  assert.deepEqual(forbidden, [], "no userFocus, prompt, or model control messages");
  console.log(`PASS ${name}`);
 } catch (caught) {
  failures++; error = String(caught.stack); console.error(`FAIL ${name}\n${error}`);
 } finally {
  const detail = await page.evaluate(() => window.__floating ? {
   geometry: window.__floating.geometry(), state: window.__floating.state(), events: window.__floating.events,
   wheels: window.__floating.wheels, inputEvents: window.__floating.inputEvents, clicks: window.__floating.clicks, samples: window.__floating.samples,
  } : null).catch(() => null);
  await page.screenshot({ path: join(output, `${name}${error ? "-failed" : ""}.png`) });
  const report = { name, pass: !error, error, errors, unexpectedRequests, ...detail };
  reports.push({ name, pass: !error, error, artifact: join(output, `${name}.json`) });
  await writeFile(join(output, `${name}.json`), JSON.stringify(report, null, 2));
  await page.close();
 }
}
try {
 browser = await chromium.launch();
 await run("live-shared-floating-lifecycle", { open: true }, async page => {
  const initial = await geometry(page);
  await detach(page);
  let g = await geometry(page); floating(g, "active detached live tool");
  assert.equal(g.working.visible, true, "live tool keeps Working visible");
  assert.equal(g.messages.clientHeight, initial.messages.clientHeight, "showing jump does not resize transcript");
  await page.evaluate(() => { const f = window.__floating; f.jump = document.querySelector(".jump-to-latest"); f.working = document.querySelector(".working-row"); });
  await faded(page);
  g = await geometry(page); await withoutRail(page, g, "active detached overlay");
  // Only the jump is allowed to take clicks. Working and empty rail space
  // must leave the underlying transcript/tool available for inspection.
  const point = g.workingHit?.point;
  assert.ok(point, "Working has a real in-chat paint sample");
  await page.mouse.click(point.x, point.y);
  const click = await page.evaluate(() => window.__floating.clicks.at(-1));
  assert.equal(click.trusted, true, "click-through probe uses real Chromium pointer input");
  assert.equal(click.inChat, true, "underlying transcript receives Working-point click");
  assert.equal(click.inRail, false, "Working does not intercept inspection click");
  await page.mouse.move(g.messages.left + 3, g.messages.top + 15);
  await streamAndSnapshot(page, "live-lifecycle", 4);
  g = await geometry(page); floating(g, "streaming after repeated snapshots");
  assert.equal(g.messages.clientHeight, initial.messages.clientHeight, "live growth/snapshots do not resize transcript");
  await page.evaluate(() => { window.__floating.finish(); window.__floating.snapshot(); window.__floating.snapshot(); });
  await frames(page); const idle = await geometry(page);
  floating(idle, "idle detached");
  assert.equal(idle.working.visible, false, "completed run hides Working, not New messages");
  assert.equal(idle.working.ariaHidden, "true", "idle Working is hidden from accessibility tree");
  assert.equal(idle.messages.clientHeight, initial.messages.clientHeight, "run end has no transcript layout cost");
  assert.equal(idle.working.width, g.working.width, "idle Working keeps horizontal alignment space");
  await page.evaluate(() => {
   const f = window.__floating; f.status.streaming = true; f.event({ type: "agent_start" }); f.event({ type: "agent_start" }); f.snapshot(); f.snapshot();
  });
  await frames(page); g = await geometry(page); floating(g, "next run in same session");
  assert.equal(g.working.visible, true, "next run reveals original Working node");
  assert.equal(g.messages.clientHeight, initial.messages.clientHeight, "run restart consumes no viewport row");
  await sample(page, "restarted-active-detached");
 });
 await run("trusted-direction-host-state", { open: true }, async page => {
  await detach(page, -460);
  floating(await geometry(page), "trusted up detached");
  await faded(page);
  await page.evaluate(() => window.__floating.hold());
  await page.waitForFunction(() => Number(document.querySelector(".working-label").textContent.match(/(\d+)s/)?.[1]) >= 1);
  const before = (await sample(page, "reading-up-before-stream")).state;
  assert.ok(before.inputTop > 50 && before.resultTop > 50, "both real inner panes are scrolled");
  assert.ok(before.selection.length > 0 && before.open, "fixture holds a selection and expanded tool");
  await streamAndSnapshot(page, "reading-up");
  const samples = await page.evaluate(() => window.__floating.samples.filter(s => s.phase.startsWith("reading-up-")));
  for (const s of samples) {
   floating(s.geometry, s.phase); held(before, s.state, s.phase);
   assert.ok(s.geometry.rail.opacity < .25, `${s.phase}: host traffic cannot cancel faded reader intent`);
  }
  assert.ok(samples.at(-1).geometry.messages.scrollHeight > samples[0].geometry.messages.scrollHeight + 50, "new host content actually grows transcript");
  assert.ok(samples.at(-1).geometry.messages.gap > 100, "streaming reader stays detached");
  const g = await geometry(page);
  await page.screenshot({ path: join(output, "trusted-up-faded.png") });
  await page.mouse.move(g.messages.left + 3, g.messages.top + g.messages.height / 2);
  await page.mouse.wheel(0, 90);
  await normal(page);
  const down = await geometry(page); floating(down, "trusted down, still detached");
  assert.ok(down.messages.gap > 50, "downward intent unfades before reaching the existing follow threshold");
  assert.ok(await page.evaluate(() => window.__floating.wheels.some(e => e.trusted && e.deltaY > 0)), "downward input is trusted");
  await streamAndSnapshot(page, "reading-down", 3);
  for (const s of await page.evaluate(() => window.__floating.samples.filter(s => s.phase.startsWith("reading-down-")))) {
   assert.ok(s.geometry.rail.opacity > .8 && s.geometry.jump.visible, `${s.phase}: host traffic keeps normal opacity without resuming follow`);
   assert.equal(s.state.selection, before.selection, `${s.phase}: downward wheel and host traffic retain selection`);
   assert.equal(s.state.inputTop, before.inputTop, `${s.phase}: preserve input inner scroll`);
   assert.equal(s.state.resultTop, before.resultTop, `${s.phase}: preserve output inner scroll`);
  }
  await sample(page, "trusted-down-final");
 });
 await run("idle-click-and-keyboard", { streaming: false }, async page => {
  const initial = await geometry(page);
  assert.equal(initial.working, null, "idle-before-first-run has no fabricated Working indicator");
  await detach(page); let g = await geometry(page); floating(g, "idle before first run", { working: false });
  await page.evaluate(() => { window.__floating.jump = document.querySelector(".jump-to-latest"); });
  await faded(page);
  await page.evaluate(() => {
   const f = window.__floating; f.snapshot(); f.snapshot(); f.status.streaming = true; f.event({ type: "agent_start" });
   f.working = document.querySelector(".working-row");
  });
  await frames(page); g = await geometry(page); floating(g, "jump existed before Working");
  assert.equal(g.messages.clientHeight, initial.messages.clientHeight, "first run adds no activity row");
  assert.ok(g.rail.opacity < .25, "run start does not erase upward reading intent");
  await page.evaluate(() => { window.__floating.finish(); window.__floating.snapshot(); window.__floating.snapshot(); });
  await frames(page); g = await geometry(page); floating(g, "idle keeps jump usable");
  assert.equal(g.working.visible, false, "idle hides Working without hiding jump");
  await page.locator(".jump-to-latest").click(); await following(page, "pointer activation");
  for (const key of ["Enter", "Space"]) {
   await detach(page); await faded(page);
   await focusByTab(page);
   await page.screenshot({ path: join(output, `idle-focus-${key.toLowerCase()}.png`) });
   await page.keyboard.press(key); await following(page, `${key} activation`);
   await page.mouse.move(3, 10);
  }
  const final = await geometry(page);
  assert.equal(final.count, 1, "click and both native keyboard activations reuse exactly one jump node");
  assert.equal(final.messages.clientHeight, initial.messages.clientHeight, "all interaction cycles retain transcript height");
  await sample(page, "idle-activation-final");
 });
 await run("trusted-input-guards", { reducedMotion: "reduce" }, async page => {
  await detach(page, -800); await faded(page);
  await page.evaluate(() => {
   const f = window.__floating;
   f.jump = document.querySelector(".jump-to-latest"); f.working = document.querySelector(".working-row");
   f.inputEvents = [];
   const capture = event => {
    const scroller = document.querySelector(".messages"), rail = document.querySelector(".chat-activity");
    f.inputEvents.push({ type: event.type, trusted: event.isTrusted, key: event.key,
     deltaX: event.deltaX, deltaY: event.deltaY, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey,
     defaultPrevented: event.defaultPrevented, inJump: !!event.target.closest(".jump-to-latest"),
     top: scroller.scrollTop, readingUp: rail.classList.contains("reading-up"),
     opacity: Number(getComputedStyle(rail).opacity), jumpVisible: !!f.jump?.classList.contains("visible") });
   };
   // Bubble AFTER the real scroller/activity listeners. Record defaultPrevented
   // before browser defaults run, then also inspect the resulting geometry.
   window.addEventListener("wheel", capture, { passive: true });
   window.addEventListener("keydown", capture);
  });
  const inputState = () => page.evaluate(() => ({
   top: document.querySelector(".messages").scrollTop,
   readingUp: document.querySelector(".chat-activity").classList.contains("reading-up"),
   opacity: Number(getComputedStyle(document.querySelector(".chat-activity")).opacity),
   jumpVisible: document.querySelector(".jump-to-latest").classList.contains("visible"),
  }));
  const lastInput = type => page.evaluate(type => window.__floating.inputEvents.filter(e => e.type === type).at(-1), type);
  const unchanged = (before, after, label) => {
   assert.ok(Math.abs(after.top - before.top) <= 1, `${label}: no manual transcript scrolling`);
   assert.equal(after.readingUp, before.readingUp, `${label}: no false vertical reading direction`);
   assert.equal(after.jumpVisible, before.jumpVisible, `${label}: follow state remains detached`);
   assert.equal(after.opacity, before.opacity, `${label}: no false fade/unfade`);
  };
  async function hoverJump() {
   const b = await page.locator(".jump-to-latest").boundingBox();
   await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  }
  for (const surface of ["jump", "messages"]) {
   if (surface === "jump") await hoverJump();
   else {
    const b = await page.locator(".messages").boundingBox();
    await page.mouse.move(b.x + 3, b.y + b.height / 2);
   }
   const before = await inputState();
   await page.keyboard.down("Control");
   try { await page.mouse.wheel(0, -120); }
   finally { await page.keyboard.up("Control"); }
   await frames(page, 24);
   const event = await lastInput("wheel");
   assert.equal(event.trusted, true, `${surface}: native trusted pinch/Ctrl-wheel input`);
   assert.equal(event.ctrl, true, `${surface}: wheel carries Ctrl/pinch modifier`);
   assert.equal(event.inJump, surface === "jump", `${surface}: intended wheel surface`);
   assert.equal(event.defaultPrevented, false, `${surface}: leave browser zoom/pinch unconsumed`);
   // The late bubble sample runs after our handlers but BEFORE native defaults.
   // Chromium's platform-owned Ctrl-wheel default may scroll or zoom even over
   // the floating button. Never require the extension to suppress that default.
   unchanged(before, event, `Ctrl-wheel handler over ${surface}`);
   const nativeResult = await inputState(), nativeGeometry = await geometry(page);
   assert.equal(nativeResult.readingUp, before.readingUp, `${surface}: native Ctrl-wheel must not fake reading direction`);
   assert.equal(nativeResult.opacity, before.opacity, `${surface}: native Ctrl-wheel must not fake fade/unfade`);
   if (!nativeResult.jumpVisible) assert.ok(nativeGeometry.messages.gap <= 50, `${surface}: only physical return to tail can resume follow`);
   await sample(page, `guard-ctrl-${surface}`);
  }
  await hoverJump();
  const horizontalBefore = await inputState();
  await page.mouse.wheel(150, 1); await frames(page, 24);
  const horizontal = await lastInput("wheel");
  assert.equal(horizontal.trusted, true, "dominant horizontal swipe is trusted");
  assert.equal(horizontal.deltaX, 150, "exercise substantial horizontal intent");
  assert.equal(horizontal.deltaY, 1, "exercise tiny incidental vertical drift");
  assert.equal(horizontal.defaultPrevented, false, "do not consume dominant horizontal platform gesture");
  unchanged(horizontalBefore, horizontal, "horizontal swipe handler over jump");
  const horizontalResult = await inputState(), horizontalGeometry = await geometry(page);
  assert.equal(horizontalResult.readingUp, horizontalBefore.readingUp, "native horizontal swipe must not fake vertical reading direction");
  assert.equal(horizontalResult.opacity, horizontalBefore.opacity, "native horizontal swipe must not fake fade/unfade");
  if (!horizontalResult.jumpVisible) assert.ok(horizontalGeometry.messages.gap <= 50, "horizontal swipe can resume follow only after physical return to tail");
  await sample(page, "guard-horizontal-drift");
  async function resetDetachedInput() {
   if ((await geometry(page)).jump.visible) await page.locator(".jump-to-latest").click();
   await frames(page, 24);
   await detach(page, -800); await faded(page);
   await page.evaluate(() => document.querySelector(".messages").focus({ preventScroll: true }));
   assert.equal(await page.evaluate(() => document.activeElement?.className), "messages", "native scroller takes keyboard focus without test-only tabindex");
  }
  for (const combo of ["Meta+ArrowDown", "Shift+ArrowDown", "Control+PageDown"]) {
   await resetDetachedInput();
   const before = await inputState(); await page.keyboard.press(combo); await frames(page, 24);
   const event = await lastInput("keydown");
   assert.equal(event.trusted, true, `${combo}: trusted shortcut input`);
   assert.equal(event.defaultPrevented, false, `${combo}: preserve platform shortcut/default behavior`);
   unchanged(before, event, `${combo} handler`);
   const nativeResult = await inputState(), nativeGeometry = await geometry(page);
   assert.equal(nativeResult.readingUp, before.readingUp, `${combo}: native movement must not change activity direction`);
   assert.equal(nativeResult.opacity, before.opacity, `${combo}: native movement must not change faded paint`);
   if (!nativeResult.jumpVisible) assert.ok(nativeGeometry.messages.gap <= 50, `${combo}: only physical return to tail can resume follow`);
   await sample(page, `guard-key-${combo}`);
  }
  await resetDetachedInput();
  // Ordinary vertical gestures still work OVER the floating jump, including
  // hovered faded controls. Only these gestures should be forwarded/consumed.
  await hoverJump(); let before = await inputState();
  await page.mouse.wheel(0, 100); await normal(page);
  let after = await inputState(), event = await lastInput("wheel");
  assert.equal(event.trusted, true, "ordinary downward jump wheel is trusted");
  assert.equal(event.defaultPrevented, true, "ordinary jump wheel forwards exactly once");
  assert.ok(Math.abs(after.top - before.top - 100) <= 1, "jump wheel forwards its real downward distance");
  assert.equal(after.readingUp, false, "ordinary downward jump wheel unfades");
  assert.equal(after.jumpVisible, true, "downward intent still leaves reader detached");
  before = after; await page.mouse.wheel(0, -100); await faded(page);
  after = await inputState(); event = await lastInput("wheel");
  assert.equal(event.defaultPrevented, true, "ordinary upward jump wheel forwards exactly once");
  assert.ok(Math.abs(after.top - before.top + 100) <= 1, "jump wheel forwards its real upward distance");
  assert.equal(after.readingUp, true, "upward wheel fades even while pointer remains over jump");
  await sample(page, "ordinary-jump-wheel-up");
  await page.evaluate(() => document.querySelector(".messages").focus({ preventScroll: true }));
  before = await inputState(); await page.keyboard.press("ArrowDown"); await normal(page); await frames(page, 24);
  after = await inputState();
  assert.ok(after.top > before.top, "plain ArrowDown retains native transcript scrolling");
  assert.equal(after.readingUp, false, "plain ArrowDown unfades");
  assert.equal(after.jumpVisible, true, "plain ArrowDown need not reach tail to unfade");
  before = after; await page.keyboard.press("ArrowUp"); await faded(page); await frames(page, 24);
  after = await inputState();
  assert.ok(after.top < before.top, "plain ArrowUp retains native transcript scrolling");
  assert.equal(after.readingUp, true, "plain ArrowUp fades");
  await page.keyboard.press("ArrowDown"); await normal(page); await frames(page, 24);
  before = await inputState(); await page.keyboard.press("Shift+Space"); await faded(page); await frames(page, 24);
  after = await inputState();
  assert.ok(after.top < before.top, "Shift+Space remains an ordinary native page-up gesture");
  assert.equal(after.readingUp, true, "Shift+Space fades as upward reading intent");
  assert.equal(after.jumpVisible, true, "all input guards retain exact detached jump node");
  floating(await geometry(page), "guarded input final");
  await sample(page, "guarded-input-final");
 });
 for (const config of [
  { name: "narrow-dark-280", theme: "vscode-dark", viewport: { width: 280, height: 640 } },
  { name: "narrow-light-320-dpr2", theme: "vscode-light", viewport: { width: 320, height: 640 }, dpr: 2 },
  { name: "highcontrast-420-and-tiny-pane", theme: "vscode-high-contrast", viewport: { width: 420, height: 640 }, reducedMotion: "reduce" },
 ]) await run(config.name, config, async page => {
  await detach(page); let g = await geometry(page); floating(g, config.name);
  assert.equal(g.rootOverflow, 0, "page has no horizontal overflow");
  assert.ok(g.messages.scrollWidth <= g.messages.clientWidth + 1, "transcript has no horizontal overflow");
  assert.ok(g.rail.scrollWidth <= g.rail.clientWidth + 1, "floating labels fit narrow rail without horizontal overflow");
  assert.equal(g.viewport.dpr, config.dpr ?? 1, "exercise requested device pixel ratio");
  if (config.reducedMotion === "reduce") assert.ok(g.rail.transitionDuration.split(",").every(v => parseFloat(v) === 0), "reduced motion disables opacity transition");
  await faded(page);
  await focusByTab(page);
  await sample(page, "narrow-focused");
  await withoutRail(page, await geometry(page), config.name);
  if (config.name === "highcontrast-420-and-tiny-pane") {
   await page.evaluate(() => {
    host({ type: "draft", text: Array.from({ length: 20 }, (_, i) => `Unsent composer line ${i}`).join("\n") });
    host({ type: "sessionChildren", children: Array.from({ length: 16 }, (_, i) => ({ id: `child-${i}`, activeSessionId: `child-session-${i}`, name: `Worker ${i}`, status: "idle", isStreaming: false })) });
    document.querySelector(".subagents-header")?.click();
    host({ type: "installPrompt", url: "https://example.invalid/install", reason: "Short-pane toolbar fixture" });
    document.activeElement?.blur();
   });
   await page.setViewportSize({ width: 280, height: 240 }); await frames(page);
   g = await geometry(page); floating(g, "240px pane with large composer and roster", { clipped: true });
   assert.ok(g.chat.height < 36, "short fixture leaves too little chat height for full floating rail");
   assert.ok(!g.paintJump || g.paintJump.height < g.jump.height, "short chat clips jump rather than covering composer");
   assert.ok(!g.paintWorking || g.paintWorking.height < g.working.height, "short chat clips Working rather than covering roster");
   if (g.rawJumpHit && !g.paintJump) assert.equal(g.rawJumpHit.inJump, false, "clipped raw jump bounds cannot intercept outside chat");
   await withoutRail(page, g, "tiny-pane clipping");
   await sample(page, "tiny-pane-clipped");
  }
 });
} finally {
 const sourceAfter = manifest(await sourceInputs());
 const generatedAfter = manifest(await generatedInputs());
 const testAfter = sha(await readFile(fileURLToPath(import.meta.url)));
 const proof = { sourceRef: sourceRef ?? "working-tree", resolvedRef, testFile: relative(root, fileURLToPath(import.meta.url)),
  testHashBefore: testBefore, testHashAfter: testAfter, sourceBefore, sourceAfter,
  sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
  generatedBefore, generatedAfter, generatedUnchanged: JSON.stringify(generatedBefore) === JSON.stringify(generatedAfter),
  testUnchanged: testBefore === testAfter, bundleHash: sha(bundle.outputFiles[0].contents), browser: browser?.version(), reports };
 await writeFile(join(output, "source-proof.json"), JSON.stringify(proof, null, 2));
 await browser?.close(); await new Promise(resolve => server.close(resolve));
 if (!proof.sourceUnchanged || !proof.generatedUnchanged || !proof.testUnchanged) {
  failures++; console.error("FAIL: source, test, or generated asset hashes changed during the proof; see source-proof.json");
 }
 console.log(`SOURCE ${sourceBefore.sha256} -> ${sourceAfter.sha256}; TEST ${testBefore}; artifacts ${output}`);
}
console.log(`${reports.filter(r => r.pass).length}/${reports.length} floating activity scenarios passed`);
process.exitCode = failures ? 1 : 0;
