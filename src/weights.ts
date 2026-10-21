/**
 * Setup-space mesh weights (#107), read from the compiled model document as stored. Watch-only: nothing here edits,
 * normalises or infers a weight. The reader itself is shared with Edit Mesh (#100): `src/setup-mesh.ts`.
 */
import {readStoredSetupMesh,setupModel,type SetupMeshCodes,type WeightInfluence} from './setup-mesh.ts';
export const WEIGHTS_MODEL_UNAVAILABLE='WEIGHTS_MODEL_UNAVAILABLE';
export const WEIGHTS_SELECT_SLOT='WEIGHTS_SELECT_SLOT';
export const WEIGHTS_NO_MESH='WEIGHTS_NO_MESH';
export const WEIGHTS_MODEL_INVALID='WEIGHTS_MODEL_INVALID';

export type {WeightInfluence} from './setup-mesh.ts';
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

/** The weights block's refusals over the shared setup-space reader (`src/setup-mesh.ts`). */
export const WEIGHTS_CODES:SetupMeshCodes=Object.freeze({unavailable:WEIGHTS_MODEL_UNAVAILABLE,select:WEIGHTS_SELECT_SLOT,noMesh:WEIGHTS_NO_MESH,invalid:WEIGHTS_MODEL_INVALID,subject:'weights are',selectText:'select one mesh slot in the parts list'});

/** The compiled model document, or the refusal that names why there is none (bar 2: a package without one). */
export const weightsModel=(model:unknown)=>setupModel(model,WEIGHTS_CODES);

/**
 * The setup-pose weights of `slot`'s mesh attachment `active` (the identity the setup pose resolved; null preserves its
 * absence as reported by the public setup identity). Weights are returned exactly as stored.
 */
export function meshWeights(model:unknown,slot:string|null,active:{skin:string;attachment:string}|null):WeightsResult {
 const read=readStoredSetupMesh(model,slot,active,WEIGHTS_CODES);if(!read.ok)return read;
 const {slot:s,skin,attachment,source,weighted,vertices,bones,triangles}=read.mesh;
 return {ok:true,weights:{slot:s,skin,attachment,source,weighted,vertices,bones,triangles}};
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
