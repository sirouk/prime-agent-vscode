/**
 * Source-bundle Chromium regressions for stable same-session rehydration.
 * No daemon, RPC process, paid model, or generated build artifact is involved.
 * Usage: node test/stable-rehydrate-state.test.mjs
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
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("stable-rehydrate-state-test") },
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
 browser=await chromium.launch();
 await run('changed orphan result remains mounted',async page=>{
  await seed(page,[...history(),result()]);
  await page.evaluate(()=>{window.__messages.at(-1).content[0].text='corrected result';window.__snapshot();});
  assert.equal(await page.locator('.tool').count(),1,'orphan card must survive');
  assert.ok((await page.locator('.messages').textContent()).includes('corrected result'),'result changes applied');
 });
 await run('preexisting compaction summary does not discard omitted live',async page=>{
  const summary={role:'compactionSummary',timestamp:500,summary:'Earlier compaction',retainedMessageCount:24};
  await seed(page,[summary,...history()]);
  const retained=await page.evaluate(()=>{
   window.__event({type:'message_start',message:{role:'assistant',timestamp:6000,content:[{type:'text',text:'Active live prose'}]}});
   window.__live=document.querySelector('.messages > .row:last-child');window.__snapshot();
   return {connected:window.__live.isConnected,text:document.querySelector('.messages').textContent};
  });
  assert.equal(retained.connected,true,'live node survives');assert.ok(retained.text.includes('Active live prose'));
 });
 await run('authoritative snapshot deletion removes newer settled rows',async page=>{
  await seed(page,[...history(),completed(),result()]);
  await page.evaluate(()=>{window.__messages=window.__messages.slice(0,-2);window.__snapshot();});
  assert.equal(await page.locator('[data-part="tool-settled-tool"]').count(),0,'deleted final card must leave');
 });
 await run('historical repaint cannot price new pending prompt',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const pricing=await page.evaluate(()=>{
   const message={role:'user',timestamp:6000,content:'New currently unpriced prompt'};window.__event({type:'message_start',message});window.__messages.push(message);
   const user=[...document.querySelectorAll('.row-user')].at(-1); window.__snapshot();
   return {connected:user.isConnected,cost:user.querySelector('.uf-cost')?.textContent??null};
  });
  assert.equal(pricing.connected,true);assert.equal(pricing.cost,null,'new prompt must remain unpriced');
 });
 await run('compaction retained user fork ordinal recomputes',async page=>{
  await seed(page,history());
  const ordinal=await page.evaluate(()=>{
   window.__messages=[{role:'compactionSummary',timestamp:999,summary:'New compaction',retainedMessageCount:4},...window.__messages.slice(-4)];
   window.__snapshot();return document.querySelector('.row-user').dataset.userOrdinal;
  });
  assert.equal(ordinal,'0','first retained prompt is full-history ordinal 0');
 });
 await run('same-length final input correction applies without remount',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const input=await page.evaluate(()=>{
   const pre=document.querySelector('[data-part="tool-settled-tool"] .tool-section pre');
   window.__messages.at(-2).content[0].arguments.code="print('updated')";
   window.__snapshot();return {same:pre===document.querySelector('[data-part="tool-settled-tool"] .tool-section pre'),text:pre.textContent};
  });
  assert.equal(input.same,true);assert.equal(input.text,"print('updated')");
 });
 await run('confirmed optimistic row survives authoritative echo',async page=>{
  await seed(page,history());
  const result=await page.evaluate(()=>{
   const textarea=document.querySelector('textarea');textarea.value='Optimistic pending probe';textarea.dispatchEvent(new Event('input',{bubbles:true}));
   textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   const user=[...document.querySelectorAll('.row-user')].at(-1);
   window.__messages.push({role:'user',timestamp:7000,content:'Optimistic pending probe'});window.__snapshot();
   return {beforeText:user.textContent,connected:user.isConnected,count:[...document.querySelectorAll('.row-user')].filter(r=>r.textContent.includes('Optimistic pending probe')).length};
  });
  assert.equal(result.connected,true,JSON.stringify(result));assert.equal(result.count,1);
 });
 await run('unconfirmed optimistic prompt survives omitted snapshot without old input price',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const retained=await page.evaluate(()=>{
   const textarea=document.querySelector('textarea');textarea.value='Still queued optimistic probe';
   textarea.dispatchEvent(new Event('input',{bubbles:true}));
   textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   const user=[...document.querySelectorAll('.row-user')].at(-1);
   if (!user.textContent.includes('Still queued optimistic probe')) throw new Error('optimistic fixture did not send');
   const footer=user.querySelector('.user-footer');window.__snapshot();window.__snapshot();
   return {connected:user.isConnected,sameFooter:footer===user.querySelector('.user-footer'),
    cost:footer.querySelector('.uf-cost')?.textContent??null,
    count:[...document.querySelectorAll('.row-user')].filter(r=>r.textContent.includes('Still queued optimistic probe')).length};
  });
  assert.deepEqual(retained,{connected:true,sameFooter:true,cost:null,count:1});
 });
 await run('pruned rendered ceiling survives authoritative refresh',async page=>{
  await seed(page,history(),false);
  const count=await page.evaluate(()=>{
   for(let i=0;i<620;i++){
    const message={role:'user',timestamp:7000+i,content:`New turn ${i}`};
    window.__event({type:'message_start',message});window.__messages.push(message);
   }
   const before=document.querySelectorAll('.messages > .row').length;window.__snapshot();
   return {before,after:document.querySelectorAll('.messages > .row').length,pruned:document.querySelector('.pruned-bar')?.textContent};
  });
  assert.ok(count.before<=600);assert.ok(count.after<=600,`refresh resurrected pruned rows ${JSON.stringify(count)}`);
 });
 await run('retained tool snapshot reordered around spawn chrome causes no remount',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const mounted=await page.evaluate(()=>{
   const tool=document.querySelector('[data-part="tool-settled-tool"]');const owner=tool.closest('.row');
   host({type:'sessionChildren',children:[],spawned:[{
    activeSessionId:'stable-spawn',name:'Stable worker',created:new Date(4500).toISOString(),
   }]});
   const spawn=document.querySelector('.spawned-card');
   if (!spawn || spawn.nextElementSibling !== owner) throw new Error('spawn fixture must precede settled owner');
   const observer=new MutationObserver(()=>{});observer.observe(document.querySelector('.messages'),{childList:true});window.__snapshot();
   const records=observer.takeRecords();observer.disconnect();return records.some(r=>[...r.removedNodes].includes(owner));
  });
  assert.equal(mounted,false,'unchanged tool owner was detached around spawn chrome');
 });
 await run('retained live omitted snapshot remains same through final inclusion',async page=>{
  await seed(page,history());
  const result=await page.evaluate(()=>{
   const message={role:'assistant',timestamp:7000,content:[{type:'toolCall',id:'live-check',name:'ipython',arguments:{code:'print(123)'}}]};
   window.__event({type:'message_start',message});const tool=document.querySelector('[data-part="tool-live-check"]');const row=tool.closest('.row');const pre=tool.querySelector('pre');tool.querySelector('.tool-toggle').click();
   window.__snapshot();const absentSame=row.isConnected&&pre===tool.querySelector('pre');
   window.__messages.push({...message,stopReason:'toolUse',usage:{totalTokens:150}});window.__snapshot();
   return {absentSame,rowSame:row===document.querySelector('[data-part="tool-live-check"]').closest('.row'),preSame:pre===tool.querySelector('pre'),footer:!!row.querySelector('.usage-line'),open:tool.classList.contains('open')};
  });
  assert.deepEqual(result,{absentSame:true,rowSame:true,preSame:true,footer:true,open:true});
 });
 await run('empty authoritative snapshot while streaming does not retain removed historical data',async page=>{
  await seed(page,history());await page.evaluate(()=>{window.__messages=[];window.__snapshot();});
  assert.equal(await page.locator('.messages > .row').count(),0);
 });

} finally {
 await browser?.close();
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log(`\n${failures ? `${failures} failing` : "All 12 passing"} stable rehydration browser scenarios`);
process.exitCode=failures?1:0;
