/** Inspection dials, not keys. Read the compiled slider's mapping; never invent a degree range. */
import type {BoneAdjust,BoneLocals} from '@rig-c/play';
export type TurnAxis='yaw'|'pitch'|'body';
export interface TurnDial {axis:TurnAxis;bone:string;slider:string;channel:keyof BoneLocals;min:number;max:number;provenance?:string}
export interface TurnSnapshot {schema:'rig-review-turn/1';values:Partial<Record<TurnAxis,number>>;held:boolean;smoothing:number}
const object=(v:unknown):Record<string,any>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v))||0;
const channels:Record<string,keyof BoneLocals>={rotate:'rotation',x:'x',y:'y',scaleX:'scaleX',scaleY:'scaleY',shearY:'shearY'};
/** `body_turn` is the producer's compiled body slider animation, including a custom turn.body.slider bone.
 * This is compiled metadata only; no producer config or opaque Play document is read. */
export function discoverTurnDials(model:unknown,durations?:readonly {name:string;duration:number}[]):TurnDial[] {
 const m=object(model);if(!m||!Array.isArray(m.bones)||!Array.isArray(m.constraints))return [];
 const names=new Set(m.bones.map((b:any)=>b.name)),animations=durations??m.animations??[];
 const result:TurnDial[]=[];
 for(const axis of ['yaw','pitch','body'] as const){
  const canonical=axis==='body'?'body_yaw_dial':axis+'_dial';
  const candidates=m.constraints.filter((c:any)=>c&&c.kind==='slider'&&typeof c.name==='string'&&names.has(c.bone)&&(c.bone===canonical||axis==='body'&&c.animation==='body_turn'));
  if(candidates.length!==1)continue;
  const c=candidates[0],duration=animations.find((a:any)=>a.name===c.animation)?.duration,from=c.from??0,to=c.to??0,scale=c.scale??1,channel=channels[c.property??'rotate'];
  if(!c.local||c.loop||!channel||![duration,from,to,scale].every(finite)||duration<=0||scale===0)continue;
  // Same inverse slider mapping as the official head-turn demo; max is not a clamp in the runtime.
  const a=from-to/scale,b=from+(duration-to)/scale;
  if(!finite(a)||!finite(b)||a===b||Math.min(a,b)>0||Math.max(a,b)<0)continue;
  if(result.some(d=>d.bone===c.bone&&d.channel===channel))continue;
  result.push({axis,bone:c.bone,slider:c.name,channel,min:Math.min(a,b),max:Math.max(a,b),provenance:`model slider ${c.name} → bone ${c.bone}, ${c.property??'rotate'}, animation ${c.animation}${c.bone!==canonical?' (compiled body_turn binding)':''}`});
 }return result;
}
export function sharedTurnDials(a:readonly TurnDial[],b:readonly TurnDial[]):TurnDial[]{
 return a.flatMap(d=>{const other=b.find(e=>e.axis===d.axis);if(!other)return [];const min=Math.max(d.min,other.min),max=Math.min(d.max,other.max);return min<max?[{...d,min,max}]:[];});
}
export function pointerPosition(x:number,y:number,rect:{left:number;top:number;width:number;height:number}):[number,number]{
 return rect.width>0&&rect.height>0?[clamp((x-rect.left)/rect.width*2-1,-1,1),clamp(1-(y-rect.top)/rect.height*2,-1,1)]:[0,0];
}
export function normalizedDial(n:number,range:{min:number;max:number}):number {const v=clamp(n,-1,1),zero=clamp(0,range.min,range.max);return clamp(zero+Math.abs(v)*((v<0?range.min:range.max)-zero),range.min,range.max);}
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
 constructor(readonly dials:readonly TurnDial[]){for(const d of dials){this.values[d.axis]=0;this.targets[d.axis]=0;this.springs.set(d.axis,{x:0,v:0});}}
 pointer(x:number,y:number):void {if(this.held)return;for(const d of this.dials)this.targets[d.axis]=normalizedDial(d.axis==='pitch'?y:x,d);}
 step(dt:number):boolean {let changed=false;if(this.held)return false;for(const d of this.dials){const s=this.springs.get(d.axis)!,target=this.targets[d.axis]!;if(this.smoothing===0){s.x=normalizedValue(target,d);s.v=0;}else springStep(s,normalizedValue(target,d),dt,this.smoothing);const next=this.smoothing===0?target:normalizedDial(s.x,d);changed||=next!==this.values[d.axis];this.values[d.axis]=next;}return changed;}
 hold(value:boolean):void {this.held=value;for(const d of this.dials){const x=this.values[d.axis]!;this.targets[d.axis]=x;Object.assign(this.springs.get(d.axis)!,{x:normalizedValue(x,d),v:0});}}
 exact(axis:TurnAxis,value:number):void {const d=this.dials.find(d=>d.axis===axis);if(!d||!finite(value)||value<d.min||value>d.max)throw new Error('TURN_VALUE_OUT_OF_RANGE');this.hold(true);this.values[axis]=value;this.targets[axis]=value;Object.assign(this.springs.get(axis)!,{x:normalizedValue(value,d),v:0});}
 reset():void {this.hold(true);for(const d of this.dials)this.exact(d.axis,0);}
 snapshot():TurnSnapshot{return {schema:'rig-review-turn/1',values:{...this.values},held:this.held,smoothing:this.smoothing};}
 validate(value:unknown):TurnSnapshot {const v=parseTurnSnapshot(value);if(Object.keys(v.values).length!==this.dials.length||this.dials.some(d=>!finite(v.values[d.axis])||v.values[d.axis]!<d.min||v.values[d.axis]!>d.max))throw new Error('TURN_STATE_MODEL_MISMATCH');return v;}
 restore(value:unknown):void {const v=this.validate(value);for(const d of this.dials)this.exact(d.axis,v.values[d.axis]!);this.smoothing=v.smoothing;this.hold(v.held);}
 adjust(dials:readonly TurnDial[]=this.dials):BoneAdjust {return bones=>{for(const d of dials){const value=this.values[d.axis];if(value!==undefined)bones.bone(d.bone)[d.channel]=value;}};}
}
