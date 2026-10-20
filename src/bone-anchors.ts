/**
 * Bone anchors (#109): the producer config's `bones` as the Setup Bones block edits them. A single bone is
 * `{name, parent, at, tip?}` and a chain `{chain, parent, points, tip}` whose links are `<chain>0 … <chain>n`
 * (rig-parts AUTHORING, `bones`); every coordinate is rig px, y down, the crop frame the chest and weights views map
 * to the rig world. Each origin, chain point and tip is one anchor addressed by its JSON Pointer
 * (`/bones/<i>/at`, `/bones/<i>/points/<k>`, `/bones/<i>/tip`); an edit is one `replace` op at that pointer naming the
 * entry (a chain is named by its `chain`). A drag moves an anchor by a whole number of rig px, so a value the config
 * writes in integers stays an integer. Pure: no IO, no DOM.
 */
import type {PatchOp} from './config-patch.ts';

export type RigPoint=[number,number];
export type AnchorKind='at'|'point'|'tip';
/** One config `bones` entry as read: its index, its name (`name`, or `chain` for a chain) and its stated points. */
export interface ConfigBone {index:number;name:string;chain:boolean;parent:string|null;at:RigPoint|null;points:RigPoint[];tip:RigPoint|null}
/** One draggable anchor: where it sits in the config, which bone it belongs to and the value the config holds. */
export interface BoneAnchor {path:string;index:number;name:string;kind:AnchorKind;link:number|null;value:RigPoint;label:string}
/** A pending edit: one anchor's new value, with the config's value it was made from. */
export interface BoneEdit {path:string;index:number;name:string;label:string;from:RigPoint;value:RigPoint}
export class BoneAnchorError extends Error {constructor(readonly code:string,detail:string){super(`${code}: ${detail}`);}}

const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const asPoint=(v:unknown):RigPoint|null=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n))?[v[0] as number,v[1] as number]:null;

/** The config's `bones` list read entry by entry; an entry with no name, or a malformed point, is named in `skipped`. */
export function configBones(list:unknown):{bones:ConfigBone[];skipped:string[]} {
 const bones:ConfigBone[]=[],skipped:string[]=[];
 if(!Array.isArray(list))return {bones,skipped:list===undefined||list===null?[]:['bones is not a list']};
 list.forEach((raw,index)=>{
  if(!isObject(raw)){skipped.push(`bones[${index}] is not an object`);return;}
  const chain=typeof raw.chain==='string'&&typeof raw.name!=='string',name=typeof raw.name==='string'?raw.name:typeof raw.chain==='string'?raw.chain:null;
  if(!name){skipped.push(`bones[${index}] names no bone (no name or chain)`);return;}
  const at=raw.at===undefined?null:asPoint(raw.at),tip=raw.tip===undefined?null:asPoint(raw.tip);
  const points=Array.isArray(raw.points)?raw.points.map(asPoint):[];
  if((raw.at!==undefined&&!at)||(raw.tip!==undefined&&!tip)||points.some(p=>!p)||(raw.points!==undefined&&!Array.isArray(raw.points))){skipped.push(`bones[${index}] "${name}" holds a point that is not [x, y]`);return;}
  bones.push({index,name,chain,parent:typeof raw.parent==='string'?raw.parent:null,at,points:points as RigPoint[],tip});
 });
 return {bones,skipped};
}

/** Every anchor of every bone, in config order: a bone's origin then its tip; a chain's points then its tip. */
export function boneAnchors(bones:readonly ConfigBone[]):BoneAnchor[] {
 return bones.flatMap(b=>{
  const out:BoneAnchor[]=[],base=`/bones/${b.index}`;
  if(b.at)out.push({path:`${base}/at`,index:b.index,name:b.name,kind:'at',link:null,value:[...b.at],label:b.name});
  b.points.forEach((p,k)=>out.push({path:`${base}/points/${k}`,index:b.index,name:b.name,kind:'point',link:k,value:[...p],label:`${b.name}${k}`}));
  if(b.tip)out.push({path:`${base}/tip`,index:b.index,name:b.name,kind:'tip',link:null,value:[...b.tip],label:`${b.name} tip`});
  return out;
 });
}

/** Decimal places a value is written with (382.7 → 1, 416 → 0). */
const places=(v:number)=>{const s=String(v),dot=s.indexOf('.');return dot<0||/e/i.test(s)?0:s.length-dot-1;};
/** A pointer delta in rig px snapped to whole px (never -0). */
export const snapDelta=(d:number)=>{const r=Math.round(d);return r===0?0:r;};
/**
 * A drag from `start` to `now` (both rig px) moves `from` by the delta snapped to whole px, written with the decimals
 * `from` already has: an integer stays an integer, 382.7 + 7 is 389.7.
 */
export function dragAnchor(from:RigPoint,start:RigPoint,now:RigPoint):RigPoint {
 return [0,1].map(i=>{const v=from[i]!+snapDelta(now[i]!-start[i]!);return Number(v.toFixed(places(from[i]!)));}) as RigPoint;
}

const same=(a:RigPoint,b:RigPoint)=>a[0]===b[0]&&a[1]===b[1];
/** Set one anchor's value; a value equal to the config's removes its pending edit. */
export function setAnchor(edits:ReadonlyMap<string,BoneEdit>,anchor:BoneAnchor,value:RigPoint):Map<string,BoneEdit> {
 if(!value.every(Number.isFinite))throw new BoneAnchorError('BONES_VALUE_INVALID',`${anchor.label} must be two finite numbers`);
 const next=new Map(edits);
 if(same(value,anchor.value))next.delete(anchor.path);
 else next.set(anchor.path,{path:anchor.path,index:anchor.index,name:anchor.name,label:anchor.label,from:[...anchor.value],value:[...value]});
 return next;
}
/** Where each anchor stands now: its pending value, else the config's. */
export const anchorAt=(anchor:BoneAnchor,edits:ReadonlyMap<string,BoneEdit>):RigPoint=>edits.get(anchor.path)?.value??anchor.value;
/** The pending edits as config patch ops: `replace` at the anchor's pointer, naming the entry (bone resolved by name, index recorded). */
export const boneOps=(edits:ReadonlyMap<string,BoneEdit>):PatchOp[]=>[...edits.values()].map(e=>({op:'replace',path:e.path,value:[...e.value],name:e.name}));

export const BONES_DRAFT_SCHEMA='rig-review-bones-draft/1';
export const draftText=(edits:ReadonlyMap<string,BoneEdit>)=>JSON.stringify({schema:BONES_DRAFT_SCHEMA,edits:[...edits.values()]});
/** Edits back from a draft, kept only where the anchor still resolves (same pointer, same name, same config value). */
export function draftEdits(text:string,anchors:readonly BoneAnchor[]):Map<string,BoneEdit> {
 let doc:unknown;try{doc=JSON.parse(text);}catch{return new Map();}
 if(!isObject(doc)||doc.schema!==BONES_DRAFT_SCHEMA||!Array.isArray(doc.edits))return new Map();
 let edits=new Map<string,BoneEdit>();
 for(const raw of doc.edits){
  if(!isObject(raw))continue;const anchor=anchors.find(a=>a.path===raw.path),from=asPoint(raw.from),value=asPoint(raw.value);
  if(!anchor||!from||!value||raw.name!==anchor.name||!same(from,anchor.value))continue;
  edits=setAnchor(edits,anchor,value);
 }
 return edits;
}

const BONE_PATH=/^\/bones\/(0|[1-9][0-9]*)\/(at|tip|points\/(0|[1-9][0-9]*))$/;
/** The Bones block's scope: every op replaces one anchor with a finite [x, y] and names its entry. */
export function assertBoneOps(ops:readonly PatchOp[]):void {
 for(const [i,op] of ops.entries()){
  if(op.op!=='replace'||!BONE_PATH.test(op.path))throw new BoneAnchorError('BONES_OP_OUT_OF_SCOPE',`ops[${i}] ${op.op} ${op.path}: the Bones block replaces /bones/<i>/at, /bones/<i>/points/<k> or /bones/<i>/tip only (adding, removing or re-parenting bones is out of scope)`);
  if(!asPoint(op.value))throw new BoneAnchorError('BONES_OP_OUT_OF_SCOPE',`ops[${i}] ${op.path}: the value must be [x, y] in rig px`);
  if(typeof op.name!=='string')throw new BoneAnchorError('BONES_OP_OUT_OF_SCOPE',`ops[${i}] ${op.path}: the op must name its bone entry`);
 }
}

/** Apply stays a choice: a LINT line blocks nothing, so only a running job or no pending edit disables it. */
export const bonesApplyEnabled=(state:{busy:boolean;pending:number;lint:readonly string[]})=>!state.busy&&state.pending>0;

/** `propose --from-config`'s lines, sorted: each LINT line, the LINT count line and the coverage lines, as printed. */
export function proposeLines(lines:readonly string[]):{lint:string[];summary:string|null;coverage:string[]} {
 const trimmed=lines.map(l=>l.trim());
 return {lint:trimmed.filter(l=>/^LINT\s/.test(l)),summary:trimmed.find(l=>/^\d+ LINT line\(s\)/.test(l))??null,coverage:trimmed.filter(l=>/^coverage[\s:]/.test(l))};
}
export interface OriginRow {bone:string;distance:number|null;tip:number|null;text:string}
/** `compare`'s per-bone origin and tip distances (null for a SKIP) and its summary lines (origin, tip, parent, length, direction). */
export function compareOrigins(lines:readonly string[]):{origins:OriginRow[];summary:string[]} {
 const origins:OriginRow[]=[],summary:string[]=[];
 for(const raw of lines){
  const line=raw.trim(),row=/^([^\s:]+): origin (?:(\d+(?:\.\d+)?) px|SKIP)/.exec(line);
  if(row){const tip=/ · tip (\d+(?:\.\d+)?) px/.exec(line);origins.push({bone:row[1]!,distance:row[2]===undefined?null:Number(row[2]),tip:tip?Number(tip[1]):null,text:line});continue;}
  if(/^(origin|tip|parent|length|direction): /.test(line))summary.push(line);
 }
 return {origins,summary};
}
/** The compare rows a reviewer reads after a move: every bone whose origin or tip moved, as printed. */
export const movedRows=(rows:readonly OriginRow[])=>rows.filter(r=>(r.distance??0)>0||(r.tip??0)>0);
