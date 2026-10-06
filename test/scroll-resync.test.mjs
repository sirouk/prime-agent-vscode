/**
 * Source-bundle Chromium regression for full snapshot/resync and tool handoff.
 * No daemon, RPC process, paid model, or generated build artifact is involved.
 * Usage: node test/scroll-resync.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
	absWorkingDir: root,
	entryPoints: ["webview/main.ts"],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2022",
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("scroll-resync-test") },
	logLevel: "silent",
});
const assets = new Map([
	["/preview.html", ["text/html", await readFile(`${root}media/preview.html`)]],
	["/main.css", ["text/css", await readFile(`${root}media/main.css`)]],
	["/main.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
const server = createServer((req, res) => {
	const asset = assets.get(new URL(req.url, "http://localhost").pathname);
	res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
	res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
let browser;
let failures = 0;

const frames = (page, count = 4) => page.evaluate(async (n) => {
	for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
}, count);
const metrics = (page) => page.$eval(".messages", (e) => ({
	top: e.scrollTop, max: e.scrollHeight - e.clientHeight,
	gap: e.scrollHeight - e.clientHeight - e.scrollTop,
}));
const indicator = (page) => page.evaluate(() => {
	const e = document.querySelector(".jump-to-latest");
	return {
		visible: !!e && e.classList.contains("visible") && getComputedStyle(e).display !== "none",
		label: e?.textContent.trim() ?? "",
	};
});
async function expectNewMessages(page) {
	assert.deepEqual(await indicator(page), { visible: true, label: "New messages" });
}


const SESSION = "snapshot-resync-fixture";
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
 cost: { input: .001, output: .002, cacheRead: 0, cacheWrite: 0, total: .003 } };
function history(count = 24) {
 return Array.from({length:count}, (_, i) => i % 2 ? {
  role: "assistant", timestamp: 1000 + i, stopReason: "stop", content: [{
   type: "text", text: `History reply ${i}. ` + "Earlier transcript words. ".repeat(18),
  }],
 } : {role: "user", timestamp: 1000 + i, content: `History prompt ${i}`});
}
const completed = () => ({role: "assistant", timestamp: 5000, stopReason: "toolUse", usage,
 content: [{type: "toolCall", id: "settled-tool", name: "ipython", arguments: {code: "print('settled')"}}]});
const result = () => ({role: "toolResult", timestamp: 5001, toolCallId: "settled-tool", toolName: "ipython",
 content: [{type: "text", text: "settled result"}], isError: false});
async function seed(page, messages = history(), streaming = true) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.evaluate(({messages, streaming, sessionId}) => {
  window.__messages = messages;
  window.__status = {...baseStatus, sessionId, streaming};
  window.__event = event => host({type:"event",event});
  window.__snapshot = () => host({type:"snapshot",messages:structuredClone(window.__messages),state:null,status:window.__status});
  window.__snapshot();
 }, {messages, streaming, sessionId:SESSION});
 await frames(page);
 assert.ok((await metrics(page)).max > 1500, "fixture must overflow");
 assert.ok((await metrics(page)).gap <= 2, "new transcript starts at bottom");
}
async function park(page, top) {
 await page.$eval(".messages", (e, top) => {e.scrollTop = top; e.dispatchEvent(new Event("scroll"));}, top);
 await frames(page);
 return page.evaluate(() => {
  const e=document.querySelector(".messages"), box=e.getBoundingClientRect();
  const anchor=[...e.querySelectorAll(":scope > .row")].find(r=>r.getBoundingClientRect().bottom>box.top);
  window.__anchorTs=anchor?.dataset.ts;
  return {top:e.scrollTop,ts:window.__anchorTs,offset:anchor?.getBoundingClientRect().top-box.top,
   rows:e.querySelectorAll(":scope > .row").length,earlier:document.querySelector(".earlier-load")?.textContent??null};
 });
}
async function anchorMetrics(page) {
 return page.evaluate(()=>{
  const e=document.querySelector(".messages");
  const anchor=[...e.querySelectorAll(":scope > .row")].find(r=>r.dataset.ts===window.__anchorTs);
  return {top:e.scrollTop,offset:anchor?anchor.getBoundingClientRect().top-e.getBoundingClientRect().top:null,
   rows:e.querySelectorAll(":scope > .row").length,earlier:document.querySelector(".earlier-load")?.textContent??null};
 });
}
function held(before, after, label) {
 assert.notEqual(after.offset,null,`${label}: visible anchor must still be rendered`);
 assert.ok(Math.abs(after.offset-before.offset)<=1,`${label}: anchor moved ${after.offset-before.offset}px`);
}
async function run(name, test) {
 const page = await browser.newPage({viewport:{width:420,height:620}});
 page.setDefaultTimeout(5000);
 const errors=[];
 page.on("pageerror", error=>errors.push(String(error)));
 try {
  await test(page);
  assert.deepEqual(errors,[],"no webview page errors");
  console.log(`PASS  ${name}`);
 } catch(error) {
  failures++;
  console.error(`FAIL  ${name}\n  ${error.stack}`);
 } finally {await page.close();}
}
try {
 browser = await chromium.launch();
 await run("same-session snapshot preserves held anchor, follow lock, and subsequent live replay", async page=>{
  await seed(page);
  const before=await park(page,(await metrics(page)).max-300);
  await page.evaluate(()=>{
   // Changed layout ABOVE the reader proves this is an anchor restore, not just scrollTop.
   window.__messages[0].content += " Older inserted prose. ".repeat(35);
   window.__snapshot();
  });
  await frames(page);
  held(before,await anchorMetrics(page),"replacement snapshot");
  await expectNewMessages(page);
  await page.evaluate(()=>{
   const msg={role:"assistant",timestamp:6000,content:[{type:"text",text:"Replayed in-flight reply."}]};
   window.__event({type:"message_start",message:msg});
   window.__event({type:"message_update",message:{...msg,content:[{type:"text",text:"Replayed in-flight reply. "+"Live words below reader. ".repeat(40)}]}});
  });
  await frames(page);
  held(before,await anchorMetrics(page),"resync replay and delta");
  await expectNewMessages(page);
 });

 await run("first empty snapshot then same-session population still uses initial tail window",async page=>{
  await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
  await page.waitForSelector(".messages");
  await page.evaluate(messages=>{
   const status={...baseStatus,sessionId:"empty-population-fixture",streaming:false};
   host({type:"snapshot",messages:[],state:null,status});
   host({type:"snapshot",messages,state:null,status});
  },history(360));
  await frames(page);
  assert.equal(await page.locator(".messages > .row").count(),150,"same-session first population must remain windowed");
  assert.equal(await page.locator(".earlier-load").textContent(),"210 earlier messages");
  assert.ok((await metrics(page)).gap<=2,"first population starts at tail");
 });
 await run("same-session snapshot retains manually loaded earlier window and reading anchor",async page=>{
  await seed(page,history(360));
  assert.equal(await page.locator(".messages > .row").count(),150,"initial population remains windowed");
  await page.locator(".earlier-load").click();
  await frames(page);
  const before=await park(page,800);
  assert.equal(before.rows,250,"loaded 100 more messages");
  assert.equal(before.earlier,"110 earlier messages");
  await page.evaluate(()=>{
   window.__messages[110].content += "Older inserted content above reader. ".repeat(15);
   window.__snapshot();
  });
  await frames(page);
  const after=await anchorMetrics(page);
  held(before,after,"loaded window replacement");
  assert.equal(after.rows,250,"same-session refresh must not discard loaded history");
  assert.equal(after.earlier,before.earlier,"unrendered count stays honest");
  await expectNewMessages(page);
 });
 await run("status naming new session before snapshot still opens new transcript at bottom",async page=>{
  await seed(page);
  await park(page,800);
  await page.evaluate(()=>{
   window.__status={...window.__status,sessionId:"different-fixture-session"};
   host({type:"status",status:window.__status});
   window.__snapshot();
  });
  await frames(page);
  assert.ok((await metrics(page)).gap<=2,"new session must not inherit held scroll");
  assert.equal((await indicator(page)).visible,false);
 });

 await run("same-session compaction replaces obsolete data even when reading anchor disappears",async page=>{
  await seed(page);
  await park(page,(await metrics(page)).max-300);
  await page.evaluate(()=>{
   window.__messages=[{role:"compactionSummary",timestamp:8000,summary:"Authoritative compacted replacement summary.",tokensBefore:3000,retainedMessageCount:0},
    {role:"user",timestamp:8001,content:"Retained replacement prompt"}];
   window.__snapshot();
  });
  await frames(page);
  const text=await page.locator(".messages").textContent();
  assert.ok(text.includes("Authoritative compacted replacement summary."),"compaction data must be adopted");
  assert.equal(text.includes("History reply"),false,"obsolete transcript must not survive same-session refresh");
  assert.ok((await metrics(page)).top>=0,"missing anchor fallback remains valid");
 });
 for (const withUsage of [true, false]) await run(`duplicate and late assistant replay preserves settled tool (${withUsage ? "usage footer" : "no usage"})`,async page=>{
  const final=completed();
  if (!withUsage) delete final.usage;
  await seed(page,[...history(),final,result()]);
  const before=await page.evaluate(()=>{
   const tool=document.querySelector('[data-part="tool-settled-tool"]');
   window.__settledOwner=tool.closest(".row-assistant");
   window.__settledFooter=window.__settledOwner.querySelector('[data-part="usage"]');
   return {top:tool.getBoundingClientRect().top,usage:document.querySelectorAll('[data-part="usage"]').length};
  });
  const late={...final,stopReason:undefined,usage:undefined};
  await page.evaluate(({final,late})=>{
   window.__event({type:"message_start",message:final});
   window.__event({type:"message_update",message:late});
   window.__event({type:"message_end",message:final});
  },{final,late});
  await frames(page);
  const after=await page.evaluate(()=>{
   const tool=document.querySelector('[data-part="tool-settled-tool"]');
   return {sameOwner:tool.closest(".row-assistant")===window.__settledOwner,
    sameFooter:window.__settledOwner.querySelector('[data-part="usage"]')===window.__settledFooter,
    top:tool.getBoundingClientRect().top,usage:document.querySelectorAll('[data-part="usage"]').length,
    state:tool.querySelector(".tool-pill")?.className,result:tool.querySelector(".tool-result")?.textContent};
  });
  assert.equal(after.sameOwner,true,"replay must not move a settled tool into another assistant row");
  assert.equal(after.sameFooter,true,"settled usage footer remains in its row");
  assert.equal(after.usage,before.usage,"replay must not duplicate usage footer");
  assert.ok(Math.abs(after.top-before.top)<=1,"replay must not move visible settled tool");
  assert.ok(after.state.includes("done"),"late replay must not revert completed state");
  assert.ok(after.result.includes("settled result"),"completed result survives replay");
 });
 await run("completed tool followed by empty assistant start and args has no down-then-up tail jump",async page=>{
  await seed(page,[...history(),completed(),result()]);
  await page.evaluate(()=>window.__event({type:"agent_start"}));
  await frames(page);
  const samples=await page.evaluate(async()=>{
   const tool=document.querySelector('[data-part="tool-settled-tool"]');
   const e=document.querySelector(".messages");
   const sample=label=>({label,top:tool.getBoundingClientRect().top,gap:e.scrollHeight-e.clientHeight-e.scrollTop});
   const samples=[sample("before empty start")];
   window.__event({type:"message_start",message:{role:"assistant",timestamp:6000,content:[]}});
   samples.push(sample("empty start synchronous"));
   for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);samples.push(sample(`empty frame ${i}`));}
   for(let i=1;i<=12;i++){
    await new Promise(requestAnimationFrame);
    window.__event({type:"message_update",message:{role:"assistant",timestamp:6000,content:[{
     type:"toolCall",id:"new-streaming-tool",name:"ipython",arguments:{code:"print('new')\n"+"# streamed args\n".repeat(i)},
    }]}});
    samples.push(sample(`args ${i}`));
   }
   return samples;
  });
  const downward=Math.max(...samples.map(s=>s.top-samples[0].top));
  assert.ok(downward<=1,`empty live slot caused settled history to move down ${downward}px: ${JSON.stringify(samples)}`);
  assert.ok(samples.every(s=>s.gap<=2),`tail following must hold every frame: ${JSON.stringify(samples)}`);
 });

 await run("snapshot shrink cannot re-stick held reader; downward wheel resumes even at clamped bottom",async page=>{
  await seed(page);
  await park(page,(await metrics(page)).max-300);
  await page.evaluate(()=>{
   // The anchor survives; only content below it is removed. This clamps the
   // physical scrollTop to the new bottom without expressing reader intent.
   window.__messages=window.__messages.slice(0,-4);
   window.__snapshot();
  });
  await frames(page);
  assert.ok((await metrics(page)).gap<=2,"shrink fixture must clamp to physical bottom");
  await expectNewMessages(page);
  // A downward wheel at the physical bottom does not emit a native scroll
  // event. It must still be enough to resume explicit reader following.
  const box=await page.locator(".messages").boundingBox();
  await page.mouse.move(box.x+12,box.y+box.height/2);
  await page.mouse.wheel(0,300);
  await frames(page);
  await page.evaluate(()=>window.__event({type:"message_start",message:{role:"assistant",timestamp:9000,
   content:[{type:"text",text:"New output after resumed wheel. "+"Live words. ".repeat(80)}]}}));
  await frames(page);
  assert.ok((await metrics(page)).gap<=2,"downward wheel must resume following after clamp");
  assert.equal((await indicator(page)).visible,false,"wheel resume hides New messages");
 });
 await run("following resync snapshot and message_start replay render exactly one live tool slot",async page=>{
  await seed(page,[...history(),completed(),result()]);
  await page.evaluate(()=>{
   const live={role:"assistant",timestamp:6000,content:[{type:"toolCall",id:"resync-live-tool",name:"ipython",arguments:{code:"print('live')"}}]};
   window.__snapshot();
   window.__event({type:"message_start",message:live});
   window.__event({type:"message_update",message:{...live,content:[{type:"toolCall",id:"resync-live-tool",name:"ipython",arguments:{code:"print('live')\nprint('delta')"}}]}});
  });
  await frames(page);
  assert.equal(await page.locator('[data-part="tool-settled-tool"]').count(),1);
  assert.equal(await page.locator('[data-part="tool-resync-live-tool"]').count(),1);
  assert.ok((await metrics(page)).gap<=2,"following survives resync and in-flight replay");
  assert.ok((await page.locator('[data-part="tool-resync-live-tool"] .tool-body').textContent()).includes("print('delta')"));
 });
} finally {
 await browser?.close();
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log(`\n${failures?`${failures} failing`:"All 10 passing"} snapshot/resync browser scenarios`);
process.exitCode=failures?1:0;
