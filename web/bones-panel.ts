/**
 * Setup · Bones (#109), page side: the producer config's bones drawn on the stage at their `at`, chain `points` and
 * `tip` (rig px through the crop → world mapping the chest and weights views use), draggable in whole rig px; per-anchor
 * x / y fields for the picked bone; the pending-ops list with per-op revert; Check (`POST /api/bones-check`:
 * `propose --from-config` LINT and coverage lines, and `compare`'s origin distances against the handoff config); Apply
 * (the generic patch runner's whole-rig `rig --config` → check, which needs the reproduced baseline) and Reset. The
 * source draft keeps the pending ops (`#bones-pending`); the generated fields carry no ids.
 */
import {anchorAt,boneAnchors,boneOps,bonesApplyEnabled,configBones,dragAnchor,draftEdits,draftText,movedRows,setAnchor,type BoneAnchor,type BoneEdit,type ConfigBone,type RigPoint} from '../src/bone-anchors.ts';
import type {PatchOp} from '../src/config-patch.ts';
import type {CropWorldMapping} from '../src/chest-regions.ts';
import type {BonesCheckResult} from '../src/bones-check.ts';
import {canvasToCrop} from './chest-editor.ts';
import type {OverlayAnchors,OverlayPoint,OverlayProject} from './rig-overlays.ts';
import {textEntryFocused} from './view-controls.ts';

export type BonesCheckView=BonesCheckResult|{status:'refused';error:string};
export interface BonesPanelDeps {
 /** Receives capture-phase pointer events before the viewport's pan. */
 pane:HTMLElement;
 /** The overlay canvas: pointer coordinates are local to it, as the projection's are. */
 canvas:HTMLElement;
 project:()=>OverlayProject|null;
 mapping:()=>CropWorldMapping;
 inspector:()=>string|undefined;
 /** Playback stops while bones are edited on the stage. */
 pause:()=>void;
 /** Redraw the overlay. */
 changed:()=>void;
 /** The draft record changed (the panel already wrote `#bones-pending`). */
 saved:()=>void;
 check:(ops:PatchOp[])=>Promise<BonesCheckView>;
 apply:(ops:PatchOp[])=>Promise<void>;
 reset:()=>Promise<void>;
 token:(name:string)=>string;
}
export interface BonesPanel {
 load(list:unknown[]|null,reason:string|null):void;
 anchors():BoneAnchor[];edits():BoneEdit[];
 set(path:string,value:RigPoint):void;
 select(name:string|null):void;
 active():boolean;setActive(on:boolean):void;
 /** Every drawn anchor's client (viewport) position, for automation that drags with a real pointer. */
 handles():{path:string;label:string;x:number;y:number}[];
 overlay():OverlayAnchors|null;
 check():Promise<BonesCheckView|null>;
 checked(view:BonesCheckView|null):void;
 applied(ops:readonly PatchOp[]|null):void;
 status(text:string,error:boolean):void;
 busy(value:boolean):void;
 restore():void;clear():void;sync():void;dispose():void;
}
/** Overlay colours: theme token names. */
export const boneTokens={line:'--rv-bone-line',origin:'--rv-bone-origin',point:'--rv-bone-point',tip:'--rv-bone-tip',pending:'--rv-bone-pending',selected:'--rv-bone-selected',ink:'--rv-bone-ink',labelBg:'--rv-bone-label-bg'} as const;
/** The anchor under the pointer (canvas px), within 9 px; the nearest wins. */
export function hitAnchor(points:readonly {path:string;at:OverlayPoint}[],p:OverlayPoint):string|null {
 let best:string|null=null,distance=9;
 for(const a of points){const d=Math.hypot(a.at.x-p.x,a.at.y-p.y);if(d<=distance){best=a.path;distance=d;}}
 return best;
}
/** The lines the overlay draws: each chain point to the next and to its tip; a single bone's origin to its tip. */
export function anchorLines(bones:readonly ConfigBone[],at:(path:string)=>RigPoint|null):{from:RigPoint;to:RigPoint}[] {
 const out:{from:RigPoint;to:RigPoint}[]=[];
 for(const b of bones){
  const base=`/bones/${b.index}`,chain=[...(b.at?[`${base}/at`]:[]),...b.points.map((_,k)=>`${base}/points/${k}`),...(b.tip?[`${base}/tip`]:[])].map(at).filter((p):p is RigPoint=>!!p);
  for(let i=1;i<chain.length;i++)out.push({from:chain[i-1]!,to:chain[i]!});
 }
 return out;
}
const fmt=(p:RigPoint)=>`[${p[0]}, ${p[1]}]`;
const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};

export function bindBonesPanel(deps:BonesPanelDeps):BonesPanel {
 const state=node('bones-panel-state'),toggle=node<HTMLButtonElement>('bones-edit'),picker=node<HTMLSelectElement>('bones-select'),editor=node('bones-anchor-editor'),pending=node('bones-pending-list');
 const checkButton=node<HTMLButtonElement>('bones-check'),applyButton=node<HTMLButtonElement>('bones-apply'),resetButton=node<HTMLButtonElement>('bones-reset-build'),statusOut=node('bones-status'),lintArea=node('bones-lint'),compareArea=node('bones-compare'),draft=node<HTMLTextAreaElement>('bones-pending');
 let bones:ConfigBone[]=[],anchors:BoneAnchor[]=[],edits=new Map<string,BoneEdit>(),selected:string|null=null,hover:string|null=null,appliedOps:string[]=[],lint:string[]=[],busy=false,active=false,space=false;
 let drag:{path:string;pointer:number;start:RigPoint;from:RigPoint}|null=null;

 function panelStatus(text:string,error:boolean){statusOut.textContent=text;statusOut.title=text;statusOut.classList.toggle('error',error);}
 const save=()=>{draft.value=draftText(edits);draft.dispatchEvent(new Event('input',{bubbles:true}));deps.saved();};
 /** Any change to the pending ops makes the last Check's lines stale, so they are cleared. */
 const change=(next:Map<string,BoneEdit>,persist=true)=>{edits=next;showCheck(null);if(persist)save();render();deps.changed();};
 const anchorOf=(path:string)=>anchors.find(a=>a.path===path);
 /** Each anchor in canvas px, from its current value through the crop → world mapping and the camera projection. */
 const projected=():{path:string;at:OverlayPoint}[]=>{
  const project=deps.project(),mapping=deps.mapping();if(!project||!mapping.available)return [];
  return anchors.map(a=>{const [x,y]=anchorAt(a,edits),w=mapping.toWorld(x,y);return {path:a.path,at:project(w.x,w.y)};});
 };
 const local=(event:PointerEvent):OverlayPoint=>{const rect=deps.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const cropAt=(p:OverlayPoint):RigPoint|null=>{const project=deps.project(),mapping=deps.mapping();return project&&mapping.available?canvasToCrop(project,mapping.toWorld,p):null;};

 function renderPicker(){
  const keep=picker.value;
  picker.replaceChildren(make('option',{value:'',textContent:bones.length?'Pick a bone (or click a handle)':'No bones in the config'}),...bones.map(b=>make('option',{value:b.name,textContent:`${b.name}${b.chain?` (chain, ${b.points.length} link${b.points.length===1?'':'s'})`:''} · bones[${b.index}]`})));
  picker.value=selected&&bones.some(b=>b.name===selected)?selected:bones.some(b=>b.name===keep)?keep:'';
  picker.disabled=busy||!bones.length;
 }
 function renderEditor(){
  const bone=bones.find(b=>b.name===selected);
  if(!bone){editor.replaceChildren(make('p',{className:'hint',textContent:'Pick a bone to edit its anchors by number, or drag a handle on the stage.'}));return;}
  const rows=anchors.filter(a=>a.index===bone.index).map(a=>{
   const now=anchorAt(a,edits),field=(axis:0|1)=>{const input=make('input',{type:'number',step:'1',value:String(now[axis]),disabled:busy,inputMode:'numeric'});input.setAttribute('aria-label',`${a.label} ${axis?'y':'x'}`);
    input.onchange=()=>{const value=Number(input.value);if(!input.value.trim()||!Number.isFinite(value)){panelStatus(`BONES_VALUE_INVALID: ${a.label} ${axis?'y':'x'} must be a number`,true);return;}const next:RigPoint=[...anchorAt(a,edits)];next[axis]=value;change(setAnchor(edits,a,next));};return input;};
   return make('div',{className:edits.has(a.path)?'bones-anchor pending':'bones-anchor'},make('code',{textContent:a.path}),make('span',{textContent:a.label}),field(0),field(1),make('output',{textContent:edits.has(a.path)?`was ${fmt(a.value)}`:''}));
  });
  editor.replaceChildren(make('p',{className:'physics-editor-title'},make('strong',{textContent:bone.name}),` · ${bone.chain?'chain':'bone'} · parent ${bone.parent??'—'} · bones[${bone.index}]`),...rows);
 }
 function renderPending(){
  const items=[...edits.values()];
  pending.replaceChildren(...items.map(e=>{
   const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.setAttribute('aria-label',`Revert ${e.path}`);
   revert.onclick=()=>{const next=new Map(edits);next.delete(e.path);change(next);};
   const applied=appliedOps.includes(JSON.stringify({path:e.path,value:e.value}));
   const delta=`Δ (${e.value[0]-e.from[0]>=0?'+':''}${Number((e.value[0]-e.from[0]).toFixed(6))}, ${e.value[1]-e.from[1]>=0?'+':''}${Number((e.value[1]-e.from[1]).toFixed(6))})`;
   return make('li',{className:applied?'applied':''},make('code',{textContent:`replace ${e.path}`}),` ${fmt(e.from)} → ${fmt(e.value)} ${delta} · ${e.name}${applied?' · applied':''}`,revert);
  }));
  if(!items.length)pending.append(make('li',{className:'hint',textContent:'No pending ops.'}));
  applyButton.disabled=!bonesApplyEnabled({busy,pending:items.length,lint});checkButton.disabled=busy||!items.length;resetButton.disabled=busy;
  toggle.disabled=!anchors.length;toggle.setAttribute('aria-pressed',String(active));
 }
 function render(){renderPicker();renderEditor();renderPending();}
 let skipped:string[]=[],loaded=false;
 /** The block's state line: the config's bones and anchors, what was not read, and whether handles can be drawn. */
 function renderState(){
  if(!loaded)return;const mapping=deps.mapping();
  state.classList.toggle('error',!mapping.available||!!skipped.length);
  state.textContent=`${bones.length} config bones · ${anchors.length} anchors (origins, chain points, tips) in rig px${skipped.length?` · not drawn: ${skipped.join('; ')}`:''}${mapping.available?'':` · ${mapping.reason}: no handles are drawn`}`;
 }

 function showCheck(view:BonesCheckView|null){
  lint=[];
  if(!view){lintArea.replaceChildren();compareArea.replaceChildren();return;}
  if(view.status==='refused'){lintArea.replaceChildren(make('code',{className:'error',textContent:view.error,title:view.error}));compareArea.replaceChildren();return;}
  const p=view.propose;lint=[...p.lint];
  const head=make('p',{className:'eyebrow',textContent:`PROPOSE --FROM-CONFIG${p.exitCode===null?'':` · EXIT ${p.exitCode}`} · LINT BLOCKS NOTHING`});
  const lines=[...p.lint.map(text=>make('code',{className:'lint',textContent:text,title:text})),make('code',{className:p.status==='ran'&&p.line===p.summary?'':'error',textContent:p.line,title:p.line})];
  const coverage=p.coverage.length?[make('details',{className:'bones-coverage'},make('summary',{textContent:p.coverage.at(-1)!}),...p.coverage.slice(0,-1).map(text=>make('code',{textContent:text,title:text})))]:[];
  lintArea.replaceChildren(head,...lines,...coverage);
  const c=view.compare,moved=movedRows(c.origins);
  compareArea.replaceChildren(make('p',{className:'eyebrow',textContent:'COMPARE --LEFT <HANDOFF CONFIG> --RIGHT <PATCHED>'}),
   ...(c.exitCode===0?[...moved.map(r=>make('code',{textContent:r.text,title:r.text})),...(moved.length?[]:[make('code',{textContent:'no bone moved'})]),...c.summary.filter(l=>/^(origin|tip):/.test(l)).map(text=>make('code',{textContent:text,title:text}))]:[make('code',{className:'error',textContent:c.line,title:c.line})]));
  renderPending();
 }

 const setActive=(on:boolean)=>{
  active=on&&anchors.length>0;if(active)deps.pause();
  if(!active){drag=null;hover=null;delete deps.pane.dataset.bonesHover;}
  render();deps.changed();
 };
 toggle.onclick=()=>setActive(!active);
 picker.onchange=()=>{selected=picker.value||null;render();deps.changed();};
 checkButton.onclick=()=>{void panel.check();};
 applyButton.onclick=()=>{if(!edits.size||busy)return;void deps.apply(boneOps(edits));};
 resetButton.onclick=()=>{if(busy)return;void deps.reset();};
 const keyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&!textEntryFocused(event.target))space=true;};
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')space=false;};
 const blur=()=>{space=false;};
 const down=(event:PointerEvent)=>{
  if(!active||busy||space||!event.isPrimary||event.button!==0)return;
  const target=event.target;if(target instanceof Element&&target.closest('button,input,select,textarea,a'))return;
  const p=local(event),path=hitAnchor(projected(),p),anchor=path?anchorOf(path):undefined,start=cropAt(p);if(!anchor||!start)return;
  // A handle drag edits values; it never reaches the viewport's pan.
  event.stopPropagation();event.preventDefault();
  drag={path:anchor.path,pointer:event.pointerId,start,from:anchorAt(anchor,edits)};selected=anchor.name;
  deps.pane.setPointerCapture(event.pointerId);deps.pane.dataset.bonesHover='move';render();deps.changed();
 };
 const move=(event:PointerEvent)=>{
  if(drag&&event.pointerId===drag.pointer){
   event.stopPropagation();const now=cropAt(local(event)),anchor=anchorOf(drag.path);if(!now||!anchor)return;
   const next=dragAnchor(drag.from,drag.start,now),current=anchorAt(anchor,edits);
   if(next[0]!==current[0]||next[1]!==current[1])change(setAnchor(edits,anchor,next),false);
   return;
  }
  if(!active||space)return;
  const path=hitAnchor(projected(),local(event));if(path!==hover){hover=path;if(path)deps.pane.dataset.bonesHover='move';else delete deps.pane.dataset.bonesHover;deps.changed();}
 };
 const end=(event:PointerEvent)=>{
  if(!drag||event.pointerId!==drag.pointer)return;
  drag=null;delete deps.pane.dataset.bonesHover;if(deps.pane.hasPointerCapture(event.pointerId))deps.pane.releasePointerCapture(event.pointerId);
  save();render();deps.changed();
 };
 deps.pane.addEventListener('pointerdown',down,true);deps.pane.addEventListener('pointermove',move,true);
 for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)deps.pane.addEventListener(type,end,true);
 document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);window.addEventListener('blur',blur);
 // Leaving Setup ends the stage mode: follow the header switch's pressed state, as the chest editor does.
 const observer=new MutationObserver(()=>panel.sync());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});

 const panel:BonesPanel={
  load(list,reason){
   if(list===null){bones=[];anchors=[];skipped=[];loaded=false;state.textContent=reason??'BONES_UNAVAILABLE: no producer handoff';state.classList.add('error');setActive(false);render();return;}
   const read=configBones(list);bones=read.bones;anchors=boneAnchors(bones);skipped=read.skipped;loaded=true;
   edits=draftEdits(draft.value,anchors);renderState();render();deps.changed();
  },
  anchors:()=>anchors.map(a=>({...a,value:[...a.value] as RigPoint})),
  edits:()=>[...edits.values()].map(e=>({...e,from:[...e.from] as RigPoint,value:[...e.value] as RigPoint})),
  set(path,value){const anchor=anchorOf(path);if(!anchor)throw new Error(`BONES_ANCHOR_UNKNOWN: ${path}`);change(setAnchor(edits,anchor,value));},
  select(name){selected=name;render();deps.changed();},
  active:()=>active,setActive,
  handles(){const rect=deps.canvas.getBoundingClientRect();return projected().map(h=>({path:h.path,label:anchorOf(h.path)!.label,x:h.at.x+rect.left,y:h.at.y+rect.top}));},
  overlay(){
   if(!active||!anchors.length)return null;const mapping=deps.mapping();if(!mapping.available)return null;
   const world=([x,y]:RigPoint)=>mapping.toWorld(x,y),current=new Map(anchors.map(a=>[a.path,anchorAt(a,edits)]));
   const colors=Object.fromEntries(Object.entries(boneTokens).map(([k,t])=>[k,deps.token(t)])) as OverlayAnchors['colors'];
   const focus=selected?bones.find(b=>b.name===selected)?.index:undefined;
   return {lines:anchorLines(bones,path=>current.get(path)??null).map(l=>({from:world(l.from),to:world(l.to)})),
    anchors:anchors.map(a=>({at:world(current.get(a.path)!),from:edits.has(a.path)?world(a.value):null,kind:a.kind,label:`${a.label} ${fmt(current.get(a.path)!)}`,selected:drag?.path===a.path||(focus===a.index&&a.kind==='at'),hover:hover===a.path})),colors};
  },
  async check(){
   if(!edits.size||busy){panelStatus('BONES_NOTHING_PENDING: no pending ops',true);return null;}
   busy=true;render();panelStatus(`Checking ${edits.size} op(s): propose --from-config and compare on a scratch copy of the patched config…`,false);
   try{const view=await deps.check(boneOps(edits));showCheck(view);
    if(view.status==='refused')panelStatus(view.error,true);
    else{const p=view.propose,o=view.compare;panelStatus(`Checked · ${p.status==='ran'?`${p.lint.length} LINT line(s) (blocks nothing)`:'LINT not run'} · compare ${o.line} · ${(((p.wallMs??0)+o.wallMs)/1000).toFixed(1)} s`,p.status!=='ran');}
    return view;}
   finally{busy=false;render();}
  },
  checked:showCheck,
  applied(ops){appliedOps=(ops??[]).map(o=>JSON.stringify({path:o.path,value:o.value}));renderPending();},
  status:panelStatus,
  busy(value){busy=value;render();},
  restore(){edits=draftEdits(draft.value,anchors);render();deps.changed();},
  clear(){change(new Map());showCheck(null);},
  sync(){renderState();if(active&&deps.inspector()!=='rig')setActive(false);},
  dispose(){observer.disconnect();deps.pane.removeEventListener('pointerdown',down,true);deps.pane.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)deps.pane.removeEventListener(type,end,true);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);window.removeEventListener('blur',blur);},
 };
 render();
 return panel;
}
