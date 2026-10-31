import type {BoneAdjust,PosedFrame,RigPlayer} from '@rig-c/play';
import {
 boneHierarchy,
 CHANNELS,
 channelSegments,
 evaluateBoneLocals,
 evaluateStoredChannel,
 filterTracks,
 readAnimationInspection,
 type AnimationInspection,
 type InspectionTarget,
 type InspectionTrack,
} from '../src/animation-inspection.ts';
import {
 AnimationOpBuilder,
 checkAnimationEditGate,
 classifyAnimationTracks,
 cleanMotionNumber,
 MAX_ANIMATION_OPS,
 overlayDraftOnInspection,
 type AnimationEditGate,
 type AnimationSourceOp,
 type EasingTuple,
 type TrackClassification,
} from '../src/animation-ops.ts';
import type {AppliedAnimation} from '../src/applied-context.ts';
import type {AnimationSourceView} from './rebuild-client.ts';
import {InspectionSelection} from './inspection-selection.ts';
import {animationPreviewAdjust} from './preview.ts';

const NS='http://www.w3.org/2000/svg';
const svg=(tag:string,attrs:Record<string,string|number>)=>{const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
const numeric=(value:number)=>Object.is(value,-0)?'-0':String(value);
const button=(label:string,click:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=click;return b;};

/** Clean human-readable seconds without Float32 noise (e.g. 1.6 instead of 1.600000023841858). */
export function formatSeconds(value:number):string {
 if(!Number.isFinite(value))return '0';
 const cleaned=Number(value.toFixed(4));
 return Object.is(cleaned,-0)?'0':String(cleaned);
}

/** Clean ruler tick positions from 0 to end for the given horizontal zoom factor. */
export function buildRulerTicks(end:number,zoom=1):number[] {
 if(!(end>0)||!Number.isFinite(end))return [0];
 const cleanEnd=Number(end.toFixed(4));
 const niceSteps=[0.02,0.05,0.1,0.2,0.25,0.5,1,2,5,10];
 const targetCount=Math.max(6,Math.min(32,Math.round(8*Math.max(1,zoom))));
 const step=niceSteps.find(s=>cleanEnd/s<=targetCount)??niceSteps.at(-1)!;
 const ticks:number[]=[0];
 for(let i=1;i*step<cleanEnd-step*0.35;i++){
  ticks.push(Number((i*step).toFixed(4)));
 }
 if(ticks.at(-1)!==cleanEnd)ticks.push(cleanEnd);
 return ticks;
}

export interface AnimationPanelOptions {
 host:HTMLElement;
 stage:HTMLElement;
 select:(value:InspectionTarget)=>void;
 seek:(time:number)=>void;
 project:(x:number,y:number)=>{x:number;y:number};
 enabled:()=>boolean;
 preview?:(adjust:BoneAdjust|null,active:boolean)=>void;
 apply?:(ops:readonly AnimationSourceOp[])=>Promise<unknown>;
 reset?:()=>Promise<void>;
 pause?:()=>void;
}

export interface SelectedAnimationKey {
 animation:string;
 trackIndex:number;
 keyIndex:number;
 pointer:string;
}

/** All picking reads the last drawn primitives, including their resolved clip; never a setup bounding box. */
export function pickedSlot(frame:PosedFrame,x:number,y:number):string|null {
 const inside=(p:readonly number[])=>{let hit=false;for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){const ax=p[i]!,ay=p[i+1]!,bx=p[j]!,by=p[j+1]!;if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)hit=!hit;}return hit;};
 for(const row of [...frame.order].reverse()){
  if(row.clip&&inside(row.clip.polygon)===row.clip.inverse)continue;
  if(row.kind==='region'&&inside(row.corners))return row.slot;
  if(row.kind==='mesh')for(let i=0;i<row.triangles.length;i+=3){const p=row.triangles.slice(i,i+3).flatMap(v=>[row.vertices[v*2]!,row.vertices[v*2+1]!]);if(inside(p))return row.slot;}
 }return null;
}

export const ANIMATION_APPLY_ISOLATION_NOTE =
 'An animation Apply builds from the handoff config.json and animations_from file into scratch (rig-parts rig → rigc build → rig-parts check), so it does not carry another kind\'s Apply on the stage.';

export class AnimationInspectionPanel {
 private baseInspection:AnimationInspection|null=null;
 private inspection:AnimationInspection|null=null;
 private document:unknown=null;
 private animation='';
 private at=0;
 private runtimeDuration=0;
 private track:InspectionTrack|null=null;
 private channel=0;
 private view='timeline';
 private zoom=1;
 private unavailableChannel='';
 private selection:InspectionSelection;
 private panes=new Map<string,HTMLElement>();
 private views:HTMLButtonElement[]=[];
 private zoomButtons:HTMLButtonElement[]=[];
 private playhead:SVGElement|null=null;
 private cursor:SVGElement|null=null;
 private plot:((t:number,v:number)=>{x:number;y:number})|null=null;
 private channelSelect:HTMLSelectElement;
 private readout:HTMLOutputElement;
 private status:HTMLElement;
 private gateBanner:HTMLElement;
 private previewBadge:HTMLElement;
 private opsSummary:HTMLElement;
 private undoOpBtn:HTMLButtonElement;
 private clearOpsBtn:HTMLButtonElement;
 private applyBtn:HTMLButtonElement;
 private resetBtn:HTMLButtonElement;
 private applyNote:HTMLElement;
 private editorStatus:HTMLElement;
 private picks:HTMLElement;
 private bones=new Map<string,{x:number;y:number}>();
 private frame:PosedFrame|null=null;
 private down:{x:number;y:number}|null=null;
 private space=false;
 private disposers:(()=>void)[]=[];
 private boneButtons=new Map<string,HTMLButtonElement>();
 private bonePoints=false;

 // Keyed animation editing state (Slice 3 / Slice 3b)
 private source:AnimationSourceView|null=null;
 private sourceFallbackReason:string|null=null;
 private builder:AnimationOpBuilder|null=null;
 private appliedOps:AnimationSourceOp[]=[];
 private selectedKey:SelectedAnimationKey|null=null;
 private lastNonEmptyAnimation='';
 private isBusy=false;
 private suppressNextKeyClick=false;
 private lastDockClientHeight=0;
 private lastLanesHeight=116;
 private draggingKey:{
  pointerId:number;
  trackIndex:number;
  keyIndex:number;
  startX:number;
  moved:boolean;
  laneEl:HTMLElement;
  markEl:HTMLButtonElement;
  end:number;
 }|null=null;

 constructor(private options:AnimationPanelOptions){
  const {host,stage}=options;
  host.classList.add('animation-inspection');
  host.innerHTML=`<div class="animation-dock-bar">
 <h3 class="animation-dock-title">Animation timeline &amp; inspection</h3>
 <div class="animation-view-buttons" aria-label="Animation inspection views"></div>
 <div class="animation-zoom-buttons" role="group" aria-label="Timeline horizontal zoom"></div>
 <div class="animation-editor-bar" data-animation-editor-bar>
  <div class="animation-editor-actions">
   <span class="animation-preview-badge" data-animation-preview-badge hidden>preview — Apply decides</span>
   <span class="animation-ops-summary" data-animation-ops-summary>0 pending ops</span>
   <button type="button" data-animation-undo-op disabled>Undo op</button>
   <button type="button" data-animation-clear-ops disabled>Discard pending</button>
   <button type="button" data-animation-apply disabled>Apply · Rebuild</button>
   <button type="button" data-animation-reset disabled>Reset</button>
  </div>
 </div>
</div>
<div class="animation-dock-status">
 <div class="animation-gate-banner hint" data-animation-gate></div>
 <p class="hint" data-animation-editor-status role="status"></p>
 <p class="hint" data-animation-apply-note></p>
 <p data-inspection-status class="hint"></p>
</div>
<section data-animation-pane="timeline" aria-label="Timeline"></section>
<section data-animation-pane="curve" aria-label="Stored curves" hidden>
 <div class="animation-curve-toolbar">
  <label>Channel <select data-curve-channel aria-label="Stored animation channel"></select></label>
  <label>Time (s) <input data-curve-time type="number" min="0" step="any" aria-label="Exact inspection seconds"></label>
  <button data-curve-seek type="button">Inspect time</button>
  <output data-curve-readout aria-live="off"></output>
 </div>
 <svg data-curve-plot role="img" aria-label="Exact stored curve and control points" viewBox="0 0 800 230"></svg>
 <p class="hint">Stored curve and handles are exact. Runtime evaluation uses Play’s ten-piece Float32 interpolation; the cursor may sit off the cubic. Values are authored locals before constraints and previews.</p>
</section>
<section data-animation-pane="tree" aria-label="Bone tree" hidden></section>`;

  this.status=host.querySelector('[data-inspection-status]')!;
  this.gateBanner=host.querySelector('[data-animation-gate]')!;
  this.previewBadge=host.querySelector('[data-animation-preview-badge]')!;
  this.opsSummary=host.querySelector('[data-animation-ops-summary]')!;
  this.undoOpBtn=host.querySelector('[data-animation-undo-op]')!;
  this.clearOpsBtn=host.querySelector('[data-animation-clear-ops]')!;
  this.applyBtn=host.querySelector('[data-animation-apply]')!;
  this.resetBtn=host.querySelector('[data-animation-reset]')!;
  this.applyNote=host.querySelector('[data-animation-apply-note]')!;
  this.editorStatus=host.querySelector('[data-animation-editor-status]')!;
  this.applyNote.textContent=ANIMATION_APPLY_ISOLATION_NOTE;
  this.applyNote.title=ANIMATION_APPLY_ISOLATION_NOTE;
  this.channelSelect=host.querySelector('[data-curve-channel]')!;
  this.readout=host.querySelector('[data-curve-readout]')!;

  this.undoOpBtn.onclick=()=>{this.undoOp();};
  this.clearOpsBtn.onclick=()=>{this.clearPending();};
  this.applyBtn.onclick=()=>{if(this.options.apply)void this.options.apply(this.ops());};
  this.resetBtn.onclick=()=>{this.resetEdits();if(this.options.reset)void this.options.reset();};

  for(const pane of host.querySelectorAll<HTMLElement>('[data-animation-pane]'))this.panes.set(pane.dataset.animationPane!,pane);
  const viewButtonsHost=host.querySelector('.animation-view-buttons')!;
  for(const [id,label]of [['timeline','Timeline'],['curve','Curves'],['tree','Bone tree']]){
   const b=button(label!,()=>this.show(id!));
   b.dataset.animationView=id;
   viewButtonsHost.append(b);
   this.views.push(b);
  }
  const zoomHost=host.querySelector('.animation-zoom-buttons');
  if(zoomHost){
   for(const z of [1,2,4,8]){
    const zb=button(`${z}×`,()=>this.setZoom(z));
    zb.dataset.animationZoom=String(z);
    zb.setAttribute('aria-pressed',String(z===this.zoom));
    zb.title=`Timeline horizontal zoom ${z}×`;
    zoomHost.append(zb);
    this.zoomButtons.push(zb);
   }
  }
  this.selection=new InspectionSelection(value=>{options.select(value);this.renderSelection();});
  host.querySelector<HTMLButtonElement>('[data-curve-seek]')!.onclick=()=>{const value=host.querySelector<HTMLInputElement>('[data-curve-time]')!.value.trim();options.seek(value?Number(value):NaN);};
  this.channelSelect.onchange=()=>{this.unavailableChannel='';const [pointer,c]=JSON.parse(this.channelSelect.value) as [string,number];this.track=this.inspection?.tracks.find(t=>t.pointer===pointer)??null;this.channel=c;this.renderCurve();this.update(this.at,this.runtimeDuration);};
  this.picks=document.createElement('div');this.picks.className='animation-stage-picks';stage.append(this.picks);
  const down=(e:PointerEvent)=>{this.down=e.isPrimary&&e.button===0?{x:e.clientX,y:e.clientY}:null;};
  const up=(e:PointerEvent)=>{const start=this.down;this.down=null;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>3||this.space||!options.enabled()||e.target instanceof Element&&e.target.closest('button,input,select,textarea')||!this.frame)return;
   const rect=stage.getBoundingClientRect(),p0=options.project(0,0),px=options.project(1,0),py=options.project(0,1),x=(e.clientX-rect.left-p0.x)/(px.x-p0.x),y=(e.clientY-rect.top-p0.y)/(py.y-p0.y),slot=pickedSlot(this.frame,x,y);if(slot)this.select({kind:'slot',name:slot});
  };
  const key=(e:KeyboardEvent)=>{if(e.code==='Space')this.space=e.type==='keydown';};const blur=()=>{this.space=false;this.down=null;};
  stage.addEventListener('pointerdown',down);stage.addEventListener('pointerup',up);window.addEventListener('keydown',key);window.addEventListener('keyup',key);window.addEventListener('blur',blur);
  this.disposers.push(()=>{stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointerup',up);window.removeEventListener('keydown',key);window.removeEventListener('keyup',key);window.removeEventListener('blur',blur);});

  if(typeof ResizeObserver!=='undefined'&&typeof host.closest==='function'){
   const dockPanel=host.closest<HTMLElement>('.inspector')??host.closest<HTMLElement>('[data-inspector-panel]');
   const ro=new ResizeObserver(()=>{this.syncDockHeight(true);});
   if(dockPanel)ro.observe(dockPanel);
   ro.observe(host);
   this.disposers.push(()=>ro.disconnect());
  }
  this.show('timeline');
  this.renderEditorBar();
 }

 zoomLevel():number{
  return this.zoom;
 }

 setZoom(nextZoom:number){
  const clamped=[1,2,4,8].includes(nextZoom)?nextZoom:1;
  if(this.zoom===clamped)return;
  this.zoom=clamped;
  for(const zb of this.zoomButtons){
   zb.setAttribute('aria-pressed',String(Number(zb.dataset.animationZoom)===this.zoom));
  }
  this.renderTimeline();
 }

 private syncDockHeight(fromResize=false){
  const lanes=this.options.host.querySelector<HTMLElement>('.animation-lanes');
  if(!lanes)return;
  if(typeof this.options.host.closest!=='function'){
   lanes.style.height=`${this.lastLanesHeight}px`;
   lanes.style.maxHeight=`${this.lastLanesHeight}px`;
   return;
  }
  const panel=this.options.host.closest<HTMLElement>('.inspector')??this.options.host.closest<HTMLElement>('[data-inspector-panel]');
  if(!panel||panel.clientHeight<=0){
   lanes.style.height=`${this.lastLanesHeight}px`;
   lanes.style.maxHeight=`${this.lastLanesHeight}px`;
   return;
  }
  if(fromResize||panel.clientHeight!==this.lastDockClientHeight){
   this.lastDockClientHeight=panel.clientHeight;
   this.lastLanesHeight=Math.max(96,Math.floor(panel.clientHeight-162));
  }
  lanes.style.height=`${this.lastLanesHeight}px`;
  lanes.style.maxHeight=`${this.lastLanesHeight}px`;
 }

 loadSource(source:AnimationSourceView|null,fallbackReason:string|null=null){
  this.source=source;
  this.sourceFallbackReason=fallbackReason;
  if(source?.available&&source.text){
   if(!this.builder||this.builder.baseText!==source.text){
    const prevOps=this.builder?[...this.builder.ops]:[...this.appliedOps];
    this.builder=new AnimationOpBuilder(source.text,(source.easings??undefined) as Readonly<Record<string,EasingTuple>>|undefined);
    for(const op of prevOps){
     try{this.builder.apply(op);}catch{break;}
    }
   }
  }else{
   this.builder=null;
   this.appliedOps=[];
   this.selectedKey=null;
  }
  this.syncEffectiveInspection(false);
  this.renderGateBanner();
  this.renderEditorBar();
  this.renderSelection();
 }

 model(doc:unknown,animation:string){
  if(this.document===doc&&this.animation===animation)return;
  if(animation&&this.lastNonEmptyAnimation&&this.lastNonEmptyAnimation!==animation)this.selectedKey=null;
  if(animation)this.lastNonEmptyAnimation=animation;
  this.document=doc;
  this.animation=animation;
  this.baseInspection=null;
  this.inspection=null;
  this.track=null;
  this.unavailableChannel='';
  this.frame=null;
  this.bones.clear();
  this.boneButtons.clear();
  this.picks.replaceChildren();
  this.channelSelect.replaceChildren();
  this.playhead=null;
  try{
   this.baseInspection=readAnimationInspection(doc,animation);
   boneHierarchy(this.baseInspection);
   this.syncEffectiveInspection(true);
   this.status.textContent=`${animation||'Setup'} · ${this.inspection!.tracks.length} stored tracks · key times in seconds; frames require a declared clock.`;
   this.status.title=this.status.textContent;
  }catch(e){
   this.status.textContent=e instanceof Error?e.message:String(e);
   this.status.title=this.status.textContent;
  }
  if(this.selection.value()&&!this.has(this.selection.value()))this.selection.select(null);
  this.renderGateBanner();
  this.renderEditorBar();
  this.renderTree();
  this.renderSelection();
 }

 private draftDocument():unknown{
  if(!this.builder)return undefined;
  try{return JSON.parse(this.builder.text);}catch{return undefined;}
 }

 gateInfo():AnimationEditGate{
  if(!this.animation){
   return {editable:false,code:'ANIMATION_NOT_IN_SOURCE',reason:'No animation selected.',note:null};
  }
  if(this.animation==='idle'){
   return checkAnimationEditGate('idle',this.source?.path??null);
  }
  if(!this.source||!this.source.available||!this.source.text){
   const r=this.source?.reason??this.sourceFallbackReason??'config.json does not declare an "animations_from" motion spec file.';
   const clean=r.replace(/^ANIMATION_SOURCE_MISSING:\s*/,'');
   return {editable:false,code:'ANIMATION_SOURCE_MISSING',reason:clean,note:null};
  }
  return checkAnimationEditGate(this.animation,this.source.path,this.draftDocument());
 }

 tracksInfo():TrackClassification[]{
  const doc=this.draftDocument();
  if(!doc||!this.animation)return [];
  return classifyAnimationTracks(doc,this.animation);
 }

 hasUnappliedPreview():boolean{
  if(!this.builder)return false;
  return JSON.stringify(this.builder.ops)!==JSON.stringify(this.appliedOps);
 }

 ops():readonly AnimationSourceOp[]{
  return this.builder?this.builder.ops:[];
 }

 unappliedOps():readonly AnimationSourceOp[]{
  const all=this.ops();
  if(!this.hasUnappliedPreview())return [];
  return all;
 }

 overlaidInspection():AnimationInspection|null{
  return this.inspection;
 }

 sourceInfo(){
  return this.source?{
   available:this.source.available,
   reason:this.source.reason,
   path:this.source.path,
   sha256:this.source.sha256,
  }:null;
 }

 private syncEffectiveInspection(notifyPreview=true){
  if(!this.baseInspection){
   this.inspection=null;
   if(notifyPreview)this.options.preview?.(null,false);
   return;
  }
  const hasPreview=this.hasUnappliedPreview();
  if(hasPreview&&this.builder){
   try{
    this.inspection=overlayDraftOnInspection(
     this.baseInspection,
     this.builder.text,
     (this.source?.easings??undefined) as Readonly<Record<string,EasingTuple>>|undefined,
    );
   }catch{
    this.inspection=this.baseInspection;
   }
  }else{
   this.inspection=this.baseInspection;
  }

  if(this.track&&this.inspection){
   this.track=this.inspection.tracks.find(t=>t.pointer===this.track!.pointer)??this.track;
  }

  if(notifyPreview){
   if(hasPreview&&this.inspection&&this.builder){
    const clss=this.tracksInfo();
    const editedBones=new Set<string>();
    for(const op of [...this.builder.ops,...this.appliedOps]){
     if(op.animation===this.animation){
      const c=clss[op.track];
      if(c&&c.targetKind==='bone'&&c.target)editedBones.add(c.target);
     }
    }
    const adjust=animationPreviewAdjust(this.inspection,editedBones,false);
    this.options.preview?.(adjust,editedBones.size>0);
   }else{
    this.options.preview?.(null,false);
   }
  }
 }

 private renderGateBanner(){
  const gate=this.gateInfo();
  if(!this.animation){
   this.gateBanner.textContent='Select an animation clip to inspect or edit keys.';
   this.gateBanner.title=this.gateBanner.textContent;
   this.gateBanner.dataset.gateCode='NONE';
   this.gateBanner.dataset.editable='false';
   return;
  }
  this.gateBanner.dataset.gateCode=gate.code;
  this.gateBanner.dataset.editable=String(gate.editable);
  if(!gate.editable){
   this.gateBanner.textContent=`Read-only clip · ${gate.code}: ${gate.reason}`;
  }else{
   const srcPath=this.source?.path??'animations_from';
   const hashShort=this.source?.sha256?` (sha256 ${this.source.sha256.slice(0,12)}…)`:'';
   const notePart=gate.note?` · Note: ${gate.note}`:'';
   this.gateBanner.textContent=`Editable clip "${this.animation}" from ${srcPath}${hashShort}${notePart}`;
  }
  this.gateBanner.title=this.gateBanner.textContent;
 }

 private renderEditorBar(){
  const allOps=this.ops();
  const hasPreview=this.hasUnappliedPreview();
  const appliedCount=this.appliedOps.length;
  this.previewBadge.hidden=!hasPreview;
  if(hasPreview){
   const clips=[...new Set([...allOps,...this.appliedOps].map(o=>o.animation))];
   this.previewBadge.textContent=`preview — Apply decides (${allOps.length} op(s)${clips.length?` on ${clips.join(', ')}`:''})`;
  }
  if(allOps.length===0&&appliedCount===0){
   this.opsSummary.textContent=`0 pending ops (cap ${MAX_ANIMATION_OPS})`;
  }else if(hasPreview){
   this.opsSummary.textContent=`${allOps.length} cumulative op(s) pending${appliedCount?` (${appliedCount} applied on stage)`:''} · cap ${MAX_ANIMATION_OPS}`;
  }else{
   this.opsSummary.textContent=`${appliedCount} op(s) applied on stage · 0 unapplied`;
  }
  this.undoOpBtn.disabled=this.isBusy||allOps.length===0;
  this.clearOpsBtn.disabled=this.isBusy||!hasPreview;
  this.applyBtn.disabled=this.isBusy||!hasPreview||allOps.length===0||!this.source?.available;
  this.resetBtn.disabled=this.isBusy||(allOps.length===0&&appliedCount===0);
 }

 setEditorStatus(text:string,error=false){
  this.editorStatus.textContent=text;
  this.editorStatus.title=text;
  this.editorStatus.classList.toggle('error',error);
  this.editorStatus.setAttribute('role',error?'alert':'status');
 }

 busy(isBusy:boolean){
  this.isBusy=isBusy;
  this.options.host.setAttribute('aria-busy',String(isBusy));
  this.renderEditorBar();
  this.syncKeyInspectorInPlace();
 }

 markApplied(ops:readonly AnimationSourceOp[],statusText:string,isError=false){
  this.appliedOps=ops.map(o=>structuredClone(o));
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderTimeline();
  this.renderChannels();
  this.setEditorStatus(statusText,isError);
 }

 /**
  * Reconcile the stage's currently active animation record without wiping pending edits in `this.builder`.
  * When another kind of Apply (Bones, Mesh, Idle, Retarget, Chest, etc.) replaces the stage build, `applied` is `null`
  * and `this.appliedOps` clears to `[]` while `this.builder.ops` stays intact as pending unapplied edits.
  */
 reconcileStageApplied(applied:AppliedAnimation|null){
  const nextApplied=applied?applied.ops.map(o=>structuredClone(o)):[];
  if(JSON.stringify(this.appliedOps)===JSON.stringify(nextApplied))return;
  this.appliedOps=nextApplied;
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderTimeline();
  this.renderChannels();
 }

 syncApplied(applied:AppliedAnimation|null){
  this.appliedOps=applied?applied.ops.map(o=>structuredClone(o)):[];
  if(this.source?.available&&this.source.text){
   this.builder=new AnimationOpBuilder(this.source.text,(this.source.easings??undefined) as Readonly<Record<string,EasingTuple>>|undefined);
   for(const op of this.appliedOps){
    try{this.builder.apply(op);}catch{break;}
   }
  }
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderSelection();
 }

 applyOp(
  op:AnimationSourceOp,
  opts:{skipTimelineDomRebuild?:boolean}={},
 ):{ok:true;ops:readonly AnimationSourceOp[]}|{ok:false;error:string}{
  if(!this.builder||!this.source?.available){
   const gate=this.gateInfo();
   const err=gate.editable?'ANIMATION_SOURCE_MISSING: animation source is not loaded':`${gate.code}: ${gate.reason}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  try{
   this.options.pause?.();
   this.builder.apply(op);
   this.syncEffectiveInspection(true);
   this.renderEditorBar();
   if(opts.skipTimelineDomRebuild){
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }else{
    this.renderTimeline();
   }
   this.renderChannels();
   this.setEditorStatus(`Applied ${op.op} on ${op.animation} track ${op.track} (${this.builder.ops.length} pending op(s), preview active).`,false);
   return {ok:true,ops:this.builder.ops};
  }catch(e){
   const msg=e instanceof Error?e.message:String(e);
   this.setEditorStatus(msg,true);
   return {ok:false,error:msg};
  }
 }

 setKeyTime(trackIndex:number,keyIndex:number,time:number){
  return this.applyOp(
   {op:'set_key_time',animation:this.animation,track:trackIndex,key:keyIndex,time},
   {skipTimelineDomRebuild:true},
  );
 }

 setKeyValue(trackIndex:number,keyIndex:number,channel:number|undefined,value:number|readonly number[]){
  return this.applyOp(
   channel!==undefined
    ?{op:'set_key_value',animation:this.animation,track:trackIndex,key:keyIndex,channel,value:value as number}
    :{op:'set_key_value',animation:this.animation,track:trackIndex,key:keyIndex,value:value as readonly number[]},
   {skipTimelineDomRebuild:true},
  );
 }

 insertKey(trackIndex:number,time:number,value?:readonly number[]){
  const clss=this.tracksInfo();
  const cls=clss[trackIndex];
  if(!cls||!cls.editable){
   const err=cls?`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`:`ANIMATION_TRACK_OUT_OF_RANGE: track ${trackIndex}`;
   this.setEditorStatus(err,true);
   return {ok:false as const,error:err};
  }
  let resolvedValue=value;
  if(!resolvedValue){
   const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===cls.target&&t.name===cls.property);
   const vals:number[]=[];
   for(let c=0;c<cls.channels;c++){
    const sampled=inspTrack?evaluateStoredChannel(inspTrack,c,time):null;
    if(sampled!==null&&Number.isFinite(sampled)){
     vals.push(cleanMotionNumber(sampled));
    }else{
     const doc=this.draftDocument() as {animations?:Record<string,{tracks?:Array<{keys?:Array<{v?:number[]}>}>}>}|undefined;
     const fallback=doc?.animations?.[this.animation]?.tracks?.[trackIndex]?.keys?.[0]?.v?.[c]??0;
     vals.push(cleanMotionNumber(fallback));
    }
   }
   resolvedValue=vals;
  }
  const res=this.applyOp({
   op:'insert_key',
   animation:this.animation,
   track:trackIndex,
   time,
   value:resolvedValue,
  });
  if(res.ok){
   const rawKeys=this.readDraftTrackKeys(trackIndex);
   const insertedIdx=rawKeys.findIndex(k=>k.t===cleanMotionNumber(time));
   if(insertedIdx>=0){
    const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===cls.target&&t.name===cls.property);
    this.selectedKey={animation:this.animation,trackIndex,keyIndex:insertedIdx,pointer:inspTrack?.pointer??''};
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }
  }
  return res;
 }

 deleteKey(trackIndex:number,keyIndex:number){
  const res=this.applyOp({op:'delete_key',animation:this.animation,track:trackIndex,key:keyIndex});
  if(res.ok){
   const rawKeys=this.readDraftTrackKeys(trackIndex);
   if(this.selectedKey&&this.selectedKey.trackIndex===trackIndex){
    if(rawKeys.length===0){
     this.selectedKey=null;
    }else{
     this.selectedKey={...this.selectedKey,keyIndex:Math.min(keyIndex,rawKeys.length-1)};
    }
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }
  }
  return res;
 }

 moveSelection(
  selections:ReadonlyArray<{track:number;key:number}>,
  deltaTime:number,
 ):{ok:true;ops:readonly AnimationSourceOp[]}|{ok:false;error:string}{
  if(!this.builder||!this.source?.available){
   const gate=this.gateInfo();
   const err=gate.editable?'ANIMATION_SOURCE_MISSING: animation source is not loaded':`${gate.code}: ${gate.reason}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  try{
   this.options.pause?.();
   this.builder.moveSelection(this.animation,selections,deltaTime);
   this.syncEffectiveInspection(true);
   this.renderEditorBar();
   this.syncTimelineKeysInPlace();
   this.syncKeyInspectorInPlace();
   this.renderChannels();
   this.setEditorStatus(`Moved ${selections.length} selected key(s) by ${deltaTime} s (${this.builder.ops.length} pending op(s)).`,false);
   return {ok:true,ops:this.builder.ops};
  }catch(e){
   const msg=e instanceof Error?e.message:String(e);
   this.setEditorStatus(msg,true);
   return {ok:false,error:msg};
  }
 }

 undoOp():boolean{
  if(!this.builder)return false;
  const undone=this.builder.undo();
  if(!undone)return false;
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderTimeline();
  this.renderChannels();
  this.setEditorStatus(`Undid last pending op (${this.builder.ops.length} pending op(s) remaining).`,false);
  return true;
 }

 clearPending():void{
  if(!this.builder||!this.source?.text)return;
  this.builder=new AnimationOpBuilder(this.source.text,(this.source.easings??undefined) as Readonly<Record<string,EasingTuple>>|undefined);
  for(const op of this.appliedOps){
   try{this.builder.apply(op);}catch{break;}
  }
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderTimeline();
  this.renderChannels();
  this.setEditorStatus('Discarded unapplied animation edits.',false);
 }

 resetEdits():void{
  this.appliedOps=[];
  if(this.source?.available&&this.source.text){
   this.builder=new AnimationOpBuilder(this.source.text,(this.source.easings??undefined) as Readonly<Record<string,EasingTuple>>|undefined);
  }
  this.selectedKey=null;
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderTimeline();
  this.renderChannels();
  this.setEditorStatus('Reset: no pending animation ops.',false);
 }

 selectKey(trackIndex:number,keyIndex:number):boolean{
  const gate=this.gateInfo();
  if(!gate.editable){
   this.setEditorStatus(`${gate.code}: ${gate.reason}`,true);
   return false;
  }
  const clss=this.tracksInfo();
  const cls=clss[trackIndex];
  if(!cls){
   this.setEditorStatus(`ANIMATION_TRACK_OUT_OF_RANGE: track ${trackIndex}`,true);
   return false;
  }
  if(!cls.editable){
   this.setEditorStatus(`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`,true);
   return false;
  }
  const rawKeys=this.readDraftTrackKeys(trackIndex);
  const k=rawKeys[keyIndex];
  if(!k){
   this.setEditorStatus(`ANIMATION_KEY_OUT_OF_RANGE: key ${keyIndex} on track ${trackIndex}`,true);
   return false;
  }
  const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===cls.target&&t.name===cls.property)??null;
  this.selectedKey={animation:this.animation,trackIndex,keyIndex,pointer:inspTrack?.pointer??''};
  if(inspTrack){
   this.track=inspTrack;
   this.channel=0;
   this.renderChannels();
  }
  if(k.t>=0&&k.t<=this.runtimeDuration){
   this.options.seek(k.t);
  }
  this.syncTimelineKeysInPlace();
  this.syncKeyInspectorInPlace();
  return true;
 }

 selectedKeyInfo(){
  if(!this.selectedKey||this.selectedKey.animation!==this.animation)return null;
  const clss=this.tracksInfo();
  const cls=clss[this.selectedKey.trackIndex];
  if(!cls||!cls.editable)return null;
  const rawKeys=this.readDraftTrackKeys(this.selectedKey.trackIndex);
  const k=rawKeys[this.selectedKey.keyIndex];
  if(!k)return null;
  const spec=CHANNELS[cls.property]??[];
  return {
   animation:this.animation,
   trackIndex:this.selectedKey.trackIndex,
   keyIndex:this.selectedKey.keyIndex,
   bone:cls.target,
   property:cls.property,
   time:k.t,
   values:[...k.v],
   channels:spec.map((ch,idx)=>({index:idx,field:ch.field,local:ch.local,value:k.v[idx]!})),
  };
 }

 private readDraftTrackKeys(trackIndex:number):Array<{t:number;v:number[];ease?:string;curve?:number[]|'stepped'}>{
  const doc=this.draftDocument() as {animations?:Record<string,{tracks?:Array<{keys?:Array<{t:number;v:number[];ease?:string;curve?:number[]|'stepped'}>}>}>}|undefined;
  const keys=doc?.animations?.[this.animation]?.tracks?.[trackIndex]?.keys;
  return Array.isArray(keys)?keys:[];
 }

 private has(value:InspectionTarget){return !value||!!this.inspection&&(value.kind==='bone'?this.inspection.bones:this.inspection.slots).some(x=>x.name===value.name);}
 unavailable(reason:string){this.model(null,'');this.capture(null,undefined);this.status.textContent=reason;}
 select(value:InspectionTarget){if(this.has(value))this.selection.select(value);}
 fromParts(slot:string|null){this.selection.select(slot?{kind:'slot',name:slot}:null);}
 value(){return this.selection.value();}
 show(view:string){this.view=view;for(const [id,pane]of this.panes)pane.hidden=id!==view;for(const b of this.views)b.setAttribute('aria-pressed',String(b.dataset.animationView===view));}

 private renderSelection(){
  const selected=this.selection.value();this.options.host.dataset.selectedKind=selected?.kind??'';this.options.host.dataset.selectedName=selected?.name??'';
  for(const b of this.options.host.querySelectorAll<HTMLButtonElement>('[data-tree-kind]'))b.setAttribute('aria-pressed',String(b.dataset.treeKind===selected?.kind&&b.dataset.treeName===selected?.name));
  this.renderTimeline();this.renderChannels();this.redraw();
 }

 private renderTree(){
  const pane=this.panes.get('tree')!;pane.replaceChildren();if(!this.inspection)return;
  pane.append(button('Whole rig',()=>this.select(null)));const root=document.createElement('ul');root.className='animation-tree';pane.append(root);const parents=new Map<string,HTMLElement>();
  for(const b of boneHierarchy(this.inspection)){
   const li=document.createElement('li'),pick=button(b.name,()=>this.select({kind:'bone',name:b.name}));pick.dataset.treeKind='bone';pick.dataset.treeName=b.name;li.append(pick);(b.parent?parents.get(b.parent)??root:root).append(li);
   const children=document.createElement('ul');li.append(children);parents.set(b.name,children);
   for(const name of b.slots){const row=document.createElement('li'),slot=button('◇ '+name,()=>this.select({kind:'slot',name}));slot.dataset.treeKind='slot';slot.dataset.treeName=name;row.append(slot);children.append(row);}
  }
  const note=document.createElement('p');note.className='hint';note.textContent='Enable Bone points to pick bones on stage. Overlapping points pick the last active bone in source order; use the tree for an exact target. Attached Parts rows highlight together.';pane.prepend(note);
 }

 /**
  * Fixed-height single-row Key Bar. Both the insert controls and the selected-key fields
  * always occupy the same 26px bar so selecting or editing a key produces zero layout shift.
  */
 private renderKeyInspector(host:HTMLElement){
  const box=document.createElement('div');
  box.className='animation-key-inspector';
  box.dataset.keyInspector='';
  const gate=this.gateInfo();
  const clss=this.tracksInfo();
  const editableTracks=clss.filter(c=>c.editable);

  const addBar=document.createElement('div');
  addBar.className='animation-insert-bar';
  const trackLabel=document.createElement('label');
  trackLabel.className='animation-bar-field';
  trackLabel.textContent='Track ';
  const trackSel=document.createElement('select');
  trackSel.dataset.insertTrack='';
  trackSel.disabled=!gate.editable||editableTracks.length===0;
  if(editableTracks.length===0){
   const opt=document.createElement('option');
   opt.value='';
   opt.textContent='No editable tracks';
   trackSel.append(opt);
  }else{
   for(const c of editableTracks){
    const opt=document.createElement('option');
    opt.value=String(c.trackIndex);
    opt.textContent=`#${c.trackIndex} ${c.target} · ${c.property}`;
    if(this.selectedKey?.trackIndex===c.trackIndex)opt.selected=true;
    trackSel.append(opt);
   }
  }
  trackLabel.append(trackSel);

  const timeLabel=document.createElement('label');
  timeLabel.className='animation-bar-field';
  timeLabel.textContent='t ';
  const timeIn=document.createElement('input');
  timeIn.type='number';
  timeIn.step='any';
  timeIn.min='0';
  timeIn.dataset.insertTime='';
  timeIn.disabled=!gate.editable||editableTracks.length===0;
  timeIn.value=String(cleanMotionNumber(this.at));
  timeLabel.append(timeIn);

  const addBtn=button('+ Add key',()=>{
   const tIdx=Number(trackSel.value);
   const tVal=Number(timeIn.value);
   this.insertKey(tIdx,tVal);
  });
  addBtn.dataset.insertKey='';
  addBtn.disabled=!gate.editable||editableTracks.length===0;
  addBar.append(trackLabel,timeLabel,addBtn);
  box.append(addBar);

  const detail=document.createElement('div');
  detail.className='animation-key-detail';
  detail.dataset.keyDetail='';
  const title=document.createElement('strong');
  title.className='animation-key-title';
  title.dataset.keyInspectorTitle='';
  detail.append(title);

  const timeWrap=document.createElement('label');
  timeWrap.className='animation-bar-field';
  timeWrap.textContent='Key t (s) ';
  const timeInput=document.createElement('input');
  timeInput.type='number';
  timeInput.step='any';
  timeInput.min='0';
  timeInput.dataset.keyTimeInput='';
  timeWrap.append(timeInput);
  detail.append(timeWrap);

  const channelsHost=document.createElement('span');
  channelsHost.className='animation-key-channels';
  channelsHost.dataset.keyChannelsHost='';
  detail.append(channelsHost);

  const delBtn=button('Delete key',()=>{});
  delBtn.dataset.deleteKey='';
  detail.append(delBtn);

  const hint=document.createElement('span');
  hint.className='hint animation-key-empty';
  hint.dataset.keyInspectorEmpty='';
  detail.append(hint);

  box.append(detail);
  host.append(box);
  this.syncKeyInspectorInPlace();
 }

 private syncKeyInspectorInPlace(){
  const box=this.options.host.querySelector<HTMLElement>('[data-key-inspector]');
  if(!box)return;
  const gate=this.gateInfo();
  const info=this.selectedKeyInfo();

  const trackSel=box.querySelector<HTMLSelectElement>('[data-insert-track]');
  if(trackSel&&info){
   for(const opt of trackSel.options){
    opt.selected=opt.value===String(info.trackIndex);
   }
  }

  const title=box.querySelector<HTMLElement>('[data-key-inspector-title]');
  const timeInput=box.querySelector<HTMLInputElement>('[data-key-time-input]');
  const channelsHost=box.querySelector<HTMLElement>('[data-key-channels-host]');
  const delBtn=box.querySelector<HTMLButtonElement>('[data-delete-key]');
  const emptyHint=box.querySelector<HTMLElement>('[data-key-inspector-empty]');

  if(!info){
   if(title){
    title.textContent='No key selected';
    title.title='';
   }
   if(timeInput){
    timeInput.disabled=true;
    if(document.activeElement!==timeInput)timeInput.value='';
    timeInput.onchange=null;
   }
   if(channelsHost){
    const existing=channelsHost.querySelectorAll<HTMLInputElement>('[data-key-channel]');
    if(existing.length!==1||!existing[0]!.disabled){
     const chWrap=document.createElement('label');
     chWrap.className='animation-bar-field';
     chWrap.textContent='val ';
     const chInput=document.createElement('input');
     chInput.type='number';
     chInput.step='any';
     chInput.dataset.keyChannel='0';
     chInput.disabled=true;
     chInput.value='';
     chWrap.append(chInput);
     channelsHost.replaceChildren(chWrap);
    }
   }
   if(delBtn){
    delBtn.disabled=true;
    delBtn.onclick=null;
   }
   if(emptyHint){
    emptyHint.hidden=false;
    emptyHint.textContent=gate.editable
     ?'Click or drag a key ◆ on an editable bone track.'
     :`Key editing disabled (${gate.code}: ${gate.reason})`;
    emptyHint.title=emptyHint.textContent;
   }
   return;
  }

  if(title){
   title.textContent=`${info.bone} · ${info.property} · key #${info.keyIndex} (track #${info.trackIndex})`;
   title.title=title.textContent;
  }
  if(timeInput){
   timeInput.disabled=this.isBusy;
   if(document.activeElement!==timeInput)timeInput.value=String(cleanMotionNumber(info.time));
   timeInput.onchange=()=>{
    const nextT=Number(timeInput.value);
    this.setKeyTime(info.trackIndex,info.keyIndex,nextT);
   };
  }
  if(channelsHost){
   const existing=channelsHost.querySelectorAll<HTMLInputElement>('[data-key-channel]');
   const sameShape=
    existing.length===info.channels.length&&
    info.channels.every((ch,idx)=>existing[idx]?.dataset.channelLocal===ch.local&&existing[idx]?.dataset.channelField===ch.field);
   if(sameShape){
    info.channels.forEach((ch,idx)=>{
     const chIn=existing[idx]!;
     chIn.disabled=this.isBusy;
     if(document.activeElement!==chIn)chIn.value=String(ch.value);
     chIn.onchange=()=>{
      const nextV=Number(chIn.value);
      this.setKeyValue(info.trackIndex,info.keyIndex,ch.index,nextV);
     };
    });
   }else{
    const nodes:HTMLElement[]=[];
    for(const ch of info.channels){
     const chWrap=document.createElement('label');
     chWrap.className='animation-bar-field';
     chWrap.textContent=`${ch.local} (${ch.field}) `;
     const chInput=document.createElement('input');
     chInput.type='number';
     chInput.step='any';
     chInput.disabled=this.isBusy;
     chInput.dataset.keyChannel=String(ch.index);
     chInput.dataset.channelLocal=ch.local;
     chInput.dataset.channelField=ch.field;
     chInput.value=String(ch.value);
     chInput.onchange=()=>{
      const nextV=Number(chInput.value);
      this.setKeyValue(info.trackIndex,info.keyIndex,ch.index,nextV);
     };
     chWrap.append(chInput);
     nodes.push(chWrap);
    }
    channelsHost.replaceChildren(...nodes);
   }
  }
  if(delBtn){
   delBtn.disabled=this.isBusy;
   delBtn.onclick=()=>{
    this.deleteKey(info.trackIndex,info.keyIndex);
   };
  }
  if(emptyHint){
   emptyHint.hidden=true;
   emptyHint.textContent='';
  }
 }

 private syncTimelineKeysInPlace(){
  if(!this.inspection)return;
  const end=Math.max(this.runtimeDuration,...this.inspection.tracks.map(t=>t.keys.at(-1)?.time??0),Number.MIN_VALUE);
  const marks=this.options.host.querySelectorAll<HTMLButtonElement>('.animation-key');
  for(const mark of marks){
   const ptr=mark.dataset.track;
   const track=ptr?this.inspection.tracks.find(t=>t.pointer===ptr):undefined;
   const kIdx=Number(mark.dataset.keyIndex);
   const srcTrack=mark.dataset.sourceTrack!==undefined?Number(mark.dataset.sourceTrack):undefined;
   const isEditable=mark.dataset.editable==='true';
   const isSelected=isEditable&&srcTrack!==undefined&&this.selectedKey?.animation===this.animation&&this.selectedKey.trackIndex===srcTrack&&this.selectedKey.keyIndex===kIdx;
   mark.classList.toggle('selected',isSelected);
   mark.setAttribute('aria-pressed',String(isSelected));
   if(track&&track.keys[kIdx]){
    const key=track.keys[kIdx]!;
    const cleanT=formatSeconds(key.time);
    mark.dataset.keyTime=cleanT;
    mark.style.left=`${Math.max(0,Math.min(100,key.time/end*100))}%`;
    mark.title=`${track.target} · ${track.name} · key ${kIdx} · ${cleanT} s${isEditable?' (drag to retime)':' (read-only)'}`;
    mark.setAttribute('aria-label',mark.title);
   }
  }
 }

 private renderTimeline(){
  const pane=this.panes.get('timeline')!;
  const prevLanes=pane.querySelector<HTMLElement>('.animation-lanes');
  const prevScrollTop=prevLanes?.scrollTop??0;
  const prevScrollLeft=prevLanes?.scrollLeft??0;
  pane.replaceChildren();
  this.playhead=null;
  if(!this.inspection)return;
  this.renderKeyInspector(pane);

  const gate=this.gateInfo();
  const clss=this.tracksInfo();
  const clsByBoneProp=new Map<string,TrackClassification>();
  for(const c of clss){
   if(c.targetKind==='bone')clsByBoneProp.set(`${c.target}\0${c.property}`,c);
  }

  const tracks=filterTracks(this.inspection,this.selection.value());
  const end=Math.max(this.runtimeDuration,...this.inspection.tracks.map(t=>t.keys.at(-1)?.time??0),Number.MIN_VALUE);
  const cleanEnd=formatSeconds(end);
  const rowWidth=this.zoom>1?`calc(190px + (100% - 190px) * ${this.zoom})`:'100%';

  const list=document.createElement('div');
  list.className='animation-lanes';
  list.dataset.animationLanes='';
  pane.append(list);

  // Sticky top time ruler with ticks and scrub support
  const ruler=document.createElement('div');
  ruler.className='animation-ruler';
  ruler.dataset.animationRuler='';
  ruler.style.width=rowWidth;
  const rulerCorner=document.createElement('div');
  rulerCorner.className='animation-ruler-corner';
  const axis=document.createElement('div');
  axis.className='animation-axis';
  axis.textContent=`0 s → ${cleanEnd} s`;
  rulerCorner.append(axis);

  const rulerTrack=document.createElement('div');
  rulerTrack.className='animation-ruler-track';
  rulerTrack.dataset.animationRulerTrack='';
  for(const tickTime of buildRulerTicks(end,this.zoom)){
   const tick=document.createElement('span');
   tick.className='animation-ruler-tick';
   tick.dataset.rulerTick=formatSeconds(tickTime);
   tick.style.left=`${Math.max(0,Math.min(100,tickTime/end*100))}%`;
   tick.textContent=`${formatSeconds(tickTime)} s`;
   rulerTrack.append(tick);
  }
  const rulerPlayhead=document.createElement('span');
  rulerPlayhead.className='animation-playhead';
  rulerPlayhead.dataset.playhead='';
  rulerTrack.append(rulerPlayhead);
  this.bindRulerScrub(rulerTrack,end);
  ruler.append(rulerCorner,rulerTrack);
  list.append(ruler);

  const matchedSourceIndices=new Set<number>();

  for(const kind of ['bone','slot'] as const){
   for(const track of tracks.filter(t=>t.kind===kind)){
    const cls=kind==='bone'?clsByBoneProp.get(`${track.target}\0${track.name}`):clss.find(c=>c.targetKind==='slot'&&c.target===track.target&&c.property===track.name);
    if(cls)matchedSourceIndices.add(cls.trackIndex);
    const isEditable=gate.editable&&!!cls?.editable;
    const readonlyReason=!gate.editable
     ?`${gate.code}: ${gate.reason}`
     :cls&&!cls.editable
     ?`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`
     :kind==='slot'
     ?`ANIMATION_TRACK_READ_ONLY: slot track "${track.target}.${track.name}" is read-only in v1`
     :`ANIMATION_TRACK_READ_ONLY: bone track "${track.target}.${track.name}" is not an editable source track in ${this.source?.path??'animations_from'}`;

    const row=document.createElement('div');
    row.className='animation-lane';
    row.style.width=rowWidth;
    row.dataset.track=track.pointer;
    row.dataset.editable=String(isEditable);
    if(cls!==undefined)row.dataset.sourceTrack=String(cls.trackIndex);
    if(!isEditable)row.dataset.readonlyReason=readonlyReason;

    const head=document.createElement('div');
    head.className='animation-lane-head';
    head.dataset.laneHead='';

    const label=button(`${track.target} · ${track.name}`,()=>{this.track=track;this.channel=0;this.renderChannels();this.show('curve');});
    label.className='animation-lane-label';
    label.title=`${track.target} · ${track.name}`;
    head.append(label);

    if(isEditable&&cls){
     const addKeyBtn=button('+ Key',()=>{
      this.insertKey(cls.trackIndex,this.at);
     });
     addKeyBtn.className='animation-lane-add';
     addKeyBtn.dataset.addKeyTrack=String(cls.trackIndex);
     addKeyBtn.title=`Insert key on ${track.target} · ${track.name} at playhead (${formatSeconds(this.at)} s)`;
     head.append(addKeyBtn);
    }else{
     const badge=document.createElement('span');
     badge.className='animation-readonly-badge';
     badge.dataset.readonlyBadge='';
     badge.textContent=readonlyReason;
     badge.title=readonlyReason;
     head.append(badge);
    }
    row.append(head);

    const marks=document.createElement('div');
    marks.className='animation-key-lane';
    marks.dataset.track=track.pointer;
    row.append(marks);

    track.keys.forEach((key,index)=>{
     const cleanT=formatSeconds(key.time);
     const mark=button('◆',()=>{
      if(this.suppressNextKeyClick){
       this.suppressNextKeyClick=false;
       return;
      }
      this.track=track;this.channel=0;this.renderChannels();
      if(isEditable&&cls){
       this.selectedKey={animation:this.animation,trackIndex:cls.trackIndex,keyIndex:index,pointer:track.pointer};
       this.syncTimelineKeysInPlace();
       this.syncKeyInspectorInPlace();
      }else{
       this.setEditorStatus(readonlyReason,true);
      }
      if(key.time>=0&&key.time<=this.runtimeDuration){
       this.options.seek(key.time);
      }
     });
     mark.className='animation-key';
     const isSelected=isEditable&&cls!==undefined&&this.selectedKey?.animation===this.animation&&this.selectedKey.trackIndex===cls.trackIndex&&this.selectedKey.keyIndex===index;
     if(isSelected)mark.classList.add('selected');
     mark.setAttribute('aria-pressed',String(isSelected));
     Object.assign(mark.dataset,{
      track:track.pointer,
      targetKind:kind,
      target:track.target,
      timeline:track.name,
      keyIndex:String(index),
      keyTime:cleanT,
      editable:String(isEditable),
      ...(cls!==undefined?{sourceTrack:String(cls.trackIndex)}:{}),
     });
     mark.style.left=`${Math.max(0,Math.min(100,key.time/end*100))}%`;
     mark.title=`${track.target} · ${track.name} · key ${index} · ${cleanT} s${isEditable?' (drag to retime)':' (read-only)'}`;
     mark.setAttribute('aria-label',mark.title);

     if(isEditable&&cls){
      this.bindKeyDrag(mark,marks,cls.trackIndex,index,track,end);
     }
     marks.append(mark);
    });

    const line=document.createElement('span');
    line.className='animation-playhead';
    line.dataset.playhead='';
    marks.append(line);
    list.append(row);
   }
  }

  // Render any additional read-only source tracks from animations_from (e.g. physics, group, path, slider, bone.inherit)
  const selectedTarget=this.selection.value();
  const extraReadonly=clss.filter(c=>{
   if(matchedSourceIndices.has(c.trackIndex))return false;
   if(!selectedTarget)return true;
   if(selectedTarget.kind==='bone'&&c.targetKind==='bone'&&c.target===selectedTarget.name)return true;
   if(selectedTarget.kind==='slot'&&c.targetKind==='slot'&&c.target===selectedTarget.name)return true;
   return false;
  });
  for(const c of extraReadonly){
   const reason=gate.editable?`ANIMATION_TRACK_READ_ONLY: ${c.reason}`:`${gate.code}: ${gate.reason}`;
   const row=document.createElement('div');
   row.className='animation-readonly-lane';
   row.style.width=rowWidth;
   row.dataset.sourceTrack=String(c.trackIndex);
   row.dataset.targetKind=c.targetKind;
   row.dataset.target=c.target;
   row.dataset.property=c.property;
   row.dataset.editable='false';
   row.dataset.readonlyReason=reason;

   const head=document.createElement('div');
   head.className='animation-lane-head';
   head.dataset.laneHead='';
   const lbl=document.createElement('span');
   lbl.className='animation-lane-label';
   lbl.textContent=`${c.targetKind}:${c.target} · ${c.property}`;
   lbl.title=lbl.textContent;
   head.append(lbl);

   const trackArea=document.createElement('div');
   trackArea.className='animation-key-lane readonly-lane-track';
   const badge=document.createElement('span');
   badge.className='animation-readonly-badge';
   badge.dataset.readonlyBadge='';
   badge.textContent=reason;
   badge.title=reason;
   const line=document.createElement('span');
   line.className='animation-playhead';
   line.dataset.playhead='';
   trackArea.append(badge,line);

   row.append(head,trackArea);
   list.append(row);
  }

  if(!tracks.length&&!extraReadonly.length){
   const empty=document.createElement('p');
   empty.textContent='No stored tracks for this selection.';
   list.append(empty);
  }
  this.syncDockHeight(false);
  this.placePlayheads();
  if(prevScrollTop>0)list.scrollTop=prevScrollTop;
  if(prevScrollLeft>0)list.scrollLeft=prevScrollLeft;
 }

 private bindRulerScrub(rulerTrack:HTMLElement,end:number){
  let scrubbingId:number|null=null;
  const scrubAt=(clientX:number)=>{
   const rect=rulerTrack.getBoundingClientRect();
   if(rect.width<=0)return;
   const ratio=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));
   const maxSeek=this.runtimeDuration>0?Math.min(end,this.runtimeDuration):end;
   const target=cleanMotionNumber(Math.min(maxSeek,ratio*end));
   this.options.seek(target);
  };
  rulerTrack.addEventListener('pointerdown',e=>{
   if(!e.isPrimary||e.button!==0)return;
   e.preventDefault();
   e.stopPropagation();
   scrubbingId=e.pointerId;
   rulerTrack.setPointerCapture?.(e.pointerId);
   scrubAt(e.clientX);
  });
  rulerTrack.addEventListener('pointermove',e=>{
   if(scrubbingId!==e.pointerId)return;
   scrubAt(e.clientX);
  });
  const endScrub=(e:PointerEvent)=>{
   if(scrubbingId!==e.pointerId)return;
   scrubbingId=null;
   if(rulerTrack.hasPointerCapture?.(e.pointerId))rulerTrack.releasePointerCapture(e.pointerId);
  };
  rulerTrack.addEventListener('pointerup',endScrub);
  rulerTrack.addEventListener('pointercancel',endScrub);
 }

 private bindKeyDrag(
  mark:HTMLButtonElement,
  laneEl:HTMLElement,
  trackIndex:number,
  keyIndex:number,
  track:InspectionTrack,
  end:number,
 ){
  mark.addEventListener('pointerdown',e=>{
   if(!e.isPrimary||e.button!==0||this.isBusy)return;
   e.preventDefault();
   e.stopPropagation();
   this.suppressNextKeyClick=true;
   // Immediately select the key in place on pointerdown without rebuilding the DOM,
   // so pressing and dragging an unselected key works in a single gesture with zero layout shift.
   this.track=track;
   this.channel=0;
   this.selectedKey={animation:this.animation,trackIndex,keyIndex,pointer:track.pointer};
   this.syncTimelineKeysInPlace();
   this.syncKeyInspectorInPlace();
   this.renderChannels();
   const k=track.keys[keyIndex];
   if(k&&k.time>=0&&k.time<=this.runtimeDuration){
    this.options.seek(k.time);
   }
   this.draggingKey={
    pointerId:e.pointerId,
    trackIndex,
    keyIndex,
    startX:e.clientX,
    moved:false,
    laneEl,
    markEl:mark,
    end,
   };
   mark.setPointerCapture?.(e.pointerId);
  });

  mark.addEventListener('pointermove',e=>{
   const drag=this.draggingKey;
   if(!drag||drag.pointerId!==e.pointerId)return;
   if(!drag.moved&&Math.abs(e.clientX-drag.startX)<1)return;
   drag.moved=true;
   this.selectedKey={animation:this.animation,trackIndex,keyIndex,pointer:track.pointer};
   const rect=drag.laneEl.getBoundingClientRect();
   if(rect.width<=0)return;
   const ratio=Math.max(0,(e.clientX-rect.left)/rect.width);
   const rawTime=Math.round(ratio*drag.end*10000)/10000;
   const res=this.applyOp(
    {op:'set_key_time',animation:this.animation,track:trackIndex,key:keyIndex,time:rawTime},
    {skipTimelineDomRebuild:true},
   );
   if(res.ok&&rawTime>=0&&rawTime<=this.runtimeDuration){
    this.options.seek(rawTime);
   }
  });

  const finishDrag=(e:PointerEvent)=>{
   const drag=this.draggingKey;
   if(!drag||drag.pointerId!==e.pointerId)return;
   this.draggingKey=null;
   if(mark.hasPointerCapture?.(e.pointerId))mark.releasePointerCapture(e.pointerId);
   e.preventDefault();
   setTimeout(()=>{this.suppressNextKeyClick=false;},0);
  };
  mark.addEventListener('pointerup',finishDrag);
  mark.addEventListener('pointercancel',finishDrag);
 }

 private renderChannels(){
  const unsupported=this.track&&(this.track.kind!=='bone'||!CHANNELS[this.track.name])?`${this.track.target} · ${this.track.name} has no numeric curve evaluator`:'';this.unavailableChannel=unsupported;
  this.channelSelect.replaceChildren();const tracks=this.inspection?filterTracks(this.inspection,this.selection.value()):[];
  for(const t of tracks)if(t.kind==='bone')CHANNELS[t.name]?.forEach((c,i)=>{const o=document.createElement('option');o.value=JSON.stringify([t.pointer,i]);o.textContent=`${t.target} · ${t.name} · ${c.local}`;this.channelSelect.append(o);});
  const value=this.track?JSON.stringify([this.track.pointer,this.channel]):'';
  if(unsupported){this.track=null;this.channelSelect.selectedIndex=-1;}
  else if([...this.channelSelect.options].some(o=>o.value===value))this.channelSelect.value=value;
  else{const first=this.channelSelect.options[0];if(first){const [pointer,c]=JSON.parse(first.value);this.track=tracks.find(t=>t.pointer===pointer)??null;this.channel=c;}else this.track=null;}
  this.channelSelect.disabled=this.channelSelect.options.length===0;this.renderCurve();this.update(this.at,this.runtimeDuration);
 }

 private renderCurve(){
  const host=this.options.host.querySelector('[data-curve-plot]')!;host.replaceChildren();this.cursor=null;this.plot=null;
  const t=this.track,field=t&&CHANNELS[t.name]?.[this.channel]?.field;if(!t||!field||!t.keys.length)return;
  const segments=channelSegments(t,this.channel),values=t.keys.map(k=>k[field] as number);for(const s of segments)if(Array.isArray(s.curve))values.push(s.curve[1]!,s.curve[3]!);
  const low=Math.min(...values),high=Math.max(...values),span=high-low||1,end=Math.max(this.runtimeDuration,t.keys.at(-1)!.time,Number.MIN_VALUE);
  const plot=this.plot=(time:number,value:number)=>({x:48+time/end*728,y:195-(value-low)/span*160});
  host.append(svg('path',{d:'M48 20 V195 H776',class:'animation-axes'}));
  for(const [time,value]of [[0,low],[end,high]]){const n=svg('text',{x:time===0?48:650,y:time===0?220:15});n.textContent=`${formatSeconds(time)} s · ${formatSeconds(value)}`;host.append(n);}
  for(const [index,s]of segments.entries()){
   const a=plot(...s.from),b=plot(...s.to);let d=`M${a.x} ${a.y}`;
   if(Array.isArray(s.curve)){const c=plot(s.curve[0]!,s.curve[1]!),e=plot(s.curve[2]!,s.curve[3]!);d+=` C${c.x} ${c.y} ${e.x} ${e.y} ${b.x} ${b.y}`;
    host.append(svg('path',{d:`M${a.x} ${a.y} L${c.x} ${c.y} M${b.x} ${b.y} L${e.x} ${e.y}`,class:'animation-handles'}));for(const p of [c,e])host.append(svg('circle',{cx:p.x,cy:p.y,r:3,class:'animation-handle'}));
   }else d+=s.curve==='stepped'?` H${b.x} V${b.y}`:` L${b.x} ${b.y}`;
   const path=svg('path',{d,class:'animation-curve'});path.dataset.segment=String(index);path.dataset.stored=JSON.stringify(s);host.append(path);
  }
  for(const k of t.keys){const p=plot(k.time,k[field] as number);host.append(svg('circle',{cx:p.x,cy:p.y,r:3,class:'animation-curve-key'}));}
  this.cursor=svg('circle',{r:5,class:'animation-runtime-cursor'});host.append(this.cursor);
 }

 update(time:number,duration:number){
  this.at=time;this.runtimeDuration=duration;const timeInput=this.options.host.querySelector<HTMLInputElement>('[data-curve-time]')!;timeInput.max=String(formatSeconds(duration));if(document.activeElement!==timeInput)timeInput.value=String(formatSeconds(time));
  const insertTimeInput=this.options.host.querySelector<HTMLInputElement>('[data-insert-time]');
  if(insertTimeInput&&document.activeElement!==insertTimeInput)insertTimeInput.value=String(cleanMotionNumber(time));
  this.placePlayheads();const t=this.track,c=t&&CHANNELS[t.name]?.[this.channel];this.readout.textContent=`Runtime evaluation unavailable: ${this.unavailableChannel||'select a numeric stored channel'}.`;for(const key of ['time','channelValue','localValue','bone','property'])delete this.readout.dataset[key];
  if(!t||!c||!this.inspection)return;
  const value=evaluateStoredChannel(t,this.channel,time),local=evaluateBoneLocals(this.inspection,t.target,time)[c.local];
  Object.assign(this.readout.dataset,{time:String(time),channelValue:value===null?'setup':numeric(value),localValue:numeric(local),bone:t.target,property:c.local});
  this.readout.textContent=`Runtime evaluation · ${formatSeconds(time)} s · ${c.local} track: ${value===null?'before first key (setup)':numeric(value)} · authored local: ${numeric(local)}`;
  if(this.cursor&&this.plot){this.cursor.setAttribute('visibility',value===null?'hidden':'visible');if(value!==null){const p=this.plot(time,value);this.cursor.setAttribute('cx',String(p.x));this.cursor.setAttribute('cy',String(p.y));}}
 }

 private placePlayheads(){const end=Math.max(this.runtimeDuration,...(this.inspection?.tracks??[]).map(t=>t.keys.at(-1)?.time??0),Number.MIN_VALUE);for(const n of this.options.host.querySelectorAll<HTMLElement>('[data-playhead]'))n.style.left=`${Math.max(0,Math.min(100,this.at/end*100))}%`;}

 capture(player:Pick<RigPlayer,'bone'>|null,frame:PosedFrame|undefined){
  this.frame=frame??null;this.bones.clear();for(const b of player&&frame?this.inspection?.bones??[]:[]){try{const p=player!.bone(b.name);if(p.active)this.bones.set(b.name,{x:p.x,y:p.y});}catch{/* unavailable bones have no stage handle */}}this.redraw();
 }

 redraw(bonePoints=this.bonePoints){
  this.bonePoints=bonePoints;
  for(const [name,node]of this.boneButtons)if(!this.bones.has(name)){node.remove();this.boneButtons.delete(name);}
  const {stage}=this.options,selected=this.selection.value();stage.dataset.heldFrame=this.frame?'available':'unavailable';stage.dataset.selectedKind=selected?.kind??'';stage.dataset.selectedName=selected?.name??'';this.picks.hidden=!this.options.enabled();
  let order=0;for(const [name,p]of this.bones){let b=this.boneButtons.get(name);if(!b){b=button('',()=>this.select({kind:'bone',name}));b.className='animation-bone-pick';b.title=`Select bone ${name}`;b.setAttribute('aria-label',b.title);b.dataset.bone=name;this.boneButtons.set(name,b);this.picks.append(b);}
   b.style.zIndex=String(order++);const at=this.options.project(p.x,p.y);b.style.left=`${at.x}px`;b.style.top=`${at.y}px`;b.hidden=!bonePoints&&!(selected?.kind==='bone'&&selected.name===name);b.setAttribute('aria-pressed',String(selected?.kind==='bone'&&selected.name===name));
  }
 }

 dispose(){for(const dispose of this.disposers)dispose();this.picks.remove();}
}
