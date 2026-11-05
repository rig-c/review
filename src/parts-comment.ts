/** Closed parts evidence. No synthetic model, frame, slot or package identity. */
import type {MarkRegion} from './stage-comment.ts';
export interface PartsCrop {path:string;sha256:string;width:number;height:number}
export interface PartsComment {
 schema:'rig-review-parts-comment/1';id:string;summary:string;part:string;imageHash:string;sourceHash:string;
 imageRegion:MarkRegion;rigRegion:MarkRegion;
 view:{camera:{zoom:number;center:{x:number;y:number};viewport:{width:number;height:number}};cameraSync:boolean;referenceCamera:{zoom:number;center:{x:number;y:number};viewport:{width:number;height:number}}|null;background:string;alpha:boolean;footprints:boolean;mesh:boolean};
 crop:PartsCrop&{png:string};nativeCrop:PartsCrop|null;
}
const fail=(code:string,why:string):never=>{throw new Error(code+': '+why);};
const obj=(v:unknown):Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:fail('PARTS_COMMENT_INVALID','object required');
const exact=(v:Record<string,any>,keys:string[])=>{if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail('PARTS_COMMENT_INVALID','unknown or missing fields');};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function parsePartsComment(raw:unknown,prepared=true):PartsComment {
 const v=obj(raw);exact(v,['schema','id','summary','part','imageHash','sourceHash','imageRegion','rigRegion','view','crop','nativeCrop']);
 if(v.schema!=='rig-review-parts-comment/1'||typeof v.id!=='string'||!v.id||v.id.length>128||typeof v.summary!=='string'||!v.summary.trim()||v.summary.length>1000||typeof v.part!=='string'||!v.part||v.part.length>512||!hash(v.imageHash)||!hash(v.sourceHash))fail('PARTS_COMMENT_INVALID','schema, text or source binding');
 for(const key of ['imageRegion','rigRegion']){const r=obj(v[key]);exact(r,['x','y','width','height']);if(!Object.values(r).every(finite))fail('PARTS_COMMENT_INVALID','finite region required');if(key==='imageRegion'&&!Object.values(r).every(Number.isSafeInteger))fail('PARTS_COMMENT_FRACTIONAL','image coordinates must be integer pixels');if(r.width<=0||r.height<=0)fail('PARTS_COMMENT_EMPTY','positive region required');}
 const view=obj(v.view);exact(view,['camera','cameraSync','referenceCamera','background','alpha','footprints','mesh']);if(!['green','magenta','black','white','checker'].includes(view.background)||![view.alpha,view.footprints,view.mesh,view.cameraSync].every(n=>typeof n==='boolean'))fail('PARTS_COMMENT_INVALID','view state');
 for(const rawCamera of [view.camera,...(view.referenceCamera===null?[]:[view.referenceCamera])]){const c=obj(rawCamera);exact(c,['zoom','center','viewport']);exact(obj(c.center),['x','y']);exact(obj(c.viewport),['width','height']);if(!finite(c.zoom)||c.zoom<=0||c.zoom>16||!Object.values(c.center).every(finite)||!Object.values(c.viewport).every(n=>finite(n)&&n>0&&n<=65536))fail('PARTS_CAMERA_RANGE','native scale or camera extent');}
 for(const [crop,inline]of [[v.crop,true],[v.nativeCrop,false]] as const){if(crop===null&&!inline&&!prepared)continue;const p=obj(crop);exact(p,['path','sha256','width','height',...(inline?['png']:[])]);if(!hash(p.sha256)||p.path!==`comment-crops/${p.sha256}.png`||![p.width,p.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=16384)||inline&&(typeof p.png!=='string'||p.png.length>200000||p.width>1024||p.height>1024))fail('PARTS_COMMENT_CROP_INVALID','bounded content-addressed crop');}
 return v as PartsComment;
}
/** Drag edges snap outward to whole native pixels. OOB is refused by the binding check, never clipped. */
export function snapImageRegion(r:MarkRegion):MarkRegion {if(r.width<=0||r.height<=0)return {x:Math.floor(r.x),y:Math.floor(r.y),width:0,height:0};const x=Math.floor(r.x),y=Math.floor(r.y);return {x,y,width:Math.ceil(r.x+r.width)-x,height:Math.ceil(r.y+r.height)-y};}
export function assertPartsCommentBinding(c:PartsComment,item:{name:string;x:number;y:number;w:number;h:number},imageHash:string,sourceHash:string):void {
 if(c.part!==item.name)fail('PARTS_COMMENT_PART_MISMATCH','comment belongs to another part');
 if(c.imageHash!==imageHash||c.sourceHash!==sourceHash)fail('PARTS_COMMENT_STALE_SOURCE','original image or package source hash differs');
 const camera=c.view.camera,fit=Math.max(.001,Math.min((camera.viewport.width-24)/item.w,(camera.viewport.height-24)/item.h));if(camera.zoom<Math.min(fit,1))fail('PARTS_CAMERA_RANGE','native zoom below fit/1 minimum');
 const r=c.imageRegion;if(r.x<0||r.y<0||r.x+r.width>item.w||r.y+r.height>item.h)fail('PARTS_COMMENT_OUT_OF_BOUNDS','region exceeds original image');
 if(c.rigRegion.x!==item.x+r.x||c.rigRegion.y!==item.y+r.y||c.rigRegion.width!==r.width||c.rigRegion.height!==r.height)fail('PARTS_COMMENT_RIG_REGION','rig region must be exact placement plus image region');
}
