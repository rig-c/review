/**
 * Setup · Rig fields (#110): the small producer config fields the Fields block edits, read from the handoff config and
 * written back as config patch ops (`src/config-patch.ts`), one pointer per field (rig-parts AUTHORING §3):
 * - `regions.<part>` — the bone a rigid part rides: `replace /regions/<part>` with a bone name.
 * - `motion.blink.still.<part>` — `{row, bone}`: the rows of a lash above `row` (rig px, y down) drawn by `<part>_still`
 *   on `bone` and kept off the blink: `add /motion/blink/still/<part>` (preceded by `add /motion/blink/still {}` when
 *   the config states no `still`), `remove` to drop it.
 * - `stops[i]` — `{chain, links?, against, at, inward, outward, lower?}`, rig-c's leg stop: `replace /stops/<i>` with the
 *   entry, `inward` / `outward` changed (degrees), naming its chain.
 * - `bones[i].inherit` (a single bone) or `bones[i].link_inherit` (a chain, `{<link>: mode}`): one of rig-c's five
 *   mode names, `add` (or `remove` back to absent), naming the bone.
 * - `turn.pivot` and `turn.depths.<part>` — `replace /turn/pivot`, `replace /turn/depths/<part>` (numbers).
 * The producer judges every value (`CONFIG_STILL_OFF_THE_BLINK`, `CONFIG_BONE_INHERIT`, `CONFIG_TURN_*`,
 * `CONFIG_NAME_RESOLVES`, `RIG_STILL_ROW_CLEAR`, `RIG_STOP_BOUNDS`): review pre-checks nothing it would refuse and shows
 * its line verbatim. Pure: no IO, no DOM, no clock.
 */
import {formatPointer,parsePointer,type JsonValue,type PatchOp} from './config-patch.ts';

/** rig-c's five inherit modes as rig-parts AUTHORING (`CONFIG_BONE_INHERIT`) spells them. */
export const INHERIT_MODES=['normal','onlyTranslation','noRotationOrReflection','noScale','noScaleOrReflection'] as const;
export type InheritMode=typeof INHERIT_MODES[number];
/** The check bars the Fields readout quotes before and after an Apply. */
export const RIG_FIELDS_READOUT_BARS=['BLINK_NO_HOLE','FEET_STAY_LEVEL'] as const;
/** The bone the rig stage adds for `turn`: its local x is the dial, in rig px; nothing keys it. */
export const TURN_BONE='turn';
/** The dial's range, rig px either way. */
export const TURN_DIAL_RANGE=120;
export const TURN_PREVIEW_LABEL='preview — Apply decides';

export type RigPoint=[number,number];
export interface StillEntry {row:number;bone:string}
export interface StopEntry {index:number;chain:string;links:string[]|null;against:string;at:RigPoint;inward:number;outward:number;raw:Record<string,JsonValue>}
export interface FieldBone {index:number;name:string;chain:boolean;links:string[];parent:string|null;at:RigPoint|null;points:RigPoint[];tip:RigPoint|null;inherit:string|null;linkInherit:Record<string,string>|null}
export interface RigFieldsSource {
 /** `regions` as written (part → bone), or null when the config states none. */
 regions:Record<string,string>|null;
 /** `motion.blink`: its `eyes` and its `still` (null when absent); null when the config states no blink. */
 blink:{eyes:string[];still:Record<string,StillEntry>|null}|null;
 stops:StopEntry[]|null;
 bones:FieldBone[];
 /** Every bone the config declares (chain links expanded), plus `root`, which the rig stage adds. */
 boneNames:string[];
 turn:{pivot:number;depths:Record<string,number>}|null;
 /** Entries not read, named. */
 skipped:string[];
}
export class RigFieldsError extends Error {constructor(readonly code:string,detail:string){super(`${code}: ${detail}`);}}

const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const asPoint=(v:unknown):RigPoint|null=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n))?[v[0] as number,v[1] as number]:null;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);

/** The config's fields as the Fields block reads them; an entry it cannot read is named in `skipped`, never guessed. */
export function rigFieldsSource(config:unknown):RigFieldsSource {
 const c=isObject(config)?config:{},skipped:string[]=[];
 const regions=isObject(c.regions)?Object.fromEntries(Object.entries(c.regions).filter(([part,bone])=>{if(typeof bone==='string')return true;skipped.push(`regions.${part} is not a bone name`);return false;})) as Record<string,string>:null;
 const bones:FieldBone[]=[];
 (Array.isArray(c.bones)?c.bones:[]).forEach((raw,index)=>{
  if(!isObject(raw))return;
  const chain=typeof raw.chain==='string'&&typeof raw.name!=='string',name=typeof raw.name==='string'?raw.name:typeof raw.chain==='string'?raw.chain:null;if(!name)return;
  const points=Array.isArray(raw.points)?raw.points.map(asPoint).filter((p):p is RigPoint=>!!p):[];
  const linkInherit=isObject(raw.link_inherit)?Object.fromEntries(Object.entries(raw.link_inherit).filter(([,m])=>typeof m==='string')) as Record<string,string>:null;
  bones.push({index,name,chain,links:chain?points.map((_,k)=>`${name}${k}`):[],parent:typeof raw.parent==='string'?raw.parent:null,at:asPoint(raw.at),points,tip:asPoint(raw.tip),inherit:typeof raw.inherit==='string'?raw.inherit:null,linkInherit});
 });
 const boneNames=['root',...bones.flatMap(b=>b.chain?b.links:[b.name])];
 const motion=isObject(c.motion)?c.motion:{},blinkRaw=isObject(motion.blink)?motion.blink:null;
 let blink:RigFieldsSource['blink']=null;
 if(blinkRaw){
  const eyes=Array.isArray(blinkRaw.eyes)?blinkRaw.eyes.filter((e):e is string=>typeof e==='string'):[];
  let still:Record<string,StillEntry>|null=null;
  if(isObject(blinkRaw.still)){still={};for(const [part,v] of Object.entries(blinkRaw.still)){if(isObject(v)&&finite(v.row)&&typeof v.bone==='string')still[part]={row:v.row,bone:v.bone};else skipped.push(`motion.blink.still.${part} is not {row, bone}`);}}
  blink={eyes,still};
 }
 let stops:StopEntry[]|null=null;
 if(Array.isArray(c.stops)){stops=[];c.stops.forEach((raw,index)=>{
  const at=isObject(raw)?asPoint(raw.at):null;
  if(!isObject(raw)||typeof raw.chain!=='string'||typeof raw.against!=='string'||!at||!finite(raw.inward)||!finite(raw.outward)){skipped.push(`stops[${index}] is not {chain, against, at, inward, outward}`);return;}
  stops!.push({index,chain:raw.chain,links:Array.isArray(raw.links)?raw.links.filter((l):l is string=>typeof l==='string'):null,against:raw.against,at,inward:raw.inward,outward:raw.outward,raw:structuredClone(raw) as Record<string,JsonValue>});
 });}
 let turn:RigFieldsSource['turn']=null;
 if(isObject(c.turn)){
  const depths=isObject(c.turn.depths)?Object.fromEntries(Object.entries(c.turn.depths).filter(([,d])=>finite(d))) as Record<string,number>:{};
  if(finite(c.turn.pivot))turn={pivot:c.turn.pivot,depths};else skipped.push('turn.pivot is not a number');
 }
 return {regions,blink,stops,bones,boneNames,turn,skipped};
}

// ---- pending edits ----
/** One pending field edit, keyed by its pointer: what the config holds (`from`, undefined when absent) and the value. */
export interface FieldEdit {field:'region'|'still'|'stop'|'inherit'|'turn';path:string;op:'replace'|'add'|'remove';from:JsonValue|undefined;value?:JsonValue;name?:string;label:string}
export type FieldEdits=ReadonlyMap<string,FieldEdit>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function put(edits:FieldEdits,edit:FieldEdit):Map<string,FieldEdit> {
 const next=new Map(edits);
 // Back to what the config holds: no pending op.
 if(edit.op==='remove'?edit.from===undefined:same(edit.value,edit.from))next.delete(edit.path);else next.set(edit.path,edit);
 return next;
}
/** The pointers, one function per field: the patch path an edit writes (the bars' wrong-path mutants change these). */
export const regionPath=(part:string)=>formatPointer(['regions',part]);
export const stillPath=(part:string)=>formatPointer(['motion','blink','still',part]);
export const stopPath=(index:number)=>formatPointer(['stops',index]);
export const inheritPath=(bone:FieldBone)=>formatPointer(['bones',bone.index,bone.chain?'link_inherit':'inherit']);
export const turnPivotPath=()=>formatPointer(['turn','pivot']);
export const turnDepthPath=(part:string)=>formatPointer(['turn','depths',part]);

/** The bone a rigid part rides. A part `regions` does not hold is refused here (it is a mesh, or no part). */
export function setRegion(source:RigFieldsSource,edits:FieldEdits,part:string,bone:string):Map<string,FieldEdit> {
 const from=source.regions?.[part];
 if(from===undefined)throw new RigFieldsError('RIG_FIELDS_NOT_A_REGION',`${part} is not in the config's regions (a meshed part rides its weights)`);
 if(typeof bone!=='string'||!bone)throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`regions.${part} must name a bone`);
 return put(edits,{field:'region',path:regionPath(part),op:'replace',from,value:bone,label:`regions.${part}`});
}
/** A lash's still row: `{row, bone}` (row snapped to whole rig px by the drag), or null to drop the entry. */
export function setStill(source:RigFieldsSource,edits:FieldEdits,part:string,entry:StillEntry|null):Map<string,FieldEdit> {
 if(!source.blink)throw new RigFieldsError('RIG_FIELDS_NO_BLINK','the config states no motion.blink; a still row belongs to the blink');
 const from=source.blink.still?.[part],path=stillPath(part),label=`motion.blink.still.${part}`;
 if(entry===null)return put(edits,{field:'still',path,op:'remove',from:from as JsonValue|undefined,label});
 if(!finite(entry.row)||typeof entry.bone!=='string'||!entry.bone)throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`${label} must be {row: number, bone: name}`);
 return put(edits,{field:'still',path,op:'add',from:from as JsonValue|undefined,value:{row:entry.row,bone:entry.bone},label});
}
/** A stop's inward / outward bound (degrees): the whole entry is replaced, every other key as written. */
export function setStop(source:RigFieldsSource,edits:FieldEdits,index:number,bounds:{inward?:number;outward?:number}):Map<string,FieldEdit> {
 const stop=source.stops?.find(s=>s.index===index);
 if(!stop)throw new RigFieldsError('RIG_FIELDS_NO_STOP',`the config states no stops[${index}]`);
 const path=stopPath(index),current=(edits.get(path)?.value as Record<string,JsonValue>|undefined)??stop.raw,value={...structuredClone(current)};
 for(const key of ['inward','outward'] as const){const v=bounds[key];if(v===undefined)continue;if(!finite(v))throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`stops[${index}].${key} must be a finite number`);value[key]=v;}
 return put(edits,{field:'stop',path,op:'replace',from:stop.raw,value,name:stop.chain,label:`stops[${index}] ${stop.chain}`});
}
/**
 * A bone's inherit mode, or null back to absent (rig-c's `normal`). A chain's link is set in its `link_inherit`, the
 * whole object written at once. The mode is passed as given: one rig-c does not name is the producer's to refuse
 * (`CONFIG_BONE_INHERIT`).
 */
export function setInherit(source:RigFieldsSource,edits:FieldEdits,index:number,mode:string|null,link?:string):Map<string,FieldEdit> {
 const bone=source.bones.find(b=>b.index===index);
 if(!bone)throw new RigFieldsError('RIG_FIELDS_NO_BONE',`the config states no bones[${index}]`);
 const path=inheritPath(bone),label=bone.chain?`bones[${index}] ${bone.name}.link_inherit`:`bones[${index}] ${bone.name}.inherit`;
 if(!bone.chain){
  if(link!==undefined)throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`${bone.name} is a single bone; it has no links`);
  return put(edits,mode===null?{field:'inherit',path,op:'remove',from:bone.inherit??undefined,name:bone.name,label}:{field:'inherit',path,op:'add',from:bone.inherit??undefined,value:mode,name:bone.name,label});
 }
 if(link===undefined||!bone.links.includes(link))throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`${bone.name} is a chain; name one of its links (${bone.links.join(', ')})`);
 const current={...((edits.get(path)?.value as Record<string,string>|undefined)??bone.linkInherit??{})};
 if(mode===null)delete current[link];else current[link]=mode;
 const from=bone.linkInherit??undefined;
 return put(edits,Object.keys(current).length?{field:'inherit',path,op:'add',from,value:current,name:bone.name,label}:{field:'inherit',path,op:'remove',from,name:bone.name,label});
}
/** `turn.pivot`, or one part's `turn.depths` entry (numbers; the producer judges the pivot against the nearest depth). */
export function setTurn(source:RigFieldsSource,edits:FieldEdits,target:{pivot:number}|{part:string;depth:number}):Map<string,FieldEdit> {
 if(!source.turn)throw new RigFieldsError('RIG_FIELDS_NO_TURN','the config states no turn');
 if('pivot' in target){
  if(!finite(target.pivot))throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID','turn.pivot must be a finite number');
  return put(edits,{field:'turn',path:turnPivotPath(),op:'replace',from:source.turn.pivot,value:target.pivot,label:'turn.pivot'});
 }
 const from=source.turn.depths[target.part];
 if(from===undefined)throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`turn.depths states no ${target.part}`);
 if(!finite(target.depth))throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID',`turn.depths.${target.part} must be a finite number`);
 return put(edits,{field:'turn',path:turnDepthPath(target.part),op:'replace',from,value:target.depth,label:`turn.depths.${target.part}`});
}

/**
 * The pending edits as config patch ops, in a fixed order (regions, still, stops, inherit, turn; then by path). A still
 * row added to a config with no `motion.blink.still` is preceded by `add /motion/blink/still {}`.
 */
export function rigFieldOps(source:RigFieldsSource,edits:FieldEdits):PatchOp[] {
 const order=['region','still','stop','inherit','turn'],list=[...edits.values()].sort((a,b)=>order.indexOf(a.field)-order.indexOf(b.field)||(a.path<b.path?-1:a.path>b.path?1:0));
 const ops:PatchOp[]=[];
 if(source.blink&&!source.blink.still&&list.some(e=>e.field==='still'&&e.op==='add'))ops.push({op:'add',path:formatPointer(['motion','blink','still']),value:{}});
 for(const e of list){
  const tag=e.name===undefined?{}:{name:e.name};
  ops.push(e.op==='remove'?{op:'remove',path:e.path,...tag}:{op:e.op,path:e.path,value:structuredClone(e.value!),...tag});
 }
 return ops;
}

const PART=/^[^/~]+$/;
/**
 * The Fields block's scope: every op is one of the card's pointers with a value of its shape; a list entry addressed by
 * index names its entry (a bone by `name` or `chain`, a stop by `chain`). Anything else is `RIG_FIELDS_OP_OUT_OF_SCOPE`.
 */
export function assertRigFieldOps(ops:readonly PatchOp[]):void {
 const out=(i:number,op:PatchOp,why:string)=>new RigFieldsError('RIG_FIELDS_OP_OUT_OF_SCOPE',`ops[${i}] ${op.op} ${op.path}: ${why}`);
 for(const [i,op] of ops.entries()){
  const t=parsePointer(op.path),v=op.value;
  if(t[0]==='regions'&&t.length===2&&PART.test(t[1]!)){if(op.op!=='replace'||typeof v!=='string'||!v)throw out(i,op,'a region is replaced with a bone name');continue;}
  if(t[0]==='motion'&&t[1]==='blink'&&t[2]==='still'){
   if(t.length===3){if(op.op!=='add'||!isObject(v)||Object.keys(v).length)throw out(i,op,'only {} may be added at /motion/blink/still');continue;}
   if(t.length===4){if(op.op==='remove')continue;if(op.op!=='add'||!isObject(v)||Object.keys(v).sort().join(',')!=='bone,row'||!finite(v.row)||typeof v.bone!=='string')throw out(i,op,'a still entry is {row, bone}');continue;}
  }
  if(t[0]==='stops'&&t.length===2&&/^(0|[1-9][0-9]*)$/.test(t[1]!)){if(op.op!=='replace'||!isObject(v)||typeof op.name!=='string')throw out(i,op,'a stop is replaced whole and names its chain');continue;}
  if(t[0]==='bones'&&t.length===3&&/^(0|[1-9][0-9]*)$/.test(t[1]!)&&(t[2]==='inherit'||t[2]==='link_inherit')){
   if(typeof op.name!=='string')throw out(i,op,'the op must name its bone entry');
   if(op.op==='remove')continue;
   if(op.op!=='add'||(t[2]==='inherit'?typeof v!=='string':!isObject(v)||!Object.values(v).every(m=>typeof m==='string')))throw out(i,op,t[2]==='inherit'?'inherit is a mode name':'link_inherit is {<link>: mode}');
   continue;
  }
  if(t[0]==='turn'&&((t.length===2&&t[1]==='pivot')||(t.length===3&&t[1]==='depths'))){if(op.op!=='replace'||!finite(v))throw out(i,op,'a turn value is replaced with a number');continue;}
  throw out(i,op,'the Fields block writes /regions/<part>, /motion/blink/still/<part>, /stops/<i>, /bones/<i>/inherit (link_inherit), /turn/pivot and /turn/depths/<part> only (turn.deform is out of scope)');
 }
}

// ---- draft ----
export const RIG_FIELDS_DRAFT_SCHEMA='rig-review-rig-fields-draft/1';
export const fieldsDraftText=(edits:FieldEdits)=>JSON.stringify({schema:RIG_FIELDS_DRAFT_SCHEMA,edits:[...edits.values()]});
/** Edits back from a draft, kept only where the field still holds the value the edit was made from. */
export function fieldsDraftEdits(text:string,source:RigFieldsSource):Map<string,FieldEdit> {
 let doc:unknown;try{doc=JSON.parse(text);}catch{return new Map();}
 if(!isObject(doc)||doc.schema!==RIG_FIELDS_DRAFT_SCHEMA||!Array.isArray(doc.edits))return new Map();
 const fresh=new Map<string,FieldEdit>();
 for(const raw of doc.edits){
  if(!isObject(raw)||typeof raw.path!=='string')continue;
  const now=currentAt(source,raw.path);
  if(!same(now,raw.from))continue;
  fresh.set(raw.path,raw as unknown as FieldEdit);
 }
 return fresh;
}
/** What the config holds at a field pointer (undefined when absent). */
export function currentAt(source:RigFieldsSource,path:string):JsonValue|undefined {
 const t=parsePointer(path);
 if(t[0]==='regions')return source.regions?.[t[1]!];
 if(t[0]==='motion')return source.blink?.still?.[t[3]!] as JsonValue|undefined;
 if(t[0]==='stops')return source.stops?.find(s=>s.index===Number(t[1]))?.raw;
 if(t[0]==='bones'){const b=source.bones.find(x=>x.index===Number(t[1]));return (t[2]==='inherit'?b?.inherit:b?.linkInherit)??undefined;}
 if(t[0]==='turn')return t[1]==='pivot'?source.turn?.pivot:source.turn?.depths[t[2]!];
 return undefined;
}

// ---- stage geometry (rig px, y down; angles in Spine degrees, counter-clockwise, y up) ----
/** Snap a row drag (rig px) to whole px, keeping the decimals the row is written with. */
export function dragRow(from:number,startY:number,nowY:number):number {
 const d=Math.round(nowY-startY),dot=String(from).indexOf('.'),places=dot<0?0:String(from).length-dot-1;
 return Number((from+(d===0?0:d)).toFixed(places));
}
/** The eligible lashes: region parts on a bone the blink's `eyes` names. */
export function stillParts(source:RigFieldsSource):string[] {
 const eyes=new Set(source.blink?.eyes??[]);
 return Object.entries(source.regions??{}).filter(([,bone])=>eyes.has(bone)).map(([part])=>part).sort();
}
/** A new still row's start: the eye bone's origin row, held by that bone's parent (`head` as proposed). */
export function seedStill(source:RigFieldsSource,part:string):StillEntry|null {
 const eye=source.regions?.[part],bone=source.bones.find(b=>!b.chain&&b.name===eye);
 return bone?.at?{row:bone.at[1],bone:bone.parent??'head'}:null;
}
/** Where a bone (or chain link) starts and which way it points, from the config: a link to the next point or the tip. */
function frame(source:RigFieldsSource,name:string):{origin:RigPoint;dir:RigPoint}|null {
 for(const b of source.bones){
  if(!b.chain&&b.name===name&&b.at){const to=b.tip,d=to?[to[0]-b.at[0],to[1]-b.at[1]] as RigPoint:[1,0] as RigPoint,n=Math.hypot(...d)||1;return {origin:b.at,dir:[d[0]/n,d[1]/n]};}
  const k=b.chain?b.links.indexOf(name):-1;
  if(k>=0){const o=b.points[k]!,to=b.points[k+1]??b.tip;if(!to)return null;const d=[to[0]-o[0],to[1]-o[1]] as RigPoint,n=Math.hypot(...d)||1;return {origin:o,dir:[d[0]/n,d[1]/n]};}
 }
 return null;
}
const norm=(deg:number)=>{let a=((deg+180)%360+360)%360-180;if(a===-180)a=180;return a;};
/**
 * A stop's arcs as rig-c's `expandStops` aims them: the pivot is the first stopped link's origin, the touch point is
 * `at` in `against`'s frame (`+x` along it, `+y` 90° counter-clockwise in Spine world), and `rest` is the direction
 * from the pivot to the touch; the link is clamped inside `[rest − inward, rest + outward]`.
 */
export function stopArcs(source:RigFieldsSource,stop:StopEntry,bounds:{inward:number;outward:number}={inward:stop.inward,outward:stop.outward}):{pivot:RigPoint;touch:RigPoint;rest:number;from:number;to:number}|{reason:string} {
 const chain=source.bones.find(b=>b.chain&&b.name===stop.chain);if(!chain)return {reason:`CONFIG_NAME_RESOLVES: stops[${stop.index}].chain ${stop.chain} is not a chain bones declares`};
 const first=stop.links?.[0]??chain.links[0],k=first?chain.links.indexOf(first):-1;if(k<0)return {reason:`CONFIG_NAME_RESOLVES: stops[${stop.index}] names no link of ${stop.chain}`};
 const against=frame(source,stop.against);if(!against)return {reason:`CONFIG_NAME_RESOLVES: stops[${stop.index}].against ${stop.against} has no origin and direction in bones`};
 const pivot=chain.points[k]!,[u0,u1]=against.dir,v:RigPoint=[u1,-u0];
 const touch:RigPoint=[against.origin[0]+stop.at[0]*u0+stop.at[1]*v[0],against.origin[1]+stop.at[0]*u1+stop.at[1]*v[1]];
 const rest=Math.atan2(-(touch[1]-pivot[1]),touch[0]-pivot[0])*180/Math.PI;
 return {pivot,touch,rest,from:rest-bounds.inward,to:rest+bounds.outward};
}
/** A drag of a stop's arc end to `angle` (Spine degrees): the bound it sets, in whole degrees, never below 0. */
export function arcBound(rest:number,side:'inward'|'outward',angle:number):number {
 const d=Math.round(norm(side==='outward'?angle-rest:rest-angle));
 return d<=0?0:d;
}
/** The dial's write: the `turn` bone's local x (rig px) held at the dial on every pose; nothing else. */
export function turnDial(x:number):(bones:{bone(name:string):{x:number}})=>void {
 if(!finite(x))throw new RigFieldsError('RIG_FIELDS_VALUE_INVALID','the dial must be a finite number');
 return bones=>{bones.bone(TURN_BONE).x=x;};
}
/**
 * The angle-range reading (#108) the block's one-click button runs: a bone picked for inherit against its parent (how
 * far it turns from what it inherits); else a rigid part whose bone is being changed, its new bone against the bone it
 * rode (how differently the part now moves); else the part's bone against its parent. Null when there is no such pair.
 */
export function readingPair(source:RigFieldsSource,edits:FieldEdits,sel:{bone:number|null;part:string|null}):{bone:string;relative:string}|null {
 const single=source.bones.find(b=>b.index===sel.bone&&!b.chain);
 if(single)return single.parent?{bone:single.name,relative:single.parent}:null;
 const held=sel.part!==null?source.regions?.[sel.part]:undefined;if(held===undefined)return null;
 const edit=edits.get(regionPath(sel.part!)),now=typeof edit?.value==='string'?edit.value:held;
 if(now!==held)return {bone:now,relative:held};
 const bone=source.bones.find(b=>!b.chain&&b.name===held);
 return bone?.parent?{bone:held,relative:bone.parent}:null;
}
/** Apply runs only with pending ops and no job running. */
export const fieldsApplyEnabled=(state:{busy:boolean;pending:number})=>!state.busy&&state.pending>0;
