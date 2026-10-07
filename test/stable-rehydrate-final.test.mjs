/**
 * Source-bundle Chromium regressions for stable same-session rehydration.
 * No daemon, RPC process, paid model, or generated build artifact is involved.
 * Usage: node test/stable-rehydrate-final.test.mjs
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
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("stable-rehydrate-final-test") },
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
 await run('retained result transfers from authoritatively deleted assistant owner',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const got=await page.evaluate(()=>{
   const card=document.querySelector('[data-part="tool-settled-tool"]');
   const owner=card.closest('.row-assistant');const pre=card.querySelector('.tool-result pre');
   window.__messages=window.__messages.filter(m=>m.role!=="assistant"||!m.content.some(p=>p.type==="toolCall"));
   window.__snapshot();
   return {ownerRemoved:!owner.isConnected,cardSame:card===document.querySelector('[data-part="tool-settled-tool"]'),
    preSame:pre===card.querySelector('.tool-result pre'),connected:card.isConnected,text:pre.textContent,tools:document.querySelectorAll('.tool').length};
  });
  assert.deepEqual(got,{ownerRemoved:true,cardSame:true,preSame:true,connected:true,text:'settled result',tools:1});
 });
 await run('deleting obsolete assistant prose does not remount retained tool or usage',async page=>{
  const message=completed();message.content.unshift({type:'text',text:'obsolete prefacing text'});
  await seed(page,[...history(),message,result()]);
  const got=await page.evaluate(()=>{
   const tool=document.querySelector('[data-part="tool-settled-tool"]');const owner=tool.closest('.row-assistant');const usage=owner.querySelector('[data-part="usage"]');
   const observer=new MutationObserver(()=>{});observer.observe(document.body,{childList:true,subtree:true});
   window.__messages.at(-2).content.shift();window.__snapshot();
   const records=observer.takeRecords();observer.disconnect();
   return {same:tool===document.querySelector('[data-part="tool-settled-tool"]'),usageSame:usage===owner.querySelector('[data-part="usage"]'),
    removed:records.some(r=>[...r.removedNodes].some(n=>n===tool||n.contains(tool)||n===usage||n.contains(usage))),obsolete:owner.textContent.includes('obsolete prefacing text')};
  });
  assert.deepEqual(got,{same:true,usageSame:true,removed:false,obsolete:false});
 });
 await run('omitted optimistic prompt retains pending price owner over unpriced historical replay',async page=>{
  await seed(page,history());
  const got=await page.evaluate(()=>{
   const textarea=document.querySelector('textarea');textarea.value='Optimistic awaiting priced reply';textarea.dispatchEvent(new Event('input',{bubbles:true}));textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   const optimistic=[...document.querySelectorAll('.row-user')].at(-1);const footer=optimistic.querySelector('.user-footer');
   window.__snapshot();window.__snapshot();
   const message={role:'assistant',timestamp:8000,responseId:'price-final',stopReason:'stop',content:[{type:'text',text:'Priced next reply'}],usage:{input:100,totalTokens:120,cost:{input:.007,total:.008}}};
   window.__event({type:'message_end',message});
   return {connected:optimistic.isConnected,sameFooter:footer===optimistic.querySelector('.user-footer'),optimistic:footer.querySelector('.uf-cost')?.textContent??null,
    historical:[...document.querySelectorAll('.row-user')].filter(r=>r!==optimistic&&r.querySelector('.uf-cost')).map(r=>r.textContent)};
  });
  assert.deepEqual(got,{connected:true,sameFooter:true,optimistic:'$0.0070 input',historical:[]});
 });
 await run('authoritative echo keeps optimistic footer mounted and assigns later price to it',async page=>{
  await seed(page,history());
  const got=await page.evaluate(()=>{
   const textarea=document.querySelector('textarea');textarea.value='Confirmed pending price';textarea.dispatchEvent(new Event('input',{bubbles:true}));textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
   const optimistic=[...document.querySelectorAll('.row-user')].at(-1);const footer=optimistic.querySelector('.user-footer');
   window.__messages.push({role:'user',timestamp:7000,content:'Confirmed pending price'});window.__snapshot();
   window.__event({type:'message_end',message:{role:'assistant',timestamp:8000,responseId:'confirmed-price',stopReason:'stop',content:[{type:'text',text:'Priced reply'}],usage:{input:100,totalTokens:120,cost:{input:.009,total:.010}}}});
   return {connected:optimistic.isConnected,sameFooter:footer===optimistic.querySelector('.user-footer'),cost:footer.querySelector('.uf-cost')?.textContent??null,
    count:[...document.querySelectorAll('.row-user')].filter(r=>r.textContent.includes('Confirmed pending price')).length};
  });
  assert.deepEqual(got,{connected:true,sameFooter:true,cost:'$0.0090 input',count:1});
 });

 await run('later result timestamp corrects shorter output without replacing mounted pre',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const got=await page.evaluate(()=>{
   const pre=document.querySelector('[data-part="tool-settled-tool"] .tool-result pre');
   window.__messages.at(-1).timestamp=5002;window.__messages.at(-1).content[0].text='correct';window.__snapshot();
   return {same:pre===document.querySelector('[data-part="tool-settled-tool"] .tool-result pre'),text:pre.textContent};
  });
  assert.deepEqual(got,{same:true,text:'correct'});
 });
 await run('same or older result timestamp cannot regress final output length',async page=>{
  await seed(page,[...history(),completed(),result()]);
  const got=await page.evaluate(()=>{
   const pre=document.querySelector('[data-part="tool-settled-tool"] .tool-result pre');
   window.__messages.at(-1).content[0].text='stale';window.__snapshot();const same=pre.textContent;
   window.__messages.at(-1).timestamp=5000;window.__snapshot();return {same,older:pre.textContent};
  });
  assert.deepEqual(got,{same:'settled result',older:'settled result'});
 });
 await run('following pruned transcript stays bounded after snapshot-only catch-up',async page=>{
  await seed(page,history(),false);
  const got=await page.evaluate(()=>{
   for(let i=0;i<620;i++){const m={role:'user',timestamp:7000+i,content:`New turn ${i}`};window.__event({type:'message_start',message:m});window.__messages.push(m);}
   const before=document.querySelectorAll('.messages > .row').length;
   for(let i=620;i<950;i++)window.__messages.push({role:'user',timestamp:7000+i,content:`Catch up turn ${i}`});
   window.__snapshot();const scroller=document.querySelector('.messages');
   return {before,after:scroller.querySelectorAll(':scope > .row').length,gap:scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop,last:scroller.lastElementChild.textContent};
  });
  assert.ok(got.before<=600,JSON.stringify(got));assert.ok(got.after<=600,JSON.stringify(got));assert.ok(got.gap<=2,JSON.stringify(got));assert.ok(got.last.includes('Catch up turn 949'),JSON.stringify(got));
 });

 await run('authoritative pending user deletion prices replacement instead of detached footer',async page=>{
  await seed(page,history());
  const got=await page.evaluate(()=>{
   window.__messages=window.__messages.filter(m=>m.role!=='user');window.__messages.push({role:'user',timestamp:7000,content:'Replacement awaiting price'});window.__snapshot();
   const user=[...document.querySelectorAll('.row-user')].at(-1);
   window.__event({type:'message_end',message:{role:'assistant',timestamp:8000,responseId:'replacement-price',stopReason:'stop',content:[{type:'text',text:'Replacement reply'}],usage:{input:100,totalTokens:120,cost:{input:.009,total:.010}}}});
   return {cost:user.querySelector('.uf-cost')?.textContent??null,connected:user.isConnected};
  });
  assert.deepEqual(got,{cost:'$0.0090 input',connected:true});
 });

 await run('retained older unpriced footer cannot override newer authoritative pending prompt',async page=>{
  await seed(page,history());
  const got=await page.evaluate(()=>{
   const old=[...document.querySelectorAll('.row-user')].at(-1);
   window.__messages.push({role:'user',timestamp:7000,content:'Newer authoritative pending prompt'});window.__snapshot();
   const current=[...document.querySelectorAll('.row-user')].at(-1);
   window.__event({type:'message_end',message:{role:'assistant',timestamp:8000,responseId:'newer-pending-price',stopReason:'stop',content:[{type:'text',text:'Newer prompt reply'}],usage:{input:100,totalTokens:120,cost:{input:.011,total:.012}}}});
   return {oldConnected:old.isConnected,oldCost:old.querySelector('.uf-cost')?.textContent??null,currentCost:current.querySelector('.uf-cost')?.textContent??null};
  });
  assert.deepEqual(got,{oldConnected:true,oldCost:null,currentCost:'$0.0110 input'});
 });

 await run('detached reader snapshot catch-up does not prune retained history or move anchor',async page=>{
  await seed(page,history(),false);
  await page.evaluate(()=>{
   for(let i=0;i<620;i++){const m={role:'user',timestamp:7000+i,content:`New turn ${i}`};window.__event({type:'message_start',message:m});window.__messages.push(m);}
  });
  const before=await park(page,1600);
  const got=await page.evaluate(()=>{
   const scroller=document.querySelector('.messages');const kept=[...scroller.querySelectorAll(':scope > .row')];
   for(let i=620;i<950;i++)window.__messages.push({role:'user',timestamp:7000+i,content:`Catch up turn ${i}`});window.__snapshot();
   return {allRetained:kept.every(row=>row.isConnected),count:scroller.querySelectorAll(':scope > .row').length};
  });
  assert.equal(got.allRetained,true,'off-tail catch-up must not discard previously mounted history');
  assert.ok(got.count>600,'held-reader snapshot must not apply tail-only row ceiling');
  held(before,await anchorMetrics(page),'held catch-up');
 });

 await run('late decoded historical attached image preserves held reading anchor',async page=>{
  await seed(page,history(),false);
  await page.evaluate(()=>{
   const strip=document.createElement('div');strip.className='bubble-images';const img=document.createElement('img');
   img.dataset.lateDecode='true';img.width=1;img.height=1;strip.appendChild(img);document.querySelector('.row-user .bubble-user').appendChild(strip);
  });await frames(page);const before=await park(page,1500);
  const got=await page.evaluate(async()=>{
   const img=document.querySelector('img[data-late-decode]');const canvas=document.createElement('canvas');canvas.width=160;canvas.height=110;
   canvas.getContext('2d').fillRect(0,0,160,110);img.removeAttribute('width');img.removeAttribute('height');img.src=canvas.toDataURL('image/png');await img.decode();
   return {naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,height:img.getBoundingClientRect().height};
  });await frames(page);
  assert.deepEqual(got,{naturalWidth:160,naturalHeight:110,height:110},'real image decoded and changed historical row height');
  held(before,await anchorMetrics(page),'late historical image decode');
 });
 await run('host late backfilled spawn above held reader preserves anchor',async page=>{
  await seed(page,history(),false);const before=await park(page,1500);
  await page.evaluate(()=>host({type:'sessionChildren',children:[],spawned:[{activeSessionId:'backfilled-spawn',name:'Backfilled worker',created:new Date(1001).toISOString()}]}));await frames(page);
  assert.equal(await page.locator('.spawned-card').count(),1,'real host children update inserted spawn chrome');
  held(before,await anchorMetrics(page),'late backfilled spawn');
 });
} finally {
 await browser?.close();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log(`\n${failures?`${failures} failing`:"All 12 passing"} final owner and pending-footer browser scenarios`);
process.exitCode=failures?1:0;
