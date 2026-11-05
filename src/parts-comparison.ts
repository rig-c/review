/** Visual comparison settings are evidence, never a producer verdict. Older comments omit them. */
export interface PartsComparison {mode:'part'|'overlay';opacity:number}
export const defaultPartsComparison = ():PartsComparison => ({mode:'part',opacity:.5});
export function parsePartsComparison(raw:unknown):PartsComparison {
 const v=raw as PartsComparison;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==2||!['mode','opacity'].every(k=>Object.hasOwn(v,k))||!['part','overlay'].includes(v.mode)||typeof v.opacity!=='number'||!Number.isFinite(v.opacity)||v.opacity<0||v.opacity>1)throw new Error('PARTS_COMPARISON_INVALID: part/overlay mode and opacity 0..1 required');
 return v;
}
export interface PaintingRectangle {x:number;y:number;width:number;height:number}
/** Whole-canvas geometry of parts@2.17.0 sourceInRig: trunc(source size * declared scale).
 * This validates original input dimensions, not equality with the producer's resampled pixels. */
export function assertOriginalPaintingSize(width:number,height:number,rigSize:readonly number[]|null,scale:unknown):void {
 if(typeof scale!=='number'||!Number.isFinite(scale)||scale<=0||!rigSize||!rigSize.every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('PARTS_PAINTING_MAPPING: declared rig_size and positive scale_rig_per_source required');
 if(Math.trunc(width*scale)!==rigSize[0]||Math.trunc(height*scale)!==rigSize[1])throw new Error('PARTS_PAINTING_SIZE: original painting dimensions times declared scale must match the rig canvas');
}
/** Exact continuous source rectangle for a visual comparison. No pixel pairing, rounding or producer resampler. */
export function paintingRectangle(item:{x:number;y:number;w:number;h:number},rigSize:readonly number[],painting:{width:number;height:number}):PaintingRectangle {
 const x=painting.width/rigSize[0]!,y=painting.height/rigSize[1]!;
 return {x:item.x*x,y:item.y*y,width:item.w*x,height:item.h*y};
}
