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
export interface RigOverlayGeometry {selection:OverlayLine[];mesh:OverlayLine[];bones:OverlayLine[];joints:OverlayBone[];warnings:string[];captured:{mesh:boolean;bones:boolean}}
export interface OverlaySnapshot {
 available:boolean;needsCapture:boolean;meshEdges:number;boneCount:number;
 capabilities:{images:boolean;mesh:boolean;bones:boolean};warnings:string[];
}
export interface OverlayView {project:OverlayProject;settings:RigOverlaySettings;dpr?:number}
export interface OverlayRefresh extends OverlayView {player:OverlayPlayer|null;bones:readonly BoneOverlaySpec[];frame?:PosedFrame;selectedSlot?:string|null}
const point=(x:number,y:number):OverlayPoint=>({x,y});
const finite=(p:OverlayPoint)=>Number.isFinite(p.x)&&Number.isFinite(p.y);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

function meshLines(frame:PosedFrame,warnings:string[]):OverlayLine[]{
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
 const geometry:RigOverlayGeometry={selection:[],mesh:[],bones:[],joints:[],warnings:[],captured:{mesh:false,bones:false}};
 if(selectedSlot){try{const bounds=partBounds(frame??player.posedFrame(null),selectedSlot);if(bounds){const {x,y,width,height}=bounds,points=[point(x,y),point(x+width,y),point(x+width,y+height),point(x,y+height)];geometry.selection=points.map((from,i)=>({from,to:points[(i+1)%4]!,slot:selectedSlot}));}}catch(error){geometry.warnings.push(`Selection bounds unavailable: ${message(error)}`);}}
 if(layers.mesh){
  try{geometry.mesh=meshLines(frame??player.posedFrame(),geometry.warnings);geometry.captured.mesh=true;}
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
 redraw({project,settings,dpr=globalThis.devicePixelRatio??1}:OverlayView):OverlaySnapshot{
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
  if(this.geometry?.selection.length){ctx.globalAlpha=1;ctx.strokeStyle='#ffbb47';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.beginPath();for(const edge of this.geometry.selection)line(edge);ctx.stroke();ctx.setLineDash([]);}
  ctx.restore();
  return this.snapshot(true,needsCapture,warnings);
 }
 clear():void{
  this.geometry=null;this.playerAvailable=false;
  const ctx=this.host.canvas.getContext('2d');if(ctx){ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.host.canvas.width,this.host.canvas.height);ctx.restore();}
 }
 dispose():void{
  if(this.disposed)return;this.clear();this.host.rigRoot.style.visibility=this.visibility;this.host.canvas.style.pointerEvents=this.pointerEvents;this.disposed=true;
 }
 private snapshot(canvasAvailable:boolean,needsCapture:boolean,warnings:string[]):OverlaySnapshot{
  return {available:this.playerAvailable&&canvasAvailable,needsCapture,meshEdges:this.geometry?.mesh.length??0,boneCount:this.geometry?.joints.length??0,capabilities:{images:this.playerAvailable,mesh:this.playerAvailable&&canvasAvailable,bones:this.playerAvailable&&canvasAvailable},warnings};
 }
 private unavailable(warning:string):OverlaySnapshot{return {available:false,needsCapture:false,meshEdges:0,boneCount:0,capabilities:{images:false,mesh:false,bones:false},warnings:[warning]};}
}
