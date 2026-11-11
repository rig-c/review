/** The existing single inspection camera controller, detached from its model provider. */
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraPoint,type CameraSignature,type PaneCamera} from './camera-view.ts';
import {bindPan,bindStageLayout,type PanCarry,type ViewPoint} from './view-controls.ts';
import {numericCamera} from './inspection-persistence.ts';
import type {ControlView} from '../src/control.ts';
export type CameraTarget='rig'|'reference'|'a'|'b';
export interface ViewportState {
 cameraSync:boolean;activeCamera:CameraTarget;cameraRestoring:boolean;cameraLayout:string;
 cameraFrames:Partial<Record<CameraTarget,CameraFrame>>;
 /** Optional named cameras; the canonical pair retains its existing state fields. */
 cameras?:Partial<Record<CameraTarget,PaneCamera>>;
 zoom:number;cameraCenter:ViewPoint|null;referenceCenter:ViewPoint|null;
 rigScale:number;referenceScale:number;referenceZoom:number;displayedCenter:ViewPoint|null;
}
export function createViewportState():ViewportState {return {cameraSync:true,activeCamera:'rig',cameraRestoring:false,cameraLayout:'',cameraFrames:{},zoom:1,cameraCenter:null,referenceCenter:null,rigScale:1,referenceScale:1,referenceZoom:1,displayedCenter:null};}
export interface ViewportGeometry {space:'world'|'image';box:{x:number;y:number;width:number;height:number};marginX:number;marginY:number}
export interface ViewportProvider {
 /** Real mounted panes; the canonical rig host uses the default pair. */
 panes?:{target:CameraTarget;viewport:HTMLElement;pane:HTMLElement;fallback?:CameraTarget}[];
 /** Legacy layouts determine visibility by measured dimensions, including cached replay. */
 dimensionVisibility?:boolean;
 fitMargins?:{x:number;y:number};
 fitMessage?:(selected:boolean)=>string;
 /** False retains hosts whose navigation never supplied a two-touch gesture. */
 pinch?:boolean;
 nativeScale?:boolean;
 el:<T extends HTMLElement=HTMLElement>(id:string)=>T;
 geometry:(target:CameraTarget)=>ViewportGeometry|null;
 layoutKey:()=>string;
 render:(controller:ViewportController)=>void;
 renderControls:(controller:ViewportController)=>void;
 selection:(target:CameraTarget)=>{selected:boolean;bounds:{x:number;y:number;width:number;height:number}|null};
 message:(value:string,error?:boolean)=>void;
}
export interface ViewportController {
 /** Center the target at one CSS px per current pane coordinate unit, or throw before any camera changes.
  * Synchronized peers retain the target's relative signature, not necessarily its unit scale. */
 unitScaleCamera:(target?:CameraTarget|null)=>void;
 /** Owe the view a Fit: it lands once the active pane has a measured size, and a later layout size fits it again
  * until any camera is written (a person's pan, zoom or Fit, a restore). */
 requestFit:()=>void;
 /** Drop an owed or held Fit, for a caller that sets the camera itself (a restored bookmark). */
 cancelFit:()=>void;
 state:ViewportState;paneFrame:(target:CameraTarget,hidden?:boolean)=>CameraFrame|null;paneCamera:(target:CameraTarget)=>PaneCamera;writeCamera:(target:CameraTarget,value:PaneCamera)=>void;activateCamera:(target:CameraTarget)=>void;availableCamera:()=>CameraTarget|null;alignCameras:()=>void;renderCameraControls:()=>void;setCameraSync:(value:boolean)=>void;cameraAction:(action:()=>void)=>void;updateCamera:(target:CameraTarget,value:CameraSignature,group?:readonly CameraTarget[])=>void;zoomCamera:(factor:number,target?:CameraTarget|null,point?:CameraPoint|null)=>void;panCamera:(target:CameraTarget,dx:number,dy:number)=>void;fitActiveCamera:(target?:CameraTarget|null)=>void;fitSelection:(target?:CameraTarget|null)=>void;zoomViewport:(target:CameraTarget,deltaY:number,point?:CameraPoint|null)=>void;fitCamera:()=>void;numericView:()=>ControlView;renderNumericView:()=>void;bindControls:()=>()=>void;bindNavigation:(carryRig?:PanCarry|((target:CameraTarget)=>PanCarry|undefined),enabled?:()=>boolean)=>()=>void;observeResize:()=>ResizeObserver;
}

export function createViewportController(provider:ViewportProvider,state=createViewportState()):ViewportController {
 const {el,message}=provider;const panes=():NonNullable<ViewportProvider['panes']>=>provider.panes??(['rig','reference'] as const).map(target=>({target,viewport:el(target+'-viewport'),pane:el(target+'-pane')}));const targets=()=>panes().map(p=>p.target);const paneNodes=(target:CameraTarget)=>panes().find(p=>p.target===target);
 const range=(frame:CameraFrame)=>provider.nativeScale?{min:Math.min(frame.fitScale??1,1),max:16}:{min:.25,max:8};const from=(value:CameraSignature,frame:CameraFrame)=>{const limits=range(frame);if(provider.nativeScale&&(!Number.isFinite(value.zoom)||value.zoom<limits.min||value.zoom>limits.max))throw new Error('PARTS_CAMERA_RANGE: native zoom outside supported range');return cameraFromSignature(value,frame,limits);};const input=(id:string)=>el<HTMLInputElement>(id),button=(id:string)=>el<HTMLButtonElement>(id);
function paneFrame(target:CameraTarget,hidden=false):CameraFrame|null {
 const nodes=paneNodes(target);if(!nodes)return null;
 const {viewport,pane,fallback}=nodes;
 let width=viewport.clientWidth,height=viewport.clientHeight;
 if(provider.dimensionVisibility&&(width<=0||height<=0)){
  if(!hidden)return null;if(state.cameraFrames[target])return state.cameraFrames[target]!;
  const sibling=fallback&&paneNodes(fallback);if(sibling){width=sibling.viewport.clientWidth;height=sibling.viewport.clientHeight;}
  if(width<=0||height<=0)return null;
 }
 const geometry=provider.geometry(target);
 if(!geometry){if(!provider.dimensionVisibility)delete state.cameraFrames[target];return null;}
 if(!provider.dimensionVisibility&&(pane.hidden||width<=0||height<=0))return hidden?state.cameraFrames[target]??null:null;
 const frame=cameraFrame(geometry.space,geometry.box,width,height,geometry.marginX,geometry.marginY);
 if(frame&&provider.nativeScale){frame.fitScale=frame.baseScale;frame.baseScale=1;}
 if(frame)state.cameraFrames[target]=frame;return frame;
}
function paneCamera(target:CameraTarget){return state.cameras?.[target]??(target==='rig'?{zoom:state.zoom,center:state.cameraCenter}:{zoom:state.referenceZoom,center:state.referenceCenter});}
// Fit owed until a pane is measured (`owed`), then held (`held`) and repeated on a new layout until another camera write.
let fitOwed=false,fitHeld=false,fitting=false;
/** True once the Fit landed (the camera update has rendered). Each measured pane fits its own frame, so a synchronized
 * peer of another size is never handed a zoom outside its own range; a refused Fit stays owed and never throws. */
function settleFit():boolean {
 if(fitting||state.cameraRestoring||(!fitOwed&&!fitHeld))return false;
 const target=availableCamera();if(!target||!paneFrame(target))return false;
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={};
 try{for(const other of targets()){const frame=paneFrame(other);if(frame)updates[other]=from({zoom:provider.nativeScale?Math.min(frame.fitScale??1,16):1,pan:{x:0,y:0}},frame);}}catch{return false;}
 fitting=true;
 try{for(const other of targets()){const update=updates[other];if(update)writeCamera(other,update);}state.activeCamera=target;fitOwed=false;fitHeld=true;fitCamera();renderCameraControls();return true;}
 finally{fitting=false;}
}
function requestFit():void {fitOwed=true;fitHeld=false;void settleFit();}
function cancelFit():void {fitOwed=false;fitHeld=false;}
function writeCamera(target:CameraTarget,value:ReturnType<typeof cameraFromSignature>):void {if(!fitting)cancelFit();if(provider.nativeScale){const frame=paneFrame(target);if(frame){const limits=range(frame);if(!Number.isFinite(value.zoom)||value.zoom<limits.min||value.zoom>limits.max)throw new Error('PARTS_CAMERA_RANGE: native zoom outside supported range');assertCameraView(value,frame,limits);}}if(state.cameras){state.cameras[target]=value;}else if(target==='rig'){state.zoom=value.zoom;state.cameraCenter=value.center;}else{state.referenceZoom=value.zoom;state.referenceCenter=value.center;}}
function activateCamera(target:CameraTarget):void {if(paneFrame(target)){state.activeCamera=target;renderCameraControls();}}
function availableCamera():CameraTarget|null {return paneFrame(state.activeCamera)?state.activeCamera:targets().find(target=>paneFrame(target))??null;}
function alignCameras():void {
 const target=availableCamera();if(!target)return;
 // Aligning peers to the active camera keeps an owed or held Fit: only the peers move, to the active pane's signature.
 const wasFitting=fitting;fitting=true;try{alignPeers(target);}finally{fitting=wasFitting;}
}
function alignPeers(target:CameraTarget):void {
 const frame=paneFrame(target)!;assertCameraView(paneCamera(target),frame,range(frame));const signature=cameraSignature(paneCamera(target),frame);
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={};
 for(const other of targets()){if(other===target)continue;const next=paneFrame(other);if(next)updates[other]=from(signature,next);}
 for(const other of targets()){const update=updates[other];if(update)writeCamera(other,update);}state.activeCamera=target;
}
function renderCameraControls():void {provider.renderControls(api);}
function setCameraSync(value:boolean):void {if(value)alignCameras();state.cameraSync=value;fitCamera();renderCameraControls();}
function cameraAction(action:()=>void):void {try{action();}catch(error){renderCameraControls();message(error instanceof Error?error.message:String(error),true);}}
function updateCamera(target:CameraTarget,value:CameraSignature,group:readonly CameraTarget[]=[]):void {
 const frame=paneFrame(target);if(!frame)return;
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={[target]:from(value,frame)};
 for(const other of targets()){if(other===target||!state.cameraSync&&!group.includes(other))continue;const next=paneFrame(other);if(next)updates[other]=from(value,next);}
 for(const other of targets()){const update=updates[other];if(update)writeCamera(other,update);}state.activeCamera=target;
 fitCamera();renderCameraControls();
}
function zoomCamera(factor:number,target=availableCamera(),point?:CameraPoint|null):void {if(!target)return;const frame=paneFrame(target);if(frame)updateCamera(target,zoomSignature(cameraSignature(paneCamera(target),frame),factor,frame,point,provider.nativeScale?range(frame):undefined));}
function unitScaleCamera(target=availableCamera()):void {
 if(!target)throw new Error('CONTROL_CAMERA_UNAVAILABLE');
 // Never use the cached frame of a hidden or zero-sized pane for this action.
 const frame=paneFrame(target);
 if(!frame)throw new Error('CONTROL_CAMERA_UNAVAILABLE');
 const zoom=1/frame.baseScale;
 // Validate the exact reciprocal, without wheel zoom's clamping. updateCamera
 // prepares every synchronized candidate before assigning any live camera.
 assertCameraView({zoom,center:frame.center},frame,range(frame));
 updateCamera(target,{zoom,pan:{x:0,y:0}});
}
function panCamera(target:CameraTarget,dx:number,dy:number):void {const frame=paneFrame(target);if(frame)updateCamera(target,dragSignature(cameraSignature(paneCamera(target),frame),frame,dx,dy));}
function fitActiveCamera(target=availableCamera()):void {if(!target)return;if(provider.nativeScale){const frame=paneFrame(target);if(frame)updateCamera(target,{zoom:Math.min(frame.fitScale??1,16),pan:{x:0,y:0}});return;}const part=provider.selection(target);if(target!=='reference'&&part.selected){const box=part.bounds,frame=paneFrame(target);if(!box||!frame){message('PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',true);return;}const margin=provider.fitMargins??{x:28,y:58};updateCamera(target,boundsFitSignature(box,frame,margin.x,margin.y));message(provider.fitMessage?.(true)??'Selected slot fitted.');}else{if(!paneFrame(target))return;updateCamera(target,{zoom:1,pan:{x:0,y:0}});message(provider.fitMessage?.(false)??'View fitted.');}}
function zoomViewport(target:CameraTarget,deltaY:number,point?:CameraPoint|null):void {zoomCamera(deltaY<0?1.1:1/1.1,target,point);}


 function fitCamera():void {
 const layout=provider.layoutKey(),relaid=layout!==state.cameraLayout;
 // An owed or held Fit settles first: it fits every pane to its own frame, so there is nothing left to align.
 if(!fitting&&(fitOwed||fitHeld&&relaid)){state.cameraLayout=layout;if(settleFit())return;}
 if(provider.nativeScale&&state.cameraSync&&!state.cameraRestoring&&!fitting&&relaid){
  const visible=targets().flatMap(target=>{const frame=paneFrame(target);return frame?[{target,frame}]:[];});
  const minimum=Math.max(...visible.map(({frame})=>range(frame).min)),maximum=Math.min(...visible.map(({frame})=>range(frame).max));
  for(const {target}of visible){
   const camera=paneCamera(target),zoom=Math.max(minimum,Math.min(maximum,camera.zoom));
   if(zoom!==camera.zoom)writeCamera(target,{zoom,center:camera.center});
  }
 }
 if(state.cameraSync&&!state.cameraRestoring&&!fitting&&relaid)alignCameras();state.cameraLayout=layout;
 provider.render(api);
 }
function numericView():ControlView {
 // ResizeObserver delivery can follow a pointer event. Keep native-image evidence
 // on the same freshly rendered layout before exporting its camera coordinates.
 if(provider.nativeScale&&provider.layoutKey()!==state.cameraLayout)fitCamera();
 const numeric=(target:CameraTarget)=>{const frame=paneFrame(target,true);if(!frame)return null;const camera=paneCamera(target);if(provider.nativeScale){const center=camera.center??frame.center;return {space:frame.space,center,zoom:camera.zoom,viewport:{width:frame.width,height:frame.height},visible:{x:center.x-frame.width/camera.zoom/2,y:center.y-frame.height/camera.zoom/2,width:frame.width/camera.zoom,height:frame.height/camera.zoom}};}return numericCamera(frame.space,camera.center??frame.center,camera.zoom,frame.baseScale*camera.zoom,frame.width,frame.height);};
 const cameras:ControlView['cameras']={rig:null,a:null,b:null,reference:null};for(const target of targets())cameras[target]=numeric(target);
 return {schema:'rig-review-view/1',cameraSync:state.cameraSync,activeCamera:state.activeCamera,cameras};
}
function renderNumericView():void {const node=document.getElementById('view-coordinates');if(node)node.textContent=JSON.stringify(numericView(),null,2);}

 function bindControls():()=>void {
  button('zoom-in').onclick=()=>cameraAction(()=>zoomCamera(1.25));button('zoom-out').onclick=()=>cameraAction(()=>zoomCamera(1/1.25));button('fit').onclick=()=>cameraAction(()=>fitActiveCamera());
  input('camera-sync').onchange=()=>cameraAction(()=>setCameraSync(input('camera-sync').checked));
  const disposers:(()=>void)[]=[];
  for(const {target,viewport}of panes()){
   const activate=()=>activateCamera(target);
   const wheel=(event:WheelEvent)=>{event.preventDefault();const rect=viewport.getBoundingClientRect();cameraAction(()=>zoomViewport(target,event.deltaY,{x:event.clientX-rect.left,y:event.clientY-rect.top}));};
   for(const event of ['pointerdown','focusin'] as const){viewport.addEventListener(event,activate);disposers.push(()=>viewport.removeEventListener(event,activate));}
   viewport.addEventListener('wheel',wheel,{passive:false});disposers.push(()=>viewport.removeEventListener('wheel',wheel));
  }
  return ()=>{for(const dispose of disposers)dispose();for(const id of ['zoom-in','zoom-out','fit'])button(id).onclick=null;input('camera-sync').onchange=null;};
 }
 function bindNavigation(carryRig?:PanCarry|((target:CameraTarget)=>PanCarry|undefined),enabled:()=>boolean=()=>true):()=>void {
 const disposers:(()=>void)[]=[];disposers.push(bindStageLayout(el('stage-layout'),fitCamera));
  for(const {target,viewport}of panes())disposers.push(bindPan(viewport,(dx,dy)=>cameraAction(()=>panCamera(target,dx,dy)),enabled,typeof carryRig==='function'?carryRig(target):target==='rig'?carryRig:undefined,provider.pinch===false?undefined:(factor,at,delta)=>cameraAction(()=>{zoomCamera(factor,target,at);panCamera(target,delta.x,delta.y);})));
 return ()=>disposers.forEach(dispose=>dispose());
 }
 function observeResize():ResizeObserver {const resize=new ResizeObserver(fitCamera);for(const {viewport}of panes())resize.observe(viewport);return resize;}
 const api={state,requestFit,cancelFit,paneFrame,paneCamera,writeCamera,activateCamera,availableCamera,alignCameras,renderCameraControls,setCameraSync,cameraAction,updateCamera,zoomCamera,unitScaleCamera,panCamera,fitActiveCamera,fitSelection:fitActiveCamera,zoomViewport,fitCamera,numericView,renderNumericView,bindControls,bindNavigation,observeResize};return api;
}
