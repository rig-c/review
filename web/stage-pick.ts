/**
 * Stage part picking (#330). A click on the rig view and the hover preview of what that click would select
 * both resolve through `pickAt` below — one gate, one hit test, one selectable filter. There is no second picker.
 */
import type {PosedFrame} from '@rig-c/play';

export type StageProject=(x:number,y:number)=>{x:number;y:number};

/** All picking reads the last drawn primitives, including their resolved clip; never a setup bounding box. */
export function pickedSlot(frame:PosedFrame,x:number,y:number):string|null {
 const inside=(p:readonly number[])=>{let hit=false;for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){const ax=p[i]!,ay=p[i+1]!,bx=p[j]!,by=p[j+1]!;if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)hit=!hit;}return hit;};
 for(const row of [...frame.order].reverse()){
  if(row.clip&&inside(row.clip.polygon)===row.clip.inverse)continue;
  if(row.kind==='region'&&inside(row.corners))return row.slot;
  if(row.kind==='mesh')for(let i=0;i<row.triangles.length;i+=3){const p=row.triangles.slice(i,i+3).flatMap(v=>[row.vertices[v*2]!,row.vertices[v*2+1]!]);if(inside(p))return row.slot;}
 }return null;
}

/** A client point to rig world through the same projection the stage draws with (stage-local CSS px). */
export function stageWorld(rect:{left:number;top:number},project:StageProject,clientX:number,clientY:number):{x:number;y:number} {
 const p0=project(0,0),px=project(1,0),py=project(0,1);
 return {x:(clientX-rect.left-p0.x)/(px.x-p0.x),y:(clientY-rect.top-p0.y)/(py.y-p0.y)};
}

/** The hover preview, in stage-local CSS px: the part's drawn primitives as a tint and their outer edges as an outline. */
export interface HoverPreview {slot:string;tint:string;outline:string;label:{x:number;y:number}}

const tenth=(v:number)=>Math.round(v*10)/10;

/** Builds the preview of `slot` from the same held frame the hit test read. Null when the slot draws nothing. */
export function hoverPreview(frame:PosedFrame,slot:string,project:StageProject,at:{x:number;y:number}):HoverPreview|null {
 const tint:string[]=[],outline:string[]=[];
 const screen=(x:number,y:number)=>{const p=project(x,y);return Number.isFinite(p.x)&&Number.isFinite(p.y)?{x:tenth(p.x),y:tenth(p.y)}:null;};
 const polygon=(points:{x:number;y:number}[])=>{
  // One orientation for every polygon, so overlapping triangles of one path fill as a union under nonzero.
  const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length]!;return sum+p.x*q.y-q.x*p.y;},0);
  const ordered=area<0?[...points].reverse():points;
  return 'M'+ordered.map(p=>`${p.x} ${p.y}`).join('L')+'Z';
 };
 for(const row of frame.order){
  if(row.slot!==slot)continue;
  if(row.kind==='region'){
   const points:{x:number;y:number}[]=[];for(let i=0;i+1<row.corners.length;i+=2){const p=screen(row.corners[i]!,row.corners[i+1]!);if(p)points.push(p);}
   if(points.length*2!==row.corners.length||points.length<3)continue;
   const d=polygon(points);tint.push(d);outline.push(d);continue;
  }
  const edges=new Map<string,{a:{x:number;y:number};b:{x:number;y:number};count:number}>();
  for(let i=0;i+2<row.triangles.length;i+=3){
   const ids=row.triangles.slice(i,i+3),points=ids.map(v=>screen(row.vertices[v*2]!,row.vertices[v*2+1]!));
   if(points.some(p=>!p))continue;
   tint.push(polygon(points as {x:number;y:number}[]));
   for(let e=0;e<3;e++){const a=ids[e]!,b=ids[(e+1)%3]!,key=a<b?`${a}:${b}`:`${b}:${a}`,seen=edges.get(key);if(seen)seen.count++;else edges.set(key,{a:points[e]!,b:points[(e+1)%3]!,count:1});}
  }
  // An edge shared by two triangles is interior; the outline is the edges only one triangle uses.
  for(const {a,b,count} of edges.values())if(count===1)outline.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
 }
 return tint.length?{slot,tint:tint.join(''),outline:outline.join(''),label:{x:tenth(at.x),y:tenth(at.y)}}:null;
}

export interface StagePickOptions {
 stage:HTMLElement;
 project:StageProject;
 frame:()=>PosedFrame|null;
 enabled:()=>boolean;
 /** Space is held: the gesture is a pan, so neither a click nor a hover picks. */
 held:()=>boolean;
 selectable:(slot:string)=>boolean;
 select:(slot:string)=>void;
 paint:(preview:HoverPreview|null)=>void;
}
export interface StagePick {
 /** The one hit test: the click and the hover preview both call it. */
 pickAt(clientX:number,clientY:number,target:EventTarget|null):string|null;
 hovered():string|null;
 /** Re-reads the held frame at the last pointer position; paints only when the preview changed. */
 refresh():void;
 reset():void;
 dispose():void;
}

/**
 * The click/drag line, in client px (#331): a press that never travels more than this from where it went down is a click
 * and may select; one that does is a drag, which pans and carries the rig (`bindPan`'s carry reads the same constant).
 */
export const CLICK_SLOP_PX=3;
const CONTROL='button,input,select,textarea';
/** A stage tool that takes the press before it reaches the stage: comment mode, an editor handle under the pointer, a pan in progress. */
const OWNER='[data-chest-hover],[data-mesh-mode],[data-mesh-hover],[data-bones-hover],[data-cuts-hover],.stage-comment-mode,[data-panning]';
const closest=(target:EventTarget|null|undefined,selector:string)=>{const node=target as {closest?:(s:string)=>Element|null}|null|undefined;return typeof node?.closest==='function'?node.closest(selector):null;};

export function bindStagePick(o:StagePickOptions):StagePick {
 const {stage}=o;
 let down:{x:number;y:number;far:boolean}|null=null,pressed=false,last:{x:number;y:number;target:EventTarget|null;buttons:number}|null=null,painted='',hover:string|null=null;
 const pickAt=(clientX:number,clientY:number,target:EventTarget|null):string|null=>{
  if(o.held()||!o.enabled()||closest(target,CONTROL))return null;
  const frame=o.frame();if(!frame)return null;
  const at=stageWorld(stage.getBoundingClientRect(),o.project,clientX,clientY),slot=pickedSlot(frame,at.x,at.y);
  return slot&&o.selectable(slot)?slot:null;
 };
 const update=()=>{
  const point=last&&!pressed&&!last.buttons&&!closest(stage,OWNER)?last:null;
  const slot=point?pickAt(point.x,point.y,point.target):null,frame=slot?o.frame():null;
  let preview:HoverPreview|null=null;
  if(slot&&frame&&point){const rect=stage.getBoundingClientRect();preview=hoverPreview(frame,slot,o.project,{x:point.x-rect.left,y:point.y-rect.top});}
  const key=preview?JSON.stringify(preview):'';
  if(key===painted)return;
  painted=key;hover=preview?.slot??null;
  if(hover)stage.dataset.hoverName=hover;else delete stage.dataset.hoverName;
  o.paint(preview);
 };
 const pointer=(e:PointerEvent)=>{last=e.pointerType==='mouse'?{x:e.clientX,y:e.clientY,target:e.target,buttons:e.buttons}:null;};
 const start=(e:PointerEvent)=>{down=e.isPrimary&&e.button===0?{x:e.clientX,y:e.clientY,far:false}:null;pressed=true;update();};
 const end=(e:PointerEvent)=>{
  const from=down;down=null;pressed=false;
  if(from&&!from.far&&Math.hypot(e.clientX-from.x,e.clientY-from.y)<=CLICK_SLOP_PX){const slot=pickAt(e.clientX,e.clientY,e.target);if(slot)o.select(slot);}
  pointer(e);if(last)last.buttons=0;update();
 };
 // A press that went past the line is a drag even if it comes back: one line, read over the whole gesture.
 const move=(e:PointerEvent)=>{if(down&&!down.far&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>CLICK_SLOP_PX)down.far=true;pointer(e);update();};
 const leave=()=>{last=null;update();};
 const cancel=()=>{down=null;pressed=false;last=null;update();};
 stage.addEventListener('pointerdown',start);stage.addEventListener('pointerup',end);stage.addEventListener('pointermove',move);
 stage.addEventListener('pointerleave',leave);stage.addEventListener('pointercancel',cancel);
 return {
  pickAt,hovered:()=>hover,refresh:update,reset:cancel,
  dispose:()=>{stage.removeEventListener('pointerdown',start);stage.removeEventListener('pointerup',end);stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerleave',leave);stage.removeEventListener('pointercancel',cancel);last=null;update();},
 };
}

const SVG='http://www.w3.org/2000/svg';
/** Paints a preview into `layer` (the stage's pick layer): an SVG tint and two-tone outline, and the slot name beside the pointer. */
export function domHoverPainter(layer:HTMLElement):(preview:HoverPreview|null)=>void {
 let svg:SVGSVGElement|null=null,tint:SVGPathElement|null=null,halo:SVGPathElement|null=null,line:SVGPathElement|null=null,label:HTMLElement|null=null;
 return preview=>{
  if(!preview){svg?.setAttribute('hidden','');if(label)label.hidden=true;return;}
  if(!svg||!svg.isConnected){
   const doc=layer.ownerDocument;
   svg=doc.createElementNS(SVG,'svg');svg.setAttribute('class','stage-hover-pick');svg.setAttribute('aria-hidden','true');
   const path=(cls:string)=>{const node=doc.createElementNS(SVG,'path');node.setAttribute('class',cls);return node;};
   tint=path('stage-hover-tint');halo=path('stage-hover-halo');line=path('stage-hover-line');svg.append(tint,halo,line);
   label=doc.createElement('span');label.className='stage-hover-label';label.setAttribute('aria-hidden','true');
   layer.prepend(svg);layer.append(label);
  }
  svg.removeAttribute('hidden');tint!.setAttribute('d',preview.tint);halo!.setAttribute('d',preview.outline);line!.setAttribute('d',preview.outline);
  label!.hidden=false;label!.textContent=preview.slot;
  const width=label!.offsetWidth,height=label!.offsetHeight,room=layer.clientWidth,floor=layer.clientHeight;
  const x=preview.label.x+14+width>room?preview.label.x-14-width:preview.label.x+14,y=preview.label.y+16+height>floor?preview.label.y-10-height:preview.label.y+16;
  label!.style.left=`${Math.max(0,x)}px`;label!.style.top=`${Math.max(0,y)}px`;
 };
}
