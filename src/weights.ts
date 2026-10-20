/**
 * Setup-space mesh weights (#107), read from the compiled model document as stored. Watch-only: nothing here edits,
 * normalises or infers a weight.
 *
 * `rigc-compiled/3` stores a mesh attachment's setup-pose vertices at `skins[].attachments.<slot>.<name>.vertices`:
 * `{weighted: false, xy}` — x, y pairs local to the slot's bone, so every vertex is the slot's bone at 1.0 — or
 * `{weighted: true, bindings}` — one list per vertex of `{bone, x, y, weight}` (the bone by name). A `linkedmesh`
 * carries no vertices of its own; it draws its source mesh's (`{skin, slot, source}`), read here the same way.
 */
export const WEIGHTS_MODEL_UNAVAILABLE='WEIGHTS_MODEL_UNAVAILABLE';
export const WEIGHTS_SELECT_SLOT='WEIGHTS_SELECT_SLOT';
export const WEIGHTS_NO_MESH='WEIGHTS_NO_MESH';
export const WEIGHTS_MODEL_INVALID='WEIGHTS_MODEL_INVALID';

/** One stored influence of one vertex: the bone, the vertex in that bone's space and the weight, as stored. */
export interface WeightInfluence {bone:string;x:number;y:number;weight:number}
export interface MeshWeights {
 slot:string;skin:string;attachment:string;
 /** Where the vertices were read: the attachment itself, or a linked mesh's source. */
 source:{skin:string;slot:string;attachment:string};
 weighted:boolean;
 /** Per vertex, the influences in stored order. */
 vertices:WeightInfluence[][];
 /** Every bone that influences a vertex, in first-stored order. */
 bones:string[];
 /** The attachment's triangle indices, as stored. */
 triangles:number[];
}
export type WeightsResult={ok:true;weights:MeshWeights}|{ok:false;code:string};

type Obj=Record<string,unknown>;
const isObject=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);

/** The compiled model document, or the refusal that names why there is none (bar 2: a package without one). */
export function weightsModel(model:unknown):{ok:true;model:Obj}|{ok:false;code:string} {
 if(model===null||model===undefined)return {ok:false,code:`${WEIGHTS_MODEL_UNAVAILABLE}: the package supplies no compiled model document; weights are read from it`};
 if(!isObject(model)||model.spec!=='rigc-compiled/3')return {ok:false,code:`${WEIGHTS_MODEL_UNAVAILABLE}: the model document is not rigc-compiled/3`};
 return {ok:true,model};
}

function attachmentOf(model:Obj,skin:string,slot:string,name:string):Obj|undefined {
 const skins=Array.isArray(model.skins)?model.skins:[];
 const found=skins.find(s=>isObject(s)&&s.name===skin) as Obj|undefined;
 const slots=found&&isObject(found.attachments)?found.attachments[slot]:undefined;
 const entry=isObject(slots)?slots[name]:undefined;
 return isObject(entry)?entry:undefined;
}
/** Without an identity: the slot's mesh attachment named like the slot, else its only mesh (first skin that has it). */
function guessFree(model:Obj,slot:string):{skin:string;attachment:string}|null {
 const found:{skin:string;attachment:string}[]=[];
 for(const s of Array.isArray(model.skins)?model.skins:[]){
  if(!isObject(s)||typeof s.name!=='string'||!isObject(s.attachments)||!isObject(s.attachments[slot]))continue;
  for(const [name,a]of Object.entries(s.attachments[slot] as Obj))if(isObject(a)&&(a.kind==='mesh'||a.kind==='linkedmesh'))found.push({skin:s.name,attachment:name});
 }
 return found.find(f=>f.attachment===slot)??(found.length===1?found[0]!:null);
}

/**
 * The setup-pose weights of `slot`'s mesh attachment `active` (the identity the held pose resolved; null takes the
 * slot's mesh named like the slot, else its only one). Weights are returned exactly as stored.
 */
export function meshWeights(model:unknown,slot:string|null,active:{skin:string;attachment:string}|null):WeightsResult {
 const doc=weightsModel(model);if(!doc.ok)return doc;
 if(!slot)return {ok:false,code:`${WEIGHTS_SELECT_SLOT}: select one mesh slot in the parts list`};
 const slots=Array.isArray(doc.model.slots)?doc.model.slots:[];
 const slotEntry=slots.find(s=>isObject(s)&&s.name===slot) as Obj|undefined;
 if(!slotEntry||typeof slotEntry.bone!=='string')return {ok:false,code:`${WEIGHTS_NO_MESH} ${slot}: the model has no such slot`};
 const key=active??guessFree(doc.model,slot);
 if(!key)return {ok:false,code:`${WEIGHTS_NO_MESH} ${slot}: no mesh attachment`};
 let entry=attachmentOf(doc.model,key.skin,slot,key.attachment),source={skin:key.skin,slot,attachment:key.attachment};
 if(entry?.kind==='linkedmesh'){
  if(typeof entry.skin!=='string'||typeof entry.slot!=='string'||typeof entry.source!=='string')return {ok:false,code:`${WEIGHTS_MODEL_INVALID}: ${slot} / ${key.attachment} is a linked mesh without skin, slot and source`};
  source={skin:entry.skin,slot:entry.slot,attachment:entry.source};entry=attachmentOf(doc.model,source.skin,source.slot,source.attachment);
 }
 if(!entry||entry.kind!=='mesh')return {ok:false,code:`${WEIGHTS_NO_MESH} ${slot}: ${key.skin} / ${key.attachment} is not a mesh attachment`};
 const bones=new Set((Array.isArray(doc.model.bones)?doc.model.bones:[]).map(b=>isObject(b)&&typeof b.name==='string'?b.name:'').filter(Boolean));
 const v=entry.vertices,invalid=(why:string)=>({ok:false as const,code:`${WEIGHTS_MODEL_INVALID}: ${source.slot} / ${source.attachment} ${why}`});
 if(!isObject(v)||typeof v.weighted!=='boolean')return invalid('vertices are not { weighted, xy | bindings }');
 const vertices:WeightInfluence[][]=[];
 if(!v.weighted){
  if(!Array.isArray(v.xy)||v.xy.length%2||!v.xy.every(finite))return invalid('xy is not an even list of finite numbers');
  const bone=slotEntry.bone as string;
  for(let i=0;i<v.xy.length;i+=2)vertices.push([{bone,x:v.xy[i] as number,y:v.xy[i+1] as number,weight:1}]);
 }else{
  if(!Array.isArray(v.bindings))return invalid('bindings is not a list');
  for(const [i,influences]of v.bindings.entries()){
   if(!Array.isArray(influences)||!influences.length)return invalid(`bindings[${i}] is not a non-empty list`);
   const row:WeightInfluence[]=[];
   for(const b of influences){
    if(!isObject(b)||typeof b.bone!=='string'||!bones.has(b.bone)||!finite(b.x)||!finite(b.y)||!finite(b.weight))return invalid(`bindings[${i}] names an unknown bone or a non-finite x, y or weight`);
    row.push({bone:b.bone,x:b.x,y:b.y,weight:b.weight});
   }
   vertices.push(row);
  }
 }
 const triangles=entry.triangles;
 if(!Array.isArray(triangles)||triangles.length%3||!triangles.every(t=>Number.isSafeInteger(t)&&(t as number)>=0&&(t as number)<vertices.length))return invalid('triangles are not whole indices into its vertices');
 const order:string[]=[];for(const row of vertices)for(const i of row)if(!order.includes(i.bone))order.push(i.bone);
 return {ok:true,weights:{slot,skin:key.skin,attachment:key.attachment,source,weighted:v.weighted,vertices,bones:order,triangles:[...triangles] as number[]}};
}

/** `bone`'s stored weight on one vertex (0 when it does not influence it; a bone stored twice is summed). */
export function weightOf(influences:readonly Pick<WeightInfluence,'bone'|'weight'>[],bone:string):number {
 let found:number|null=null;for(const i of influences)if(i.bone===bone)found=found===null?i.weight:found+i.weight;return found??0;
}
/** The dominant influence of one vertex: the largest stored weight (the first stored on a tie). */
export function dominantInfluence<T extends Pick<WeightInfluence,'bone'|'weight'>>(influences:readonly T[]):T|null {
 let best:T|null=null;for(const i of influences)if(!best||i.weight>best.weight)best=i;return best;
}

/** `#rrggbb` (or `#rgb`) → [r, g, b]; null for anything else. */
export function parseHex(value:string):[number,number,number]|null {
 const m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());if(!m)return null;
 const h=m[1]!.length===3?[...m[1]!].map(c=>c+c).join(''):m[1]!;
 return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)) as [number,number,number];
}
/**
 * The ramp colour at `t` (clamped to 0..1) over evenly spaced stops (the theme's weight tokens, low → high), as
 * `rgb(r, g, b)`. A stop that is not a hex colour makes the ramp unavailable (null) rather than guessing one.
 */
export function rampColor(stops:readonly string[],t:number):string|null {
 const rgb=stops.map(parseHex);if(rgb.length<2||rgb.some(c=>!c)||!Number.isFinite(t))return null;
 const x=Math.max(0,Math.min(1,t))*(rgb.length-1),i=Math.min(rgb.length-2,Math.floor(x)),f=x-i,a=rgb[i]!,b=rgb[i+1]!;
 return `rgb(${[0,1,2].map(k=>Math.round(a[k]!+(b[k]!-a[k]!)*f)).join(', ')})`;
}
/** A stored weight as text: the number as stored, never rounded (an integer keeps one decimal). */
export const weightText=(w:number)=>Number.isInteger(w)?w.toFixed(1):String(w);
const rgbOf=(value:string):[number,number,number]|null=>{const hex=parseHex(value);if(hex)return hex;const m=/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value.trim());return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null;};
/** The mean of hex or `rgb()` colours as `rgb(r, g, b)`; null when one is neither. */
export function meanColor(colors:readonly string[]):string|null {
 const rgb=colors.map(rgbOf);if(!rgb.length||rgb.some(c=>!c))return null;
 return `rgb(${[0,1,2].map(k=>Math.round(rgb.reduce((n,c)=>n+c![k]!,0)/rgb.length)).join(', ')})`;
}

/** A bone's world transform as the published player reports it (`BoneWorld`'s x, y, a, b, c, d). */
export interface WorldTransform {x:number;y:number;a:number;b:number;c:number;d:number}
/**
 * One vertex's world position from its stored influences and the bones' world transforms: the published player's own
 * skinning formula (`worldVertices` in `@rig-c/play`: coordinates and weights through `Math.fround`, each influence
 * `(x·a + y·b + worldX, x·c + y·d + worldY) · weight`, summed; an unweighted vertex is its slot bone's transform at 1).
 */
export function skinVertex(influences:readonly WeightInfluence[],world:(bone:string)=>WorldTransform,weighted:boolean):{x:number;y:number} {
 let wx=0,wy=0;
 for(const i of influences){
  const t=world(i.bone),x=Math.fround(i.x),y=Math.fround(i.y),w=weighted?Math.fround(i.weight):1;
  wx+=(x*t.a+y*t.b+t.x)*w;wy+=(x*t.c+y*t.d+t.y)*w;
 }
 return {x:wx,y:wy};
}
