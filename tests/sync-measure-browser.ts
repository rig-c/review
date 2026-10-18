/** Measurement-only browser entry. Never imported by the production app. */
import { RigPlayer } from '@rig-c/play';
import { frameAtTime } from '../src/frame-clock.ts';
import type { CompareResponse } from '../src/compare.ts';

type Phase = 'idle' | 'playback' | 'scrub' | 'timer-1x' | 'timer-half';
interface Sample {
 phase:Phase; callbackNow:number;callbackStartedAt:number; mediaTime:number; currentTimeBefore:number; currentTimeAfter:number;
 preparedBefore:{a:number|null;b:number|null};preparedAfter:{a:number|null;b:number|null};expectedDisplayTime:number|null; presentedFrames:number|null; before:{a:number|null;b:number|null}; after:{a:number|null;b:number|null};
 poseFinishedAt:number|null;seekMs:number; drawMs:number; callbackMs:number; seekCalls:number; drawCalls:number; requestedTimes:number[]; appliedTimes:number[];
}
interface Scrub { poseMs:number;drawMs:number;reviewLabels:{a:string;b:string};requestedFrame:number; requestedTime:number; mediaTime:number; a:number; b:number; referenceFrames:{a:number|null;b:number|null};playerFrames:{a:number|null;b:number|null} }
export interface SyncBrowserReport { samples:Sample[]; scrubs:Scrub[]; errors:string[]; callbackSource:'requestVideoFrameCallback'|'currentTime fallback'; runtimeVersion:string; userAgent:string; visibility:string; mutant:{rate:number;epoch:number}|null }
interface TransportProbe {drawn:{a:number|null;b:number|null};prepared:{a:number|null;b:number|null};targetPts:number|null;feedbackDisabled:boolean;frameSeekDisabled:boolean;status:string}
export interface SyncProbe { ready():boolean; playback():Promise<void>;basicPlayback():Promise<void>;lateControl():Promise<{initial:TransportProbe;held:TransportProbe;recovered:TransportProbe;injectedSeekDelayMs:number}>; scrub(frame:number,time:number):Promise<void>; mutant():Promise<void>; report():SyncBrowserReport; stop():void }
declare global { interface Window { __rigReviewSync?:SyncProbe } }
const video= document.querySelector<HTMLVideoElement>('#reference-video');
if(!video)throw new Error('sync-measure: compare reference video required');
const reference=video,players:RigPlayer[]=[],samples:Sample[]=[],scrubs:Scrub[]=[],errors:string[]=[];
let phase:Phase='idle',active:Sample|null=null,latest:Sample|null=null,timer:{rate:number;epoch:number}|null=null,disposed=false;
let injectedSeekDelayMs=0;let seekSerial=0,drawSerial=0,totalSeekMs=0,totalDrawMs=0;let fallbackHandle:number|null=null;const callbacks=new Set<number>();
const originalSeek=RigPlayer.prototype.seek,originalDraw=RigPlayer.prototype.draw;
const drawn=new Map<RigPlayer,number>();
const prepared=()=>({a:players[0]?.time??null,b:players[1]?.time??null});
const pose=()=>({a:players[0]?drawn.get(players[0])??null:null,b:players[1]?drawn.get(players[1])??null:null});
// The existing pair helper calls A.seek then B.seek; no private fields are read.
RigPlayer.prototype.seek=function(time:number):void {
 if(!players.includes(this)){if(players.length===2)throw new Error('sync-measure: unexpected third player');players.push(this);}
 const applied=time;
 const started=performance.now();try{const result=originalSeek.call(this,applied);if(injectedSeekDelayMs>0){const until=performance.now()+injectedSeekDelayMs;while(performance.now()<until){/* measurement-only deliberate CPU stall */}}return result;}finally{const cost=performance.now()-started;seekSerial++;totalSeekMs+=cost;const row=active??latest;if(row){row.seekMs+=cost;row.seekCalls++;row.requestedTimes.push(time);row.appliedTimes.push(applied);row.preparedAfter=prepared();}}
};
RigPlayer.prototype.draw=function():void {const started=performance.now();try{const result=originalDraw.call(this);drawn.set(this,this.time);return result;}finally{const cost=performance.now()-started;drawSerial++;totalDrawMs+=cost;const row=active??latest;if(row){row.drawMs+=cost;row.drawCalls++;row.after=pose();row.preparedAfter=prepared();row.currentTimeAfter=reference.currentTime;row.poseFinishedAt=performance.now();}}};
const prototype=HTMLVideoElement.prototype,originalFrames=prototype.requestVideoFrameCallback;
if(typeof originalFrames==='function')prototype.requestVideoFrameCallback=function(callback:VideoFrameRequestCallback):number {
 if(this!==reference)return originalFrames.call(this,callback);
 let handle=0;handle=originalFrames.call(this,(now,metadata)=>{
  callbacks.delete(handle);
  const row:Sample={phase,callbackNow:now,callbackStartedAt:performance.now(),mediaTime:metadata.mediaTime,currentTimeBefore:reference.currentTime,currentTimeAfter:reference.currentTime,preparedBefore:prepared(),preparedAfter:prepared(),expectedDisplayTime:metadata.expectedDisplayTime,presentedFrames:metadata.presentedFrames,before:pose(),after:pose(),poseFinishedAt:null,seekMs:0,drawMs:0,callbackMs:0,seekCalls:0,drawCalls:0,requestedTimes:[],appliedTimes:[]};
  const started=performance.now();active=row;latest=row;
  try{callback(now,metadata);}finally{row.after=pose();row.preparedAfter=prepared();row.currentTimeAfter=reference.currentTime;row.callbackMs=performance.now()-started;active=null;if(phase!=='idle')samples.push(row);}
 });callbacks.add(handle);return handle;
};
else {
 // Observational only: no independent posing. Costs still use public methods;
 // fallback cannot claim actual presented-frame PTS or full decoded-frame bars.
 const next=()=>{if(disposed)return;const p=pose();if(phase!=='idle')samples.push({phase,callbackNow:performance.now(),callbackStartedAt:performance.now(),mediaTime:reference.currentTime,currentTimeBefore:reference.currentTime,currentTimeAfter:reference.currentTime,preparedBefore:prepared(),preparedAfter:prepared(),expectedDisplayTime:null,presentedFrames:null,before:p,after:p,poseFinishedAt:null,seekMs:0,drawMs:0,callbackMs:0,seekCalls:0,drawCalls:0,requestedTimes:[],appliedTimes:[]});fallbackHandle=requestAnimationFrame(next);};fallbackHandle=requestAnimationFrame(next);
}
const node=<T extends HTMLElement>(id:string)=>{const value=document.getElementById(id);if(!value)throw new Error('sync-measure: missing '+id);return value as T;};
async function until(condition:()=>boolean,timeout=20000):Promise<void>{const deadline=performance.now()+timeout;while(!condition()){if(performance.now()>deadline)throw new Error('sync-measure: timed out waiting for actual app state');await new Promise<void>(resolve=>setTimeout(resolve,20));}}
let data:CompareResponse;
async function seek(time:number,frame?:number):Promise<void>{
 if(frame===undefined&&!reference.seeking&&players.length===2&&players.every(player=>Math.abs(player.time-time)<1e-9))return;
 const beforeSeek=seekSerial,beforeDraw=drawSerial;
 if(frame===undefined){node<HTMLInputElement>('time-input').value=String(time);node<HTMLButtonElement>('seek').click();}
 else{node<HTMLSelectElement>('frame-basis').value='b';node<HTMLInputElement>('frame-input').value=String(frame);node<HTMLButtonElement>('frame-seek').click();}
 await until(()=>!reference.seeking&&seekSerial>=beforeSeek+2&&drawSerial>=beforeDraw+2);
}
async function playFor(seconds:number|null):Promise<void>{
 await new Promise<void>((resolve,reject)=>{
  let deadline:ReturnType<typeof setTimeout>,bounded:ReturnType<typeof setTimeout>|null=null,poll:ReturnType<typeof setInterval>;
  const finish=(error?:Error)=>{clearTimeout(deadline);if(bounded!==null)clearTimeout(bounded);clearInterval(poll);reference.removeEventListener('ended',ended);reference.pause();error?reject(error):resolve();};
  const ended=()=>finish();reference.addEventListener('ended',ended,{once:true});
  deadline=setTimeout(()=>finish(new Error('sync-measure: playback watchdog expired')),120000);
  if(seconds!==null)bounded=setTimeout(()=>finish(),seconds*1000);
  poll=setInterval(()=>{if(node<HTMLButtonElement>('play').disabled)finish(new Error('sync-measure: actual app pair failed'));else if(reference.paused&&reference.currentTime>=Number(node<HTMLInputElement>('scrub').max)-.01)finish();},50);
  node<HTMLButtonElement>('play').click();
 });
}
async function timerMutant(rate:1|0.5):Promise<void>{
 if(typeof originalFrames!=='function')throw new Error('sync-measure: decoded-frame mutant requires requestVideoFrameCallback');
 // Cancel only callbacks registered by this isolated page's actual app. The
 // negative controls deliberately substitute independent 1x/half-rate timers,
 // while retaining the real public players/poser/draw and decoded video PTS.
 for(const handle of callbacks)reference.cancelVideoFrameCallback(handle);callbacks.clear();
 timer={rate,epoch:performance.now()};phase=rate===1?'timer-1x':'timer-half';let frame:number|null=null;
 const observe=()=>{frame=originalFrames.call(reference,(now,metadata)=>{const p=pose();samples.push({phase,callbackNow:now,callbackStartedAt:performance.now(),mediaTime:metadata.mediaTime,currentTimeBefore:reference.currentTime,currentTimeAfter:reference.currentTime,preparedBefore:prepared(),preparedAfter:prepared(),expectedDisplayTime:metadata.expectedDisplayTime,presentedFrames:metadata.presentedFrames,before:p,after:p,poseFinishedAt:null,seekMs:0,drawMs:0,callbackMs:0,seekCalls:0,drawCalls:0,requestedTimes:[],appliedTimes:[]});observe();});};observe();
 const interval=setInterval(()=>{const t=(performance.now()-timer!.epoch)/1000*timer!.rate;for(const player of players){originalSeek.call(player,t);originalDraw.call(player);drawn.set(player,player.time);}},1000/24);
 try{await reference.play();await new Promise<void>(resolve=>setTimeout(resolve,5000));}finally{clearInterval(interval);if(frame!==null)reference.cancelVideoFrameCallback(frame);reference.pause();phase='idle';}
}
const transport=():TransportProbe=>({drawn:pose(),prepared:prepared(),targetPts:latest?.mediaTime??null,feedbackDisabled:node<HTMLButtonElement>('add-feedback').disabled,frameSeekDisabled:node<HTMLButtonElement>('frame-seek').disabled,status:node('sync-status').textContent??''});
window.addEventListener('error',event=>errors.push(event.message));
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
window.__rigReviewSync={
 ready:()=>players.length===2&&!node<HTMLButtonElement>('play').disabled&&!reference.seeking,
 async playback(){phase='scrub';await seek(0);phase='playback';await playFor(null);phase='idle';},
 async basicPlayback(){phase='playback';await playFor(2);phase='idle';},
 async lateControl(){const initial=transport();injectedSeekDelayMs=80;phase='playback';node<HTMLButtonElement>('play').click();await new Promise<void>(resolve=>setTimeout(resolve,2000));const held=transport();injectedSeekDelayMs=0;phase='scrub';const beforeSeek=seekSerial,beforeDraw=drawSerial;node<HTMLButtonElement>('play').click();await until(()=>reference.paused&&!reference.seeking&&seekSerial>=beforeSeek+2&&drawSerial>=beforeDraw+2);const recovered=transport();phase='idle';return {initial,held,recovered,injectedSeekDelayMs:80};},
 async scrub(frame,time){phase='scrub';const beforePose=totalSeekMs,beforeDraw=totalDrawMs;await seek(time,frame);if(!latest||players.length!==2)throw new Error('sync-measure: no completed real pair');const a=players[0]!.time,b=players[1]!.time;scrubs.push({poseMs:totalSeekMs-beforePose,drawMs:totalDrawMs-beforeDraw,reviewLabels:{a:node('a-frame').textContent??'',b:node('b-frame').textContent??''},requestedFrame:frame,requestedTime:time,mediaTime:latest.mediaTime,a,b,referenceFrames:{a:frameAtTime(data.a.report?.clock,latest.mediaTime),b:frameAtTime(data.b.report?.clock,latest.mediaTime)},playerFrames:{a:frameAtTime(data.a.report?.clock,a),b:frameAtTime(data.b.report?.clock,b)}});phase='idle';},
 async mutant(){for(const rate of [1,0.5] as const){phase='scrub';await seek(0);await timerMutant(rate);}},
 report:()=>({samples:samples.map(row=>({...row})),scrubs:[...scrubs],errors:[...errors],callbackSource:typeof originalFrames==='function'?'requestVideoFrameCallback':'currentTime fallback',runtimeVersion:data.a.reviewedSource.runtimeVersion,userAgent:navigator.userAgent,visibility:document.visibilityState,mutant:timer}),
 stop(){disposed=true;reference.pause();if(fallbackHandle!==null)cancelAnimationFrame(fallbackHandle);RigPlayer.prototype.seek=originalSeek;RigPlayer.prototype.draw=originalDraw;if(typeof originalFrames==='function')prototype.requestVideoFrameCallback=originalFrames;}
};
// Bundle deduplication shares exactly the public class instrumented above.
// This runs the actual compare UI, not a replacement animation loop.
data=await(await fetch('/api/compare')).json() as CompareResponse;
await import('../web/compare.ts');
