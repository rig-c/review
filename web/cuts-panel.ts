/**
 * Setup · Cuts (#115), page side: the producer config's `assemble.cuts` polygons, `assemble.patches` boxes and each limb
 * joint with its `range` arc, drawn on the stage in rig px of the setup pose (the crop → world mapping the chest, mesh
 * and bones views use) and edited there: drag a cut vertex or a box corner, drag a joint (its lower bone's origin — a
 * `bones` op, since the joint is the bone's origin), type a range; place a new cut polygon or a new patch box by
 * clicking. Every edit is a config patch op (`src/cut-edits.ts`); Apply sends them as one `rig` patch, which the server
 * runs as `rig-parts build` (assemble → rig → check) from the handoff's painting and runs, and the scratch build reloads
 * in place. The producer's refusals (`ASSEMBLE_CUT_*`, `ASSEMBLE_UNDER_*`, `CONFIG_LIMB_*`, `CONFIG_PART_UNIQUE`, …) come
 * back verbatim; `LIMB_ONE_BONE` and `SEAM_OVER_RANGE` are check's bars, read from the build's check. Review paints no
 * `under` or `cap` image: a new cut names none. The draft keeps the pending edits (`#cuts-pending`).
 */
import {anchorAt,boneAnchors,configBones,setAnchor,type BoneAnchor,type BoneEdit} from '../src/bone-anchors.ts';
import type {PatchOp} from '../src/config-patch.ts';
import type {CropWorldMapping} from '../src/chest-regions.ts';
import {
 boxAt,CutEditError,cutOps,cutsDraft,cutsDraftText,cutsSource,dragPoint,rangeArc,rangeAt,setBox,setRange,setVertex,vertexAt,
 type CutAdd,type CutDraw,type CutEdit,type CutsSource,type PatchBox,type RigPoint,
} from '../src/cut-edits.ts';
import {canvasToCrop} from './chest-editor.ts';
import type {OverlayMarker,OverlayPoint,OverlayProject,OverlayRegion} from './rig-overlays.ts';
import {textEntryFocused} from './view-controls.ts';
import type {PatchJobView,RebuildRefusal} from './rebuild-client.ts';

export interface CutsPanelDeps {
 pane:HTMLElement;canvas:HTMLElement;
 project:()=>OverlayProject|null;mapping:()=>CropWorldMapping;inspector:()=>string|undefined;
 pause:()=>void;changed:()=>void;saved:()=>void;
 apply:(ops:PatchOp[])=>Promise<PatchJobView|RebuildRefusal|null>;
 reset:()=>Promise<void>;
 token:(name:string)=>string;
 /** The served URL of a page-relative route (the capability-bearing access route). */
 route:(path:string)=>string;
}
/** One drawn handle: a cut vertex, a patch box corner or a limb joint. */
export interface CutHandle {id:string;label:string;at:RigPoint}
export interface CutsPanel {
 load(config:unknown|null,bones:unknown[]|null,reason:string|null,build:string|null):void;
 source():CutsSource;ops():PatchOp[];
 setVertex(cut:number,k:number,value:RigPoint):void;setBox(patch:number,value:PatchBox):void;setRange(limb:string,k:number,value:[number,number]|null):void;
 active():boolean;setActive(on:boolean):void;
 handles():{id:string;label:string;x:number;y:number}[];
 overlayRegions():OverlayRegion[];overlayMarkers():OverlayMarker[];
 apply():Promise<PatchJobView|RebuildRefusal|null>;
 shown(job:PatchJobView|RebuildRefusal|null):void;
 status(text:string,error:boolean):void;busy(value:boolean):void;
 restore():void;clear():void;sync():void;dispose():void;
}
const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const fmt=(p:readonly number[])=>`[${p.join(', ')}]`;
/** The handle under the pointer (canvas px), within 9 px; the nearest wins. */
export function hitHandle(points:readonly {id:string;at:OverlayPoint}[],p:OverlayPoint):string|null {
 let best:string|null=null,distance=9;
 for(const h of points){const d=Math.hypot(h.at.x-p.x,h.at.y-p.y);if(d<=distance){best=h.id;distance=d;}}
 return best;
}
const drawText=(d:CutDraw)=>typeof d==='string'?d:`before ${d.before}`;

export function bindCutsPanel(deps:CutsPanelDeps):CutsPanel {
 const state=node('cuts-panel-state'),toggle=node<HTMLButtonElement>('cuts-edit'),picker=node<HTMLSelectElement>('cuts-select'),editor=node('cuts-editor'),pending=node('cuts-pending-list');
 const applyButton=node<HTMLButtonElement>('cuts-apply'),resetButton=node<HTMLButtonElement>('cuts-reset'),statusOut=node('cuts-status'),readout=node('cuts-readout'),draft=node<HTMLTextAreaElement>('cuts-pending');
 const addForm=node('cuts-add');
 let config:unknown=null,source:CutsSource={cuts:[],patches:[],segments:[],plan:[],skipped:[]},anchors:BoneAnchor[]=[],buildReason:string|null=null,loaded=false;
 let edits=new Map<string,CutEdit>(),joints=new Map<string,BoneEdit>(),adds:CutAdd[]=[];
 let selected='',active=false,busy=false,space=false,hover:string|null=null;
 let drag:{id:string;pointer:number;start:RigPoint;from:RigPoint}|null=null;
 let placing:{kind:'cut'|'patch';points:RigPoint[]}|null=null;

 const panelStatus=(text:string,error:boolean)=>{statusOut.textContent=text;statusOut.title=text;statusOut.classList.toggle('error',error);};
 const save=()=>{draft.value=JSON.stringify({cuts:JSON.parse(cutsDraftText(edits,adds)),joints:[...joints.values()]});draft.dispatchEvent(new Event('input',{bubbles:true}));deps.saved();};
 const jointAnchor=(bone:string)=>anchors.find(a=>a.label===bone&&(a.kind==='at'||a.kind==='point'));
 const allOps=():PatchOp[]=>[...cutOps(edits,adds,config),...[...joints.values()].map(e=>({op:'replace' as const,path:e.path,value:[...e.value],name:e.name}))];
 const guard=(fn:()=>void)=>{try{fn();}catch(error){if(error instanceof CutEditError){panelStatus(error.message,true);return;}throw error;}};
 const change=(persist=true)=>{if(persist)save();render();deps.changed();};

 /** Every handle in rig px: each cut's vertices, each patch box's two corners, each joint below a limb's upper segment. */
 function handlesRig():CutHandle[] {
  const out:CutHandle[]=[];
  for(const c of source.cuts)c.polygon.forEach((_,k)=>out.push({id:`v:${c.index}:${k}`,label:`${c.into} vertex ${k}`,at:vertexAt(edits,c,k)}));
  for(const q of source.patches){const b=boxAt(edits,q);out.push({id:`b0:${q.index}`,label:`${q.name} box min`,at:[b[0],b[1]]},{id:`b1:${q.index}`,label:`${q.name} box max`,at:[b[2],b[3]]});}
  for(const s of source.segments){if(!s.joint)continue;const a=jointAnchor(s.bone);if(a)out.push({id:`j:${a.path}`,label:`${s.limb} ${s.joint} (${s.bone} origin)`,at:anchorAt(a,joints)});}
  return out;
 }
 const projected=()=>{const project=deps.project(),mapping=deps.mapping();if(!project||!mapping.available)return [];return handlesRig().map(h=>{const w=mapping.toWorld(h.at[0],h.at[1]);return {id:h.id,at:project(w.x,w.y)};});};
 const local=(event:PointerEvent):OverlayPoint=>{const rect=deps.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const cropAt=(p:OverlayPoint):RigPoint|null=>{const project=deps.project(),mapping=deps.mapping();return project&&mapping.available?canvasToCrop(project,mapping.toWorld,p):null;};
 /** Move one handle to a rig px value. */
 function moveHandle(id:string,value:RigPoint){
  const [kind,a,b]=id.split(':');
  if(kind==='v'){const cut=source.cuts.find(c=>c.index===Number(a))!;edits=setVertex(edits,cut,Number(b),value);}
  else if(kind==='b0'||kind==='b1'){const q=source.patches.find(p=>p.index===Number(a))!,box=[...boxAt(edits,q)] as PatchBox;if(kind==='b0'){box[0]=value[0];box[1]=value[1];}else{box[2]=value[0];box[3]=value[1];}edits=setBox(edits,q,box);}
  else if(kind==='j'){const anchor=anchors.find(x=>x.path===id.slice(2))!;joints=setAnchor(joints,anchor,value);}
 }

 function renderPicker(){
  const keep=selected;
  const options=[make('option',{value:'',textContent:source.cuts.length||source.patches.length||source.segments.length?'Pick a cut, patch or limb (or drag a handle)':'The config states no cut, patch or limb'}),
   ...source.cuts.map(c=>make('option',{value:`cut:${c.index}`,textContent:`cut ${c.into} ← ${c.from} · assemble.cuts[${c.index}]`})),
   ...source.patches.map(q=>make('option',{value:`patch:${q.index}`,textContent:`patch ${q.name} · assemble.patches[${q.index}]`})),
   ...source.segments.filter(s=>s.joint).map(s=>make('option',{value:`seg:${s.limb}:${s.index}`,textContent:`limb ${s.limb} · ${s.joint} → ${s.part} (${s.bone})`}))];
  picker.replaceChildren(...options);picker.value=[...picker.options].some(o=>o.value===keep)?keep:'';picker.disabled=busy||options.length<2;
 }
 const numberInput=(label:string,value:number,set:(v:number)=>void,step='1')=>{const input=make('input',{type:'number',step,value:String(value),disabled:busy,inputMode:'numeric'});input.setAttribute('aria-label',label);input.onchange=()=>{const v=Number(input.value);if(!input.value.trim()||!Number.isFinite(v)){panelStatus(`CUTS_VALUE_INVALID: ${label} must be a number`,true);return;}guard(()=>{set(v);change();});};return input;};
 function renderEditor(){
  const [kind,a,b]=selected.split(':');
  if(kind==='cut'){const c=source.cuts.find(x=>x.index===Number(a));if(!c){editor.replaceChildren();return;}
   editor.replaceChildren(make('p',{className:'physics-editor-title'},make('strong',{textContent:c.into}),` · cut from ${c.from} · draw ${drawText(c.draw)} · overlap ${c.overlap}${c.under?` · under ${c.under} (the polygon box's size — moving the box's edge is the producer's ASSEMBLE_UNDER_SIZE)`:''}`),
    ...c.polygon.map((_,k)=>{const now=vertexAt(edits,c,k);return make('div',{className:edits.has(`/assemble/cuts/${c.index}/polygon/${k}`)?'bones-anchor pending':'bones-anchor'},make('code',{textContent:`/assemble/cuts/${c.index}/polygon/${k}`}),numberInput(`${c.into} vertex ${k} x`,now[0],v=>{edits=setVertex(edits,c,k,[v,vertexAt(edits,c,k)[1]]);}),numberInput(`${c.into} vertex ${k} y`,now[1],v=>{edits=setVertex(edits,c,k,[vertexAt(edits,c,k)[0],v]);}));}));
   return;}
  if(kind==='patch'){const q=source.patches.find(x=>x.index===Number(a));if(!q){editor.replaceChildren();return;}const box=boxAt(edits,q);
   editor.replaceChildren(make('p',{className:'physics-editor-title'},make('strong',{textContent:q.name}),` · patch · alpha ${q.alpha} · draw ${drawText(q.draw)} · box [x0, y0, x1, y1), x1 / y1 exclusive`),
    make('div',{className:'bones-anchor'},make('code',{textContent:`/assemble/patches/${q.index}/box`}),...box.map((v,i)=>numberInput(`${q.name} box ${['x0','y0','x1','y1'][i]}`,v,n=>{const next=[...boxAt(edits,q)] as PatchBox;next[i]=n;edits=setBox(edits,q,next);}))));
   return;}
  if(kind==='seg'){const s=source.segments.find(x=>x.limb===a&&x.index===Number(b));if(!s){editor.replaceChildren();return;}const range=rangeAt(edits,s),anchor=jointAnchor(s.bone);
   const none=make('input',{type:'checkbox',checked:!range,disabled:busy});none.setAttribute('aria-label',`${s.part} no range`);none.onchange=()=>guard(()=>{edits=setRange(edits,s,none.checked?null:rangeAt(edits,s)??[-30,30]);change();});
   editor.replaceChildren(make('p',{className:'physics-editor-title'},make('strong',{textContent:`${s.limb} · ${s.joint}`}),` · ${s.part} on ${s.bone}, cut from ${s.from} · range is degrees from rest, min ≤ 0 ≤ max (check poses the joint there: SEAM_OVER_RANGE)`),
    make('div',{className:'bones-anchor'},make('code',{textContent:`/limbs/${s.limb}/segments/${s.index}/range`}),...(range?[numberInput(`${s.part} range min`,range[0],v=>{edits=setRange(edits,s,[v,rangeAt(edits,s)![1]]);},'any'),numberInput(`${s.part} range max`,range[1],v=>{edits=setRange(edits,s,[rangeAt(edits,s)![0],v]);},'any')]:[]),make('label',{},none,' no range')),
    ...(anchor?[make('div',{className:joints.has(anchor.path)?'bones-anchor pending':'bones-anchor'},make('code',{textContent:anchor.path}),make('span',{textContent:`joint = ${s.bone} origin`}),...[0,1].map(i=>numberInput(`${s.joint} ${i?'y':'x'}`,anchorAt(anchor,joints)[i]!,v=>{const p=[...anchorAt(anchor,joints)] as RigPoint;p[i]=v;joints=setAnchor(joints,anchor,p);})))]:[make('p',{className:'hint',textContent:`${s.bone}'s origin is not a config bone anchor; the joint is not drawn`})]));
   return;}
  editor.replaceChildren(make('p',{className:'hint',textContent:'Pick a cut, a patch or a limb joint to edit it by number, or drag a handle on the stage.'}));
 }
 function renderPending(){
  const items:HTMLElement[]=[];
  for(const e of edits.values()){const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.onclick=()=>{edits.delete(e.path);change();};
   items.push(make('li',{},make('code',{textContent:`${e.kind==='range'&&e.value===null?'remove':e.kind==='range'&&e.from===null?'add':'replace'} ${e.path}`}),` ${e.from?fmt(e.from):'—'} → ${e.value?fmt(e.value):'—'} · ${e.name}`,revert));}
  for(const e of joints.values()){const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.onclick=()=>{joints.delete(e.path);change();};
   items.push(make('li',{},make('code',{textContent:`replace ${e.path}`}),` ${fmt(e.from)} → ${fmt(e.value)} · ${e.name} (a joint is its bone's origin)`,revert));}
  adds.forEach((a,i)=>{const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.onclick=()=>{adds.splice(i,1);change();};
   items.push(make('li',{},make('code',{textContent:`add /assemble/${a.kind==='cut'?'cuts':'patches'}/-`}),` ${a.kind==='cut'?`cut ${a.into} ← ${a.from}, ${a.polygon.length} point(s)`:`patch ${a.name} ${fmt(a.box)}`} · regions → ${a.bone}`,revert));});
  pending.replaceChildren(...(items.length?items:[make('li',{className:'hint',textContent:'No pending ops.'})]));
  applyButton.disabled=busy||!items.length||!!buildReason;resetButton.disabled=busy;
  toggle.disabled=!loaded;toggle.setAttribute('aria-pressed',String(active));
 }
 function renderAdd(){
  const field=(id:string)=>addForm.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-cuts-add="${id}"]`);
  const from=field('from') as HTMLSelectElement|null,before=field('draw') as HTMLSelectElement|null;
  if(from&&from.options.length!==source.plan.length){from.replaceChildren(...source.plan.map(n=>make('option',{value:n,textContent:n})));}
  if(before&&before.options.length!==source.plan.length+2){before.replaceChildren(make('option',{value:'front',textContent:'front'}),make('option',{value:'back',textContent:'back'}),...source.plan.map(n=>make('option',{value:`before:${n}`,textContent:`before ${n}`})));}
  for(const el of addForm.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button'))el.disabled=busy||!loaded;
  const finish=addForm.querySelector<HTMLButtonElement>('[data-cuts-add="finish"]');if(finish)finish.disabled=busy||!placing||(placing.kind==='cut'?placing.points.length<3:placing.points.length<2);
 }
 function render(){renderPicker();renderEditor();renderPending();renderAdd();}
 function renderState(){
  if(!loaded)return;const mapping=deps.mapping();
  state.classList.toggle('error',!mapping.available||!!source.skipped.length||!!buildReason);
  state.textContent=`${source.cuts.length} cut(s) · ${source.patches.length} patch(es) · ${source.segments.filter(s=>s.joint).length} limb joint(s) in rig px of the setup pose${source.skipped.length?` · not read: ${source.skipped.join('; ')}`:''}${buildReason?` · Apply: ${buildReason}`:''}${mapping.available?'':` · ${mapping.reason}: no handles are drawn`}`;
 }

 const setActive=(on:boolean)=>{active=on&&loaded;if(active)deps.pause();if(!active){drag=null;hover=null;placing=null;delete deps.pane.dataset.cutsHover;}render();deps.changed();};
 toggle.onclick=()=>setActive(!active);
 picker.onchange=()=>{selected=picker.value;render();deps.changed();};
 applyButton.onclick=()=>{void panel.apply();};
 resetButton.onclick=()=>{if(!busy)void deps.reset();};
 addForm.addEventListener('click',event=>{
  const target=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-cuts-add]');if(!target)return;
  const kind=target.dataset.cutsAdd;
  if(kind==='place-cut'||kind==='place-patch'){placing={kind:kind==='place-cut'?'cut':'patch',points:[]};setActive(true);panelStatus(kind==='place-cut'?'Click the polygon\'s points on the stage (rig px, whole numbers), then Finish.':'Click the box\'s two corners on the stage, then Finish.',false);render();return;}
  if(kind==='finish'&&placing){
   const value=(id:string)=>(addForm.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-cuts-add="${id}"]`)?.value??'').trim();
   const drawValue=value('draw'),draw:CutDraw=drawValue.startsWith('before:')?{before:drawValue.slice('before:'.length)}:drawValue==='back'?'back':'front';
   const name=value('name'),bone=value('bone');
   if(!name||!bone){panelStatus('CUTS_ADD_INCOMPLETE: a new part needs a name and the bone its region rides',true);return;}
   if(placing.kind==='cut')adds.push({kind:'cut',from:value('from'),into:name,polygon:placing.points.map(p=>[...p] as RigPoint),draw,overlap:Number(value('overlap')||'0'),bone});
   else{const [p,q]=placing.points as [RigPoint,RigPoint];adds.push({kind:'patch',name,box:[Math.min(p[0],q[0]),Math.min(p[1],q[1]),Math.max(p[0],q[0]),Math.max(p[1],q[1])],alpha:value('alpha')==='box'?'box':'silhouette',draw,bone});}
   placing=null;change();panelStatus(`Added ${name}: Apply runs rig-parts build; the producer judges the polygon or box.`,false);return;
  }
  if(kind==='cancel'){placing=null;render();deps.changed();}
 });
 const keyDown=(event:KeyboardEvent)=>{if(event.code==='Space'&&!textEntryFocused(event.target))space=true;};
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')space=false;};
 const down=(event:PointerEvent)=>{
  if(!active||busy||space||!event.isPrimary||event.button!==0)return;
  const target=event.target;if(target instanceof Element&&target.closest('button,input,select,textarea,a'))return;
  const p=local(event),at=cropAt(p);if(!at)return;
  if(placing){event.stopPropagation();event.preventDefault();placing.points.push([Math.round(at[0]),Math.round(at[1])]);if(placing.kind==='patch'&&placing.points.length>2)placing.points.shift();render();deps.changed();return;}
  const id=hitHandle(projected(),p);if(!id)return;
  event.stopPropagation();event.preventDefault();
  const handle=handlesRig().find(h=>h.id===id)!;drag={id,pointer:event.pointerId,start:at,from:[...handle.at]};
  const [kind,a,b]=id.split(':');selected=kind==='v'?`cut:${a}`:kind==='j'?(()=>{const anchor=anchors.find(x=>x.path===id.slice(2));const s=source.segments.find(g=>g.joint&&jointAnchor(g.bone)===anchor);return s?`seg:${s.limb}:${s.index}`:selected;})():`patch:${a}`;void b;
  deps.pane.setPointerCapture(event.pointerId);deps.pane.dataset.cutsHover='move';render();deps.changed();
 };
 const move=(event:PointerEvent)=>{
  if(drag&&event.pointerId===drag.pointer){event.stopPropagation();const now=cropAt(local(event));if(!now)return;guard(()=>{moveHandle(drag!.id,dragPoint(drag!.from,drag!.start,now));});render();deps.changed();return;}
  if(!active||space)return;const id=hitHandle(projected(),local(event));if(id!==hover){hover=id;if(id)deps.pane.dataset.cutsHover='move';else delete deps.pane.dataset.cutsHover;deps.changed();}
 };
 const end=(event:PointerEvent)=>{if(!drag||event.pointerId!==drag.pointer)return;drag=null;delete deps.pane.dataset.cutsHover;if(deps.pane.hasPointerCapture(event.pointerId))deps.pane.releasePointerCapture(event.pointerId);save();render();deps.changed();};
 deps.pane.addEventListener('pointerdown',down,true);deps.pane.addEventListener('pointermove',move,true);
 for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)deps.pane.addEventListener(type,end,true);
 document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);
 const observer=new MutationObserver(()=>panel.sync());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});

 const colors=()=>({stroke:deps.token('--rv-mesh-region'),fill:deps.token('--rv-mesh-region-fill'),handle:deps.token('--rv-mesh-handle'),ink:deps.token('--rv-bone-ink'),labelBg:deps.token('--rv-bone-label-bg'),joint:deps.token('--rv-landmark'),pending:deps.token('--rv-bone-pending')});
 const world=(p:RigPoint)=>{const m=deps.mapping();return m.available?m.toWorld(p[0],p[1]):null;};
 const restore=()=>{
  let doc:unknown=null;try{doc=JSON.parse(draft.value||'null');}catch{doc=null;}
  const kept=doc&&typeof doc==='object'&&'cuts' in (doc as object)?cutsDraft(JSON.stringify((doc as {cuts:unknown}).cuts),source):{edits:new Map<string,CutEdit>(),adds:[] as CutAdd[]};
  edits=kept.edits;adds=kept.adds;joints=new Map();
  const list=doc&&typeof doc==='object'&&Array.isArray((doc as {joints?:unknown}).joints)?(doc as {joints:BoneEdit[]}).joints:[];
  for(const e of list){const a=anchors.find(x=>x.path===e.path&&x.name===e.name&&x.value[0]===e.from[0]&&x.value[1]===e.from[1]);if(a)joints=setAnchor(joints,a,e.value);}
 };

 const panel:CutsPanel={
  load(next,bones,reason,build){
   if(next===null){config=null;source={cuts:[],patches:[],segments:[],plan:[],skipped:[]};loaded=false;state.textContent=reason??'CUTS_UNAVAILABLE: no producer handoff';state.classList.add('error');setActive(false);render();return;}
   config=next;source=cutsSource(next);anchors=boneAnchors(configBones(bones??[]).bones);buildReason=build;loaded=true;
   restore();renderState();render();deps.changed();
  },
  source:()=>structuredClone(source),
  ops:allOps,
  setVertex(cut,k,value){const c=source.cuts.find(x=>x.index===cut);if(!c)throw new Error(`CUTS_UNKNOWN: assemble.cuts[${cut}]`);edits=setVertex(edits,c,k,value);change();},
  setBox(index,value){const q=source.patches.find(x=>x.index===index);if(!q)throw new Error(`CUTS_UNKNOWN: assemble.patches[${index}]`);edits=setBox(edits,q,value);change();},
  setRange(limb,k,value){const s=source.segments.find(x=>x.limb===limb&&x.index===k);if(!s)throw new Error(`CUTS_UNKNOWN: limbs.${limb}.segments[${k}]`);edits=setRange(edits,s,value);change();},
  active:()=>active,setActive,
  handles(){const rect=deps.canvas.getBoundingClientRect(),labels=new Map(handlesRig().map(h=>[h.id,h.label]));return projected().map(h=>({id:h.id,label:labels.get(h.id)!,x:h.at.x+rect.left,y:h.at.y+rect.top}));},
  overlayRegions(){
   if(!active||!loaded)return [];const c=colors(),out:OverlayRegion[]=[],handleColors={handle:c.handle,ink:c.ink,labelBg:c.labelBg};
   const region=(name:string,points:RigPoint[],focus:boolean,extra:Partial<OverlayRegion>={})=>{const w=points.map(world);if(w.some(p=>!p))return;out.push({name,points:w as OverlayPoint[],stroke:c.stroke,fill:c.fill,handles:true,active:focus&&drag?Number(drag.id.split(':')[2]??0):null,colors:handleColors,...extra});};
   for(const cut of source.cuts)region(cut.into,cut.polygon.map((_,k)=>vertexAt(edits,cut,k)),selected===`cut:${cut.index}`);
   for(const q of source.patches){const b=boxAt(edits,q);region(q.name,[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]],false);}
   for(const s of source.segments){
    const r=rangeAt(edits,s),a=s.joint?jointAnchor(s.bone):undefined;if(!r||!a)continue;
    // The rest direction: the lower bone toward its next point or tip, in config rig px.
    const next=anchors.find(x=>x.index===a.index&&(x.kind==='point'&&a.kind==='point'?x.link===(a.link??0)+1:x.kind==='tip'));
    if(!next)continue;region(`${s.joint} ${fmt(r)}°`,rangeArc(anchorAt(a,joints),anchorAt(next,joints),r,40),false,{handles:false});
   }
   if(placing&&placing.points.length)region(placing.kind==='cut'?'new cut':'new patch',placing.kind==='patch'&&placing.points.length===2?[placing.points[0]!,[placing.points[1]![0],placing.points[0]![1]],placing.points[1]!,[placing.points[0]![0],placing.points[1]![1]]]:placing.points,false,{open:placing.kind==='cut',active:placing.points.length-1});
   for(const a of adds)region(a.kind==='cut'?a.into:a.name,a.kind==='cut'?a.polygon:[[a.box[0],a.box[1]],[a.box[2],a.box[1]],[a.box[2],a.box[3]],[a.box[0],a.box[3]]],false);
   return out;
  },
  overlayMarkers(){
   if(!active||!loaded)return [];const c=colors();
   return source.segments.flatMap(s=>{const a=s.joint?jointAnchor(s.bone):undefined;const at=a?world(anchorAt(a,joints)):null;return at?[{at,tag:`${s.joint} · ${s.part}`,active:hover===`j:${a!.path}`||drag?.id===`j:${a!.path}`,colors:{stroke:joints.has(a!.path)?c.pending:c.joint,fill:c.joint,ink:c.ink,labelBg:c.labelBg}}]:[];});
  },
  async apply(){
   const ops=allOps();if(!ops.length||busy){panelStatus('CUTS_NOTHING_PENDING: no pending ops',true);return null;}
   const result=await deps.apply(ops);panel.shown(result);return result;
  },
  shown(job){
   if(!job){readout.replaceChildren();return;}
   const lines:HTMLElement[]=[],line=(label:string,text:string,error=false)=>lines.push(make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:label}),make('code',{textContent:text,title:text,className:error?'error':''})));
   if(!('id' in job)){line('REFUSED',job.error,true);readout.replaceChildren(...lines);return;}
   const a=job.assembled;
   for(const r of a?.refusals??[])line('REFUSED',r,true);
   for(const r of a?.checkFails??[])line('CHECK FAIL',r,true);
   if(a){
    if(a.recomposite.line)line('RECOMPOSITE',a.recomposite.line);
    const before=a.recomposite.before,after=a.recomposite.after;if(before&&after)line('ERROR PX',`${before.error_px} → ${after.error_px} (uncovered ${before.uncovered_error_px} → ${after.uncovered_error_px}, holes ${before.hole_count} → ${after.hole_count})`);
    for(const l of a.lines)line(l.startsWith('uncovered')?'HOLE':l.split(':')[0]!.toUpperCase(),l);
    for(const l of a.seam)line('SEAM',l);for(const l of a.seamPairs)line('SEAM PAIR',l);
    if(a.parts)line('PARTS',a.parts.changed.length?`changed: ${a.parts.changed.join(', ')} · ${a.parts.unchanged} unchanged · parts.json differs at ${a.parts.partsJson.count} path(s)`:`no part changed · parts.json differs at ${a.parts.partsJson.count} path(s)`);
   }
   if(job.status==='built'){line('BUILD',`${job.wallMs.op===null?'—':`${(job.wallMs.op/1000).toFixed(1)} s`} wall clock (assemble → rig → check) · compile ${job.wallMs.compile===null?'—':`${(job.wallMs.compile/1000).toFixed(1)} s`}${job.reused?' · reused':''}`);if(job.check?.line)line('CHECK',job.check.line,job.check.pass!==true);}
   const map=a?.recomposite.errorMap;
   readout.replaceChildren(...lines,...(map&&job.status==='built'?[make('figure',{className:'cuts-error-map'},make('img',{src:deps.route(map.url),alt:'Recomposite error map of the scratch build: red is painting no part holds, blue a part more than 40 off'}),make('figcaption',{textContent:`recomposite_error_rig.png · sha256 ${map.sha256.slice(0,12)}…`}))]:[]));
  },
  status:panelStatus,
  busy(value){busy=value;render();},
  restore(){restore();render();deps.changed();},
  clear(){edits=new Map();joints=new Map();adds=[];placing=null;change();},
  sync(){renderState();if(active&&deps.inspector()!=='rig')setActive(false);},
  dispose(){observer.disconnect();deps.pane.removeEventListener('pointerdown',down,true);deps.pane.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)deps.pane.removeEventListener(type,end,true);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);},
 };
 render();
 return panel;
}
