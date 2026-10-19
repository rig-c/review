/** Slot thumbnails cut from the actual page images by the region the compiled model declares for the drawn attachment.
 * Nothing is inferred from the art: an attachment without a declared, unrotated page region shows its type icon and a
 * named reason, and a whole page is never shown as a part. */
import type {ControlPartIdentity} from '../src/control.ts';
import type {PartEntry,PartThumbnailSource} from './part-selection.ts';

export interface PageRegion {page:string;name:string;x:number;y:number;width:number;height:number;degrees:number}
export interface PageRegionTable {pages:Map<string,{width:number;height:number}>;regions:Map<string,PageRegion[]>;absent:string|null}
/** The source rectangle on the page, as page UVs (the page spanning [0, 1]) and as page pixels derived from them. */
export interface ThumbnailCrop {kind:'crop';key:string;page:string;region:string;u0:number;v0:number;u1:number;v1:number;sx:number;sy:number;sw:number;sh:number}
export interface ThumbnailIcon {kind:'icon';key:string;reason:string}
export type ThumbnailPlan=ThumbnailCrop|ThumbnailIcon;
/** CSS box edge; the canvas backing store is twice that. */
export const thumbnailBox=24,thumbnailScale=2;

const record=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const finite=(v:unknown,min:number):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=min;
/** Reads `pages[].regions[]` of a `rigc-compiled/3` document. A malformed entry is dropped (its attachment shows the icon), never repaired. */
export function pageRegionTable(model:unknown):PageRegionTable {
 const pages=new Map<string,{width:number;height:number}>(),regions=new Map<string,PageRegion[]>(),list=record(model)?.pages;
 if(!Array.isArray(list))return {pages,regions,absent:'the model has no pages section'};
 for(const raw of list.slice(0,256)){
  const page=record(raw);if(!page||typeof page.name!=='string'||!finite(page.width,1)||!finite(page.height,1)||!Array.isArray(page.regions))continue;
  pages.set(page.name,{width:page.width,height:page.height});
  for(const value of page.regions.slice(0,100000)){const r=record(value);if(!r||typeof r.name!=='string'||!finite(r.x,0)||!finite(r.y,0)||!finite(r.width,1)||!finite(r.height,1))continue;const region:PageRegion={page:page.name,name:r.name,x:r.x,y:r.y,width:r.width,height:r.height,degrees:typeof r.degrees==='number'?r.degrees:0};regions.set(r.name,[...regions.get(r.name)??[],region]);}
 }
 return {pages,regions,absent:null};
}
/** What a row shows for the attachment the held public identity says is active. */
export function thumbnailPlan(table:PageRegionTable,entry:PartEntry,identity:ControlPartIdentity|null):ThumbnailPlan {
 if(!identity)return {kind:'icon',key:'',reason:'awaiting identity snapshot'};
 if(identity.reason!==null||identity.attachment===null||identity.skin===null)return {kind:'icon',key:'',reason:`no active attachment (${identity.reason??'none'})`};
 const key=JSON.stringify([identity.skin,identity.attachment]),declaration=entry.declarations.find(d=>d.skin===identity.skin&&d.attachment===identity.attachment);
 if(!declaration)return {kind:'icon',key,reason:`THUMBNAIL_UNDECLARED: ${identity.skin} / ${identity.attachment} is not in the catalog`};
 if(declaration.kind!=='region'&&declaration.kind!=='mesh')return {kind:'icon',key,reason:`${declaration.kind} attachment draws no page image`};
 if(table.absent)return {kind:'icon',key,reason:`THUMBNAIL_REGION_UNAVAILABLE: ${table.absent}`};
 const name=declaration.path??declaration.attachment,found=table.regions.get(name)??[];
 if(!found.length)return {kind:'icon',key,reason:`THUMBNAIL_NO_PAGE_REGION: the model declares no page region "${name}"`};
 if(found.length>1)return {kind:'icon',key,reason:`THUMBNAIL_AMBIGUOUS_REGION: ${found.length} page regions are named "${name}" (sequence frames)`};
 const region=found[0]!,page=table.pages.get(region.page)!;
 if(region.degrees!==0)return {kind:'icon',key,reason:`THUMBNAIL_ROTATED_REGION: "${name}" is packed at ${region.degrees}°`};
 if(region.x+region.width>page.width||region.y+region.height>page.height)return {kind:'icon',key,reason:`THUMBNAIL_REGION_OUTSIDE_PAGE: "${name}" exceeds ${region.page}`};
 const u0=region.x/page.width,v0=region.y/page.height,u1=(region.x+region.width)/page.width,v1=(region.y+region.height)/page.height;
 // Page pixels back from the UVs, rounded off float residue (a region edge sits on a whole or half texel).
 const px=(value:number)=>Math.round(value*1e6)/1e6;
 return {kind:'crop',key,page:region.page,region:name,u0,v0,u1,v1,sx:px(u0*page.width),sy:px(v0*page.height),sw:px((u1-u0)*page.width),sh:px((v1-v0)*page.height)};
}
/** Destination rectangle on the backing store: the crop fitted inside the box, aspect kept, centred. */
export function thumbnailFit(sw:number,sh:number,size=thumbnailBox*thumbnailScale):{dx:number;dy:number;dw:number;dh:number} {
 const scale=Math.min(size/sw,size/sh),dw=sw*scale,dh=sh*scale;return {dx:(size-dw)/2,dy:(size-dh)/2,dw,dh};
}
type PageImage=CanvasImageSource&{complete?:boolean;naturalWidth?:number};
/** Lazy (IntersectionObserver) drawing, one cached bitmap per attachment key. */
export class PartThumbnails implements PartThumbnailSource {
 private cache=new Map<string,HTMLCanvasElement>();private pending=new Map<Element,ThumbnailCrop>();private observer:IntersectionObserver|null=null;
 constructor(private table:PageRegionTable,private images:ReadonlyMap<string,PageImage>){
  if(typeof IntersectionObserver==='function')this.observer=new IntersectionObserver(items=>{for(const item of items)if(item.isIntersecting){const plan=this.pending.get(item.target);this.observer?.unobserve(item.target);this.pending.delete(item.target);if(plan)this.paint(item.target as HTMLCanvasElement,plan);}});
 }
 show(icon:HTMLElement,entry:PartEntry,identity:ControlPartIdentity|null,glyph:string):string {
  const plan=thumbnailPlan(this.table,entry,identity),image=plan.kind==='crop'?this.images.get(plan.page):undefined;
  const shown:ThumbnailPlan=plan.kind==='crop'&&!image?{kind:'icon',key:plan.key,reason:`THUMBNAIL_PAGE_UNAVAILABLE: page ${plan.page} is not loaded`}:plan;
  const stamp=JSON.stringify(shown);
  if(icon.dataset.thumbnailPlan!==stamp){
   icon.dataset.thumbnailPlan=stamp;for(const child of icon.querySelectorAll('canvas')){this.observer?.unobserve(child);this.pending.delete(child);}
   if(shown.kind==='crop'){const canvas=document.createElement('canvas');canvas.width=canvas.height=thumbnailBox*thumbnailScale;canvas.setAttribute('aria-hidden','true');icon.replaceChildren(canvas);icon.dataset.thumbnail='image';if(this.observer){this.pending.set(canvas,shown);this.observer.observe(canvas);}else this.paint(canvas,shown);}
   else{icon.textContent=glyph;icon.dataset.thumbnail='icon';}
  }
  return shown.kind==='crop'?`thumbnail: region ${shown.region} on ${shown.page}`:`type icon: ${shown.reason}`;
 }
 private paint(canvas:HTMLCanvasElement,plan:ThumbnailCrop):void {
  let source=this.cache.get(plan.key);
  if(!source){const image=this.images.get(plan.page);if(!image)return;source=document.createElement('canvas');source.width=source.height=thumbnailBox*thumbnailScale;const fit=thumbnailFit(plan.sw,plan.sh);source.getContext('2d')?.drawImage(image,plan.sx,plan.sy,plan.sw,plan.sh,fit.dx,fit.dy,fit.dw,fit.dh);this.cache.set(plan.key,source);}
  const context=canvas.getContext('2d');if(!context)return;context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(source,0,0);
 }
 dispose():void {this.observer?.disconnect();this.pending.clear();this.cache.clear();}
}
