/** Native image policy for the canonical pair. Camera gestures and writes belong to viewport-controller. */
import {createViewportController,createViewportState,type ViewportState,type ViewportController,type CameraTarget,type ViewportProvider} from './viewport-controller.ts';
import {t} from './i18n.ts';

export interface PartsViewportHost {el:ViewportProvider['el'];canvas:HTMLCanvasElement;message:ViewportProvider['message'];reference:()=>HTMLCanvasElement|null;frameSize:(target:CameraTarget)=>{w:number;h:number}|null}
export function createPartsViewportProvider(host:PartsViewportHost,state:ViewportState):ViewportProvider {
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
 renderControls:controller=>{const zoom=controller.paneCamera(controller.availableCamera()??'rig').zoom;host.el('zoom-value').textContent=zoom===1?t('1:1'):`${(zoom*100).toFixed(1)}%`;host.el('native-one').setAttribute('aria-pressed',String(zoom===1));(host.el('camera-sync') as HTMLInputElement).checked=state.cameraSync;host.el('fit').textContent=t('Fit');}
 };
 return provider;
}

/** Compatibility for module consumers; the review screen selects this provider on its one controller. */
export function createPartsViewport(host:PartsViewportHost){const state=createViewportState();state.cameraSync=false;return createViewportController(createPartsViewportProvider(host,state),state);}

import type {partsViewJson} from '../src/parts-view.ts';
import {defaultPartsComparison,paintingRectangle,type PartsComparison} from '../src/parts-comparison.ts';
import {paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,type Box} from './parts-render.ts';
import {bindStageComments,type CommentCodec,type CommentUiPose} from './stage-comments.ts';
import {parsePartsIssue,assertPartsIssueBinding,snapImageRegion,type PartsIssue} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {EMIT_UNPINNED_CREATE_FIELDS} from '../src/create-pin-gate.ts';
export type PartsSubjectData=ReturnType<typeof partsViewJson>;
export interface PartsSubjectEntry {subject:'parts';parts:PartsSubjectData}
export interface PartsSubjectSession {subject:'parts';issues:PartsIssue[]}
type Item=PartsSubjectData['items'][number];
interface PartsPose extends CommentUiPose {item:Item;sourceHash:string;view:PartsIssue['view']}
/** Source-specific pixels and evidence. Shell, list, toolbar, controller and act stay in main.ts. */
export function bindPartsSubject(host:{
 data:PartsSubjectData;canvas:HTMLCanvasElement;referenceCanvas:HTMLCanvasElement;viewport:ViewportController;
 el:ViewportProvider['el'];toolbar:HTMLElement;commentsHost:HTMLElement;issues:PartsIssue[];
 request:(path:string,init?:RequestInit)=>Promise<Response>;base:string;paintingPath:string;
 mesh:()=>boolean;restoreMesh:(on:boolean)=>void;images:()=>boolean;changed:()=>void;selectionChanged:()=>void;locked:(id:string)=>boolean;refusal:()=>string|null;drawn:(input:{state:'loaded'}|{state:'failed';reason:string})=>void;message:ViewportProvider['message'];
}) {
 const data=host.data,hidden=new Set<string>(),images=new Map<number,Promise<HTMLImageElement>>();
 let selected:string|null=null,solo=false,comparison:PartsComparison=defaultPartsComparison(),token=0,disposed=false,busy=false,failed=false;
 let drawnFrame:{w:number;h:number}|null=null;
 let original:Promise<HTMLImageElement>|null=null,comments:ReturnType<typeof bindStageComments<PartsIssue,PartsPose>>|null=null;
 const makeCanvas=(w:number,h:number)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
 const item=()=>data.items.find(item=>item.name===selected)??data.items[0]!;
 const assembled=()=>!solo||selected===null;
 const box=():Box=>assembled()&&data.rigSize?{name:'',index:0,x:0,y:0,w:data.rigSize[0],h:data.rigSize[1]}:item();
 const loadImage=async(path:string):Promise<HTMLImageElement>=>{
  const response=await host.request(path),url=URL.createObjectURL(await response.blob());
  try{const image=new Image();image.src=url;await image.decode();if(disposed)throw new Error('PARTS_PAINT_FAILED');return image;}
  finally{URL.revokeObjectURL(url);}
 };
 const image=(entry:Item)=>{let pending=images.get(entry.index);if(!pending){pending=loadImage(`${host.base}/image/${entry.index}`);images.set(entry.index,pending);}return pending;};
 const painting=()=>original??=loadImage(host.paintingPath);
 const partsBinding=(names:readonly string[])=>names.map(name=>{const entry=data.items.find(item=>item.name===name);if(!entry?.imageHash)throw new Error('PARTS_COMMENT_PART_MISMATCH');return {name,imageHash:entry.imageHash};});
 const sourceItems=()=>new Map(data.items.map(item=>[item.name,{...item,imageHash:item.imageHash!}]));
 async function prepare(issue:PartsIssue):Promise<PartsIssue>{
  if(!EMIT_UNPINNED_CREATE_FIELDS&&Object.hasOwn(issue.view,'visibleLayers')){const {visibleLayers:_ignored,...view}=issue.view;issue={...issue,view};}
  const bound=parsePartsIssue(issue,false,false,false);assertPartsIssueBinding(bound,sourceItems(),data.sourceHash);
  const response=await host.request(`${host.base}/comment`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(bound)});
  if(disposed)throw new Error('PARTS_COMMENT_STALE_SOURCE');return parsePartsIssue((await response.json()).comment,true,false,false);
 }
 /** Paint a frozen navigation generation, then publish it. A failed or superseded draw never leaves stale pixels targetable. */
 async function paint():Promise<void>{
  const navigation=++token;busy=true;comments?.refresh();host.el('stage-layout').setAttribute('aria-busy','true');
  const bitmaps:ImageBitmap[]=[];
  try{
   if(data.mode!=='parts'||!data.items.length)throw new Error('PARTS_IMAGE_UNAVAILABLE');
   const frame=box(),shown=assembled()?data.items.filter(item=>!hidden.has(item.name)):[item()];
   const layers=await Promise.all(shown.map(async entry=>({box:entry,image:await image(entry)})));
   const raster=makeCanvas(frame.w,frame.h),ctx=raster.getContext('2d')!;
   if(comparison.mode==='difference'){
    const differences=[];
    for(const entry of shown){const response=await host.request(`${host.base}/difference/${entry.index}?threshold=${comparison.threshold}&footprints=false`);const bitmap=await createImageBitmap(await response.blob());bitmaps.push(bitmap);differences.push({box:assembled()?entry:{...entry,x:0,y:0},image:bitmap});}
    paintAssembly(ctx,frame.w,frame.h,differences,{bg:'checker',alpha:false,transparent:true});
   }else if(comparison.mode==='overlay'&&data.painting&&data.rigSize){
    const original=await painting();
    if(assembled()){
     paintPaintingCrop(ctx,original,paintingRectangle(frame,data.rigSize,data.painting),frame.w,frame.h,'checker');
     const composite=makeCanvas(frame.w,frame.h);paintAssembly(composite.getContext('2d')!,frame.w,frame.h,layers,{bg:'checker',alpha:false,transparent:true});
     ctx.globalAlpha=comparison.opacity;if(host.images())ctx.drawImage(composite,0,0);ctx.globalAlpha=1;
    }else if(host.images())paintOverlay(ctx,item(),layers[0]!.image,original,paintingRectangle(item(),data.rigSize,data.painting),comparison.opacity,'checker');
   }else if(host.images())paintAssembly(ctx,frame.w,frame.h,layers.map(layer=>assembled()?layer:{...layer,box:{...layer.box,x:0,y:0}}),{bg:'checker',alpha:false,transparent:true});
   if(host.mesh())for(const layer of layers){if(!layer.box.mesh)continue;ctx.save();if(assembled())ctx.translate(layer.box.x,layer.box.y);paintMesh(ctx,layer.image,layer.box.w,layer.box.h,layer.box.mesh,makeCanvas,{tint:selected===null||selected===layer.box.name});ctx.restore();}
   if(disposed||navigation!==token)return;
   host.canvas.width=frame.w;host.canvas.height=frame.h;host.canvas.getContext('2d')!.drawImage(raster,0,0);
   drawnFrame={w:frame.w,h:frame.h};failed=false;host.drawn({state:'loaded'});host.el('rig-empty').hidden=true;host.el('rig-label').textContent=t(assembled()?'Assembled parts':'Selected part');
   host.viewport.fitCamera();comments?.refresh();
  }catch(error){if(!disposed&&navigation===token){failed=true;drawnFrame=null;host.drawn({state:'failed',reason:error instanceof Error?error.message:'PARTS_PAINT_FAILED'});host.canvas.getContext('2d')?.clearRect(0,0,host.canvas.width,host.canvas.height);host.message(error instanceof Error?error.message:'PARTS_PAINT_FAILED',true);throw error;}}
  finally{for(const bitmap of bitmaps)bitmap.close();if(navigation===token){busy=false;host.el('stage-layout').setAttribute('aria-busy','false');comments?.refresh();}}
 }
 const redraw=()=>{void paint().catch(()=>{});};
 const codec:CommentCodec<PartsIssue,PartsPose>={
  read:raw=>{try{const c=parsePartsIssue(raw,false,true,false),camera={space:'image' as const,center:c.view.camera.center,zoom:c.view.camera.zoom,viewport:c.view.camera.viewport,visible:{x:c.view.camera.center.x-c.view.camera.viewport.width/c.view.camera.zoom/2,y:c.view.camera.center.y-c.view.camera.viewport.height/c.view.camera.zoom/2,width:c.view.camera.viewport.width/c.view.camera.zoom,height:c.view.camera.viewport.height/c.view.camera.zoom}},r=c.view.mode==='assembled'?c.rigRegion:c.imageRegion!;return {mode:'parts',viewport:'rig',screen:region(projectMark(r,camera),projectMark({x:r.x+r.width,y:r.y+r.height},camera)),world:r,camera,crop:{...c.crop,png:c.crop.png??''},bookmark:c};}catch{return null;}},
  signature:pose=>[pose.sourceHash,pose.item.name,pose.item.imageHash,pose.view],
  matches:(_mark,pose,raw)=>{try{const c=parsePartsIssue(raw,false,true,false);return pose.sourceHash===c.sourceHash&&pose.view.mode===c.view.mode&&(assembled()||c.parts[0]?.name===pose.item.name);}catch{return false;}},
  label:raw=>`${raw.parts.map(part=>part.name).join(', ')} · ${raw.summary}`,
  chips:(pose,_screen,existing)=>({selected:existing?.parts.map(part=>part.name)??(pose.view.mode==='item'?[pose.item.name]:[]),candidates:pose.view.mode==='assembled'?data.items.filter(item=>!hidden.has(item.name)).map(item=>item.name):[]}),
  create:async(pose,_view,screen,crop,_bookmark,summary,parts)=>{
   const frame=box(),r=snapImageRegion(region(unprojectMark(screen,pose.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},pose.camera),{x:0,y:0,width:frame.w,height:frame.h})),single=pose.view.mode==='item';
   return prepare({schema:'rig-review-parts-comment/2',id:crypto.randomUUID(),summary,sourceHash:data.sourceHash,parts:partsBinding(single?[pose.item.name]:parts??[]),rigRegion:single?{...r,x:r.x+pose.item.x,y:r.y+pose.item.y}:r,imageRegion:single?r:null,view:structuredClone(pose.view),crop,nativeCrop:null});
  },
  update:(existing,summary,parts)=>prepare({...existing,summary,parts:existing.view.mode==='assembled'?partsBinding(parts??[]):existing.parts}),
 };
 const pose=():PartsPose|null=>{
  const camera=host.viewport.numericView().cameras.rig,entry=item();if(!camera||!entry||busy||failed||disposed)return null;
  return {mode:'parts',item:entry,sourceHash:data.sourceHash,camera,view:{mode:assembled()?'assembled':'item',camera:{zoom:camera.zoom,center:camera.center,viewport:camera.viewport},cameraSync:host.viewport.state.cameraSync,referenceCamera:null,background:'checker',alpha:false,footprints:false,mesh:host.mesh(),comparison:{...comparison},...(assembled()&&EMIT_UNPINNED_CREATE_FIELDS?{visibleLayers:partsBinding(data.items.filter(item=>!hidden.has(item.name)).map(item=>item.name))}:{})},capture:{pane:host.el('rig-viewport'),root:host.el('rig-root'),images:true,canvas:host.canvas,backend:'canvas2d',nearest:true}};
 };
 comments=bindStageComments({toolbar:host.toolbar,listHost:host.commentsHost,toggle:host.el<HTMLButtonElement>('stage-comment'),viewports:{rig:host.el('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
  restore:async raw=>{const issue=parsePartsIssue(raw,false,true,false);assertPartsIssueBinding(issue,sourceItems(),data.sourceHash);selected=issue.parts[0]!.name;solo=issue.view.mode==='item';comparison=issue.view.comparison??defaultPartsComparison();host.restoreMesh(issue.view.mesh);if(issue.view.visibleLayers){const visible=new Set(issue.view.visibleLayers.map(part=>part.name));hidden.clear();for(const item of data.items)if(!visible.has(item.name))hidden.add(item.name);}await paint();host.viewport.writeCamera('rig',issue.view.camera);host.viewport.fitCamera();host.selectionChanged();},
  feedback:()=>host.issues,locked:host.locked,refusal:host.refusal,add:issue=>host.issues.push(issue),changed:host.changed,error:host.message,blocked:()=>busy||failed||disposed,busy:()=>busy,codec});
 return {
  frameSize:(target:CameraTarget)=>target==='rig'?drawnFrame:data.painting?{w:data.painting.width,h:data.painting.height}:null,
  image:(index:number)=>{const entry=data.items.find(item=>item.index===index);if(!entry)return Promise.reject(new Error('PARTS_IMAGE_UNAVAILABLE'));return image(entry);},
  selected:()=>selected,solo:()=>solo,visible:(name:string)=>!hidden.has(name),issues:()=>host.issues,
  select:(name:string|null)=>{selected=name;if(name===null)solo=false;redraw();host.selectionChanged();},isolate:(value:boolean)=>{solo=value;redraw();host.selectionChanged();},
  show:(name:string,value:boolean)=>{if(value)hidden.delete(name);else hidden.add(name);redraw();},
  differenceAvailable:()=>data.differenceAvailable&&!!data.painting&&!failed,
  comparison:()=>comparison,setComparison:(mode:PartsComparison['mode'])=>{comparison=mode==='difference'?{mode,opacity:comparison.opacity,threshold:0}:{mode,opacity:comparison.opacity};redraw();},
  opacity:(value:number)=>{comparison.opacity=value;redraw();},paint,redraw,
  async ready(){if(data.painting){const original=await painting();host.referenceCanvas.width=original.naturalWidth;host.referenceCanvas.height=original.naturalHeight;host.referenceCanvas.getContext('2d')!.drawImage(original,0,0);}await paint();},
  dispose(){disposed=true;++token;comments?.dispose();images.clear();},
 };
}

export interface StagePartsState {
 inspectionSourceHash:string;part:string;imageHash:string;box:{x:number;y:number;w:number;h:number};mapping:{skin:string;slot:string;attachment:string};
 rig:{zoom:number;center:{x:number;y:number}|null};reference:{zoom:number;center:{x:number;y:number}|null};cameraSync:boolean;
 bg:string;alpha:boolean;footprints:boolean;view:'item'|'page'|'assembled';mesh:boolean;
}
/** Navigation state transfers only over exact original-art/package identity and the same draft address. */
export function stagePartsSelectionIndex(data:{inspectionSourceHash?:string;items:{name:string;imageHash?:string;x:number;y:number;w:number;h:number}[];draft?:{mappings:{part:string;skin:string;slot:string;attachment:string}[]}},saved:StagePartsState):number {
 const i=data.items.findIndex(item=>item.name===saved.part&&item.imageHash===saved.imageHash&&(['x','y','w','h']as const).every(k=>item[k]===saved.box[k]));
 const m=data.draft?.mappings.find(m=>m.part===saved.part);
 if(i<0||data.inspectionSourceHash!==saved.inspectionSourceHash||!m||(['skin','slot','attachment']as const).some(k=>m[k]!==saved.mapping[k]))throw new Error('STAGE_DRAFT_MISMATCH');
 return i;
}
