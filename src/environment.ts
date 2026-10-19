/**
 * Inspection-only environment for Animate: a pure wind model (base, breeze, gust),
 * the jolt packet, the drag-to-trail mapping and the read-only physics constraint
 * list. Nothing here writes the model or motion; the player stays the only solver.
 *
 * The wind model ports the semantics of the public parts-examples viewer's
 * `wind-controls.mjs`: the same breeze formula, gust envelope, repeat period and
 * limits. Its clock is advanced by the caller with the step the player takes, so a
 * paused player freezes the gust.
 */
import type {Json} from './manifest.ts';

export const BASE_WIND_LIMIT=100;
export const MAX_GUST_PEAK=200;
export const MIN_GUST_DURATION=0.1;
export const MAX_GUST_DURATION=20;
export const GUST_DURATION=2.4;
export const GUST_PEAK=48;
export const GUST_PERIOD=6;
export const GRAVITY_MIN=0;
export const GRAVITY_MAX=4;
export const GRAVITY_DEFAULT=1;
/** `@rig-c/play`'s start values (`environment(null)`): x right, y down. */
export const RUNTIME_START={wind:[1,0] as [number,number],gravity:[0,1] as [number,number]};

const bounded=(value:number,min:number,max:number,name:string):number=>{
 if(!Number.isFinite(value)||value<min||value>max)throw new RangeError(`${name} must be finite and within [${min}, ${max}]`);
 return value;
};

/** The gentle breeze at clock time `t`. */
export function breezeAt(t:number):number {return 2*Math.sin(2.2*t)+0.8*Math.sin(5.1*t);}
/** One gust pulse `peak·sin²(π·age/duration)` inside `[0, duration)`, 0 outside. */
export function gustEnvelope(age:number,peak:number,duration:number):number {
 return age>=0&&age<duration?peak*Math.sin(Math.PI*age/duration)**2:0;
}
/** Repeat period: never shorter than GUST_PERIOD, and 0.6 s of calm after a long pulse. */
export function gustPeriod(duration:number):number {return Math.max(GUST_PERIOD,duration+0.6);}

export interface WindSnapshot {version:1;base:number;breeze:boolean;repeat:boolean;gustPeak:number;gustDuration:number}
export interface WindReading {
 base:number;breeze:boolean;repeat:boolean;time:number;
 /** The breeze term (0 when the breeze is off). */
 gentle:number;gust:number;gusting:boolean;
 /** Seconds since the active pulse began, or null when no pulse was started. */
 gustAge:number|null;
 wind:number;gustPeak:number;gustDuration:number;activeGustPeak:number;activeGustDuration:number;
}
export interface WindModel {
 read():WindReading;snapshot():WindSnapshot;restore(value:WindSnapshot|null):void;
 setBase(value:number):void;setGustPeak(value:number):void;setGustDuration(value:number):void;
 setBreeze(value:boolean):void;setRepeat(value:boolean):void;triggerGust():void;
 advance(dt:number):WindReading;
}
export const defaultWindSnapshot=():WindSnapshot=>({version:1,base:0,breeze:false,repeat:false,gustPeak:GUST_PEAK,gustDuration:GUST_DURATION});

export function createWindModel():WindModel {
 let base=0,breeze=false,repeat=false,time=0,gustStart:number|null=null,gustDirection=1,nextGust:number|null=null;
 let gustPeak=GUST_PEAK,gustDuration=GUST_DURATION,activeGustPeak=GUST_PEAK,activeGustDuration=GUST_DURATION;
 function start(at:number):void {
  gustStart=at;gustDirection=base<0?-1:1;activeGustPeak=gustPeak;activeGustDuration=gustDuration;
  if(repeat)nextGust=at+gustPeriod(activeGustDuration);
 }
 function read():WindReading {
  const age=gustStart===null?activeGustDuration:time-gustStart;
  const gusting=age>=0&&age<activeGustDuration;
  const gust=gusting?gustDirection*gustEnvelope(age,activeGustPeak,activeGustDuration):0;
  const gentle=breeze?breezeAt(time):0;
  return {base,breeze,repeat,time,gentle,gust,gusting,gustAge:gustStart===null?null:age,wind:base+gentle+gust,gustPeak,gustDuration,activeGustPeak,activeGustDuration};
 }
 return {
  read,
  snapshot:()=>({version:1,base,breeze,repeat,gustPeak,gustDuration}),
  restore(value){
   const s=value===null?defaultWindSnapshot():value;
   if(!s||typeof s!=='object'||Array.isArray(s)||s.version!==1)throw new RangeError('wind snapshot must be a version 1 object');
   // Validate the complete configuration before changing the standing state.
   const nextBase=bounded(s.base,-BASE_WIND_LIMIT,BASE_WIND_LIMIT,'base wind');
   const nextPeak=bounded(s.gustPeak,0,MAX_GUST_PEAK,'gust peak');
   const nextDuration=bounded(s.gustDuration,MIN_GUST_DURATION,MAX_GUST_DURATION,'gust duration');
   if(typeof s.breeze!=='boolean'||typeof s.repeat!=='boolean')throw new RangeError('wind snapshot breeze and repeat must be booleans');
   base=nextBase;gustPeak=nextPeak;gustDuration=nextDuration;breeze=s.breeze;repeat=s.repeat;
   time=0;gustStart=null;gustDirection=1;nextGust=null;activeGustPeak=gustPeak;activeGustDuration=gustDuration;
   if(repeat)start(0);
  },
  setBase(value){base=bounded(value,-BASE_WIND_LIMIT,BASE_WIND_LIMIT,'base wind');},
  setGustPeak(value){gustPeak=bounded(value,0,MAX_GUST_PEAK,'gust peak');},
  setGustDuration(value){gustDuration=bounded(value,MIN_GUST_DURATION,MAX_GUST_DURATION,'gust duration');},
  setBreeze(value){breeze=Boolean(value);},
  // A click cannot interrupt a pulse.
  triggerGust(){if(!read().gusting)start(time);},
  setRepeat(value){
   const enabled=Boolean(value);if(enabled===repeat)return;repeat=enabled;
   if(repeat){if(read().gusting)nextGust=gustStart!+gustPeriod(activeGustDuration);else start(time);}
   else nextGust=null; // Finish the active pulse before returning to base.
  },
  advance(dt){
   if(!Number.isFinite(dt)||dt<0||!Number.isFinite(time+dt))throw new RangeError('wind dt must be finite, non-negative and keep a finite clock');
   time+=dt;
   if(repeat&&nextGust!==null&&time>=nextGust){const interval=gustPeriod(gustDuration);start(nextGust+Math.floor((time-nextGust)/interval)*interval);}
   return read();
  },
 };
}

/** The value `player.environment` receives for a reading: wind along x, gravity down. */
export function environmentFor(reading:WindReading,gravity:number):{wind:[number,number];gravity:[number,number]} {
 return {wind:[reading.wind,0],gravity:[0,bounded(gravity,GRAVITY_MIN,GRAVITY_MAX,'gravity')]};
}

const fixed=(value:number,digits=1)=>(Object.is(value,-0)?0:value).toFixed(digits);
/** `wind: base + breeze + gust = total` with the gust phase and the stepped clock. */
export function windReadout(reading:WindReading,gravity:number):string {
 const phase=reading.gusting&&reading.gustAge!==null?` · gust ${reading.gustAge.toFixed(2)}/${reading.activeGustDuration.toFixed(2)} s`:'';
 return `wind: ${fixed(reading.base)} + ${fixed(reading.gentle)} + ${fixed(reading.gust)} = ${fixed(reading.wind)} · gravity ${fixed(gravity,2)} · t ${reading.time.toFixed(3)} s${phase}`;
}
export const RUNTIME_START_READOUT=`Runtime start values · wind [${RUNTIME_START.wind.join(', ')}] · gravity [${RUNTIME_START.gravity.join(', ')}] · controls not applied`;

/** The example's jolt: translate (18, −10), then the inverse 0.09 s later. */
export interface JoltStep {at:number;x:number;y:number}
export const JOLT_DELAY=0.09;
export function joltPacket(start:number):JoltStep[] {return [{at:start,x:18,y:-10},{at:start+JOLT_DELAY,x:-18,y:10}];}
/** Splits a queue into the steps due at `now` (in order) and the rest. */
export function dueJolts(queue:readonly JoltStep[],now:number):{due:JoltStep[];pending:JoltStep[]} {
 const due:JoltStep[]=[],pending:JoltStep[]=[];for(const step of queue)(step.at<=now?due:pending).push(step);
 due.sort((a,b)=>a.at-b.at);return {due,pending};
}

/** A page-pixel pointer delta as `player.moved` wants it: ÷ the root's scale, y negated (world y up). */
export function dragMoved(dx:number,dy:number,scale:number):{x:number;y:number}|null {
 if(!Number.isFinite(dx)||!Number.isFinite(dy)||!Number.isFinite(scale)||scale<=0)return null;
 return {x:dx/scale,y:-dy/scale};
}

/** Columns read as the compiled model declares them; an absent field stays absent. */
export const PHYSICS_FIELDS=['wind','gravity','inertia','strength','damping','mix'] as const;
export type PhysicsField=typeof PHYSICS_FIELDS[number];
export interface PhysicsConstraintRow {name:string;bone:string|null;declaredIn:string|null;values:Partial<Record<PhysicsField,number>>}
export type PhysicsConstraints={available:true;rows:PhysicsConstraintRow[]}|{available:false;reason:string};
export const CONSTRAINT_MIX_READONLY='CONSTRAINT_MIX_READONLY: @rig-c/play exposes no per-constraint mix';

/** Lists the document's `constraints` entries of kind `physics` in their order; nothing is computed or defaulted. */
export function physicsConstraints(document:unknown):PhysicsConstraints {
 if(!document||typeof document!=='object'||Array.isArray(document))return {available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model document is not an object'};
 const list=(document as Record<string,unknown>).constraints;
 if(!Array.isArray(list))return {available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model declares no constraints list'};
 const rows:PhysicsConstraintRow[]=[];
 for(const item of list){
  if(!item||typeof item!=='object'||Array.isArray(item))continue;
  const entry=item as Record<string,unknown>;if(entry.kind!=='physics')continue;
  if(typeof entry.name!=='string'||!entry.name)return {available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: a physics constraint has no name'};
  const values:Partial<Record<PhysicsField,number>>={};
  for(const field of PHYSICS_FIELDS){const value=entry[field];if(typeof value==='number'&&Number.isFinite(value))values[field]=value;}
  rows.push({name:entry.name,bone:typeof entry.bone==='string'?entry.bone:null,declaredIn:typeof entry.declaredIn==='string'?entry.declaredIn:null,values});
 }
 if(!rows.length)return {available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model declares no physics constraints'};
 return {available:true,rows};
}

/** Reads the reviewed model bytes (hash-checked against the reviewed identity) and lists its physics constraints. */
export async function loadPhysicsConstraints(url:string,sha256:string,fetcher:typeof fetch=fetch):Promise<PhysicsConstraints> {
 const response=await fetcher(url);if(!response.ok)return {available:false,reason:`PHYSICS_CONSTRAINTS_UNAVAILABLE: model request failed (${response.status})`};
 const bytes=await response.arrayBuffer();if(bytes.byteLength>128*1024*1024)return {available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model exceeds 128 MiB'};
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
 if(hash!==sha256)return {available:false,reason:'PHYSICS_CONSTRAINTS_UNAVAILABLE: model bytes differ from reviewed SHA-256'};
 try{return physicsConstraints(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
 catch(error){return {available:false,reason:`PHYSICS_CONSTRAINTS_UNAVAILABLE: ${error instanceof Error?error.message:String(error)}`};}
}

/** What a feedback record keeps of the environment it was written under. */
export interface EnvironmentContext {
 applied:boolean;
 wind:{base:number;breeze:boolean;gust:{peak:number;duration:number;repeat:boolean;active:boolean;value:number};total:number};
 gravity:number;
 /** What the player reported standing when the note was written (x right, y down). */
 standing:{wind:[number,number];gravity:[number,number]};
}
export function environmentContext(reading:WindReading,gravity:number,applied:boolean,standing:{wind:readonly number[];gravity:readonly number[]}):EnvironmentContext {
 return {applied,wind:{base:reading.base,breeze:reading.breeze,gust:{peak:reading.gusting?reading.activeGustPeak:reading.gustPeak,duration:reading.gusting?reading.activeGustDuration:reading.gustDuration,repeat:reading.repeat,active:reading.gusting,value:reading.gust},total:reading.wind},gravity,standing:{wind:[standing.wind[0]!,standing.wind[1]!],gravity:[standing.gravity[0]!,standing.gravity[1]!]}};
}

const fail=(field:string,expected:string):never=>{throw new Error(`feedback.context.environment${field}: expected ${expected}`);};
const exactKeys=(value:unknown,keys:readonly string[],field:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))fail(field,'object');
 const o=value as Record<string,unknown>;
 for(const key of Object.keys(o))if(!keys.includes(key))fail(field,`only ${keys.join(', ')}`);
 return o;
};
const finite=(value:unknown,field:string):number=>typeof value==='number'&&Number.isFinite(value)?value:fail(field,'finite number');
const flag=(value:unknown,field:string):boolean=>typeof value==='boolean'?value:fail(field,'boolean');
const pair=(value:unknown,field:string):[number,number]=>Array.isArray(value)&&value.length===2?[finite(value[0],field),finite(value[1],field)]:fail(field,'[x, y]');
/** Validates `context.environment`; null means no compiled model was drawn. Absent stays valid for older records. */
export function parseEnvironmentContext(value:unknown):EnvironmentContext|null {
 if(value===null)return null;
 const o=exactKeys(value,['applied','wind','gravity','standing'],'');
 const wind=exactKeys(o.wind,['base','breeze','gust','total'],'.wind'),gust=exactKeys(wind.gust,['peak','duration','repeat','active','value'],'.wind.gust'),standing=exactKeys(o.standing,['wind','gravity'],'.standing');
 const result:EnvironmentContext={applied:flag(o.applied,'.applied'),
  wind:{base:finite(wind.base,'.wind.base'),breeze:flag(wind.breeze,'.wind.breeze'),gust:{peak:finite(gust.peak,'.wind.gust.peak'),duration:finite(gust.duration,'.wind.gust.duration'),repeat:flag(gust.repeat,'.wind.gust.repeat'),active:flag(gust.active,'.wind.gust.active'),value:finite(gust.value,'.wind.gust.value')},total:finite(wind.total,'.wind.total')},
  gravity:finite(o.gravity,'.gravity'),standing:{wind:pair(standing.wind,'.standing.wind'),gravity:pair(standing.gravity,'.standing.gravity')}};
 if(Math.abs(result.wind.base)>BASE_WIND_LIMIT)fail('.wind.base',`within ±${BASE_WIND_LIMIT}`);
 if(result.wind.gust.peak<0||result.wind.gust.peak>MAX_GUST_PEAK)fail('.wind.gust.peak',`within [0, ${MAX_GUST_PEAK}]`);
 if(result.wind.gust.duration<MIN_GUST_DURATION||result.wind.gust.duration>MAX_GUST_DURATION)fail('.wind.gust.duration',`within [${MIN_GUST_DURATION}, ${MAX_GUST_DURATION}]`);
 if(result.gravity<GRAVITY_MIN||result.gravity>GRAVITY_MAX)fail('.gravity',`within [${GRAVITY_MIN}, ${GRAVITY_MAX}]`);
 return result;
}
/** One line for issue text: "under gust 48 / wind 30". */
export function environmentSummary(value:EnvironmentContext):string {
 const s=value.standing,standing=`standing wind [${s.wind.join(', ')}] · gravity [${s.gravity.join(', ')}]`;
 if(!value.applied)return `runtime start values · ${standing}`;
 const w=value.wind,gust=w.gust.active?`gust ${w.gust.peak} over ${w.gust.duration} s (now ${fixed(w.gust.value)})`:`gust idle (peak ${w.gust.peak}, ${w.gust.duration} s)`;
 return `wind ${w.base}${w.breeze?' + breeze':''} · ${gust}${w.gust.repeat?' · repeat':''} · total ${fixed(w.total)} · gravity ${value.gravity} · ${standing}`;
}
export const environmentJson=(value:EnvironmentContext):Json=>JSON.parse(JSON.stringify(value)) as Json;
