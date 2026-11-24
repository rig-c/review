/** Existing compiled rig/reference rendering for the shared inspection viewport. */
import type {ModelAssets,RigPlayer,PoseBounds,PosedFrame} from '@rig-c/play';
import {formatZoomReadout,type CameraTarget,type ViewportProvider,type ViewportState,type ViewportController} from './viewport-controller.ts';
import {cameraSignature} from './camera-view.ts';
import {dragImpulse} from '../src/environment.ts';
import {CLICK_SLOP_PX} from './stage-pick.ts';
import {createPartsViewportProvider,type PartsViewportHost} from './parts-viewport-provider.ts';
type RigPane={target:CameraTarget;viewport:HTMLElement;pane:HTMLElement;root:HTMLElement;fallback?:CameraTarget;
 player:()=>RigPlayer|null;assets:()=>ModelAssets|null;drawnGeneration:()=>number|undefined;scale:(value:number)=>void};
export interface RigViewportHost {
 fitLabel?:string;el:ViewportProvider['el'];player:()=>RigPlayer|null;assets:()=>ModelAssets|null;
 referenceSize:()=>{width:number;height:number}|null;view:()=>string;referenceGeneration:()=>number;
 parts:()=>{value:()=>unknown;bounds:()=>PoseBounds|null;frame?:(side:'single')=>PosedFrame|undefined}|null;
 text:(id:string,value:string)=>void;message:ViewportProvider['message'];redrawOverlay:(fresh:boolean)=>void;
 /** Additional compiled panes share the union of their per-player framing bases. */
 panes?:RigPane[];
 /** The canonical rig and reference rectangles can temporarily display two compiled rigs. */
 pairedRig?:()=>RigPane|null;
 framingBox?:()=>PoseBounds|null;
 rigMargins?:{x:number;y:number};
 referenceTransform?:{content:HTMLElement;mode:'relative'};
 layoutKey?:ViewportProvider['layoutKey'];
 cameraControls?:{zoomId?:string;targetLabel?:(target:CameraTarget|null)=>string;
  fitLabel?:(sync:boolean)=>string;coordinatesId?:string|null};
 selection?:ViewportProvider['selection'];
 fitMessage?:ViewportProvider['fitMessage'];
 pinch?:ViewportProvider['pinch'];
 dimensionVisibility?:ViewportProvider['dimensionVisibility'];
 /** A native Setup comparison uses the existing parts raster policy on this same controller. */
 raster?:PartsViewportHost & {active:()=>boolean};
}
function unionBounds(a:PoseBounds,b:PoseBounds):PoseBounds {
 const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);
 return {x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y};
}
export function createRigViewportProvider(host:RigViewportHost,state:ViewportState):ViewportProvider {
 const raster=host.raster?createPartsViewportProvider(host.raster,state):null;
 const rasterActive=()=>!!host.raster?.active();
 const {el,text,message,redrawOverlay}=host;const input=(id:string)=>el<HTMLInputElement>(id),button=(id:string)=>el<HTMLButtonElement>(id);
 const framingBoxes=new WeakMap<RigPlayer,{assets:ModelAssets|null;box:PoseBounds}>();
 function positiveBounds(box:PoseBounds|null|undefined):box is PoseBounds {
  return !!box&&box.width>0&&box.height>0&&[box.x,box.y,box.width,box.height,box.x+box.width,box.y+box.height].every(Number.isFinite);
 }
 function rigFramingBox(player:RigPlayer|null,assets:ModelAssets|null,drawnGeneration:()=>number|undefined):PoseBounds|null {
  if(!player)return null;
  const declared=assets?.stage;
  // A model without a positive declared stage keeps its existing live pose/filter basis.
  if(!positiveBounds(declared))return player.bounds();
  const cached=framingBoxes.get(player);if(cached&&cached.assets===assets)return cached.box;
  const stage={...declared},generation=drawnGeneration();
  // The generation comes from a successful draw. A prepared pose or later player slot filter
  // must not become the whole-rig framing basis merely because bounds() is positive.
  if(generation===undefined||generation!==player.generation||player.slots!==null)return stage;
  const drawn=player.bounds();
  if(!positiveBounds(drawn))return stage;
  const box=unionBounds(stage,drawn);
  if(!positiveBounds(box))return null;
  // bounds() follows the live pose/filter. Keep one framing basis per loaded player/assets,
  // including when a semantic publication is temporarily replaced and then restored.
  framingBoxes.set(player,{assets,box});return box;
 }
 const singleFramingBox=()=>host.player()?(host.framingBox?.()??rigFramingBox(host.player(),host.assets(),()=>host.parts()?.frame?.('single')?.generation)):null;
 const rigPane=():RigPane=>({target:'rig',viewport:el('rig-viewport'),pane:el('rig-pane'),root:el('rig-root'),player:host.player,assets:host.assets,
  drawnGeneration:()=>host.parts()?.frame?.('single')?.generation,scale:value=>{state.rigScale=value;}});
 function sharedFramingBox():PoseBounds|null {
  const paired=host.pairedRig?.();
  if(paired){
   const current=singleFramingBox(),previous=rigFramingBox(paired.player(),paired.assets(),paired.drawnGeneration);
   return current&&previous?unionBounds(current,previous):current??previous;
  }
  let shared:PoseBounds|null=null;
  for(const pane of host.panes??[]){
   const box=rigFramingBox(pane.player(),pane.assets(),pane.drawnGeneration);
   if(box)shared=shared?unionBounds(shared,box):box;
  }
  return shared;
 }
function referenceFit(controller:ViewportController): void {
  const referenceSize=host.referenceSize();const {paneFrame}=controller;
  if(!referenceSize)return;const frame=paneFrame('reference');if (!frame) return;
  if(host.referenceTransform){
   const signature=cameraSignature(controller.paneCamera('reference'),frame);
   host.referenceTransform.content.style.transform=`translate(${signature.pan.x*frame.width}px,${signature.pan.y*frame.height}px) scale(${signature.zoom})`;
   return;
  }
  const viewport = el('reference-viewport'), content = el('reference-content');
  const scale = state.referenceScale = Math.max(.001,Math.min((viewport.clientWidth - 24) / referenceSize.width, (viewport.clientHeight - 56) / referenceSize.height) * state.referenceZoom);
  const center=state.referenceCenter??{x:referenceSize.width/2,y:referenceSize.height/2};
  content.style.left = `${viewport.clientWidth/2-center.x*scale}px`;
  content.style.top = `${viewport.clientHeight/2-center.y*scale}px`;
  content.style.transform = `scale(${scale})`;
}

function render(controller:ViewportController): void {
  const player=host.player(),assets=host.assets();const {paneFrame,renderNumericView,renderCameraControls}=controller;
  const paired=host.pairedRig?.(),multiple=!!(host.panes||paired);
  if(!multiple){referenceFit(controller);renderNumericView();renderCameraControls();}
  const panes=host.panes??(paired?[rigPane(),paired]:player&&assets?[rigPane()]:[]);
  let drawn=false;
  for(const pane of panes){
   const box=multiple?sharedFramingBox():singleFramingBox();if(!box||box.width<=0||box.height<=0)continue;
   const frame=paneFrame(pane.target);if(!frame)continue;
   const camera=controller.paneCamera(pane.target),center=camera.center??frame.center;
   const scale=multiple?frame.baseScale*camera.zoom:Math.max(.001,Math.min((pane.viewport.clientWidth-28)/box.width,(pane.viewport.clientHeight-58)/box.height)*camera.zoom);
   pane.scale(scale);if(!host.panes&&pane.target==='rig')state.displayedCenter={...center};
   const {root,viewport}=pane;root.style.left=`${viewport.clientWidth/2-center.x*scale}px`;root.style.top=`${viewport.clientHeight/2+center.y*scale}px`;root.style.transform=`scale(${scale})`;
   pane.player()?.renderer.syncPixelRatio();drawn=true;
  }
  if(drawn||multiple)redrawOverlay(false);
  if(multiple){if(!paired)referenceFit(controller);renderCameraControls();renderNumericView();}else if(drawn)renderNumericView();
}

function renderControls(controller:ViewportController):void {
 const controls=host.cameraControls;
 input('camera-sync').checked=!!host.pairedRig?.()||state.cameraSync;
 text(controls?.zoomId??'zoom-value',formatZoomReadout(controller,controls?.targetLabel));
 button('fit').textContent=host.fitLabel??controls?.fitLabel?.(state.cameraSync)??(state.cameraSync?'Fit views':'Fit active');
 renderCaption();
}
/** The footer names the camera mode the sync checkbox shows, on the rig and the raster paths alike. */
function renderCaption():void {
 const controls=host.cameraControls;
 if(controls?.coordinatesId!==null)text(controls?.coordinatesId??'coordinates',host.pairedRig?.()||state.cameraSync?'Cameras synchronized · drag to pan · scroll to zoom':'Independent cameras · drag to pan · scroll to zoom');
}
 return {el,message,get nativeScale(){return host.raster?rasterActive():undefined;},
 render:controller=>rasterActive()?raster!.render(controller):render(controller),
 renderControls:controller=>{if(rasterActive()){raster!.renderControls(controller);renderCaption();}else renderControls(controller);},
 ...(host.panes?{panes:[...host.panes,{target:'reference' as const,viewport:el('reference-viewport'),pane:el('reference-pane')}]}:{}),
 cameraAlias:target=>!rasterActive()&&target==='reference'&&host.pairedRig?.()?'rig':target,
 dimensionVisibility:host.dimensionVisibility,
 fitMargins:host.rigMargins,fitMessage:host.fitMessage,pinch:host.pinch,
 geometry:target=>{
  if(rasterActive())return raster!.geometry(target);
  if(host.pairedRig?.()){
   const box=sharedFramingBox(),margin=host.rigMargins??{x:28,y:58};
   return box?{space:'world',box,marginX:margin.x,marginY:margin.y}:null;
  }
  const rig=target!=='reference',referenceSize=host.referenceSize(),pane=host.panes?.find(p=>p.target===target);
  const box=rig?(host.panes?(pane?.player()?sharedFramingBox():null):singleFramingBox()):referenceSize?{x:0,y:0,...referenceSize}:null;
  if(!box)return null;const margin=rig?host.rigMargins??{x:28,y:58}:host.referenceTransform?{x:0,y:0}:{x:24,y:56};
  return {space:rig?'world':'image',box,marginX:margin.x,marginY:margin.y};
 },
 layoutKey:()=>rasterActive()?'raster:'+raster!.layoutKey():(host.layoutKey?host.layoutKey()+(host.panes?JSON.stringify(sharedFramingBox()):''):(()=>{const player=host.player(),referenceSize=host.referenceSize(),view=host.view(),referenceGeneration=host.referenceGeneration(),paired=host.pairedRig?.();const boxKey=paired?sharedFramingBox():singleFramingBox();return ['rig','reference'].map(target=>{const v=el(target+'-viewport');return `${v.clientWidth}:${v.clientHeight}`;}).join('|')+view+referenceGeneration+!!player+JSON.stringify(referenceSize)+JSON.stringify(boxKey)+(paired?'paired':'');})()),
 selection:target=>rasterActive()?raster!.selection(target):(host.selection?.(target)??(()=>{const parts=host.parts(),part=parts?.value();return {selected:!!part,bounds:target==='rig'&&part?parts?.bounds()??null:null};})())
 };
}
export function rigPanCarry(host:Pick<RigViewportHost,'player'>,state:ViewportState){return {threshold:CLICK_SLOP_PX,move:(dx:number,dy:number)=>{const player=host.player(),rigScale=state.rigScale;const impulse=dragImpulse(dx,dy,rigScale);if(impulse&&player)player.moved(impulse);}};}
