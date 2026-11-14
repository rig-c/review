/** Native image policy for the canonical pair. Camera gestures and writes belong to viewport-controller. */
import {createViewportController,createViewportState,type ViewportState,type ViewportController,type CameraTarget,type ViewportProvider} from './viewport-controller.ts';
import {t} from './i18n.ts';

interface PartsFrame {w:number;h:number;world?:{box:{x:number;y:number;width:number;height:number};origin:{x:number;y:number};scale:{x:number;y:number}}}
/** Decode the response already checked by the caller, without retaining an object URL. */
export async function loadViewportImage(response:Response):Promise<HTMLImageElement>{
 const url=URL.createObjectURL(await response.blob());
 try{const image=new Image();image.src=url;await image.decode();return image;}
 finally{URL.revokeObjectURL(url);}
}
export interface PartsViewportHost {el:ViewportProvider['el'];canvas:HTMLCanvasElement;message:ViewportProvider['message'];reference:()=>HTMLCanvasElement|null;frameSize:(target:CameraTarget)=>PartsFrame|null}
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
 get absoluteSync(){return !!host.frameSize('rig')?.world;},
 panes:(['rig','reference'] as const).map(target=>({target,viewport:host.el(target+'-viewport'),pane:host.el(target+'-pane')})),
 geometry:target=>{
  const declared=host.frameSize(target);
  const size=declared?canvasSize(declared):target==='rig'?host.canvas:host.reference();
  if(!size)return null;
  const {width,height}=size;
  return {space:'image',box:declared?.world?.box??{x:0,y:0,width,height},marginX:24,marginY:24};
 },
 layoutKey:()=>JSON.stringify([host.frameSize('rig'),host.frameSize('reference'),state.cameraSync,host.canvas.width,host.canvas.height,host.reference()?.width??0,host.reference()?.height??0,host.el('rig-viewport').clientWidth,host.el('rig-viewport').clientHeight]),selection:()=>({selected:false,bounds:null}),
 render:controller=>{
  // Translated controls can wrap the toolbar and resize its sibling panes.
  controller.renderCameraControls();
  for(const target of ['rig','reference'] as const){
   const frame=controller.paneFrame(target);if(!frame)continue;
   const c=controller.paneCamera(target),center=c.center??frame.center;
   const root=host.el(target==='rig'?'rig-root':'reference-content');
   const world=host.frameSize(target)?.world,origin=world?.origin??{x:0,y:0},scale=world?.scale??{x:1,y:1};
   root.style.left=`${frame.width/2+(origin.x-center.x)*c.zoom}px`;
   root.style.top=`${frame.height/2+(origin.y-center.y)*c.zoom}px`;
   root.style.transform=scale.x===1&&scale.y===1?`scale(${c.zoom})`:`scale(${c.zoom*scale.x},${c.zoom*scale.y})`;
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
import {defaultPartsComparison,paintingRectangle,differencePixels,assertOriginalPaintingSize,type PartsComparison} from '../src/parts-comparison.ts';
import {paintAssembly,paintMesh,paintOverlay,paintPaintingCrop,pickAssembly,type Box} from './parts-render.ts';
import {bindStageComments,type CommentCodec,type CommentUiPose,type CommentRow} from './stage-comments.ts';
import {parsePartsIssue,assertPartsIssueBinding,snapImageRegion,type PartsIssue} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {EMIT_UNPINNED_CREATE_FIELDS} from '../src/create-pin-gate.ts';
/** U5 uses the same native raster paint path as a parts subject, with the whole rig as one operand. */
export function paintRigDifference(canvas:HTMLCanvasElement,still:HTMLCanvasElement,painting:HTMLImageElement) {
 assertOriginalPaintingSize(painting.naturalWidth,painting.naturalHeight,[still.width,still.height],1);
 const original=Object.assign(document.createElement('canvas'),{width:still.width,height:still.height});
 original.getContext('2d')!.drawImage(painting,0,0);
 const raster=(source:HTMLCanvasElement)=>({width:source.width,height:source.height,data:new Uint8Array(source.getContext('2d')!.getImageData(0,0,source.width,source.height).data)});
 const difference=differencePixels(raster(still),{x:0,y:0,w:still.width,h:still.height},raster(original),[],0,false);
 const pixels=Object.assign(document.createElement('canvas'),{width:difference.width,height:difference.height});
 pixels.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(difference.data),difference.width,difference.height),0,0);
 canvas.width=difference.width;canvas.height=difference.height;
 paintAssembly(canvas.getContext('2d')!,canvas.width,canvas.height,[{box:{name:'',index:0,x:0,y:0,w:canvas.width,h:canvas.height},image:pixels}],{bg:'checker',alpha:false,transparent:true});
 return {count:difference.count,compared:difference.compared};
}
export type PartsSubjectData=ReturnType<typeof partsViewJson>;
export interface PartsSubjectEntry {subject:'parts';parts:PartsSubjectData}
export interface PartsSubjectSession {subject:'parts';issues:PartsIssue[]}
type Item=PartsSubjectData['items'][number];
interface PartsPose extends CommentUiPose {item:Item;sourceHash:string;view:PartsIssue['view']}
/** Source-specific pixels and evidence. Shell, list, toolbar, controller and act stay in main.ts. */
export function bindPartsSubject(host:{
 data:PartsSubjectData;canvas:HTMLCanvasElement;referenceCanvas:HTMLCanvasElement;viewport:ViewportController;
 el:ViewportProvider['el'];toolbar:HTMLElement;commentsHost:HTMLElement;openComments?:()=>void;issues:PartsIssue[];recordComments?:CommentRow[];
 request:(path:string,init?:RequestInit)=>Promise<Response>;base:string;paintingPath:string;
 mesh:()=>boolean;restoreMesh:(on:boolean)=>void;images:()=>boolean;changed:()=>void;selectionChanged:()=>void;locked:(id:string)=>boolean;refusal:()=>string|null;drawn:(input:{state:'loaded'}|{state:'failed';reason:string})=>void;message:ViewportProvider['message'];
}) {
 const data=host.data,hidden=new Set<string>(),images=new Map<number,Promise<HTMLImageElement>>(),loaded=new Map<string,HTMLImageElement>(),assemblyAlpha=new Map<string,{box:Box;alpha:Uint8ClampedArray}>();
 let selected:string|null=null,solo=false,comparison:PartsComparison=defaultPartsComparison(),token=0,disposed=false,busy=false,failed=false;
 let drawnFrame:{w:number;h:number}|null=null,drawnReferenceFrame:{w:number;h:number}|null=null;
 let drawnRegion:Box|null=null,drawnSolo=false;
 let original:Promise<HTMLImageElement>|null=null,comments:ReturnType<typeof bindStageComments<CommentRow,PartsPose>>|null=null;
 const makeCanvas=(w:number,h:number)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
 const item=()=>data.items.find(item=>item.name===selected)??data.items[0]!;
 const assembled=()=>!solo||selected===null;
 const box=():Box=>assembled()&&data.rigSize?{name:'',index:0,x:0,y:0,w:data.rigSize[0],h:data.rigSize[1]}:item();
 const loadImage=async(path:string):Promise<HTMLImageElement>=>{
  const image=await loadViewportImage(await host.request(path));
  if(disposed)throw new Error('PARTS_PAINT_FAILED');return image;
 };
 const image=(entry:Item)=>{let pending=images.get(entry.index);if(!pending){pending=loadImage(`${host.base}/image/${entry.index}`).then(img=>{loaded.set(entry.name,img);return img;});images.set(entry.index,pending);}return pending;};
 const sourceAlpha=(entry:Item,img:HTMLImageElement)=>{const cached=assemblyAlpha.get(entry.name);if(cached)return cached;const c=makeCanvas(entry.w,entry.h),rgba=(c.getContext('2d')!.drawImage(img,0,0),c.getContext('2d')!.getImageData(0,0,c.width,c.height).data),alpha=new Uint8ClampedArray(c.width*c.height);for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3]!;const layer={box:{...entry,w:c.width,h:c.height},alpha};assemblyAlpha.set(entry.name,layer);return layer;};
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
   const frame=box(),referenceBox=selected===null?null:item(),shown=assembled()?data.items.filter(item=>!hidden.has(item.name)):[item()];
   const layers=await Promise.all(shown.map(async entry=>{const img=await image(entry);loaded.set(entry.name,img);return {box:entry,image:img};}));
   let reference:HTMLCanvasElement|null=null;
   if(data.painting&&data.rigSize){
    const original=await painting();
    reference=makeCanvas(referenceBox?.w??original.naturalWidth,referenceBox?.h??original.naturalHeight);
    if(referenceBox)paintPaintingCrop(reference.getContext('2d')!,original,paintingRectangle(referenceBox,data.rigSize,data.painting),referenceBox.w,referenceBox.h,'checker');
    else reference.getContext('2d')!.drawImage(original,0,0);
   }
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
   const selectionChanged=drawnRegion?.name!==referenceBox?.name||drawnSolo!==!assembled();
   drawnRegion=referenceBox;drawnSolo=!assembled();
   if(reference){host.referenceCanvas.width=reference.width;host.referenceCanvas.height=reference.height;host.referenceCanvas.getContext('2d')!.drawImage(reference,0,0);drawnReferenceFrame={w:reference.width,h:reference.height};}
   drawnFrame={w:frame.w,h:frame.h};failed=false;host.drawn({state:'loaded'});host.el('rig-empty').hidden=true;host.el('rig-label').textContent=t(assembled()?'Assembled parts':'Selected part');
   if(data.painting&&host.viewport.state.cameraSync&&selectionChanged)host.viewport.requestFit();
   host.viewport.fitCamera();comments?.refresh();
  }catch(error){if(!disposed&&navigation===token){failed=true;drawnFrame=null;drawnReferenceFrame=null;host.drawn({state:'failed',reason:error instanceof Error?error.message:'PARTS_PAINT_FAILED'});host.canvas.getContext('2d')?.clearRect(0,0,host.canvas.width,host.canvas.height);host.referenceCanvas.getContext('2d')?.clearRect(0,0,host.referenceCanvas.width,host.referenceCanvas.height);host.message(error instanceof Error?error.message:'PARTS_PAINT_FAILED',true);throw error;}}
  finally{for(const bitmap of bitmaps)bitmap.close();if(navigation===token){busy=false;host.el('stage-layout').setAttribute('aria-busy','false');comments?.refresh();}}
 }
 const redraw=()=>{void paint().catch(()=>{});};
 const codec:CommentCodec<CommentRow,PartsPose>={
  read:raw=>{try{const c=parsePartsIssue(raw,false,true,false),camera={space:'image' as const,center:c.view.camera.center,zoom:c.view.camera.zoom,viewport:c.view.camera.viewport,visible:{x:c.view.camera.center.x-c.view.camera.viewport.width/c.view.camera.zoom/2,y:c.view.camera.center.y-c.view.camera.viewport.height/c.view.camera.zoom/2,width:c.view.camera.viewport.width/c.view.camera.zoom,height:c.view.camera.viewport.height/c.view.camera.zoom}},r=c.view.mode==='assembled'?c.rigRegion:c.imageRegion!;return {mode:'parts',viewport:'rig',screen:region(projectMark(r,camera),projectMark({x:r.x+r.width,y:r.y+r.height},camera)),world:r,camera,crop:{...c.crop,png:c.crop.png??''},bookmark:c};}catch{return null;}},
  signature:pose=>[pose.sourceHash,pose.item.name,pose.item.imageHash,pose.view],
  matches:(_mark,pose,raw)=>{try{const c=parsePartsIssue(raw,false,true,false);return pose.sourceHash===c.sourceHash&&pose.view.mode===c.view.mode&&(assembled()||c.parts[0]?.name===pose.item.name);}catch{return false;}},
  label:raw=>{const issue=parsePartsIssue(raw,false,true,false);return `${issue.parts.map(part=>part.name).join(', ')} · ${issue.summary}`;},
  chips:(pose,screen,existing)=>{
   const visible=data.items.filter(item=>!hidden.has(item.name)),candidates=pose.view.mode==='assembled'?visible.map(item=>item.name):[];
   if(existing)return {selected:parsePartsIssue(existing,false,true,false).parts.map(part=>part.name),candidates};
   if(pose.view.mode==='item')return {selected:[pose.item.name],candidates};
   const frame=box(),r=snapImageRegion(region(unprojectMark(screen,pose.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},pose.camera),{x:0,y:0,width:frame.w,height:frame.h}));
   const hits=new Set<string>(),layers=visible.flatMap(box=>{const img=loaded.get(box.name);return img?[sourceAlpha(box,img)]:[];});
   const stepX=Math.max(1,r.width/32),stepY=Math.max(1,r.height/32);
   for(let y=r.y+.5;y<r.y+r.height;y+=stepY)for(let x=r.x+.5;x<r.x+r.width;x+=stepX){const hit=pickAssembly(layers,x,y);if(hit)hits.add(hit.name);}
   return {selected:visible.filter(item=>hits.has(item.name)).map(item=>item.name),candidates};
  },
  create:async(pose,_view,screen,crop,_bookmark,summary,parts)=>{
   const frame=box(),r=snapImageRegion(region(unprojectMark(screen,pose.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},pose.camera),{x:0,y:0,width:frame.w,height:frame.h})),single=pose.view.mode==='item';
   return prepare({schema:'rig-review-parts-comment/2',id:crypto.randomUUID(),summary,sourceHash:data.sourceHash,parts:partsBinding(single?[pose.item.name]:parts??[]),rigRegion:single?{...r,x:r.x+pose.item.x,y:r.y+pose.item.y}:r,imageRegion:single?r:null,view:structuredClone(pose.view),crop,nativeCrop:null});
  },
  update:(raw,summary,parts)=>{const existing=parsePartsIssue(raw,false,true,false);return prepare({...existing,summary,parts:existing.view.mode==='assembled'?partsBinding(parts??[]):existing.parts});},
 };
 const pose=():PartsPose|null=>{
  let camera=host.viewport.numericView().cameras.rig;const entry=item();if(!camera||!entry||busy||failed||disposed)return null;
  if(data.painting&&!assembled())camera={...camera,center:{x:camera.center.x-entry.x,y:camera.center.y-entry.y},visible:{...camera.visible,x:camera.visible.x-entry.x,y:camera.visible.y-entry.y}};
  return {mode:'parts',item:entry,sourceHash:data.sourceHash,camera,view:{mode:assembled()?'assembled':'item',camera:{zoom:camera.zoom,center:camera.center,viewport:camera.viewport},cameraSync:host.viewport.state.cameraSync,referenceCamera:null,background:'checker',alpha:false,footprints:false,mesh:host.mesh(),comparison:{...comparison},...(assembled()&&EMIT_UNPINNED_CREATE_FIELDS?{visibleLayers:partsBinding(data.items.filter(item=>!hidden.has(item.name)).map(item=>item.name))}:{})},capture:{pane:host.el('rig-viewport'),root:host.el('rig-root'),images:true,canvas:host.canvas,backend:'canvas2d',nearest:true}};
 };
 comments=bindStageComments<CommentRow,PartsPose>({general:host.recordComments?{create:summary=>({id:crypto.randomUUID(),summary}),matches:row=>!('schema' in row)}:undefined,toolbar:host.toolbar,listHost:host.commentsHost,openList:host.openComments,toggle:host.el<HTMLButtonElement>('stage-comment'),viewports:{rig:host.el('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
  restore:async raw=>{const issue=parsePartsIssue(raw,false,true,false);assertPartsIssueBinding(issue,sourceItems(),data.sourceHash);selected=issue.parts[0]!.name;solo=issue.view.mode==='item';comparison=issue.view.comparison??defaultPartsComparison();host.restoreMesh(issue.view.mesh);if(issue.view.visibleLayers){const visible=new Set(issue.view.visibleLayers.map(part=>part.name));hidden.clear();for(const item of data.items)if(!visible.has(item.name))hidden.add(item.name);}await paint();host.viewport.writeCamera('rig',data.painting&&solo?{...issue.view.camera,center:{x:issue.view.camera.center.x+item().x,y:issue.view.camera.center.y+item().y}}:issue.view.camera);host.viewport.activateCamera('rig');if(host.viewport.state.cameraSync)host.viewport.alignCameras();host.viewport.fitCamera();host.selectionChanged();},
  feedback:()=>host.recordComments??host.issues,locked:host.locked,refusal:host.refusal,add:row=>{if(host.recordComments)host.recordComments.push(row);else host.issues.push(row as PartsIssue);},changed:host.changed,error:host.message,blocked:()=>busy||failed||disposed,busy:()=>busy,codec});
 return {
  frameSize:(target:CameraTarget):PartsFrame|null=>{
   const frame=target==='rig'?drawnFrame:drawnReferenceFrame;if(!frame||!data.painting||!data.rigSize)return frame;
   const full={x:0,y:0,w:data.rigSize[0],h:data.rigSize[1]},region=drawnRegion??full;
   const bounds=target==='reference'||host.viewport.state.cameraSync||drawnSolo?region:full;
   const origin=target==='reference'||drawnSolo?{x:region.x,y:region.y}:{x:0,y:0};
   const scale=target==='reference'&&!drawnRegion?{x:region.w/frame.w,y:region.h/frame.h}:{x:1,y:1};
   return {...frame,world:{box:{x:bounds.x,y:bounds.y,width:bounds.w,height:bounds.h},origin,scale}};
  },
  image:(index:number)=>{const entry=data.items.find(item=>item.index===index);if(!entry)return Promise.reject(new Error('PARTS_IMAGE_UNAVAILABLE'));return image(entry);},
  items:()=>data.items,sourceHash:()=>data.sourceHash,refreshComments:()=>comments?.refresh(),selected:()=>selected,solo:()=>solo,visible:(name:string)=>!hidden.has(name),issues:()=>host.issues,
  select:(name:string|null)=>{selected=name;if(name===null)solo=false;redraw();host.selectionChanged();},isolate:(value:boolean)=>{solo=value;redraw();host.selectionChanged();},
  show:(name:string,value:boolean)=>{if(value)hidden.delete(name);else hidden.add(name);redraw();},
  differenceAvailable:()=>data.differenceAvailable&&!!data.painting&&!failed,
  comparison:()=>comparison,setComparison:(mode:PartsComparison['mode'])=>{comparison=mode==='difference'?{mode,opacity:comparison.opacity,threshold:0}:{mode,opacity:comparison.opacity};redraw();},
  opacity:(value:number)=>{comparison.opacity=value;redraw();},paint,redraw,
  async ready(){if(data.painting)host.viewport.state.cameraSync=true;await paint();},
  dispose(){disposed=true;++token;comments?.dispose();images.clear();loaded.clear();assemblyAlpha.clear();},
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
