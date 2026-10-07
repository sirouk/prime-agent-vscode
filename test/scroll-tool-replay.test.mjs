/**
 * Real Chromium regression for the OUTER chat scroller during live output.
 * Usage: node test/scroll-tool-replay.test.mjs
 *
 * Bundle source in memory: this does not depend on a stale media/main.js or
 * change build artifacts. The original preview harness supplies the fake host;
 * all output below is controlled MessageEvents, never a paid agent run.
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
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("scroll-anchor-test") },
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


async function seed(page) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector('.messages');
 await page.evaluate(() => {
  const messages=[];
  for(let i=0;i<12;i++) {
   messages.push({role:'user',content:`History ${i}`});
   messages.push({role:'assistant',stopReason:'stop',content:[{type:'text',text:'Earlier transcript prose. '.repeat(30)}]});
  }
  host({type:'snapshot',messages,status:{...baseStatus,sessionId:'replay-test',streaming:true},state:null});
  window.__event=event=>host({type:'event',event});
  window.__tool=(id,timestamp)=>({role:'assistant',...(timestamp?{timestamp}:{}),content:[{
   type:'toolCall',id,name:'ipython',arguments:{code:'print(1)\n'.repeat(60)},
  }]});
  window.__event({type:'agent_start'});
 });
 await frames(page);
 assert.ok((await metrics(page)).max>1500,'fixture overflows');
}
async function detach(page,gap) {
 await page.$eval('.messages',(e,gap)=>{
  e.scrollTop=e.scrollHeight-e.clientHeight-gap;
  e.dispatchEvent(new Event('scroll'));
 },gap);
 await frames(page);
 assert.equal(Math.round((await metrics(page)).gap),gap);
 await expectNewMessages(page);
}
async function run(name,test) {
 const page=await browser.newPage({viewport:{width:420,height:350}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 try {
  await seed(page);await test(page);assert.deepEqual(errors,[]);console.log(`PASS  ${name}`);
 }catch(error){failures++;console.error(`FAIL  ${name}\n${error.stack}`);}
 finally{await page.close();}
}

try {
 browser=await chromium.launch();
 for(const usage of [false,true]) for(const gap of [51,300]) {
  await run(`expanded settled tool replay preserves rows, ${usage?'with':'without'} usage, gap ${gap}`,async(page)=>{
   await page.evaluate(usage=>{
    // No timestamp: replay identity must work through tool call id alone.
    window.__old=window.__tool('old-tool');
    window.__finished={...window.__old,stopReason:'toolUse',...(usage?{usage:{totalTokens:100}}:{})};
    window.__event({type:'message_start',message:window.__old});
    document.querySelector('[data-part="tool-old-tool"] .tool-toggle').click();
    window.__event({type:'message_end',message:window.__finished});
   },usage);
   await frames(page);await detach(page,gap);
   const result=await page.evaluate(async()=>{
    const e=document.querySelector('.messages');
    const tool=document.querySelector('[data-part="tool-old-tool"]');
    const row=tool.closest('.row');const footer=row.querySelector('.usage-line');
    const history=e.querySelector('.row');const samples=[];
    const measure=()=>({top:e.scrollTop,max:e.scrollHeight-e.clientHeight,
     history:history.getBoundingClientRect().top,tool:tool.getBoundingClientRect().top,
     footer:footer?.getBoundingClientRect().top??null,rows:e.querySelectorAll(':scope > .row').length,
     owner:tool.closest('.row')===row,footerSame:row.querySelector('.usage-line')===footer,
     expanded:tool.classList.contains('open')});
    const before=measure();let sampling=true;
    const loop=()=>{if(sampling){samples.push(measure());requestAnimationFrame(loop);}};loop();
    for(let i=0;i<8;i++) {
     await new Promise(requestAnimationFrame);
     window.__event({type:'message_start',message:window.__old});samples.push(measure());
     window.__event({type:'message_update',message:window.__old});samples.push(measure());
     window.__event({type:'message_end',message:window.__finished});samples.push(measure());
    }
    for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
    sampling=false;return {before,samples};
   });
   assert.ok(result.samples.length>=30,'sample synchronous mutations and real frames');
   for(const sample of result.samples) {
    assert.ok(sample.owner&&sample.footerSame&&sample.expanded,'completed tool owner/footer/open state unchanged');
    assert.equal(sample.rows,result.before.rows,'replay must not append assistant rows');
    for(const key of ['top','max','history','tool','footer']) {
     if(result.before[key]!==null)assert.ok(Math.abs(sample[key]-result.before[key])<=1,`${key} drifted: ${JSON.stringify(sample)}`);
    }
   }
   await expectNewMessages(page);
  });
 }
 await run('stale replay cannot mutate a new active bubble or mix settled tool owners',async(page)=>{
  const result=await page.evaluate(()=>{
   for(const [id,ts] of [['old-A',111],['old-B',222]]) {
    const message=window.__tool(id,ts);window.__event({type:'message_start',message});
    window.__event({type:'message_end',message:{...message,stopReason:'toolUse',usage:{totalTokens:100}}});
   }
   const toolA=document.querySelector('[data-part="tool-old-A"]');const rowA=toolA.closest('.row');
   const toolB=document.querySelector('[data-part="tool-old-B"]');const rowB=toolB.closest('.row');
   const before={a:rowA.innerHTML,b:rowB.innerHTML,rows:document.querySelectorAll('.messages > .row').length};
   const live=window.__tool('live-C',333);window.__event({type:'message_start',message:live});
   const rowC=document.querySelector('[data-part="tool-live-C"]').closest('.row');const liveBefore=rowC.innerHTML;
   const old=window.__tool('old-A',111);
   window.__event({type:'message_update',message:old});
   window.__event({type:'message_end',message:{...old,stopReason:'toolUse',usage:{totalTokens:100}}});
   window.__event({type:'message_update',message:{...live,content:[...live.content,...old.content]}});
   window.__event({type:'message_end',message:{...old,stopReason:'toolUse',usage:{totalTokens:100},content:[...old.content,...window.__tool('old-B',222).content]}});
   const after={a:rowA.innerHTML,b:rowB.innerHTML,live:rowC.innerHTML,
    ownerA:toolA.closest('.row')===rowA,ownerB:toolB.closest('.row')===rowB,
    rows:document.querySelectorAll('.messages > .row').length};
   // A genuine next frame must still update the new active turn.
   window.__event({type:'message_update',message:{...live,content:[{type:'text',text:'New active turn is still live'},...live.content]}});
   return {before,liveBefore,after,liveContinues:rowC.textContent.includes('New active turn is still live')};
  });
  assert.equal(result.after.a,result.before.a,'settled A unchanged');
  assert.equal(result.after.b,result.before.b,'settled B unchanged');
  assert.ok(result.after.ownerA&&result.after.ownerB,'historical calls cannot move');
  assert.equal(result.after.live,result.liveBefore,'stale events cannot replace new active content');
  assert.equal(result.after.rows,result.before.rows+1,'exactly one genuinely new row');
  assert.ok(result.liveContinues,'genuine live update still rendered');
 });
 for(const gap of [51,60,80]) await run(`authoritative content shrink clamps without re-sticking, gap ${gap}`,async(page)=>{
  await page.evaluate(()=>{
   window.__text=(text,timestamp=444)=>({role:'assistant',timestamp,content:[{type:'text',text}]});
   window.__event({type:'message_start',message:window.__text('Long live content.\n\n'.repeat(40))});
  });await frames(page);await detach(page,gap);const before=await metrics(page);
  // An older partial must not shrink the row. A final authoritative correction
  // may do so, and its native clamp still must not imply a return-to-tail intent.
  await page.evaluate(()=>window.__event({type:'message_end',message:{...window.__text('short'),stopReason:'stop'}}));
  await frames(page);const clamped=await metrics(page);
  assert.ok(clamped.max<before.top-100,'fixture must force browser scrollTop clamp');
  assert.ok(clamped.gap<=1,'browser clamps to shortened tail');await expectNewMessages(page);
  const box=await page.locator('.messages').boundingBox();
  await page.mouse.move(box.x+12,box.y+box.height/2);await page.mouse.wheel(0,-1);await frames(page);
  const held=await metrics(page);assert.ok(held.top<clamped.top,'native upward wheel really moved');await expectNewMessages(page);
  await page.evaluate(()=>window.__event({type:'message_start',message:window.__text('New words after clamp. '.repeat(40),445)}));
  await frames(page);const grown=await metrics(page);
  assert.ok(grown.max>held.max+50,'new content must grow');
  assert.ok(Math.abs(grown.top-held.top)<=1,'growth must not resume following after clamp/upward wheel');
  await expectNewMessages(page);
 });
}finally {
 await browser?.close();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log(`\n${failures?`${failures} failing`:'All 8 passing'} tool replay and shrink browser scenarios`);
process.exitCode=failures?1:0;
