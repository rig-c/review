/** Inspection graphics from the last successfully drawn public player pose. */
import {partBounds} from './part-selection.ts';
import type {BoneWorld,PosedFrame,RigPlayer} from '@rig-c/play';

export interface OverlayPoint {x:number;y:number}
export type OverlayProject=(x:number,y:number)=>OverlayPoint;
export interface BoneOverlaySpec {name:string;parent?:string;length?:number}
export interface RigOverlaySettings {images:boolean;mesh:boolean;bones:boolean;meshOpacity:number}
export interface OverlayPlayer extends Pick<RigPlayer,'posedFrame'|'bone'> {}
export interface OverlayLine {from:OverlayPoint;to:OverlayPoint;slot?:string}
export interface OverlayBone {name:string;point:OverlayPoint;xAxis:OverlayPoint;yAxis:OverlayPoint}
/** `meshTriangles`: per slot, the triangles the mesh layer draws from the captured pose (#106 bar 1 reads it). */
export interface RigOverlayGeometry {selection:OverlayLine[];mesh:OverlayLine[];meshTriangles:Record<string,number>;bones:OverlayLine[];joints:OverlayBone[];warnings:string[];captured:{mesh:boolean;bones:boolean}}
export interface OverlaySnapshot {
 available:boolean;needsCapture:boolean;meshEdges:number;meshTriangles:Record<string,number>;boneCount:number;
 capabilities:{images:boolean;mesh:boolean;bones:boolean};warnings:string[];
}
/** Designation polygons in rig world coordinates (Setup's Chest regions tool); colours are theme token values. */
/**
 * `handles` (#106, the Mesh panel's polygon regions): a square on every vertex, the `active` one filled with `handle`,
 * and the name as a label; `open` draws the outline unclosed (a polygon still being placed).
 */
export interface OverlayRegion {name:string;points:OverlayPoint[];stroke:string;fill:string;handles?:boolean;active?:number|null;open?:boolean;colors?:{handle:string;ink:string;labelBg:string}}
/**
 * A circle designation in rig world units (crop px = world px under the crop mapping): core r at full weight, dashed
 * outer circle at r + band. With handles it is the chest editor's drawing (centre, core edge on the right, band on
 * top, a label under the outer circle). Colours are theme token values.
 */
export interface OverlayCircle {center:OverlayPoint;r:number;band:number;label?:string;/** Label rows below the outer circle, so two labels never overlap. */labelRow?:number;handles:boolean;flash?:boolean;colors:{stroke:string;fill:string;handle:string;ink:string;labelBg:string;flash:string}}
/**
 * Mesh edit preview in rig world coordinates: the selected slot's original triangles (cut out of the veil that dims the
 * rest of the rig), the edges after the delta by kind, moved-vertex ghosts and the vertices as handles. A box is in
 * canvas px. It is drawn over the original triangulation; nothing here retriangulates. Colours are theme token values.
 */
export interface OverlayMeshEdit {
 triangles:readonly OverlayPoint[][];
 edges:readonly {from:OverlayPoint;to:OverlayPoint;kind:'hull'|'interior'|'constraint'|'removed';hover?:boolean}[];
 ghosts:readonly {from:OverlayPoint;to:OverlayPoint}[];
 vertices:readonly {at:OverlayPoint;state:'source'|'moved'|'added'|'removed';selected:boolean;hover:boolean;pending:boolean}[];
 box?:{from:OverlayPoint;to:OverlayPoint};
 colors:{veil:string;edge:string;hull:string;constraint:string;removed:string;vertex:string;ink:string;selected:string;added:string;hover:string;box:string;boxFill:string};
}
/**
 * A chest landmark (#105) in rig world units: a diamond with its tag, and a guide from the cleavage to each apex (the
 * distance the producer derives a radius from). Colours are theme token values.
 */
export interface OverlayMarker {at:OverlayPoint;tag:string;active:boolean;colors:{stroke:string;fill:string;ink:string;labelBg:string};guideTo?:OverlayPoint[]}
/**
 * Setup weights (#107) in rig world coordinates: the selected slot's setup-pose mesh, each triangle filled with the mean
 * of its vertices' ramp colours and each vertex a dot in its own colour, over a veil that dims the rest of the rig.
 * `value` is the weight the colour was taken from (stored, never normalised); `hover` indexes `vertices` and draws its
 * label. Colours are theme token values.
 */
export interface OverlayWeights {
 triangles:readonly {points:readonly [number,number,number];color:string}[];
 vertices:readonly {at:OverlayPoint;index:number;value:number;color:string;label:string}[];
 hover:number|null;
 colors:{veil:string;edge:string;ink:string;labelBg:string;hover:string};
}
/**
 * Setup bones (#109) in rig world coordinates: every config anchor as a handle — an origin a square, a chain point a
 * circle, a tip a diamond — joined by its chain or bone-to-tip line; a pending anchor draws a dashed ghost from the
 * config's value; the hovered or selected anchor is ringed and labelled. Colours are theme token values.
 */
export interface OverlayAnchors {
 lines:readonly {from:OverlayPoint;to:OverlayPoint}[];
 anchors:readonly {at:OverlayPoint;from:OverlayPoint|null;kind:'at'|'point'|'tip';label:string;selected:boolean;hover:boolean}[];
 colors:{line:string;origin:string;point:string;tip:string;pending:string;selected:string;ink:string;labelBg:string};
}
export interface OverlayView {project:OverlayProject;settings:RigOverlaySettings;dpr?:number;regions?:readonly OverlayRegion[];circles?:readonly OverlayCircle[];markers?:readonly OverlayMarker[];meshEdit?:OverlayMeshEdit|null;weights?:OverlayWeights|null;anchors?:OverlayAnchors|null}
/** Canvas-pixel geometry of a circle designation, the same numbers the editor hit-tests against. */
export function projectCircle(project:OverlayProject,circle:Pick<OverlayCircle,'center'|'r'|'band'>):{center:OverlayPoint;pxR:number;pxBand:number}|null {
 const {x,y}=circle.center,center=project(x,y),edge=project(x+circle.r,y),top=project(x,y+circle.r+circle.band);
 if(![center,edge,top].every(finite))return null;
 const pxR=Math.max(2,Math.hypot(edge.x-center.x,edge.y-center.y));
 return {center,pxR,pxBand:Math.max(pxR+2,Math.hypot(top.x-center.x,top.y-center.y))};
}
export interface OverlayRefresh extends OverlayView {player:OverlayPlayer|null;bones:readonly BoneOverlaySpec[];frame?:PosedFrame;selectedSlot?:string|null}
const point=(x:number,y:number):OverlayPoint=>({x,y});
const finite=(p:OverlayPoint)=>Number.isFinite(p.x)&&Number.isFinite(p.y);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

function meshLines(frame:PosedFrame,warnings:string[],triangles:Record<string,number>={}):OverlayLine[]{
 const lines:OverlayLine[]=[];
 for(const slot of frame.order){
  if(slot.kind!=='mesh')continue;
  const edges=new Set<string>();
  if(slot.vertices.length%2||slot.triangles.length%3){warnings.push(`Mesh overlay ${slot.slot}: incomplete coordinates or triangle`);continue;}
  for(let i=0;i<slot.triangles.length;i+=3){
   const ids=slot.triangles.slice(i,i+3);
   if(ids.some(index=>!Number.isSafeInteger(index)||index<0||index*2+1>=slot.vertices.length)){warnings.push(`Mesh overlay ${slot.slot}: triangle index outside posed vertices`);continue;}
   const points=ids.map(index=>point(slot.vertices[index*2]!,slot.vertices[index*2+1]!));
   if(points.some(p=>!finite(p))){warnings.push(`Mesh overlay ${slot.slot}: nonfinite posed vertex`);continue;}
   triangles[slot.slot]=(triangles[slot.slot]??0)+1;
   for(let edge=0;edge<3;edge++){
    const a=ids[edge]!,b=ids[(edge+1)%3]!,key=a<b?`${a}:${b}`:`${b}:${a}`;
    if(edges.has(key))continue;edges.add(key);
    lines.push({from:{...points[edge]!},to:{...points[(edge+1)%3]!},slot:slot.slot});
   }
  }
 }
 return lines;
}

/** Takes copies; later seeks cannot turn an old overlay into a prepared pose. */
export function captureRigGeometry(player:OverlayPlayer,specs:readonly BoneOverlaySpec[],layers:Pick<RigOverlaySettings,'mesh'|'bones'>,frame?:PosedFrame,selectedSlot?:string|null):RigOverlayGeometry{
 const geometry:RigOverlayGeometry={selection:[],mesh:[],meshTriangles:{},bones:[],joints:[],warnings:[],captured:{mesh:false,bones:false}};
 if(selectedSlot){try{const bounds=partBounds(frame??player.posedFrame(null),selectedSlot);if(bounds){const {x,y,width,height}=bounds,points=[point(x,y),point(x+width,y),point(x+width,y+height),point(x,y+height)];geometry.selection=points.map((from,i)=>({from,to:points[(i+1)%4]!,slot:selectedSlot}));}}catch(error){geometry.warnings.push(`Selection bounds unavailable: ${message(error)}`);}}
 if(layers.mesh){
  try{geometry.mesh=meshLines(frame??player.posedFrame(),geometry.warnings,geometry.meshTriangles);geometry.captured.mesh=true;}
  catch(error){geometry.warnings.push(`Mesh overlay unavailable: ${message(error)}`);}
 }
 if(layers.bones){
  const found=new Map<string,BoneWorld>();
  const read=(name:string):BoneWorld|null=>{
   if(found.has(name))return found.get(name)!;
   try{const value=player.bone(name);if(![value.x,value.y,value.a,value.b,value.c,value.d].every(Number.isFinite))throw new Error('nonfinite world transform');const copied={...value};found.set(name,copied);return copied;}
   catch(error){geometry.warnings.push(`Bone overlay ${name}: ${message(error)}`);return null;}
  };
  const names=new Set<string>();
  for(const spec of specs){
   if(!spec.name||names.has(spec.name)){geometry.warnings.push('Bone overlay: missing or duplicate declared name');continue;}names.add(spec.name);
   const bone=read(spec.name);if(!bone?.active)continue;
   const from=point(bone.x,bone.y);
   geometry.joints.push({name:spec.name,point:from,xAxis:point(bone.a,bone.c),yAxis:point(bone.b,bone.d)});
   if(spec.length!==undefined&&(!Number.isFinite(spec.length)||spec.length<0)){geometry.warnings.push(`Bone overlay ${spec.name}: invalid declared length`);continue;}
   if(spec.length!==undefined&&spec.length>0){geometry.bones.push({from:{...from},to:point(bone.x+bone.a*spec.length,bone.y+bone.c*spec.length)});}
   else if(spec.parent){const parent=read(spec.parent);if(parent?.active)geometry.bones.push({from:point(parent.x,parent.y),to:{...from}});}
  }
  geometry.captured.bones=true;
 }
 return geometry;
}

/**
 * The canvas must be a sibling above rigRoot. refresh follows an actual successful
 * draw; redraw is for camera/layer changes and never samples a prepared player.
 */
export class RigOverlays {
 private geometry:RigOverlayGeometry|null=null;
 private playerAvailable=false;
 private disposed=false;
 private readonly visibility:string;
 private readonly pointerEvents:string;
 constructor(private readonly host:{canvas:HTMLCanvasElement;rigRoot:HTMLElement}){
  this.visibility=host.rigRoot.style.visibility;this.pointerEvents=host.canvas.style.pointerEvents;
  host.canvas.style.pointerEvents='none';
 }
 refresh(input:OverlayRefresh):OverlaySnapshot{
  if(this.disposed)return this.unavailable('Overlay has been disposed');
  this.playerAvailable=!!input.player;
  this.geometry=input.player?captureRigGeometry(input.player,input.bones,input.settings,input.frame,input.selectedSlot):null;
  return this.redraw(input);
 }
 redraw({project,settings,dpr=globalThis.devicePixelRatio??1,regions=[],circles=[],markers=[],meshEdit=null,weights=null,anchors=null}:OverlayView):OverlaySnapshot{
  if(this.disposed)return this.unavailable('Overlay has been disposed');
  this.host.rigRoot.style.visibility=settings.images?this.visibility:'hidden';
  const warnings=[...(this.geometry?.warnings??[])],ctx=this.host.canvas.getContext('2d');
  const captured=this.geometry?.captured;
  const needsCapture=this.playerAvailable&&((settings.mesh&&!captured?.mesh)||(settings.bones&&!captured?.bones));
  if(needsCapture)warnings.push('Overlay pending: a successful rig draw is required for the selected layers');
  if(!this.playerAvailable&&(settings.mesh||settings.bones))warnings.push('Overlay unavailable: no successfully drawn rig pose');
  if(!ctx){warnings.push('Overlay unavailable: Canvas2D context missing');return this.snapshot(false,needsCapture,warnings);}
  const width=this.host.canvas.clientWidth,height=this.host.canvas.clientHeight;
  if(!Number.isFinite(dpr)||dpr<=0){warnings.push('Overlay unavailable: positive finite pixel ratio required');ctx.clearRect(0,0,this.host.canvas.width,this.host.canvas.height);return this.snapshot(false,needsCapture,warnings);}
  if(width<=0||height<=0){ctx.clearRect(0,0,this.host.canvas.width,this.host.canvas.height);return this.snapshot(true,needsCapture,warnings);}
  const pw=Math.max(1,Math.round(width*dpr)),ph=Math.max(1,Math.round(height*dpr));
  if(this.host.canvas.width!==pw)this.host.canvas.width=pw;
  if(this.host.canvas.height!==ph)this.host.canvas.height=ph;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const projected=(p:OverlayPoint):OverlayPoint|null=>{
   const value=project(p.x,p.y);if(finite(value))return value;
   if(!warnings.includes('Overlay projection returned nonfinite coordinates'))warnings.push('Overlay projection returned nonfinite coordinates');return null;
  };
  const line=(value:OverlayLine)=>{const from=projected(value.from),to=projected(value.to);if(from&&to){ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);}};
  ctx.save();
  if(settings.mesh&&captured?.mesh){
   ctx.strokeStyle='#007d98';ctx.lineWidth=2.3;ctx.globalAlpha=Math.max(0,Math.min(1,Number.isFinite(settings.meshOpacity)?settings.meshOpacity:0));
   ctx.beginPath();for(const edge of this.geometry!.mesh)line(edge);ctx.stroke();
   ctx.strokeStyle='#69f1ff';ctx.lineWidth=.9;ctx.beginPath();for(const edge of this.geometry!.mesh)line(edge);ctx.stroke();
  }
  if(settings.bones&&captured?.bones){
   ctx.globalAlpha=1;ctx.strokeStyle='#5c3b00';ctx.lineWidth=3;ctx.beginPath();for(const edge of this.geometry!.bones)line(edge);ctx.stroke();
   ctx.strokeStyle='#ffe26b';ctx.lineWidth=1.3;ctx.beginPath();for(const edge of this.geometry!.bones)line(edge);ctx.stroke();
   for(const bone of this.geometry!.joints){
    const center=projected(bone.point);if(!center)continue;
    // Axis ticks are display glyphs, not invented bone lengths.
    for(const [axis,color] of [[bone.xAxis,'#ff876f'],[bone.yAxis,'#80e9a2']] as const){
     const end=projected(point(bone.point.x+axis.x,bone.point.y+axis.y));if(!end)continue;
     const dx=end.x-center.x,dy=end.y-center.y,length=Math.hypot(dx,dy);if(length===0)continue;
     ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(center.x,center.y);ctx.lineTo(center.x+dx/length*9,center.y+dy/length*9);ctx.stroke();
    }
    ctx.fillStyle='#ffe26b';ctx.strokeStyle='#44310d';ctx.lineWidth=1;ctx.beginPath();ctx.arc(center.x,center.y,2.8,0,Math.PI*2);ctx.fill();ctx.stroke();
   }
  }
  // Designations are drawn over the drawn rig only; they are values the reviewer typed, not rig geometry.
  if(this.playerAvailable)for(const region of regions){
   const points=region.points.map(projected);if(points.length<(region.open?1:3)||points.some(p=>!p))continue;
   ctx.globalAlpha=1;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(points[0]!.x,points[0]!.y);for(const p of points.slice(1))ctx.lineTo(p!.x,p!.y);
   if(!region.open){ctx.closePath();ctx.fillStyle=region.fill;ctx.fill();}
   ctx.strokeStyle=region.stroke;ctx.lineWidth=1.6;ctx.stroke();
   if(region.handles&&region.colors){
    const c=region.colors;
    points.forEach((p,i)=>{const size=region.active===i?5:3.5;ctx.fillStyle=region.active===i?c.handle:c.ink;ctx.strokeStyle=region.stroke;ctx.lineWidth=1.5;ctx.fillRect(p!.x-size,p!.y-size,size*2,size*2);ctx.strokeRect(p!.x-size,p!.y-size,size*2,size*2);});
    const top=points.reduce((a,p)=>p!.y<a!.y?p:a,points[0]);
    // An empty name draws no label (#111: one label per chain set, not per chain).
    if(region.name){ctx.font='600 11px ui-monospace, monospace';const width=ctx.measureText(region.name).width+8;ctx.fillStyle=c.labelBg;ctx.fillRect(top!.x-width/2,top!.y-24,width,15);ctx.fillStyle=region.stroke;ctx.fillText(region.name,top!.x-width/2+4,top!.y-13);}
   }
  }
  if(this.playerAvailable)for(const circle of circles){
   const at=projectCircle(project,circle);if(!at)continue;const {center,pxR,pxBand}=at,c=circle.colors;
   ctx.globalAlpha=.95;
   ctx.beginPath();ctx.setLineDash([5,4]);ctx.strokeStyle=c.stroke;ctx.lineWidth=1.6;ctx.arc(center.x,center.y,pxBand,0,Math.PI*2);ctx.stroke();
   ctx.beginPath();ctx.setLineDash([]);ctx.fillStyle=c.fill;ctx.lineWidth=2.2;ctx.arc(center.x,center.y,pxR,0,Math.PI*2);ctx.fill();ctx.stroke();
   if(!circle.handles)continue;
   ctx.globalAlpha=1;
   ctx.beginPath();ctx.moveTo(center.x-7,center.y);ctx.lineTo(center.x+7,center.y);ctx.moveTo(center.x,center.y-7);ctx.lineTo(center.x,center.y+7);ctx.stroke();
   for(const [x,y,fill,stroke] of [[center.x,center.y,c.handle,c.stroke],[center.x+pxR,center.y,c.stroke,c.ink],[center.x,center.y-pxBand,c.ink,c.stroke]] as const){ctx.beginPath();ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();ctx.stroke();}
   if(circle.label){
    ctx.font='600 11px ui-monospace, monospace';const width=ctx.measureText(circle.label).width+8,lx=center.x-width/2,ly=center.y+pxBand+14+(circle.labelRow??0)*17;
    ctx.fillStyle=circle.flash?c.flash:c.labelBg;ctx.fillRect(lx,ly-11,width,15);ctx.fillStyle=circle.flash?c.ink:c.stroke;ctx.fillText(circle.label,lx+4,ly);
   }
  }
  if(this.playerAvailable)for(const marker of markers){
   const at=projected(marker.at);if(!at)continue;const c=marker.colors;
   ctx.globalAlpha=.9;ctx.setLineDash([3,3]);ctx.strokeStyle=c.stroke;ctx.lineWidth=1.2;
   for(const to of marker.guideTo??[]){const end=projected(to);if(!end)continue;ctx.beginPath();ctx.moveTo(at.x,at.y);ctx.lineTo(end.x,end.y);ctx.stroke();}
   ctx.setLineDash([]);ctx.globalAlpha=1;const size=marker.active?7:5.5;
   ctx.beginPath();ctx.moveTo(at.x,at.y-size);ctx.lineTo(at.x+size,at.y);ctx.lineTo(at.x,at.y+size);ctx.lineTo(at.x-size,at.y);ctx.closePath();
   ctx.fillStyle=c.fill;ctx.fill();ctx.strokeStyle=c.ink;ctx.lineWidth=marker.active?2.4:1.6;ctx.stroke();
   ctx.font='600 11px ui-monospace, monospace';const width=ctx.measureText(marker.tag).width+8,lx=at.x+size+4,ly=at.y-size-2;
   ctx.fillStyle=c.labelBg;ctx.fillRect(lx,ly-11,width,15);ctx.fillStyle=c.stroke;ctx.fillText(marker.tag,lx+4,ly);
  }
  ctx.globalAlpha=1;
  if(this.playerAvailable&&meshEdit)this.drawMeshEdit(ctx,meshEdit,projected,width,height);
  else if(this.playerAvailable&&weights)this.drawWeights(ctx,weights,projected,width,height);
  if(this.playerAvailable&&anchors)this.drawAnchors(ctx,anchors,projected);
  if(this.geometry?.selection.length&&!meshEdit&&!weights&&!anchors){ctx.globalAlpha=1;ctx.strokeStyle='#ffbb47';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.beginPath();for(const edge of this.geometry.selection)line(edge);ctx.stroke();ctx.setLineDash([]);}
  ctx.restore();
  return this.snapshot(true,needsCapture,warnings);
 }
 private drawMeshEdit(ctx:CanvasRenderingContext2D,edit:OverlayMeshEdit,projected:(p:OverlayPoint)=>OverlayPoint|null,width:number,height:number):void{
  const c=edit.colors;ctx.save();ctx.globalAlpha=1;ctx.setLineDash([]);
  // The rest of the rig dims; the edited slot's own triangles are cut out of the veil so its art stays at full opacity.
  ctx.fillStyle=c.veil;ctx.fillRect(0,0,width,height);
  ctx.globalCompositeOperation='destination-out';ctx.fillStyle=c.ink;ctx.beginPath();
  for(const triangle of edit.triangles){const points=triangle.map(projected);if(points.length<3||points.some(p=>!p))continue;ctx.moveTo(points[0]!.x,points[0]!.y);for(const p of points.slice(1))ctx.lineTo(p!.x,p!.y);ctx.closePath();}
  ctx.fill();ctx.globalCompositeOperation='source-over';
  const segment=(from:OverlayPoint,to:OverlayPoint)=>{const a=projected(from),b=projected(to);if(a&&b){ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}};
  const stroke=(kind:OverlayMeshEdit['edges'][number]['kind'],color:string,width:number,dash:number[]=[])=>{ctx.beginPath();ctx.setLineDash(dash);ctx.strokeStyle=color;ctx.lineWidth=width;for(const e of edit.edges)if(e.kind===kind)segment(e.from,e.to);ctx.stroke();};
  stroke('removed',c.removed,1.4,[4,3]);stroke('interior',c.edge,1);stroke('constraint',c.constraint,2.4);stroke('hull',c.hull,2.2);
  ctx.beginPath();ctx.setLineDash([2,3]);ctx.strokeStyle=c.ink;ctx.lineWidth=1;for(const g of edit.ghosts)segment(g.from,g.to);ctx.stroke();
  ctx.beginPath();ctx.setLineDash([]);ctx.strokeStyle=c.hover;ctx.lineWidth=3.2;for(const e of edit.edges)if(e.hover)segment(e.from,e.to);ctx.stroke();
  for(const v of edit.vertices){
   const p=projected(v.at);if(!p)continue;
   if(v.state==='removed'){ctx.beginPath();ctx.strokeStyle=c.removed;ctx.lineWidth=1.6;ctx.moveTo(p.x-4,p.y-4);ctx.lineTo(p.x+4,p.y+4);ctx.moveTo(p.x+4,p.y-4);ctx.lineTo(p.x-4,p.y+4);ctx.stroke();continue;}
   const r=v.selected?4.6:3.4;ctx.beginPath();ctx.fillStyle=v.selected?c.selected:v.state==='added'?c.added:c.vertex;ctx.strokeStyle=v.state==='moved'?c.selected:c.ink;ctx.lineWidth=v.state==='moved'?2:1.2;ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();ctx.stroke();
   if(v.hover||v.pending){ctx.beginPath();ctx.strokeStyle=v.pending?c.constraint:c.hover;ctx.lineWidth=2;ctx.arc(p.x,p.y,7.5,0,Math.PI*2);ctx.stroke();}
  }
  if(edit.box){const {from,to}=edit.box,x=Math.min(from.x,to.x),y=Math.min(from.y,to.y),w=Math.abs(to.x-from.x),h=Math.abs(to.y-from.y);ctx.fillStyle=c.boxFill;ctx.fillRect(x,y,w,h);ctx.setLineDash([4,3]);ctx.strokeStyle=c.box;ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w,h);}
  ctx.restore();
 }
 private drawWeights(ctx:CanvasRenderingContext2D,w:OverlayWeights,projected:(p:OverlayPoint)=>OverlayPoint|null,width:number,height:number):void{
  const c=w.colors,points=w.vertices.map(v=>projected(v.at));ctx.save();ctx.globalAlpha=1;ctx.setLineDash([]);
  ctx.fillStyle=c.veil;ctx.fillRect(0,0,width,height);
  for(const t of w.triangles){
   const [a,b,d]=t.points.map(i=>points[i]);if(!a||!b||!d)continue;
   ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(d.x,d.y);ctx.closePath();ctx.globalAlpha=.72;ctx.fillStyle=t.color;ctx.fill();ctx.globalAlpha=.5;ctx.strokeStyle=c.edge;ctx.lineWidth=.8;ctx.stroke();
  }
  ctx.globalAlpha=1;
  w.vertices.forEach((v,i)=>{const p=points[i];if(!p)return;ctx.beginPath();ctx.fillStyle=v.color;ctx.strokeStyle=c.ink;ctx.lineWidth=1.1;ctx.arc(p.x,p.y,3.4,0,Math.PI*2);ctx.fill();ctx.stroke();});
  const h=w.hover===null?null:w.vertices[w.hover],hp=w.hover===null?null:points[w.hover];
  if(h&&hp){
   ctx.beginPath();ctx.strokeStyle=c.hover;ctx.lineWidth=2;ctx.arc(hp.x,hp.y,7.5,0,Math.PI*2);ctx.stroke();
   ctx.font='600 11px ui-monospace, monospace';const tw=ctx.measureText(h.label).width+10,lx=Math.min(Math.max(2,hp.x+11),width-tw-2),ly=Math.max(14,hp.y-11);
   ctx.fillStyle=c.labelBg;ctx.fillRect(lx,ly-12,tw,17);ctx.fillStyle=c.hover;ctx.fillText(h.label,lx+5,ly);
  }
  ctx.restore();
 }
 private drawAnchors(ctx:CanvasRenderingContext2D,b:OverlayAnchors,projected:(p:OverlayPoint)=>OverlayPoint|null):void{
  const c=b.colors;ctx.save();ctx.globalAlpha=1;
  ctx.setLineDash([]);ctx.lineWidth=1.6;ctx.strokeStyle=c.line;ctx.beginPath();
  for(const l of b.lines){const from=projected(l.from),to=projected(l.to);if(from&&to){ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);}}
  ctx.stroke();
  ctx.setLineDash([3,3]);ctx.strokeStyle=c.pending;ctx.lineWidth=1.2;ctx.beginPath();
  for(const a of b.anchors){if(!a.from)continue;const from=projected(a.from),to=projected(a.at);if(from&&to){ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);}}
  ctx.stroke();ctx.setLineDash([]);
  const labels:{at:OverlayPoint;text:string;color:string}[]=[];
  for(const a of b.anchors){
   const p=projected(a.at);if(!p)continue;
   if(a.from){const g=projected(a.from);if(g){ctx.beginPath();ctx.strokeStyle=c.pending;ctx.lineWidth=1;ctx.arc(g.x,g.y,2.5,0,Math.PI*2);ctx.stroke();}}
   const fill=a.from?c.pending:a.kind==='at'?c.origin:a.kind==='point'?c.point:c.tip,size=a.selected||a.hover?6:4.5;
   ctx.beginPath();
   if(a.kind==='at')ctx.rect(p.x-size,p.y-size,size*2,size*2);
   else if(a.kind==='point')ctx.arc(p.x,p.y,size,0,Math.PI*2);
   else{ctx.moveTo(p.x,p.y-size-1);ctx.lineTo(p.x+size+1,p.y);ctx.lineTo(p.x,p.y+size+1);ctx.lineTo(p.x-size-1,p.y);ctx.closePath();}
   ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=c.ink;ctx.lineWidth=1.3;ctx.stroke();
   if(a.selected||a.hover){ctx.beginPath();ctx.strokeStyle=c.selected;ctx.lineWidth=2;ctx.arc(p.x,p.y,size+4,0,Math.PI*2);ctx.stroke();}
   if(a.selected||a.hover||a.from)labels.push({at:p,text:a.label,color:a.selected||a.hover?c.selected:c.pending});
  }
  ctx.font='600 11px ui-monospace, monospace';
  for(const l of labels){const w=ctx.measureText(l.text).width+8,lx=l.at.x+10,ly=l.at.y-9;ctx.fillStyle=c.labelBg;ctx.fillRect(lx,ly-11,w,15);ctx.fillStyle=l.color;ctx.fillText(l.text,lx+4,ly);}
  ctx.restore();
 }
 clear():void{
  this.geometry=null;this.playerAvailable=false;
  const ctx=this.host.canvas.getContext('2d');if(ctx){ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.host.canvas.width,this.host.canvas.height);ctx.restore();}
 }
 dispose():void{
  if(this.disposed)return;this.clear();this.host.rigRoot.style.visibility=this.visibility;this.host.canvas.style.pointerEvents=this.pointerEvents;this.disposed=true;
 }
 private snapshot(canvasAvailable:boolean,needsCapture:boolean,warnings:string[]):OverlaySnapshot{
  return {available:this.playerAvailable&&canvasAvailable,needsCapture,meshEdges:this.geometry?.mesh.length??0,meshTriangles:{...(this.geometry?.meshTriangles??{})},boneCount:this.geometry?.joints.length??0,capabilities:{images:this.playerAvailable,mesh:this.playerAvailable&&canvasAvailable,bones:this.playerAvailable&&canvasAvailable},warnings};
 }
 private unavailable(warning:string):OverlaySnapshot{return {available:false,needsCapture:false,meshEdges:0,meshTriangles:{},boneCount:0,capabilities:{images:false,mesh:false,bones:false},warnings:[warning]};}
}
