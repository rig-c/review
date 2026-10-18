import type { ReviewedSource } from './manifest.ts';
import type { CompareBinding } from './compare.ts';
import type { ReportSeeds } from './report.ts';
import type { FrameClock } from './frame-clock.ts';

export type StripSide='single'|'a'|'b';
export interface StripInterval {id:string;feedbackId?:string;basis:StripSide;frameStart:number;frameEnd:number}
export interface StripRequest {format:'png'|'json';sourceHash:string;animation:string;referenceId?:string;intervals:StripInterval[]}
export interface StripBinding {sourceHash:string;packages:{id:StripSide;label:string;sourceHash:string;reviewedSource:ReviewedSource}[];reference:{name:string;sha256:string};compare:CompareBinding|null}
export interface StripRow {id:'reference'|StripSide;label:string}
export interface StripGroup {id:string;feedbackId:string|null;basis:StripSide;frameStart:number;frameEnd:number;samples:{requestedFrame:number;time:number|null}[]}
/** layout.footerHeight is a maximum provenance budget; rendering.height records the measured PNG. */
export interface StripPlan {schema:'rig-review-strip/1';mode:'single'|'compare';animation:string;basis:StripSide;rows:StripRow[];groups:StripGroup[];binding:StripBinding;layout:{cellWidth:number;cellHeight:number;labelHeight:number;rowLabelWidth:number;groupGap:number;footerHeight:number}}
export interface StripRenderInput {plan:StripPlan;referencePath:string;rigs:{id:StripSide;root:string;modelPath:string;animation:string;clock:FrameClock|null}[]}
export interface StripRenderSample {groupId:string;requestedFrame:number;requestedTime:number;presentedTime:number;delta:number;decodedFrame:number;sampling:'video-frame';playerTimes:Partial<Record<StripSide,number>>;frames:Partial<Record<StripSide,number|null>>}
export interface StripRenderResult {png:Uint8Array;width:number;height:number;renderer:{name:string;version:string;backend:string};samples:StripRenderSample[]}
export const stripNoClock='report에 frameTimes 없음 — pose 0.30.0 이상으로 재생성';
function obj(value:unknown,field:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${field}: expected object`);return value as Record<string,unknown>;}
function text(value:unknown,field:string):string{if(typeof value!=='string'||!value.trim()||value.length>256)throw new Error(`${field}: expected nonempty string <= 256 characters`);return value;}
function keys(value:Record<string,unknown>,allowed:string[],field:string){for(const key of Object.keys(value))if(!allowed.includes(key))throw new Error(`${field}.${key}: unsupported field`);}
export function parseStripRequest(input:unknown):StripRequest{
  const v=obj(input,'strip');keys(v,['format','sourceHash','animation','referenceId','intervals'],'strip');
  if(v.format!=='png'&&v.format!=='json')throw new Error('strip.format: expected png | json');
  if(typeof v.sourceHash!=='string'||!/^([a-f0-9]{64})$/.test(v.sourceHash))throw new Error('strip.sourceHash: expected bound SHA-256');
  if(!Array.isArray(v.intervals)||v.intervals.length<1||v.intervals.length>64)throw new Error('strip.intervals: expected 1…64 inclusive intervals');
  const intervals=v.intervals.map((value,index)=>{const f=`strip.intervals[${index}]`,r=obj(value,f);keys(r,['id','feedbackId','basis','frameStart','frameEnd'],f);if(r.basis!=='single'&&r.basis!=='a'&&r.basis!=='b')throw new Error(`${f}.basis: expected single | a | b`);if(!Number.isSafeInteger(r.frameStart)||!Number.isSafeInteger(r.frameEnd)||(r.frameStart as number)<0||(r.frameEnd as number)<(r.frameStart as number))throw new Error(`${f}: expected inclusive safe integers 0 <= frameStart <= frameEnd`);return {id:text(r.id,f+'.id'),...(r.feedbackId===undefined?{}:{feedbackId:text(r.feedbackId,f+'.feedbackId')}),basis:r.basis,frameStart:r.frameStart as number,frameEnd:r.frameEnd as number} as StripInterval;});
  if(new Set(intervals.map(v=>v.id)).size!==intervals.length)throw new Error('strip.intervals.id: expected unique ids');
  if(intervals.reduce((n,v)=>n+v.frameEnd-v.frameStart+1,0)>256)throw new Error('strip.intervals: export exceeds 256 total frames; split the selection');
  return {format:v.format,sourceHash:v.sourceHash,animation:text(v.animation,'strip.animation'),...(v.referenceId===undefined?{}:{referenceId:text(v.referenceId,'strip.referenceId')}),intervals};
}
/** Only explicit report frameTimes select export times, including in uniform-clock packages. */
export function planStrip(request:StripRequest,context:{mode:'single'|'compare';binding:StripBinding;reports:Partial<Record<StripSide,ReportSeeds|null>>}):StripPlan{
  if(request.sourceHash!==context.binding.sourceHash)throw new Error('Strip inputs changed: sourceHash does not match loaded package');
  if(context.mode==='compare'&&request.referenceId!==undefined)throw new Error('strip.referenceId: compare uses its fixed reference');
  const groups=request.intervals.map(interval=>{
    if(context.mode==='single'?interval.basis!=='single':interval.basis==='single')throw new Error('strip.basis: does not match review mode');
    const report=context.reports[interval.basis],clock=report?.clock;
    if(report?.animation&&report.animation!==request.animation)throw new Error('strip.animation: differs from selected report animation');
    const times=clock?.kind==='samples'&&clock.frameTimes.length?clock.frameTimes:null;
    if(times&&report?.animation!==request.animation)throw new Error('strip.animation: explicit report animation required to bind frameTimes');
    if(!times&&request.format==='png')throw new Error(stripNoClock);
    if(times&&interval.frameEnd>=times.length)throw new Error(`strip.frameEnd: ${interval.frameEnd} beyond report last frame ${times.length-1}`);
    return {...interval,feedbackId:interval.feedbackId??null,samples:Array.from({length:interval.frameEnd-interval.frameStart+1},(_,i)=>({requestedFrame:interval.frameStart+i,time:times?.[interval.frameStart+i]??null}))};
  });
  const rows:StripRow[]=[{id:'reference',label:'Reference'},...context.binding.packages.map(p=>({id:p.id,label:p.label}))];
  const layout={cellWidth:220,cellHeight:260,labelHeight:32,rowLabelWidth:120,groupGap:24,footerHeight:180+context.binding.packages.length*320};
  const width=layout.rowLabelWidth+Math.max(...groups.map(g=>g.samples.length))*layout.cellWidth;
  const height=groups.length*(layout.labelHeight*2+rows.length*layout.cellHeight+layout.groupGap)+layout.footerHeight;
  if(width>16384||height>16384||width*height>64000000)throw new Error('strip.layout: export exceeds 64 megapixels or 16384 pixels; split the selection');
  return {schema:'rig-review-strip/1',mode:context.mode,animation:request.animation,basis:groups[0]!.basis,rows,groups,binding:structuredClone(context.binding),layout};
}
