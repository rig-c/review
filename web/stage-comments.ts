/** One gesture into the existing feedback record. No authoring or HTTP endpoint. */
import type {ModelAssets,PosedFrame} from '@rig-c/play';
import {paintInspectionViewport,pixelAlignedCrop,type ViewportCapture} from './viewport-capture.ts';
import type {Feedback} from '../src/session.ts';
import type {JobAnsweredDirectionFeedback} from '../src/job-contract.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import {drawnSlots,region,projectMark,unprojectMark,parseStageComment,feedbackTimingLabel,type MarkRegion,type MarkPoint,type StageComment} from '../src/stage-comment.ts';
import {applyDomI18n,getLanguage as i18nLang,onLanguageChange as i18nOnChange,t as i18nT,tr as i18nTr} from './i18n.ts';
import {panSpaceHeld,textEntryFocused} from './view-controls.ts';
import {boxesIntersect} from './label-placement.ts';
export interface CommentPose {
 mode:StageComment['mode'];camera:ControlNumericCamera;frame:StageComment['frame'];timeBasis?:StageComment['timeBasis'];time:number;animation:string|null;
 turn:unknown;sourceHash:string;modelHash:string|null;referenceHash:string|null;referenceId:string|null;frameReason?:string;
 capture?:ViewportCapture;rig:string;side?:'a'|'b';posed?:PosedFrame;assets?:ModelAssets;media?:HTMLVideoElement|HTMLImageElement;
 projection?:{worldToPane:(point:MarkPoint)=>MarkPoint;paneToWorld:(point:MarkPoint)=>MarkPoint;clip:MarkRegion};
}
export interface CommentRow {id:string;summary:string;context?:unknown}
export interface CommentUiPose extends Partial<Omit<CommentPose,'mode'>> {mode:string;camera:ControlNumericCamera}
export interface CommentUiMark extends Partial<Omit<StageComment,'mode'>> {mode:string;viewport:StageComment['viewport'];screen:MarkRegion;world:MarkRegion;crop:StageComment['crop'];bookmark:unknown}
/** A codec supplies only source-specific evidence; gesture, composer, pins and pixel capture stay here. */
export interface CommentCodec<Row extends CommentRow,Pose extends CommentUiPose> {
 read:(row:Row)=>CommentUiMark|null;signature:(pose:Pose)=>unknown;matches:(mark:CommentUiMark,pose:Pose,row:Row)=>boolean;
 label:(row:Row,mark:CommentUiMark)=>string;
 chips?:(pose:Pose,screen:MarkRegion,existing?:Row)=>{selected:string[];candidates:string[]};
 /** Opt in only when this codec can prepare replacement geometry and fresh pixel evidence. */
 geometry?:boolean;
 update?:(row:Row,summary:string,parts?:string[],geometry?:{pose:Pose;screen:MarkRegion;crop:StageComment['crop']})=>Promise<Row>|Row;
 create:(pose:Pose,view:StageComment['viewport'],screen:MarkRegion,crop:StageComment['crop'],bookmark:unknown,summary:string,parts?:string[])=>Promise<Row>;
}
interface RigAnchor {
 lastFrame:(animation:string|null)=>number|null;
 targetNames:(kind:Feedback['target']['kind'])=>readonly string[]|null;
 selectedTarget:()=>Feedback['target']|null;
}
interface Host<Row extends CommentRow=Feedback,Pose extends CommentUiPose=CommentPose> {
 toolbar:HTMLElement;toggle?:HTMLButtonElement;listHost?:HTMLElement;openList?:()=>void;hasPicture?:()=>boolean;viewports:Partial<Record<StageComment['viewport'],HTMLElement>>;
 pose:(view:StageComment['viewport'])=>Pose|null;pause:()=>Promise<void>;
 viewportAvailable?:(view:StageComment['viewport'])=>boolean;
 bookmark:()=>unknown;restore:(bookmark:unknown,timeOnly?:boolean,row?:Row)=>Promise<void>;
 feedback:()=>Row[];locked:(id:string)=>boolean;
 add:(feedback:Row,side?:'a'|'b')=>void;changed:()=>void|Promise<void>;draftChanged?:()=>void;error:(message:string)=>void;
 general?:{create:(summary:string)=>Row;matches:(row:Row)=>boolean;rows?:Row[];available?:()=>boolean;refusal?:()=>string|null};
 answeredDirectionFeedback?:readonly JobAnsweredDirectionFeedback[];
 rigAnchor?:RigAnchor;
 renderRow?:(row:Row,element:HTMLElement)=>void;
 /** #1062: the shown still picture a mark names, if any. A still picture has no clock, so its row shows the picture and the place, not a time. */
 picture?:(mark:StageComment)=>string|{name:string}|null;
 refusal?:()=>string|null;blocked:()=>boolean;busy?:()=>boolean;busyError?:(message:string)=>void;shortcutBlocked?:()=>boolean;shortcutActive?:()=>boolean;codec?:CommentCodec<Row,Pose>;
}
const markOf=(f:Feedback):StageComment|null=>{try{const c=f.context as Record<string,unknown>|undefined;return c?.comment?parseStageComment(c.comment):null;}catch{return null;}};
function commentItem():HTMLDivElement {
 const row=document.createElement('div');
 row.className='stage-comment-item';
 return row;
}
const commentLabels:Record<string,string>={setup:'Setup',animate:'Animate',compare:'Compare',rig:'Rig',reference:'Reference',a:'A',b:'B'};
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const t=(s:string)=>typeof i18nT==='function'?i18nT(s):s;
const toEn=(s:string)=>typeof i18nTr==='function'?i18nTr(s,'en'):s;
const onLang=(fn:()=>void)=>typeof i18nOnChange==='function'?i18nOnChange(fn):()=>{};
const curLang=()=>typeof i18nLang==='function'?i18nLang():'en';
const spaceHeld=()=>typeof panSpaceHeld==='function'&&panSpaceHeld();
const categoryLabels={defect:'Defect',quality:'Quality'} as const;
type RigAnchorFields=Pick<Feedback,'target'|'category'>&{frameStart:number;frameEnd:number};
const intervalOf=({frameStart,frameEnd}:RigAnchorFields)=>({frameStart,frameEnd,inclusive:true});

// The frame, target and category fields from Structured feedback, in the composer layout.
const rigAnchorMarkup=`<div class="stage-comment-anchor-row">
  <div class="label">Frame range · inclusive</div>
  <div class="frame-range">
   <label>Start<input id="feedback-start" type="number" min="0" step="1" inputmode="numeric"></label>
   <label>End<input id="feedback-end" type="number" min="0" step="1" inputmode="numeric"></label>
  </div>
 </div>
 <small id="feedback-range-hint" hidden></small>
 <div class="stage-comment-anchor-row">
  <label for="feedback-target-kind" class="label space-top">Target type</label>
  <select id="feedback-target-kind"><option value="rig">Entire rig</option><option value="bone">Bone</option><option value="slot">Slot</option></select>
  <label for="feedback-target-name" class="label space-top">Target name</label>
  <input id="feedback-target-name" type="text" list="feedback-target-names" autocomplete="off" placeholder="Actual bone or slot name">
  <datalist id="feedback-target-names"></datalist>
 </div>
 <div class="stage-comment-anchor-row">
  <label for="feedback-category" class="label space-top">Category</label>
  <select id="feedback-category"><option value="defect">Defect</option><option value="quality">Quality</option></select>
 </div>`;

function mountRigAnchor(
 hint:HTMLElement,anchor:RigAnchor,pin:number,animation:string|null,fallback:Feedback['target'],
 existing:Feedback|undefined,readOnly:boolean,draftChanged?:()=>void
) {
 const box=document.createElement('div');
 box.className='stage-comment-anchor';
 box.innerHTML=rigAnchorMarkup;
 const start=box.querySelector<HTMLInputElement>('#feedback-start')!;
 const end=box.querySelector<HTMLInputElement>('#feedback-end')!;
 const kind=box.querySelector<HTMLSelectElement>('#feedback-target-kind')!;
 const name=box.querySelector<HTMLInputElement>('#feedback-target-name')!;
 const names=box.querySelector<HTMLDataListElement>('#feedback-target-names')!;
 const category=box.querySelector<HTMLSelectElement>('#feedback-category')!;
 const bounds=box.querySelector<HTMLElement>('#feedback-range-hint')!;
 const last=anchor.lastFrame(animation);
 const selection=existing?existing.target:anchor.selectedTarget();
 const target=selection&&(existing||anchor.targetNames(selection.kind)?.includes(selection.name))?selection:fallback;
 start.value=String(existing?.frameStart??pin);start.max=String(pin);
 end.value=String(existing?.frameEnd??pin);end.min=String(pin);
 if(last!==null)end.max=String(last);
 kind.value=target.kind;name.value=target.name;category.value=existing?.category??'defect';
 const targetNames=()=>kind.value?anchor.targetNames(kind.value as Feedback['target']['kind']):null;
 const syncTargets=()=>{
  const options=(targetNames()??[]).map(value=>{
   const option=document.createElement('option');
   option.value=value;
   return option;
  });
  names.replaceChildren(...options);
  name.readOnly=readOnly||kind.value==='rig';
 };
 kind.onchange=()=>{
  syncTargets();
  name.value=kind.value==='rig'?targetNames()?.[0]??'':'';
 };
 const syncBounds=()=>{
  bounds.hidden=!(start.valueAsNumber<0||last!==null&&end.valueAsNumber>last);
  bounds.textContent=bounds.hidden?'':last===null?t('Bounds unknown · enter an inclusive integer frame range. FPS is not inferred.')
   :last<0?t('No frames overlap the explicit clock and selected clip.')
   :t('F0–F{0} for the explicit clock and current clip · inclusive').replace('{0}',String(last));
 };
 box.oninput=()=>{syncBounds();draftChanged?.();};
 const controls=[start,end,kind,name,category];
 const setBusy=(busy:boolean)=>{for(const control of controls)control.disabled=busy||readOnly;};
 syncTargets();setBusy(false);
 hint.before(box);
 const localize=()=>{applyDomI18n(box);syncBounds();};
 localize();
 return {
  localize,setBusy,
  read():RigAnchorFields{
   const frameStart=start.valueAsNumber,frameEnd=end.valueAsNumber;
   if(!Number.isSafeInteger(frameStart)||!Number.isSafeInteger(frameEnd)||frameStart<0||frameEnd<frameStart)
    throw new Error('Enter nonnegative integer start and end frames, with the end at or after the start.');
   if(frameStart>pin||frameEnd<pin)throw new Error('COMMENT_CONTEXT_MISMATCH: frame, time or animation differs');
   if(last!==null&&frameEnd>last)
    throw new Error(t('feedback.frameEnd: {0} beyond clip last frame {1}').replace('{0}',String(frameEnd)).replace('{1}',String(last)));
   const targetKind=kind.value;
   const classification=category.value;
   if((targetKind!=='rig'&&targetKind!=='bone'&&targetKind!=='slot')||(classification!=='defect'&&classification!=='quality'))
    throw new Error('Select a target type and defect or quality category.');
   if(!name.value.trim())throw new Error('Enter the actual target name and a one-line summary of up to 1,000 characters.');
   if(!targetNames()?.includes(name.value))throw new Error('feedback.target.name: not in inspected model/package');
   return {frameStart,frameEnd,target:{kind:targetKind,name:name.value},category:classification};
  }
 };
}

function rigCommentGeometry(pose:CommentPose,screen:MarkRegion) {
 const unproject=pose.projection?.paneToWorld??(point=>unprojectMark(point,pose.camera));
 const world=region(unproject(screen),unproject({x:screen.x+screen.width,y:screen.y+screen.height}));
 const slots=pose.posed?drawnSlots(pose.posed,world):[];
 const target:Feedback['target']=slots[0]?{kind:'slot',name:slots[0].slot}:{kind:'rig',name:pose.rig};
 return {world,slots,target};
}

function clipMark(mark:MarkRegion,clip?:MarkRegion):MarkRegion|null {
 if(!clip)return mark;
 const right=mark.x+mark.width,bottom=mark.y+mark.height;
 if(right<clip.x||bottom<clip.y||mark.x>clip.x+clip.width||mark.y>clip.y+clip.height)return null;
 return region(mark,{x:right,y:bottom},clip);
}

function markOnPane(mark:CommentUiMark,pose:CommentUiPose):MarkRegion {
 const project=pose.projection?.worldToPane??(point=>projectMark(point,pose.camera));
 const {x,y,width,height}=mark.world;
 return region(project({x,y}),project({x:x+width,y:y+height}));
}

function rigCommentLabel(feedback:Feedback,frame:StageComment['frame'],seconds:string):string {
 if(!frame)return `${seconds} · ${feedback.target.name} · ${t(categoryLabels[feedback.category])}`;
 const start=feedback.frameStart??frame.index,end=feedback.frameEnd??frame.index;
 const label=start===end?`F${start}`:t('F{0}–{1}').replace('{0}',String(start)).replace('{1}',String(end));
 const timing=t(`F{0} (${frame.basis})`).replace('F{0}',label);
 return `${timing} · ${feedback.target.name} · ${t(categoryLabels[feedback.category])}`;
}

const resizeHandles=[['nw',0,0],['n',.5,0],['ne',1,0],['e',1,.5],['se',1,1],['s',.5,1],['sw',0,1],['w',0,.5]] as const;
function rectElement(r:MarkRegion):HTMLDivElement{const node=document.createElement('div');node.className='stage-comment-region';Object.assign(node.style,{left:r.x+'px',top:r.y+'px',width:Math.max(2,r.width)+'px',height:Math.max(2,r.height)+'px'});return node;}
async function crop(pose:CommentUiPose,r:MarkRegion):Promise<StageComment['crop']>{
 if(!pose.capture)throw new Error(t('COMMENT_CROP_UNAVAILABLE: viewport pixel source unavailable'));
 const camera=pose.camera,padding=24,rawLeft=Math.max(0,Math.floor(r.x-padding)),rawTop=Math.max(0,Math.floor(r.y-padding)),pane=pose.capture.pane,bounds=pane.getBoundingClientRect(),ratio=globalThis.devicePixelRatio||1;
 const padded=clipMark({x:rawLeft,y:rawTop,width:Math.min(camera.viewport.width-rawLeft,Math.ceil(r.width+2*padding)),height:Math.min(camera.viewport.height-rawTop,Math.ceil(r.height+2*padding))},pose.projection?.clip);
 if(!padded)throw new Error(t('COMMENT_CROP_UNAVAILABLE: mark is outside the viewport'));
 const {x:left,y:top,width,height}=pixelAlignedCrop(padded,{x:bounds.left+pane.clientLeft,y:bounds.top+pane.clientTop},ratio);
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
export function bindStageComments<Row extends CommentRow=Feedback,Pose extends CommentUiPose=CommentPose>(host:Host<Row,Pose>):{refresh:()=>void;dispose:()=>void;active:()=>boolean;draft:()=>boolean;hasPendingComment:()=>boolean;commitDraft:()=>Promise<boolean>}{
 const available=(view:StageComment['viewport'])=>host.viewportAvailable?.(view)!==false;
 const poseFor=(view:StageComment['viewport'])=>available(view)?host.pose(view):null;
 const readMark=(row:Row):CommentUiMark|null=>host.codec?host.codec.read(row):markOf(row as unknown as Feedback);
 const toggle=host.toggle??document.getElementById('stage-comment') as HTMLButtonElement;if(!toggle)throw new Error('PARTS_WORKSPACE_NODE_REQUIRED: stage-comment');Object.assign(toggle.style,{whiteSpace:'nowrap',flex:'none'});
 const inline=!!host.listHost;
 const list=document.createElement('section');list.id='stage-comment-list';list.className='stage-comment-list stage-comment-ui';list.classList.toggle('stage-comment-list-inline',inline);list.setAttribute('aria-label',t('Comments'));list.hidden=!inline;
 // An absolute overlay is not stage chrome: workspace measures stack children
 // to allocate Inspector height. Keep the list in its positioned main instead,
 // anchored below the toolbar even when the bar wraps (#284).
 const workspace=host.toolbar.closest('main');if(host.listHost)host.listHost.append(list);else if(workspace)workspace.append(list);else host.toolbar.after(list);
 const placeList=()=>{if(inline)return;const bar=host.toolbar.getBoundingClientRect?.(),parent=(workspace??host.toolbar).getBoundingClientRect?.();if(bar&&parent&&Number.isFinite(bar.bottom)&&Number.isFinite(parent.top)&&bar.bottom>parent.top){const topPx=`${Math.ceil(bar.bottom-parent.top)+5}px`;if(list.style.top!==topPx)list.style.top=topPx;}};
 const refusalNote=document.createElement('small');refusalNote.id='stage-comment-refusal';refusalNote.setAttribute('role','status');refusalNote.hidden=true;Object.assign(refusalNote.style,{position:'absolute',width:'1px',height:'1px',overflow:'hidden',clipPath:'inset(50%)',whiteSpace:'nowrap'});toggle.after(refusalNote);toggle.setAttribute('aria-describedby',refusalNote.id);toggle.setAttribute('aria-controls',list.id);toggle.setAttribute('aria-expanded',String(inline));
 const updateRefusal=()=>{const raw=host.refusal?.()??null,reason=raw?t(raw):null,prev=refusalNote.textContent||'',nextTitle=reason??t('Comment · C');toggle.disabled=!!host.busy?.();toggle.setAttribute('aria-busy',String(toggle.disabled));if(toggle.title!==nextTitle)toggle.title=nextTitle;if(refusalNote.title!==(reason??''))refusalNote.title=reason??'';if(refusalNote.textContent!==(reason??''))refusalNote.textContent=reason??'';refusalNote.hidden=!reason;if(!list.hidden&&(reason??'')!==prev)renderList();return reason;};
 const layers=new Map<StageComment['viewport'],HTMLDivElement>();for(const [key,pane]of Object.entries(host.viewports)){const layer=document.createElement('div');layer.className='stage-comment-layer';pane!.append(layer);layers.set(key as StageComment['viewport'],layer);}
 let enabled=false,disposed=false,pending:{view:StageComment['viewport'];start:MarkPoint;end:MarkPoint;mode:string;id:number;interaction:number;settled:Promise<void>}|null=null,composer:HTMLFormElement|null=null,composerField:HTMLInputElement|null=null,composerSubmit:(()=>Promise<boolean>)|null=null,composerReadOnly=false,composerGeneral=false,syncComposerLang:(()=>void)|null=null,draftMark:{view:StageComment['viewport'];mode:string;screen:MarkRegion}|null=null,busy=false,last='',raf=0,interaction=0;
 let geometryEdit:{view:StageComment['viewport'];screen:MarkRegion;id?:string;update:(screen:MarkRegion)=>void;changed:boolean;camera:string}|null=null;
 let geometryDrag:{id:number;start:MarkPoint;screen:MarkRegion;handle:string}|null=null;
 let suppressPinClick=false;
 let pinPress:{id:number;view:StageComment['viewport'];start:MarkPoint;pin:HTMLButtonElement}|null=null;
 const setCapture=(value:boolean)=>{value=value&&host.hasPicture?.()!==false;enabled=value;toggle.setAttribute('aria-pressed',String(value||!inline&&!list.hidden));for(const pane of Object.values(host.viewports))pane!.classList.toggle('stage-comment-mode',value);};
 const cancel=()=>{++interaction;const hadComposer=!!composer,previous=pending??(geometryDrag&&geometryEdit?{view:geometryEdit.view,id:geometryDrag.id}:pinPress);geometryEdit=null;geometryDrag=null;pinPress=null;pending=null;if(previous){const pane=host.viewports[previous.view];if(pane?.hasPointerCapture(previous.id))pane.releasePointerCapture(previous.id);}composer?.remove();composer=null;composerField=null;composerSubmit=null;composerReadOnly=false;composerGeneral=false;syncComposerLang=null;draftMark=null;last='';if(hadComposer)host.draftChanged?.();};
 const assertCapture=()=>{const reason=updateRefusal();if(reason){cancel();setCapture(false);host.error(reason);throw new Error(reason);}if(host.blocked())throw new Error(t('COMMENT_BUSY: wait for inspection'));};
 const generalRefusal=()=>host.general?.refusal?.()??null;
 const assertWritable=(reason:string|null)=>{if(reason){setCapture(false);host.error(reason);throw new Error(reason);}if(host.blocked())throw new Error(t('COMMENT_BUSY: wait for inspection'));};
 const assertEdit=(general=false)=>assertWritable(general?(generalRefusal()??(host.general?.available?.()===false?t('JOB_ACT_NOTHING_TO_SUBMIT'):null)):updateRefusal());
 let jumpGeneration = 0;
 let hiddenPanes: {pane: HTMLElement; visibility: string}[] | null = null;
 const jump = async (row: Row): Promise<boolean> => {
  const mark = readMark(row);if (!mark) return false;
  cancel();const generation = interaction, request = ++jumpGeneration;
  // Editing a mark already visible in this parts view must not replay its navigation bookmark.
  const pose=poseFor(mark.viewport);
  if(host.codec?.geometry&&pose&&host.codec.matches(mark,pose,row)){last='';return true;}

  hiddenPanes ??= Object.values(host.viewports).map(pane => ({pane: pane!, visibility: pane!.style.visibility}));
  try {
   // The destination controls whether capture can resume after the saved mark is restored.
   setCapture(false);
   for (const {pane} of hiddenPanes) pane.style.visibility = 'hidden';
   await host.restore(mark.bookmark, mark.frame === null, row);
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
 const revealLatest=()=>{
  if(inline&&list.closest('.workspace-review-panel'))list.lastElementChild?.scrollIntoView({block:'nearest',behavior:'instant'});
 };
 const setOpen=(value:boolean)=>{
  if(!value){cancel();list.hidden=!inline;toggle.setAttribute('aria-expanded',String(inline));setCapture(false);return;}
  if(host.busy?.()){(host.busyError??host.error)(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  if(host.shortcutBlocked?.()){host.error(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  const reason=updateRefusal();
  if(!reason&&host.blocked()){host.error(t('COMMENT_BUSY: close the active editor or wait for the inspection to settle'));return;}
  list.hidden=false;host.openList?.();placeList();toggle.setAttribute('aria-expanded','true');renderList();
  // Explicitly opening Comments reveals the newest row within its own panel.
  // Refreshes never change the reviewer's scroll position.
  revealLatest();
  if(reason){setCapture(false);host.error(reason);return;}
  setCapture(layers.size>0);for(const view of layers.keys())poseFor(view);
 };
 const openComment=async(f:Row)=>{const mark=readMark(f);if(!mark){if(host.general?.matches(f))openComposer(null,{x:0,y:0,width:0,height:0},f);return;}if(list.hidden)setOpen(true);if(list.hidden)return;if(await jump(f)){const reason=updateRefusal();setCapture(!reason&&!host.blocked());const pose=poseFor(mark.viewport),picture=host.codec?null:host.picture?.(mark as StageComment),screen=pose&&(pose.projection||host.codec?.geometry||picture&&typeof picture==='object')?markOnPane(mark,pose):mark.screen;openComposer(mark.viewport,screen,f,pose?.mode??mark.mode);}};
 const renderList=()=>{
  placeList();
  list.setAttribute('aria-label',t('Comments'));
  // Refresh the rows in place so a list-hosted composer never loses focus or selection.
  const retained=composer?.parentElement===list?composer:null;
  if(retained){
   for(const child of Array.from(list.children)){
    if(child!==retained)child.remove();
   }
  }else{
   list.replaceChildren();
  }
  const append=(node:HTMLElement)=>retained?retained.before(node):list.append(node);
  const title=document.createElement('strong');
  title.textContent=t('Comments');
  append(title);
  const rawReason=host.refusal?.()??null,reason=rawReason?t(rawReason):null;
  if(reason){
   const note=document.createElement('small');note.className='stage-comment-refusal-note';note.title=reason;note.textContent=reason;
   Object.assign(note.style,{display:'block',marginTop:'4px',maxWidth:'100%',whiteSpace:inline?'normal':'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
   append(note);
  }
  if(host.general&&host.general.available?.()!==false){
   const add=document.createElement('button');add.type='button';add.textContent=t('Add general comment');add.dataset.commentGeneral='';
   add.onclick=()=>openComposer(null,{x:0,y:0,width:0,height:0});
   append(add);
  }
  const all=host.feedback().filter(f=>readMark(f)||host.general?.matches(f));
  if(host.general?.rows)all.push(...host.general.rows);
  toggle.textContent=t(host.busy?.()?'Comment · C ({0}) · Rendering':'Comment · C ({0})').replace('{0}',String(all.length));
  if(!all.length){
   const empty=document.createElement('p');
   const canPin=!reason&&layers.size>0&&host.hasPicture?.()!==false;
   empty.textContent=t(inline
    ? (canPin?'Comment · C → click the image to pin':'No comments yet.')
    : (reason?'Read only · Escape closes':'Mark a point or region, then type. Enter saves · Escape cancels.'));
   append(empty);
  }
  for(const feedback of host.answeredDirectionFeedback??[])for(const comment of feedback.comments){
   const row=commentItem();
   row.classList.add('stage-comment-answered');
   row.setAttribute('translate','no');
   const kind=document.createElement('span');
   kind.textContent=`${t(comment.kind==='general'?'General comment':'Stage comments')} · v${feedback.postVersion}`;
   const body=document.createElement('div');
   body.textContent=comment.text;
   const status=document.createElement('span');
   status.textContent=t('Answered by v{0}').replace('{0}',String(feedback.answeredByPostVersion));
   row.append(kind,body,status);
   append(row);
  }
  for(const [i,f]of all.entries()){
   const mark=readMark(f),row=commentItem();row.dataset.commentId=f.id;
   const picture=mark&&!host.codec?host.picture?.(mark as StageComment)??null:null;
   const [timing,frameReason]=mark&&!host.codec&&!picture&&!mark.frame?feedbackTimingLabel(f as unknown as Feedback).split(' · '):[];
   const rigFeedback=!host.codec&&host.rigAnchor&&mark?.viewport==='rig'&&'target' in f?f as unknown as Feedback:null;
   const place=picture?t(mark!.world.width>0||mark!.world.height>0?'Region':'Point'):'';
   const picturePlace=typeof picture==='string'?`${picture} · ${place}`:picture?place+t(' on {0}').replace('{0}',picture.name):null;
   const go=document.createElement('button');go.type='button';go.className='stage-comment-summary';if(frameReason)go.title=t(frameReason);
   const frameLabel=rigFeedback?rigCommentLabel(rigFeedback,mark?.frame??null,t(timing??'')):mark?.frame?t(`F${mark.frame.index} (${mark.frame.basis})`):t(timing??'');
   go.textContent=!mark?`${i+1} · ${t('General comment')} · ${f.summary}`:host.codec?`${i+1} · ${host.codec.label(f,mark)}`:picture?`${i+1} · ${picturePlace} · ${f.summary}`:`${i+1} · ${t(commentLabels[mark.mode]??mark.mode)} · ${t(commentLabels[mark.viewport]??mark.viewport)} · ${frameLabel} · ${f.summary}${frameReason?` · ${t('Frame unavailable')}`:''}`;
   go.onclick=()=>openComment(f);row.append(go);
   if(host.locked(f.id)){const submitted=document.createElement('span');submitted.textContent=t('Submitted');row.append(submitted);}
   append(row);
   host.renderRow?.(f,row);
  }
 };
 const refresh=()=>{last='';renderList();renderPins();};
 const openComposer=(view:StageComment['viewport']|null,screen:MarkRegion,existing?:Row,placementMode=view?poseFor(view)?.mode:undefined)=>{
  if(view&&!available(view))return;
  const general=view===null;
  const generalAvailable=!general||host.general?.available?.()!==false;
  if(general&&(!host.general||(!existing&&!generalAvailable)))return;
  if(!existing){try{general?assertEdit(true):assertCapture();}catch{return;}}
  const currentMode=view?poseFor(view)?.mode:undefined;
  if(!general&&(!placementMode||currentMode&&currentMode!==placementMode)){cancel();return;}
  const locked=!!existing&&host.locked(existing.id),initialRefusal=existing?(general?generalRefusal():updateRefusal()):null;
  if(existing&&!initialRefusal&&host.blocked()){host.error(t('COMMENT_BUSY: wait for inspection'));return;}
  geometryEdit=null;composer?.remove();composerReadOnly=locked||!!initialRefusal||!generalAvailable;composerGeneral=general;draftMark=view?{view,mode:placementMode!,screen}:null;const generation=interaction;const pane=view?host.viewports[view]!:list,form=composer=document.createElement('form');form.className='stage-comment-composer stage-comment-ui';form.setAttribute('aria-label',t('Comment composer'));if(general)form.style.position='relative';
  const field=composerField=document.createElement('input');field.type='text';field.maxLength=1000;field.setAttribute('aria-label',t('Comment text'));field.placeholder=t('Describe this spot…');field.value=existing?.summary??'';field.oninput=()=>host.draftChanged?.();
  if(composerReadOnly){field.readOnly=true;field.setAttribute('aria-readonly','true');}
  const hint=document.createElement('small');hint.textContent=composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels';hint.textContent=t(hint.textContent);const error=document.createElement('p');error.setAttribute('role','alert');form.append(field,hint,error);
  const place=()=>{if(general)return;
   if(host.codec?.geometry){
    const previousPlacement={position:form.style.position,left:form.style.left,top:form.style.top,width:form.style.width,height:form.style.height,maxWidth:form.style.maxWidth,maxHeight:form.style.maxHeight,zIndex:form.style.zIndex};
    Object.assign(form.style,{position:'absolute',height:'',maxWidth:'',maxHeight:'',zIndex:''});
    const right=pane.clientWidth-screen.x-screen.width-12,left=screen.x-12,available=Math.max(left,right);
    let x:number,y:number;
    if(available>=160){
     const width=Math.min(286,available);form.style.width=width+'px';const height=form.offsetHeight||132;
     x=right>=left?screen.x+screen.width+8:screen.x-width-8;y=Math.max(4,Math.min(screen.y,pane.clientHeight-height-4));
    }else{
     form.style.width='';const w=form.offsetWidth||294,h=form.offsetHeight||132;
     x=Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-w-4));y=Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-h-4));
    }
    const w=form.getBoundingClientRect().width||form.offsetWidth||294,h=form.offsetHeight||132,radius=7;
    const clampX=(v:number)=>Math.max(4,Math.min(v,pane.clientWidth-w-4)),clampY=(v:number)=>Math.max(4,Math.min(v,pane.clientHeight-h-4));
    const outside=(p:{x:number;y:number})=>!boxesIntersect({...p,w,h},{x:screen.x-radius,y:screen.y-radius,w:screen.width+2*radius,h:screen.height+2*radius});
    const handles=resizeHandles;
    const points=handles.map(([name,dx,dy])=>({name,x:screen.x+screen.width*dx,y:screen.y+screen.height*dy}));
    const covers=(p:{x:number;y:number},at:{x:number;y:number})=>boxesIntersect({...p,w,h},{x:at.x-radius,y:at.y-radius,w:2*radius,h:2*radius});
    const pointer=geometryDrag&&(geometryDrag.handle==='move'?{x:geometryDrag.start.x+screen.x-geometryDrag.screen.x,y:geometryDrag.start.y+screen.y-geometryDrag.screen.y}:points.find(p=>p.name===geometryDrag!.handle));
    const candidates=[{x,y},...[
     [right>=left?screen.x-w-8:screen.x+screen.width+8,screen.y],
     [screen.x,screen.y+screen.height+8],[screen.x,screen.y-h-8],
    ].map(([cx,cy])=>({x:clampX(cx!),y:clampY(cy!)}))];
    // A held handle must never acquire the composer under its pointer.
    const usable=(p:{x:number;y:number})=>!pointer||!covers(p,pointer);
    let chosen=candidates.find(p=>outside(p)&&usable(p));
    if(!chosen){
     // Handle edges partition all possible placements into constant hit-count cells,
     // including the interior of a large area. Boundaries suffice; no pixel scan.
     const xs=[x,4,pane.clientWidth-w-4,...points.flatMap(p=>[p.x-radius-w,p.x+radius])].map(clampX);
     const ys=[y,4,pane.clientHeight-h-4,...points.flatMap(p=>[p.y-radius-h,p.y+radius])].map(clampY);
     candidates.push(...xs.flatMap(cx=>ys.map(cy=>({x:cx,y:cy}))).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y)));
     const safe=candidates.filter(usable);
     const pool=safe.length?safe:candidates;
     chosen=pool.reduce((best,p)=>points.filter(at=>covers(p,at)).length<points.filter(at=>covers(best,at)).length?p:best,pool[0]!);
    }
    if(points.some(at=>covers(chosen!,at))&&workspace){
     const origin=pane.getBoundingClientRect(),main=workspace.getBoundingClientRect();
     const ox=origin.left+pane.clientLeft,oy=origin.top+pane.clientTop;
     const minX=Math.max(4,main.left+4)-ox,minY=Math.max(4,main.top+4)-oy;
     const maxX=Math.min(window.innerWidth-4,main.right-4)-ox-w,maxY=Math.min(window.innerHeight-4,main.bottom-4)-oy-h;
     if(maxX>=minX&&maxY>=minY){
      const cx=(v:number)=>Math.max(minX,Math.min(v,maxX)),cy=(v:number)=>Math.max(minY,Math.min(v,maxY));
      const acts=[...document.querySelectorAll<HTMLElement>('#workspace-act-row,.workspace-act-bar,#request-changes,#submit')].filter(n=>!n.hidden&&n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {x:r.left-ox,y:r.top-oy,width:r.width,height:r.height};});
      const blocksAct=(p:{x:number;y:number})=>acts.some(r=>boxesIntersect({...p,w,h},{x:r.x,y:r.y,w:r.width,h:r.height}));
      const xs=[x,minX,maxX,...points.flatMap(p=>[p.x-radius-w,p.x+radius]),...acts.flatMap(r=>[r.x-w,r.x+r.width])].map(cx);
      const ys=[y,minY,maxY,...points.flatMap(p=>[p.y-radius-h,p.y+radius]),...acts.flatMap(r=>[r.y-h,r.y+r.height])].map(cy);
      const expanded=[...candidates.map(p=>({x:cx(p.x),y:cy(p.y)})),...xs.flatMap(px=>ys.map(py=>({x:px,y:py}))).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))].filter(usable);
      const zero=expanded.filter(p=>!points.some(at=>covers(p,at))),clear=zero.filter(p=>!blocksAct(p));
      const pool=clear.length?clear:zero.length?zero:expanded;
      if(pool.length){
       const mainChoice=pool.reduce((best,p)=>points.filter(at=>covers(p,at)).length<points.filter(at=>covers(best,at)).length?p:best,pool[0]!);
       if(zero.length||points.filter(at=>covers(mainChoice,at)).length<points.filter(at=>covers(chosen!,at)).length){
        Object.assign(form.style,{position:'fixed',left:mainChoice.x+ox+'px',top:mainChoice.y+oy+'px',width:w+'px',height:h+'px',maxWidth:w+'px',maxHeight:h+'px',zIndex:'30'});return;
       }
      }
     }
    }
    // Only after the main search also fails may a held pointer keep its origin.
    if(pointer&&!candidates.some(usable)){Object.assign(form.style,previousPlacement);return;}
    Object.assign(form.style,{left:chosen.x+'px',top:chosen.y+'px'});return;
   }
   const w=form.offsetWidth||294,h=form.offsetHeight||132;Object.assign(form.style,{left:Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-w-4))+'px',top:Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-h-4))+'px'});};
  let removeBtn:HTMLButtonElement|null=null,errorSource='';
  if(existing&&!locked){
   const remove=removeBtn=document.createElement('button');remove.type='button';remove.className='stage-comment-delete';remove.textContent=t('Delete');
   remove.onclick=()=>{
    if(busy)return;
    try{
     if(general)assertWritable(generalRefusal());else assertEdit();
     if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
     const all=(general?host.general?.rows:undefined)??host.feedback(),index=all.findIndex(x=>x.id===existing.id);if(index>=0)all.splice(index,1);
     cancel();host.changed();refresh();
    }catch(e){errorSource=toEn(e instanceof Error?e.message:String(e));error.textContent=t(errorSource);place();}
   };
   form.append(remove);
  }
  // Capture all view context now; camera or dial changes while typing cannot rebind the mark.
  const pose=view?poseFor(view):null,bookmark=general?null:copy(host.bookmark()),turn=pose?.turn===undefined?null:copy(pose.turn);
  const previous=existing?readMark(existing):null;
  const rigGeometry=view==='rig'&&host.rigAnchor&&!existing&&!host.codec&&pose?.frame?.basis==='producer'
   ?rigCommentGeometry(pose as unknown as CommentPose,screen):null;
  const anchorSource=existing?previous:pose;
  const existingFeedback=existing&&'target' in existing?existing as unknown as Feedback:undefined;
  const rigTarget=existingFeedback?.target??rigGeometry?.target;
  const rigFields=view==='rig'&&host.rigAnchor&&!host.codec&&anchorSource?.frame?.basis==='producer'&&rigTarget
   ?mountRigAnchor(hint,host.rigAnchor,anchorSource.frame.index,anchorSource.animation??null,rigTarget,existingFeedback,composerReadOnly,host.draftChanged):null;
  if(rigFields)form.classList.add('stage-comment-composer-rig');
  const initialParts = pose ? host.codec?.chips?.(pose, screen, existing) : undefined;
  let selectedParts = initialParts?.selected.slice(),partsTouched=!!existing;
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
     partsTouched=true;
     const chosen = new Set(selectedParts);
     if (chosen.has(name)) chosen.delete(name);else chosen.add(name);
     selectedParts = chipNames.filter(part => chosen.has(part));
     syncChips();place();field.focus();
    };
    return chip;
   }));
  };
  if (chipBox) {chipBox.className = 'stage-comment-parts';chipBox.setAttribute('role', 'group');form.append(chipBox);syncChips();}
  if(initialRefusal){errorSource=toEn(host.refusal?.()??initialRefusal);error.textContent=t(errorSource);host.error(t(errorSource));}
  else if(!host.codec&&!existing&&pose&&!pose.frame&&!pose.timeBasis){errorSource=toEn(pose.frameReason??'COMMENT_FRAME_UNAVAILABLE: no explicit frame index');error.textContent=t(errorSource);}
  syncComposerLang=()=>{if(composer!==form)return;form.setAttribute('aria-label',t('Comment composer'));if(general)form.style.position='relative';field.setAttribute('aria-label',t('Comment text'));field.placeholder=t('Describe this spot…');hint.textContent=t(composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels');if(removeBtn)removeBtn.textContent=t('Delete');if(errorSource)error.textContent=t(errorSource);syncChips();if(rigFields){rigFields.localize();place();}};
  pane.append(form);place();
  let prepared=general?Promise.resolve(null):previous?Promise.resolve(previous.crop):pose?crop(pose,screen):Promise.reject(new Error('COMMENT_VIEW_UNAVAILABLE'));
  prepared.catch(()=>{});
  if(view&&pose&&host.codec?.geometry&&!composerReadOnly){
   geometryEdit={view,screen:{...screen},id:existing?.id,changed:false,camera:JSON.stringify(pose.camera),update:next=>{
    const a=unprojectMark(next,pose.camera),b=unprojectMark({x:next.x+next.width,y:next.y+next.height},pose.camera);
    let x=Math.round(a.x),y=Math.round(a.y),right=Math.round(b.x),bottom=Math.round(b.y);
    if(right<=x){if(geometryDrag?.handle.includes('w'))x=right-1;else right=x+1;}
    if(bottom<=y){if(geometryDrag?.handle.includes('n'))y=bottom-1;else bottom=y+1;}
    screen=region(projectMark({x,y},pose.camera),projectMark({x:right,y:bottom},pose.camera));draftMark={view,mode:placementMode!,screen};geometryEdit!.screen=screen;geometryEdit!.changed=true;
    if(!partsTouched){selectedParts=host.codec?.chips?.(pose,screen)?.selected.slice();syncChips();}
    prepared=crop(pose,screen);prepared.catch(()=>{});last='';place();
   }};
  }
  const submitComposer=composerSubmit=async():Promise<boolean>=>{if(busy)return false;if(generation!==interaction||view&&(!available(view)||poseFor(view)&&poseFor(view)?.mode!==placementMode)){cancel();return false;}const summary=field.value.trim();if(!summary){field.focus();return false;}try{
   if(selectedParts && !selectedParts.length)throw new Error(t('Select at least one part.'));
   const editedAnchor=rigFields?.read();
   if(existing){
    assertEdit(general);if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
    busy=true;field.disabled=true;rigFields?.setBusy(true);syncChips();
    if(!general&&host.codec?.update){
     const geometry=geometryEdit?.changed&&pose?{pose,screen:{...screen},crop:(await prepared)!}:undefined;
     if(disposed||generation!==interaction)return false;assertEdit(general);
     const replacement=await host.codec.update(copy(existing),summary,selectedParts?.slice(),geometry);
     if(disposed||generation!==interaction)return false;
     assertEdit(general);if(host.locked(existing.id))throw new Error(t('COMMENT_SUBMITTED: submitted evidence is immutable'));
     const all=host.feedback(),index=all.indexOf(existing);
     if(index<0)return false;
     all.splice(index,1,replacement);
    }else if(editedAnchor&&existingFeedback){
     const context=existingFeedback.context;
     Object.assign(existingFeedback,editedAnchor,{summary,context:{
      ...(context&&typeof context==='object'&&!Array.isArray(context)?context:{}),
      interval:intervalOf(editedAnchor)
     }});
    }else existing.summary=summary;
   }else if(general){
    assertEdit(true);const row=host.general!.create(summary);
    if(host.general!.rows)host.general!.rows.push(row);else host.add(row);
   }else{
    assertCapture();if(!pose||!host.codec&&!pose.frame&&!pose.timeBasis)throw new Error(t(pose?.frameReason??'COMMENT_FRAME_UNAVAILABLE: provide an explicit producer clock or a decoded reference frame index'));
    busy=true;field.disabled=true;rigFields?.setBusy(true);syncChips();
    if(host.codec){const pixels=await prepared;if(disposed||generation!==interaction)return false;assertCapture();const row=await host.codec.create(pose,view!,screen,pixels!,bookmark,summary,selectedParts?.slice());if(disposed||generation!==interaction)return false;assertCapture();if(poseFor(view!)?.mode!==placementMode)return false;host.add(row);}
    else {const rigPose=pose as unknown as CommentPose;
    const {world,slots,target}=rigGeometry??rigCommentGeometry(rigPose,screen);
    const comment:StageComment={schema:'rig-review-comment/1',mode:placementMode as StageComment['mode'],viewport:view!,frame:rigPose.frame,...(rigPose.timeBasis?{timeBasis:rigPose.timeBasis}:{}),time:rigPose.time,animation:rigPose.animation,sourceHash:rigPose.sourceHash,modelHash:rigPose.modelHash,referenceHash:rigPose.referenceHash,referenceId:rigPose.referenceId,camera:copy(rigPose.camera),screen,world,slots,crop:(await prepared)!,bookmark};
    assertCapture();
    if(disposed||generation!==interaction||poseFor(view!)?.mode!==placementMode)return false;
    const n=rigPose.frame?.index??null;
    const anchor=editedAnchor??{frameStart:n,frameEnd:n,target,category:'defect'};
    host.add({id:crypto.randomUUID(),...anchor,summary,context:{animation:rigPose.animation,time:rigPose.time,frame:rigPose.frame?.basis==='producer'?n:null,...(turn?{turn:turn as any}:{}),interval:editedAnchor?intervalOf(editedAnchor):n===null?null:{frameStart:n,frameEnd:n,inclusive:true},comment:comment as any} } as unknown as Row,rigPose.side);
    }
   }
   busy=true;field.disabled=true;syncChips();
   await host.changed();
   if(disposed||generation!==interaction)return false;
   cancel();refresh();revealLatest();return true;
  }catch(e){if(disposed||generation!==interaction)return false;const rawMsg=e instanceof Error?e.message:String(e),msg=/^PARTS_COMMENT_OUT_OF_BOUNDS:/.test(rawMsg)?'PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds original image':/^JOB_[A-Z_]+$/.test(rawMsg)&&t('job.submit.'+rawMsg)!=='job.submit.'+rawMsg?'job.submit.'+rawMsg:rawMsg;errorSource=toEn(msg);error.textContent=t(errorSource);place();host.error(t(errorSource));field.disabled=false;field.focus();return false;}finally{busy=false;if(composer===form){rigFields?.setBusy(false);syncChips();}}};
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();renderPins();pane.focus();}else if(e.key==='Enter'&&!e.isComposing&&!composerReadOnly){e.stopPropagation();if(rigFields&&(e.target as Element|null)?.closest?.('select,button'))return;e.preventDefault();void submitComposer();}};
  form.onsubmit=e=>{e.preventDefault();return submitComposer();};
  field.focus();last='';host.draftChanged?.();
 };
 const disposers:(()=>void)[]=[];
 for(const [key,pane]of Object.entries(host.viewports)){
  const view=key as StageComment['viewport'],local=(e:PointerEvent)=>{const r=pane!.getBoundingClientRect();return {x:Math.max(0,Math.min(pane!.clientWidth,e.clientX-r.left-pane!.clientLeft)),y:Math.max(0,Math.min(pane!.clientHeight,e.clientY-r.top-pane!.clientTop))};};
  const down=(e:PointerEvent)=>{
   if(!available(view))return;
   if(e.button!==0||!e.isPrimary||spaceHeld()){if(spaceHeld()&&(e.target as Element)?.closest?.('.stage-comment-pin'))suppressPinClick=true;return;}
   suppressPinClick=false;
   const target=e.target as Element,pin=host.codec?.geometry?target.closest<HTMLButtonElement>('.stage-comment-pin'):null;
   const handle=target.closest<HTMLElement>('[data-comment-handle]')?.dataset.commentHandle;
   if(geometryEdit?.view===view&&handle&&!e.shiftKey){
    if(busy||host.blocked()||geometryEdit.id&&host.locked(geometryEdit.id))return;
    try{assertEdit();}catch{return;}
    e.preventDefault();e.stopImmediatePropagation();suppressPinClick=true;geometryDrag={id:e.pointerId,start:local(e),screen:{...geometryEdit.screen},handle};pane!.setPointerCapture(e.pointerId);return;
   }
   if(pin&&!host.blocked()){
    if(!enabled)setOpen(true);if(!enabled)return;
    try{assertCapture();}catch{return;}
    e.preventDefault();e.stopImmediatePropagation();suppressPinClick=true;pinPress={id:e.pointerId,view,start:local(e),pin};pane!.setPointerCapture(e.pointerId);return;
   }
   if(target.closest('.stage-comment-ui,button,input')&&!(e.shiftKey&&handle&&host.codec?.geometry)){if(host.codec?.geometry)e.stopImmediatePropagation();return;}
   if(enabled||!inline&&!list.hidden){try{assertCapture();}catch{return;}}if(!enabled||host.blocked())return;e.preventDefault();e.stopImmediatePropagation();cancel();const pose=poseFor(view),at=local(e);if(!pose||!clipMark(region(at,at),pose.projection?.clip))return;const generation=interaction;pending={view,start:at,end:at,mode:pose.mode,id:e.pointerId,interaction:generation,settled:host.pause()};pending.settled.catch(e=>{if(interaction===generation&&!disposed)host.error(String(e));});pane!.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{
   if(geometryDrag?.id===e.pointerId&&geometryEdit){
    e.preventDefault();e.stopImmediatePropagation();const p=local(e),g=geometryDrag,r=g.screen,dx=p.x-g.start.x,dy=p.y-g.start.y;
    let x=r.x,y=r.y,right=r.x+r.width,bottom=r.y+r.height;
    if(g.handle==='move'){x=Math.max(0,Math.min(pane!.clientWidth-r.width,x+dx));y=Math.max(0,Math.min(pane!.clientHeight-r.height,y+dy));right=x+r.width;bottom=y+r.height;}
    else {if(g.handle.includes('w'))x=Math.max(0,Math.min(right-1,x+dx));if(g.handle.includes('e'))right=Math.min(pane!.clientWidth,Math.max(x+1,right+dx));if(g.handle.includes('n'))y=Math.max(0,Math.min(bottom-1,y+dy));if(g.handle.includes('s'))bottom=Math.min(pane!.clientHeight,Math.max(y+1,bottom+dy));}
    geometryEdit.update({x,y,width:right-x,height:bottom-y});return;
   }
   if(pinPress?.id===e.pointerId){
    const p=pinPress,at=local(e);if(Math.hypot(at.x-p.start.x,at.y-p.start.y)<4)return;
    e.preventDefault();e.stopImmediatePropagation();// Transfer the held pointer to new capture without releasing it.
    const start=p.start;pinPress=null;cancel();const mode=poseFor(view)?.mode;if(!mode)return;
    pending={view,start,end:at,mode,id:e.pointerId,interaction,settled:host.pause()};pending.settled.catch(error=>host.error(String(error)));
   }
   if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();pending.end=local(e);const screen=clipMark(region(pending.start,pending.end),poseFor(view)?.projection?.clip);draftMark=screen?{view,mode:pending.mode,screen}:null;last='';};
  const up=async(e:PointerEvent)=>{
   if(geometryDrag?.id===e.pointerId){e.preventDefault();e.stopImmediatePropagation();geometryDrag=null;if(pane!.hasPointerCapture(e.pointerId))pane!.releasePointerCapture(e.pointerId);if(composer&&!composerReadOnly)composerField?.focus();return;}
   if(pinPress?.id===e.pointerId){e.preventDefault();e.stopImmediatePropagation();const pin=pinPress.pin;pinPress=null;if(pane!.hasPointerCapture(e.pointerId))pane!.releasePointerCapture(e.pointerId);pin.click();return;}
   if(!pending||pending.id!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();const p=pending;pending=null;if(pane!.hasPointerCapture(e.pointerId))pane!.releasePointerCapture(e.pointerId);try{await p.settled;assertCapture();if(disposed||interaction!==p.interaction||!enabled)return;const r=Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y)<4?region(p.start,p.start):region(p.start,p.end);const screen=clipMark(r,poseFor(view)?.projection?.clip);if(screen)openComposer(view,screen,undefined,p.mode);else cancel();}catch(error){host.error(String(error));cancel();}};
  const abort=(e:PointerEvent)=>{if(pending?.view===view&&pending.id===e.pointerId||geometryDrag?.id===e.pointerId||pinPress?.id===e.pointerId)cancel();};
  const suppressClick=(e:MouseEvent)=>{if((e.target as Element)?.closest('.stage-comment-pin')&&e.isTrusted&&e.detail>0&&(suppressPinClick||spaceHeld())){suppressPinClick=false;e.preventDefault();e.stopImmediatePropagation();}};
  pane!.addEventListener('click',suppressClick,true);disposers.push(()=>pane!.removeEventListener('click',suppressClick,true));
  pane!.addEventListener('pointerdown',down,true);pane!.addEventListener('pointermove',move,true);pane!.addEventListener('pointerup',up,true);pane!.addEventListener('pointercancel',abort,true);pane!.addEventListener('lostpointercapture',abort,true);
  disposers.push(()=>{pane!.removeEventListener('pointerdown',down,true);pane!.removeEventListener('pointermove',move,true);pane!.removeEventListener('pointerup',up,true);pane!.removeEventListener('pointercancel',abort,true);pane!.removeEventListener('lostpointercapture',abort,true);});
 }
 const key=(e:KeyboardEvent)=>{if(host.shortcutActive&&!host.shortcutActive())return;if(e.key==='Escape'&&(pending||composer||pinPress)){e.preventDefault();cancel();renderPins();return;}if(e.key==='Enter'&&!e.isComposing&&composer&&!composerReadOnly&&!busy&&!textEntryFocused(e.target)){e.preventDefault();void composerSubmit?.();return;}if(e.defaultPrevented||e.repeat||e.ctrlKey||e.metaKey||e.altKey||textEntryFocused(e.target)||host.shortcutBlocked?.())return;if(e.key.toLowerCase()==='c'){e.preventDefault();setOpen(inline?!enabled:list.hidden);}};
 window.addEventListener('blur',cancel);window.addEventListener('resize',placeList);document.addEventListener('keydown',key);toggle.onclick=(e?:MouseEvent)=>{if(e?.detail)toggle.blur?.();setOpen(inline?!enabled:list.hidden);};
 const ro=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(!disposed&&!list.hidden)placeList();}):null;if(ro){try{ro.observe(host.toolbar);if(workspace)ro.observe(workspace);}catch{}}
 const renderPins=()=>{if(disposed)return;if(enabled&&host.hasPicture?.()===false){cancel();setCapture(false);}if(!list.hidden)placeList();const refusal=updateRefusal();if(refusal&&(enabled||pending||composer&&!composerReadOnly&&!composerGeneral)){cancel();setCapture(false);host.error(refusal);}const all=host.feedback().map(f=>({f,mark:readMark(f)})).filter(x=>x.mark);
 // #356: a pose reads the pane's size (a forced layout after the played frame's writes); with no mark, draft or pending
 // capture there is nothing to place, so this per-frame loop skips it.
 const poses=new Map(all.length||draftMark||pending?[...layers.keys()].map(view=>[view,poseFor(view)]):[]);
 if(draftMark&&poses.get(draftMark.view)?.mode!==draftMark.mode||pending&&poses.get(pending.view)?.mode!==pending.mode)cancel();
 if(geometryEdit&&(geometryEdit.id&&host.locked(geometryEdit.id)||JSON.stringify(poses.get(geometryEdit.view)?.camera)!==geometryEdit.camera))cancel();
 const signature=JSON.stringify([geometryEdit?.screen,curLang(),refusal,all.map(({f,mark})=>[f.id,f.summary,mark!.mode,mark!.world]),[...poses].map(([view,p])=>[view,host.codec&&p?host.codec.signature(p):[p?.mode,p?.animation,p?.frame,p?.timeBasis,p?.time,p?.turn,p?.camera,p?.referenceId,p?.referenceHash,p?.projection?.clip]]),draftMark]);
 if(signature!==last){last=signature;for(const [view,layer] of layers){
  layer.replaceChildren();
  const clip=poses.get(view)?.projection?.clip;
  const corners=clip?[[clip.x,clip.y],[clip.x+clip.width,clip.y],
    [clip.x+clip.width,clip.y+clip.height],[clip.x,clip.y+clip.height]]:null;
  layer.style.clipPath=corners?'polygon('+corners.map(point=>point.map(value=>value+'px').join(' ')).join(', ')+')':'';
 }const occupied=new Map<StageComment['viewport'],{x:number;y:number;width:number;height:number}[]>();for(const [i,{f,mark:m}]of all.entries()){
  const mark=m!,pose=poses.get(mark.viewport),layer=layers.get(mark.viewport);if(refusal||!pose||!layer||(host.codec?!host.codec.matches(mark,pose,f):pose.mode!==mark.mode||pose.animation!==mark.animation||pose.sourceHash!==mark.sourceHash||pose.modelHash!==mark.modelHash||pose.referenceId!==mark.referenceId||pose.referenceHash!==mark.referenceHash||JSON.stringify(pose.frame)!==JSON.stringify(mark.frame)||JSON.stringify(pose.timeBasis??null)!==JSON.stringify(mark.timeBasis??null)||Math.abs((pose.time??0)-(mark.time??0))>1e-7||JSON.stringify(pose.turn)!==JSON.stringify((f.context as any)?.turn??null)))continue;
  const r=geometryEdit?.id===f.id?geometryEdit.screen:clipMark(markOnPane(mark,pose),pose.projection?.clip);if(!r)continue;
  const box=rectElement(r),pin=document.createElement('button');pin.type='button';pin.className='stage-comment-pin stage-comment-ui';pin.textContent=String(i+1);pin.setAttribute('aria-label',`${t('Comment {0}:').replace('{0}',String(i+1))} ${f.summary}`);pin.title=f.summary;Object.assign(pin.style,{left:r.x+'px',top:r.y+'px'});pin.onclick=()=>openComment(f);layer.append(box,pin);
  const pane=host.viewports[mark.viewport]!;
  if(host.codec?.geometry&&r.x>=0&&r.y>=0&&r.x<=pane.clientWidth&&r.y<=pane.clientHeight){
   const width=pin.offsetWidth||24,height=pin.offsetHeight||24,placed=occupied.get(mark.viewport)??[];
   if(!occupied.has(mark.viewport)){
    occupied.set(mark.viewport,placed);
    if(geometryEdit?.view===mark.viewport){const r=geometryEdit.screen;for(const [,x,y]of resizeHandles)placed.push({x:r.x+r.width*x!,y:r.y+r.height*y!,width:12,height:12});}
   }
   const clamp=(n:number,size:number,limit:number)=>Math.max(size/2,Math.min(limit-size/2,n));
   const clear=(x:number,y:number)=>placed.every(p=>Math.abs(p.x-x)>=(p.width+width)/2+2||Math.abs(p.y-y)>=(p.height+height)/2+2);
   let x=clamp(r.x,width,pane.clientWidth),y=clamp(r.y,height,pane.clientHeight),distance=Infinity;
   if(!clear(x,y))for(let py=height/2;py<=pane.clientHeight-height/2;py+=height+4)for(let px=width/2;px<=pane.clientWidth-width/2;px+=width+4){const d=(px-r.x)**2+(py-r.y)**2;if(d<distance&&clear(px,py)){x=px;y=py;distance=d;}}
   placed.push({x,y,width,height});Object.assign(pin.style,{left:x+'px',top:y+'px'});
  }

 }if(draftMark&&!geometryEdit)layers.get(draftMark.view)?.append(rectElement(draftMark.screen));
 if(geometryEdit){
  const {view,screen:r}=geometryEdit,layer=layers.get(view)!,box=rectElement(r);box.dataset.commentHandle='move';Object.assign(box.style,{pointerEvents:'auto',cursor:'move'});layer.prepend(box);
  for(const [name,x,y]of resizeHandles){
   const handle=document.createElement('button');handle.type='button';handle.dataset.commentHandle=name;handle.className='stage-comment-ui';handle.setAttribute('aria-label',t('Resize comment area: {0}').replace('{0}',name));
   Object.assign(handle.style,{position:'absolute',left:r.x+r.width*x+'px',top:r.y+r.height*y+'px',width:'12px',height:'12px',minWidth:'12px',minHeight:'12px',padding:'0',transform:'translate(-50%,-50%)',pointerEvents:'auto',cursor:name+'-resize',borderWidth:'2px',borderStyle:'solid',borderColor:'var(--link)',background:'var(--rv-panel)'});layer.append(handle);
  }
 }}};
 const paint=()=>{if(disposed)return;renderPins();raf=requestAnimationFrame(paint);};
 const offLang=onLang(()=>{if(disposed)return;updateRefusal();renderList();syncComposerLang?.();last='';renderPins();});
 refresh();paint();return {active:()=>enabled,draft:()=>!!pending||!!composer&&!composerReadOnly,hasPendingComment:()=>!!composer&&!composerReadOnly&&!composerGeneral&&!!composerField?.value.trim(),commitDraft:async()=>composer&&!composerReadOnly&&composerSubmit?await composerSubmit():true,refresh,dispose:()=>{disposed=true;ro?.disconnect();offLang();cancelAnimationFrame(raf);cancel();window.removeEventListener('blur',cancel);window.removeEventListener('resize',placeList);document.removeEventListener('keydown',key);for(const dispose of disposers)dispose();for(const layer of layers.values())layer.remove();toggle.onclick=null;list.remove();refusalNote.remove();}};
}
