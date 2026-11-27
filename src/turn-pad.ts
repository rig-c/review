/** Inspection dials, not keys. Read the compiled slider's mapping; never invent a degree range. */
import {normalizedDial,type BoneAdjust,type TurnAxis,type TurnDial} from '@rig-c/play';
export {discoverTurnDials,normalizedDial,type TurnAxis,type TurnDial} from '@rig-c/play';
export interface TurnSnapshot {schema:'rig-review-turn/1';values:Partial<Record<TurnAxis,number>>;held:boolean;smoothing:number}
const object=(v:unknown):Record<string,any>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v))||0;
export function sharedTurnDials(a:readonly TurnDial[],b:readonly TurnDial[]):TurnDial[]{
 return a.flatMap(d=>{const other=b.find(e=>e.axis===d.axis);if(!other)return [];const min=Math.max(d.min,other.min),max=Math.min(d.max,other.max);return min<max?[{...d,min,max}]:[];});
}
export function pointerPosition(x:number,y:number,rect:{left:number;top:number;width:number;height:number}):[number,number]{
 return rect.width>0&&rect.height>0?[clamp((x-rect.left)/rect.width*2-1,-1,1),clamp(1-(y-rect.top)/rect.height*2,-1,1)]:[0,0];
}
/** Display precision for `<output>` readouts: 2 decimals for spans >= 1, scaled up (at most 6) for sub-unit ranges. */
export function turnDialPrecision(range:{min:number;max:number},precision?:number):number {
 if(precision!==undefined){if(!Number.isInteger(precision)||precision<0||precision>6)throw new Error('TURN_PRECISION_INVALID');return precision;}
 const span=Math.abs(range.max-range.min);
 return span>0&&span<1?Math.min(6,Math.max(2,Math.ceil(-Math.log10(span))+2)):2;
}
/** Rounded display text for `<output>`; the number input and `dataset.value` keep the exact value. */
export function formatTurnValue(value:number,range:{min:number;max:number},precision=turnDialPrecision(range)):string {
 const p=turnDialPrecision(range,precision);
 return String(Number(value.toFixed(p))||0);
}
/** Widest character count (`ch`) reachable in `[range.min, range.max]` at `precision`, including minus sign and decimal point. */
export function turnDialWidthCh(range:{min:number;max:number},precision=turnDialPrecision(range)):number {
 if(!finite(range.min)||!finite(range.max)||range.min>=range.max)throw new Error('TURN_RANGE_INVALID');
 const p=turnDialPrecision(range,precision);
 return Math.max(range.min.toFixed(p).length,range.max.toFixed(p).length);
}
/** Exact critically damped solution from https://rig-c.org/demos/head-turn/bundle/app.js (HEAD_SPRING_OMEGA0=20). */
export function springStep(s:{x:number;v:number},target:number,dt:number,omega=20):void {
 if(!(dt>0)||!finite(dt))return;const e=s.x-target,tau=omega*dt,exp=Math.exp(-tau),x=target+(e*(1+tau)+s.v*dt)*exp,v=(s.v*(1-tau)-omega*omega*dt*e)*exp;
 s.x=Math.abs(x-target)<1e-12&&Math.abs(v)<1e-9?target:x;s.v=s.x===target?0:v;
}
export function parseTurnSnapshot(value:unknown):TurnSnapshot {
 const o=object(value);if(!o||o.schema!=='rig-review-turn/1'||Object.keys(o).some(k=>!['schema','values','held','smoothing'].includes(k))||typeof o.held!=='boolean'||!finite(o.smoothing)||o.smoothing<0||o.smoothing>100)throw new Error('TURN_STATE_INVALID');
 const values=object(o.values);if(!values||Object.keys(values).some(k=>!['yaw','pitch','body'].includes(k)||!finite(values[k])))throw new Error('TURN_VALUES_INVALID');
 return {schema:o.schema,values:{...values},held:o.held,smoothing:o.smoothing};
}
const normalizedValue=(value:number,d:TurnDial)=>value<0?d.min<0?-value/d.min:0:d.max>0?value/d.max:0;
export class TurnState {
 values:Partial<Record<TurnAxis,number>>={};held=false;smoothing=20;
 readonly targets:Partial<Record<TurnAxis,number>>={};private springs=new Map<TurnAxis,{x:number;v:number}>();
 private active=false;
 private releaseSpring:{x:number;v:number}|null=null;
 private lastSteered:Partial<Record<TurnAxis,number>>|null=null;
 get engaged():boolean {return this.active;}
 get releasing():boolean {return this.releaseSpring!==null;}
 constructor(readonly dials:readonly TurnDial[]){for(const d of dials){this.values[d.axis]=0;this.targets[d.axis]=0;this.springs.set(d.axis,{x:0,v:0});}}
 pointer(x:number,y:number):boolean {
  if(this.held)return false;
  const entered=!this.active;
  this.active=true;
  this.releaseSpring=null;
  this.lastSteered=null;
  for(const d of this.dials)this.targets[d.axis]=normalizedDial(d.axis==='pitch'?y:x,d);
  return entered;
 }
 leave():boolean {
  if(!this.active||this.held)return false;
  this.lastSteered={...this.values};
  if(!this.smoothing){this.clearPose();return true;}
  this.active=false;
  this.releaseSpring={x:1,v:0};
  for(const d of this.dials)this.targets[d.axis]=0;
  return true;
 }
 clear():void {
  this.lastSteered=null;
  this.clearPose();
 }
 private clearPose():void {
  this.held=false;
  this.active=false;
  this.releaseSpring=null;
  for(const d of this.dials){
   this.values[d.axis]=0;
   this.targets[d.axis]=0;
   Object.assign(this.springs.get(d.axis)!,{x:0,v:0});
  }
 }
 step(dt:number):boolean {
  if(this.releaseSpring){
   const before=this.releaseSpring.x;
   springStep(this.releaseSpring,0,dt,this.smoothing);
   const weight=this.releaseSpring.x;
   if(!this.smoothing||weight<1e-6){this.clearPose();return true;}
   if(weight===before)return false;
   for(const d of this.dials){
    this.values[d.axis]!*=weight/before;
    Object.assign(this.springs.get(d.axis)!,{x:normalizedValue(this.values[d.axis]!,d),v:0});
   }
   return true;
  }
  let changed=false;
  if(!this.active||this.held)return false;
  for(const d of this.dials){
   const s=this.springs.get(d.axis)!,target=this.targets[d.axis]!;
   if(this.smoothing===0){s.x=normalizedValue(target,d);s.v=0;}
   else springStep(s,normalizedValue(target,d),dt,this.smoothing);
   const next=this.smoothing===0?target:normalizedDial(s.x,d);
   changed||=next!==this.values[d.axis];
   this.values[d.axis]=next;
  }
  return changed;
 }
 hold(value:boolean):void {
  // Reaching the Hold button takes the pointer outside the viewport.
  if(value&&this.lastSteered)Object.assign(this.values,this.lastSteered);
  this.lastSteered=null;
  this.active=true;
  this.releaseSpring=null;
  this.held=value;
  for(const d of this.dials){
   const x=this.values[d.axis]!;
   this.targets[d.axis]=x;
   Object.assign(this.springs.get(d.axis)!,{x:normalizedValue(x,d),v:0});
  }
 }
 exact(axis:TurnAxis,value:number):void {const d=this.dials.find(d=>d.axis===axis);if(!d||!finite(value)||value<d.min||value>d.max)throw new Error('TURN_VALUE_OUT_OF_RANGE');this.lastSteered=null;this.hold(true);this.values[axis]=value;this.targets[axis]=value;Object.assign(this.springs.get(axis)!,{x:normalizedValue(value,d),v:0});}
 reset():void {this.hold(true);for(const d of this.dials)this.exact(d.axis,0);}
 snapshot():TurnSnapshot{return {schema:'rig-review-turn/1',values:{...this.values},held:this.held,smoothing:this.smoothing};}
 validate(value:unknown):TurnSnapshot {const v=parseTurnSnapshot(value);if(Object.keys(v.values).length!==this.dials.length||this.dials.some(d=>!finite(v.values[d.axis])||v.values[d.axis]!<d.min||v.values[d.axis]!>d.max))throw new Error('TURN_STATE_MODEL_MISMATCH');return v;}
 restore(value:unknown):void {const v=this.validate(value);for(const d of this.dials)this.exact(d.axis,v.values[d.axis]!);this.smoothing=v.smoothing;this.hold(v.held);}
 adjust(dials:readonly TurnDial[]=this.dials):BoneAdjust {
  return bones=>{
   if(!this.active&&!this.releaseSpring)return;
   for(const d of dials){
    const value=this.values[d.axis];
    if(value===undefined)continue;
    const bone=bones.bone(d.bone);
    // Read each pose's current clip value, including independent clips in Compare.
    bone[d.channel]=this.releaseSpring?value+bone[d.channel]*(1-this.releaseSpring.x):value;
   }
  };
 }
}
