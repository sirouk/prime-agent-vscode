/**
 * FOLLOWING / live-tail geometry regressions against an in-memory source bundle.
 * No daemon, paid model, generated asset, or synthetic user scroll is involved.
 * Usage: LIVE_TAIL_ARTIFACTS=/tmp/live-tail node test/live-tail-geometry.test.mjs
 * Optional: LIVE_TAIL_ONLY='pill|snapshot' or LIVE_TAIL_SOURCE_REF=d6e0d2c
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = process.env.LIVE_TAIL_ARTIFACTS ?? "/tmp/prime-live-tail-geometry";
await mkdir(dir, { recursive: true });
const sourceRef = process.env.LIVE_TAIL_SOURCE_REF;
// Optional captured TypeScript input for an intermediate read-only RED proof.
const transcriptSource = process.env.LIVE_TAIL_TRANSCRIPT_SOURCE;
const git = promisify(execFile);
async function source(path) {
 if (transcriptSource && relative(root,path)==="webview/transcript.ts") return readFile(transcriptSource);
 if (!sourceRef) return readFile(path);
 const {stdout} = await git("git", ["show", `${sourceRef}:${relative(root, path)}`], {cwd:root,maxBuffer:8*1024*1024});
 return Buffer.from(stdout);
}
const bundle = await build({absWorkingDir:root,entryPoints:["webview/main.ts"],bundle:true,write:false,
 format:"iife",platform:"browser",target:"es2022",logLevel:"silent",
 define:{PRIME_AGENT_BUILD_REV:JSON.stringify("live-tail-geometry-test")},
 plugins:sourceRef||transcriptSource?[{name:"historical-source",setup(api){api.onLoad({filter:/\.ts$/},async({path})=>({contents:(await source(path)).toString(),loader:"ts"}));}}]:[],
});
const assets=new Map([
 ["/preview.html",["text/html",await source(`${root}media/preview.html`)]],
 ["/main.css",["text/css",await source(`${root}media/main.css`)]],
 ["/main.js",["text/javascript",bundle.outputFiles[0].contents]],
]);
const server=createServer((req,res)=>{const a=assets.get(new URL(req.url,"http://localhost").pathname);res.writeHead(a?200:404,{"Content-Type":a?.[0]??"text/plain"});res.end(a?.[1]??"Not found");});
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
const usage={input:1640,output:519,cacheRead:0,cacheWrite:0,totalTokens:2159,cost:{input:.004,output:.006,total:.010}};
const history=Array.from({length:20},(_,i)=>i%2?{role:"assistant",timestamp:1000+i,responseId:`history-${i}`,stopReason:"stop",content:[{type:"text",text:`Earlier response ${i}. `+"Stable transcript history. ".repeat(20)}]}:{role:"user",timestamp:1000+i,content:`Earlier prompt ${i}`});
const frames=(page,n=3)=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
let browser; const reports=[];
async function seed(page) {
 await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
 await page.waitForSelector(".messages");
 await page.waitForSelector(".boot-splash", { state: "detached" });
 await page.evaluate(({history,usage})=>{
  const outer=document.querySelector(".messages");
  window.__durable=history;window.__status={...baseStatus,streaming:true,sessionId:"live-tail-geometry"};
  window.__live=null;window.__usage=usage;window.__phase="seed";window.__trace=[];window.__events=[];window.__tracks=new Map();
  window.__ids=new WeakMap();window.__idSeq=0;
  const ident=node=>{if(!node)return null;if(!window.__ids.has(node))window.__ids.set(node,++window.__idSeq);return window.__ids.get(node);};
  const geom=node=>{
   if(!node)return null;const r=node.getBoundingClientRect();const st=getComputedStyle(node);
   return {id:ident(node),connected:node.isConnected,top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width,
    scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,display:st.display,visibility:st.visibility,
    clippedVisible:r.bottom>outer.getBoundingClientRect().top&&r.top<outer.getBoundingClientRect().bottom&&st.display!=="none"};
  };
  window.__sample=label=>{
   const r=outer.getBoundingClientRect();const cards=[...outer.querySelectorAll(".tool")].map(c=>({part:c.dataset.part,kind:c.dataset.toolKind,
    state:c.querySelector(".tool-dot")?.className,inputTextLen:c.querySelector(".tool-section:not(.tool-result) pre")?.textContent.length??0,
    resultTextLen:c.querySelector(".tool-result pre")?.textContent.length??0,
    root:geom(c),owner:geom(c.closest(".row")),header:geom(c.querySelector(".tool-header")),pill:{...geom(c.querySelector(".tool-pill")),text:c.querySelector(".tool-pill")?.textContent},
    summary:c.querySelector(".tool-summary")?.textContent,input:geom(c.querySelector(".tool-section:not(.tool-result) pre")),result:geom(c.querySelector(".tool-result pre"))}));
   const activity=geom(document.querySelector(".chat-activity")),working=geom(document.querySelector(".working-row"));
   const value={label,phase:window.__phase,time:performance.now(),top:outer.scrollTop,max:outer.scrollHeight-outer.clientHeight,
    gap:outer.scrollHeight-outer.clientHeight-outer.scrollTop,scroller:geom(outer),chat:geom(outer.parentElement),app:geom(document.querySelector(".chat-root")),
    activity,working,workingText:document.querySelector(".working-label")?.textContent,
    overlay:!!working&&working.visibility==="visible"&&cards.some(c=>c.root.clippedVisible&&c.root.bottom>working.top&&c.root.top<working.bottom),
    jump:document.querySelector(".jump-to-latest")?.classList.contains("visible")??false,cards,
    tracks:[...window.__tracks].map(([name,node])=>({name,...geom(node)})),
    parts:[...outer.querySelectorAll(".row-body > [data-part]")].map(n=>({part:n.dataset.part,...geom(n),open:n.open})),
    footers:[...outer.querySelectorAll(".user-footer")].map(n=>geom(n)),
    visibleText:[...outer.children].filter(n=>{const b=n.getBoundingClientRect();return b.bottom>r.top&&b.top<r.bottom;}).map(n=>n.textContent.slice(0,300)),
   };
   window.__trace.push(value);return value;
  };
  window.__event=event=>{window.__events.push({phase:window.__phase,type:event.type,message:structuredClone(event.message),toolCallId:event.toolCallId});host({type:"event",event:structuredClone(event)});window.__sample(`event:${event.type}`);};
  window.__snapshot=({live=true,messages=null}={})=>{window.__events.push({phase:window.__phase,type:"snapshot",live});host({type:"snapshot",messages:structuredClone(messages??[...window.__durable,...(live&&window.__live?[window.__live]:[])]),state:null,status:window.__status});window.__sample("snapshot");};
  window.__track=(name,selector)=>{const node=document.querySelector(selector);if(!node)throw new Error(`Missing track ${name}: ${selector}`);window.__tracks.set(name,node);return geom(node);};
  window.__watch=true;const watch=()=>{if(!window.__watch)return;window.__sample("rAF");requestAnimationFrame(watch);};requestAnimationFrame(watch);
  window.__snapshot();window.__event({type:"agent_start"});
 },{history,usage});
 await frames(page);
 assert.ok((await page.evaluate(()=>window.__trace.at(-1).max))>1000,"real overflowing transcript");
}
async function step(page,name,fn,arg,n=3){
 // Change the phase and deliver its host events in one browser task. A separate
 // phase-only evaluate can mislabel a rAF that still shows the prior state.
 await page.evaluate(({name,fnSource,arg})=>{
  window.__phase=name;
  if(fnSource)(0,eval)(`(${fnSource})`)(arg);
 },{name,fnSource:fn?.toString()??null,arg});
 await frames(page,n);
}
async function shot(page,name){await page.screenshot({path:join(dir,`${name}.png`)});}
function backwards(trace,trackName) {
 const fs=trace.filter(s=>s.label==="rAF");let prev=null;const downs=[];
 for(const s of fs){const track=s.tracks.find(t=>t.name===trackName);if(track?.connected&&prev?.track.connected&&track.id===prev.track.id&&track.top>prev.track.top+.5)downs.push({delta:track.top-prev.track.top,before:prev.s,after:s});if(track)prev={s,track};}
 return downs;
}
async function run(name,test,viewport={width:420,height:620}) {
 if(process.env.LIVE_TAIL_ONLY&&!new RegExp(process.env.LIVE_TAIL_ONLY).test(name))return;
 const page=await browser.newPage({viewport});page.setDefaultTimeout(5000);const errors=[];page.on("pageerror",e=>errors.push(String(e)));
 let detail={},error=null;
 try{
  await seed(page);detail=await test(page)??{};assert.deepEqual(errors,[]);
  assert.equal(await page.locator(".pa-handler-error").count(),0,"no caught host-message handler errors");
  const visibleFrames=await page.evaluate(()=>window.__trace.filter(s=>s.label==="rAF"));
  assert.ok(visibleFrames.every(s=>s.gap<=1&&!s.jump),"every painted frame stays FOLLOWING at the actual tail");
  assert.ok(visibleFrames.every(s=>!s.overlay),"Working must not cover a visible tool card");
 }
 catch(e){error=String(e.stack);console.error(`FAIL ${name}\n${error}`);}
 const trace=await page.evaluate(()=>{window.__watch=false;return window.__trace;});
 const events=await page.evaluate(()=>window.__events);
 const tail=trace.at(-1);const report={name,pass:!error,error,detail,samples:trace.length,frames:trace.filter(s=>s.label==="rAF").length,
  overlays:trace.filter(s=>s.label==="rAF"&&s.overlay).length,maxGap:Math.max(...trace.filter(s=>s.label==="rAF").map(s=>s.gap)),
  artifact:join(dir,`${name}.json`),last:{phase:tail.phase,gap:tail.gap,visibleText:tail.visibleText,activity:tail.activity,working:tail.working}};
 await writeFile(report.artifact,JSON.stringify({report,events,trace},null,2));await shot(page,`${name}-current-visible`);
 reports.push(report);if(!error)console.log(`PASS ${name} ${JSON.stringify({detail,samples:report.samples,overlays:report.overlays,maxGap:report.maxGap})}`);
 await page.close();
}
const pythonCode="import json, pathlib\nfrom pathlib import Path\n"+Array.from({length:190},(_,i)=>`item_${i} = {'path': '/Users/chrisk/project/src/file_${i}.ts', 'count': ${i}}\n`).join("")+"print(json.dumps({'items': 190, 'ok': True}))\n";
const shellCode="%%bash\nset -euo pipefail\ncd /Users/chrisk/project\n"+Array.from({length:190},(_,i)=>`printf '%s\\n' 'Checking source item ${i}: long streamed shell call line'\n`).join("")+"npm run typecheck\n";
try{
 browser=await chromium.launch();
 for(const kind of ["python","shell"])await run(`${kind}-pill-lifecycle`,async page=>{
  const code=kind==="python"?pythonCode:shellCode;
  await step(page,"empty-message-start",()=>{window.__live={role:"assistant",timestamp:5000,responseId:"live-response",content:[]};window.__event({type:"message_start",message:window.__live});});
  await step(page,"tool-first-empty",()=>{window.__live.content=[{type:"toolCall",id:"live-tool",name:"ipython",arguments:{}}];window.__event({type:"message_update",message:window.__live,assistantMessageEvent:{type:"toolcall_start",contentIndex:0}});window.__track("card",'[data-part="tool-live-tool"]');window.__track("owner",'[data-part="tool-live-tool"] .tool-header');});
  await page.evaluate(async code=>{for(let i=1;i<=25;i++){await new Promise(requestAnimationFrame);window.__phase=`args-${i}`;window.__live.content[0].arguments={code:code.slice(0,Math.ceil(code.length*i/25))};window.__event({type:"message_update",message:window.__live,assistantMessageEvent:{type:"toolcall_delta",contentIndex:0,delta:"streamed chunk"}});if(i%4===0){window.__snapshot();window.__event({type:"message_start",message:window.__live});}}},code);
  await step(page,"message-end-usage",()=>{window.__live.stopReason="toolUse";window.__live.usage=window.__usage;window.__event({type:"message_end",message:window.__live});window.__durable.push(structuredClone(window.__live));});
  await shot(page,`${kind}-before-tool-execution`);
  await step(page,"tool-running",()=>window.__event({type:"tool_execution_start",toolCallId:"live-tool",toolName:"ipython",args:window.__live.content[0].arguments}));
  await step(page,"tool-partial",()=>window.__event({type:"tool_execution_update",toolCallId:"live-tool",partialResult:{output:"Checking source files\n".repeat(100)}}));
  await shot(page,`${kind}-tool-running`);
  await step(page,"tool-done",()=>{window.__event({type:"tool_execution_end",toolCallId:"live-tool",result:{output:"Checking source files\n".repeat(100)+"All done"},isError:false});window.__durable.push({role:"toolResult",timestamp:5001,toolCallId:"live-tool",toolName:"ipython",content:[{type:"text",text:"Checking source files\n".repeat(100)+"All done"}]});window.__live=null;});
  await shot(page,`${kind}-tool-done`);
  await step(page,"settled-replay-snapshot",()=>{window.__snapshot();const final=window.__durable.at(-2);window.__event({type:"message_start",message:final});window.__event({type:"message_update",message:{...final,stopReason:undefined,usage:undefined}});window.__event({type:"message_end",message:final});});
  const got=await page.evaluate(()=>window.__trace);const ds=backwards(got,"card");
  const phases=ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase,beforeHeight:d.before.cards.at(-1)?.root.height,afterHeight:d.after.cards.at(-1)?.root.height,beforeGap:d.before.gap,afterGap:d.after.gap}));
  const painted=got.filter(s=>s.label==="rAF");
  assert.equal(painted.some(s=>s.jump),false,"all frames stay FOLLOWING");
  const running=painted.filter(s=>["tool-running","tool-partial"].includes(s.phase));
  assert.ok(running.length>0&&running.every(s=>s.cards.at(-1).state==="tool-dot running"&&s.cards.at(-1).pill.display!=="none"),"genuine execution after assistant message_end stays running");
  assert.ok(running.some(s=>s.cards.at(-1).resultTextLen>100),"genuine execution partial output is painted");
  const done=painted.filter(s=>["tool-done","settled-replay-snapshot"].includes(s.phase));
  assert.ok(done.length>0&&done.every(s=>s.cards.at(-1).state==="tool-dot done"&&s.cards.at(-1).resultTextLen>100),"genuine execution settles with its output intact");
  assert.deepEqual(phases,[],`existing card must not move DOWN during append-only lifecycle: ${JSON.stringify(phases)}`);
  return {downs:phases};
 });
 for(const kind of ["python","shell"])for(const viewport of [{width:320,height:620},{width:900,height:720}])await run(`${kind}-execution-replay-${viewport.width}`,async page=>{
  const code=kind==="python"?pythonCode:shellCode;
  await step(page,"settled-card-snapshot",code=>{
   const message={role:"assistant",timestamp:8000,responseId:"settled-replay",stopReason:"toolUse",usage:window.__usage,content:[{type:"toolCall",id:"replay-tool",name:"ipython",arguments:{code}}]};
   const result={role:"toolResult",timestamp:8001,toolCallId:"replay-tool",toolName:"ipython",content:[{type:"text",text:"Successful source review\n".repeat(90)}]};
   window.__durable.push(message,result);window.__snapshot();window.__track("card",'[data-part="tool-replay-tool"]');window.__track("usage",'[data-part="tool-replay-tool"] ~ [data-part="usage"]');
  },code);
  await shot(page,`${kind}-execution-replay-${viewport.width}-before`);
  await step(page,"replayed-execution-start",()=>window.__event({type:"tool_execution_start",toolCallId:"replay-tool",toolName:"ipython",args:{}}));
  await shot(page,`${kind}-execution-replay-${viewport.width}-running`);
  await step(page,"replayed-execution-end",()=>window.__event({type:"tool_execution_end",toolCallId:"replay-tool",result:{output:"Successful source review\n".repeat(90)},isError:false}));
  await step(page,"same-authoritative-snapshot",()=>window.__snapshot());
  const got=await page.evaluate(()=>window.__trace),ds=backwards(got,"card");
  const heights=got.filter(s=>s.label==="rAF"&&s.cards.length).map(s=>({phase:s.phase,top:s.cards.at(-1).root.top,height:s.cards.at(-1).root.height,header:s.cards.at(-1).header.height,summary:s.cards.at(-1).summary,pill:s.cards.at(-1).pill.display,state:s.cards.at(-1).state,inputTextLen:s.cards.at(-1).inputTextLen,resultTextLen:s.cards.at(-1).resultTextLen,gap:s.gap}));
  assert.deepEqual(ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],`done->running->done execution replay must not move a mounted card DOWN: ${JSON.stringify(heights)}`);
  const afterSettled=heights.slice(heights.findIndex(h=>h.phase==="settled-card-snapshot"));
  const expectedSummary=afterSettled[0]?.summary;
  assert.ok(expectedSummary,"fixture has a real final collapsed summary");
  assert.ok(afterSettled.every(h=>h.summary===expectedSummary&&h.pill==="none"&&h.state==="tool-dot done"&&h.inputTextLen===afterSettled[0].inputTextLen&&h.resultTextLen===afterSettled[0].resultTextLen),`a settled tool summary/state must not flicker on execution-start replay: ${JSON.stringify(heights)}`);
  return {heights:[...new Map(heights.map(v=>[v.phase,v])).values()]};
 },viewport);
 for(const kind of ["python","shell"])await run(`${kind}-expanded-execution-replay`,async page=>{
  const code=kind==="python"?pythonCode:shellCode;
  await step(page,"expanded-settled-snapshot",code=>{
   const message={role:"assistant",timestamp:8200,responseId:"expanded-settled",stopReason:"toolUse",usage:window.__usage,content:[{type:"toolCall",id:"expanded-replay-tool",name:"ipython",arguments:{code}}]};
   const result={role:"toolResult",timestamp:8201,toolCallId:"expanded-replay-tool",toolName:"ipython",content:[{type:"text",text:"All checks passed."}]};
   window.__durable.push(message,result);window.__snapshot();document.querySelector('[data-part="tool-expanded-replay-tool"] .tool-toggle').click();window.__track("card",'[data-part="tool-expanded-replay-tool"]');
  },code);
  await shot(page,`${kind}-expanded-replay-before`);
  await step(page,"expanded-replayed-empty-start",()=>window.__event({type:"tool_execution_start",toolCallId:"expanded-replay-tool",toolName:"ipython",args:{}}));
  await shot(page,`${kind}-expanded-replay-during`);
  await step(page,"expanded-replayed-end",()=>window.__event({type:"tool_execution_end",toolCallId:"expanded-replay-tool",result:{output:"All checks passed."},isError:false}));
  await step(page,"expanded-current-snapshot",()=>window.__snapshot());
  await shot(page,`${kind}-expanded-replay-after`);
  const got=await page.evaluate(()=>window.__trace),ds=backwards(got,"card");
  const heights=got.filter(s=>s.label==="rAF"&&s.cards.length).map(s=>({phase:s.phase,top:s.cards.at(-1).root.top,height:s.cards.at(-1).root.height,input:s.cards.at(-1).input.height,header:s.cards.at(-1).header.height,summary:s.cards.at(-1).summary,pill:s.cards.at(-1).pill.display,state:s.cards.at(-1).state,inputTextLen:s.cards.at(-1).inputTextLen,resultTextLen:s.cards.at(-1).resultTextLen,gap:s.gap}));
  assert.ok(got.filter(s=>s.label==="rAF").every(s=>s.gap<=1&&!s.jump),"expanded replay must remain following");
  assert.deepEqual(ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],`a settled expanded card must not jiggle DOWN then UP when stale execution start repeats empty args: ${JSON.stringify(heights)}`);
  assert.ok(heights.every(h=>h.state==="tool-dot done"&&h.summary===heights[0].summary&&h.inputTextLen===heights[0].inputTextLen&&h.resultTextLen===heights[0].resultTextLen),"expanded settled state, input, and output receipt remain intact through replay");
 });
 for(const kind of ["python","shell"])await run(`${kind}-expanded-input-stream`,async page=>{
  const code=kind==="python"?pythonCode:shellCode;
  await step(page,"empty-tool",()=>{window.__live={role:"assistant",timestamp:8500,responseId:"expanded-live",content:[{type:"toolCall",id:"expanded-tool",name:"ipython",arguments:{}}]};window.__event({type:"message_start",message:window.__live});document.querySelector('[data-part="tool-expanded-tool"] .tool-toggle').click();window.__track("card",'[data-part="tool-expanded-tool"]');window.__track("history-line",'.messages > .row-assistant:nth-last-child(2)');});
  await page.evaluate(async code=>{for(let i=1;i<=32;i++){await new Promise(requestAnimationFrame);window.__phase=`expanded-input-${i}`;window.__live.content[0].arguments={code:code.slice(0,Math.ceil(code.length*i/32))};window.__event({type:"message_update",message:window.__live});if(i%4===0){window.__snapshot();window.__event({type:"message_start",message:window.__live});}}},code);
  await step(page,"expanded-final-input",()=>{window.__live.stopReason="toolUse";window.__live.usage=window.__usage;window.__event({type:"message_end",message:window.__live});});
  await step(page,"expanded-output-start",()=>window.__event({type:"tool_execution_start",toolCallId:"expanded-tool",toolName:"ipython",args:window.__live.content[0].arguments}));
  await page.evaluate(async()=>{for(let i=1;i<=25;i++){await new Promise(requestAnimationFrame);window.__phase=`expanded-output-${i}`;window.__event({type:"tool_execution_update",toolCallId:"expanded-tool",partialResult:{output:"source check output line\n".repeat(i*6)}});}});
  await step(page,"expanded-output-done",()=>window.__event({type:"tool_execution_end",toolCallId:"expanded-tool",result:{output:"source check output line\n".repeat(150)},isError:false}));
  const got=await page.evaluate(()=>window.__trace),ds=backwards(got,"card");
  assert.deepEqual(ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],"expanded input/output growth must not reverse a mounted card while following");
 });
 await run("settled-shorter-execution-end-replay",async page=>{
  await step(page,"genuine-final-result",()=>{
   window.__live={role:"assistant",timestamp:8700,responseId:"result-replay",content:[{type:"toolCall",id:"result-replay-tool",name:"ipython",arguments:{code:"print('source review')"}}]};
   window.__event({type:"message_start",message:window.__live});
   window.__live.stopReason="toolUse";window.__live.usage=window.__usage;window.__event({type:"message_end",message:window.__live});
   window.__event({type:"tool_execution_start",toolCallId:"result-replay-tool",toolName:"ipython",args:window.__live.content[0].arguments});
   const output="Successful source review output line\n".repeat(100)+"All checks passed.\n";
   window.__event({type:"tool_execution_end",toolCallId:"result-replay-tool",result:{output},isError:false});
   window.__durable.push(structuredClone(window.__live),{role:"toolResult",timestamp:8701,toolCallId:"result-replay-tool",toolName:"ipython",content:[{type:"text",text:output}]});window.__live=null;
   document.querySelector('[data-part="tool-result-replay-tool"] .tool-toggle').click();
   window.__track("card",'[data-part="tool-result-replay-tool"]');window.__track("footer",'[data-part="tool-result-replay-tool"] ~ [data-part="usage"]');window.__track("result",'[data-part="tool-result-replay-tool"] .tool-result pre');
  });
  await shot(page,"settled-shorter-result-before");
  await step(page,"duplicate-partial-execution-start",()=>window.__event({type:"tool_execution_start",toolCallId:"result-replay-tool",toolName:"ipython",args:{}}));
  await step(page,"duplicate-shorter-execution-end",()=>window.__event({type:"tool_execution_end",toolCallId:"result-replay-tool",result:{output:"partial"},isError:false}));
  await shot(page,"settled-shorter-result-during");
  await step(page,"authoritative-current-result",()=>window.__snapshot());
  await shot(page,"settled-shorter-result-after");
  const got=await page.evaluate(()=>window.__trace),painted=got.filter(s=>s.label==="rAF"&&s.cards.length),ds=backwards(got,"card");
  const initial=painted[0].cards.at(-1);
  assert.ok(initial.resultTextLen>1000,"fixture has a real settled long output receipt");
  assert.ok(painted.every(s=>s.cards.at(-1).state==="tool-dot done"&&s.cards.at(-1).pill.display==="none"&&s.cards.at(-1).summary===initial.summary&&s.cards.at(-1).inputTextLen===initial.inputTextLen&&s.cards.at(-1).resultTextLen===initial.resultTextLen),"duplicate partial execution start/end cannot regress completed input, output, or final state");
  assert.deepEqual(ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],"duplicate shorter execution end cannot move the completed expanded card DOWN then UP");
 });
 await run("thinking-live-snapshot-growth",async page=>{
  await step(page,"empty-start",()=>{window.__live={role:"assistant",timestamp:6000,responseId:"thinking-live",content:[]};window.__event({type:"message_start",message:window.__live});});
  await step(page,"thinking-first",()=>{window.__live.content=[{type:"thinking",thinking:"I will inspect the source and stream the tool call carefully."}];window.__event({type:"message_update",message:window.__live});});
  await step(page,"prose-and-tool",code=>{window.__live.content.push({type:"text",text:"I am checking the build pipeline."},{type:"toolCall",id:"thought-tool",name:"ipython",arguments:{code}});window.__event({type:"message_update",message:window.__live});window.__track("card",'[data-part="tool-thought-tool"]');window.__track("thinking",'[data-part="think-0"]');},pythonCode.slice(0,200));
  await page.evaluate(async code=>{for(let i=1;i<=35;i++){await new Promise(requestAnimationFrame);window.__phase=`thinking-grow-${i}`;window.__live.content[0].thinking+="\nAnother line of reasoning explains the source review and expected geometry.";window.__live.content[2].arguments.code=code.slice(0,Math.ceil(code.length*i/35));window.__event({type:"message_update",message:window.__live});if(i%3===0){window.__snapshot({live:i%2===0});window.__event({type:"message_start",message:window.__live});}}},pythonCode);
  await step(page,"live-current",()=>window.__snapshot());
  const got=await page.evaluate(()=>window.__trace);const ds=backwards(got,"card");
  assert.deepEqual(ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],"growing thinking and snapshots must not reverse existing card movement while following");
  assert.equal(got.filter(s=>s.label==="rAF").some(s=>s.jump),false,"all frames stay FOLLOWING");
 });
 await run("snapshot-growth-watermark",async page=>{
  await step(page,"watermark-prior-receipt",()=>{
   const message={role:"assistant",timestamp:8800,responseId:"watermark-witness",stopReason:"toolUse",usage:window.__usage,content:[{type:"toolCall",id:"watermark-prior-tool",name:"ipython",arguments:{code:"print('retained witness')"}}]};
   window.__durable.push(message,{role:"toolResult",timestamp:8801,toolCallId:"watermark-prior-tool",toolName:"ipython",content:[{type:"text",text:"retained witness"}]});window.__snapshot();
  });
  await step(page,"watermark-short-live",()=>{
   window.__live={role:"assistant",timestamp:8850,responseId:"watermark-live",content:[{type:"thinking",thinking:"Inspect the source before running the streamed Python call."},{type:"text",text:"Inspect"},{type:"toolCall",id:"watermark-live-tool",name:"ipython",arguments:{code:"import json, pathlib\n"}}]};
   window.__event({type:"message_start",message:window.__live});window.__event({type:"message_update",message:window.__live});
   window.__track("card",'[data-part="tool-watermark-live-tool"]');window.__track("prior-card",'[data-part="tool-watermark-prior-tool"]');window.__track("footer",'[data-part="tool-watermark-prior-tool"] ~ [data-part="usage"]');window.__track("thinking",'[data-part="think-0"]');
  });
  await step(page,"watermark-full-snapshot",code=>{
   window.__live.content[0].thinking="Inspect the source before running the streamed Python call.\n".repeat(8);
   window.__live.content[1].text="Inspect the retained code card and report the source geometry.";
   window.__live.content[2].arguments.code=code;window.__snapshot();
  },pythonCode);
  await shot(page,"snapshot-watermark-before-medium");
  await step(page,"watermark-medium-replayed-partial",()=>{
   const medium={...window.__live,content:[{type:"thinking",thinking:"Inspect the source before running the streamed Python call.\n".repeat(4)},{type:"text",text:"Inspect the retained code card."},{type:"toolCall",id:"watermark-live-tool",name:"ipython",arguments:{code:"import json, pathlib\nfrom pathlib import Path\n"}}]};
   window.__event({type:"message_start",message:medium});window.__event({type:"message_update",message:medium});
  });
  await shot(page,"snapshot-watermark-during-medium");
  await step(page,"watermark-next-full-delta",()=>window.__event({type:"message_update",message:window.__live}));
  await shot(page,"snapshot-watermark-after-full");
  const got=await page.evaluate(()=>window.__trace),painted=got.filter(s=>s.label==="rAF"&&s.tracks.length),ds=backwards(got,"prior-card");
  assert.ok(painted.every(s=>s.gap<=1&&!s.jump&&s.tracks.every(t=>t.connected)),"snapshot-growth witnesses stay mounted and following");
  const accepted=painted.find(s=>s.phase==="watermark-full-snapshot"),short=painted.find(s=>s.phase==="watermark-short-live");
  assert.ok(accepted.tracks.find(t=>t.name==="thinking").height>short.tracks.find(t=>t.name==="thinking").height+50,"snapshot must really grow existing live content beyond the pre-snapshot watermark");
  assert.ok(accepted.tracks.find(t=>t.name==="prior-card").clippedVisible&&accepted.tracks.find(t=>t.name==="footer").clippedVisible,"card/footer witnesses must actually be visible after accepted snapshot");
  assert.deepEqual(ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],"a medium old partial cannot roll back a larger accepted live snapshot and move retained card/footer DOWN then UP");
 });
 await run("same-tool-stale-live-visual-jiggle",async page=>{
  await step(page,"prior-settled-card",()=>{
   const message={role:"assistant",timestamp:6900,responseId:"witness-response",stopReason:"toolUse",usage:window.__usage,content:[{type:"toolCall",id:"witness-tool",name:"ipython",arguments:{code:"print('recent result')"}}]};
   const result={role:"toolResult",timestamp:6901,toolCallId:"witness-tool",toolName:"ipython",content:[{type:"text",text:"recent result"}]};
   window.__durable.push(message,result);window.__snapshot();
  });
  await step(page,"same-tool-full-live",code=>{
   window.__live={role:"assistant",timestamp:6950,responseId:"same-tool-live",content:[{type:"thinking",thinking:"Check the streamed Python call and live tail source.\n".repeat(6)},{type:"text",text:"Inspect the retained code card below."},{type:"toolCall",id:"same-live-tool",name:"ipython",arguments:{code}}]};
   window.__event({type:"message_start",message:window.__live});window.__event({type:"message_update",message:window.__live});
   window.__track("card",'[data-part="tool-same-live-tool"]');window.__track("prior-card",'[data-part="tool-witness-tool"]');window.__track("footer",'[data-part="tool-witness-tool"] ~ [data-part="usage"]');
   window.__track("thinking",'[data-part="think-0"]');
  },pythonCode);
  await step(page,"same-tool-full-snapshot",()=>window.__snapshot());
  await shot(page,"same-tool-stale-before");
  await step(page,"same-tool-replayed-older-partial",()=>{
   const stale={...window.__live,content:[{type:"thinking",thinking:"Check the streamed Python call and live tail source."},{type:"text",text:"Inspect"},{type:"toolCall",id:"same-live-tool",name:"ipython",arguments:{code:"import json, pathlib\n"}}]};
   window.__event({type:"message_start",message:stale});window.__event({type:"message_update",message:stale});
  });
  await shot(page,"same-tool-stale-during");
  await step(page,"same-tool-next-current-delta",()=>window.__event({type:"message_update",message:window.__live}));
  await shot(page,"same-tool-stale-after");
  const got=await page.evaluate(()=>window.__trace),ds=backwards(got,"prior-card");
  const phases=ds.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase,beforeTop:d.before.tracks.find(t=>t.name==="prior-card").top,afterTop:d.after.tracks.find(t=>t.name==="prior-card").top}));
  const frameValues=got.filter(s=>s.label==="rAF"&&s.tracks.length);
  assert.ok(frameValues.every(s=>s.gap<=1&&!s.jump),"geometry jiggle must occur while FOLLOWING, not a detached-scroll test");
  assert.ok(frameValues.every(s=>s.tracks.every(t=>t.connected)),"every witness must stay mounted; this tests visual jiggle, not identity loss");
  assert.deepEqual(phases,[],`retained visible prior card/footer must not move DOWN then UP from shorter same-response, same-tool live replay: ${JSON.stringify(phases)}`);
 });
 await run("stale-live-update-after-snapshot",async page=>{
  await step(page,"full-live",code=>{window.__live={role:"assistant",timestamp:7000,responseId:"catchup-live",content:[{type:"thinking",thinking:"Reasoning source review.\n".repeat(10)},{type:"text",text:"Now inspect the streamed Python tool input."},{type:"toolCall",id:"catchup-tool",name:"ipython",arguments:{code}}]};window.__event({type:"message_start",message:window.__live});window.__event({type:"message_update",message:window.__live});window.__track("card",'[data-part="tool-catchup-tool"]');window.__track("thinking",'[data-part="think-0"]');window.__track("history-line",'.messages > .row-assistant:nth-last-child(2)');},pythonCode);
  await step(page,"snapshot-full-live",()=>window.__snapshot());
  await shot(page,"stale-live-before-replay");
  await step(page,"replayed-old-partial",()=>{const stale={...window.__live,content:[{type:"thinking",thinking:"Reasoning source review."}]};window.__event({type:"message_start",message:stale});window.__event({type:"message_update",message:stale});});
  await shot(page,"stale-live-replayed-partial");
  await step(page,"next-full-delta",()=>window.__event({type:"message_update",message:window.__live}));
  const got=await page.evaluate(()=>window.__trace);const losses=got.filter(s=>s.label==="rAF"&&s.tracks.some(t=>t.name==="card"&&!t.connected));
  const down=backwards(got,"history-line");
  const positions=got.filter(s=>s.label==="rAF").map(s=>({phase:s.phase,gap:s.gap,top:s.top,history:s.tracks.find(t=>t.name==="history-line"),thinking:s.tracks.find(t=>t.name==="thinking")}));
  assert.deepEqual(down.map(d=>({delta:d.delta,before:d.before.phase,after:d.after.phase})),[],`a retained visible history line must not jiggle DOWN then UP through old replay: ${JSON.stringify(positions.map(p=>({phase:p.phase,top:p.top,y:p.history?.top,thinkingHeight:p.thinking?.height,gap:p.gap})))}`);
  assert.equal(losses.length,0,"replayed old live partial must not erase an existing card without authoritative removal");
 });
}finally{await browser?.close();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
await writeFile(join(dir,"summary.json"),JSON.stringify(reports,null,2));
console.log(`Artifacts: ${dir}`);process.exitCode=reports.some(r=>!r.pass)?1:0;
