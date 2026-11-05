/** Native image policy for the canonical pair. Camera gestures and writes belong to viewport-controller. */
import {createViewportController,createViewportState,type ViewportProvider} from './viewport-controller.ts';
import {t} from './i18n.ts';
export function createPartsViewport(host:{el:ViewportProvider['el'];canvas:HTMLCanvasElement;message:ViewportProvider['message'];reference:()=>HTMLCanvasElement|null}){
 const state=createViewportState();state.cameraSync=false;
 const provider:ViewportProvider={el:host.el,message:host.message,nativeScale:true,
 panes:(['rig','reference'] as const).map(target=>({target,viewport:host.el(target+'-viewport'),pane:host.el(target+'-pane')})),
 geometry:target=>{const canvas=target==='rig'?host.canvas:host.reference();return canvas?{space:'image',box:{x:0,y:0,width:canvas.width,height:canvas.height},marginX:24,marginY:24}:null;},
 layoutKey:()=>[host.canvas.width,host.canvas.height,host.el('rig-viewport').clientWidth,host.el('rig-viewport').clientHeight].join(':'),selection:()=>({selected:false,bounds:null}),
 render:controller=>{for(const target of ['rig','reference'] as const){const frame=controller.paneFrame(target);if(!frame)continue;const c=controller.paneCamera(target),center=c.center??frame.center,root=host.el(target==='rig'?'rig-root':'reference-content');root.style.left=`${frame.width/2-center.x*c.zoom}px`;root.style.top=`${frame.height/2-center.y*c.zoom}px`;root.style.transform=`scale(${c.zoom})`;if(target==='rig'){state.rigScale=c.zoom;state.displayedCenter={...center};}}controller.renderCameraControls();},
 renderControls:controller=>{const zoom=controller.paneCamera(controller.availableCamera()??'rig').zoom;host.el('zoom-value').textContent=zoom===1?t('1:1'):`${(zoom*100).toFixed(1)}%`;host.el('native-one').setAttribute('aria-pressed',String(zoom===1));(host.el('camera-sync') as HTMLInputElement).checked=state.cameraSync;host.el('fit').textContent=t('Fit');}
 };
 return createViewportController(provider,state);
}
