/** One gesture into the existing feedback record. No authoring or HTTP endpoint. */
import type {ModelAssets,PosedFrame} from '@rig-c/play';
import {paintInspectionViewport,pixelAlignedCrop,type ViewportCapture} from './viewport-capture.ts';
import type {Feedback} from '../src/session.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import {drawnSlots,region,projectMark,unprojectMark,parseStageComment,feedbackTimingLabel,type MarkRegion,type MarkPoint,type StageComment} from '../src/stage-comment.ts';
import {getLanguage as i18nLang,onLanguageChange as i18nOnChange,t as i18nT,tr as i18nTr} from './i18n.ts';
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
 refusal?:()=>string|null;blocked:()=>boolean;shortcutBlocked?:()=>boolean;
}
const markOf=(f:Feedback):StageComment|null=>{try{const c=f.context as Record<string,unknown>|undefined;return c?.comment?parseStageComment(c.comment):null;}catch{return null;}};
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const t=(s:string)=>typeof i18nT==='function'?i18nT(s):s;
const toEn=(s:string)=>typeof i18nTr==='function'?i18nTr(s,'en'):s;
const onLang=(fn:()=>void)=>typeof i18nOnChange==='function'?i18nOnChange(fn):()=>{};
const curLang=()=>typeof i18nLang==='function'?i18nLang():'en';
function rectElement(r:MarkRegion):HTMLDivElement{const node=document.createElement('div');node.className='stage-comment-region';Object.assign(node.style,{left:r.x+'px',top:r.y+'px',width:Math.max(2,r.width)+'px',height:Math.max(2,r.height)+'px'});return node;}
async function crop(pose:CommentPose,r:MarkRegion):Promise<StageComment['crop']>{
 if(!pose.capture)throw new Error(t('COMMENT_CROP_UNAVAILABLE: viewport pixel source unavailable'));
 const camera=pose.camera,padding=24,rawLeft=Math.max(0,Math.floor(r.x-padding)),rawTop=Math.max(0,Math.floor(r.y-padding)),pane=pose.capture.pane,bounds=pane.getBoundingClientRect(),ratio=globalThis.devicePixelRatio||1;
 const {x:left,y:top,width,height}=pixelAlignedCrop({x:rawLeft,y:rawTop,width:Math.min(camera.viewport.width-rawLeft,Math.ceil(r.width+2*padding)),height:Math.min(camera.viewport.height-rawTop,Math.ceil(r.height+2*padding))},{x:bounds.left+pane.clientLeft,y:bounds.top+pane.clientTop},ratio);
 if(width<=0||height<=0)throw new Error(t('COMMENT_CROP_UNAVAILABLE: mark is outside the viewport'));
 const out=document.createElement('canvas'),stroke=getComputedStyle(document.documentElement).getPropertyValue('--link').trim()||'#3b82f6';
 let scale=Math.min(ratio,768/width,768/height),png='';
 while(true){
  out.width=Math.max(1,Math.round(width*scale));out.height=Math.max(1,Math.round(height*scale));
  const sx=out.width/width,sy=out.height/height,s=Math.min(sx,sy),ctx=out.getContext('2d')!;
  ctx.scale(sx,sy);ctx.translate(-left,-top);
  paintInspectionViewport(ctx,{x:left,y:top,width,height},pose.capture,pose);
  const pad=1/s,mw=Math.min(Math.max(3/s,r.width),Math.max(1/s,width-2*pad)),mh=Math.min(Math.max(3/s,r.height),Math.max(1/s,height-2*pad));
  const mx=Math.max(left+pad,Math.min(r.x,left+width-pad-mw)),my=Math.max(top+pad,Math.min(r.y,top+height-pad-mh));
  ctx.strokeStyle=stroke;ctx.lineWidth=2/s;ctx.strokeRect(mx,my,mw,mh);
  png=out.toDataURL('image/png');
  if(png.length<=200000||out.width===1&&out.height===1)break;
  const next=scale*Math.min(.85,Math.sqrt(185000/png.length));
  scale=Math.max(1,Math.round(width*next))===out.width&&Math.max(1,Math.round(height*next))===out.height?Math.min((out.width-1)/width,(out.height-1)/height):next;
 }
 if(png.length>200000)throw new Error(t('COMMENT_CROP_LIMIT: mark a smaller region (PNG limit 150 KiB)'));
 const bytes=Uint8Array.from(atob(png.split(',')[1]!),c=>c.charCodeAt(0)),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
 return {path:`comment-crops/${sha256}.png`,sha256,png,width:out.width,height:out.height};
}
export function bindStageComments(host:Host):{refresh:()=>void;dispose:()=>void;active:()=>boolean;draft:()=>boolean}{
 const toggle=document.getElementById('stage-comment') as HTMLButtonElement;Object.assign(toggle.style,{whiteSpace:'nowrap',flex:'none'});
 const list=document.createElement('section');list.id='stage-comment-list';list.className='stage-comment-list stage-comment-ui';list.setAttribute('aria-label',t('Stage comments'));list.hidden=true;
 // An absolute overlay is not stage chrome: workspace measures stack children
 // to allocate Inspector height. Keep the list in its positioned main instead.
 const workspace=host.toolbar.closest('main');if(workspace)workspace.append(list);else host.toolbar.after(list);
 const refusalNote=document.createElement('small');refusalNote.id='stage-comment-refusal';refusalNote.setAttribute('role','status');refusalNote.hidden=true;Object.assign(refusalNote.style,{position:'absolute',width:'1px',height:'1px',overflow:'hidden',clipPath:'inset(50%)',whiteSpace:'nowrap'});toggle.after(refusalNote);toggle.setAttribute('aria-describedby',refusalNote.id);toggle.setAttribute('aria-controls',list.id);toggle.setAttribute('aria-expanded','false');const originalTitle=toEn(toggle.title);
 const updateRefusal=()=>{const raw=host.refusal?.()??null,reason=raw?t(raw):null,prev=refusalNote.textContent||'',nextTitle=reason??t(originalTitle);toggle.disabled=false;if(toggle.title!==nextTitle)toggle.title=nextTitle;if(refusalNote.title!==(reason??''))refusalNote.title=reason??'';if(refusalNote.textContent!==(reason??''))refusalNote.textContent=reason??'';refusalNote.hidden=!reason;if(!list.hidden&&(reason??'')!==prev)renderList();return reason;};
 const layers=new Map<StageComment['viewport'],HTMLDivElement>();for(const [key,pane]of Object.entries(host.viewports)){const layer=document.createElement('div');layer.className='stage-comment-layer';pane!.append(layer);layers.set(key as StageComment['viewport'],layer);}
 let enabled=false,disposed=false,pending:{view:StageComment['viewport'];start:MarkPoint;end:MarkPoint;mode:StageComment['mode'];id:number;interaction:number;settled:Promise<void>}|null=null,composer:HTMLFormElement|null=null,composerReadOnly=false,syncComposerLang:(()=>void)|null=null,draftMark:{view:StageComment['viewport'];mode:StageComment['mode'];screen:MarkRegion}|null=null,busy=false,last='',raf=0,interaction=0;
 const setCapture=(value:boolean)=>{enabled=value;toggle.setAttribute('aria-pressed',String(value||!list.hidden));for(const pane of Object.values(host.viewports))pane!.classList.toggle('stage-comment-mode',value);};
 const cancel=()=>{++interaction;const previous=pending;pending=null;if(previous){const pane=host.viewports[previous.view];if(pane?.hasPointerCapture(previous.id))pane.releasePointerCapture(previous.id);}composer?.remove();composer=null;composerReadOnly=false;syncComposerLang=null;draftMark=null;last='';};
 const assertCapture=()=>{const reason=updateRefusal();if(reason){cancel();setCapture(false);host.error(reason);throw new Error(reason);}if(host.blocked())throw new Error(t('COMMENT_BUSY: wait for inspection'));};
 const assertEdit=()=>{const reason=updateRefusal();if(reason){setCapture(false);host.error(reason);throw new Error(reason);}if(host.blocked())throw new Error(t('COMMENT_BUSY: wait for inspection'));};
 const jump=async(f:Feedback):Promise<boolean>=>{const mark=markOf(f);if(!mark)return false;const panes=Object.values(host.viewports).map(p=>({pane:p!,visibility:p!.style.visibility}));try{cancel();for(const {pane}of panes)pane.style.visibility='hidden';await host.restore(mark.bookmark,mark.frame===null);last='';return true;}catch(error){host.error(String(error));return false;}finally{for(const {pane,visibility}of panes)pane.style.visibility=visibility;}};
 const setOpen=(value:boolean)=>{
  if(!value){cancel();list.hidden=true;toggle.setAttribute('aria-expanded','false');setCapture(false);return;}
  if(host.shortcutBlocked?.()){host.error(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  const reason=updateRefusal();
  if(!reason&&host.blocked()){host.error(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  list.hidden=false;toggle.setAttribute('aria-expanded','true');renderList();
  if(reason){setCapture(false);host.error(reason);return;}
  setCapture(true);
 };
 const openComment=async(f:Feedback)=>{const mark=markOf(f);if(!mark)return;if(list.hidden)setOpen(true);if(list.hidden)return;if(await jump(f)){const reason=updateRefusal();setCapture(!reason&&!host.blocked());openComposer(mark.viewport,mark.screen,f,host.pose(mark.viewport)?.mode??mark.mode);}};
 const renderList=()=>{list.setAttribute('aria-label',t('Stage comments'));list.replaceChildren();const title=document.createElement('strong');title.textContent=t('Comments');list.append(title);const rawReason=host.refusal?.()??null,reason=rawReason?t(rawReason):null;if(reason){const note=document.createElement('small');note.className='stage-comment-refusal-note';note.title=reason;note.textContent=reason;Object.assign(note.style,{display:'block',marginTop:'4px',maxWidth:'100%',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});list.append(note);}const all=host.feedback().filter(f=>markOf(f));toggle.textContent=t(`Comment · C (${all.length})`);if(!all.length){const empty=document.createElement('p');empty.textContent=t(reason?'Read only · Escape closes':'Mark a point or region, then type. Enter saves · Escape cancels.');list.append(empty);}for(const [i,f]of all.entries()){
  const mark=markOf(f)!,row=document.createElement('div');row.className='stage-comment-item';row.dataset.commentId=f.id;
  const go=document.createElement('button');go.type='button';go.className='stage-comment-summary';go.textContent=`${i+1} · ${mark.mode.toUpperCase()} · ${mark.viewport.toUpperCase()} · ${mark.frame?`F${mark.frame.index} (${mark.frame.basis})`:t(feedbackTimingLabel(f))} · ${f.summary}`;go.onclick=()=>openComment(f);row.append(go);
  if(host.locked(f.id)){const submitted=document.createElement('span');submitted.textContent=t('Submitted');row.append(submitted);}
  list.append(row);
 }};
 const refresh=()=>{last='';renderList();};
 const openComposer=(view:StageComment['viewport'],screen:MarkRegion,existing?:Feedback,placementMode=host.pose(view)?.mode)=>{
  if(!existing){try{assertCapture();}catch{return;}}
  const currentMode=host.pose(view)?.mode;
  if(!placementMode||currentMode&&currentMode!==placementMode){cancel();return;}
  const locked=!!existing&&host.locked(existing.id),initialRefusal=existing?updateRefusal():null;
  if(existing&&!initialRefusal&&host.blocked()){host.error(t('COMMENT_BUSY: wait for inspection'));return;}
  composer?.remove();composerReadOnly=locked||!!initialRefusal;draftMark={view,mode:placementMode,screen};const generation=interaction;const pane=host.viewports[view]!,form=composer=document.createElement('form');form.className='stage-comment-composer stage-comment-ui';form.setAttribute('aria-label',t('Comment composer'));
  const field=document.createElement('input');field.type='text';field.maxLength=1000;field.setAttribute('aria-label',t('Comment text'));field.placeholder=t('Describe this spot…');field.value=existing?.summary??'';
  if(locked||initialRefusal){field.readOnly=true;field.setAttribute('aria-readonly','true');}
  const hint=document.createElement('small');hint.textContent=composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels';hint.textContent=t(hint.textContent);const error=document.createElement('p');error.setAttribute('role','alert');form.append(field,hint,error);
  const place=()=>{const w=form.offsetWidth||294,h=form.offsetHeight||132;Object.assign(form.style,{left:Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-w-4))+'px',top:Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-h-4))+'px'});};
  let removeBtn:HTMLButtonElement|null=null,errorSource='';
  if(existing&&!locked){
   const remove=removeBtn=document.createElement('button');remove.type='button';remove.className='stage-comment-delete';remove.textContent=t('Delete');
   remove.onclick=()=>{
    if(busy)return;
    try{
     assertEdit();if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
     const all=host.feedback(),index=all.findIndex(x=>x.id===existing.id);if(index>=0)all.splice(index,1);
     cancel();host.changed();refresh();
    }catch(e){errorSource=toEn(e instanceof Error?e.message:String(e));error.textContent=t(errorSource);place();}
   };
   form.append(remove);
  }
  // Capture all view context now; camera or dial changes while typing cannot rebind the mark.
  const pose=host.pose(view),bookmark=copy(host.bookmark()),turn=pose?copy(pose.turn):null;
  if(initialRefusal){errorSource=toEn(host.refusal?.()??initialRefusal);error.textContent=t(errorSource);host.error(t(errorSource));}
  else if(!existing&&pose&&!pose.frame&&!pose.timeBasis){errorSource=toEn(pose.frameReason??'COMMENT_FRAME_UNAVAILABLE: no explicit frame index');error.textContent=t(errorSource);}
  syncComposerLang=()=>{if(composer!==form)return;form.setAttribute('aria-label',t('Comment composer'));field.setAttribute('aria-label',t('Comment text'));field.placeholder=t('Describe this spot…');hint.textContent=t(composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels');if(removeBtn)removeBtn.textContent=t('Delete');if(errorSource)error.textContent=t(errorSource);};
  pane.append(form);place();
  const previous=existing?markOf(existing):null;
  const prepared=previous?Promise.resolve(previous.crop):pose?crop(pose,screen):Promise.reject(new Error('COMMENT_VIEW_UNAVAILABLE'));
  prepared.catch(()=>{});
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);pane.focus();}};
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;if(generation!==interaction||host.pose(view)&&host.pose(view)?.mode!==placementMode){cancel();return;}const summary=field.value.trim();if(!summary){field.focus();return;}try{
   if(existing){
    assertEdit();if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
    busy=true;field.disabled=true;
    existing.summary=summary;
   }else{
    assertCapture();if(!pose||!pose.frame&&!pose.timeBasis)throw new Error(t(pose?.frameReason??'COMMENT_FRAME_UNAVAILABLE: provide an explicit producer clock or a decoded reference frame index'));
    busy=true;field.disabled=true;
    const world=region(unprojectMark(screen,pose.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},pose.camera));
    const slots=pose.posed?drawnSlots(pose.posed,world):[];
    const comment:StageComment={schema:'rig-review-comment/1',mode:placementMode,viewport:view,frame:pose.frame,...(pose.timeBasis?{timeBasis:pose.timeBasis}:{}),time:pose.time,animation:pose.animation,sourceHash:pose.sourceHash,modelHash:pose.modelHash,referenceHash:pose.referenceHash,referenceId:pose.referenceId,camera:copy(pose.camera),screen,world,slots,crop:await prepared,bookmark};
    assertCapture();
    if(disposed||generation!==interaction||host.pose(view)?.mode!==placementMode)return;
    const n=pose.frame?.index??null;host.add({id:crypto.randomUUID(),frameStart:n,frameEnd:n,target:slots[0]?{kind:'slot',name:slots[0].slot}:{kind:'rig',name:pose.rig},category:'defect',summary,context:{animation:pose.animation,time:pose.time,frame:pose.frame?.basis==='producer'?n:null,...(turn?{turn:turn as any}:{}),interval:n===null?null:{frameStart:n,frameEnd:n,inclusive:true},comment:comment as any}},pose.side);
   }
   cancel();host.changed();refresh();
  }catch(e){const msg=e instanceof Error?e.message:String(e);errorSource=toEn(msg);error.textContent=t(errorSource);place();if(locked)host.error(t(errorSource));field.disabled=false;field.focus();}finally{busy=false;}};
  field.focus();last='';
 };
 const disposers:(()=>void)[]=[];
 for(const [key,pane]of Object.entries(host.viewports)){
  const view=key as StageComment['viewport'],local=(e:PointerEvent)=>{const r=pane!.getBoundingClientRect();return {x:Math.max(0,Math.min(pane!.clientWidth,e.clientX-r.left-pane!.clientLeft)),y:Math.max(0,Math.min(pane!.clientHeight,e.clientY-r.top-pane!.clientTop))};};
  const down=(e:PointerEvent)=>{if(e.button!==0||!e.isPrimary||(e.target as Element)?.closest?.('.stage-comment-ui,button,input'))return;if(enabled||!list.hidden){try{assertCapture();}catch{return;}}if(!enabled||host.blocked())return;e.preventDefault();e.stopImmediatePropagation();cancel();const at=local(e),mode=host.pose(view)?.mode;if(!mode)return;const generation=interaction;pending={view,start:at,end:at,mode,id:e.pointerId,interaction:generation,settled:host.pause()};pending.settled.catch(e=>{if(interaction===generation&&!disposed)host.error(String(e));});pane!.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();pending.end=local(e);draftMark={view,mode:pending.mode,screen:region(pending.start,pending.end)};last='';};
  const up=async(e:PointerEvent)=>{if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=pending;pending=null;if(pane!.hasPointerCapture(e.pointerId))pane!.releasePointerCapture(e.pointerId);try{await p.settled;assertCapture();if(disposed||interaction!==p.interaction||!enabled)return;const r=Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y)<4?region(p.start,p.start):region(p.start,p.end);openComposer(view,r,undefined,p.mode);}catch(error){host.error(String(error));cancel();}};
  const abort=(e:PointerEvent)=>{if(pending?.view===view&&pending.id===e.pointerId)cancel();};
  pane!.addEventListener('pointerdown',down,true);pane!.addEventListener('pointermove',move,true);pane!.addEventListener('pointerup',up,true);pane!.addEventListener('pointercancel',abort,true);pane!.addEventListener('lostpointercapture',abort,true);
  disposers.push(()=>{pane!.removeEventListener('pointerdown',down,true);pane!.removeEventListener('pointermove',move,true);pane!.removeEventListener('pointerup',up,true);pane!.removeEventListener('pointercancel',abort,true);pane!.removeEventListener('lostpointercapture',abort,true);});
 }
 const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&(pending||composer||(enabled||!list.hidden)&&!host.shortcutBlocked?.()&&!textEntryFocused(e.target))){e.preventDefault();setOpen(false);return;}if(e.defaultPrevented||e.repeat||e.ctrlKey||e.metaKey||e.altKey||textEntryFocused(e.target)||host.shortcutBlocked?.())return;if(e.key.toLowerCase()==='c'){e.preventDefault();setOpen(list.hidden);}};
 window.addEventListener('blur',cancel);document.addEventListener('keydown',key);toggle.onclick=()=>setOpen(list.hidden);
 const renderPins=()=>{if(disposed)return;const refusal=updateRefusal();if(refusal&&(enabled||pending||composer&&!composerReadOnly)){cancel();setCapture(false);host.error(refusal);}const all=host.feedback().map(f=>({f,mark:markOf(f)})).filter(x=>x.mark);
 const poses=new Map([...layers.keys()].map(view=>[view,host.pose(view)]));
 if(draftMark&&poses.get(draftMark.view)?.mode!==draftMark.mode||pending&&poses.get(pending.view)?.mode!==pending.mode)cancel();
 const signature=JSON.stringify([curLang(),refusal,all.map(({f,mark})=>[f.id,f.summary,mark!.mode,mark!.world]),[...poses].map(([view,p])=>[view,p?.mode,p?.animation,p?.frame,p?.timeBasis,p?.time,p?.turn,p?.camera,p?.referenceId,p?.referenceHash]),draftMark]);
 if(signature!==last){last=signature;for(const layer of layers.values())layer.replaceChildren();for(const [i,{f,mark:m}]of all.entries()){
  const mark=m!,pose=poses.get(mark.viewport),layer=layers.get(mark.viewport);if(refusal||!pose||!layer||pose.mode!==mark.mode||pose.animation!==mark.animation||pose.sourceHash!==mark.sourceHash||pose.modelHash!==mark.modelHash||pose.referenceId!==mark.referenceId||pose.referenceHash!==mark.referenceHash||JSON.stringify(pose.frame)!==JSON.stringify(mark.frame)||JSON.stringify(pose.timeBasis??null)!==JSON.stringify(mark.timeBasis??null)||Math.abs(pose.time-mark.time)>1e-7||JSON.stringify(pose.turn)!==JSON.stringify((f.context as any)?.turn??null))continue;
  const a=projectMark(mark.world,pose.camera),b=projectMark({x:mark.world.x+mark.world.width,y:mark.world.y+mark.world.height},pose.camera),r=region(a,b),box=rectElement(r),pin=document.createElement('button');pin.type='button';pin.className='stage-comment-pin stage-comment-ui';pin.textContent=String(i+1);pin.setAttribute('aria-label',`${t('Comment {0}:').replace('{0}',String(i+1))} ${f.summary}`);pin.title=f.summary;Object.assign(pin.style,{left:r.x+'px',top:r.y+'px'});pin.onclick=()=>openComment(f);layer.append(box,pin);
 }if(draftMark)layers.get(draftMark.view)?.append(rectElement(draftMark.screen));}};
 const paint=()=>{if(disposed)return;renderPins();raf=requestAnimationFrame(paint);};
 const offLang=onLang(()=>{if(disposed)return;updateRefusal();renderList();syncComposerLang?.();last='';renderPins();});
 refresh();paint();return {active:()=>enabled,draft:()=>!!pending||!!composer&&!composerReadOnly,refresh,dispose:()=>{disposed=true;offLang();cancelAnimationFrame(raf);cancel();window.removeEventListener('blur',cancel);document.removeEventListener('keydown',key);for(const dispose of disposers)dispose();for(const layer of layers.values())layer.remove();list.remove();refusalNote.remove();}};
}
