/**
 * The chest-region editor (Setup): a view-bar toggle, an editor bar of R / L circles and direct manipulation of the
 * circles on the rig pane. The values live in the Chest regions detail block's fields (row 0 = R, row 1 = L), so the
 * draft, export and binding are the detail block's. Review builds no mesh itself: Apply · Rebuild hands the rows to the
 * host, which sends them to the installed producer (#99); this module never reaches a process or the server.
 */
import {clampNonOverlapping,CHEST_CIRCLE_LIMITS,type ChestCircle,type CropWorldMapping} from '../src/chest-regions.ts';
import {BUST_DEFAULTS,deriveBust,type BustDerivation,type BustSpec,type RigPoint} from '../src/chest-landmarks.ts';
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

/** The toggle is available in both Setup and Animate so the overlay can be inspected and adjusted on the posed rig (#307). */
export function chestEditVisible(inspector:string|undefined):boolean {return inspector==='rig'||inspector==='playback';}

export interface BoneWorldReader {bone:(name:string)=>{x:number;y:number}|null|undefined}
/** World-space delta of the posed `chest` bone from its setup-pose world position, matching Family's poseDx/poseDy. */
export function chestPoseOffset(player:BoneWorldReader|null|undefined,setupChest:{x:number;y:number}|null|undefined):{x:number;y:number} {
 if(!player||!setupChest)return {x:0,y:0};
 try{const b=player.bone('chest');if(b&&Number.isFinite(b.x)&&Number.isFinite(b.y))return {x:b.x-setupChest.x,y:b.y-setupChest.y};}catch{/* rig lacks a chest bone */}
 return {x:0,y:0};
}
/** Shifts a crop → world mapping by the posed chest bone's world offset so overlays and hit-testing follow the chest bone. */
export function posedChestMapping<T extends CropWorldMapping>(mapping:T,offset:{x:number;y:number}):T {
 if(!mapping.available||(!offset.x&&!offset.y))return mapping;
 return {...mapping,toWorld:(x:number,y:number)=>{const w=mapping.toWorld(x,y);return {x:w.x+offset.x,y:w.y+offset.y};}};
}

const number=(read:ChestFieldReader,id:string)=>{const raw=(read(id)?.value??'').trim();if(!raw)return null;const value=Number(raw);return Number.isFinite(value)?value:null;};
/** A row is a circle when its semi-axes are equal and it has no medial clip; then r is that semi-axis. */
export function rowCircle(read:ChestFieldReader,row:number):ChestCircle|null {
 const cx=number(read,chestRowId(row,'cx')),cy=number(read,chestRowId(row,'cy')),ax=number(read,chestRowId(row,'ax')),ay=number(read,chestRowId(row,'ay')),band=number(read,chestRowId(row,'band'));
 if(cx===null||cy===null||ax===null||band===null||ax<=0||ay!==ax||(read(chestRowId(row,'clip'))?.value??'').trim())return null;
 return {cx,cy,r:ax,band};
}
/**
 * #315: a row the handles edit — a circle, or an axis-aligned ellipse (`r` = ax, `ry` = ay) with an optional medial clip.
 * The rule for an ellipse: the r handle sets ax and scales ay and the clip's offset from the centre by the same factor
 * (the shape keeps its aspect); the band handle sets band from the core's top (ay); a move shifts the centre and the clip.
 */
export interface BustShape extends ChestCircle {ry?:number;clip?:number}
export function rowShape(read:ChestFieldReader,row:number):BustShape|null {
 const circle=rowCircle(read,row);if(circle)return circle;
 const cx=number(read,chestRowId(row,'cx')),cy=number(read,chestRowId(row,'cy')),ax=number(read,chestRowId(row,'ax')),ay=number(read,chestRowId(row,'ay')),band=number(read,chestRowId(row,'band'));
 const clipText=(read(chestRowId(row,'clip'))?.value??'').trim(),clip=clipText?number(read,chestRowId(row,'clip')):undefined;
 if(cx===null||cy===null||ax===null||ay===null||band===null||ax<=0||ay<=0||clip===null)return null;
 return {cx,cy,r:ax,ry:ay,band,...(clip===undefined?{}:{clip})};
}
const grid=(value:number)=>Math.round(value*256)/256;
/** The ellipse rule's resize: r → ax, and ay and the clip offset scale with it; a circle just takes r. */
export function resizeBust(from:BustShape,r:number):BustShape {
 if(from.ry===undefined&&from.clip===undefined)return {...from,r};
 const k=from.r>0?r/from.r:1;
 return {...from,r,...(from.ry===undefined?{}:{ry:grid(from.ry*k)}),...(from.clip===undefined?{}:{clip:grid(from.cx+(from.clip-from.cx)*k)})};
}
/** Field values that store a shape in a detail row: a circle's r writes both semi-axes; an ellipse's ry writes ay. */
export function circleFields(row:number,circle:Partial<BustShape>):Record<string,string> {
 const out:Record<string,string>={};
 if(circle.cx!==undefined)out[chestRowId(row,'cx')]=String(circle.cx);
 if(circle.cy!==undefined)out[chestRowId(row,'cy')]=String(circle.cy);
 if(circle.r!==undefined){out[chestRowId(row,'ax')]=String(circle.r);out[chestRowId(row,'ay')]=String(circle.ry??circle.r);}
 if(circle.band!==undefined)out[chestRowId(row,'band')]=String(circle.band);
 if(circle.clip!==undefined)out[chestRowId(row,'clip')]=String(circle.clip);
 return out;
}
export const bustLabel=(side:BustSide,c:BustShape)=>c.ry===undefined?`${sideTag(side)} (${Math.round(c.cx)},${Math.round(c.cy)}) r:${Math.round(c.r)} b:${Math.round(c.band)}`:`${sideTag(side)} (${Math.round(c.cx)},${Math.round(c.cy)}) r:${Math.round(c.r)}×${Math.round(c.ry)} b:${Math.round(c.band)}`;

export interface ProjectedBust {side:BustSide;center:OverlayPoint;pxR:number;pxBand:number;/** #315: an ellipse's vertical semi-axis in canvas px. */pxRy?:number}
/** Canvas distance from the centre to the core's edge toward p: pxR for a circle, the ellipse's radius along p for an ellipse. */
const edgeAlong=(c:ProjectedBust,dx:number,dy:number)=>{if(c.pxRy===undefined)return c.pxR;const d=Math.hypot(dx,dy);if(!d)return Math.min(c.pxR,c.pxRy);return c.pxR*c.pxRy/Math.hypot(c.pxRy*dx/d,c.pxR*dy/d);};
/** The example's hit order: core handle or core edge → r, band handles or outer edge → band, anywhere inside the outer band disc → move (#307). */
export function hitBustHandle(circles:readonly ProjectedBust[],p:OverlayPoint):{side:BustSide;mode:BustMode}|null {
 for(const c of circles){
  const toR=Math.hypot(p.x-(c.center.x+c.pxR),p.y-c.center.y),toBand=Math.min(Math.hypot(p.x-c.center.x,p.y-(c.center.y-c.pxBand)),Math.hypot(p.x-c.center.x,p.y-(c.center.y+c.pxBand))),toCenter=Math.hypot(p.x-c.center.x,p.y-c.center.y);
  const core=edgeAlong(c,p.x-c.center.x,p.y-c.center.y),outer=core+(c.pxBand-(c.pxRy??c.pxR));
  if(toR<=10||Math.abs(toCenter-core)<=6)return {side:c.side,mode:'r'};
  if(toBand<=10||Math.abs(toCenter-outer)<=6)return {side:c.side,mode:'band'};
 }
 let best:{side:BustSide;dist:number}|null=null;
 for(const c of circles){
  const toCenter=Math.hypot(p.x-c.center.x,p.y-c.center.y);
  const outer=edgeAlong(c,p.x-c.center.x,p.y-c.center.y)+(c.pxBand-(c.pxRy??c.pxR));
  if(toCenter<=Math.max(12,outer)&&(!best||toCenter<best.dist))best={side:c.side,dist:toCenter};
 }
 return best?{side:best.side,mode:'move'}:null;
}
const limit=(value:number,[low,high]:readonly [number,number])=>Math.max(low,Math.min(high,value));
export interface BustDrag {side:BustSide;mode:BustMode;start:OverlayPoint;centre:OverlayPoint;from:BustShape}
/** Pointer (canvas px) → source px through the camera scale (canvas px per source px), rounded as the example does; an ellipse follows the BustShape rule. */
export function dragBust(drag:BustDrag,p:OverlayPoint,scale:number):BustShape {
 const from=drag.from;if(!(scale>0)||!Number.isFinite(scale))return {...from};
 if(drag.mode==='move'){const cx=Math.round(from.cx+(p.x-drag.start.x)/scale),cy=Math.round(from.cy+(p.y-drag.start.y)/scale);return {...from,cx,cy,...(from.clip===undefined?{}:{clip:grid(from.clip+cx-from.cx)})};}
 const distance=Math.hypot(p.x-drag.centre.x,p.y-drag.centre.y)/scale;
 if(from.ry!==undefined){
  // #316: an ellipse is measured along the grab ray. The core's radius there (r_dir) is what the pointer holds, so a grab
  // changes nothing until it moves, and +d along the ray scales the core by (r_dir + d) / r_dir or grows the band by d.
  const gx=drag.start.x-drag.centre.x,gy=drag.start.y-drag.centre.y,grabbed=Math.hypot(gx,gy)/scale;
  const [ux,uy]=grabbed>0?[gx,gy]:[p.x-drag.centre.x,p.y-drag.centre.y],u=Math.hypot(ux,uy);
  const rDir=u>0?from.r*from.ry/Math.hypot(from.ry*ux/u,from.r*uy/u):from.r;
  // A grab at the centre (no ray) reads the pointer as on the edge, or on the band ring, along its own ray.
  const held=grabbed>0?grabbed:drag.mode==='r'?rDir:rDir+from.band,d=distance-held;
  if(d===0)return {...from};
  if(drag.mode==='r')return resizeBust(from,limit(Math.round(from.r*(rDir+d)/rDir),CHEST_CIRCLE_LIMITS.r));
  return {...from,band:limit(Math.round(from.band+d),CHEST_CIRCLE_LIMITS.band)};
 }
 if(drag.mode==='r')return resizeBust(from,limit(Math.round(distance),CHEST_CIRCLE_LIMITS.r));
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
export function editorStatus(notice:{text:string;error:boolean}|null,mapping:CropWorldMapping,mode:'circles'|'landmarks'='circles'):{text:string;error:boolean} {
 if(notice)return notice;
 if(mapping.available&&mode==='landmarks')return {text:'Click the part to place the armed landmark · drag a marker to move it · Space-drag pans',error:false};
 return mapping.available?{text:'Drag a centre to move · the right-edge handle sets r · the dashed top handle sets band · Space-drag pans',error:false}:{text:`${mapping.reason} — the values still edit and export; nothing is drawn on the stage.`,error:true};
}

/** Circles (#92/#99: the R / L rows) or Landmarks (#105: `contour.bust`). The mode lives in a hidden input, so the draft keeps it. */
export type ChestMode='circles'|'landmarks';
export const LANDMARKS=[{key:'apex_r',tag:"Right apex (character's right, image left)"},{key:'apex_l',tag:"Left apex (character's left, image right)"},{key:'cleavage',tag:'Cleavage'}] as const;
export type LandmarkKey=typeof LANDMARKS[number]['key'];
export const landmarkInputId=(key:LandmarkKey,axis:'x'|'y')=>`lm-${key}-${axis}`;
/** Slider ranges; the producer's defaults sit inside them. */
export const LANDMARK_SLIDERS={alpha:{min:0.05,max:0.95,step:0.01},clearance:{min:0,max:40,step:0.1}} as const;
export type LandmarkRead={spec:BustSpec;derived:BustDerivation}|{missing:LandmarkKey[]}|{error:string};
/**
 * The landmark fields → the `contour.bust` entry and the producer's derivation of it. Points are rig px (integers from a
 * click, any 1/256 value typed); alpha and clearance are always stated; an empty bone field is the producer's default.
 */
export function readLandmarks(read:ChestFieldReader):LandmarkRead {
 const value=(id:string)=>(read(id)?.value??'').trim();
 const points:Partial<Record<LandmarkKey,RigPoint>>={},missing:LandmarkKey[]=[];
 for(const {key} of LANDMARKS){
  const x=value(landmarkInputId(key,'x')),y=value(landmarkInputId(key,'y'));
  if(!x||!y){missing.push(key);continue;}
  const p:RigPoint=[Number(x),Number(y)];
  if(!p.every(Number.isFinite))return {error:`LANDMARK_VALUE_INVALID: ${key}`};
  if(!p.every(n=>Number.isInteger(n*256)))return {error:`LANDMARK_VALUE_INVALID: ${key} is off the 1/256 px grid`};
  points[key]=p;
 }
 if(missing.length)return {missing};
 const alpha=Number(value('lm-alpha')||BUST_DEFAULTS.alpha),clearance=Number(value('lm-clearance')||BUST_DEFAULTS.clearance);
 if(!Number.isFinite(alpha)||alpha<=0||alpha>=1)return {error:'LANDMARK_VALUE_INVALID: alpha is a core ratio in (0, 1)'};
 if(!Number.isFinite(clearance))return {error:'LANDMARK_VALUE_INVALID: clearance'};
 const spec:BustSpec={apex_r:points.apex_r!,apex_l:points.apex_l!,cleavage:points.cleavage!,alpha,clearance};
 for(const key of ['bone_r','bone_l'] as const){const bone=value(`lm-${key}`);if(bone)spec[key]=bone;}
 return {spec,derived:deriveBust(spec)};
}
/** The landmark bar's readout: the derived circles, the producer's refusal verbatim, or which click comes next. */
export function landmarkReadout(result:LandmarkRead):{text:string;error:boolean} {
 if('error' in result)return {text:result.error,error:true};
 if('missing' in result)return {text:`Click the part to place ${LANDMARKS.find(l=>l.key===result.missing[0])!.tag}${result.missing.length>1?` (then ${result.missing.slice(1).map(k=>LANDMARKS.find(l=>l.key===k)!.tag).join(', ')})`:''} · drag a marker to move it`,error:false};
 if(result.derived.refusal)return {text:result.derived.refusal,error:true};
 const [r,l]=result.derived.regions;
 return {text:`bust_r (${r.cx},${r.cy}) r ${r.r} band ${r.band} → ${r.bone} · bust_l (${l.cx},${l.cy}) r ${l.r} band ${l.band} → ${l.bone} · D ${result.derived.D.toFixed(2)} px · the producer derives these again`,error:false};
}
/** The next point a click places: the armed one, else the first one not yet placed, else none. */
export function nextLandmark(armed:LandmarkKey|null,missing:readonly LandmarkKey[]):LandmarkKey|null {return armed??missing[0]??null;}
/**
 * Canvas px → crop px through the camera projection and the crop → world mapping, both affine: each is read off three
 * points and inverted. Null when either is degenerate.
 */
export function canvasToCrop(project:OverlayProject,toWorld:(x:number,y:number)=>{x:number;y:number},p:OverlayPoint):RigPoint|null {
 const invert=(f:(x:number,y:number)=>{x:number;y:number},q:{x:number;y:number})=>{
  const o=f(0,0),ex=f(1,0),ey=f(0,1),a=ex.x-o.x,b=ey.x-o.x,c=ex.y-o.y,d=ey.y-o.y,det=a*d-b*c;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)return null;
  const dx=q.x-o.x,dy=q.y-o.y;return {x:(d*dx-b*dy)/det,y:(a*dy-c*dx)/det};
 };
 const world=invert(project,p);if(!world)return null;
 const crop=invert(toWorld,world);return crop?[crop.x,crop.y]:null;
}
/** The marker under the pointer (canvas px), within 10 px. */
export function hitLandmark(markers:readonly {key:LandmarkKey;at:OverlayPoint}[],p:OverlayPoint):LandmarkKey|null {
 let best:LandmarkKey|null=null,distance=10;
 for(const m of markers){const d=Math.hypot(p.x-m.at.x,p.y-m.at.y);if(d<=distance){best=m.key;distance=d;}}
 return best;
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
 /** Circles or Landmarks; Apply sends regions or `contour.bust` accordingly. */
 mode:()=>ChestMode;
 /** The landmark fields read as the producer's entry and derivation (Landmarks mode). */
 landmarks:()=>LandmarkRead;
 /** The point the next click places, for the overlay's highlight. */
 armed:()=>LandmarkKey|null;
 /** Hold a status line (null clears it); `log` is the producer's latest lines. */
 notify:(text:string|null,error?:boolean,log?:readonly string[])=>void;
 /** The current notice text (empty string when none). */
 noticeText:()=>string;
 /** Apply is disabled while a rebuild runs; Reset is enabled while a rebuilt build is on the stage. */
 rebuildState:(state:{busy:boolean;applied:boolean})=>void}

export function bindChestEditor(host:ChestEditorHost):ChestEditor {
 const node=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
 const toggle=node<HTMLButtonElement>('chest-edit'),bar=node<HTMLElement>('chest-editor-bar'),status=node<HTMLElement>('chest-editor-status');
 const field=(id:string)=>document.getElementById(id) as HTMLInputElement|null;
 const read:ChestFieldReader=id=>{const f=field(id);return f?{value:f.value}:undefined;};
 const log=node<HTMLElement>('chest-editor-log'),apply=node<HTMLButtonElement>('bust-apply'),reset=node<HTMLButtonElement>('bust-reset');
 let notice:{text:string;error:boolean}|null=null;
 const modeInput=field('bust-mode'),landmarkGroups=[...bar.querySelectorAll<HTMLElement>('[data-chest-mode]')],readout=node<HTMLElement>('lm-derived');
 const mode=():ChestMode=>modeInput?.value==='landmarks'?'landmarks':'circles';
 let armed:LandmarkKey|null=null,landmarkDrag:{key:LandmarkKey;pointer:number}|null=null;
 const writePoint=(key:LandmarkKey,[x,y]:RigPoint)=>{for(const [axis,v] of [['x',x],['y',y]] as const){const f=field(landmarkInputId(key,axis));if(f)f.value=String(Math.round(v));}};
 const landmarkMarkers=():{key:LandmarkKey;at:OverlayPoint}[]=>{
  const project=host.project(),mapping=host.mapping();if(!project||!mapping.available)return [];
  return LANDMARKS.flatMap(({key})=>{const x=Number((read(landmarkInputId(key,'x'))?.value??'').trim()||NaN),y=Number((read(landmarkInputId(key,'y'))?.value??'').trim()||NaN);if(!Number.isFinite(x)||!Number.isFinite(y))return [];const w=mapping.toWorld(x,y);return [{key,at:project(w.x,w.y)}];});
 };
 const cropAt=(p:OverlayPoint):RigPoint|null=>{const project=host.project(),mapping=host.mapping();return project&&mapping.available?canvasToCrop(project,mapping.toWorld,p):null;};
 let active=false,space=false,drag:(BustDrag&{pointer:number;other:ChestCircle|null})|null=null;
 const flash=new Set<BustSide>();
 const write=(row:number,circle:Partial<BustShape>)=>{
  for(const [id,value] of Object.entries(circleFields(row,circle))){const f=field(id);if(f)f.value=value;}
  const nameField=field(chestRowId(row,'name'));if(nameField&&!nameField.value.trim())nameField.value=row===0?'bust_r':'bust_l';
  const boneField=field(chestRowId(row,'bone'));if(boneField&&!boneField.value.trim())boneField.value=(field(row===0?'lm-bone_r':'lm-bone_l')?.value??'').trim()||(row===0?'boob_r':'boob_l');
  const spacingField=field(chestRowId(row,'spacing'));if(spacingField&&!spacingField.value.trim())spacingField.value='14';
 };
 /** Writes a changed side directly as Family does (without clamping overlapping outer bands across sides). */
 const commit=(side:BustSide,next:BustShape)=>{write(sideRow(side),next);};
 const projected=():ProjectedBust[]=>{
  const project=host.project(),mapping=host.mapping();if(!project||!mapping.available)return [];
  return bustSides.flatMap(({side,row})=>{const c=rowShape(read,row);if(!c)return [];const at=projectCircle(project,{center:mapping.toWorld(c.cx,c.cy),r:c.r,...(c.ry===undefined?{}:{ry:c.ry}),band:c.band});return at?[{side,...at}]:[];});
 };
 const local=(event:PointerEvent):OverlayPoint=>{const rect=host.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const scale=()=>{const project=host.project();if(!project)return 0;const a=project(0,0),b=project(1,0);return Math.hypot(b.x-a.x,b.y-a.y);};
 const sync=()=>{
  const visible=chestEditVisible(host.inspector());toggle.hidden=!visible;
  if(!visible&&active)setActive(false);
  for(const {side,row} of bustSides){
   const circle=rowShape(read,row),values={x:read(chestRowId(row,'cx'))?.value??'',y:read(chestRowId(row,'cy'))?.value??'',r:circle?String(circle.r):'',band:read(chestRowId(row,'band'))?.value??''};
   for(const f of bustFields){const input=field(bustInputId(side,f));if(input&&document.activeElement!==input)input.value=values[f];}
   const r=field(bustInputId(side,'r'));if(r)r.placeholder=circle||!(read(chestRowId(row,'ax'))?.value??'').trim()?'':'ellipse';
  }
  const m=mode();
  for(const group of landmarkGroups)group.hidden=group.dataset.chestMode!==m;
  for(const button of bar.querySelectorAll<HTMLButtonElement>('[data-bust-mode]'))button.setAttribute('aria-pressed',String(button.dataset.bustMode===m));
  const landmarks=readLandmarks(read),shownReadout=landmarkReadout(landmarks),next=nextLandmark(armed,'missing' in landmarks?landmarks.missing:[]);
  readout.textContent=shownReadout.text;readout.title=shownReadout.text;readout.classList.toggle('error',shownReadout.error);
  for(const button of bar.querySelectorAll<HTMLButtonElement>('[data-landmark]'))button.setAttribute('aria-pressed',String(button.dataset.landmark===next));
  for(const id of ['lm-alpha','lm-clearance']){const out=document.getElementById(`${id}-value`);const f=field(id);if(out&&f)out.textContent=f.value;}
  const shown=editorStatus(notice,host.mapping(),m);
  status.textContent=shown.text;status.title=shown.text;status.classList.toggle('error',shown.error);
 };
 const setActive=(on:boolean)=>{active=on;toggle.setAttribute('aria-pressed',String(on));bar.hidden=!on;if(!on){drag=null;landmarkDrag=null;armed=null;delete host.pane.dataset.chestHover;}sync();host.changed();};
 toggle.addEventListener('click',()=>setActive(!active));
 bar.addEventListener('input',event=>{
  const target=event.target as HTMLInputElement,match=/^bust-([rl])-(x|y|r|band)$/.exec(target.id);if(!match)return;
  const value=Number(target.value);if(!target.value.trim()||!Number.isFinite(value))return;
  const side=match[1] as BustSide,key=({x:'cx',y:'cy',r:'r',band:'band'} as const)[match[2] as typeof bustFields[number]];
  // #315: r on an ellipse row follows the handles' rule (ay and the clip offset scale with it).
  const shape=key==='r'?rowShape(read,sideRow(side)):null;
  write(sideRow(side),shape?resizeBust(shape,value):{[key]:value});host.changed();
 });
 bar.addEventListener('change',event=>{
  const target=event.target as HTMLInputElement,match=/^bust-([rl])-/.exec(target.id);if(!match)return;
  const side=match[1] as BustSide,mine=rowShape(read,sideRow(side));
  if(mine){const r=limit(Math.round(mine.r),CHEST_CIRCLE_LIMITS.r);commit(side,{...(r===mine.r?mine:resizeBust(mine,r)),band:limit(Math.round(mine.band),CHEST_CIRCLE_LIMITS.band)});}
  sync();host.changed();
 });
 for(const button of bar.querySelectorAll<HTMLButtonElement>('[data-bust-mode]'))button.addEventListener('click',()=>{
  const nextMode=button.dataset.bustMode==='landmarks'?'landmarks':'circles';
  if(nextMode==='circles'&&!rowShape(read,0)&&!rowShape(read,1)){
   const lm=readLandmarks(read);if('derived' in lm){const [r,l]=lm.derived.regions;write(0,{cx:r.cx,cy:r.cy,r:r.r,band:r.band});write(1,{cx:l.cx,cy:l.cy,r:l.r,band:l.band});}
  }
  if(modeInput){modeInput.value=nextMode;modeInput.dispatchEvent(new Event('input',{bubbles:true}));}
  armed=null;sync();host.changed();
 });
 for(const button of bar.querySelectorAll<HTMLButtonElement>('[data-landmark]'))button.addEventListener('click',()=>{const key=button.dataset.landmark as LandmarkKey;armed=armed===key?null:key;sync();host.changed();});
 bar.addEventListener('input',event=>{const id=(event.target as HTMLElement).id;if(/^lm-/.test(id)){sync();host.changed();}});
 node<HTMLButtonElement>('bust-mirror').addEventListener('click',()=>{
  const right=rowCircle(read,0),leftX=Number((read(chestRowId(1,'cx'))?.value??'').trim()||NaN);
  if(!right||!Number.isFinite(leftX)){host.message('Mirror needs a complete R circle and an L x.',true);return;}
  write(0,right);write(1,mirrorBust(right,{cx:leftX}));sync();host.changed();
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
  if(mode()==='landmarks'){
   const p=local(event),hitKey=hitLandmark(landmarkMarkers(),p),landmarks=readLandmarks(read),place=hitKey?null:nextLandmark(armed,'missing' in landmarks?landmarks.missing:[]);
   if(!hitKey&&!place)return;
   const at=cropAt(p);if(!at)return;
   // A landmark click or drag edits values; it never reaches the viewport's pan.
   event.stopPropagation();event.preventDefault();
   const key=(hitKey??place)!;writePoint(key,at);if(place)armed=null;
   landmarkDrag={key,pointer:event.pointerId};host.pane.setPointerCapture(event.pointerId);host.pane.dataset.chestHover='move';
   sync();host.changed();return;
  }
  const p=local(event),circles=projected(),hit=hitBustHandle(circles,p);if(!hit)return;
  const row=sideRow(hit.side),from=rowShape(read,row),at=circles.find(c=>c.side===hit.side);if(!from||!at)return;
  // A handle drag edits values; it never reaches the viewport's pan and never moves the camera.
  event.stopPropagation();event.preventDefault();
  drag={side:hit.side,mode:hit.mode,start:p,centre:at.center,from,pointer:event.pointerId,other:rowCircle(read,sideRow(hit.side==='r'?'l':'r'))};
  host.pane.setPointerCapture(event.pointerId);host.pane.dataset.chestHover=hit.mode;
 };
 const move=(event:PointerEvent)=>{
  if(landmarkDrag&&event.pointerId===landmarkDrag.pointer){event.stopPropagation();const at=cropAt(local(event));if(at){writePoint(landmarkDrag.key,at);sync();host.changed();}return;}
  if(active&&!space&&mode()==='landmarks'){if(hitLandmark(landmarkMarkers(),local(event)))host.pane.dataset.chestHover='move';else delete host.pane.dataset.chestHover;return;}
  if(drag&&event.pointerId===drag.pointer){event.stopPropagation();commit(drag.side,dragBust(drag,local(event),scale()));sync();host.changed();return;}
  if(active&&!space&&!drag){const hit=hitBustHandle(projected(),local(event));if(hit)host.pane.dataset.chestHover=hit.mode;else delete host.pane.dataset.chestHover;}
 };
 const end=(event:PointerEvent)=>{
  if(landmarkDrag&&event.pointerId===landmarkDrag.pointer){landmarkDrag=null;delete host.pane.dataset.chestHover;if(host.pane.hasPointerCapture(event.pointerId))host.pane.releasePointerCapture(event.pointerId);host.changed();return;}
  if(!drag||event.pointerId!==drag.pointer)return;drag=null;delete host.pane.dataset.chestHover;if(host.pane.hasPointerCapture(event.pointerId))host.pane.releasePointerCapture(event.pointerId);host.changed();};
 host.pane.addEventListener('pointerdown',down,true);host.pane.addEventListener('pointermove',move,true);
 for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)host.pane.addEventListener(type,end,true);
 document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);window.addEventListener('blur',blur);
 // The selected section is the header switch's pressed state; follow it without touching the switch's own wiring.
 const observer=new MutationObserver(()=>sync());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});
 sync();
 return {
  active:()=>active,flashing:side=>flash.has(side),sync,mode,landmarks:()=>readLandmarks(read),armed:()=>{const l=readLandmarks(read);return nextLandmark(armed,'missing' in l?l.missing:[]);},
  notify:(text,error=false,lines)=>{notice=text===null?null:{text,error};if(lines){log.textContent=lines.join('\n');log.hidden=!lines.length;log.scrollTop=log.scrollHeight;}sync();},
  noticeText:()=>notice?.text??'',
  rebuildState:({busy,applied})=>{apply.disabled=busy;apply.setAttribute('aria-busy',String(busy));reset.disabled=busy||!applied;},
  dispose:()=>{observer.disconnect();host.pane.removeEventListener('pointerdown',down,true);host.pane.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)host.pane.removeEventListener(type,end,true);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);window.removeEventListener('blur',blur);},
 };
}
