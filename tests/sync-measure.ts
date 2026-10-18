/** Manual #24 measurement runner. No browser/server starts without the explicit gate. */
import { writeFile,mkdir,readFile,realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { timeAtFrame } from '../src/frame-clock.ts';
import type { SyncBrowserReport } from './sync-measure-browser.ts';
interface Page {goto(url:string):Promise<unknown>;waitForFunction(fn:()=>boolean):Promise<unknown>;evaluate<T>(fn:()=>T|Promise<T>):Promise<T>;evaluate<T,A>(fn:(arg:A)=>T|Promise<T>,arg:A):Promise<T>}
interface Browser {newPage(options:{viewport:{width:number;height:number}}):Promise<Page>;version():string;close():Promise<void>}
interface Playwright {chromium:{launch(options:{headless:boolean;args:string[]}):Promise<Browser>}}
const quantile=(values:number[],q:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(q*values.length)-1)]!:null;
function summary(report:SyncBrowserReport){
 const phases=Object.fromEntries((['playback','scrub','timer-1x','timer-half'] as const).map(phase=>{
  const raw=report.samples.filter(row=>row.phase===phase),all=phase==='scrub'?raw.filter(row=>row.seekCalls>=2&&row.drawCalls>=2):raw,posed=all.filter(row=>row.seekCalls>=2);
  const drift=(when:'before'|'after',clock:'mediaTime'|'currentTimeAfter')=>all.flatMap(row=>[row[when].a,row[when].b].filter((time):time is number=>time!==null).map(time=>Math.abs(time-row[clock])*24));
  const stats=(values:number[])=>({max:values.length?Math.max(...values):null,median:quantile(values,.5),p95:quantile(values,.95)});
  const gaps=all.slice(1).map((row,i)=>row.presentedFrames!==null&&all[i]!.presentedFrames!==null?Math.max(0,row.presentedFrames-all[i]!.presentedFrames!-1):0);
  const lateness=posed.filter(row=>row.expectedDisplayTime!==null).map(row=>Math.max(0,Math.max(row.callbackStartedAt+row.callbackMs,row.poseFinishedAt??0)-row.expectedDisplayTime!));
  return [phase,{callbacks:all.length,posedPairs:posed.length,previousPoseAgeVsPresentedPtsFrames:stats(drift('before','mediaTime')),targetPoseDriftVsPresentedPtsFrames:stats(drift('after','mediaTime')),postPoseVsElementCurrentTimeFrames:{...stats(drift('after','currentTimeAfter')),meaning:'HTMLMediaElement.currentTime after pose; diagnostic only, not decoded PTS'},bothPoseMs:{p50:quantile(posed.map(row=>row.seekMs),.5),p95:quantile(posed.map(row=>row.seekMs),.95)},bothDrawMs:{p50:quantile(posed.map(row=>row.drawMs),.5),p95:quantile(posed.map(row=>row.drawMs),.95)},callbackMs:{p50:quantile(posed.map(row=>row.callbackMs),.5),p95:quantile(posed.map(row=>row.callbackMs),.95)},presentedFrameGaps:{total:gaps.reduce((a,b)=>a+b,0),max:gaps.length?Math.max(...gaps):null},callbackDeadline:{misses:lateness.filter(value=>value>0).length,latenessMs:stats(lateness),lateness24fpsFrames:stats(lateness.map(value=>value/1000*24))}}];
 }));
 const completed=report.scrubs,drifts=completed.flatMap(row=>[Math.abs(row.a-row.mediaTime)*24,Math.abs(row.b-row.mediaTime)*24]);
 return {...phases,completedScrubs:{count:completed.length,poseMs:{p50:quantile(completed.map(row=>row.poseMs),.5),p95:quantile(completed.map(row=>row.poseMs),.95)},targetDriftFrames:{max:drifts.length?Math.max(...drifts):null,median:quantile(drifts,.5)},reviewLabelMismatches:completed.filter(row=>!row.reviewLabels.b.startsWith(`Review F${row.requestedFrame} /`)).map(row=>row.requestedFrame)}};
}
async function main(args:string[]):Promise<void>{
 if(!args.includes('--browser-authorized'))throw new Error('SYNC_BROWSER_PERMISSION_REQUIRED: obtain explicit user permission before launching this measurement. This flag records permission; it cannot grant it.');
 const options=new Map<string,string>();for(let i=0;i<args.length;i++){if(args[i]==='--browser-authorized')continue;const value=args[++i];if(!value)throw new Error('sync-measure: missing option value');options.set(args[i-1]!,value);}
 const required=(key:string)=>{const value=options.get(key);if(!value)throw new Error('sync-measure: required '+key);return value;};
 const input={a:required('--a'),b:required('--b'),reference:required('--reference'),animation:required('--animation')},out=resolve(required('--out'));
 // Fresh private profile/context; no connectOverCDP or existing browser tabs.
 const moduleName=options.get('--playwright-module')??'playwright';
 const tool=await import(moduleName) as Playwright;
 const p=await loadCompare(input);for(const root of [p.a.root,p.b.root]){if(out===root||out.startsWith(root+'/'))throw new Error('sync-measure: evidence destination must be outside both packages');}
 const referencePath=await realpath(input.reference);if(out===referencePath)throw new Error('sync-measure: cannot overwrite source video');
 await mkdir(out,{recursive:true});const app=await startCompareServer(p,{port:0,stateDir:resolve(out,'state')});
 let browser:Browser|null=null,proxy:ReturnType<typeof Bun.serve>|null=null;const cleanup={ownedBrowserClosed:true,ownedProxyStopped:true,ownedAppStopped:false,hqServerAccessed:false};
 try{
  const built=await Bun.build({entrypoints:[resolve(import.meta.dir,'sync-measure-browser.ts')],target:'browser',format:'esm'});if(!built.success)throw new Error(built.logs.map(row=>row.message).join('\n'));const bundle=built.outputs[0]!;
  cleanup.ownedProxyStopped=false;proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const url=new URL(req.url);if(url.origin!==`http://127.0.0.1:${proxy!.port}`)return new Response('Loopback host required',{status:403});if(req.method!=='GET'&&req.method!=='HEAD')return new Response('Read-only measurement',{status:405});if(url.pathname==='/main.js')return new Response(req.method==='HEAD'?null:bundle,{headers:{'Content-Type':'text/javascript'}});const headers=new Headers(req.headers);headers.delete('host');return fetch(`http://127.0.0.1:${app.port}${url.pathname}${url.search}`,{method:req.method,headers,redirect:'error'});}});
  const flags=['--autoplay-policy=no-user-gesture-required'];browser=await tool.chromium.launch({headless:true,args:flags});cleanup.ownedBrowserClosed=false;const page=await browser.newPage({viewport:{width:1600,height:1000}});
  await page.goto(`http://127.0.0.1:${proxy.port}/`);await page.waitForFunction(()=>window.__rigReviewSync?.ready()===true);
  const persist=async(stage:string)=>{const report=await page.evaluate(()=>window.__rigReviewSync!.report()),result={schema:'rig-review-sync-measure/1',stage,host:{label:options.get('--host-label')??'unlabeled measurement host',browser:browser!.version(),flags,platform:process.platform,bun:Bun.version},source:p.response.binding,units:{driftFramesPerSecond:24,meaning:'issue #24 comparison unit, not an inferred producer FPS'},interpretation:{previousPoseAge:'May normally be one previous frame at callback entry; assess with deadline lateness and presentation gaps, not as failure alone',postPose:'PTS-target agreement alone does not prove compositor display synchronization',mutants:'timer-1x uses an independent same-rate wall clock; timer-half is a deliberately wrong-speed sensitivity control, not proof that every 1x timer must drift'},inputRoles:{a:'v20',b:'v22',scrubBasis:'B explicit report clock; never borrowed by A'},summary:summary(report),...report};await writeFile(resolve(out,'sync.json'),JSON.stringify(result,null,2)+'\n');return result;};
  if(options.get('--mode')==='late-control'){await page.waitForFunction(()=>!(document.getElementById('frame-seek') as HTMLButtonElement|null)?.disabled);const control=await page.evaluate(async()=>window.__rigReviewSync!.lateControl());await persist('forced-late-live-pause-recovery');await writeFile(resolve(out,'late-control.json'),JSON.stringify(control,null,2)+'\n');if(JSON.stringify(control.held.drawn)!==JSON.stringify(control.initial.drawn)||!control.held.feedbackDisabled||control.held.frameSeekDisabled||control.recovered.feedbackDisabled||control.held.prepared.a===control.held.drawn.a)throw new Error('late-control: held draw/feedback/pause recovery mismatch');return;}
  if(options.get('--mode')==='missing-index'){await page.evaluate(async()=>{await window.__rigReviewSync!.basicPlayback();});const result=await persist('missing-index-basic-playback');await writeFile(resolve(out,'missing-index.json'),JSON.stringify({frameSeekDisabled:await page.evaluate(()=>(document.getElementById('frame-seek') as HTMLButtonElement).disabled),status:await page.evaluate(()=>document.getElementById('frame-index-status')!.textContent),samples:result.samples.length})+'\n');return;}
  if(options.get('--mode')!=='scrub-only'){await page.evaluate(async()=>{await window.__rigReviewSync!.playback();});await persist('baseline-playback');}
  await page.waitForFunction(()=>!(document.getElementById('frame-seek') as HTMLButtonElement|null)?.disabled);
  const clock=p.b.report?.clock;if(!clock)throw new Error('sync-measure: explicit B report clock required for requested-frame scrub probes');
  for(const frame of [0,100,176,177,178,179,180,181,182,183,184,1,312]){const time=timeAtFrame(clock,frame);if(time!==null)await page.evaluate(async arg=>{await window.__rigReviewSync!.scrub(arg.frame,arg.time);},{frame,time});}
  await persist('completed-scrub');if(options.get('--mode')!=='scrub-only')await page.evaluate(async()=>{await window.__rigReviewSync!.mutant();});
  const result=await persist(options.get('--mode')==='scrub-only'?'scrub-only-complete':'complete');console.log(JSON.stringify(result.summary,null,2));
  // Record the exact observer bytes; no screenshot or device-visual claim.
  await writeFile(resolve(out,'harness.json'),JSON.stringify({observerSha256:createHash('sha256').update(await readFile(resolve(import.meta.dir,'sync-measure-browser.ts'))).digest('hex')},null,2)+'\n');
  await page.evaluate(()=>window.__rigReviewSync!.stop());
 }finally{try{await browser?.close();cleanup.ownedBrowserClosed=true;}finally{try{await proxy?.stop(true);cleanup.ownedProxyStopped=true;}finally{try{await app.stop(true);cleanup.ownedAppStopped=true;}finally{await writeFile(resolve(out,'cleanup.json'),JSON.stringify(cleanup)+'\n');}}}}
}
// Not auto-discovered by bun test; invocation is deliberate and permission-gated.
if(import.meta.main)main(Bun.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
