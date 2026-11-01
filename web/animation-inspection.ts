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
 findBoneConstraint,
 MAX_ANIMATION_OPS,
 overlayDraftOnInspection,
 seedCubicCurve,
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
const button=(label:string,click:(e?:MouseEvent)=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=click;return b;};

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
 readOnlyReason?:string|null|(()=>string|null);
}

export interface SelectedAnimationKey {
 animation:string;
 trackIndex:number;
 keyIndex:number;
 pointer:string;
}

export interface AnimationSideState {
 document?:unknown;
 animation?:string;
 baseInspection?:AnimationInspection|null;
 source:AnimationSourceView|null;
 sourceLoaded:boolean;
 sourceFallbackReason:string|null;
 builder:AnimationOpBuilder|null;
 appliedOps:AnimationSourceOp[];
 selectedKey:SelectedAnimationKey|null;
 selectedKeys:SelectedAnimationKey[];
 editorStatus:{text:string;error:boolean};
 poseMode:'rotate'|'translate';
 poseModeLockedByUser:boolean;
 zoom:number;
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
 private poseMode:'rotate'|'translate'='rotate';
 private poseModeLockedByUser=false;
 private unavailableChannel='';
 private selection:InspectionSelection;
 private panes=new Map<string,HTMLElement>();
 private views:HTMLButtonElement[]=[];
 private zoomButtons:HTMLButtonElement[]=[];
 private poseModeButtons:HTMLButtonElement[]=[];
 private playhead:SVGElement|null=null;
 private cursor:SVGElement|null=null;
 private plot:((t:number,v:number)=>{x:number;y:number})|null=null;
 private channelSelect:HTMLSelectElement;
 private segmentSelect:HTMLSelectElement;
 private easeSelect:HTMLSelectElement;
 private curveReadonly:HTMLElement;
 private curvePlot:SVGSVGElement;
 private curveSegment=0;
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
 private bones=new Map<string,{x:number;y:number;a:number;b:number;c:number;d:number;hasMatrix:boolean}>();
 private frame:PosedFrame|null=null;
 private down:{x:number;y:number}|null=null;
 private space=false;
 private disposers:(()=>void)[]=[];
 private boneButtons=new Map<string,HTMLButtonElement>();
 private bonePoints=false;

 // Keyed animation editing state (Slice 3 / Slice 3b / Slice 4a / Slice 4b / Slice 4c)
 private source:AnimationSourceView|null=null;
 private sourceLoaded=false;
 private sourceFallbackReason:string|null=null;
 private builder:AnimationOpBuilder|null=null;
 private appliedOps:AnimationSourceOp[]=[];
 private cachedDraftText:string|null=null;
 private cachedDraftDoc:unknown=undefined;
 private cachedTracksKey='';
 private cachedTracks:TrackClassification[]=[];
 private cachedGateKey='';
 private cachedGate:AnimationEditGate|null=null;
 private selectedKey:SelectedAnimationKey|null=null;
 private selectedKeys:SelectedAnimationKey[]=[];
 private lastNonEmptyAnimation='';
 private forceNextModelReload=false;
 private isBusy=false;
 private suppressNextKeyClick=false;
 private suppressNextBoneClick=false;
 private lastDockClientHeight=0;
 private lastLanesHeight=186;
 private draggingKey:{
  pointerId:number;
  trackIndex:number;
  keyIndex:number;
  startX:number;
  moved:boolean;
  wasAlreadyInMulti:boolean;
  undoGroupId:number;
  laneEl:HTMLElement;
  markEl:HTMLButtonElement;
  end:number;
 }|null=null;
 private draggingCurveHandle:{
  pointerId:number;
  trackIndex:number;
  segmentIndex:number;
  handleIndex:1|2;
  channel:number;
  undoGroupId:number;
  low:number;
  high:number;
  span:number;
  end:number;
 }|null=null;
 private draggingStageBone:{
  pointerId:number;
  boneName:string;
  mode:'rotate'|'translate';
  startX:number;
  startY:number;
  moved:boolean;
  undoGroupId:number;
  originWorld:{x:number;y:number};
  parentWorld:{x:number;y:number;a:number;b:number;c:number;d:number};
 }|null=null;

 constructor(private options:AnimationPanelOptions){
  const {host,stage}=options;
  host.classList.add('animation-inspection');
  host.innerHTML=`<div class="animation-dock-bar">
 <h3 class="animation-dock-title">Animation timeline &amp; inspection</h3>
 <div class="animation-view-buttons" aria-label="Animation inspection views"></div>
 <div class="animation-zoom-buttons" role="group" aria-label="Timeline horizontal zoom"></div>
 <div class="animation-pose-buttons" role="group" aria-label="Stage bone pose mode"></div>
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
 <p class="hint rebuild-drop-notice" data-rebuild-drop="animation" hidden></p>
 <p class="hint" data-animation-editor-status role="status"></p>
 <p class="hint" data-animation-apply-note></p>
 <p data-inspection-status class="hint"></p>
</div>
<section data-animation-pane="timeline" aria-label="Timeline"></section>
<section data-animation-pane="curve" aria-label="Stored curves" hidden>
 <div class="animation-curve-toolbar">
  <label>Channel <select data-curve-channel aria-label="Stored animation channel"></select></label>
  <label>Segment <select data-curve-segment aria-label="Curve segment"></select></label>
  <label>Curve <select data-curve-ease aria-label="Segment curve or easing"></select></label>
  <label>Time (s) <input data-curve-time type="number" min="0" step="any" aria-label="Exact inspection seconds"></label>
  <button data-curve-seek type="button">Inspect time</button>
  <span class="animation-curve-readonly hint" data-curve-readonly hidden></span>
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
  this.segmentSelect=host.querySelector('[data-curve-segment]')!;
  this.easeSelect=host.querySelector('[data-curve-ease]')!;
  this.curveReadonly=host.querySelector('[data-curve-readonly]')!;
  this.curvePlot=host.querySelector('[data-curve-plot]')!;
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
  const poseHost=host.querySelector('.animation-pose-buttons');
  if(poseHost){
   for(const [mode,label,tip] of [
    ['rotate','Rotate','Drag bone handles on stage to rotate (hold Alt during drag to translate)'],
    ['translate','Move','Drag bone handles on stage to translate (hold Alt during drag to rotate)'],
   ] as const){
    const pb=button(label,()=>this.setStagePoseMode(mode,true));
    pb.dataset.stagePoseMode=mode;
    pb.setAttribute('aria-pressed',String(mode===this.poseMode));
    pb.title=tip;
    poseHost.append(pb);
    this.poseModeButtons.push(pb);
   }
  }
  this.selection=new InspectionSelection(value=>{options.select(value);this.renderSelection();});
  host.querySelector<HTMLButtonElement>('[data-curve-seek]')!.onclick=()=>{const value=host.querySelector<HTMLInputElement>('[data-curve-time]')!.value.trim();options.seek(value?Number(value):NaN);};
  this.channelSelect.onchange=()=>{this.unavailableChannel='';const [pointer,c]=JSON.parse(this.channelSelect.value) as [string,number];this.track=this.inspection?.tracks.find(t=>t.pointer===pointer)??null;this.channel=c;this.renderCurve();this.update(this.at,this.runtimeDuration);};
  this.segmentSelect.onchange=()=>{
   this.curveSegment=Math.max(0,Number(this.segmentSelect.value)||0);
   const cls=this.resolveTrackClassification(this.track);
   if(this.gateInfo().editable&&cls?.editable&&this.track){
    const sel={animation:this.animation,trackIndex:cls.trackIndex,keyIndex:this.curveSegment,pointer:this.track.pointer};
    this.selectedKey=sel;
    this.selectedKeys=[sel];
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }
   this.renderCurve();
  };
  this.easeSelect.onchange=()=>{this.applyCurveModeChange(this.easeSelect.value);};
  this.bindCurveHandleDrag();
  this.picks=document.createElement('div');this.picks.className='animation-stage-picks';stage.append(this.picks);
  const down=(e:PointerEvent)=>{this.down=e.isPrimary&&e.button===0?{x:e.clientX,y:e.clientY}:null;};
  const up=(e:PointerEvent)=>{const start=this.down;this.down=null;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>3||this.space||!options.enabled()||e.target instanceof Element&&e.target.closest('button,input,select,textarea')||!this.frame)return;
   const rect=stage.getBoundingClientRect(),p0=options.project(0,0),px=options.project(1,0),py=options.project(0,1),x=(e.clientX-rect.left-p0.x)/(px.x-p0.x),y=(e.clientY-rect.top-p0.y)/(py.y-p0.y),slot=pickedSlot(this.frame,x,y);if(slot)this.select({kind:'slot',name:slot});
  };
  const key=(e:KeyboardEvent)=>{
   if(e.code==='Space')this.space=e.type==='keydown';
   if(e.type==='keydown'&&(e.key==='Delete'||e.key==='Backspace')&&!this.isBusy){
    const active=document.activeElement as Element|null;
    const inField=active&&typeof active.closest==='function'&&active.closest('input,textarea,select');
    const inHost=active&&typeof this.options.host.contains==='function'&&this.options.host.contains(active);
    if(!inField&&inHost){
     if(this.selectedKeys.length>1){
      e.preventDefault();
      this.deleteSelection();
     }else if(this.selectedKey&&this.selectedKey.animation===this.animation){
      e.preventDefault();
      this.deleteKey(this.selectedKey.trackIndex,this.selectedKey.keyIndex);
     }
    }
   }
  };
  const blur=()=>{this.space=false;this.down=null;};
  stage.addEventListener('pointerdown',down);stage.addEventListener('pointerup',up);window.addEventListener('keydown',key);window.addEventListener('keyup',key);window.addEventListener('blur',blur);
  this.disposers.push(()=>{stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointerup',up);window.removeEventListener('keydown',key);window.removeEventListener('keyup',key);window.removeEventListener('blur',blur);});

  if(typeof ResizeObserver!=='undefined'&&typeof host.closest==='function'){
   const playbackPanel=host.closest<HTMLElement>('[data-inspector-panel]');
   const dockPanel=host.closest<HTMLElement>('.inspector');
   const ro=new ResizeObserver(()=>{this.syncDockHeight(true);});
   if(playbackPanel)ro.observe(playbackPanel);
   if(dockPanel&&dockPanel!==playbackPanel)ro.observe(dockPanel);
   ro.observe(host);
   this.disposers.push(()=>ro.disconnect());
  }
  this.show('timeline');
  this.renderEditorBar();
 }

 stagePoseMode():'rotate'|'translate'{
  return this.poseMode;
 }

 setStagePoseMode(mode:'rotate'|'translate',lockedByUser=true){
  if(mode!=='rotate'&&mode!=='translate')return;
  this.poseMode=mode;
  if(lockedByUser)this.poseModeLockedByUser=true;
  for(const pb of this.poseModeButtons){
   pb.setAttribute('aria-pressed',String(pb.dataset.stagePoseMode===this.poseMode));
  }
  this.redraw();
 }

 private isBoneEditableInMode(boneName:string,mode:'rotate'|'translate'=this.poseMode):boolean{
  if(!this.gateInfo().editable)return false;
  const props=mode==='rotate'?['rotate']:['translate','translatex','translatey'];
  return this.tracksInfo().some(
   c=>c.targetKind==='bone'&&c.target===boneName&&c.editable&&props.includes(c.property),
  );
 }

 private firstEditableTrackIndexForBone(boneName:string,mode:'rotate'|'translate'=this.poseMode):number{
  const props=mode==='rotate'?['rotate']:['translate','translatex','translatey'];
  const hit=this.tracksInfo().find(
   c=>c.targetKind==='bone'&&c.target===boneName&&c.editable&&props.includes(c.property),
  );
  return hit?hit.trackIndex:Number.MAX_SAFE_INTEGER;
 }

 private overlappingBonesFor(boneName:string,maxScreenDistPx:number):string[]{
  const origin=this.bones.get(boneName);
  if(!origin)return [boneName];
  const originScreen=this.options.project(origin.x,origin.y);
  const btn=this.boneButtons.get(boneName);
  const hasRealDomLayout=(btn?.getBoundingClientRect?.().width??0)>0;
  const out:string[]=[];
  for(const [name,p] of this.bones){
   const worldDist=Math.hypot(p.x-origin.x,p.y-origin.y);
   if(worldDist<=1e-3){
    out.push(name);
    continue;
   }
   if(hasRealDomLayout&&maxScreenDistPx>0){
    const sc=this.options.project(p.x,p.y);
    if(Math.hypot(sc.x-originScreen.x,sc.y-originScreen.y)<=maxScreenDistPx){
     out.push(name);
    }
   }
  }
  return out.length>0?out:[boneName];
 }

 private sortOverlappingBones(candidates:readonly string[],mode:'rotate'|'translate'=this.poseMode):string[]{
  const otherMode:'rotate'|'translate'=mode==='rotate'?'translate':'rotate';
  const boneOrder=new Map((this.inspection?.bones??[]).map((b,i)=>[b.name,i]));
  return [...candidates].sort((a,b)=>{
   const aEdit=this.isBoneEditableInMode(a,mode);
   const bEdit=this.isBoneEditableInMode(b,mode);
   if(aEdit!==bEdit)return aEdit?-1:1;
   if(aEdit&&bEdit){
    const ta=this.firstEditableTrackIndexForBone(a,mode);
    const tb=this.firstEditableTrackIndexForBone(b,mode);
    if(ta!==tb)return ta-tb;
   }
   const aOther=this.isBoneEditableInMode(a,otherMode);
   const bOther=this.isBoneEditableInMode(b,otherMode);
   if(aOther!==bOther)return aOther?-1:1;
   return (boneOrder.get(a)??0)-(boneOrder.get(b)??0);
  });
 }

 private resolveBoneForStageDrag(boneName:string,mode:'rotate'|'translate'=this.poseMode):string{
  const selected=this.selection.value();
  const exactGroup=this.overlappingBonesFor(boneName,2);
  const editableExact=this.sortOverlappingBones(
   exactGroup.filter(n=>this.isBoneEditableInMode(n,mode)),
   mode,
  );
  if(editableExact.length>0){
   if(selected?.kind==='bone'&&editableExact.includes(selected.name)){
    return selected.name;
   }
   return editableExact[0]!;
  }
  const hitboxGroup=this.overlappingBonesFor(boneName,12);
  const editableNearby=this.sortOverlappingBones(
   hitboxGroup.filter(n=>this.isBoneEditableInMode(n,mode)),
   mode,
  );
  if(editableNearby.length>0){
   if(selected?.kind==='bone'&&editableNearby.includes(selected.name)){
    return selected.name;
   }
   return editableNearby[0]!;
  }
  return boneName;
 }

 private resolveBoneForStageClick(boneName:string):string{
  const group=this.overlappingBonesFor(boneName,2);
  const candidates=group.length>1?group:this.overlappingBonesFor(boneName,10);
  if(candidates.length<=1)return boneName;
  const ordered=this.sortOverlappingBones(candidates,this.poseMode);
  const selected=this.selection.value();
  const curIdx=selected?.kind==='bone'?ordered.indexOf(selected.name):-1;
  if(curIdx<0)return ordered[0]!;
  return ordered[(curIdx+1)%ordered.length]!;
 }

 private autoSyncPoseModeFromProperty(property:string|undefined){
  if(this.poseModeLockedByUser||!property)return;
  if(property==='rotate')this.setStagePoseMode('rotate',false);
  else if(property==='translate'||property==='translatex'||property==='translatey')this.setStagePoseMode('translate',false);
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
  const panel=this.options.host.closest<HTMLElement>('[data-inspector-panel]')??this.options.host.closest<HTMLElement>('.inspector');
  if(!panel||panel.clientHeight<=0){
   lanes.style.height=`${this.lastLanesHeight}px`;
   lanes.style.maxHeight=`${this.lastLanesHeight}px`;
   return;
  }
  if(fromResize||panel.clientHeight!==this.lastDockClientHeight){
   this.lastDockClientHeight=panel.clientHeight;
   const overhead=panel.hasAttribute('data-inspector-panel')?129:159;
   this.lastLanesHeight=Math.max(104,Math.floor(panel.clientHeight-overhead));
  }
  lanes.style.height=`${this.lastLanesHeight}px`;
  lanes.style.maxHeight=`${this.lastLanesHeight}px`;
 }

 setSourceLoading(){
  this.sourceLoaded=false;
  this.source=null;
  this.sourceFallbackReason=null;
  this.builder=null;
  this.appliedOps=[];
  this.selectedKey=null;
  this.selectedKeys=[];
  this.syncEffectiveInspection(false);
  this.renderGateBanner();
  this.renderEditorBar();
  this.renderSelection();
 }

 exportSideState():AnimationSideState{
  return {
   document:this.document,
   animation:this.animation,
   baseInspection:this.baseInspection,
   source:this.source,
   sourceLoaded:this.sourceLoaded,
   sourceFallbackReason:this.sourceFallbackReason,
   builder:this.builder,
   appliedOps:this.appliedOps.map(o=>structuredClone(o)),
   selectedKey:this.selectedKey?{...this.selectedKey}:null,
   selectedKeys:this.selectedKeys.map(k=>({...k})),
   editorStatus:{
    text:this.editorStatus.textContent??'',
    error:this.editorStatus.classList.contains('error'),
   },
   poseMode:this.poseMode,
   poseModeLockedByUser:this.poseModeLockedByUser,
   zoom:this.zoom,
  };
 }

 importSideState(state:AnimationSideState|null){
  this.draggingKey=null;
  this.draggingCurveHandle=null;
  this.draggingStageBone=null;
  this.forceNextModelReload=true;
  if(!state){
   this.document=null;
   this.baseInspection=null;
   this.inspection=null;
   this.source=null;
   this.sourceLoaded=false;
   this.sourceFallbackReason=null;
   this.builder=null;
   this.appliedOps=[];
   this.selectedKey=null;
   this.selectedKeys=[];
   this.setEditorStatus('',false);
  }else{
   this.document=state.document??null;
   if(state.animation!==undefined)this.animation=state.animation;
   this.baseInspection=state.baseInspection??null;
   this.inspection=this.baseInspection;
   this.source=state.source;
   this.sourceLoaded=state.sourceLoaded;
   this.sourceFallbackReason=state.sourceFallbackReason;
   this.builder=state.builder;
   this.appliedOps=state.appliedOps.map(o=>structuredClone(o));
   this.selectedKey=state.selectedKey?{...state.selectedKey}:null;
   this.selectedKeys=state.selectedKeys.map(k=>({...k}));
   this.setEditorStatus(state.editorStatus.text,state.editorStatus.error);
   this.setStagePoseMode(state.poseMode,state.poseModeLockedByUser);
   this.setZoom(state.zoom);
  }
  this.syncEffectiveInspection(true);
  this.renderGateBanner();
  this.renderEditorBar();
  this.renderSelection();
 }

 loadSource(source:AnimationSourceView|null,fallbackReason:string|null=null){
  this.sourceLoaded=true;
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
   this.selectedKeys=[];
  }
  this.syncEffectiveInspection(false);
  this.renderGateBanner();
  this.renderEditorBar();
  this.renderSelection();
 }

 model(doc:unknown,animation:string){
  if(!this.forceNextModelReload&&this.document===doc&&this.animation===animation)return;
  this.forceNextModelReload=false;
  if(animation&&this.lastNonEmptyAnimation&&this.lastNonEmptyAnimation!==animation){
   this.selectedKey=null;
   this.selectedKeys=[];
   this.setEditorStatus('',false);
  }
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
  const text=this.builder.text;
  if(text===this.cachedDraftText)return this.cachedDraftDoc;
  this.cachedDraftText=text;
  try{this.cachedDraftDoc=JSON.parse(text);}catch{this.cachedDraftDoc=undefined;}
  return this.cachedDraftDoc;
 }

 gateInfo():AnimationEditGate{
  if(!this.animation){
   return {editable:false,code:'ANIMATION_NOT_IN_SOURCE',reason:'No animation selected.',note:null};
  }
  if(this.animation==='idle'){
   return checkAnimationEditGate('idle',this.source?.path??null);
  }
  const ro=typeof this.options.readOnlyReason==='function'?this.options.readOnlyReason():this.options.readOnlyReason;
  if(ro||!this.options.apply||!this.options.preview){
   return {
    editable:false,
    code:'ANIMATION_COMPARE_READ_ONLY',
    reason:
     ro??
     'keyed animation editing is read-only in comparison sessions until per-side animation rebuild is wired.',
    note:null,
   };
  }
  if(!this.sourceLoaded){
   return {
    editable:false,
    code:'ANIMATION_SOURCE_LOADING',
    reason:'Reading the producer handoff…',
    note:null,
   };
  }
  if(!this.source||!this.source.available||!this.source.text){
   const r=this.source?.reason??this.sourceFallbackReason??'config.json does not declare an "animations_from" motion spec file.';
   const clean=r.replace(/^ANIMATION_SOURCE_MISSING:\s*/,'');
   return {editable:false,code:'ANIMATION_SOURCE_MISSING',reason:clean,note:null};
  }
  const gateKey=`${this.animation}\0${this.source.path??''}\0${this.builder?.text??''}`;
  if(gateKey===this.cachedGateKey&&this.cachedGate)return this.cachedGate;
  const gate=checkAnimationEditGate(this.animation,this.source.path,this.draftDocument());
  this.cachedGateKey=gateKey;
  this.cachedGate=gate;
  return gate;
 }

 tracksInfo():TrackClassification[]{
  const doc=this.draftDocument();
  if(!doc||!this.animation)return [];
  const key=`${this.animation}\0${this.builder?.text??''}`;
  if(key===this.cachedTracksKey)return this.cachedTracks;
  this.cachedTracksKey=key;
  this.cachedTracks=classifyAnimationTracks(doc,this.animation);
  return this.cachedTracks;
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
   delete this.gateBanner.dataset.loading;
   return;
  }
  if(gate.code==='ANIMATION_SOURCE_LOADING'){
   this.gateBanner.textContent=gate.reason??'Reading the producer handoff…';
   this.gateBanner.title=this.gateBanner.textContent;
   this.gateBanner.dataset.gateCode='LOADING';
   this.gateBanner.dataset.editable='false';
   this.gateBanner.dataset.loading='true';
   return;
  }
  delete this.gateBanner.dataset.loading;
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
  const gate=this.gateInfo();
  this.undoOpBtn.disabled=this.isBusy||!gate.editable||allOps.length===0;
  this.clearOpsBtn.disabled=this.isBusy||!gate.editable||!hasPreview;
  this.applyBtn.disabled=this.isBusy||!gate.editable||!hasPreview||allOps.length===0||!this.source?.available;
  this.resetBtn.disabled=this.isBusy||!gate.editable||(allOps.length===0&&appliedCount===0);
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
  this.renderCurve();
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
 reconcileStageApplied(applied:AppliedAnimation|null,restoredOutcome?:{text:string;error:boolean}|null){
  const nextApplied=applied?applied.ops.map(o=>structuredClone(o)):[];
  if(JSON.stringify(this.appliedOps)!==JSON.stringify(nextApplied)){
   this.appliedOps=nextApplied;
   this.syncEffectiveInspection(true);
   this.renderEditorBar();
   this.renderTimeline();
   this.renderChannels();
  }
  const curStatus=(this.editorStatus.textContent??'').trim();
  if(applied){
   if(restoredOutcome){
    this.setEditorStatus(restoredOutcome.text,restoredOutcome.error);
   }
  }else if(/^Applied [0-9a-f]{6,}…/.test(curStatus)||(curStatus.startsWith('Applied ')&&curStatus.includes(' with ')&&curStatus.includes('Reset returns to the inspected build'))){
   this.setEditorStatus('',false);
  }
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
  const gate=this.gateInfo();
  if(!gate.editable){
   const err=`${gate.code}: ${gate.reason??'animation is read-only'}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  if(!this.builder||!this.source?.available){
   const err='ANIMATION_SOURCE_MISSING: animation source is not loaded';
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

 setKeyCurve(trackIndex:number,keyIndex:number,curve:readonly number[]|'stepped'|null){
  return this.applyOp(
   {op:'set_key_curve',animation:this.animation,track:trackIndex,key:keyIndex,curve},
   {skipTimelineDomRebuild:true},
  );
 }

 setKeyEase(trackIndex:number,keyIndex:number,ease:string|null){
  return this.applyOp(
   {op:'set_key_ease',animation:this.animation,track:trackIndex,key:keyIndex,ease},
   {skipTimelineDomRebuild:true},
  );
 }

 insertKey(trackIndex:number,time:number,value?:readonly number[]){
  const gate=this.gateInfo();
  if(!gate.editable){
   const err=`${gate.code}: ${gate.reason??'animation is read-only'}`;
   this.setEditorStatus(err,true);
   return {ok:false as const,error:err};
  }
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
    const sel={animation:this.animation,trackIndex,keyIndex:insertedIdx,pointer:inspTrack?.pointer??''};
    this.selectedKey=sel;
    this.selectedKeys=[sel];
    this.autoSyncPoseModeFromProperty(cls.property);
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
     this.selectedKeys=[];
    }else{
     this.selectedKey={...this.selectedKey,keyIndex:Math.min(keyIndex,rawKeys.length-1)};
     this.selectedKeys=[this.selectedKey];
    }
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }
  }
  return res;
 }

 deleteSelection(
  selections?:ReadonlyArray<{track:number;key:number}>,
 ):{ok:true;ops:readonly AnimationSourceOp[]}|{ok:false;error:string}{
  const gate=this.gateInfo();
  if(!gate.editable){
   const err=`${gate.code}: ${gate.reason??'animation is read-only'}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  if(!this.builder||!this.source?.available){
   const err='ANIMATION_SOURCE_MISSING: animation source is not loaded';
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  const targets=
   selections??
   this.selectedKeys
    .filter(s=>s.animation===this.animation)
    .map(s=>({track:s.trackIndex,key:s.keyIndex}));
  if(targets.length===0){
   const err='ANIMATION_KEY_OUT_OF_RANGE: no keys selected to delete';
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  try{
   this.options.pause?.();
   this.builder.deleteSelection(this.animation,targets);
   this.selectedKey=null;
   this.selectedKeys=[];
   this.syncEffectiveInspection(true);
   this.renderEditorBar();
   this.renderTimeline();
   this.renderChannels();
   this.setEditorStatus(`Deleted ${targets.length} selected key(s) (${this.builder.ops.length} pending op(s)).`,false);
   return {ok:true,ops:this.builder.ops};
  }catch(e){
   const msg=e instanceof Error?e.message:String(e);
   this.setEditorStatus(msg,true);
   return {ok:false,error:msg};
  }
 }

 moveSelection(
  selections:ReadonlyArray<{track:number;key:number}>,
  deltaTime:number,
 ):{ok:true;ops:readonly AnimationSourceOp[]}|{ok:false;error:string}{
  const gate=this.gateInfo();
  if(!gate.editable){
   const err=`${gate.code}: ${gate.reason??'animation is read-only'}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  if(!this.builder||!this.source?.available){
   const err='ANIMATION_SOURCE_MISSING: animation source is not loaded';
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
  this.selectedKeys=[];
  this.syncEffectiveInspection(true);
  this.renderEditorBar();
  this.renderTimeline();
  this.renderChannels();
  this.setEditorStatus('Reset: no pending animation ops.',false);
 }

 isKeySelected(trackIndex:number,keyIndex:number):boolean{
  if(this.selectedKeys.some(s=>s.animation===this.animation&&s.trackIndex===trackIndex&&s.keyIndex===keyIndex)){
   return true;
  }
  return (
   this.selectedKey!==null&&
   this.selectedKey.animation===this.animation&&
   this.selectedKey.trackIndex===trackIndex&&
   this.selectedKey.keyIndex===keyIndex
  );
 }

 selectedKeysInfo():SelectedAnimationKey[]{
  const list=this.selectedKeys.filter(s=>s.animation===this.animation);
  if(list.length>0)return [...list];
  if(this.selectedKey&&this.selectedKey.animation===this.animation)return [this.selectedKey];
  return [];
 }

 toggleKeySelection(trackIndex:number,keyIndex:number,pointerHint?:string):boolean{
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
  const pointer=pointerHint??inspTrack?.pointer??'';
  const current=this.selectedKeysInfo();
  const existingIdx=current.findIndex(s=>s.trackIndex===trackIndex&&s.keyIndex===keyIndex);
  if(existingIdx>=0){
   current.splice(existingIdx,1);
   this.selectedKeys=current;
   this.selectedKey=current.at(-1)??null;
  }else{
   const entry:SelectedAnimationKey={animation:this.animation,trackIndex,keyIndex,pointer};
   current.push(entry);
   this.selectedKeys=current;
   this.selectedKey=entry;
   this.autoSyncPoseModeFromProperty(cls.property);
  }
  this.syncTimelineKeysInPlace();
  this.syncKeyInspectorInPlace();
  this.setEditorStatus(`Selected ${this.selectedKeys.length} key(s) across ${new Set(this.selectedKeys.map(s=>s.trackIndex)).size} track(s).`,false);
  return true;
 }

 selectKeys(selections:ReadonlyArray<{track:number;key:number}>):boolean{
  const gate=this.gateInfo();
  if(!gate.editable){
   this.setEditorStatus(`${gate.code}: ${gate.reason}`,true);
   return false;
  }
  const clss=this.tracksInfo();
  const next:SelectedAnimationKey[]=[];
  const seen=new Set<string>();
  const skippedReadonly=new Set<string>();
  for(const sel of selections){
   const cls=clss[sel.track];
   if(!cls)continue;
   if(!cls.editable){
    skippedReadonly.add(`${cls.target}.${cls.property}`);
    continue;
   }
   const rawKeys=this.readDraftTrackKeys(sel.track);
   if(!rawKeys[sel.key])continue;
   const id=`${sel.track}:${sel.key}`;
   if(seen.has(id))continue;
   seen.add(id);
   const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===cls.target&&t.name===cls.property)??null;
   next.push({animation:this.animation,trackIndex:sel.track,keyIndex:sel.key,pointer:inspTrack?.pointer??''});
  }
  this.selectedKeys=next;
  this.selectedKey=next.at(-1)??null;
  if(this.selectedKey){
   const lastCls=clss[this.selectedKey.trackIndex];
   this.autoSyncPoseModeFromProperty(lastCls?.property);
  }
  this.syncTimelineKeysInPlace();
  this.syncKeyInspectorInPlace();
  if(skippedReadonly.size>0){
   this.setEditorStatus(
    `Selected ${next.length} editable key(s); skipped read-only track(s): ${[...skippedReadonly].join(', ')} (ANIMATION_TRACK_READ_ONLY).`,
    false,
   );
  }else{
   this.setEditorStatus(`Selected ${next.length} key(s) across ${new Set(next.map(s=>s.trackIndex)).size} track(s).`,false);
  }
  return next.length>0;
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
  const curTarget=this.selection.value();
  if(curTarget&&(curTarget.kind!==cls.targetKind||curTarget.name!==cls.target)){
   this.selection.select(null);
  }
  const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===cls.target&&t.name===cls.property)??null;
  const sel={animation:this.animation,trackIndex,keyIndex,pointer:inspTrack?.pointer??''};
  this.selectedKey=sel;
  this.selectedKeys=[sel];
  this.autoSyncPoseModeFromProperty(cls.property);
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
  const multi=this.selectedKeysInfo();

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
   const hideInputs=!gate.editable;
   if(title){
    title.hidden=hideInputs;
    title.textContent='No key selected';
    title.title='';
   }
   if(timeInput){
    timeInput.disabled=true;
    if(timeInput.parentElement)timeInput.parentElement.hidden=hideInputs;
    if(document.activeElement!==timeInput)timeInput.value='';
    timeInput.onchange=null;
   }
   if(channelsHost){
    channelsHost.hidden=hideInputs;
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
    delBtn.hidden=hideInputs;
    delBtn.disabled=true;
    delBtn.textContent='Delete key';
    delBtn.onclick=null;
   }
   if(emptyHint){
    emptyHint.hidden=gate.editable;
    emptyHint.textContent=gate.editable
     ?''
     :`Key editing disabled (${gate.code})`;
    emptyHint.title=gate.editable?'':`${gate.code}: ${gate.reason}`;
   }
   return;
  }

  if(title){
   title.hidden=false;
   if(multi.length>1){
    const trackCount=new Set(multi.map(s=>s.trackIndex)).size;
    title.textContent=`${multi.length} keys selected (${trackCount} track${trackCount===1?'':'s'})`;
    title.title=`${multi.length} keys selected (${trackCount} track(s)) · anchor ${info.bone} · ${info.property} #${info.keyIndex}`;
   }else{
    title.textContent=`${info.bone} · ${info.property} · key #${info.keyIndex} (track #${info.trackIndex})`;
    title.title=title.textContent;
   }
  }
  if(timeInput){
   if(timeInput.parentElement)timeInput.parentElement.hidden=false;
   timeInput.disabled=this.isBusy;
   if(document.activeElement!==timeInput)timeInput.value=String(cleanMotionNumber(info.time));
   timeInput.onchange=()=>{
    const nextT=Number(timeInput.value);
    if(multi.length>1){
     const delta=cleanMotionNumber(nextT-info.time);
     this.moveSelection(multi.map(s=>({track:s.trackIndex,key:s.keyIndex})),delta);
    }else{
     this.setKeyTime(info.trackIndex,info.keyIndex,nextT);
    }
   };
  }
  if(channelsHost){
   channelsHost.hidden=multi.length>1;
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
   delBtn.hidden=false;
   delBtn.disabled=this.isBusy;
   delBtn.textContent=multi.length>1?`Delete ${multi.length} keys`:'Delete key';
   delBtn.onclick=()=>{
    if(multi.length>1){
     this.deleteSelection();
    }else{
     this.deleteKey(info.trackIndex,info.keyIndex);
    }
   };
  }
  if(emptyHint){
   emptyHint.hidden=true;
   emptyHint.textContent='';
  }
 }

 private effectiveEnd():number{
  return Math.max(
   this.runtimeDuration,
   ...(this.inspection?.tracks??[]).map(t=>t.keys.at(-1)?.time??0),
   Number.MIN_VALUE,
  );
 }

 private syncRulerInPlace(end:number){
  const cleanEnd=formatSeconds(end);
  const axis=this.options.host.querySelector<HTMLElement>('.animation-axis');
  if(axis)axis.textContent=`0 s → ${cleanEnd} s`;
  const rulerTrack=this.options.host.querySelector<HTMLElement>('[data-animation-ruler-track]');
  if(!rulerTrack)return;
  for(const oldTick of [...rulerTrack.querySelectorAll('.animation-ruler-tick')])oldTick.remove();
  const playhead=rulerTrack.querySelector('[data-playhead]');
  for(const tickTime of buildRulerTicks(end,this.zoom)){
   const tick=document.createElement('span');
   tick.className='animation-ruler-tick';
   tick.dataset.rulerTick=formatSeconds(tickTime);
   tick.style.left=`${Math.max(0,Math.min(100,tickTime/end*100))}%`;
   tick.textContent=`${formatSeconds(tickTime)} s`;
   rulerTrack.append(tick);
  }
  if(playhead)rulerTrack.append(playhead);
 }

 private syncTimelineKeysInPlace(){
  if(!this.inspection)return;
  const end=this.effectiveEnd();
  this.syncRulerInPlace(end);
  const marks=this.options.host.querySelectorAll<HTMLButtonElement>('.animation-key');
  for(const mark of marks){
   const ptr=mark.dataset.track;
   const track=ptr?this.inspection.tracks.find(t=>t.pointer===ptr):undefined;
   const kIdx=Number(mark.dataset.keyIndex);
   const srcTrack=mark.dataset.sourceTrack!==undefined?Number(mark.dataset.sourceTrack):undefined;
   const isEditable=mark.dataset.editable==='true';
   const isSelected=isEditable&&srcTrack!==undefined&&this.isKeySelected(srcTrack,kIdx);
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
  this.placePlayheads();
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
  const end=this.effectiveEnd();
  const cleanEnd=formatSeconds(end);
  const rowWidth=this.zoom>1?`calc(190px + (100% - 190px) * ${this.zoom})`:'100%';

  const list=document.createElement('div');
  list.className='animation-lanes';
  list.dataset.animationLanes='';
  pane.append(list);
  this.bindLaneBoxSelection(list);

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
  this.bindRulerScrub(rulerTrack);
  ruler.append(rulerCorner,rulerTrack);
  list.append(ruler);

  const matchedSourceIndices=new Set<number>();

  for(const kind of ['bone','slot'] as const){
   for(const track of tracks.filter(t=>t.kind===kind)){
    const trackPointer=track.pointer;
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
    row.dataset.track=trackPointer;
    row.dataset.editable=String(isEditable);
    if(cls!==undefined)row.dataset.sourceTrack=String(cls.trackIndex);
    if(!isEditable)row.dataset.readonlyReason=readonlyReason;

    const head=document.createElement('div');
    head.className='animation-lane-head';
    head.dataset.laneHead='';

    const label=button(`${track.target} · ${track.name}`,()=>{
     const liveTrack=this.inspection?.tracks.find(t=>t.pointer===trackPointer)??track;
     this.track=liveTrack;this.channel=0;this.autoSyncPoseModeFromProperty(track.name);this.renderChannels();this.show('curve');
    });
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
    }
    row.append(head);

    const marks=document.createElement('div');
    marks.className='animation-key-lane';
    marks.dataset.track=trackPointer;
    if(!isEditable){
     marks.onclick=e=>{if(e.target===marks)this.setEditorStatus(readonlyReason,true);};
    }
    if(!isEditable&&track.keys.length===0){
     const badge=document.createElement('span');
     badge.className='animation-readonly-badge';
     badge.dataset.readonlyBadge='';
     badge.textContent=readonlyReason;
     badge.title=readonlyReason;
     marks.append(badge);
    }
    row.append(marks);

    track.keys.forEach((key,index)=>{
     const cleanT=formatSeconds(key.time);
     const mark=button('◆',e=>{
      if(this.suppressNextKeyClick||(isEditable&&cls&&(e?.detail??0)>0)){
       this.suppressNextKeyClick=false;
       return;
      }
      const liveTrack=this.inspection?.tracks.find(t=>t.pointer===trackPointer)??track;
      const liveIdx=Number(mark.dataset.keyIndex??index);
      const liveKey=liveTrack.keys[liveIdx]??key;
      this.track=liveTrack;this.channel=0;this.renderChannels();
      if(isEditable&&cls){
       if(e?.shiftKey){
        this.toggleKeySelection(cls.trackIndex,liveIdx,trackPointer);
       }else{
        const sel={animation:this.animation,trackIndex:cls.trackIndex,keyIndex:liveIdx,pointer:trackPointer};
        this.selectedKey=sel;
        this.selectedKeys=[sel];
        this.autoSyncPoseModeFromProperty(cls.property);
        this.syncTimelineKeysInPlace();
        this.syncKeyInspectorInPlace();
       }
      }else{
       this.setEditorStatus(readonlyReason,true);
      }
      if(liveKey.time>=0&&liveKey.time<=this.runtimeDuration){
       this.options.seek(liveKey.time);
      }
     });
     mark.className='animation-key';
     const isSelected=isEditable&&cls!==undefined&&this.isKeySelected(cls.trackIndex,index);
     if(isSelected)mark.classList.add('selected');
     mark.setAttribute('aria-pressed',String(isSelected));
     Object.assign(mark.dataset,{
      track:trackPointer,
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
      this.bindKeyDrag(mark,marks,cls.trackIndex,index,trackPointer);
     }
     marks.append(mark);
    });

    const line=document.createElement('span');
    line.className='animation-playhead';
    line.dataset.playhead='';
    marks.append(line);
    if(gate.editable&&!isEditable&&track.keys.length>0){
     row.classList.add('has-readonly-note');
     const badge=document.createElement('div');
     badge.className='animation-readonly-badge animation-readonly-subrow';
     badge.dataset.readonlyBadge='';
     badge.textContent=readonlyReason;
     badge.title=readonlyReason;
     row.append(badge);
    }
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

 /**
  * Box-drag selection (>= 3 px) across `.animation-lanes` / `.animation-key-lane`,
  * while a plain click (< 3 px) on an empty editable `.animation-key-lane` seeks the playhead.
  * Playhead scrub remains on `.animation-ruler-track`.
  */
 private bindLaneBoxSelection(list:HTMLElement){
  let activeBox:{
   pointerId:number;
   startX:number;
   startY:number;
   shiftKey:boolean;
   baseSelection:SelectedAnimationKey[];
   clickedLane:HTMLElement|null;
   clickedRow:HTMLElement|null;
   moved:boolean;
   boxEl:HTMLElement|null;
  }|null=null;

  list.addEventListener('pointerdown',e=>{
   if(!e.isPrimary||e.button!==0||this.isBusy)return;
   const rawTarget=e.target as (Element&{dataset?:DOMStringMap;className?:string})|null;
   const hitInteractive=rawTarget?.closest?.('button,input,select,textarea,[data-animation-ruler],[data-lane-head]');
   if(hitInteractive)return;
   const clickedLane=rawTarget?.closest?.<HTMLElement>('.animation-key-lane')??(rawTarget?.className?.includes('animation-key-lane')?rawTarget as unknown as HTMLElement:null);
   const clickedRow=rawTarget?.closest?.<HTMLElement>('.animation-lane,.animation-readonly-lane')??(clickedLane?.parentElement as HTMLElement|null)??null;
   e.preventDefault();
   if(typeof window!=='undefined'&&typeof window.getSelection==='function'){
    window.getSelection()?.removeAllRanges?.();
   }
   activeBox={
    pointerId:e.pointerId,
    startX:e.clientX,
    startY:e.clientY,
    shiftKey:e.shiftKey,
    baseSelection:e.shiftKey?this.selectedKeysInfo():[],
    clickedLane,
    clickedRow,
    moved:false,
    boxEl:null,
   };
   list.setPointerCapture?.(e.pointerId);
  });

  list.addEventListener('pointermove',e=>{
   if(!activeBox||activeBox.pointerId!==e.pointerId)return;
   const dist=Math.hypot(e.clientX-activeBox.startX,e.clientY-activeBox.startY);
   if(!activeBox.moved&&dist<3)return;
   activeBox.moved=true;
   e.preventDefault();
   if(typeof window!=='undefined'&&typeof window.getSelection==='function'){
    window.getSelection()?.removeAllRanges?.();
   }
   const listRect=list.getBoundingClientRect();
   const minX=Math.min(activeBox.startX,e.clientX);
   const maxX=Math.max(activeBox.startX,e.clientX);
   const minY=Math.min(activeBox.startY,e.clientY);
   const maxY=Math.max(activeBox.startY,e.clientY);

   if(!activeBox.boxEl){
    const boxEl=document.createElement('div');
    boxEl.className='animation-selection-box';
    boxEl.dataset.selectionBox='';
    list.append(boxEl);
    activeBox.boxEl=boxEl;
   }
   activeBox.boxEl.style.left=`${minX-listRect.left+(list.scrollLeft||0)}px`;
   activeBox.boxEl.style.top=`${minY-listRect.top+(list.scrollTop||0)}px`;
   activeBox.boxEl.style.width=`${maxX-minX}px`;
   activeBox.boxEl.style.height=`${maxY-minY}px`;

   const merged=new Map<string,SelectedAnimationKey>();
   for(const s of activeBox.baseSelection){
    merged.set(`${s.trackIndex}:${s.keyIndex}`,s);
   }
   const skippedReadonly=new Set<string>();
   const allMarks=list.querySelectorAll<HTMLButtonElement>('.animation-key');
   for(const mark of allMarks){
    const r=mark.getBoundingClientRect();
    const cx=(r.left+r.right)/2;
    const cy=(r.top+r.bottom)/2;
    const intersects=r.right>=minX&&r.left<=maxX&&r.bottom>=minY&&r.top<=maxY&&(cx>=minX-4&&cx<=maxX+4&&cy>=minY-4&&cy<=maxY+4);
    if(!intersects)continue;
    if(mark.dataset.editable==='true'&&mark.dataset.sourceTrack!==undefined){
     const tr=Number(mark.dataset.sourceTrack);
     const kIdx=Number(mark.dataset.keyIndex);
     merged.set(`${tr}:${kIdx}`,{
      animation:this.animation,
      trackIndex:tr,
      keyIndex:kIdx,
      pointer:mark.dataset.track??'',
     });
    }else{
     skippedReadonly.add(`${mark.dataset.target??''}.${mark.dataset.timeline??''}`);
    }
   }
   this.selectedKeys=[...merged.values()];
   this.selectedKey=this.selectedKeys.at(-1)??null;
   this.syncTimelineKeysInPlace();
   this.syncKeyInspectorInPlace();
   if(skippedReadonly.size>0){
    this.setEditorStatus(
     `Selected ${this.selectedKeys.length} editable key(s); skipped read-only track(s): ${[...skippedReadonly].join(', ')} (ANIMATION_TRACK_READ_ONLY).`,
     false,
    );
   }else{
    this.setEditorStatus(
     `Selected ${this.selectedKeys.length} key(s) across ${new Set(this.selectedKeys.map(s=>s.trackIndex)).size} track(s).`,
     false,
    );
   }
  });

  const endBox=(e:PointerEvent)=>{
   if(!activeBox||activeBox.pointerId!==e.pointerId)return;
   const box=activeBox;
   activeBox=null;
   if(list.hasPointerCapture?.(e.pointerId))list.releasePointerCapture(e.pointerId);
   if(box.boxEl)box.boxEl.remove();
   if(!box.moved&&box.clickedLane){
    const rowEditable=box.clickedRow?.dataset.editable==='true';
    const roReason=box.clickedRow?.dataset.readonlyReason;
    if(!rowEditable&&roReason){
     this.setEditorStatus(roReason,true);
     return;
    }
    if(rowEditable){
     if(!box.shiftKey){
      this.selectedKey=null;
      this.selectedKeys=[];
      this.syncTimelineKeysInPlace();
      this.syncKeyInspectorInPlace();
     }
     const rect=box.clickedLane.getBoundingClientRect();
     if(rect.width>0){
      const end=this.effectiveEnd();
      const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
      const rawTime=cleanMotionNumber(ratio*end);
      this.at=rawTime;
      this.placePlayheads();
      const maxSeek=this.runtimeDuration>0?Math.min(end,this.runtimeDuration):end;
      this.options.seek(cleanMotionNumber(Math.min(maxSeek,rawTime)));
     }
    }
   }
  };
  list.addEventListener('pointerup',endBox);
  list.addEventListener('pointercancel',endBox);
 }

 private bindRulerScrub(rulerTrack:HTMLElement){
  let scrubbingId:number|null=null;
  const scrubAt=(clientX:number)=>{
   const rect=rulerTrack.getBoundingClientRect();
   if(rect.width<=0)return;
   const end=this.effectiveEnd();
   const ratio=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));
   const rawTime=cleanMotionNumber(ratio*end);
   this.at=rawTime;
   this.placePlayheads();
   const maxSeek=this.runtimeDuration>0?Math.min(end,this.runtimeDuration):end;
   const target=cleanMotionNumber(Math.min(maxSeek,rawTime));
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
  trackPointer:string,
 ){
  mark.addEventListener('pointerdown',e=>{
   if(!e.isPrimary||e.button!==0||this.isBusy)return;
   e.preventDefault();
   e.stopPropagation();
   this.suppressNextKeyClick=true;
   // Immediately select the key in place on pointerdown without rebuilding the DOM,
   // so pressing and dragging an unselected key works in a single gesture with zero layout shift.
   const liveTrack=this.inspection?.tracks.find(t=>t.pointer===trackPointer)??null;
   const liveIdx=Number(mark.dataset.keyIndex??keyIndex);
   if(liveTrack)this.track=liveTrack;
   this.channel=0;
   if(e.shiftKey){
    this.toggleKeySelection(trackIndex,liveIdx,trackPointer);
    this.renderChannels();
    return;
   }
   const alreadyInMulti=this.selectedKeys.length>1&&this.isKeySelected(trackIndex,liveIdx);
   const sel={animation:this.animation,trackIndex,keyIndex:liveIdx,pointer:trackPointer};
   this.selectedKey=sel;
   if(!alreadyInMulti){
    this.selectedKeys=[sel];
   }
   this.autoSyncPoseModeFromProperty(liveTrack?.name);
   this.syncTimelineKeysInPlace();
   this.syncKeyInspectorInPlace();
   this.renderChannels();
   const k=liveTrack?.keys[liveIdx];
   if(k&&k.time>=0&&k.time<=this.runtimeDuration){
    this.options.seek(k.time);
   }
   this.draggingKey={
    pointerId:e.pointerId,
    trackIndex,
    keyIndex:liveIdx,
    startX:e.clientX,
    moved:false,
    wasAlreadyInMulti:alreadyInMulti,
    undoGroupId:this.builder?this.builder.beginUndoGroup():1,
    laneEl,
    markEl:mark,
    end:this.effectiveEnd(),
   };
   mark.setPointerCapture?.(e.pointerId);
  });

  mark.addEventListener('pointermove',e=>{
   const drag=this.draggingKey;
   if(!drag||drag.pointerId!==e.pointerId)return;
   if(!drag.moved&&Math.abs(e.clientX-drag.startX)<1)return;
   drag.moved=true;
   this.selectedKey={animation:this.animation,trackIndex:drag.trackIndex,keyIndex:drag.keyIndex,pointer:trackPointer};
   const rect=drag.laneEl.getBoundingClientRect();
   if(rect.width<=0)return;
   const ratio=Math.max(0,(e.clientX-rect.left)/rect.width);
   const rawTime=Math.round(ratio*drag.end*10000)/10000;
   if(this.selectedKeys.length>1&&this.isKeySelected(drag.trackIndex,drag.keyIndex)){
    const anchorKey=this.readDraftTrackKeys(drag.trackIndex)[drag.keyIndex];
    if(!anchorKey)return;
    const delta=cleanMotionNumber(rawTime-anchorKey.t);
    if(Math.abs(delta)<1e-6)return;
    const runMove=()=>
     this.moveSelection(
      this.selectedKeys.map(s=>({track:s.trackIndex,key:s.keyIndex})),
      delta,
     );
    const res=this.builder?this.builder.withUndoGroup(drag.undoGroupId,runMove):runMove();
    if(res.ok&&rawTime>=0&&rawTime<=this.runtimeDuration){
     this.options.seek(rawTime);
    }
    return;
   }
   const res=this.applyOp(
    {op:'set_key_time',animation:this.animation,track:drag.trackIndex,key:drag.keyIndex,time:rawTime},
    {skipTimelineDomRebuild:true},
   );
   if(res.ok&&rawTime>=0&&rawTime<=this.runtimeDuration){
    this.options.seek(rawTime);
   }
  });

  const finishDrag=(e:PointerEvent)=>{
   const drag=this.draggingKey;
   if(!drag||drag.pointerId!==e.pointerId){
    if(mark.hasPointerCapture?.(e.pointerId))mark.releasePointerCapture(e.pointerId);
    if(e.type==="pointercancel")this.suppressNextKeyClick=false;
    return;
   }
   this.draggingKey=null;
   if(mark.hasPointerCapture?.(e.pointerId))mark.releasePointerCapture(e.pointerId);
   if(!drag.moved&&drag.wasAlreadyInMulti&&this.selectedKey){
    this.selectedKeys=[this.selectedKey];
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }
   e.preventDefault();
   if(e.type==="pointercancel")this.suppressNextKeyClick=false;
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

 private resolveTrackClassification(track:InspectionTrack|null):TrackClassification|undefined{
  if(!track||track.kind!=='bone')return undefined;
  return this.tracksInfo().find(c=>c.targetKind==='bone'&&c.target===track.target&&c.property===track.name);
 }

 private availableEasings():Record<string,EasingTuple>{
  const out:Record<string,EasingTuple>={...(this.source?.easings??{})};
  const doc=this.draftDocument() as {easings?:Record<string,unknown>}|undefined;
  if(doc?.easings&&typeof doc.easings==='object'&&!Array.isArray(doc.easings)){
   for(const [k,v] of Object.entries(doc.easings)){
    if(Array.isArray(v)&&v.length===4&&v.every(n=>typeof n==='number'&&Number.isFinite(n))){
     out[k]=[v[0] as number,v[1] as number,v[2] as number,v[3] as number];
    }
   }
  }
  return out;
 }

 private fullSegmentCubic(trackIndex:number,segmentIndex:number):number[]|null{
  const rawKeys=this.readDraftTrackKeys(trackIndex);
  const k0=rawKeys[segmentIndex],k1=rawKeys[segmentIndex+1];
  if(!k0||!k1)return null;
  const numChannels=k0.v.length;
  if(Array.isArray(k0.curve)&&k0.curve.length===numChannels*4){
   return k0.curve.map(n=>cleanMotionNumber(n));
  }
  if(typeof k0.ease==='string'&&k0.ease!=='stepped'){
   const handles=this.availableEasings()[k0.ease];
   if(handles&&handles.length===4){
    const [hx1,hy1,hx2,hy2]=handles;
    const dt=k1.t-k0.t;
    const out:number[]=[];
    for(let c=0;c<numChannels;c++){
     const v1=k0.v[c]!,dv=k1.v[c]!-v1;
     out.push(
      cleanMotionNumber(k0.t+dt*hx1),
      cleanMotionNumber(v1+dv*hy1),
      cleanMotionNumber(k0.t+dt*hx2),
      cleanMotionNumber(v1+dv*hy2),
     );
    }
    return out;
   }
  }
  return seedCubicCurve(k0.t,k0.v,k1.t,k1.v);
 }

 private applyCurveModeChange(mode:string){
  const gate=this.gateInfo();
  const cls=this.resolveTrackClassification(this.track);
  if(!gate.editable||!cls?.editable){
   const reason=!gate.editable?`${gate.code}: ${gate.reason}`:cls?`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`:'ANIMATION_TRACK_READ_ONLY: track is read-only';
   this.setEditorStatus(reason,true);
   return;
  }
  const segIdx=this.curveSegment;
  if(mode==='linear'){
   this.setKeyCurve(cls.trackIndex,segIdx,null);
  }else if(mode==='stepped'){
   this.setKeyCurve(cls.trackIndex,segIdx,'stepped');
  }else if(mode==='cubic'){
   const seeded=this.fullSegmentCubic(cls.trackIndex,segIdx);
   if(seeded)this.setKeyCurve(cls.trackIndex,segIdx,seeded);
  }else if(mode.startsWith('ease:')){
   this.setKeyEase(cls.trackIndex,segIdx,mode.slice(5));
  }
 }

 private renderCurveControls(
  t:InspectionTrack|null,
  segments:ReturnType<typeof channelSegments>,
  cls:TrackClassification|undefined,
  trackEditable:boolean,
 ){
  const gate=this.gateInfo();
  this.segmentSelect.replaceChildren();
  this.easeSelect.replaceChildren();
  if(!t||segments.length===0){
   const opt=document.createElement('option');
   opt.value='0';
   opt.textContent='No segments';
   this.segmentSelect.append(opt);
   this.segmentSelect.disabled=true;
   const eOpt=document.createElement('option');
   eOpt.value='linear';
   eOpt.textContent='Linear';
   this.easeSelect.append(eOpt);
   this.easeSelect.disabled=true;
   const reason=!gate.editable
    ?`${gate.code}: ${gate.reason}`
    :cls&&!cls.editable
    ?`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`
    :t
    ?'Track has fewer than 2 keys (no curve segments).'
    :'Select a bone channel.';
   this.curveReadonly.hidden=false;
   this.curveReadonly.textContent=reason;
   this.curveReadonly.title=reason;
   return;
  }

  if(
   cls&&
   this.selectedKey?.animation===this.animation&&
   this.selectedKey.trackIndex===cls.trackIndex&&
   this.selectedKey.keyIndex>=0&&
   this.selectedKey.keyIndex<segments.length
  ){
   this.curveSegment=this.selectedKey.keyIndex;
  }
  this.curveSegment=Math.max(0,Math.min(this.curveSegment,segments.length-1));

  segments.forEach((s,idx)=>{
   const opt=document.createElement('option');
   opt.value=String(idx);
   opt.textContent=`#${idx} · ${formatSeconds(s.from[0])}s → ${formatSeconds(s.to[0])}s`;
   if(idx===this.curveSegment)opt.selected=true;
   this.segmentSelect.append(opt);
  });
  this.segmentSelect.disabled=segments.length<=1;

  const easings=this.availableEasings();
  const modeOptions:Array<[string,string]>=[
   ['linear','Linear'],
   ['cubic','Cubic Bézier (handles)'],
   ['stepped','Stepped (hold)'],
   ...Object.keys(easings).map((name):[string,string]=>[`ease:${name}`,`Ease: ${name}`]),
  ];
  for(const [val,label] of modeOptions){
   const opt=document.createElement('option');
   opt.value=val;
   opt.textContent=label;
   this.easeSelect.append(opt);
  }

  let currentMode='linear';
  if(cls){
   const rawKey=this.readDraftTrackKeys(cls.trackIndex)[this.curveSegment];
   if(rawKey){
    if(rawKey.curve==='stepped'||rawKey.ease==='stepped')currentMode='stepped';
    else if(Array.isArray(rawKey.curve))currentMode='cubic';
    else if(typeof rawKey.ease==='string'&&rawKey.ease){
     const eVal=`ease:${rawKey.ease}`;
     if(![...this.easeSelect.options].some(o=>o.value===eVal)){
      const extra=document.createElement('option');
      extra.value=eVal;
      extra.textContent=`Ease: ${rawKey.ease}`;
      this.easeSelect.append(extra);
     }
     currentMode=eVal;
    }
   }
  }else{
   const seg=segments[this.curveSegment];
   if(seg?.curve==='stepped')currentMode='stepped';
   else if(Array.isArray(seg?.curve))currentMode='cubic';
  }
  this.easeSelect.value=currentMode;
  this.easeSelect.disabled=this.isBusy||!trackEditable;

  if(!trackEditable){
   const readonlyReason=!gate.editable
    ?`${gate.code}: ${gate.reason}`
    :cls&&!cls.editable
    ?`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`
    :`ANIMATION_TRACK_READ_ONLY: bone track "${t.target}.${t.name}" is not an editable source track in ${this.source?.path??'animations_from'}`;
   this.curveReadonly.hidden=false;
   this.curveReadonly.textContent=readonlyReason;
   this.curveReadonly.title=readonlyReason;
  }else{
   this.curveReadonly.hidden=true;
   this.curveReadonly.textContent='';
   this.curveReadonly.title='';
  }
 }

 private onCurveHandlePointerDown(e:PointerEvent,target:SVGElement){
  if(!e.isPrimary||e.button!==0||this.isBusy||this.draggingCurveHandle)return;
  e.preventDefault();
  e.stopPropagation();
  const gate=this.gateInfo();
  const cls=this.resolveTrackClassification(this.track);
  const trackEditable=gate.editable&&!!cls?.editable;
  if(!trackEditable||!cls||!this.track){
   const reason=!gate.editable
    ?`${gate.code}: ${gate.reason}`
    :cls&&!cls.editable
    ?`ANIMATION_TRACK_READ_ONLY: ${cls.reason}`
    :'ANIMATION_TRACK_READ_ONLY: curve handles are read-only on this track';
   this.setEditorStatus(reason,true);
   return;
  }
  const segIdx=Number(target.dataset.segment??0);
  const handleIdx=Number(target.dataset.curveHandle)===2?2:1;
  this.curveSegment=segIdx;
  const sel={animation:this.animation,trackIndex:cls.trackIndex,keyIndex:segIdx,pointer:this.track.pointer};
  this.selectedKey=sel;
  this.selectedKeys=[sel];
  this.syncTimelineKeysInPlace();
  this.syncKeyInspectorInPlace();
  const field=CHANNELS[this.track.name]?.[this.channel]?.field;
  if(!field||!this.track.keys.length)return;
  const segments=channelSegments(this.track,this.channel);
  const values=this.track.keys.map(k=>k[field] as number);
  for(const s of segments)if(Array.isArray(s.curve))values.push(s.curve[1]!,s.curve[3]!);
  const low=Math.min(...values),high=Math.max(...values),span=high-low||1;
  const end=Math.max(this.runtimeDuration,this.track.keys.at(-1)!.time,Number.MIN_VALUE);
  this.draggingCurveHandle={
   pointerId:e.pointerId,
   trackIndex:cls.trackIndex,
   segmentIndex:segIdx,
   handleIndex:handleIdx,
   channel:this.channel,
   undoGroupId:this.builder?this.builder.beginUndoGroup():1,
   low,
   high,
   span,
   end,
  };
  this.curvePlot.setPointerCapture?.(e.pointerId);
 }

 private bindCurveHandleDrag(){
  const svgHost=this.curvePlot;
  svgHost.addEventListener('pointerdown',e=>{
   const rawTarget=e.target as (Element&{dataset?:DOMStringMap})|null;
   const target=rawTarget?.closest?.<SVGElement>('[data-curve-handle]')??(rawTarget?.dataset?.curveHandle?rawTarget as unknown as SVGElement:null);
   if(target)this.onCurveHandlePointerDown(e,target);
  });

  svgHost.addEventListener('pointermove',e=>{
   const drag=this.draggingCurveHandle;
   if(!drag||drag.pointerId!==e.pointerId)return;
   const rect=svgHost.getBoundingClientRect();
   if(rect.width<=0||rect.height<=0)return;
   const toPlot=svgHost.getScreenCTM()?.inverse();
   if(!toPlot)return;
   const svgX=toPlot.a*e.clientX+toPlot.c*e.clientY+toPlot.e;
   const svgY=toPlot.b*e.clientX+toPlot.d*e.clientY+toPlot.f;
   const rawT=((svgX-48)/728)*drag.end;
   const rawV=drag.low+((195-svgY)/160)*drag.span;
   const rawKeys=this.readDraftTrackKeys(drag.trackIndex);
   const k0=rawKeys[drag.segmentIndex],k1=rawKeys[drag.segmentIndex+1];
   if(!k0||!k1)return;
   const cx=cleanMotionNumber(Math.max(k0.t,Math.min(k1.t,rawT)));
   const cy=cleanMotionNumber(rawV);
   const baseCurve=this.fullSegmentCubic(drag.trackIndex,drag.segmentIndex);
   if(!baseCurve)return;
   const nextCurve=[...baseCurve];
   const offset=drag.channel*4+(drag.handleIndex===2?2:0);
   nextCurve[offset]=cx;
   nextCurve[offset+1]=cy;
   this.setKeyCurve(drag.trackIndex,drag.segmentIndex,nextCurve);
  });

  const endDrag=(e:PointerEvent)=>{
   const drag=this.draggingCurveHandle;
   if(!drag||drag.pointerId!==e.pointerId)return;
   this.draggingCurveHandle=null;
   if(svgHost.hasPointerCapture?.(e.pointerId))svgHost.releasePointerCapture(e.pointerId);
   this.renderCurve();
  };
  svgHost.addEventListener('pointerup',endDrag);
  svgHost.addEventListener('pointercancel',endDrag);
 }

 private renderCurve(){
  const host=this.curvePlot;host.replaceChildren();this.cursor=null;this.plot=null;
  const t=this.track,field=t&&CHANNELS[t.name]?.[this.channel]?.field;
  const cls=this.resolveTrackClassification(t);
  const trackEditable=this.gateInfo().editable&&!!cls?.editable;
  if(!t||!field||!t.keys.length){
   this.renderCurveControls(null,[],cls,false);
   return;
  }
  const segments=channelSegments(t,this.channel);
  this.renderCurveControls(t,segments,cls,trackEditable);
  const values=t.keys.map(k=>k[field] as number);for(const s of segments)if(Array.isArray(s.curve))values.push(s.curve[1]!,s.curve[3]!);
  const activeDrag=this.draggingCurveHandle&&cls&&this.draggingCurveHandle.trackIndex===cls.trackIndex&&this.draggingCurveHandle.channel===this.channel?this.draggingCurveHandle:null;
  const low=activeDrag?activeDrag.low:Math.min(...values);
  const high=activeDrag?activeDrag.high:Math.max(...values);
  const span=activeDrag?activeDrag.span:(high-low||1);
  const end=activeDrag?activeDrag.end:Math.max(this.runtimeDuration,t.keys.at(-1)!.time,Number.MIN_VALUE);
  const plot=this.plot=(time:number,value:number)=>({x:48+time/end*728,y:195-(value-low)/span*160});
  host.append(svg('path',{d:'M48 20 V195 H776',class:'animation-axes'}));
  for(const [time,value]of [[0,low],[end,high]]){const n=svg('text',{x:time===0?48:650,y:time===0?220:15});n.textContent=`${formatSeconds(time)} s · ${formatSeconds(value)}`;host.append(n);}
  for(const [index,s]of segments.entries()){
   const a=plot(...s.from),b=plot(...s.to);let d=`M${a.x} ${a.y}`;
   if(Array.isArray(s.curve)){const c=plot(s.curve[0]!,s.curve[1]!),e=plot(s.curve[2]!,s.curve[3]!);d+=` C${c.x} ${c.y} ${e.x} ${e.y} ${b.x} ${b.y}`;
    const hLine=svg('path',{d:`M${a.x} ${a.y} L${c.x} ${c.y} M${b.x} ${b.y} L${e.x} ${e.y}`,class:'animation-handles'});
    hLine.dataset.handleLines=String(index);
    host.append(hLine);
    for(const [hIdx,p] of [[1,c],[2,e]] as const){
     const hCircle=svg('circle',{cx:p.x,cy:p.y,r:trackEditable?5:3,class:`animation-handle${index===this.curveSegment?' active':''}`});
     hCircle.dataset.curveHandle=String(hIdx);
     hCircle.dataset.segment=String(index);
     hCircle.dataset.editable=String(trackEditable);
     hCircle.addEventListener('pointerdown',e=>this.onCurveHandlePointerDown(e as PointerEvent,hCircle));
     host.append(hCircle);
    }
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

 private placePlayheads(){const end=this.effectiveEnd();for(const n of this.options.host.querySelectorAll<HTMLElement>('[data-playhead]'))n.style.left=`${Math.max(0,Math.min(100,this.at/end*100))}%`;}

 boneWorldMatrix(boneName:string):{x:number;y:number;a:number;b:number;c:number;d:number}{
  const captured=this.bones.get(boneName);
  if(captured&&captured.hasMatrix){
   return {x:captured.x,y:captured.y,a:captured.a,b:captured.b,c:captured.c,d:captured.d};
  }
  if(!this.inspection)return {x:captured?.x??0,y:captured?.y??0,a:1,b:0,c:0,d:1};
  const chain:string[]=[];
  let curr:string|undefined=boneName;
  const visited=new Set<string>();
  while(curr&&!visited.has(curr)){
   visited.add(curr);
   chain.unshift(curr);
   const b=this.inspection.bones.find(x=>x.name===curr);
   curr=b?.parent;
  }
  let wa=1,wb=0,wc=0,wd=1,wx=0,wy=0;
  for(const name of chain){
   const locals=evaluateBoneLocals(this.inspection,name,this.at);
   const rx=(locals.rotation+locals.shearX)*(Math.PI/180);
   const ry=(locals.rotation+90+locals.shearY)*(Math.PI/180);
   const la=Math.cos(rx)*locals.scaleX;
   const lb=Math.cos(ry)*locals.scaleY;
   const lc=Math.sin(rx)*locals.scaleX;
   const ld=Math.sin(ry)*locals.scaleY;
   const nx=wa*locals.x+wb*locals.y+wx;
   const ny=wc*locals.x+wd*locals.y+wy;
   const na=wa*la+wb*lc;
   const nb=wa*lb+wb*ld;
   const nc=wc*la+wd*lc;
   const nd=wc*lb+wd*ld;
   wx=nx;wy=ny;wa=na;wb=nb;wc=nc;wd=nd;
  }
  return {x:wx,y:wy,a:wa,b:wb,c:wc,d:wd};
 }

 private clientToWorld(clientX:number,clientY:number):{x:number;y:number}{
  const pickRect=this.picks.getBoundingClientRect();
  const rect=pickRect.width>0?pickRect:this.options.stage.getBoundingClientRect();
  const p0=this.options.project(0,0);
  const px=this.options.project(1,0);
  const py=this.options.project(0,1);
  const sx=px.x-p0.x||1;
  const sy=py.y-p0.y||1;
  return {
   x:(clientX-rect.left-p0.x)/sx,
   y:(clientY-rect.top-p0.y)/sy,
  };
 }

 /**
  * Pose `boneName` on stage in `mode` ('rotate' or 'translate') at viewport client coordinates
  * `(clientX, clientY)`. When the playhead sits on an existing key (within 5e-4 s), sets that key's
  * value; otherwise inserts a key at the playhead (`this.at`) and sets it as one undo group.
  */
 poseBoneOnStage(
  boneName:string,
  mode:'rotate'|'translate',
  clientX:number,
  clientY:number,
  gesture?:{
   undoGroupId:number;
   originWorld:{x:number;y:number};
   parentWorld:{x:number;y:number;a:number;b:number;c:number;d:number};
  },
 ):{ok:true;ops:readonly AnimationSourceOp[]}|{ok:false;error:string}{
  const gate=this.gateInfo();
  if(!gate.editable){
   const err=`${gate.code}: ${gate.reason??'animation is read-only'}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  if(!this.builder||!this.source?.available||!this.inspection){
   const err='ANIMATION_SOURCE_MISSING: animation source is not loaded';
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  const setup=this.inspection.bones.find(b=>b.name===boneName);
  if(!setup){
   const err=`ANIMATION_BONE_NO_TRACK: unknown bone "${boneName}"`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  const clss=this.tracksInfo();
  const boneTracks=clss.filter(c=>c.targetKind==='bone'&&c.target===boneName);
  const matchingProps=mode==='rotate'?['rotate']:['translate','translatex','translatey'];
  const matchingTracks=boneTracks.filter(c=>matchingProps.includes(c.property));
  const readonlyMatch=matchingTracks.find(c=>!c.editable);
  if(readonlyMatch){
   const err=`ANIMATION_TRACK_READ_ONLY: ${readonlyMatch.reason}`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }
  // Also check if compiled inspection has a bone track for this property that is missing from source
  const editableMatches=matchingTracks.filter(c=>c.editable);
  if(editableMatches.length===0){
   const constraint=findBoneConstraint(this.document,boneName);
   if(constraint){
    const err=`ANIMATION_BONE_CONSTRAINED: bone "${boneName}" is driven by ${constraint.kind} constraint "${constraint.name}" and cannot be posed directly on stage`;
    this.setEditorStatus(err,true);
    return {ok:false,error:err};
   }
   const compiledOnly=this.inspection.tracks.find(
    t=>t.kind==='bone'&&t.target===boneName&&matchingProps.includes(t.name),
   );
   if(compiledOnly){
    const err=`ANIMATION_TRACK_READ_ONLY: bone track "${boneName}.${compiledOnly.name}" is not an editable source track in ${this.source.path??'animations_from'}`;
    this.setEditorStatus(err,true);
    return {ok:false,error:err};
   }
   const err=`ANIMATION_BONE_NO_TRACK: bone "${boneName}" has no editable "${mode}" track in animation "${this.animation}" (${this.source.path??'animations_from'})`;
   this.setEditorStatus(err,true);
   return {ok:false,error:err};
  }

  const worldPt=this.clientToWorld(clientX,clientY);
  const parentWorld=
   gesture?.parentWorld??
   (setup.parent?this.boneWorldMatrix(setup.parent):{x:0,y:0,a:1,b:0,c:0,d:1});
  const originWorld=gesture?.originWorld??this.boneWorldMatrix(boneName);
  const det=parentWorld.a*parentWorld.d-parentWorld.b*parentWorld.c;

  let targetOps:Array<{trackIndex:number;property:string;channel?:number;value:number|readonly number[]}>=[];

  if(mode==='rotate'){
   const rotTrack=editableMatches.find(c=>c.property==='rotate')!;
   const vx=worldPt.x-originWorld.x;
   const vy=worldPt.y-originWorld.y;
   if(Math.hypot(vx,vy)<1e-6){
    return {ok:true,ops:this.builder.ops};
   }
   const lvx=Math.abs(det)>1e-8?(parentWorld.d*vx-parentWorld.b*vy)/det:vx;
   const lvy=Math.abs(det)>1e-8?(-parentWorld.c*vx+parentWorld.a*vy)/det:vy;
   const angleDeg=Math.atan2(lvy,lvx)*(180/Math.PI);
   const rawDelta=angleDeg-(setup.rotation??0);
   const wrapped=((((rawDelta+180)%360)+360)%360)-180;
   const rotVal=cleanMotionNumber(wrapped);
   targetOps=[{trackIndex:rotTrack.trackIndex,property:'rotate',value:[rotVal]}];
  }else{
   const dx=worldPt.x-parentWorld.x;
   const dy=worldPt.y-parentWorld.y;
   const localX=Math.abs(det)>1e-8?(parentWorld.d*dx-parentWorld.b*dy)/det:dx;
   const localY=Math.abs(det)>1e-8?(-parentWorld.c*dx+parentWorld.a*dy)/det:dy;
   const trackValX=cleanMotionNumber(localX-(setup.x??0));
   const trackValY=cleanMotionNumber(localY-(setup.y??0));
   const tr2d=editableMatches.find(c=>c.property==='translate');
   if(tr2d){
    targetOps=[{trackIndex:tr2d.trackIndex,property:'translate',value:[trackValX,trackValY]}];
   }else{
    const trx=editableMatches.find(c=>c.property==='translatex');
    const tryTrack=editableMatches.find(c=>c.property==='translatey');
    if(trx)targetOps.push({trackIndex:trx.trackIndex,property:'translatex',value:[trackValX]});
    if(tryTrack)targetOps.push({trackIndex:tryTrack.trackIndex,property:'translatey',value:[trackValY]});
   }
  }

  const groupId=gesture?.undoGroupId??this.builder.beginUndoGroup();
  const savedText=this.builder.text;
  try{
   this.options.pause?.();
   if(gesture){
    this.builder.unwindUndoGroup(groupId);
   }
   let keyCountChanged=false;
   const playheadTime=cleanMotionNumber(this.at);
   this.builder.withUndoGroup(groupId,()=>{
    for(const item of targetOps){
     const beforeKeys=this.readDraftTrackKeys(item.trackIndex);
     const existingIdx=beforeKeys.findIndex(k=>Math.abs(k.t-playheadTime)<=5e-4);
     const arrVal=Array.isArray(item.value)?item.value:[item.value as number];
     if(existingIdx>=0){
      this.builder!.apply({
       op:'set_key_value',
       animation:this.animation,
       track:item.trackIndex,
       key:existingIdx,
       value:arrVal,
      });
      const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===boneName&&t.name===item.property);
      const sel={animation:this.animation,trackIndex:item.trackIndex,keyIndex:existingIdx,pointer:inspTrack?.pointer??''};
      this.selectedKey=sel;
      this.selectedKeys=[sel];
     }else{
      this.builder!.apply({
       op:'insert_key',
       animation:this.animation,
       track:item.trackIndex,
       time:playheadTime,
       value:arrVal,
      });
      const afterKeys=this.readDraftTrackKeys(item.trackIndex);
      const newIdx=afterKeys.findIndex(k=>Math.abs(k.t-playheadTime)<=5e-4);
      const inspTrack=this.inspection?.tracks.find(t=>t.kind==='bone'&&t.target===boneName&&t.name===item.property);
      if(newIdx>=0){
       const sel={animation:this.animation,trackIndex:item.trackIndex,keyIndex:newIdx,pointer:inspTrack?.pointer??''};
       this.selectedKey=sel;
       this.selectedKeys=[sel];
      }
      const domLaneKeys=this.options.host.querySelectorAll(`.animation-key[data-source-track="${item.trackIndex}"]`).length;
      if(domLaneKeys!==afterKeys.length)keyCountChanged=true;
     }
    }
   });
   this.syncEffectiveInspection(true);
   this.renderEditorBar();
   if(keyCountChanged){
    this.renderTimeline();
   }else{
    this.syncTimelineKeysInPlace();
    this.syncKeyInspectorInPlace();
   }
   this.renderChannels();
   this.setEditorStatus(
    `Posed bone "${boneName}" (${mode}) at ${formatSeconds(playheadTime)} s (${this.builder.ops.length} pending op(s), preview active).`,
    false,
   );
   return {ok:true,ops:this.builder.ops};
  }catch(e){
   if(this.builder.text!==savedText&&gesture){
    this.builder.unwindUndoGroup(groupId);
   }
   const msg=e instanceof Error?e.message:String(e);
   this.setEditorStatus(msg,true);
   return {ok:false,error:msg};
  }
 }

 private bindStageBoneDrag(btn:HTMLButtonElement,boneName:string){
  btn.addEventListener('pointerdown',e=>{
   if(!e.isPrimary||e.button!==0||this.isBusy||this.space)return;
   e.stopPropagation();
   const mode:'rotate'|'translate'=e.altKey?(this.poseMode==='rotate'?'translate':'rotate'):this.poseMode;
   const targetBone=this.resolveBoneForStageDrag(boneName,mode);
   const setup=this.inspection?.bones.find(b=>b.name===targetBone);
   const originWorld=this.boneWorldMatrix(targetBone);
   const parentWorld=setup?.parent?this.boneWorldMatrix(setup.parent):{x:0,y:0,a:1,b:0,c:0,d:1};
   const undoGroupId=this.builder?this.builder.beginUndoGroup():1;
   this.draggingStageBone={
    pointerId:e.pointerId,
    boneName:targetBone,
    mode,
    startX:e.clientX,
    startY:e.clientY,
    moved:false,
    undoGroupId,
    originWorld:{x:originWorld.x,y:originWorld.y},
    parentWorld,
   };
   btn.setPointerCapture?.(e.pointerId);
  });

  btn.addEventListener('pointermove',e=>{
   const drag=this.draggingStageBone;
   if(!drag||drag.pointerId!==e.pointerId)return;
   if(!drag.moved&&Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)<2)return;
   if(!drag.moved){
    drag.moved=true;
    this.suppressNextBoneClick=true;
    this.select({kind:'bone',name:drag.boneName});
   }
   const activeMode:'rotate'|'translate'=e.altKey?(this.poseMode==='rotate'?'translate':'rotate'):drag.mode;
   this.poseBoneOnStage(drag.boneName,activeMode,e.clientX,e.clientY,{
    undoGroupId:drag.undoGroupId,
    originWorld:drag.originWorld,
    parentWorld:drag.parentWorld,
   });
  });

  const endBoneDrag=(e:PointerEvent)=>{
   const drag=this.draggingStageBone;
   if(!drag||drag.pointerId!==e.pointerId)return;
   this.draggingStageBone=null;
   if(btn.hasPointerCapture?.(e.pointerId))btn.releasePointerCapture(e.pointerId);
   if(drag.moved){
    e.preventDefault();
    setTimeout(()=>{this.suppressNextBoneClick=false;},0);
   }
  };
  btn.addEventListener('pointerup',endBoneDrag);
  btn.addEventListener('pointercancel',endBoneDrag);
 }

 capture(player:Pick<RigPlayer,'bone'>|null,frame:PosedFrame|undefined){
  this.frame=frame??null;this.bones.clear();
  for(const b of player&&frame?this.inspection?.bones??[]:[]){
   try{
    const p=player!.bone(b.name) as {x:number;y:number;active:boolean;a?:number;b?:number;c?:number;d?:number};
    if(p.active){
     const hasMatrix=typeof p.a==='number'&&typeof p.b==='number'&&typeof p.c==='number'&&typeof p.d==='number';
     this.bones.set(b.name,{
      x:p.x,
      y:p.y,
      a:hasMatrix?p.a!:1,
      b:hasMatrix?p.b!:0,
      c:hasMatrix?p.c!:0,
      d:hasMatrix?p.d!:1,
      hasMatrix,
     });
    }
   }catch{/* unavailable bones have no stage handle */}
  }
  this.redraw();
 }

 redraw(bonePoints=this.bonePoints){
  this.bonePoints=bonePoints;
  for(const [name,node]of this.boneButtons)if(!this.bones.has(name)){node.remove();this.boneButtons.delete(name);}
  const {stage}=this.options,selected=this.selection.value();
  stage.dataset.heldFrame=this.frame?'available':'unavailable';
  stage.dataset.selectedKind=selected?.kind??'';
  stage.dataset.selectedName=selected?.name??'';
  const enabled=this.options.enabled();
  this.picks.hidden=!enabled;
  const otherMode:'rotate'|'translate'=this.poseMode==='rotate'?'translate':'rotate';
  let order=0;
  for(const [name,p]of this.bones){
   let b=this.boneButtons.get(name);
   if(!b){
    b=button('',()=>{
     if(this.suppressNextBoneClick){
      this.suppressNextBoneClick=false;
      return;
     }
     const targetName=this.resolveBoneForStageClick(name);
     this.select({kind:'bone',name:targetName});
    });
    b.className='animation-bone-pick';
    b.title=`Select or drag bone ${name}`;
    b.setAttribute('aria-label',`Select bone ${name}`);
    b.dataset.bone=name;
    this.bindStageBoneDrag(b,name);
    this.boneButtons.set(name,b);
    this.picks.append(b);
   }
   const isSelected=selected?.kind==='bone'&&selected.name===name;
   const visible=enabled&&(bonePoints||isSelected);
   b.hidden=!bonePoints&&!isSelected;
   b.setAttribute('aria-pressed',String(isSelected));
   if(!visible){
    order++;
    continue;
   }
   const editableNow=this.isBoneEditableInMode(name,this.poseMode);
   const editableOther=this.isBoneEditableInMode(name,otherMode);
   b.dataset.poseEditable=editableNow?'true':editableOther?'other':'false';
   const zRank=isSelected&&editableNow
    ?500
    :editableNow
    ?400-Math.min(90,this.firstEditableTrackIndexForBone(name,this.poseMode))
    :isSelected||editableOther
    ?200+order
    :100+order;
   order++;
   b.style.zIndex=String(zRank);
   const at=this.options.project(p.x,p.y);
   b.style.left=`${at.x}px`;
   b.style.top=`${at.y}px`;
  }
 }

 dispose(){for(const dispose of this.disposers)dispose();this.picks.remove();}
}
