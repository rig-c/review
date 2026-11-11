/** Existing compiled rig/reference rendering for the shared inspection viewport. */
import type {ModelAssets,RigPlayer,PoseBounds,PosedFrame} from '@rig-c/play';
import type {CameraTarget,ViewportProvider,ViewportState,ViewportController} from './viewport-controller.ts';
import {cameraSignature} from './camera-view.ts';
import {dragImpulse} from '../src/environment.ts';
import {CLICK_SLOP_PX} from './stage-pick.ts';
import {createPartsViewportProvider,type PartsViewportHost} from './parts-viewport-provider.ts';
export interface RigViewportHost {
 fitLabel?:string;el:ViewportProvider['el'];player:()=>RigPlayer|null;assets:()=>ModelAssets|null;
 referenceSize:()=>{width:number;height:number}|null;view:()=>string;referenceGeneration:()=>number;
 parts:()=>{value:()=>unknown;bounds:()=>PoseBounds|null;frame?:(side:'single')=>PosedFrame|undefined}|null;
 text:(id:string,value:string)=>void;message:ViewportProvider['message'];redrawOverlay:(fresh:boolean)=>void;
 /** Additional compiled panes share the renderer while retaining their declared framing basis. */
 panes?:{target:CameraTarget;viewport:HTMLElement;pane:HTMLElement;root:HTMLElement;fallback?:CameraTarget;
  box:()=>PoseBounds|null;player:()=>RigPlayer|null;scale:(value:number)=>void}[];
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
export function createRigViewportProvider(host:RigViewportHost,state:ViewportState):ViewportProvider {
 const raster=host.raster?createPartsViewportProvider(host.raster,state):null;
 const rasterActive=()=>!!host.raster?.active();
 const {el,text,message,redrawOverlay}=host;const input=(id:string)=>el<HTMLInputElement>(id),button=(id:string)=>el<HTMLButtonElement>(id);
 const framingBoxes=new WeakMap<RigPlayer,{assets:ModelAssets|null;box:PoseBounds}>();
 function positiveBounds(box:PoseBounds|null|undefined):box is PoseBounds {
  return !!box&&box.width>0&&box.height>0&&[box.x,box.y,box.width,box.height,box.x+box.width,box.y+box.height].every(Number.isFinite);
 }
 function rigFramingBox():PoseBounds|null {
  const player=host.player(),assets=host.assets();if(!player)return null;
  const declared=assets?.stage;
  // A model without a positive declared stage keeps its existing live pose/filter basis.
  if(!positiveBounds(declared))return player.bounds();
  const cached=framingBoxes.get(player);if(cached&&cached.assets===assets)return cached.box;
  const stage={...declared},frame=host.parts()?.frame?.('single');
  // present() records a successful draw. A prepared pose or later player slot filter
  // must not become the whole-rig framing basis merely because bounds() is positive.
  if(!frame||frame.generation===undefined||frame.generation!==player.generation||player.slots!==null)return stage;
  const drawn=player.bounds();
  if(!positiveBounds(drawn))return stage;
  const x=Math.min(stage.x,drawn.x),y=Math.min(stage.y,drawn.y);
  const box={x,y,width:Math.max(stage.x+stage.width,drawn.x+drawn.width)-x,
   height:Math.max(stage.y+stage.height,drawn.y+drawn.height)-y};
  if(!positiveBounds(box))return null;
  // bounds() follows the live pose/filter. Keep one framing basis per loaded player/assets,
  // including when a semantic publication is temporarily replaced and then restored.
  framingBoxes.set(player,{assets,box});return box;
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
  if(!host.panes){referenceFit(controller);renderNumericView();renderCameraControls();}
  const panes=host.panes??(player&&assets?[{target:'rig' as const,viewport:el('rig-viewport'),root:el('rig-root'),box:rigFramingBox,player:()=>player,scale:(value:number)=>{state.rigScale=value;}}]:[]);
  let drawn=false;
  for(const pane of panes){
   const box=pane.box();if(!box||box.width<=0||box.height<=0)continue;
   const frame=paneFrame(pane.target);if(!frame)continue;
   const camera=controller.paneCamera(pane.target),center=camera.center??frame.center;
   const scale=host.panes?frame.baseScale*camera.zoom:Math.max(.001,Math.min((pane.viewport.clientWidth-28)/box.width,(pane.viewport.clientHeight-58)/box.height)*camera.zoom);
   pane.scale(scale);if(!host.panes)state.displayedCenter={...center};
   const {root,viewport}=pane;root.style.left=`${viewport.clientWidth/2-center.x*scale}px`;root.style.top=`${viewport.clientHeight/2+center.y*scale}px`;root.style.transform=`scale(${scale})`;
   pane.player()?.renderer.syncPixelRatio();drawn=true;
  }
  if(drawn||host.panes)redrawOverlay(false);
  if(host.panes){referenceFit(controller);renderCameraControls();renderNumericView();}else if(drawn)renderNumericView();
}

function renderControls(controller:ViewportController):void {
 const {availableCamera,paneCamera}=controller,controls=host.cameraControls;
 input('camera-sync').checked=state.cameraSync;const target=availableCamera();
 const label=controls?.targetLabel?.(target)??(target==='reference'?'Reference':'Rig');
 text(controls?.zoomId??'zoom-value',`${Math.round((target?paneCamera(target).zoom:1)*100)}% · ${label}`);
 button('fit').textContent=host.fitLabel??controls?.fitLabel?.(state.cameraSync)??(state.cameraSync?'Fit views':'Fit active');
 if(controls?.coordinatesId!==null)text(controls?.coordinatesId??'coordinates',state.cameraSync?'Cameras synchronized · drag to pan · scroll to zoom':'Independent cameras · drag to pan · scroll to zoom');
}
 return {el,message,get nativeScale(){return host.raster?rasterActive():undefined;},
 render:controller=>rasterActive()?raster!.render(controller):render(controller),
 renderControls:controller=>rasterActive()?raster!.renderControls(controller):renderControls(controller),
 ...(host.panes?{panes:[...host.panes,{target:'reference' as const,viewport:el('reference-viewport'),pane:el('reference-pane')}]}:{}),
 dimensionVisibility:host.dimensionVisibility,
 fitMargins:host.rigMargins,fitMessage:host.fitMessage,pinch:host.pinch,
 geometry:target=>{
  if(rasterActive())return raster!.geometry(target);
  const rig=target!=='reference',referenceSize=host.referenceSize(),pane=host.panes?.find(p=>p.target===target);
  const box=rig?(host.panes?(pane?.player()?pane.box():null):rigFramingBox()):referenceSize?{x:0,y:0,...referenceSize}:null;
  if(!box)return null;const margin=rig?host.rigMargins??{x:28,y:58}:host.referenceTransform?{x:0,y:0}:{x:24,y:56};
  return {space:rig?'world':'image',box,marginX:margin.x,marginY:margin.y};
 },
 layoutKey:()=>rasterActive()?'raster:'+raster!.layoutKey():(host.layoutKey?.()??(()=>{const player=host.player(),referenceSize=host.referenceSize(),view=host.view(),referenceGeneration=host.referenceGeneration();const boxKey=rigFramingBox();return ['rig','reference'].map(target=>{const v=el(target+'-viewport');return `${v.clientWidth}:${v.clientHeight}`;}).join('|')+view+referenceGeneration+!!player+JSON.stringify(referenceSize)+JSON.stringify(boxKey);})()),
 selection:target=>rasterActive()?raster!.selection(target):(host.selection?.(target)??(()=>{const parts=host.parts(),part=parts?.value();return {selected:!!part,bounds:target==='rig'&&part?parts?.bounds()??null:null};})())
 };
}
export function rigPanCarry(host:Pick<RigViewportHost,'player'>,state:ViewportState){return {threshold:CLICK_SLOP_PX,move:(dx:number,dy:number)=>{const player=host.player(),rigScale=state.rigScale;const impulse=dragImpulse(dx,dy,rigScale);if(impulse&&player)player.moved(impulse);}};}
