import type {TurnDial} from './turn-pad.ts';
import { lastFrame, timeAtFrame, type FrameClock } from './frame-clock.ts';

/** Null names mean unavailable metadata; an empty list means known empty. */
export interface FeedbackCatalog {
  rig:string;bones:string[]|null;slots:string[]|null;
  animations:{name:string;duration:number}[]|null;
  clock:FrameClock|null;clockAnimation:string|null;
  turnDials?:TurnDial[];
}
export type FeedbackTargetKind='bone'|'slot'|'rig';
export interface FeedbackSelection {frameStart:number;frameEnd:number;target:{kind:FeedbackTargetKind;name:string};animation:string|null}
export function feedbackTargetNames(catalog:FeedbackCatalog,kind:FeedbackTargetKind):string[]|null {
  return kind==='rig'?[catalog.rig]:kind==='bone'?catalog.bones:catalog.slots;
}
/** Clip end restricts declared samples; it never creates a rate or a frame. */
export function feedbackLastFrame(catalog:FeedbackCatalog,animation:string|null):number|null {
  const last=lastFrame(catalog.clock);if(last===null)return null;
  if(catalog.animations===null)return catalog.clockAnimation===null||animation===null||animation===catalog.clockAnimation?last:null;
  if(!animation||catalog.clockAnimation!==animation)return null;
  const clip=catalog.animations.find(value=>value.name===animation);if(!clip)return null;
  let low=0,high=last;
  while(low<=high){const middle=low+Math.floor((high-low)/2),time=timeAtFrame(catalog.clock,middle);if(time!==null&&time<=clip.duration)low=middle+1;else high=middle-1;}
  // -1 is a known empty clip/sample intersection, not an unknown clock.
  return high;
}
export function validateFeedbackSelection(catalog:FeedbackCatalog,value:FeedbackSelection):void {
  if(!value.target||!['bone','slot','rig'].includes(value.target.kind))throw new Error('feedback.target.kind: expected bone | slot | rig');
  if(typeof value.target.name!=='string'||!value.target.name.trim())throw new Error('feedback.target.name: expected nonempty model or package name');
  if(value.animation!==null&&typeof value.animation!=='string')throw new Error('feedback.context.animation: expected animation name or null');
  if(!Number.isSafeInteger(value.frameStart)||!Number.isSafeInteger(value.frameEnd)||value.frameStart<0||value.frameEnd<value.frameStart)throw new Error('feedback frames: expected inclusive integer 0 <= frameStart <= frameEnd');
  const names=feedbackTargetNames(catalog,value.target.kind);
  if(names===null)throw new Error(`feedback.target.name: ${value.target.kind} validation unavailable without model ${value.target.kind} names`);
  if(!names.includes(value.target.name))throw new Error(`feedback.target.name: ${value.target.kind} ${JSON.stringify(value.target.name)} not in ${value.target.kind==='rig'?'package':'model'}`);
  if(value.animation!==null&&catalog.animations!==null&&!catalog.animations.some(clip=>clip.name===value.animation))throw new Error(`feedback.context.animation: ${JSON.stringify(value.animation)} not in model`);
  if(catalog.animations===null&&lastFrame(catalog.clock)!==null&&catalog.clockAnimation!==null&&value.animation!==null&&value.animation!==catalog.clockAnimation)throw new Error('feedback.context.animation: does not match source report frame clock');
  if(catalog.animations!==null&&lastFrame(catalog.clock)!==null&&catalog.clockAnimation!==null&&value.animation===null)throw new Error('feedback.context.animation: required to bind declared report frame clock');
  const last=feedbackLastFrame(catalog,value.animation);
  if(last!==null&&value.frameEnd>last)throw new Error(`feedback.frameEnd: ${value.frameEnd} beyond clip last frame ${last}`);
}
/** Target/animation validation for a seconds-only comment; no fabricated frame is passed to the integer validator. */
export function validateTimedFeedbackSelection(catalog:FeedbackCatalog,value:{target:FeedbackSelection['target'];animation:string|null;time:number}):void {
 if(!value.target||!['bone','slot','rig'].includes(value.target.kind))throw new Error('feedback.target.kind: expected bone | slot | rig');
 const names=feedbackTargetNames(catalog,value.target.kind);if(names===null)throw new Error(`feedback.target.name: ${value.target.kind} validation unavailable without model names`);
 if(!names.includes(value.target.name))throw new Error('feedback.target.name: not in inspected model/package');
 if(value.animation!==null&&typeof value.animation!=='string')throw new Error('feedback.context.animation: expected animation name or null');
 const clip=catalog.animations?.find(c=>c.name===value.animation);if(value.animation!==null&&catalog.animations!==null&&!clip)throw new Error('feedback.context.animation: not in model');
 if(!Number.isFinite(value.time)||value.time<0||value.time>Number.MAX_SAFE_INTEGER||clip&&value.time>clip.duration)throw new Error('COMMENT_TIME_ONLY_INVALID: seconds outside inspected animation');
}
