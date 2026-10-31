import {clockForAnimation,frameAtTime} from './frame-clock.ts';
import {parseBookmark} from '../web/inspection-persistence.ts';
import {parseStageComment,projectMark,hasStageComment,isTimeOnlyFeedback,requireFeedbackFrames} from './stage-comment.ts';
import {validateCommentCrop,saveCommentCrops,assertSubmittedComments} from './comment-crops.ts';
import {TurnState,type TurnDial} from './turn-pad.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import {referenceBinding,type ReferenceBinding} from './reference.ts';
import { validateFeedbackSelection,validateTimedFeedbackSelection } from './feedback-validation.ts';
import { parseEnvironmentContext } from './environment.ts';
import { appliedCheckRefusal, parseAppliedContext } from './applied-context.ts';
import { parseReadingsContext } from './readings.ts';
import { parseRequirementsContext } from './requirements.ts';
import { parseScheduleContext } from './environment-schedule.ts';
import { choice, object, string, type Json, type ReviewPackage, type ReviewedSource } from './manifest.ts';
export interface Feedback {id:string;frameStart:number|null;frameEnd:number|null;target:{kind:'bone'|'slot'|'rig';name:string};category:'defect'|'quality';summary:string;context?:Json}
export function parseFeedback(item:unknown,strict=true):Feedback {
  const f=object(item,'feedback');const target=object(f.target,'feedback.target');
  if(hasStageComment((f.context as any)?.comment))parseStageComment((f.context as any).comment);
  // Older releases admitted integer values beyond the safe range. Retain those
  // as readable evidence; strict saves and validatePackageFeedback refuse them.
  const integer=strict?Number.isSafeInteger:Number.isInteger;
  if(f.frameStart===null||f.frameEnd===null){if(!isTimeOnlyFeedback(f))throw new Error('COMMENT_TIME_ONLY_INVALID: null frames require a validated time-only single comment and null interval');}
  else if(!integer(f.frameStart)||!integer(f.frameEnd)||(f.frameStart as number)<0||(f.frameEnd as number)<(f.frameStart as number))throw new Error('feedback frames: expected inclusive integer 0 <= frameStart <= frameEnd');
  const summary=string(f.summary,'feedback.summary');if(summary.length>1000||/[\r\n]/.test(summary))throw new Error('feedback.summary: expected one line <= 1000 characters');
  return {id:string(f.id,'feedback.id'),frameStart:f.frameStart as number|null,frameEnd:f.frameEnd as number|null,target:{kind:choice(target.kind,['bone','slot','rig'] as const,'feedback.target.kind'),name:string(target.name,'feedback.target.name')},category:choice(f.category,['defect','quality'] as const,'feedback.category'),summary,...(f.context===undefined?{}:{context:f.context as Json})};
}
export interface FeedbackWarning {id:string;error:string}

/** Derive the annotated interval, retaining inspection context as separate data. */
export function validatePackageFeedback(feedback:Feedback,p:ReviewPackage,animation?:string,turnDials:readonly TurnDial[]=p.feedbackCatalog.turnDials??[]):Feedback {
  const context=feedback.context===undefined?{}:object(feedback.context,'feedback.context');
  const comment=hasStageComment(context.comment)?parseStageComment(context.comment):null,timed=comment?.frame===null;
  if(timed&&(!isTimeOnlyFeedback(feedback)||animation!==undefined))throw new Error('COMMENT_TIME_ONLY_INVALID: seconds-only single comment requires null frame and interval');
  const interval=timed?null:{frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,inclusive:true};
  if(context.interval!==undefined&&!isDeepStrictEqual(context.interval,interval))throw new Error('feedback.context.interval: must match chosen inclusive frameStart/frameEnd');
  if(context.animation!==undefined&&context.animation!==null&&typeof context.animation!=='string')throw new Error('feedback.context.animation: expected animation name or null');
  if(animation!==undefined&&context.animation!==undefined&&context.animation!==null&&context.animation!==animation)throw new Error('feedback.context.animation: does not match selected comparison animation');
  // Older records without an environment stay valid; a present one must have the recorded shape.
  if(context.environment!==undefined)parseEnvironmentContext(context.environment);
  // Likewise the applied state (#99 regions, #102 patch): absent or null stays valid; a present record has its exact shape.
  if(context.applied!==undefined){parseAppliedContext(context.applied);const unchecked=appliedCheckRefusal(context.applied);if(unchecked)throw new Error(unchecked);}
  // The readings chosen (#108): absent or null stays valid; a present record names its pairs and the builds they ran on.
  if(context.readings!==undefined)parseReadingsContext(context.readings);
  // The declared requirements (#113): absent or null stays valid; a present record carries the file's text and its sha256, recomputed here.
  if(context.requirements!==undefined)parseRequirementsContext(context.requirements,text=>createHash('sha256').update(text).digest('hex'));
  // The exported environment schedule (#112): absent or null stays valid; a present record carries its bytes and their sha256, recomputed here.
  if(context.environmentSchedule!==undefined)parseScheduleContext(context.environmentSchedule,text=>createHash('sha256').update(text).digest('hex'));
  if(context.turn!==undefined){if(!turnDials.length)throw new Error('TURN_UNAVAILABLE: this inspected model has no supported turn dials');new TurnState(turnDials).validate(context.turn);}
  if(hasStageComment(context.comment)){
    const c=parseStageComment(context.comment);validateCommentCrop(c);const bookmark=parseBookmark(c.bookmark);
    if(!isDeepStrictEqual(bookmark.view.cameras[c.viewport],c.camera))throw new Error('COMMENT_CONTEXT_MISMATCH: saved pane camera');
    if(bookmark.time!==c.time||bookmark.animation!==c.animation||!isDeepStrictEqual(bookmark.selection.turn??null,context.turn??null))throw new Error('COMMENT_CONTEXT_MISMATCH: bookmark pose');
    if(animation===undefined){parseBookmark(c.bookmark,{mode:'single',sourceHash:p.sourceHash,rigs:[p.reviewedSource.rig?.sha256??null]});if(c.viewport!=='rig'&&c.viewport!=='reference')throw new Error('COMMENT_CONTEXT_MISMATCH: single viewport');
      if(c.viewport==='reference'){
        const declared=p.manifest.references.find(r=>r.id===c.referenceId),explicit=referenceBinding(p)?.reference;
        const expectedHash=explicit?.id===c.referenceId?explicit.sha256:c.referenceId?p.referenceHashes?.[c.referenceId]:undefined;
        if(!declared||!expectedHash||c.referenceHash!==expectedHash||bookmark.selection.reference!==c.referenceId)throw new Error('COMMENT_REFERENCE_MISMATCH: selected reference ID/hash must match the source and bookmark');
        const clock=clockForAnimation(p.feedbackCatalog.clock,p.feedbackCatalog.clockAnimation??undefined,c.animation??'',!!p.reviewedSource.rig);
        if(c.frame&&(c.frame.basis!=='producer'||frameAtTime(clock,c.time)!==c.frame.index))throw new Error('COMMENT_FRAME_UNAVAILABLE: producer frame differs from the inspected reference time');
      }else if(c.referenceId!==null||c.referenceHash!==null)throw new Error('COMMENT_REFERENCE_MISMATCH: single rig marks have no reference viewport binding');
}
    if(c.sourceHash!==p.sourceHash||c.modelHash!==(c.viewport==='reference'?null:p.reviewedSource.rig?.sha256??null))throw new Error('COMMENT_SOURCE_CHANGED: comment differs from inspected source');
    if(c.animation!==(animation??context.animation??null)||c.time!==context.time||(c.frame?.index??null)!==feedback.frameStart||feedback.frameStart!==feedback.frameEnd)throw new Error('COMMENT_CONTEXT_MISMATCH: frame, time or animation differs');
    if(timed){const clock=clockForAnimation(p.feedbackCatalog.clock,p.feedbackCatalog.clockAnimation??undefined,c.animation??'',!!p.reviewedSource.rig);if(frameAtTime(clock,c.time)!==null)throw new Error('COMMENT_TIME_ONLY_INVALID: explicit producer frame exists at this time');}
    const a=projectMark(c.world,c.camera),b=projectMark({x:c.world.x+c.world.width,y:c.world.y+c.world.height},c.camera);
    if(Math.abs(Math.min(a.x,b.x)-c.screen.x)>1e-5||Math.abs(Math.min(a.y,b.y)-c.screen.y)>1e-5||Math.abs(Math.abs(a.x-b.x)-c.screen.width)>1e-5||Math.abs(Math.abs(a.y-b.y)-c.screen.height)>1e-5)throw new Error('COMMENT_CONTEXT_MISMATCH: screen/world region projection');
    if(c.camera.space!==(c.viewport==='reference'?'image':'world'))throw new Error('COMMENT_CONTEXT_MISMATCH: camera space');
    if(c.slots.some(s=>!p.feedbackCatalog.slots?.includes(s.slot))||c.viewport==='reference'&&c.slots.length)throw new Error('COMMENT_SLOT_UNKNOWN: drawn slot not in this model');
    const expected=c.slots[0]?{kind:'slot',name:c.slots[0].slot}:{kind:'rig',name:p.feedbackCatalog.rig};
    if(!isDeepStrictEqual(feedback.target,expected))throw new Error('COMMENT_TARGET_MISMATCH: use topmost drawn slot or rig');
  }
  const selected=animation??(typeof context.animation==='string'?context.animation:null);
  if(timed)validateTimedFeedbackSelection(p.feedbackCatalog,{target:feedback.target,animation:selected,time:comment!.time});
  else validateFeedbackSelection((context.comment as any)?.frame?.basis==='reference'?{...p.feedbackCatalog,clock:null,clockAnimation:null}:p.feedbackCatalog,{...requireFeedbackFrames(feedback),target:feedback.target,animation:selected});
  return {...feedback,context:{...context,...(animation===undefined?{}:{animation}),interval} as Json};
}
export function readPackageFeedback(feedback:Feedback,p:ReviewPackage,animation?:string,turnDials?:readonly TurnDial[]):{feedback:Feedback;warning?:FeedbackWarning} {
  try{return {feedback:validatePackageFeedback(feedback,p,animation,turnDials)};}catch(e){
    // Old submitted evidence remains readable. Only add a missing derived
    // interval; contradictory supplied evidence is preserved with its warning.
    const context=feedback.context;const normalized=context===undefined?{interval:{frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,inclusive:true}}:context&&typeof context==='object'&&!Array.isArray(context)&&!('interval' in context)?{...context,interval:{frameStart:feedback.frameStart,frameEnd:feedback.frameEnd,inclusive:true}}:context;
    return {feedback:{...feedback,...(normalized===undefined?{}:{context:normalized})},warning:{id:feedback.id,error:e instanceof Error?e.message:String(e)}};
  }
}
export interface ReviewSession { schema:'rig-review-session/1'; id:string; revision:string; sourceHash:string; reviewedSource:ReviewedSource; referenceBinding?:ReferenceBinding; status:'pending'|'approved'|'changes-requested'; checkpoints:Record<string,{outcome:'pending'|'pass'|'fail';note:string}>; feedback:Feedback[]; feedbackWarnings:FeedbackWarning[]; updatedAt:string|null }
export function freshSession(p:ReviewPackage):ReviewSession { return {schema:'rig-review-session/1',id:p.manifest.id,revision:p.manifest.revision,sourceHash:p.sourceHash,reviewedSource:p.reviewedSource,...(referenceBinding(p)?{referenceBinding:referenceBinding(p)}:{}),status:'pending',checkpoints:{},feedback:[],feedbackWarnings:[],updatedAt:null}; }
export function parseSession(input:unknown,p:ReviewPackage,strict=true):ReviewSession {
  const v=object(input,'session'); const fresh=freshSession(p);
  for(const k of ['schema','id','revision','sourceHash'] as const) if(v[k]!==fresh[k]) throw new Error(`session.${k}: does not match loaded package`);
  if(!isDeepStrictEqual(v.reviewedSource,p.reviewedSource))throw new Error('session.reviewedSource: does not match exact rig/motion hashes and tool versions of loaded package');
  if(!isDeepStrictEqual(v.referenceBinding,fresh.referenceBinding))throw new Error('session.referenceBinding: does not match selected reference and package hash');
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
export async function saveSession(p:ReviewPackage,input:unknown,stateDir?:string):Promise<ReviewSession> {const value=parseSession(input,p);assertSubmittedComments((await readSession(p,stateDir)).feedback,value.feedback);await saveCommentCrops(value.feedback,stateDir);const file=sessionFile(p,stateDir);await mkdir(join(file,'..'),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file);return value;}
