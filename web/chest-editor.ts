/**
 * The chest-region editor (Setup): a view-bar toggle, an editor bar of R / L circles and direct manipulation of the
 * circles on the rig pane. The values live in the Chest regions detail block's fields (row 0 = R, row 1 = L), so the
 * draft, export and binding are the detail block's. Review builds no mesh itself: Apply · Rebuild hands the rows to the
 * host, which sends them to the installed producer (#99); this module never reaches a process or the server.
 */
import {clampNonOverlapping,CHEST_CIRCLE_LIMITS,type ChestCircle,type CropWorldMapping} from '../src/chest-regions.ts';
import {chestRowId,type ChestFieldReader} from './chest-regions-tool.ts';
import {projectCircle,type OverlayPoint,type OverlayProject} from './rig-overlays.ts';
import {textEntryFocused} from './view-controls.ts';

export type BustSide='r'|'l';
export type BustMode='move'|'r'|'band';
export const bustSides=[{side:'r',row:0,tag:'R'},{side:'l',row:1,tag:'L'}] as const;
export const bustFields=['x','y','r','band'] as const;
export const bustInputId=(side:BustSide,field:typeof bustFields[number])=>`bust-${side}-${field}`;
export const CHEST_REGIONS_CLAMPED='CHEST_REGIONS_CLAMPED';
const sideRow=(side:BustSide)=>side==='r'?0:1;
const sideTag=(side:BustSide)=>side==='r'?'R':'L';

/** The toggle belongs to Setup only. */
export function chestEditVisible(inspector:string|undefined):boolean {return inspector==='rig';}

const number=(read:ChestFieldReader,id:string)=>{const raw=(read(id)?.value??'').trim();if(!raw)return null;const value=Number(raw);return Number.isFinite(value)?value:null;};
/** A row is a circle when its semi-axes are equal and it has no medial clip; then r is that semi-axis. */
export function rowCircle(read:ChestFieldReader,row:number):ChestCircle|null {
 const cx=number(read,chestRowId(row,'cx')),cy=number(read,chestRowId(row,'cy')),ax=number(read,chestRowId(row,'ax')),ay=number(read,chestRowId(row,'ay')),band=number(read,chestRowId(row,'band'));
 if(cx===null||cy===null||ax===null||band===null||ax<=0||ay!==ax||(read(chestRowId(row,'clip'))?.value??'').trim())return null;
 return {cx,cy,r:ax,band};
}
/** Field values that store a circle in a detail row: r writes both semi-axes. */
export function circleFields(row:number,circle:Partial<ChestCircle>):Record<string,string> {
 const out:Record<string,string>={};
 if(circle.cx!==undefined)out[chestRowId(row,'cx')]=String(circle.cx);
 if(circle.cy!==undefined)out[chestRowId(row,'cy')]=String(circle.cy);
 if(circle.r!==undefined){out[chestRowId(row,'ax')]=String(circle.r);out[chestRowId(row,'ay')]=String(circle.r);}
 if(circle.band!==undefined)out[chestRowId(row,'band')]=String(circle.band);
 return out;
}
export const bustLabel=(side:BustSide,c:ChestCircle)=>`${sideTag(side)} (${Math.round(c.cx)},${Math.round(c.cy)}) r:${Math.round(c.r)} b:${Math.round(c.band)}`;

export interface ProjectedBust {side:BustSide;center:OverlayPoint;pxR:number;pxBand:number}
/** The example's hit order: core handle or core edge → r, band handle or outer edge → band, inside the core → move. */
export function hitBustHandle(circles:readonly ProjectedBust[],p:OverlayPoint):{side:BustSide;mode:BustMode}|null {
 for(const c of circles){
  const toR=Math.hypot(p.x-(c.center.x+c.pxR),p.y-c.center.y),toBand=Math.hypot(p.x-c.center.x,p.y-(c.center.y-c.pxBand)),toCenter=Math.hypot(p.x-c.center.x,p.y-c.center.y);
  if(toR<=10||Math.abs(toCenter-c.pxR)<=6)return {side:c.side,mode:'r'};
  if(toBand<=10||Math.abs(toCenter-c.pxBand)<=6)return {side:c.side,mode:'band'};
  if(toCenter<=Math.max(12,c.pxR))return {side:c.side,mode:'move'};
 }
 return null;
}
const limit=(value:number,[low,high]:readonly [number,number])=>Math.max(low,Math.min(high,value));
export interface BustDrag {side:BustSide;mode:BustMode;start:OverlayPoint;centre:OverlayPoint;from:ChestCircle}
/** Pointer (canvas px) → source px through the camera scale (canvas px per source px), rounded as the example does. */
export function dragBust(drag:BustDrag,p:OverlayPoint,scale:number):ChestCircle {
 const from=drag.from;if(!(scale>0)||!Number.isFinite(scale))return {...from};
 if(drag.mode==='move')return {...from,cx:Math.round(from.cx+(p.x-drag.start.x)/scale),cy:Math.round(from.cy+(p.y-drag.start.y)/scale)};
 const distance=Math.hypot(p.x-drag.centre.x,p.y-drag.centre.y)/scale;
 if(drag.mode==='r')return {...from,r:limit(Math.round(distance),CHEST_CIRCLE_LIMITS.r)};
 return {...from,band:limit(Math.round(distance-from.r),CHEST_CIRCLE_LIMITS.band)};
}
/** Mirror: L takes R's y, core radius and band; L keeps its own x. */
export const mirrorBust=(right:ChestCircle,left:Pick<ChestCircle,'cx'>):ChestCircle=>({cx:left.cx,cy:right.cy,r:right.r,band:right.band});
const same=(a:ChestCircle,b:ChestCircle)=>a.cx===b.cx&&a.cy===b.cy&&a.r===b.r&&a.band===b.band;
/** Live non-overlap clamp for a pair of circles; names the sides it changed. */
export function settleBust(right:ChestCircle,left:ChestCircle):{right:ChestCircle;left:ChestCircle;clamped:BustSide[]} {
 const out=clampNonOverlapping(right,left),round=clampNonOverlapping(right,left,-Infinity);
 // `round` is the same integer/range pass without the distance rule (−∞ margin leaves every pair fitting), so only the non-overlap change flashes.
 return {right:out.right,left:out.left,clamped:(['r','l'] as const).filter(side=>!same(side==='r'?out.right:out.left,side==='r'?round.right:round.left))};
}
/** The editor-bar status: a held rebuild notice (its latest line, or the producer's refusal verbatim) wins over the drag help. */
export function editorStatus(notice:{text:string;error:boolean}|null,mapping:CropWorldMapping):{text:string;error:boolean} {
 if(notice)return notice;
 return mapping.available?{text:'Drag a centre to move · the right-edge handle sets r · the dashed top handle sets band · Space-drag pans',error:false}:{text:`${mapping.reason} — the values still edit and export; nothing is drawn on the stage.`,error:true};
}

export interface ChestEditorHost {
 /** Receives capture-phase pointer events before the viewport's pan. */
 pane:HTMLElement;
 /** The overlay canvas: pointer coordinates are local to it, as the projection's are. */
 canvas:HTMLElement;
 project:()=>OverlayProject|null;
 mapping:()=>CropWorldMapping;
 /** Re-render the detail block and the overlay after a value changed. */
 changed:()=>void;
 download:()=>void;
 /** Apply · Rebuild: the host runs the installed producer on the current rows and reloads the stage. */
 apply:()=>void;
 /** Reset: the host reloads the inspected build. */
 reset:()=>void;
 message:(text:string,error?:boolean)=>void;
 inspector:()=>string|undefined;
}
export interface ChestEditor {active:()=>boolean;flashing:(side:BustSide)=>boolean;sync:()=>void;dispose:()=>void;
 /** Hold a status line (null clears it); `log` is the producer's latest lines. */
 notify:(text:string|null,error?:boolean,log?:readonly string[])=>void;
 /** Apply is disabled while a rebuild runs; Reset is enabled while a rebuilt build is on the stage. */
 rebuildState:(state:{busy:boolean;applied:boolean})=>void}

export function bindChestEditor(host:ChestEditorHost):ChestEditor {
 const node=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
 const toggle=node<HTMLButtonElement>('chest-edit'),bar=node<HTMLElement>('chest-editor-bar'),status=node<HTMLElement>('chest-editor-status');
 const field=(id:string)=>document.getElementById(id) as HTMLInputElement|null;
 const read:ChestFieldReader=id=>{const f=field(id);return f?{value:f.value}:undefined;};
 const log=node<HTMLElement>('chest-editor-log'),apply=node<HTMLButtonElement>('bust-apply'),reset=node<HTMLButtonElement>('bust-reset');
 let notice:{text:string;error:boolean}|null=null;
 let active=false,space=false,drag:(BustDrag&{pointer:number;other:ChestCircle|null})|null=null,flashTimer:ReturnType<typeof setTimeout>|null=null;
 const flash=new Set<BustSide>();
 const write=(row:number,circle:Partial<ChestCircle>)=>{for(const [id,value] of Object.entries(circleFields(row,circle))){const f=field(id);if(f)f.value=value;}};
 const flashSides=(sides:readonly BustSide[])=>{
  if(!sides.length)return;for(const side of sides)flash.add(side);
  host.message(`${CHEST_REGIONS_CLAMPED}: ${sides.map(sideTag).join(' and ')} — both cores plus 8 px must fit the centre distance minus 2 px and the bands share the rest`,true);
  if(flashTimer)clearTimeout(flashTimer);flashTimer=setTimeout(()=>{flash.clear();flashTimer=null;host.changed();},700);
 };
 /** Writes a changed side; when both rows are circles the pair is clamped as the rebuild script would. */
 const commit=(side:BustSide,next:ChestCircle,other:ChestCircle|null)=>{
  if(!other){write(sideRow(side),next);return;}
  const [right,left]=side==='r'?[next,other]:[other,next],settled=settleBust(right,left);
  write(0,settled.right);write(1,settled.left);flashSides(settled.clamped);
 };
 const projected=():ProjectedBust[]=>{
  const project=host.project(),mapping=host.mapping();if(!project||!mapping.available)return [];
  return bustSides.flatMap(({side,row})=>{const c=rowCircle(read,row);if(!c)return [];const at=projectCircle(project,{center:mapping.toWorld(c.cx,c.cy),r:c.r,band:c.band});return at?[{side,...at}]:[];});
 };
 const local=(event:PointerEvent):OverlayPoint=>{const rect=host.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const scale=()=>{const project=host.project();if(!project)return 0;const a=project(0,0),b=project(1,0);return Math.hypot(b.x-a.x,b.y-a.y);};
 const sync=()=>{
  const visible=chestEditVisible(host.inspector());toggle.hidden=!visible;
  if(!visible&&active)setActive(false);
  for(const {side,row} of bustSides){
   const circle=rowCircle(read,row),values={x:read(chestRowId(row,'cx'))?.value??'',y:read(chestRowId(row,'cy'))?.value??'',r:circle?String(circle.r):'',band:read(chestRowId(row,'band'))?.value??''};
   for(const f of bustFields){const input=field(bustInputId(side,f));if(input&&document.activeElement!==input)input.value=values[f];}
   const r=field(bustInputId(side,'r'));if(r)r.placeholder=circle||!(read(chestRowId(row,'ax'))?.value??'').trim()?'':'ellipse';
  }
  const shown=editorStatus(notice,host.mapping());
  status.textContent=shown.text;status.title=shown.text;status.classList.toggle('error',shown.error);
 };
 const setActive=(on:boolean)=>{active=on;toggle.setAttribute('aria-pressed',String(on));bar.hidden=!on;if(!on){drag=null;delete host.pane.dataset.chestHover;}sync();host.changed();};
 toggle.addEventListener('click',()=>setActive(!active));
 bar.addEventListener('input',event=>{
  const target=event.target as HTMLInputElement,match=/^bust-([rl])-(x|y|r|band)$/.exec(target.id);if(!match)return;
  const value=Number(target.value);if(!target.value.trim()||!Number.isFinite(value))return;
  const side=match[1] as BustSide,key=({x:'cx',y:'cy',r:'r',band:'band'} as const)[match[2] as typeof bustFields[number]];
  write(sideRow(side),{[key]:value});host.changed();
 });
 bar.addEventListener('change',event=>{
  const target=event.target as HTMLInputElement,match=/^bust-([rl])-/.exec(target.id);if(!match)return;
  const side=match[1] as BustSide,mine=rowCircle(read,sideRow(side)),other=rowCircle(read,sideRow(side==='r'?'l':'r'));
  if(mine)commit(side,{...mine,r:limit(Math.round(mine.r),CHEST_CIRCLE_LIMITS.r),band:limit(Math.round(mine.band),CHEST_CIRCLE_LIMITS.band)},other);
  sync();host.changed();
 });
 node<HTMLButtonElement>('bust-mirror').addEventListener('click',()=>{
  const right=rowCircle(read,0),leftX=Number((read(chestRowId(1,'cx'))?.value??'').trim()||NaN);
  if(!right||!Number.isFinite(leftX)){host.message('Mirror needs a complete R circle and an L x.',true);return;}
  commit('l',mirrorBust(right,{cx:leftX}),right);sync();host.changed();
 });
 node<HTMLButtonElement>('bust-download').addEventListener('click',()=>host.download());
 apply.addEventListener('click',()=>host.apply());
 reset.addEventListener('click',()=>host.reset());
 const keyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&!textEntryFocused(event.target))space=true;};
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')space=false;};
 const blur=()=>{space=false;};
 const down=(event:PointerEvent)=>{
  if(!active||space||!event.isPrimary||event.button!==0)return;
  const target=event.target;if(target instanceof Element&&target.closest('button,input,select,textarea,a'))return;
  const p=local(event),circles=projected(),hit=hitBustHandle(circles,p);if(!hit)return;
  const row=sideRow(hit.side),from=rowCircle(read,row),at=circles.find(c=>c.side===hit.side);if(!from||!at)return;
  // A handle drag edits values; it never reaches the viewport's pan and never moves the camera.
  event.stopPropagation();event.preventDefault();
  drag={side:hit.side,mode:hit.mode,start:p,centre:at.center,from,pointer:event.pointerId,other:rowCircle(read,sideRow(hit.side==='r'?'l':'r'))};
  host.pane.setPointerCapture(event.pointerId);host.pane.dataset.chestHover=hit.mode;
 };
 const move=(event:PointerEvent)=>{
  if(drag&&event.pointerId===drag.pointer){event.stopPropagation();commit(drag.side,dragBust(drag,local(event),scale()),drag.other);sync();host.changed();return;}
  if(active&&!space&&!drag){const hit=hitBustHandle(projected(),local(event));if(hit)host.pane.dataset.chestHover=hit.mode;else delete host.pane.dataset.chestHover;}
 };
 const end=(event:PointerEvent)=>{if(!drag||event.pointerId!==drag.pointer)return;drag=null;delete host.pane.dataset.chestHover;if(host.pane.hasPointerCapture(event.pointerId))host.pane.releasePointerCapture(event.pointerId);host.changed();};
 host.pane.addEventListener('pointerdown',down,true);host.pane.addEventListener('pointermove',move,true);
 for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)host.pane.addEventListener(type,end,true);
 document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);window.addEventListener('blur',blur);
 // The selected section is the header switch's pressed state; follow it without touching the switch's own wiring.
 const observer=new MutationObserver(()=>sync());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});
 sync();
 return {
  active:()=>active,flashing:side=>flash.has(side),sync,
  notify:(text,error=false,lines)=>{notice=text===null?null:{text,error};if(lines){log.textContent=lines.join('\n');log.hidden=!lines.length;log.scrollTop=log.scrollHeight;}sync();},
  rebuildState:({busy,applied})=>{apply.disabled=busy;apply.setAttribute('aria-busy',String(busy));reset.disabled=busy||!applied;},
  dispose:()=>{observer.disconnect();if(flashTimer)clearTimeout(flashTimer);host.pane.removeEventListener('pointerdown',down,true);host.pane.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)host.pane.removeEventListener(type,end,true);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);window.removeEventListener('blur',blur);},
 };
}
