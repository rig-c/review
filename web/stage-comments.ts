/** One gesture into the existing feedback record. No authoring or HTTP endpoint. */
import type {ModelAssets,PosedFrame} from '@rig-c/play';
import {paintInspectionViewport,pixelAlignedCrop,type ViewportCapture} from './viewport-capture.ts';
import type {Feedback} from '../src/session.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import {drawnSlots,region,projectMark,unprojectMark,parseStageComment,feedbackTimingLabel,type MarkRegion,type MarkPoint,type StageComment} from '../src/stage-comment.ts';
import {textEntryFocused} from './view-controls.ts';
export interface CommentPose {
 mode:StageComment['mode'];camera:ControlNumericCamera;frame:StageComment['frame'];timeBasis?:StageComment['timeBasis'];time:number;animation:string|null;
 turn:unknown;sourceHash:string;modelHash:string|null;referenceHash:string|null;referenceId:string|null;frameReason?:string;
 capture?:ViewportCapture;rig:string;side?:'a'|'b';posed?:PosedFrame;assets?:ModelAssets;media?:HTMLVideoElement|HTMLImageElement;
}
interface Host {
 toolbar:HTMLElement;viewports:Partial<Record<StageComment['viewport'],HTMLElement>>;
 pose:(view:StageComment['viewport'])=>CommentPose|null;pause:()=>Promise<void>;
 bookmark:()=>unknown;restore:(bookmark:unknown,timeOnly?:boolean)=>Promise<void>;
 feedback:()=>Feedback[];locked:(id:string)=>boolean;
 add:(feedback:Feedback,side?:'a'|'b')=>void;changed:()=>void;error:(message:string)=>void;
 blocked:()=>boolean;shortcutBlocked?:()=>boolean;
}
const markOf=(f:Feedback):StageComment|null=>{try{const c=f.context as Record<string,unknown>|undefined;return c?.comment?parseStageComment(c.comment):null;}catch{return null;}};
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function rectElement(r:MarkRegion):HTMLDivElement{const node=document.createElement('div');node.className='stage-comment-region';Object.assign(node.style,{left:r.x+'px',top:r.y+'px',width:Math.max(2,r.width)+'px',height:Math.max(2,r.height)+'px'});return node;}
async function crop(pose:CommentPose,r:MarkRegion):Promise<StageComment['crop']>{
 if(!pose.capture)throw new Error('COMMENT_CROP_UNAVAILABLE: viewport pixel source unavailable');
 const camera=pose.camera,padding=24,rawLeft=Math.max(0,Math.floor(r.x-padding)),rawTop=Math.max(0,Math.floor(r.y-padding)),pane=pose.capture.pane,bounds=pane.getBoundingClientRect(),ratio=globalThis.devicePixelRatio||1;
 const {x:left,y:top,width,height}=pixelAlignedCrop({x:rawLeft,y:rawTop,width:Math.min(camera.viewport.width-rawLeft,Math.ceil(r.width+2*padding)),height:Math.min(camera.viewport.height-rawTop,Math.ceil(r.height+2*padding))},{x:bounds.left+pane.clientLeft,y:bounds.top+pane.clientTop},ratio);
 if(width<=0||height<=0)throw new Error('COMMENT_CROP_UNAVAILABLE: mark is outside the viewport');
 const scale=Math.min(ratio,768/width,768/height),out=document.createElement('canvas');out.width=Math.max(1,Math.round(width*scale));out.height=Math.max(1,Math.round(height*scale));const ctx=out.getContext('2d')!;ctx.scale(scale,scale);ctx.translate(-left,-top);
 paintInspectionViewport(ctx,{x:left,y:top,width,height},pose.capture,pose);
 ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--link').trim();ctx.lineWidth=2/scale;ctx.strokeRect(r.x,r.y,Math.max(3,r.width),Math.max(3,r.height));
 const png=out.toDataURL('image/png');if(png.length>200000)throw new Error('COMMENT_CROP_LIMIT: mark a smaller region (PNG limit 150 KiB)');
 const bytes=Uint8Array.from(atob(png.split(',')[1]!),c=>c.charCodeAt(0)),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
 return {path:`comment-crops/${sha256}.png`,sha256,png,width:out.width,height:out.height};
}
export function bindStageComments(host:Host):{refresh:()=>void;dispose:()=>void;active:()=>boolean;draft:()=>boolean}{
 const toggle=document.getElementById('stage-comment') as HTMLButtonElement,listToggle=document.getElementById('stage-comment-list-toggle') as HTMLButtonElement;
 const list=document.createElement('section');list.id='stage-comment-list';list.className='stage-comment-list stage-comment-ui';list.setAttribute('aria-label','Stage comments');list.hidden=true;
 // An absolute overlay is not stage chrome: workspace measures stack children
 // to allocate Inspector height. Keep the list in its positioned main instead.
 const workspace=host.toolbar.closest('main');if(workspace)workspace.append(list);else host.toolbar.after(list);
 const layers=new Map<StageComment['viewport'],HTMLDivElement>();for(const [key,pane]of Object.entries(host.viewports)){const layer=document.createElement('div');layer.className='stage-comment-layer';pane!.append(layer);layers.set(key as StageComment['viewport'],layer);}
 let enabled=false,disposed=false,pending:{view:StageComment['viewport'];start:MarkPoint;end:MarkPoint;mode:StageComment['mode'];id:number;interaction:number;settled:Promise<void>}|null=null,composer:HTMLFormElement|null=null,draftMark:{view:StageComment['viewport'];mode:StageComment['mode'];screen:MarkRegion}|null=null,busy=false,last='',raf=0,interaction=0;
 const setEnabled=(value:boolean)=>{if(value&&(host.blocked()||host.shortcutBlocked?.())){host.error('COMMENT_BUSY: close the active editor or wait for the inspection to settle');return;}enabled=value;toggle.setAttribute('aria-pressed',String(value));for(const pane of Object.values(host.viewports))pane!.classList.toggle('stage-comment-mode',value);};
 const cancel=()=>{++interaction;const previous=pending;pending=null;if(previous){const pane=host.viewports[previous.view];if(pane?.hasPointerCapture(previous.id))pane.releasePointerCapture(previous.id);}composer?.remove();composer=null;draftMark=null;last='';};
 const jump=async(f:Feedback)=>{const mark=markOf(f);if(!mark)return;const panes=Object.values(host.viewports).map(p=>({pane:p!,visibility:p!.style.visibility}));try{cancel();for(const {pane}of panes)pane.style.visibility='hidden';await host.restore(mark.bookmark,mark.frame===null);last='';}catch(error){host.error(String(error));}finally{for(const {pane,visibility}of panes)pane.style.visibility=visibility;}};
 const renderList=()=>{list.replaceChildren();const title=document.createElement('strong');title.textContent='Comments';list.append(title);const all=host.feedback().filter(f=>markOf(f));listToggle.textContent=`Comments (${all.length})`;if(!all.length){const empty=document.createElement('p');empty.textContent='Mark a point or region, then type. Enter saves · Escape cancels.';list.append(empty);}for(const [i,f]of all.entries()){
  const mark=markOf(f)!,row=document.createElement('div');row.className='stage-comment-item';row.dataset.commentId=f.id;
  const go=document.createElement('button');go.type='button';go.textContent=`${i+1} · ${mark.mode.toUpperCase()} · ${mark.viewport.toUpperCase()} · ${mark.frame?`F${mark.frame.index} (${mark.frame.basis})`:feedbackTimingLabel(f)} · ${f.summary}`;go.onclick=()=>void jump(f);row.append(go);
  if(!host.locked(f.id)){const edit=document.createElement('button');edit.textContent='Edit';edit.onclick=async()=>{await jump(f);openComposer(mark.viewport,mark.screen,f);};const remove=document.createElement('button');remove.textContent='Delete';remove.onclick=()=>{const all=host.feedback(),index=all.findIndex(x=>x.id===f.id);if(index>=0)all.splice(index,1);cancel();host.changed();refresh();};row.append(edit,remove);}else{const submitted=document.createElement('span');submitted.textContent='Submitted';row.append(submitted);}list.append(row);
 }};
 const refresh=()=>{last='';renderList();};
 const openComposer=(view:StageComment['viewport'],screen:MarkRegion,existing?:Feedback,placementMode=host.pose(view)?.mode)=>{
  if(!placementMode||host.pose(view)?.mode!==placementMode){cancel();return;}
  composer?.remove();draftMark={view,mode:placementMode,screen};const generation=interaction;const pane=host.viewports[view]!,form=composer=document.createElement('form');form.className='stage-comment-composer stage-comment-ui';form.setAttribute('aria-label','Comment composer');
  const field=document.createElement('input');field.type='text';field.maxLength=1000;field.setAttribute('aria-label','Comment text');field.placeholder='Describe this spot…';field.value=existing?.summary??'';
  const hint=document.createElement('small');hint.textContent='Enter saves · Escape cancels';const error=document.createElement('p');error.setAttribute('role','alert');form.append(field,hint,error);pane.append(form);
  Object.assign(form.style,{left:Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-294))+'px',top:Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-110))+'px'});
  // Capture all view context now; camera or dial changes while typing cannot rebind the mark.
  const pose=host.pose(view),bookmark=copy(host.bookmark()),turn=pose?copy(pose.turn):null;
  if(pose&&!pose.frame&&!pose.timeBasis)error.textContent=pose.frameReason??'COMMENT_FRAME_UNAVAILABLE: no explicit frame index';
  const previous=existing?markOf(existing):null;
  const prepared=previous?Promise.resolve(previous.crop):pose?crop(pose,screen):Promise.reject(new Error('COMMENT_VIEW_UNAVAILABLE'));
  prepared.catch(()=>{});
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();pane.focus();}};
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;if(generation!==interaction||host.pose(view)?.mode!==placementMode){cancel();return;}const summary=field.value.trim();if(!summary){field.focus();return;}try{
   if(host.blocked())throw new Error('COMMENT_BUSY: wait for inspection');if(!pose||!pose.frame&&!pose.timeBasis)throw new Error(pose?.frameReason??'COMMENT_FRAME_UNAVAILABLE: provide an explicit producer clock or a decoded reference frame index');
   busy=true;field.disabled=true;
   if(existing){if(host.locked(existing.id))throw new Error('COMMENT_SUBMITTED: submitted evidence is immutable');existing.summary=summary;}
   else{
    const world=region(unprojectMark(screen,pose.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},pose.camera));
    const slots=pose.posed?drawnSlots(pose.posed,world):[];
    const comment:StageComment={schema:'rig-review-comment/1',mode:placementMode,viewport:view,frame:pose.frame,...(pose.timeBasis?{timeBasis:pose.timeBasis}:{}),time:pose.time,animation:pose.animation,sourceHash:pose.sourceHash,modelHash:pose.modelHash,referenceHash:pose.referenceHash,referenceId:pose.referenceId,camera:copy(pose.camera),screen,world,slots,crop:await prepared,bookmark};
    if(disposed||generation!==interaction||host.pose(view)?.mode!==placementMode)return;
    const n=pose.frame?.index??null;host.add({id:crypto.randomUUID(),frameStart:n,frameEnd:n,target:slots[0]?{kind:'slot',name:slots[0].slot}:{kind:'rig',name:pose.rig},category:'defect',summary,context:{animation:pose.animation,time:pose.time,frame:pose.frame?.basis==='producer'?n:null,...(turn?{turn:turn as any}:{}),interval:n===null?null:{frameStart:n,frameEnd:n,inclusive:true},comment:comment as any}},pose.side);
   }
   cancel();host.changed();refresh();
  }catch(e){error.textContent=e instanceof Error?e.message:String(e);field.disabled=false;field.focus();}finally{busy=false;}};
  field.focus();last='';
 };
 const disposers:(()=>void)[]=[];
 for(const [key,pane]of Object.entries(host.viewports)){
  const view=key as StageComment['viewport'],local=(e:PointerEvent)=>{const r=pane!.getBoundingClientRect();return {x:Math.max(0,Math.min(pane!.clientWidth,e.clientX-r.left-pane!.clientLeft)),y:Math.max(0,Math.min(pane!.clientHeight,e.clientY-r.top-pane!.clientTop))};};
  const down=(e:PointerEvent)=>{if(!enabled||e.button!==0||!e.isPrimary||host.blocked()||(e.target as Element).closest('.stage-comment-ui,button,input'))return;e.preventDefault();e.stopImmediatePropagation();cancel();const at=local(e),mode=host.pose(view)?.mode;if(!mode)return;const generation=interaction;pending={view,start:at,end:at,mode,id:e.pointerId,interaction:generation,settled:host.pause()};pending.settled.catch(e=>{if(interaction===generation&&!disposed)host.error(String(e));});pane!.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();pending.end=local(e);draftMark={view,mode:pending.mode,screen:region(pending.start,pending.end)};last='';};
  const up=async(e:PointerEvent)=>{if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=pending;pending=null;if(pane!.hasPointerCapture(e.pointerId))pane!.releasePointerCapture(e.pointerId);try{await p.settled;if(disposed||interaction!==p.interaction||!enabled)return;const r=Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y)<4?region(p.start,p.start):region(p.start,p.end);openComposer(view,r,undefined,p.mode);}catch(error){host.error(String(error));cancel();}};
  const abort=(e:PointerEvent)=>{if(pending?.view===view&&pending.id===e.pointerId)cancel();};
  pane!.addEventListener('pointerdown',down,true);pane!.addEventListener('pointermove',move,true);pane!.addEventListener('pointerup',up,true);pane!.addEventListener('pointercancel',abort,true);pane!.addEventListener('lostpointercapture',abort,true);
  disposers.push(()=>{pane!.removeEventListener('pointerdown',down,true);pane!.removeEventListener('pointermove',move,true);pane!.removeEventListener('pointerup',up,true);pane!.removeEventListener('pointercancel',abort,true);pane!.removeEventListener('lostpointercapture',abort,true);});
 }
 const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&(pending||composer||enabled&&!host.shortcutBlocked?.()&&!textEntryFocused(e.target))){e.preventDefault();cancel();setEnabled(false);return;}if(e.defaultPrevented||e.repeat||e.ctrlKey||e.metaKey||e.altKey||textEntryFocused(e.target)||host.shortcutBlocked?.())return;if(e.key.toLowerCase()==='c'){e.preventDefault();setEnabled(!enabled);}else if(e.key==='Escape'&&enabled){cancel();setEnabled(false);}};
 window.addEventListener('blur',cancel);document.addEventListener('keydown',key);toggle.onclick=()=>setEnabled(!enabled);listToggle.onclick=()=>{list.hidden=!list.hidden;listToggle.setAttribute('aria-expanded',String(!list.hidden));refresh();};
 const paint=()=>{if(disposed)return;const all=host.feedback().map(f=>({f,mark:markOf(f)})).filter(x=>x.mark);
 const poses=new Map([...layers.keys()].map(view=>[view,host.pose(view)]));
 if(draftMark&&poses.get(draftMark.view)?.mode!==draftMark.mode||pending&&poses.get(pending.view)?.mode!==pending.mode)cancel();
 const signature=JSON.stringify([all.map(({f,mark})=>[f.id,f.summary,mark!.mode,mark!.world]),[...poses].map(([view,p])=>[view,p?.mode,p?.animation,p?.frame,p?.timeBasis,p?.time,p?.turn,p?.camera,p?.referenceId,p?.referenceHash]),draftMark]);
 if(signature!==last){last=signature;for(const layer of layers.values())layer.replaceChildren();for(const [i,{f,mark:m}]of all.entries()){
  const mark=m!,pose=poses.get(mark.viewport),layer=layers.get(mark.viewport);if(!pose||!layer||pose.mode!==mark.mode||pose.animation!==mark.animation||pose.sourceHash!==mark.sourceHash||pose.modelHash!==mark.modelHash||pose.referenceId!==mark.referenceId||pose.referenceHash!==mark.referenceHash||JSON.stringify(pose.frame)!==JSON.stringify(mark.frame)||JSON.stringify(pose.timeBasis??null)!==JSON.stringify(mark.timeBasis??null)||Math.abs(pose.time-mark.time)>1e-7||JSON.stringify(pose.turn)!==JSON.stringify((f.context as any)?.turn??null))continue;
  const a=projectMark(mark.world,pose.camera),b=projectMark({x:mark.world.x+mark.world.width,y:mark.world.y+mark.world.height},pose.camera),r=region(a,b),box=rectElement(r),pin=document.createElement('button');pin.type='button';pin.className='stage-comment-pin stage-comment-ui';pin.textContent=String(i+1);pin.setAttribute('aria-label',`Comment ${i+1}: ${f.summary}`);pin.title=f.summary;Object.assign(pin.style,{left:r.x+'px',top:r.y+'px'});pin.onclick=()=>{list.hidden=false;renderList();};layer.append(box,pin);
 }if(draftMark)layers.get(draftMark.view)?.append(rectElement(draftMark.screen));}raf=requestAnimationFrame(paint);};
 refresh();paint();return {active:()=>enabled,draft:()=>!!composer||!!pending,refresh,dispose:()=>{disposed=true;cancelAnimationFrame(raf);cancel();window.removeEventListener('blur',cancel);document.removeEventListener('keydown',key);for(const dispose of disposers)dispose();for(const layer of layers.values())layer.remove();list.remove();}};
}
