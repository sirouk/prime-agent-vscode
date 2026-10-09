/**
 * Source-bundle Chromium regressions for stable snapshot mounts and activity chrome.
 * No daemon, RPC process, paid model, or generated build artifact is involved.
 * Usage: node test/scroll-mount.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
// Optional baseline: SCROLL_MOUNT_SOURCE_REF=11ba0a0 node test/scroll-mount.test.mjs
// Read historical source in memory. Never check it out or overwrite build assets.
const sourceRef = process.env.SCROLL_MOUNT_SOURCE_REF;
const git = promisify(execFile);
async function source(path) {
 if (!sourceRef) return readFile(path);
 const { stdout } = await git("git", ["show", `${sourceRef}:${relative(root, path)}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
 return Buffer.from(stdout);
}
const bundle = await build({
	absWorkingDir: root,
	entryPoints: ["webview/main.ts"],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2022",
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("scroll-mount-test") },
	logLevel: "silent",
 plugins: sourceRef ? [{name:"historical-source",setup(api){
  api.onLoad({filter:/\.ts$/},async ({path})=>({contents:(await source(path)).toString(),loader:"ts"}));
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
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
let browser;
let failures = 0;
let scenarios = 0;
const SESSION = "stable-mount-fixture";
const usage = {input:100,output:50,cacheRead:0,cacheWrite:0,totalTokens:150,
 cost:{input:.001,output:.002,cacheRead:0,cacheWrite:0,total:.003}};
const lines = prefix => Array.from({length:100},(_,i)=>`${prefix} line ${i}`).join("\n");
const CODE = `print('stable call')\n${lines("# input")}`;
const OUTPUT = lines("stable output");
function history() {
 return Array.from({length:24},(_,i)=>i%2 ? {role:"assistant",timestamp:1000+i,stopReason:"stop",
  content:[{type:"text",text:`History reply ${i}. `+"Earlier transcript words. ".repeat(18)}]} :
  {role:"user",timestamp:1000+i,content:`History prompt ${i}`});
}
const completed = () => ({role:"assistant",timestamp:5000,responseId:"settled-response",stopReason:"toolUse",usage,
 content:[{type:"text",text:"Selected stable assistant prose."},
  {type:"toolCall",id:"settled-tool",name:"ipython",arguments:{code:CODE}}]});
const result = () => ({role:"toolResult",timestamp:5001,toolCallId:"settled-tool",toolName:"ipython",
 content:[{type:"text",text:OUTPUT}],isError:false});
const live = () => ({role:"assistant",timestamp:6000,responseId:"live-response",
 content:[{type:"toolCall",id:"live-tool",name:"ipython",arguments:{code:CODE}}]});
const frames = (page,count=4)=>page.evaluate(async n=>{
 for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);
},count);
async function seed(page,{messages=[...history(),completed(),result()],streaming=true}={}) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.evaluate(({messages,streaming,sessionId})=>{
  window.__messages=messages;
  window.__status={...baseStatus,sessionId,streaming};
  window.__event=event=>host({type:"event",event});
  window.__snapshot=(messages=window.__messages,status=window.__status)=>
   host({type:"snapshot",messages:structuredClone(messages),state:null,status:{...status}});
  window.__snapshot();
 },{messages,streaming,sessionId:SESSION});
 await frames(page);
}
async function run(name,test) {
 scenarios++;
 const page=await browser.newPage({viewport:{width:420,height:620}});
 page.setDefaultTimeout(5000);
 const errors=[];
 page.on("pageerror",error=>errors.push(String(error)));
 try {
  await test(page);
  assert.deepEqual(errors,[],"no webview page errors");
  console.log(`PASS  ${name}`);
 } catch(error) {
  failures++;
  console.error(`FAIL  ${name}\n  ${error.stack}`);
 } finally {await page.close();}
}

/** Retain exact references. Watching the whole document also catches an ancestor
 * removal, or a same-node remove+insert that ends connected and looks identical.
 * Do NOT count text-node updates as mounts: changing content in place is valid. */
async function watchMounts(page,ids=["settled-tool"],{selection=true,selectionTarget="prose"}={}) {
 await page.evaluate(({ids,selection,selectionTarget})=>{
  window.__protected={};
  const keep=(key,node)=>{if(!node)throw new Error(`Missing protected node: ${key}`);window.__protected[key]=node;};
  for(const id of ids){
   const card=document.querySelector(`[data-part="tool-${id}"]`);
   keep(`${id}:card`,card);
   keep(`${id}:row`,card.closest(".row-assistant"));
   keep(`${id}:body`,card.closest(".row-body"));
   keep(`${id}:toggle`,card.querySelector(".tool-toggle"));
   keep(`${id}:input-section`,card.querySelector(".tool-body").firstElementChild);
   keep(`${id}:input-pre`,card.querySelector(".tool-body pre"));
   keep(`${id}:result-section`,card.querySelector(".tool-result"));
   keep(`${id}:result-pre`,card.querySelector(".tool-result pre"));
   keep(`${id}:scroll-body`,card.querySelector(".tool-body"));
   const usage=card.closest(".row-assistant").querySelector('[data-part="usage"]');
   if(id==="settled-tool")keep(`${id}:usage`,usage);
   if(!card.classList.contains("open"))card.querySelector(".tool-toggle").click();
  }
  const user=[...document.querySelectorAll(".row-user")].find(r=>r.textContent.includes("History prompt 22"));
  keep("user:row",user);keep("user:footer",user.querySelector(".user-footer"));
  const outer=document.querySelector(".messages"),card=window.__protected[`${ids[0]}:card`];
  outer.scrollTop+=card.getBoundingClientRect().top-outer.getBoundingClientRect().top-30;
  outer.dispatchEvent(new Event("scroll"));
  for(const [key,node] of Object.entries(window.__protected)){
   if(key.endsWith("-pre")||key.endsWith(":scroll-body")){
    node.scrollTop=47;node.dispatchEvent(new Event("scroll"));
   }
  }
  if(selection){
   const row=window.__protected["settled-tool:row"];
   const text=selectionTarget==="result"?window.__protected["settled-tool:result-pre"].firstChild:
    row.querySelector('[data-part="text-0"] p').firstChild;
   const range=document.createRange();range.setStart(text,0);range.setEnd(text,8);
   const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
   window.__selection={text:sel.toString(),anchor:sel.anchorNode,focus:sel.focusNode,anchorOffset:sel.anchorOffset,focusOffset:sel.focusOffset};
  }else window.__selection=null;
  window.__mountChanges=[];
  window.__mountObserver=new MutationObserver(records=>{
   for(const record of records)for(const kind of ["removedNodes","addedNodes"]){
    for(const changed of record[kind])for(const [key,node] of Object.entries(window.__protected)){
     if(changed===node||changed.contains(node))window.__mountChanges.push({kind,key});
    }
   }
  });
  window.__mountObserver.observe(document.body,{childList:true,subtree:true});
 },{ids,selection,selectionTarget});
 await frames(page);
 return page.evaluate(()=>{
  window.__panePositions=Object.fromEntries(Object.entries(window.__protected)
   .filter(([key])=>key.endsWith("-pre")||key.endsWith(":scroll-body"))
   .map(([key,node])=>[key,node.scrollTop]));
  return window.__panePositions;
 });
}
async function expectMounted(page,label,{panes=true,selection=true}={}) {
 await frames(page);
 const got=await page.evaluate(()=>{
  const identities=Object.entries(window.__protected).map(([key,node])=>{
   let current;
   if(key==="user:row")current=[...document.querySelectorAll(".row-user")].find(r=>r.textContent.includes("History prompt 22"));
   else if(key==="user:footer")current=[...document.querySelectorAll(".row-user")].find(r=>r.textContent.includes("History prompt 22"))?.querySelector(".user-footer");
   else{
    const [id,part]=key.split(":"),card=document.querySelector(`[data-part="tool-${id}"]`);
    current=part==="card"?card:part==="row"?card?.closest(".row-assistant"):part==="body"?card?.closest(".row-body"):
     part==="toggle"?card?.querySelector(".tool-toggle"):part==="input-section"?card?.querySelector(".tool-body")?.firstElementChild:
     part==="input-pre"?card?.querySelector(".tool-body pre"):part==="result-section"?card?.querySelector(".tool-result"):
     part==="result-pre"?card?.querySelector(".tool-result pre"):part==="scroll-body"?card?.querySelector(".tool-body"):
     card?.closest(".row-assistant")?.querySelector('[data-part="usage"]');
   }
   return {key,same:node===current,connected:node.isConnected};
  });
  const sel=getSelection(),saved=window.__selection;
  return {identities,changes:window.__mountChanges,
   open:Object.entries(window.__protected).filter(([key])=>key.endsWith(":card")).every(([,node])=>node.classList.contains("open")),
   panes:Object.entries(window.__panePositions).map(([key,top])=>({key,before:top,after:window.__protected[key].scrollTop})),
   selection:!saved||(sel.toString()===saved.text&&sel.anchorNode===saved.anchor&&sel.focusNode===saved.focus&&
    sel.anchorOffset===saved.anchorOffset&&sel.focusOffset===saved.focusOffset)};
 });
 assert.deepEqual(got.identities.filter(r=>!r.same||!r.connected),[],`${label}: all nodes remain the exact mounted objects`);
 assert.deepEqual(got.changes,[],`${label}: zero protected subtree remove/reinsert records`);
 assert.equal(got.open,true,`${label}: expanded tools stay open`);
 if(panes)for(const pane of got.panes)assert.ok(Math.abs(pane.after-pane.before)<=1,`${label}: nested scroll moved ${JSON.stringify(pane)}`);
 if(selection)assert.equal(got.selection,true,`${label}: selected text and exact range endpoints survive`);
}
async function startLive(page) {
 await page.evaluate(message=>{
  window.__live=message;
  window.__event({type:"message_start",message});
  window.__event({type:"tool_execution_start",toolCallId:"live-tool",toolName:"ipython",args:message.content[0].arguments});
  window.__event({type:"tool_execution_update",toolCallId:"live-tool",partialResult:{output:window.__output}});
 },live());
 await frames(page);
}
async function liveSeed(page) {
 await seed(page);
 await page.evaluate(output=>window.__output=output,OUTPUT);
 await startLive(page);
}
async function fakeRunClock(page) {
 // Keep RAF native. A controllable wall clock and the actual production interval
 // callback prove timer continuity without sleeps or a multi-second test delay.
 await page.addInitScript(()=>{
  window.__now=1900000000000;Date.now=()=>window.__now;
  window.__intervals=new Map();
  const set=window.setInterval.bind(window),clear=window.clearInterval.bind(window);
  window.setInterval=(callback,delay,...args)=>{const id=set(callback,delay,...args);window.__intervals.set(id,()=>callback(...args));return id;};
  window.clearInterval=id=>{window.__intervals.delete(id);clear(id);};
  window.__advance=ms=>{window.__now+=ms;for(const fn of window.__intervals.values())fn();};
 });
}
const seconds=text=>Number(text.match(/(\d+)s/)?.[1]??0);
async function activity(page) {
 return page.evaluate(()=>{
  const row=document.querySelector(".working-row"),label=row?.querySelector(".working-label");
  const activity=document.querySelector(".chat-activity"),messages=document.querySelector(".messages"),status=document.querySelector(".status-strip");
  const rect=e=>{const b=e?.getBoundingClientRect();return b?{top:b.top,bottom:b.bottom,height:b.height}:null;};
  const style=row?getComputedStyle(row):null;
  const visible=!!row&&style.display!=="none"&&style.visibility!=="hidden"&&Number(style.opacity)!==0&&row.getBoundingClientRect().height>0;
  return {present:visible,mounted:!!row,label:label?.textContent,slot:rect(activity),row:rect(row),messages:rect(messages),status:rect(status),
   chat:rect(messages.parentElement),slotPosition:getComputedStyle(activity).position,pointerEvents:style?.pointerEvents,
   sibling:!!activity&&activity.parentElement===messages.parentElement,
   contained:!!status&&status.contains(row),floating:!!activity&&activity.contains(row),position:row?getComputedStyle(row).position:null,
   same:row===window.__workingRef,sameLabel:label===window.__workingLabelRef,changes:window.__workingChanges??[]};
 });
}
try {
 browser=await chromium.launch();
 await run("repeated same-session snapshots never remount completed card, row, usage or user footer",async page=>{
  await seed(page);const positions=await watchMounts(page,["settled-tool"],{selectionTarget:"result"});
  assert.ok(positions["settled-tool:input-pre"]>0&&positions["settled-tool:result-pre"]>0,"both pre fixtures overflow and hold nested scroll");
  for(let i=0;i<6;i++){
   await page.evaluate(()=>window.__snapshot());
   await expectMounted(page,`identical snapshot ${i}`);
  }
 });
 await run("changed input, result and usage patch existing nodes in place",async page=>{
  await seed(page);await watchMounts(page);
  await page.evaluate(()=>{
   const assistant=window.__messages.find(m=>m.role==="assistant"&&m.responseId==="settled-response");
   assistant.content[1].arguments.code+="\nprint('changed input in place')";
   assistant.usage={...assistant.usage,totalTokens:175};
   window.__messages.find(m=>m.role==="toolResult").content[0].text+="\nchanged result in place";
   window.__snapshot();
  });
  await expectMounted(page,"changed snapshot");
  assert.ok((await page.locator('[data-part="tool-settled-tool"] .tool-body pre').first().textContent()).includes("changed input in place"));
  assert.ok((await page.locator('[data-part="tool-settled-tool"] .tool-result pre').textContent()).includes("changed result in place"));
  assert.ok((await page.locator('[data-part="usage"]').textContent()).includes("175 tokens"));
  await page.evaluate(()=>{
   const assistant=window.__messages.find(m=>m.responseId==="settled-response");
   assistant.content[1].arguments.code=assistant.content[1].arguments.code.replace("stable call","edited call");
   window.__snapshot();
  });
  await expectMounted(page,"same-length settled correction");
  assert.ok((await page.locator('[data-part="tool-settled-tool"] .tool-body pre').first().textContent()).includes("edited call"),
   "settled same-length content corrections are not mistaken for stale input");
 });
 await run("partial snapshot omitting live message and subsequent start/update replay preserve live card",async page=>{
  await liveSeed(page);await watchMounts(page,["settled-tool","live-tool"]);
  await page.evaluate(()=>window.__snapshot());
  await expectMounted(page,"omitted-live snapshot");
  await page.evaluate(()=>{
   window.__event({type:"message_start",message:window.__live});
   window.__live.content[0].arguments.code+="\nprint('replayed live delta')";
   window.__event({type:"message_update",message:window.__live});
  });
  await expectMounted(page,"live start/update replay");
  assert.equal(await page.locator('[data-part="tool-live-tool"]').count(),1);
  assert.ok((await page.locator('[data-part="tool-live-tool"] .tool-body pre').first().textContent()).includes("replayed live delta"));
 });
 await run("snapshot including live same call rehydrates and replays without mounts",async page=>{
  await liveSeed(page);await watchMounts(page,["settled-tool","live-tool"]);
  for(let i=0;i<4;i++){
   await page.evaluate(()=>{
    window.__snapshot([...window.__messages,window.__live]);
    window.__event({type:"message_start",message:window.__live});
    window.__event({type:"message_update",message:window.__live});
   });
   await expectMounted(page,`included-live snapshot/replay ${i}`);
  }
  assert.equal(await page.locator('[data-part="tool-live-tool"]').count(),1);
  assert.equal(await page.locator('.row-assistant').filter({has:page.locator('[data-part="tool-live-tool"]')}).locator('[data-part="usage"]').count(),0,
   "snapshot must not invent a final usage footer on the live assistant");
 });
 await run("stale shorter snapshot does not shrink mounted tool input/result or lose final usage",async page=>{
  await seed(page);await watchMounts(page);
  await page.evaluate(()=>{
   const stale=structuredClone(window.__messages);
   const assistant=stale.find(m=>m.responseId==="settled-response");
   assistant.content[1].arguments.code="print('stable call')";
   delete assistant.stopReason;delete assistant.usage;
   stale.find(m=>m.role==="toolResult").content[0].text="stable output line 0";
   window.__snapshot(stale);
  });
  await expectMounted(page,"stale shorter snapshot");
  assert.equal(await page.locator('[data-part="tool-settled-tool"] .tool-body pre').first().textContent(),CODE);
  assert.equal(await page.locator('[data-part="tool-settled-tool"] .tool-result pre').textContent(),OUTPUT);
  assert.ok((await page.locator('[data-part="usage"]').textContent()).includes("150 tokens"));
 });
 await run("compact status timer leaves transcript geometry and tool input unchanged",async page=>{
  await seed(page);
  const got=await activity(page);
  assert.equal(got.present,true,"streaming snapshot shows Working");
  assert.equal(got.sibling,true,".chat-activity is a sibling of .messages");
  assert.equal(got.contained,true,"elapsed timer belongs to the bottom status strip");
  assert.equal(got.floating,false,"only New messages floats over the transcript");
  assert.equal(got.slotPosition,"absolute","activity strip reserves no separate row");
  assert.ok(got.slot.height>0,"floating strip has usable bounds");
  assert.ok(Math.abs(got.messages.bottom-got.chat.bottom)<=1,"transcript reaches the chat bottom behind controls");
  assert.ok(Math.abs(got.messages.height-got.chat.height)<=1,"controls consume no transcript viewport height");
  assert.ok(got.row.top>=got.status.top-1&&got.row.bottom<=got.status.bottom+1,"timer fits the bottom status strip");
  assert.notEqual(got.position,"absolute","timer flows within its reserved status slot");
  assert.equal(got.pointerEvents,"none","Working cannot intercept underlying tool input");
  const hidden=await page.evaluate(()=>{
   const activity=document.querySelector(".chat-activity"),messages=document.querySelector(".messages");
   const before={height:messages.clientHeight,scrollHeight:messages.scrollHeight};
   activity.style.display="none";
   const after={height:messages.clientHeight,scrollHeight:messages.scrollHeight};
   activity.style.display="";
   return {before,after};
  });
  assert.deepEqual(hidden.before,hidden.after,"floating activity has no layout cost");
  await page.evaluate(()=>window.__event({type:"agent_end"}));await frames(page);
  const idle=await activity(page);
  assert.equal(idle.present,false,"agent_end hides the run indicator");
  assert.ok(Math.abs(idle.slot.height-got.slot.height)<=1,"idle retains floating strip bounds");
  assert.ok(Math.abs(idle.messages.bottom-got.messages.bottom)<=1,"idle transition does not resize transcript viewport");
 });
 await run("Working label and elapsed timer stay mounted and continuous through tool transitions and snapshot",async page=>{
  await fakeRunClock(page);await seed(page);
  await page.evaluate(()=>{
   window.__workingRef=document.querySelector(".working-row");
   window.__workingLabelRef=document.querySelector(".working-label");
   window.__workingChanges=[];
   window.__workingObserver=new MutationObserver(records=>{
    for(const record of records)for(const kind of ["removedNodes","addedNodes"])for(const node of record[kind]){
     if(node===window.__workingRef||node.contains(window.__workingRef)||node===window.__workingLabelRef||node.contains(window.__workingLabelRef))
      window.__workingChanges.push(kind);
    }
   });
   window.__workingObserver.observe(document.body,{childList:true,subtree:true});
   window.__advance(3000);
  });
  assert.equal(seconds((await activity(page)).label),3,"initial run clock advances");
  const steps=[
   ["message_start",()=>{window.__live={role:"assistant",timestamp:6000,responseId:"clock-live",content:[{type:"toolCall",id:"clock-tool",name:"ipython",arguments:{code:"print(1)"}}]};window.__event({type:"message_start",message:window.__live});}],
   ["message_update",()=>window.__event({type:"message_update",message:window.__live})],
   ["message_end",()=>window.__event({type:"message_end",message:{...window.__live,stopReason:"toolUse",usage:{totalTokens:12}}})],
   ["tool_execution_start",()=>window.__event({type:"tool_execution_start",toolCallId:"clock-tool",toolName:"ipython",args:{code:"print(1)"}})],
   ["tool_execution_update",()=>window.__event({type:"tool_execution_update",toolCallId:"clock-tool",partialResult:{output:"1"}})],
   ["tool_execution_end",()=>window.__event({type:"tool_execution_end",toolCallId:"clock-tool",result:{output:"1"},isError:false})],
   ["turn_end",()=>window.__event({type:"turn_end"})],
   ["same-session snapshot",()=>window.__snapshot()],
  ];
  let expected=3;
  for(const [label,step] of steps){
   await page.evaluate(step);await frames(page);
   const before=await activity(page);
   assert.equal(before.present,true,`${label}: Working stays visible`);
   assert.equal(before.same,true,`${label}: exact Working row remains`);
   assert.equal(before.sameLabel,true,`${label}: exact label remains`);
   assert.deepEqual(before.changes,[],`${label}: no activity row/label remove+insert`);
   assert.equal(seconds(before.label),expected,`${label}: elapsed clock cannot reset`);
   await page.evaluate(()=>window.__advance(1000));expected++;
   assert.equal(seconds((await activity(page)).label),expected,`${label}: same run timer advances`);
  }
  await page.evaluate(()=>window.__event({type:"agent_end"}));await frames(page);
  assert.equal((await activity(page)).present,false,"run end stops Working");
  await page.evaluate(()=>{window.__advance(5000);window.__event({type:"agent_start"});window.__advance(1000);});
  assert.equal(seconds((await activity(page)).label),1,"genuine next run starts a new timer");
 });
 await run("genuine session navigation resets mounted transcript, expansion, selection and timer",async page=>{
  await fakeRunClock(page);await seed(page);await watchMounts(page);
  await page.evaluate(()=>{
   window.__advance(9000);
   window.__oldWorking=document.querySelector(".working-row");
   window.__status={...window.__status,sessionId:"genuinely-new-session"};
   host({type:"status",status:window.__status});
   // Same identities in a different session must still build new nodes.
   window.__snapshot(window.__messages);
   window.__advance(1000);
  });await frames(page);
  const got=await page.evaluate(()=>({
   detached:Object.values(window.__protected).every(n=>!n.isConnected),
   open:document.querySelector('[data-part="tool-settled-tool"]').classList.contains("open"),
   selection:getSelection().toString(),sameWorking:window.__oldWorking===document.querySelector(".working-row"),
   gap:(e=>e.scrollHeight-e.clientHeight-e.scrollTop)(document.querySelector(".messages")),
  }));
  assert.equal(got.detached,true,"new session must not retain old-session nodes even with matching tool ids");
  assert.equal(got.open,false,"old session expansion is not transferred");
  assert.equal(got.selection,"","old selected content is not transferred");
  assert.equal(got.sameWorking,false,"new session owns a new run indicator");
  assert.equal(seconds((await activity(page)).label),1,"new-session run timer resets");
  assert.ok(got.gap<=2,"new session opens at transcript tail");
 });
 await run("authoritative same-session compaction removes obsolete cards and rows",async page=>{
  await seed(page);await watchMounts(page);
  await page.evaluate(()=>window.__snapshot([
   {role:"compactionSummary",timestamp:8000,summary:"Authoritative compacted replacement.",tokensBefore:3000,retainedMessageCount:0},
   {role:"user",timestamp:8001,content:"Retained compacted prompt"},
  ],{...window.__status,streaming:false}));await frames(page);
  assert.equal(await page.evaluate(()=>Object.values(window.__protected).every(n=>!n.isConnected)),true,"obsolete mounts must be detached on compaction");
  assert.equal(await page.locator('[data-part="tool-settled-tool"]').count(),0,"old tool card is gone");
  const text=await page.locator(".messages").textContent();
  assert.ok(text.includes("Authoritative compacted replacement."));
  assert.ok(text.includes("Retained compacted prompt"));
  assert.equal(text.includes("History reply"),false,"old transcript data is not retained");
  assert.equal((await activity(page)).present,false,"compaction's idle snapshot stops activity");
 });
} finally {
 await browser?.close();
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log(`\n${failures?`${failures}/${scenarios} failing`:`All ${scenarios} passing`} stable-mount browser scenarios${sourceRef?` (source ${sourceRef})`:""}`);
process.exitCode=failures?1:0;
