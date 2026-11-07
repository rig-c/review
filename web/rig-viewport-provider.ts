/** Existing compiled rig/reference rendering for the shared inspection viewport. */
import type {ModelAssets,RigPlayer,PoseBounds,PosedFrame} from '@rig-c/play';
import type {ViewportProvider,ViewportState,ViewportController} from './viewport-controller.ts';
import {dragImpulse} from '../src/environment.ts';
import {CLICK_SLOP_PX} from './stage-pick.ts';
export interface RigViewportHost {
 el:ViewportProvider['el'];player:()=>RigPlayer|null;assets:()=>ModelAssets|null;
 referenceSize:()=>{width:number;height:number}|null;view:()=>string;referenceGeneration:()=>number;
 parts:()=>{value:()=>unknown;bounds:()=>PoseBounds|null;frame?:(side:'single')=>PosedFrame|undefined}|null;
 text:(id:string,value:string)=>void;message:ViewportProvider['message'];redrawOverlay:(fresh:boolean)=>void;
}
export function createRigViewportProvider(host:RigViewportHost,state:ViewportState):ViewportProvider {
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
  if (!referenceSize || !paneFrame('reference')) return;
  const viewport = el('reference-viewport'), content = el('reference-content');
  const scale = state.referenceScale = Math.max(.001,Math.min((viewport.clientWidth - 24) / referenceSize.width, (viewport.clientHeight - 56) / referenceSize.height) * state.referenceZoom);
  const center=state.referenceCenter??{x:referenceSize.width/2,y:referenceSize.height/2};
  content.style.left = `${viewport.clientWidth/2-center.x*scale}px`;
  content.style.top = `${viewport.clientHeight/2-center.y*scale}px`;
  content.style.transform = `scale(${scale})`;
}

function render(controller:ViewportController): void {
  const player=host.player(),assets=host.assets();const {paneFrame,renderNumericView,renderCameraControls}=controller;
  referenceFit(controller);renderNumericView();renderCameraControls();
  if (!player || !assets) return;
  const box=rigFramingBox();if(!box||box.width<=0||box.height<=0)return;
  const viewport = el('rig-viewport');if(!paneFrame('rig'))return;
  const scale = state.rigScale = Math.max(.001,Math.min((viewport.clientWidth - 28) / box.width, (viewport.clientHeight - 58) / box.height) * state.zoom);
  const center = state.cameraCenter ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };state.displayedCenter={...center};
  const root = el('rig-root'); root.style.left = `${viewport.clientWidth / 2 - center.x * scale}px`; root.style.top = `${viewport.clientHeight / 2 + center.y * scale}px`; root.style.transform = `scale(${scale})`;
  player.renderer.syncPixelRatio();redrawOverlay(false);renderNumericView();
}

function renderControls(controller:ViewportController):void {const {availableCamera,paneCamera}=controller;input('camera-sync').checked=state.cameraSync;const target=availableCamera();text('zoom-value',`${Math.round((target?paneCamera(target).zoom:1)*100)}% · ${target==='reference'?'Reference':'Rig'}`);button('fit').textContent=state.cameraSync?'Fit views':'Fit active';text('coordinates',state.cameraSync?'Cameras synchronized · drag to pan · scroll to zoom':'Independent cameras · drag to pan · scroll to zoom');}
 return {el,message,render,renderControls,
 geometry:target=>{const referenceSize=host.referenceSize();const box=target==='rig'?rigFramingBox():referenceSize?{x:0,y:0,...referenceSize}:null;if(!box)return null;return {space:target==='rig'?'world':'image',box,marginX:target==='rig'?28:24,marginY:target==='rig'?58:56};},
 layoutKey:()=>{const player=host.player(),referenceSize=host.referenceSize(),view=host.view(),referenceGeneration=host.referenceGeneration();const boxKey=rigFramingBox();return ['rig','reference'].map(target=>{const v=el(target+'-viewport');return `${v.clientWidth}:${v.clientHeight}`;}).join('|')+view+referenceGeneration+!!player+JSON.stringify(referenceSize)+JSON.stringify(boxKey);},
 selection:target=>{const parts=host.parts(),part=parts?.value();return {selected:!!part,bounds:target==='rig'&&part?parts?.bounds()??null:null};}
 };
}
export function rigPanCarry(host:Pick<RigViewportHost,'player'>,state:ViewportState){return {threshold:CLICK_SLOP_PX,move:(dx:number,dy:number)=>{const player=host.player(),rigScale=state.rigScale;const impulse=dragImpulse(dx,dy,rigScale);if(impulse&&player)player.moved(impulse);}};}
