/** The existing single inspection camera controller, detached from its model provider. */
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraPoint,type CameraSignature} from './camera-view.ts';
import {bindPan,bindStageLayout,type PanCarry,type ViewPoint} from './view-controls.ts';
import {numericCamera} from './inspection-persistence.ts';
import type {ControlView} from '../src/control.ts';
export type CameraTarget='rig'|'reference';
export interface ViewportState {
 cameraSync:boolean;activeCamera:CameraTarget;cameraRestoring:boolean;cameraLayout:string;
 cameraFrames:Partial<Record<CameraTarget,CameraFrame>>;
 zoom:number;cameraCenter:ViewPoint|null;referenceCenter:ViewPoint|null;
 rigScale:number;referenceScale:number;referenceZoom:number;displayedCenter:ViewPoint|null;
}
export function createViewportState():ViewportState {return {cameraSync:true,activeCamera:'rig',cameraRestoring:false,cameraLayout:'',cameraFrames:{},zoom:1,cameraCenter:null,referenceCenter:null,rigScale:1,referenceScale:1,referenceZoom:1,displayedCenter:null};}
export interface ViewportGeometry {space:'world'|'image';box:{x:number;y:number;width:number;height:number};marginX:number;marginY:number}
export interface ViewportProvider {
 el:<T extends HTMLElement=HTMLElement>(id:string)=>T;
 geometry:(target:CameraTarget)=>ViewportGeometry|null;
 layoutKey:()=>string;
 render:(controller:ViewportController)=>void;
 renderControls:(controller:ViewportController)=>void;
 selection:(target:CameraTarget)=>{selected:boolean;bounds:{x:number;y:number;width:number;height:number}|null};
 message:(value:string,error?:boolean)=>void;
}
export interface ViewportController {
 state:ViewportState;paneFrame:(target:CameraTarget,hidden?:boolean)=>CameraFrame|null;paneCamera:(target:CameraTarget)=>{zoom:number;center:ViewPoint|null};writeCamera:(target:CameraTarget,value:{zoom:number;center:ViewPoint|null})=>void;activateCamera:(target:CameraTarget)=>void;availableCamera:()=>CameraTarget|null;alignCameras:()=>void;renderCameraControls:()=>void;setCameraSync:(value:boolean)=>void;cameraAction:(action:()=>void)=>void;updateCamera:(target:CameraTarget,value:CameraSignature)=>void;zoomCamera:(factor:number,target?:CameraTarget|null,point?:CameraPoint|null)=>void;panCamera:(target:CameraTarget,dx:number,dy:number)=>void;fitActiveCamera:(target?:CameraTarget|null)=>void;zoomViewport:(target:CameraTarget,deltaY:number,point?:CameraPoint|null)=>void;fitCamera:()=>void;numericView:()=>ControlView;renderNumericView:()=>void;bindControls:()=>void;bindNavigation:(carryRig?:PanCarry,enabled?:()=>boolean)=>()=>void;observeResize:()=>ResizeObserver;
}

export function createViewportController(provider:ViewportProvider,state=createViewportState()):ViewportController {
 const {el,message}=provider;const input=(id:string)=>el<HTMLInputElement>(id),button=(id:string)=>el<HTMLButtonElement>(id);
function paneFrame(target:CameraTarget,hidden=false):CameraFrame|null {
 const viewport=el(target+'-viewport'),pane=el(target+'-pane'),geometry=provider.geometry(target);
 if(!geometry){delete state.cameraFrames[target];return null;}
 if(pane.hidden||viewport.clientWidth<=0||viewport.clientHeight<=0)return hidden?state.cameraFrames[target]??null:null;
 const frame=cameraFrame(geometry.space,geometry.box,viewport.clientWidth,viewport.clientHeight,geometry.marginX,geometry.marginY);
 if(frame)state.cameraFrames[target]=frame;return frame;
}
function paneCamera(target:CameraTarget){return target==='rig'?{zoom:state.zoom,center:state.cameraCenter}:{zoom:state.referenceZoom,center:state.referenceCenter};}
function writeCamera(target:CameraTarget,value:ReturnType<typeof cameraFromSignature>):void {if(target==='rig'){state.zoom=value.zoom;state.cameraCenter=value.center;}else{state.referenceZoom=value.zoom;state.referenceCenter=value.center;}}
function activateCamera(target:CameraTarget):void {if(paneFrame(target)){state.activeCamera=target;renderCameraControls();}}
function availableCamera():CameraTarget|null {return paneFrame(state.activeCamera)?state.activeCamera:paneFrame('rig')?'rig':paneFrame('reference')?'reference':null;}
function alignCameras():void {
 const target=availableCamera();if(!target)return;
 const frame=paneFrame(target)!;assertCameraView(paneCamera(target),frame);const signature=cameraSignature(paneCamera(target),frame);
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={};
 for(const other of ['rig','reference'] as const){if(other===target)continue;const next=paneFrame(other);if(next)updates[other]=cameraFromSignature(signature,next);}
 for(const other of ['rig','reference'] as const){const update=updates[other];if(update)writeCamera(other,update);}state.activeCamera=target;
}
function renderCameraControls():void {provider.renderControls(api);}
function setCameraSync(value:boolean):void {if(value)alignCameras();state.cameraSync=value;fitCamera();renderCameraControls();}
function cameraAction(action:()=>void):void {try{action();}catch(error){renderCameraControls();message(error instanceof Error?error.message:String(error),true);}}
function updateCamera(target:CameraTarget,value:CameraSignature):void {
 const frame=paneFrame(target);if(!frame)return;
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={[target]:cameraFromSignature(value,frame)};
 if(state.cameraSync)for(const other of ['rig','reference'] as const){if(other===target)continue;const next=paneFrame(other);if(next)updates[other]=cameraFromSignature(value,next);}
 for(const other of ['rig','reference'] as const){const update=updates[other];if(update)writeCamera(other,update);}state.activeCamera=target;
 fitCamera();renderCameraControls();
}
function zoomCamera(factor:number,target=availableCamera(),point?:CameraPoint|null):void {if(!target)return;const frame=paneFrame(target);if(frame)updateCamera(target,zoomSignature(cameraSignature(paneCamera(target),frame),factor,frame,point));}
function panCamera(target:CameraTarget,dx:number,dy:number):void {const frame=paneFrame(target);if(frame)updateCamera(target,dragSignature(cameraSignature(paneCamera(target),frame),frame,dx,dy));}
function fitActiveCamera(target=availableCamera()):void {if(!target)return;const part=provider.selection(target);if(target==='rig'&&part.selected){const box=part.bounds,frame=paneFrame(target);if(!box||!frame){message('PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',true);return;}updateCamera(target,boundsFitSignature(box,frame,28,58));message('Selected slot fitted.');}else{if(!paneFrame(target))return;updateCamera(target,{zoom:1,pan:{x:0,y:0}});message('View fitted.');}}
function zoomViewport(target:CameraTarget,deltaY:number,point?:CameraPoint|null):void {zoomCamera(deltaY<0?1.1:1/1.1,target,point);}


 function fitCamera():void {
 const layout=provider.layoutKey();
 if(state.cameraSync&&!state.cameraRestoring&&layout!==state.cameraLayout)alignCameras();state.cameraLayout=layout;
 provider.render(api);
 }
function numericView():ControlView {
 const numeric=(target:CameraTarget)=>{const frame=paneFrame(target,true);if(!frame)return null;const camera=paneCamera(target);return numericCamera(frame.space,camera.center??frame.center,camera.zoom,frame.baseScale*camera.zoom,frame.width,frame.height);};
 return {schema:'rig-review-view/1',cameraSync:state.cameraSync,activeCamera:state.activeCamera,cameras:{rig:numeric('rig'),a:null,b:null,reference:numeric('reference')}};
}
function renderNumericView():void {const node=document.getElementById('view-coordinates');if(node)node.textContent=JSON.stringify(numericView(),null,2);}

 function bindControls():void {
  button('zoom-in').onclick=()=>cameraAction(()=>zoomCamera(1.25));button('zoom-out').onclick=()=>cameraAction(()=>zoomCamera(1/1.25));button('fit').onclick=()=>cameraAction(()=>fitActiveCamera());
  input('camera-sync').onchange=()=>cameraAction(()=>setCameraSync(input('camera-sync').checked));
  for(const target of ['rig','reference'] as const)for(const event of ['pointerdown','focusin'] as const)el(target+'-viewport').addEventListener(event,()=>activateCamera(target));
  for (const id of ['reference-viewport', 'rig-viewport']) el(id).addEventListener('wheel', event => { event.preventDefault(); const rect=el(id).getBoundingClientRect(); cameraAction(()=>zoomViewport(id==='rig-viewport'?'rig':'reference',event.deltaY,{x:event.clientX-rect.left,y:event.clientY-rect.top})); }, { passive: false });
 }
 function bindNavigation(carryRig?:PanCarry,enabled:()=>boolean=()=>true):()=>void {
 const disposers:(()=>void)[]=[];disposers.push(bindStageLayout(el('stage-layout'),fitCamera));
  for(const target of ['rig','reference'] as const)disposers.push(bindPan(el(target+'-viewport'),(dx,dy)=>cameraAction(()=>panCamera(target,dx,dy)),enabled,target==='rig'?carryRig:undefined));
 return ()=>disposers.forEach(dispose=>dispose());
 }
 function observeResize():ResizeObserver {const resize=new ResizeObserver(fitCamera);resize.observe(el('rig-viewport'));resize.observe(el('reference-viewport'));return resize;}
 const api={state,paneFrame,paneCamera,writeCamera,activateCamera,availableCamera,alignCameras,renderCameraControls,setCameraSync,cameraAction,updateCamera,zoomCamera,panCamera,fitActiveCamera,zoomViewport,fitCamera,numericView,renderNumericView,bindControls,bindNavigation,observeResize};return api;
}
