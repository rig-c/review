/** Native image policy for the canonical pair. Camera gestures and writes belong to viewport-controller. */
import {createViewportController,createViewportState,type CameraTarget,type ViewportProvider} from './viewport-controller.ts';
import {t} from './i18n.ts';

export function createPartsViewport(host:{el:ViewportProvider['el'];canvas:HTMLCanvasElement;message:ViewportProvider['message'];reference:()=>HTMLCanvasElement|null;frameSize:(target:CameraTarget)=>{w:number;h:number}|null}){
 const state=createViewportState();state.cameraSync=false;
 let dimensionProbe:HTMLCanvasElement|undefined;
 const ordinaryExtent=(value:number)=>Number.isInteger(value)&&value>=0&&value<=0x7fffffff;
 const canvasSize=(size:{w:number;h:number})=>{
  if(ordinaryExtent(size.w)&&ordinaryExtent(size.h))return {width:size.w,height:size.h};
  // Match the browser's canvas IDL conversion even for legacy fractional or clipped dimensions.
  const probe=dimensionProbe??=document.createElement('canvas');
  probe.width=size.w;probe.height=size.h;
  return {width:probe.width,height:probe.height};
 };
 const provider:ViewportProvider={el:host.el,message:host.message,nativeScale:true,
 panes:(['rig','reference'] as const).map(target=>({target,viewport:host.el(target+'-viewport'),pane:host.el(target+'-pane')})),
 geometry:target=>{
  const declared=host.frameSize(target);
  const size=declared?canvasSize(declared):target==='rig'?host.canvas:host.reference();
  if(!size)return null;
  const {width,height}=size;
  return {space:'image',box:{x:0,y:0,width,height},marginX:24,marginY:24};
 },
 layoutKey:()=>[host.canvas.width,host.canvas.height,host.reference()?.width??0,host.reference()?.height??0,host.el('rig-viewport').clientWidth,host.el('rig-viewport').clientHeight].join(':'),selection:()=>({selected:false,bounds:null}),
 render:controller=>{
  // Translated controls can wrap the toolbar and resize its sibling panes.
  controller.renderCameraControls();
  for(const target of ['rig','reference'] as const){
   const frame=controller.paneFrame(target);if(!frame)continue;
   const c=controller.paneCamera(target),center=c.center??frame.center;
   const root=host.el(target==='rig'?'rig-root':'reference-content');
   root.style.left=`${frame.width/2-center.x*c.zoom}px`;
   root.style.top=`${frame.height/2-center.y*c.zoom}px`;
   root.style.transform=`scale(${c.zoom})`;
   if(target==='rig'){state.rigScale=c.zoom;state.displayedCenter={...center};}
  }
 },
 renderControls:controller=>{const zoom=controller.paneCamera(controller.availableCamera()??'rig').zoom;host.el('zoom-value').textContent=zoom===1?'100%':`${(zoom*100).toFixed(1)}%`;host.el('native-one').setAttribute('aria-pressed',String(zoom===1));(host.el('camera-sync') as HTMLInputElement).checked=state.cameraSync;host.el('fit').textContent=t('Fit');}
 };
 return createViewportController(provider,state);
}
