/**
 * Source-bundle Chromium regressions for replay identity and snapshot anchors.
 * No daemon, RPC process, paid model, or generated build artifact is involved.
 * Usage: node test/scroll-identity.test.mjs
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
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("scroll-identity-test") },
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

/** Hold a concrete row, not the first row with a potentially colliding timestamp. */
async function holdRow(page, text) {
 await page.evaluate(text=>{
  const e=document.querySelector('.messages');
  const row=[...e.children].find(r=>r.textContent.includes(text));
  if(!row)throw new Error(`Missing row ${text}`);
  e.scrollTop+=row.getBoundingClientRect().top-e.getBoundingClientRect().top+20;
  e.dispatchEvent(new Event('scroll'));
 },text);
 await frames(page);
 return rowAnchor(page,text);
}
async function rowAnchor(page,text) {
 return page.evaluate(text=>{
  const e=document.querySelector('.messages');
  const row=[...e.children].find(r=>r.textContent.includes(text));
  return {key:row?.dataset.messageKey,offset:row?row.getBoundingClientRect().top-e.getBoundingClientRect().top:null};
 },text);
}
function sameAnchor(before,after,label) {
 assert.notEqual(before.offset,null,`${label}: fixture row exists`);
 assert.notEqual(after.offset,null,`${label}: durable row remains`);
 assert.equal(after.key,before.key,`${label}: live/snapshot anchor identity matches`);
 assert.ok(Math.abs(before.offset-after.offset)<=1,`${label}: ${JSON.stringify({before,after})}`);
}
try {
 browser = await chromium.launch();
 for(const role of ['user','assistant']) await run(`same timestamp ${role} rows retain later visible snapshot anchor`,async page=>{
  const messages=history(60),index=role==='user'?40:41;
  messages[index].timestamp=messages[index%2].timestamp;
  await seed(page,messages);
  const text=role==='user'?`History prompt ${index}`:`History reply ${index}.`;
  const before=await holdRow(page,text);
  await page.evaluate(()=>window.__snapshot());await frames(page);
  sameAnchor(before,await rowAnchor(page,text),'duplicate timestamp resync');
  await expectNewMessages(page);
 });
 for(const kind of ['response','tool']) await run(`new distinct ${kind} identity sharing settled timestamp renders`,async page=>{
  const old=kind==='response'?{role:'assistant',timestamp:6000,responseId:'old-response',stopReason:'stop',content:[{type:'text',text:'Old settled response'}]}:
   {role:'assistant',timestamp:6000,stopReason:'toolUse',content:[{type:'toolCall',id:'old-tool-identity',name:'ipython',arguments:{code:'print(1)'}}]};
  await seed(page,[...history(),old]);
  const message=kind==='response'?{role:'assistant',timestamp:6000,responseId:'new-response',content:[{type:'text',text:'New distinct response'}]}:
   {role:'assistant',timestamp:6000,content:[{type:'toolCall',id:'new-tool-identity',name:'ipython',arguments:{code:'print(2)'}}]};
  await page.evaluate(message=>{
   window.__event({type:'message_start',message});window.__event({type:'message_update',message});
   window.__event({type:'message_end',message:{...message,stopReason:'stop'}});
  },message);
  await frames(page);
  assert.equal(kind==='response'?await page.getByText('New distinct response',{exact:true}).count():await page.locator('[data-part="tool-new-tool-identity"]').count(),1);
 });
 for(const role of ['user','assistant']) await run(`live ${role} duplicate timestamp anchor survives snapshot and growth above`,async page=>{
  const messages=history(60),text=`Live ${role} collision anchor`;
  await seed(page,messages);
  const live={role,timestamp:messages[role==='user'?0:1].timestamp,content:role==='user'?text:[{type:'text',text}],...(role==='assistant'?{responseId:'live-anchor-response',stopReason:'stop'}:{})};
  const below=history(24).map(m=>({...m,timestamp:m.timestamp+10000}));
  await page.evaluate(({live,below})=>{
   const all=[live,...below];
   for(const message of all)window.__event({type:'message_start',message});
   window.__messages.push(...all);
  },{live,below});
  await frames(page);const before=await holdRow(page,text);
  await page.evaluate(()=>{
   window.__messages[0].content+=' Growth above visible live anchor. '.repeat(30);
   window.__snapshot();
  });await frames(page);
  sameAnchor(before,await rowAnchor(page,text),'live durable resync');
 });
 await run('duplicates outside initial window retain occurrence identity after load earlier',async page=>{
  const messages=history(360);messages[240].timestamp=messages[0].timestamp;
  await seed(page,messages);
  const text='History prompt 240';const before=await holdRow(page,text);
  await page.evaluate(()=>window.__snapshot());await frames(page);
  sameAnchor(before,await rowAnchor(page,text),'windowed duplicate resync');
  await page.locator('.earlier-load').click();await frames(page);
  const loaded=await rowAnchor(page,text);
  await page.evaluate(()=>window.__snapshot());await frames(page);
  sameAnchor(loaded,await rowAnchor(page,text),'loaded duplicate resync');
 });

 await run('distinct text-only assistant sharing settled timestamp is not silently lost',async page=>{
  await seed(page,[...history(),{role:'assistant',timestamp:6000,stopReason:'stop',content:[{type:'text',text:'Old timestamp-only response'}]}]);
  await page.evaluate(()=>{
   const message={role:'assistant',timestamp:6000,content:[{type:'text',text:'New timestamp-only response'}]};
   window.__event({type:'message_start',message});
   window.__event({type:'message_update',message});
   window.__event({type:'message_end',message:{...message,stopReason:'stop'}});
  });await frames(page);
  assert.equal(await page.getByText('New timestamp-only response',{exact:true}).count(),1);
 });
 await run('text-first live assistant gains tool identity without losing snapshot anchor',async page=>{
  await seed(page,history(60));
  const text='Text-first live tool anchor';
  const start={role:'assistant',timestamp:16000,content:[{type:'text',text}]};
  const end={...start,stopReason:'toolUse',content:[...start.content,{type:'toolCall',id:'text-first-tool',name:'ipython',arguments:{code:'print(3)'}}]};
  await page.evaluate(({start,end,below})=>{
   window.__event({type:'message_start',message:start});
   window.__event({type:'message_update',message:end});
   window.__event({type:'message_end',message:end});
   for(const message of below)window.__event({type:'message_start',message});
   window.__messages.push(end,...below);
  },{start,end,below:history(24).map(m=>({...m,timestamp:m.timestamp+20000}))});
  await frames(page);const before=await holdRow(page,text);
  await page.evaluate(()=>{
   window.__messages[0].content+=' Growth above evolving assistant. '.repeat(30);
   window.__snapshot();
  });await frames(page);
  sameAnchor(before,await rowAnchor(page,text),'text-to-tool resync');
 });
}finally {
 await browser?.close();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log(`\n${failures?`${failures} failing`:'All 9 passing'} replay identity and snapshot anchor browser scenarios`);
process.exitCode=failures?1:0;
