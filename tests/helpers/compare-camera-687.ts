import {readFile} from 'node:fs/promises';
import {createViewportController,createViewportState,type ViewportController} from '../../web/viewport-controller.ts';
import {createRigViewportProvider} from '../../web/rig-viewport-provider.ts';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraPoint} from '../../web/camera-view.ts';
import {numericCamera,restoredZoom,restoreTransaction,type InspectionBookmark} from '../../web/inspection-persistence.ts';
import {syncStageLayout} from '../../web/view-controls.ts';
import type {ControlView} from '../../src/control.ts';

/** DOM-free event host for the real compare provider/controller wiring. */
export class CameraNode {
 constructor(public clientWidth=600,public clientHeight=400){}
 hidden=false;style:Record<string,string>={};dataset:Record<string,string>={};checked=true;textContent='';
 handlers=new Map<string,Function[]>();captured=new Set<number>();
 addEventListener(key:string,fn:Function){this.handlers.set(key,[...this.handlers.get(key)??[],fn]);}
 removeEventListener(key:string,fn:Function){this.handlers.set(key,(this.handlers.get(key)??[]).filter(value=>value!==fn));}
 emit(key:string,value:Record<string,unknown>={}){for(const fn of this.handlers.get(key)??[])fn({target:this,button:0,isPrimary:true,preventDefault(){},...value});}
 closest(){return null;}querySelectorAll(){return [];}getBoundingClientRect(){return {left:10,top:20};}
 setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}
 releasePointerCapture(id:number){this.captured.delete(id);this.emit('lostpointercapture',{pointerId:id});}
 onclick:(()=>void)|null=null;onchange:(()=>void)|null=null;
}
export type CompareCameraState={view:ControlView;scales:{a:number;b:number};referenceTransform:string;positions:{a:Record<string,string>;b:Record<string,string>}};
export interface CompareCameraHarness {
 nodes:Map<string,CameraNode>;viewport:ViewportController;frame(target:string,hidden?:boolean):CameraFrame|null;activate(target:string):void;
 mode(mode:string,side:string):void;edge():void;pan(target:string,dx:number,dy:number):void;zoom(factor:number,target?:string,point?:CameraPoint):void;
 sync(value:boolean):void;fit(target?:string):void;part(value:unknown,bounds:unknown):void;status():{value:string;error:boolean}|undefined;
 remote(command:unknown):Promise<void>;restore(value:InspectionBookmark):Promise<void>;bookmark():InspectionBookmark;
 state():CompareCameraState;signature(target:string):{zoom:number;pan:CameraPoint};
}
export async function openCompareCamera(initialFit=true):Promise<CompareCameraHarness>{
 const source=await readFile(new URL('../../web/compare.ts',import.meta.url),'utf8');
 const slice=(from:string,to:string)=>{const a=source.indexOf(from),b=source.indexOf(to,a);if(a<0||b<a)throw new Error('compare camera boundary missing');return source.slice(a,b);};
 const functions=slice('function unionBounds(','async function loadSide(')+slice('function createCompareViewport(','function redrawOverlays(')+slice('async function applyControl(','function numericView(')+slice('function numericView():','function renderNumericView(')+slice('async function restoreInspection(','async function setupPersistence(');
 const script=`function open(deps){const {createViewportController,createViewportState,createRigViewportProvider,makeNode,initialFit,cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}=deps;
 const cameras={a:{zoom:1,center:null},b:{zoom:1,center:null},reference:{zoom:1,center:null}},cameraFrames={},rigScales={a:1,b:1};let turnPad=null;let cameraSync=true,activeCamera='a',cameraRestoring=false,cameraLayout='',idleHeld=true,trace=null,seeking=false;let selected=null,selectedBounds=null;const statuses=[];const parts={value:()=>selected,bounds:()=>selectedBounds,validate(){},select(value){selected=value;}},message=(value,error=false)=>{statuses.push({value,error});};const video={videoWidth:1920,videoHeight:1080,style:{},muted:true},players={a:{renderer:{syncPixelRatio(){}}},b:{renderer:{syncPixelRatio(){}}}},assets={a:{stage:{x:-300,y:80,width:200,height:600}},b:{stage:{x:-200,y:90,width:300,height:580}}};const nodes=new Map();const el=id=>{if(!nodes.has(id)){const size=id.startsWith('a-')?[600,400]:id.startsWith('b-')?[400,600]:[300,800];nodes.set(id,makeNode(size[0],size[1]));}return nodes.get(id);};const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},redrawOverlays=()=>{},renderNumericView=()=>{},stop=()=>{},captureInputs=()=>({}),restoreInputs=()=>{},appearance=null,layers={images:true,mesh:false,bones:false},document={querySelectorAll:()=>[]},domain={start:0,end:2},data={animation:'idle',reference:{sha256:'reference'},a:{manifest:{title:'First'}},b:{manifest:{title:'Second'}}};let pickedTools=null;let saving=false,stripBusy=false;const localDraft=()=>false,requireCommonTime=()=>{};async function seekTo(time){trace={reference:time};}const inspectionBookmark=()=>({animation:'idle',time:null,theme:'dark',layers:{images:true,meshes:false,bones:false},selection:{reference:'reference'},view:numericView()});
 ${functions};const viewport=createCompareViewport();viewport.renderNumericView=renderNumericView;const {paneFrame,setCameraSync,updateCamera,fitSelection:fitActiveCamera,zoomCamera,panCamera}=viewport;if(initialFit)fit();return {nodes,viewport,frame:paneFrame,activate:viewport.activateCamera,mode:(mode,side)=>{pickedTools={mode:()=>mode,pickedSide:()=>side};},edge:()=>{video.videoWidth=2*Number.MAX_SAFE_INTEGER-1000;cameras.reference.center=null;},pan:panCamera,zoom:zoomCamera,sync:setCameraSync,fit:fitActiveCamera,part:(value,bounds)=>{selected=value;selectedBounds=bounds;},status:()=>statuses.at(-1),remote:command=>applyControl(command,new AbortController().signal),restore:value=>restoreInspection(value,new AbortController().signal),bookmark:inspectionBookmark,state:()=>({view:numericView(),scales:{...rigScales},referenceTransform:video.style.transform,positions:{a:{...el('a-root').style},b:{...el('b-root').style}}}),signature:target=>cameraSignature(cameras[target],paneFrame(target))};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 return new Function('deps',code+';return open(deps);')({createViewportController,createViewportState,createRigViewportProvider,makeNode:(width:number,height:number)=>new CameraNode(width,height),initialFit,cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout});
}
