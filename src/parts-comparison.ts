/** Visual comparison settings are evidence, never a producer verdict. Older comments omit them. */
export type PartsComparison = {mode:'part'|'overlay';opacity:number} | {mode:'difference';opacity:number;threshold:number};
export const defaultPartsComparison = ():PartsComparison => ({mode:'part',opacity:.5});
export function parsePartsComparison(raw:unknown):PartsComparison {
 const v=raw as PartsComparison;
 const keys=v?.mode==='difference'?['mode','opacity','threshold']:['mode','opacity'];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k))||!['part','overlay','difference'].includes(v.mode)||typeof v.opacity!=='number'||!Number.isFinite(v.opacity)||v.opacity<0||v.opacity>1||v.mode==='difference'&&(!Number.isInteger(v.threshold)||v.threshold<0||v.threshold>255))throw new Error('PARTS_COMPARISON_INVALID: part/overlay with opacity 0..1, or difference with integer threshold 0..255 required');
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

export interface DifferenceRaster {width:number;height:number;data:Uint8Array}
export interface DifferenceBox {x:number;y:number;w:number;h:number}
/** Exact native-cell pairing only. No placement rounding, filtering or alpha premultiplication. */
export function differencePixels(part:DifferenceRaster,box:DifferenceBox,painting:DifferenceRaster,fronts:readonly {box:DifferenceBox;raster:DifferenceRaster}[],threshold:number,excludeCovered:boolean) {
 if(!Number.isInteger(threshold)||threshold<0||threshold>255)throw new Error('PARTS_COMPARISON_INVALID: integer threshold 0..255 required');
 const valid=(b:DifferenceBox,r:DifferenceRaster)=>[b.x,b.y,b.w,b.h].every(Number.isSafeInteger)&&b.w===r.width&&b.h===r.height&&r.data.length===r.width*r.height*4;
 if(!valid(box,part)||(excludeCovered&&fronts.some(f=>!valid(f.box,f.raster))))throw new Error('PARTS_DIFFERENCE_ALIGNMENT: integer native placement and exact PNG dimensions required');
 const rgba=new Uint8Array(part.width*part.height*4);let count=0,covered=0,compared=0;
 for(let y=0;y<part.height;y++)for(let x=0;x<part.width;x++){
  const i=(y*part.width+x)*4;if(!part.data[i+3])continue;
  const gx=box.x+x,gy=box.y+y;
  if(gx<0||gy<0||gx>=painting.width||gy>=painting.height)throw new Error('PARTS_DIFFERENCE_ALIGNMENT: nontransparent part pixel lies outside declared rig grid');
  if(excludeCovered&&fronts.some(f=>{const fx=gx-f.box.x,fy=gy-f.box.y;return fx>=0&&fy>=0&&fx<f.raster.width&&fy<f.raster.height&&f.raster.data[(fy*f.raster.width+fx)*4+3]!>0;})){
   rgba.set([128,128,128,255],i);covered++;continue;
  }
  const j=(gy*painting.width+gx)*4,d=Math.max(...[0,1,2].map(c=>Math.abs(part.data[i+c]!-painting.data[j+c]!)));
  compared++;if(d>threshold)count++;
  rgba.set([d>threshold?d:0,0,0,255],i);
 }
 return {width:part.width,height:part.height,data:rgba,count,covered,compared};
}
