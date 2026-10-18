import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { validateFeedbackSelection } from './feedback-validation.ts';
import { choice, object, string, type Json, type ReviewPackage, type ReviewedSource } from './manifest.ts';
export interface Feedback {id:string;frameStart:number;frameEnd:number;target:{kind:'bone'|'slot'|'rig';name:string};category:'defect'|'quality';summary:string;context?:Json}
export function parseFeedback(item:unknown,strict=true):Feedback {
  const f=object(item,'feedback');const target=object(f.target,'feedback.target');
  // Older releases admitted integer values beyond the safe range. Retain those
  // as readable evidence; strict saves and validatePackageFeedback refuse them.
  const integer=strict?Number.isSafeInteger:Number.isInteger;
  if(!integer(f.frameStart)||!integer(f.frameEnd)||(f.frameStart as number)<0||(f.frameEnd as number)<(f.frameStart as number))throw new Error('feedback frames: expected inclusive integer 0 <= frameStart <= frameEnd');
  const summary=string(f.summary,'feedback.summary');if(summary.length>1000||/[\r\n]/.test(summary))throw new Error('feedback.summary: expected one line <= 1000 characters');
  return {id:string(f.id,'feedback.id'),frameStart:f.frameStart as number,frameEnd:f.frameEnd as number,target:{kind:choice(target.kind,['bone','slot','rig'] as const,'feedback.target.kind'),name:string(target.name,'feedback.target.name')},category:choice(f.category,['defect','quality'] as const,'feedback.category'),summary,...(f.context===undefined?{}:{context:f.context as Json})};
}
export interface FeedbackWarning {id:string;error:string}

/** Derive the annotated interval, retaining inspection context as separate data. */
export function validatePackageFeedback(feedback:Feedback,p:ReviewPackage,animation?:string):Feedback {
  const context=feedback.context===undefined?{}:object(feedback.context,'feedback.context');
  const interval={frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,inclusive:true};
  if(context.interval!==undefined&&!isDeepStrictEqual(context.interval,interval))throw new Error('feedback.context.interval: must match chosen inclusive frameStart/frameEnd');
  if(context.animation!==undefined&&context.animation!==null&&typeof context.animation!=='string')throw new Error('feedback.context.animation: expected animation name or null');
  if(animation!==undefined&&context.animation!==undefined&&context.animation!==null&&context.animation!==animation)throw new Error('feedback.context.animation: does not match selected comparison animation');
  const selected=animation??(typeof context.animation==='string'?context.animation:null);
  validateFeedbackSelection(p.feedbackCatalog,{frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,target:feedback.target,animation:selected});
  return {...feedback,context:{...context,...(animation===undefined?{}:{animation}),interval} as Json};
}
export function readPackageFeedback(feedback:Feedback,p:ReviewPackage,animation?:string):{feedback:Feedback;warning?:FeedbackWarning} {
  try{return {feedback:validatePackageFeedback(feedback,p,animation)};}catch(e){
    // Old submitted evidence remains readable. Only add a missing derived
    // interval; contradictory supplied evidence is preserved with its warning.
    const context=feedback.context;const normalized=context===undefined?{interval:{frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,inclusive:true}}:context&&typeof context==='object'&&!Array.isArray(context)&&!('interval' in context)?{...context,interval:{frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,inclusive:true}}:context;
    return {feedback:{...feedback,...(normalized===undefined?{}:{context:normalized})},warning:{id:feedback.id,error:e instanceof Error?e.message:String(e)}};
  }
}
export interface ReviewSession { schema:'rig-review-session/1'; id:string; revision:string; sourceHash:string; reviewedSource:ReviewedSource; status:'pending'|'approved'|'changes-requested'; checkpoints:Record<string,{outcome:'pending'|'pass'|'fail';note:string}>; feedback:Feedback[]; feedbackWarnings:FeedbackWarning[]; updatedAt:string|null }
export function freshSession(p:ReviewPackage):ReviewSession { return {schema:'rig-review-session/1',id:p.manifest.id,revision:p.manifest.revision,sourceHash:p.sourceHash,reviewedSource:p.reviewedSource,status:'pending',checkpoints:{},feedback:[],feedbackWarnings:[],updatedAt:null}; }
export function parseSession(input:unknown,p:ReviewPackage,strict=true):ReviewSession {
  const v=object(input,'session'); const fresh=freshSession(p);
  for(const k of ['schema','id','revision','sourceHash'] as const) if(v[k]!==fresh[k]) throw new Error(`session.${k}: does not match loaded package`);
  if(!isDeepStrictEqual(v.reviewedSource,p.reviewedSource))throw new Error('session.reviewedSource: does not match exact rig/motion hashes and tool versions of loaded package');
  const status=choice(v.status,['pending','approved','changes-requested'],'session.status');
  const entries=object(v.checkpoints,'session.checkpoints'); const checkpoints:ReviewSession['checkpoints']={};
  for(const [key,value] of Object.entries(entries)) { if(!p.manifest.checkpoints.some(c=>c.id===key)) throw new Error(`session.checkpoints: unknown checkpoint ${key}`);const c=object(value,'checkpoint');if(typeof c.note!=='string'||c.note.length>10000)throw new Error('checkpoint.note: expected string <= 10000 characters');checkpoints[key]={outcome:choice(c.outcome,['pending','pass','fail'],'checkpoint.outcome'),note:c.note}; }
  if(v.corrections!==undefined)throw new Error('session.corrections: authoring proposals are not accepted; use read-only structured feedback');
  if(!Array.isArray(v.feedback)||v.feedback.length>1000)throw new Error('session.feedback: expected array <= 1000');
  const feedbackWarnings:FeedbackWarning[]=[];const feedback:Feedback[]=v.feedback.map((item:unknown)=>{const parsed=parseFeedback(item,strict);if(strict)return validatePackageFeedback(parsed,p);const read=readPackageFeedback(parsed,p);if(read.warning)feedbackWarnings.push(read.warning);return read.feedback;});
  if(new Set(feedback.map(f=>f.id)).size!==feedback.length)throw new Error('session.feedback: duplicate ids');
  return {...fresh,status,checkpoints,feedback,feedbackWarnings,updatedAt:new Date().toISOString()};
}
export function sessionFile(p:ReviewPackage,stateDir=join(homedir(),'.local','state','rig-c-review')):string { const key=createHash('sha256').update(JSON.stringify([p.manifest.id,p.manifest.revision,p.sourceHash,p.reviewedSource])).digest('hex'); return join(stateDir,key+'.json'); }
export async function readSession(p:ReviewPackage,stateDir?:string):Promise<ReviewSession> {try {const v=JSON.parse(await readFile(sessionFile(p,stateDir),'utf8'));const parsed=parseSession(v,p,false);return {...parsed,updatedAt:v.updatedAt};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return freshSession(p);throw e;} }
export async function saveSession(p:ReviewPackage,input:unknown,stateDir?:string):Promise<ReviewSession> {const value=parseSession(input,p);const file=sessionFile(p,stateDir);await mkdir(join(file,'..'),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file);return value;}
