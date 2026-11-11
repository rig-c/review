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
export interface CommentRow {id:string;summary:string;context?:unknown}
export interface CommentUiPose extends Partial<Omit<CommentPose,'mode'>> {mode:string;camera:ControlNumericCamera}
export interface CommentUiMark extends Partial<Omit<StageComment,'mode'>> {mode:string;viewport:StageComment['viewport'];screen:MarkRegion;world:MarkRegion;crop:StageComment['crop'];bookmark:unknown}
/** A codec supplies only source-specific evidence; gesture, composer, pins and pixel capture stay here. */
export interface CommentCodec<Row extends CommentRow,Pose extends CommentUiPose> {
 read:(row:Row)=>CommentUiMark|null;signature:(pose:Pose)=>unknown;matches:(mark:CommentUiMark,pose:Pose,row:Row)=>boolean;
 label:(row:Row,mark:CommentUiMark)=>string;
 chips?:(pose:Pose,screen:MarkRegion,existing?:Row)=>{selected:string[];candidates:string[]};
 update?:(row:Row,summary:string,parts?:string[])=>Promise<Row>|Row;
 create:(pose:Pose,view:StageComment['viewport'],screen:MarkRegion,crop:StageComment['crop'],bookmark:unknown,summary:string,parts?:string[])=>Promise<Row>;
}
interface Host<Row extends CommentRow=Feedback,Pose extends CommentUiPose=CommentPose> {
 toolbar:HTMLElement;toggle?:HTMLButtonElement;listHost?:HTMLElement;viewports:Partial<Record<StageComment['viewport'],HTMLElement>>;
 pose:(view:StageComment['viewport'])=>Pose|null;pause:()=>Promise<void>;
 bookmark:()=>unknown;restore:(bookmark:unknown,timeOnly?:boolean)=>Promise<void>;
 feedback:()=>Row[];locked:(id:string)=>boolean;
 add:(feedback:Row,side?:'a'|'b')=>void;changed:()=>void;error:(message:string)=>void;
 general?:{create:(summary:string)=>Row;matches:(row:Row)=>boolean};
 refusal?:()=>string|null;blocked:()=>boolean;busy?:()=>boolean;busyError?:(message:string)=>void;shortcutBlocked?:()=>boolean;shortcutActive?:()=>boolean;codec?:CommentCodec<Row,Pose>;
}
const markOf=(f:Feedback):StageComment|null=>{try{const c=f.context as Record<string,unknown>|undefined;return c?.comment?parseStageComment(c.comment):null;}catch{return null;}};
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const t=(s:string)=>typeof i18nT==='function'?i18nT(s):s;
const toEn=(s:string)=>typeof i18nTr==='function'?i18nTr(s,'en'):s;
const onLang=(fn:()=>void)=>typeof i18nOnChange==='function'?i18nOnChange(fn):()=>{};
const curLang=()=>typeof i18nLang==='function'?i18nLang():'en';
function rectElement(r:MarkRegion):HTMLDivElement{const node=document.createElement('div');node.className='stage-comment-region';Object.assign(node.style,{left:r.x+'px',top:r.y+'px',width:Math.max(2,r.width)+'px',height:Math.max(2,r.height)+'px'});return node;}
async function crop(pose:CommentUiPose,r:MarkRegion):Promise<StageComment['crop']>{
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
export function bindStageComments<Row extends CommentRow=Feedback,Pose extends CommentUiPose=CommentPose>(host:Host<Row,Pose>):{refresh:()=>void;dispose:()=>void;active:()=>boolean;draft:()=>boolean}{
 const readMark=(row:Row):CommentUiMark|null=>host.codec?host.codec.read(row):markOf(row as unknown as Feedback);
 const toggle=host.toggle??document.getElementById('stage-comment') as HTMLButtonElement;if(!toggle)throw new Error('PARTS_WORKSPACE_NODE_REQUIRED: stage-comment');Object.assign(toggle.style,{whiteSpace:'nowrap',flex:'none'});
 const inline=!!host.listHost;
 const list=document.createElement('section');list.id='stage-comment-list';list.className='stage-comment-list stage-comment-ui';list.classList.toggle('stage-comment-list-inline',inline);list.setAttribute('aria-label',t(inline?'Issues':'Stage comments'));list.hidden=!inline;
 // An absolute overlay is not stage chrome: workspace measures stack children
 // to allocate Inspector height. Keep the list in its positioned main instead,
 // anchored below the toolbar even when the bar wraps (#284).
 const workspace=host.toolbar.closest('main');if(host.listHost)host.listHost.append(list);else if(workspace)workspace.append(list);else host.toolbar.after(list);
 const placeList=()=>{if(inline)return;const bar=host.toolbar.getBoundingClientRect?.(),parent=(workspace??host.toolbar).getBoundingClientRect?.();if(bar&&parent&&Number.isFinite(bar.bottom)&&Number.isFinite(parent.top)&&bar.bottom>parent.top){const topPx=`${Math.ceil(bar.bottom-parent.top)+5}px`;if(list.style.top!==topPx)list.style.top=topPx;}};
 const refusalNote=document.createElement('small');refusalNote.id='stage-comment-refusal';refusalNote.setAttribute('role','status');refusalNote.hidden=true;Object.assign(refusalNote.style,{position:'absolute',width:'1px',height:'1px',overflow:'hidden',clipPath:'inset(50%)',whiteSpace:'nowrap'});toggle.after(refusalNote);toggle.setAttribute('aria-describedby',refusalNote.id);toggle.setAttribute('aria-controls',list.id);toggle.setAttribute('aria-expanded',String(inline));const originalTitle=toEn(toggle.title);
 const updateRefusal=()=>{const raw=host.refusal?.()??null,reason=raw?t(raw):null,prev=refusalNote.textContent||'',nextTitle=reason??t(originalTitle);toggle.disabled=!!host.busy?.();toggle.setAttribute('aria-busy',String(toggle.disabled));if(toggle.title!==nextTitle)toggle.title=nextTitle;if(refusalNote.title!==(reason??''))refusalNote.title=reason??'';if(refusalNote.textContent!==(reason??''))refusalNote.textContent=reason??'';refusalNote.hidden=!reason;if(!list.hidden&&(reason??'')!==prev)renderList();return reason;};
 const layers=new Map<StageComment['viewport'],HTMLDivElement>();for(const [key,pane]of Object.entries(host.viewports)){const layer=document.createElement('div');layer.className='stage-comment-layer';pane!.append(layer);layers.set(key as StageComment['viewport'],layer);}
 let enabled=false,disposed=false,pending:{view:StageComment['viewport'];start:MarkPoint;end:MarkPoint;mode:string;id:number;interaction:number;settled:Promise<void>}|null=null,composer:HTMLFormElement|null=null,composerReadOnly=false,composerGeneral=false,syncComposerLang:(()=>void)|null=null,draftMark:{view:StageComment['viewport'];mode:string;screen:MarkRegion}|null=null,busy=false,last='',raf=0,interaction=0;
 const setCapture=(value:boolean)=>{enabled=value;toggle.setAttribute('aria-pressed',String(value||!inline&&!list.hidden));for(const pane of Object.values(host.viewports))pane!.classList.toggle('stage-comment-mode',value);};
 const cancel=()=>{++interaction;const previous=pending;pending=null;if(previous){const pane=host.viewports[previous.view];if(pane?.hasPointerCapture(previous.id))pane.releasePointerCapture(previous.id);}composer?.remove();composer=null;composerReadOnly=false;composerGeneral=false;syncComposerLang=null;draftMark=null;last='';};
 const assertCapture=()=>{const reason=updateRefusal();if(reason){cancel();setCapture(false);host.error(reason);throw new Error(reason);}if(host.blocked())throw new Error(t('COMMENT_BUSY: wait for inspection'));};
 const assertEdit=(general=false)=>{const reason=general?null:updateRefusal();if(reason){setCapture(false);host.error(reason);throw new Error(reason);}if(host.blocked())throw new Error(t('COMMENT_BUSY: wait for inspection'));};
 let jumpGeneration = 0;
 let hiddenPanes: {pane: HTMLElement; visibility: string}[] | null = null;
 const jump = async (row: Row): Promise<boolean> => {
  const mark = readMark(row);if (!mark) return false;
  cancel();const generation = interaction, request = ++jumpGeneration;
  hiddenPanes ??= Object.values(host.viewports).map(pane => ({pane: pane!, visibility: pane!.style.visibility}));
  try {
   for (const {pane} of hiddenPanes) pane.style.visibility = 'hidden';
   await host.restore(mark.bookmark, mark.frame === null);
   if (disposed || request !== jumpGeneration || generation !== interaction) return false;
   last = '';return true;
  } catch (error) {
   if (!disposed && request === jumpGeneration) host.error(String(error));
   return false;
  } finally {
   if (request === jumpGeneration) {
    if (!disposed) for (const {pane, visibility} of hiddenPanes!) pane.style.visibility = visibility;
    hiddenPanes = null;
   }
  }
 };
 const setOpen=(value:boolean)=>{
  if(!value){cancel();list.hidden=!inline;toggle.setAttribute('aria-expanded',String(inline));setCapture(false);return;}
  if(host.busy?.()){(host.busyError??host.error)(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  if(host.shortcutBlocked?.()){host.error(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  const reason=updateRefusal();
  if(!reason&&host.blocked()){host.error(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  list.hidden=false;placeList();toggle.setAttribute('aria-expanded','true');renderList();
  if(reason){setCapture(false);host.error(reason);return;}
  setCapture(true);for(const view of layers.keys())host.pose(view);
 };
 const openComment=async(f:Row)=>{const mark=readMark(f);if(!mark){if(host.general?.matches(f))openComposer(null,{x:0,y:0,width:0,height:0},f);return;}if(list.hidden)setOpen(true);if(list.hidden)return;if(await jump(f)){const reason=updateRefusal();setCapture(!reason&&!host.blocked());openComposer(mark.viewport,mark.screen,f,host.pose(mark.viewport)?.mode??mark.mode);}};
 const renderList=()=>{placeList();list.setAttribute('aria-label',t(inline?'Issues':'Stage comments'));list.replaceChildren();const title=document.createElement('strong');title.textContent=t(inline?'Issues':'Comments');list.append(title);const rawReason=host.refusal?.()??null,reason=rawReason?t(rawReason):null;if(reason){const note=document.createElement('small');note.className='stage-comment-refusal-note';note.title=reason;note.textContent=reason;Object.assign(note.style,{display:'block',marginTop:'4px',maxWidth:'100%',whiteSpace:inline?'normal':'nowrap',overflow:'hidden',textOverflow:'ellipsis'});list.append(note);}if(host.general){const add=document.createElement('button');add.type='button';add.textContent=t('Add general comment');add.dataset.commentGeneral='';add.onclick=()=>openComposer(null,{x:0,y:0,width:0,height:0});list.append(add);}const all=host.feedback().filter(f=>readMark(f)||host.general?.matches(f));toggle.textContent=t(host.busy?.()?'Comment · C ({0}) · Rendering':'Comment · C ({0})').replace('{0}',String(all.length));if(!all.length){const empty=document.createElement('p');empty.textContent=t(inline?'No issues yet.':reason?'Read only · Escape closes':'Mark a point or region, then type. Enter saves · Escape cancels.');list.append(empty);}for(const [i,f]of all.entries()){
  const mark=readMark(f),row=document.createElement('div');row.className='stage-comment-item';row.dataset.commentId=f.id;
  const go=document.createElement('button');go.type='button';go.className='stage-comment-summary';go.textContent=!mark?`${i+1} · ${t('General comment')} · ${f.summary}`:host.codec?`${i+1} · ${host.codec.label(f,mark)}`:`${i+1} · ${mark.mode.toUpperCase()} · ${mark.viewport.toUpperCase()} · ${mark.frame?`F${mark.frame.index} (${mark.frame.basis})`:t(feedbackTimingLabel(f as unknown as Feedback))} · ${f.summary}`;go.onclick=()=>openComment(f);row.append(go);
  if(host.locked(f.id)){const submitted=document.createElement('span');submitted.textContent=t('Submitted');row.append(submitted);}
  list.append(row);
 }};
 const refresh=()=>{last='';renderList();renderPins();};
 const openComposer=(view:StageComment['viewport']|null,screen:MarkRegion,existing?:Row,placementMode=view?host.pose(view)?.mode:undefined)=>{
  const general=view===null; if(general&&!host.general)return;
  if(!existing){try{general?assertEdit(true):assertCapture();}catch{return;}}
  const currentMode=view?host.pose(view)?.mode:undefined;
  if(!general&&(!placementMode||currentMode&&currentMode!==placementMode)){cancel();return;}
  const locked=!!existing&&host.locked(existing.id),initialRefusal=existing&&!general?updateRefusal():null;
  if(existing&&!initialRefusal&&host.blocked()){host.error(t('COMMENT_BUSY: wait for inspection'));return;}
  composer?.remove();composerReadOnly=locked||!!initialRefusal;composerGeneral=general;draftMark=view?{view,mode:placementMode!,screen}:null;const generation=interaction;const pane=view?host.viewports[view]!:list,form=composer=document.createElement('form');form.className='stage-comment-composer stage-comment-ui';form.setAttribute('aria-label',t('Comment composer'));if(general)form.style.position='relative';
  const field=document.createElement('input');field.type='text';field.maxLength=1000;field.setAttribute('aria-label',t('Comment text'));field.placeholder=t('Describe this spot…');field.value=existing?.summary??'';
  if(locked||initialRefusal){field.readOnly=true;field.setAttribute('aria-readonly','true');}
  const hint=document.createElement('small');hint.textContent=composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels';hint.textContent=t(hint.textContent);const error=document.createElement('p');error.setAttribute('role','alert');form.append(field,hint,error);
  const place=()=>{if(general)return;const w=form.offsetWidth||294,h=form.offsetHeight||132;Object.assign(form.style,{left:Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-w-4))+'px',top:Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-h-4))+'px'});};
  let removeBtn:HTMLButtonElement|null=null,errorSource='';
  if(existing&&!locked){
   const remove=removeBtn=document.createElement('button');remove.type='button';remove.className='stage-comment-delete';remove.textContent=t('Delete');
   remove.onclick=()=>{
    if(busy)return;
    try{
     assertEdit(general);if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
     const all=host.feedback(),index=all.findIndex(x=>x.id===existing.id);if(index>=0)all.splice(index,1);
     cancel();host.changed();refresh();
    }catch(e){errorSource=toEn(e instanceof Error?e.message:String(e));error.textContent=t(errorSource);place();}
   };
   form.append(remove);
  }
  // Capture all view context now; camera or dial changes while typing cannot rebind the mark.
  const pose=view?host.pose(view):null,bookmark=general?null:copy(host.bookmark()),turn=pose?.turn===undefined?null:copy(pose.turn);
  const initialParts = pose ? host.codec?.chips?.(pose, screen, existing) : undefined;
  let selectedParts = initialParts?.selected.slice();
  const chipBox = initialParts ? document.createElement('div') : null;
  const chipNames = initialParts ? [...new Set([...initialParts.selected, ...initialParts.candidates])] : [];
  const syncChips = () => {
   if (!chipBox || !initialParts) return;
   chipBox.setAttribute('aria-label', t('Issue parts'));
   chipBox.replaceChildren(...chipNames.map(name => {
    const chip = document.createElement('button');
    chip.type = 'button';chip.textContent = name;chip.dataset.commentPart = name;chip.disabled = composerReadOnly || busy;
    chip.setAttribute('aria-pressed', String(selectedParts!.includes(name)));
    chip.onclick = () => {
     if (busy || composerReadOnly) return;
     const chosen = new Set(selectedParts);
     if (chosen.has(name)) chosen.delete(name);else chosen.add(name);
     selectedParts = chipNames.filter(part => chosen.has(part));
     syncChips();place();
    };
    return chip;
   }));
  };
  if (chipBox) {chipBox.className = 'stage-comment-parts';chipBox.setAttribute('role', 'group');form.append(chipBox);syncChips();}
  if(initialRefusal){errorSource=toEn(host.refusal?.()??initialRefusal);error.textContent=t(errorSource);host.error(t(errorSource));}
  else if(!host.codec&&!existing&&pose&&!pose.frame&&!pose.timeBasis){errorSource=toEn(pose.frameReason??'COMMENT_FRAME_UNAVAILABLE: no explicit frame index');error.textContent=t(errorSource);}
  syncComposerLang=()=>{if(composer!==form)return;form.setAttribute('aria-label',t('Comment composer'));if(general)form.style.position='relative';field.setAttribute('aria-label',t('Comment text'));field.placeholder=t('Describe this spot…');hint.textContent=t(composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels');if(removeBtn)removeBtn.textContent=t('Delete');if(errorSource)error.textContent=t(errorSource);syncChips();};
  pane.append(form);place();
  const previous=existing?readMark(existing):null;
  const prepared=general?Promise.resolve(null):previous?Promise.resolve(previous.crop):pose?crop(pose,screen):Promise.reject(new Error('COMMENT_VIEW_UNAVAILABLE'));
  prepared.catch(()=>{});
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);pane.focus();}};
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;if(generation!==interaction||view&&host.pose(view)&&host.pose(view!)?.mode!==placementMode){cancel();return;}const summary=field.value.trim();if(!summary){field.focus();return;}try{
   if(selectedParts && !selectedParts.length)throw new Error(t('Select at least one part.'));
   if(existing){
    assertEdit(general);if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
    busy=true;field.disabled=true;syncChips();
    if(!general&&host.codec?.update){
     const replacement=await host.codec.update(copy(existing),summary,selectedParts?.slice());
     if(disposed||generation!==interaction)return;
     assertEdit(general);if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
     const all=host.feedback(),index=all.indexOf(existing);
     if(index<0)return;
     all.splice(index,1,replacement);
    }else existing.summary=summary;
   }else if(general){assertEdit(true);host.add(host.general!.create(summary));
   }else{
    assertCapture();if(!pose||!host.codec&&!pose.frame&&!pose.timeBasis)throw new Error(t(pose?.frameReason??'COMMENT_FRAME_UNAVAILABLE: provide an explicit producer clock or a decoded reference frame index'));
    busy=true;field.disabled=true;syncChips();
    if(host.codec){const pixels=await prepared;if(disposed||generation!==interaction)return;assertCapture();const row=await host.codec.create(pose,view!,screen,pixels!,bookmark,summary,selectedParts?.slice());if(disposed||generation!==interaction)return;assertCapture();if(host.pose(view!)?.mode!==placementMode)return;host.add(row);}
    else {const rigPose=pose as unknown as CommentPose;
    const world=region(unprojectMark(screen,rigPose.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},rigPose.camera));
    const slots=rigPose.posed?drawnSlots(rigPose.posed,world):[];
    const comment:StageComment={schema:'rig-review-comment/1',mode:placementMode as StageComment['mode'],viewport:view!,frame:rigPose.frame,...(rigPose.timeBasis?{timeBasis:rigPose.timeBasis}:{}),time:rigPose.time,animation:rigPose.animation,sourceHash:rigPose.sourceHash,modelHash:rigPose.modelHash,referenceHash:rigPose.referenceHash,referenceId:rigPose.referenceId,camera:copy(rigPose.camera),screen,world,slots,crop:(await prepared)!,bookmark};
    assertCapture();
    if(disposed||generation!==interaction||host.pose(view!)?.mode!==placementMode)return;
    const n=rigPose.frame?.index??null;host.add({id:crypto.randomUUID(),frameStart:n,frameEnd:n,target:slots[0]?{kind:'slot',name:slots[0].slot}:{kind:'rig',name:rigPose.rig},category:'defect',summary,context:{animation:rigPose.animation,time:rigPose.time,frame:rigPose.frame?.basis==='producer'?n:null,...(turn?{turn:turn as any}:{}),interval:n===null?null:{frameStart:n,frameEnd:n,inclusive:true},comment:comment as any} } as unknown as Row,rigPose.side);
    }
   }
   cancel();host.changed();refresh();
  }catch(e){if(disposed||generation!==interaction)return;const msg=e instanceof Error?e.message:String(e);errorSource=toEn(msg);error.textContent=t(errorSource);place();if(locked)host.error(t(errorSource));field.disabled=false;field.focus();}finally{busy=false;if(composer===form)syncChips();}};
  field.focus();last='';
 };
 const disposers:(()=>void)[]=[];
 for(const [key,pane]of Object.entries(host.viewports)){
  const view=key as StageComment['viewport'],local=(e:PointerEvent)=>{const r=pane!.getBoundingClientRect();return {x:Math.max(0,Math.min(pane!.clientWidth,e.clientX-r.left-pane!.clientLeft)),y:Math.max(0,Math.min(pane!.clientHeight,e.clientY-r.top-pane!.clientTop))};};
  const down=(e:PointerEvent)=>{if(e.button!==0||!e.isPrimary||(e.target as Element)?.closest?.('.stage-comment-ui,button,input'))return;if(enabled||!inline&&!list.hidden){try{assertCapture();}catch{return;}}if(!enabled||host.blocked())return;e.preventDefault();e.stopImmediatePropagation();cancel();const mode=host.pose(view)?.mode;if(!mode)return;const at=local(e),generation=interaction;pending={view,start:at,end:at,mode,id:e.pointerId,interaction:generation,settled:host.pause()};pending.settled.catch(e=>{if(interaction===generation&&!disposed)host.error(String(e));});pane!.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();pending.end=local(e);draftMark={view,mode:pending.mode,screen:region(pending.start,pending.end)};last='';};
  const up=async(e:PointerEvent)=>{if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=pending;pending=null;if(pane!.hasPointerCapture(e.pointerId))pane!.releasePointerCapture(e.pointerId);try{await p.settled;assertCapture();if(disposed||interaction!==p.interaction||!enabled)return;const r=Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y)<4?region(p.start,p.start):region(p.start,p.end);openComposer(view,r,undefined,p.mode);}catch(error){host.error(String(error));cancel();}};
  const abort=(e:PointerEvent)=>{if(pending?.view===view&&pending.id===e.pointerId)cancel();};
  pane!.addEventListener('pointerdown',down,true);pane!.addEventListener('pointermove',move,true);pane!.addEventListener('pointerup',up,true);pane!.addEventListener('pointercancel',abort,true);pane!.addEventListener('lostpointercapture',abort,true);
  disposers.push(()=>{pane!.removeEventListener('pointerdown',down,true);pane!.removeEventListener('pointermove',move,true);pane!.removeEventListener('pointerup',up,true);pane!.removeEventListener('pointercancel',abort,true);pane!.removeEventListener('lostpointercapture',abort,true);});
 }
 const key=(e:KeyboardEvent)=>{if(host.shortcutActive&&!host.shortcutActive())return;if(e.key==='Escape'&&(pending||composer||(enabled||!inline&&!list.hidden)&&!host.shortcutBlocked?.()&&!textEntryFocused(e.target))){e.preventDefault();setOpen(false);return;}if(e.defaultPrevented||e.repeat||e.ctrlKey||e.metaKey||e.altKey||textEntryFocused(e.target)||host.shortcutBlocked?.())return;if(e.key.toLowerCase()==='c'){e.preventDefault();setOpen(inline?!enabled:list.hidden);}};
 window.addEventListener('blur',cancel);window.addEventListener('resize',placeList);document.addEventListener('keydown',key);toggle.onclick=()=>setOpen(inline?!enabled:list.hidden);
 const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(!disposed&&!list.hidden)placeList();}):null;if(ro){try{ro.observe(host.toolbar);if(workspace)ro.observe(workspace);}catch{}}
 const renderPins=()=>{if(disposed)return;if(!list.hidden)placeList();const refusal=updateRefusal();if(refusal&&(enabled||pending||composer&&!composerReadOnly&&!composerGeneral)){cancel();setCapture(false);host.error(refusal);}const all=host.feedback().map(f=>({f,mark:readMark(f)})).filter(x=>x.mark);
 // #356: a pose reads the pane's size (a forced layout after the played frame's writes); with no mark, draft or pending
 // capture there is nothing to place, so this per-frame loop skips it.
 const poses=new Map(all.length||draftMark||pending?[...layers.keys()].map(view=>[view,host.pose(view)]):[]);
 if(draftMark&&poses.get(draftMark.view)?.mode!==draftMark.mode||pending&&poses.get(pending.view)?.mode!==pending.mode)cancel();
 const signature=JSON.stringify([curLang(),refusal,all.map(({f,mark})=>[f.id,f.summary,mark!.mode,mark!.world]),[...poses].map(([view,p])=>[view,host.codec&&p?host.codec.signature(p):[p?.mode,p?.animation,p?.frame,p?.timeBasis,p?.time,p?.turn,p?.camera,p?.referenceId,p?.referenceHash]]),draftMark]);
 if(signature!==last){last=signature;for(const layer of layers.values())layer.replaceChildren();for(const [i,{f,mark:m}]of all.entries()){
  const mark=m!,pose=poses.get(mark.viewport),layer=layers.get(mark.viewport);if(refusal||!pose||!layer||(host.codec?!host.codec.matches(mark,pose,f):pose.mode!==mark.mode||pose.animation!==mark.animation||pose.sourceHash!==mark.sourceHash||pose.modelHash!==mark.modelHash||pose.referenceId!==mark.referenceId||pose.referenceHash!==mark.referenceHash||JSON.stringify(pose.frame)!==JSON.stringify(mark.frame)||JSON.stringify(pose.timeBasis??null)!==JSON.stringify(mark.timeBasis??null)||Math.abs((pose.time??0)-(mark.time??0))>1e-7||JSON.stringify(pose.turn)!==JSON.stringify((f.context as any)?.turn??null)))continue;
  const a=projectMark(mark.world,pose.camera),b=projectMark({x:mark.world.x+mark.world.width,y:mark.world.y+mark.world.height},pose.camera),r=region(a,b),box=rectElement(r),pin=document.createElement('button');pin.type='button';pin.className='stage-comment-pin stage-comment-ui';pin.textContent=String(i+1);pin.setAttribute('aria-label',`${t('Comment {0}:').replace('{0}',String(i+1))} ${f.summary}`);pin.title=f.summary;Object.assign(pin.style,{left:r.x+'px',top:r.y+'px'});pin.onclick=()=>openComment(f);layer.append(box,pin);
 }if(draftMark)layers.get(draftMark.view)?.append(rectElement(draftMark.screen));}};
 const paint=()=>{if(disposed)return;renderPins();raf=requestAnimationFrame(paint);};
 const offLang=onLang(()=>{if(disposed)return;updateRefusal();renderList();syncComposerLang?.();last='';renderPins();});
 refresh();paint();return {active:()=>enabled,draft:()=>!!pending||!!composer&&!composerReadOnly,refresh,dispose:()=>{disposed=true;ro?.disconnect();offLang();cancelAnimationFrame(raf);cancel();window.removeEventListener('blur',cancel);window.removeEventListener('resize',placeList);document.removeEventListener('keydown',key);for(const dispose of disposers)dispose();for(const layer of layers.values())layer.remove();toggle.onclick=null;list.remove();refusalNote.remove();}};
}
