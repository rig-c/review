/**
 * Mesh edit (Setup): a view-bar toggle, an editor bar of sub-modes (Modify / Create / Delete / Edges) and direct
 * manipulation of the selected slot's actual mesh on the rig pane. The mesh is the slot's attachment in the compiled
 * model document at the **setup pose** (#100): the stored vertices placed through the setup-pose bones of a never-played
 * player (`web/setup-pose.ts`, shared with Setup · Weights) and drawn over the stage with the stage's own camera — the
 * stage itself stays paused at the pose it held, under the veil. Everything is a typed delta (`src/mesh-edit.ts`,
 * `basis: "setup"`) previewed over the original triangulation; nothing is retriangulated, written into the package or
 * sent to a producer from here — Apply · Rebuild still refuses `MODELING_TARGET_UNSUPPORTED` by name.
 */
import type {CropWorldMapping} from '../src/chest-regions.ts';
import {placeSetupMesh,readSetupMesh,setupModel} from '../src/setup-mesh.ts';
import {
 MESH_EDIT_CODES,MESH_EDIT_NO_MESH,MESH_EDIT_PREVIEW_NOTE,MESH_EDIT_RIG_UNAVAILABLE,MODELING_TARGET_UNSUPPORTED,MESH_EDIT_SELECT_SLOT,MeshEditSession,affineOf,applyAffine,applyMeshOps,attachmentHashText,draftOps,hitMesh,
 invertAffine,meshEditDocument,parseMeshDraft,screenDeltaToCrop,verticesInBox,writeMeshDraft,type MeshEditDocument,type MeshEditResult,type MeshOp,type MeshSource,
 type MeshView,type ScreenPoint,type Vec,
} from '../src/mesh-edit.ts';
import type {OverlayMeshEdit,OverlayPoint,OverlayProject} from './rig-overlays.ts';
import type {SetupPose} from './setup-pose.ts';
import {textEntryFocused} from './view-controls.ts';

export type MeshMode='modify'|'create'|'delete'|'edges';
export const meshModes:readonly MeshMode[]=['modify','create','delete','edges'];
/** Single-key sub-mode shortcuts. Free of I / M / B (layers), Space (pan), Enter, arrows (nudge) and Z (undo). */
export const meshModeKeys:Readonly<Record<string,MeshMode>>=Object.freeze({v:'modify',c:'create',x:'delete',e:'edges'});
export const meshModeLabel:Readonly<Record<MeshMode,string>>=Object.freeze({modify:'Modify',create:'Create',delete:'Delete',edges:'Edges'});
export const meshEditVisible=(inspector:string|undefined)=>inspector==='rig';

export type MeshKeyAction={type:'mode';mode:MeshMode}|{type:'escape'}|{type:'undo'}|{type:'redo'}|{type:'nudge';dx:number;dy:number};
interface KeyLike {key:string;shiftKey:boolean;ctrlKey:boolean;metaKey:boolean;altKey:boolean;repeat?:boolean;defaultPrevented?:boolean;target:unknown}
/** Focus inside these keeps its own keys (tabs, separators, the part list, menus and buttons use arrows/Escape). */
const ownKeys='[role=separator],[role=tab],[data-part-list],[data-part-search],details,dialog';
/** Keyboard map while mesh edit is on. Text entry keeps every key. */
export function meshEditShortcut(event:KeyLike,state:{active:boolean;mode:MeshMode|null;selected:number}):MeshKeyAction|null {
 if(!state.active||event.defaultPrevented||typeof event.key!=='string'||textEntryFocused(event.target))return null;
 const key=event.key.toLowerCase(),within=(selector:string)=>{const node=event.target as {closest?:(s:string)=>unknown}|null;return !!node&&typeof node.closest==='function'&&!!node.closest(selector);};
 if((event.metaKey||event.ctrlKey)&&!event.altKey&&key==='z')return event.shiftKey?{type:'redo'}:{type:'undo'};
 if(event.metaKey||event.ctrlKey||event.altKey)return null;
 if(key==='escape')return within('dialog[open],details[open]')?null:{type:'escape'};
 if(event.key.startsWith('Arrow')){
  if(state.mode!=='modify'||!state.selected||within(ownKeys))return null;
  const step=event.shiftKey?10:1,d=({ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]} as Record<string,[number,number]>)[event.key];
  return d?{type:'nudge',dx:d[0],dy:d[1]}:null;
 }
 if(event.repeat||event.shiftKey)return null;
 const mode=meshModeKeys[key];return mode?{type:'mode',mode}:null;
}

/** World → crop through the inverse of the crop mapping (crop px, x right, y down), unrounded: the producer holds a `move.from` to 1e-3 px. */
export function cropFromWorld(mapping:Extract<CropWorldMapping,{available:true}>):((x:number,y:number)=>Vec)|null {
 const inverse=invertAffine(affineOf((x,y)=>mapping.toWorld(x,y)));if(!inverse)return null;
 return (x,y)=>{const p=applyAffine(inverse,x,y);return [p.x,p.y];};
}
type SourceResult={ok:true;source:Omit<MeshSource,'hash'>;entry:unknown;world:number[]}|{ok:false;code:string};
/**
 * The selected slot's mesh in setup space: its attachment's entry in the hash-verified compiled model document (the
 * attachment the setup pose resolves), its stored vertices placed through the setup-pose bones (`world`, flat x, y)
 * and mapped to crop px. Refuses, in order: no model document (`MESH_EDIT_MODEL_UNAVAILABLE`), whole rig, no setup pose,
 * a non-mesh or linked attachment, no crop mapping.
 */
export function meshEditSource(input:{slot:string|null;model:unknown;pose:(slot:string)=>SetupPose|null;mapping:CropWorldMapping}):SourceResult {
 const available=setupModel(input.model,MESH_EDIT_CODES);if(!available.ok)return available;
 const {slot}=input;if(!slot)return {ok:false,code:`${MESH_EDIT_SELECT_SLOT}: ${MESH_EDIT_CODES.selectText}`};
 let pose:SetupPose|null;
 try{pose=input.pose(slot);}catch(error){return {ok:false,code:`${MESH_EDIT_RIG_UNAVAILABLE}: ${error instanceof Error?error.message:String(error)}`};}
 if(!pose)return {ok:false,code:`${MESH_EDIT_RIG_UNAVAILABLE}: no rig loaded`};
 const read=readSetupMesh(input.model,slot,pose.identity,MESH_EDIT_CODES);if(!read.ok)return read;
 const mesh=read.mesh,noMesh=(why:string)=>({ok:false as const,code:`${MESH_EDIT_NO_MESH} ${slot}: ${why}`});
 if(mesh.linked)return noMesh(`${mesh.skin} / ${mesh.attachment} is a linked mesh of ${mesh.source.slot} / ${mesh.source.attachment}; edit its source mesh`);
 if(mesh.hull===null)return noMesh('the model entry stores no hull');
 if(!input.mapping.available)return {ok:false,code:`${input.mapping.reason}: mesh edit needs the crop mapping`};
 let world:number[]|null;
 try{world=placeSetupMesh(mesh,pose.world);}catch(error){return {ok:false,code:`${MESH_EDIT_RIG_UNAVAILABLE}: ${error instanceof Error?error.message:String(error)}`};}
 if(!world)return {ok:false,code:`MESH_EDIT_SOURCE_MISMATCH: ${slot} has a non-finite setup-pose vertex`};
 const toCrop=cropFromWorld(input.mapping);if(!toCrop)return {ok:false,code:'MESH_EDIT_MAPPING_SINGULAR'};
 const vertices:Vec[]=[];for(let i=0;i<world.length;i+=2)vertices.push(toCrop(world[i]!,world[i+1]!));
 return {ok:true,source:{slot,skin:mesh.skin,attachment:mesh.attachment,vertices,triangles:mesh.triangles,hull:mesh.hull},entry:mesh.entry,world};
}
export async function sha256Hex(text:string):Promise<string> {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}

export interface MeshEditorHost {
 pane:HTMLElement;canvas:HTMLElement;
 project:()=>OverlayProject|null;
 mapping:()=>CropWorldMapping;
 inspector:()=>string|undefined;
 /** The selected slot's setup-space source, or the refusal that names why there is none. */
 source:()=>SourceResult;
 /** Hold the stage still under the setup-pose overlay. */
 pause:()=>void;
 changed:()=>void;
 download:(document:MeshEditDocument)=>void;
 message:(text:string,error?:boolean)=>void;
 confirm:(text:string)=>boolean;
 token:(name:string)=>string;
}
export interface MeshEditor {active:()=>boolean;overlay:()=>OverlayMeshEdit|null;sync:()=>void;selectionChanged:()=>void;dispose:()=>void;session:()=>MeshEditSession|null;mode:()=>MeshMode|null}

type Drag={pointer:number;start:ScreenPoint;ids:number[];base:MeshView;ops:MeshOp[]}|{pointer:number;start:ScreenPoint;box:ScreenPoint;add:boolean};

export function bindMeshEditor(host:MeshEditorHost):MeshEditor {
 const node=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
 const toggle=node<HTMLButtonElement>('mesh-edit'),bar=node<HTMLElement>('mesh-editor-bar'),status=node<HTMLElement>('mesh-editor-status'),draft=node<HTMLTextAreaElement>('mesh-edit-draft');
 const chestToggle=document.getElementById('chest-edit') as HTMLButtonElement|null;
 let active=false,entering=false,mode:MeshMode|null=null,session:MeshEditSession|null=null,space=false,drag:Drag|null=null,pending:number|null=null,hover:ReturnType<typeof hitMesh>=null,note='',noteError=false;
 let preview:MeshView|null=null;const selected=new Set<number>();
 const view=()=>preview??session?.view()??null;
 const cropToScreen=()=>{const project=host.project(),mapping=host.mapping();if(!project||!mapping.available)return null;return affineOf((x,y)=>{const w=mapping.toWorld(x,y);return project(w.x,w.y);});};
 const screenPoints=():(ScreenPoint|null)[]=>{const m=cropToScreen(),v=view();if(!m||!v)return [];return v.vertices.map(p=>p?applyAffine(m,p[0],p[1]):null);};
 const toCrop=(p:ScreenPoint):Vec|null=>{const m=cropToScreen(),inverse=m&&invertAffine(m);if(!inverse)return null;const q=applyAffine(inverse,p.x,p.y);return [q.x,q.y];};
 const local=(event:PointerEvent):ScreenPoint=>{const rect=host.canvas.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const hint:Record<MeshMode,string>={
  modify:'drag a vertex or edge · Shift-click selects more · drag empty space to box-select · arrows nudge 1 px (Shift 10)',
  create:'click empty space to add a vertex · click an edge to split it',
  delete:'click a vertex (with its edges) or an added constraint edge to remove it · hull and triangulation edges are the producer\'s',
  edges:'click vertex A then vertex B to add a constraint edge · click a constraint edge to remove it',
 };
 const sync=()=>{
  const visible=meshEditVisible(host.inspector());toggle.hidden=!visible;
  if(!visible&&active){setActive(false);return;}
  toggle.setAttribute('aria-pressed',String(active));bar.hidden=!active;
  for(const button of bar.querySelectorAll<HTMLButtonElement>('[data-mesh-mode]'))button.setAttribute('aria-pressed',String(button.dataset.meshMode===mode));
  node<HTMLButtonElement>('mesh-undo').disabled=!session?.canUndo();node<HTMLButtonElement>('mesh-redo').disabled=!session?.canRedo();node<HTMLButtonElement>('mesh-reset').disabled=!session?.canUndo()&&!session?.ops().length;
  if(!session){status.textContent='';return;}
  const s=session.source,count=session.ops().length;
  status.textContent=`${note?note+' · ':''}${count} op${count===1?'':'s'} · setup pose · ${MESH_EDIT_PREVIEW_NOTE} · ${mode?hint[mode]:'no sub-mode — Escape again leaves mesh edit'} · Space-drag pans`;
  status.title=`${s.slot} / ${s.skin} / ${s.attachment} · ${s.vertices.length} vertices · ${s.triangles.length/3} triangles · hull ${s.hull} · ${status.textContent}`;
  status.classList.toggle('error',noteError);
  if(mode)host.pane.dataset.meshMode=mode;else delete host.pane.dataset.meshMode;
 };
 const say=(text:string,error=false)=>{note=text;noteError=error;if(text)host.message(text,error);sync();};
 const persist=()=>{if(!session)return;const text=writeMeshDraft(parseMeshDraft(draft.value),session.source,session.ops());if(text.length>32768){say('MESH_EDIT_DRAFT_LIMIT: the local draft is full — download the JSON; edits after this are not kept on reload',true);return;}draft.value=text;draft.dispatchEvent(new Event('input',{bubbles:true}));};
 /** Reports a step: a refusal by its code, a no-op by its reason, a change by what it did. */
 const after=(result:MeshEditResult,what:()=>string)=>{
  if(!result.ok)say(result.code,true);
  else if(result.changed){persist();say('');host.message(`${what()} · ${MESH_EDIT_PREVIEW_NOTE}`);}
  else say(result.code??'');
  host.changed();
 };
 const lastAdded=()=>(session?.view().vertices.length??1)-1;
 const setMode=(next:MeshMode|null)=>{mode=next;pending=null;drag=null;preview=null;sync();host.changed();};
 const leave=()=>{active=false;mode=null;session=null;drag=null;preview=null;pending=null;hover=null;selected.clear();note='';delete host.pane.dataset.meshHover;delete host.pane.dataset.meshMode;};
 const setActive=(on:boolean)=>{if(!on){leave();sync();host.changed();return;}void enter();};
 const enter=async()=>{
  if(entering)return;entering=true;
  try{
   const result=host.source();if(!result.ok){leave();sync();host.message(result.code,true);host.changed();return;}
   const hash=await sha256Hex(attachmentHashText(result.entry)),source:MeshSource={...result.source,hash};
   const restored=draftOps(parseMeshDraft(draft.value),source);session=new MeshEditSession(source,restored??[]);
   if(chestToggle?.getAttribute('aria-pressed')==='true')chestToggle.click();
   host.pause();active=true;mode='modify';selected.clear();pending=null;note=restored?.length?`restored ${restored.length} draft op${restored.length===1?'':'s'}`:'';noteError=false;
   sync();host.changed();
  }finally{entering=false;}
 };
 toggle.addEventListener('click',()=>setActive(!active));
 for(const button of bar.querySelectorAll<HTMLButtonElement>('[data-mesh-mode]'))button.addEventListener('click',()=>setMode(button.dataset.meshMode as MeshMode));
 const undo=()=>{if(session?.undo()){selected.clear();persist();say('');host.changed();}};
 const redo=()=>{if(session?.redo()){selected.clear();persist();say('');host.changed();}};
 node<HTMLButtonElement>('mesh-undo').addEventListener('click',undo);node<HTMLButtonElement>('mesh-redo').addEventListener('click',redo);
 node<HTMLButtonElement>('mesh-reset').addEventListener('click',()=>{if(!session)return;if(!host.confirm(`Drop the whole mesh-edit delta for ${session.source.slot} / ${session.source.attachment}? This cannot be undone.`))return;session.reset();selected.clear();persist();say('delta reset');host.changed();});
 node<HTMLButtonElement>('mesh-download').addEventListener('click',()=>{if(session)host.download(meshEditDocument(session));});
 // No producer command consumes a vertex delta (#99): refuse by name and run nothing.
 node<HTMLButtonElement>('mesh-apply').addEventListener('click',()=>{host.message(MODELING_TARGET_UNSUPPORTED,true);say(MODELING_TARGET_UNSUPPORTED,true);});
 const keyDown=(event:KeyboardEvent)=>{
  if(event.code==='Space'&&!textEntryFocused(event.target))space=true;
  const action=meshEditShortcut(event,{active,mode,selected:selected.size});if(!action)return;
  event.preventDefault();event.stopPropagation();
  if(action.type==='mode')setMode(action.mode);
  else if(action.type==='escape'){if(mode)setMode(null);else setActive(false);}
  else if(action.type==='undo')undo();else if(action.type==='redo')redo();
  else if(session)after(session.record(session.moveOps([...selected],action.dx,action.dy)),()=>`nudged ${selected.size} vertex${selected.size===1?'':'es'} by ${action.dx}, ${action.dy} crop px`);
 };
 const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')space=false;};
 const blur=()=>{space=false;};
 const down=(event:PointerEvent)=>{
  if(!active||!mode||!session||space||!event.isPrimary||event.button!==0)return;
  const target=event.target;if(target instanceof Element&&target.closest('button,input,select,textarea,a,summary'))return;
  // In a sub-mode every primary press edits; the viewport's pan never sees it (Space-drag still pans).
  event.stopPropagation();event.preventDefault();
  const p=local(event),points=screenPoints(),current=session.view(),hit=hitMesh(points,current.edges,p,event.pointerType==='touch');
  const capture=()=>host.pane.setPointerCapture(event.pointerId);
  if(mode==='modify'){
   if(hit?.kind==='vertex'){
    if(event.shiftKey){if(selected.has(hit.v))selected.delete(hit.v);else selected.add(hit.v);host.changed();return;}
    if(!selected.has(hit.v)){selected.clear();selected.add(hit.v);}
    drag={pointer:event.pointerId,start:p,ids:[...selected],base:current,ops:[]};capture();host.changed();return;
   }
   if(hit?.kind==='edge'){
    if(event.shiftKey){selected.add(hit.a);selected.add(hit.b);host.changed();return;}
    if(!(selected.has(hit.a)&&selected.has(hit.b))){selected.clear();selected.add(hit.a);selected.add(hit.b);}
    drag={pointer:event.pointerId,start:p,ids:[...selected],base:current,ops:[]};capture();host.changed();return;
   }
   if(!event.shiftKey)selected.clear();
   drag={pointer:event.pointerId,start:p,box:p,add:event.shiftKey};capture();host.changed();return;
  }
  if(mode==='create'){
   if(hit?.kind==='vertex'){say('Create: that is a vertex already — click empty space or an edge');return;}
   const at=toCrop(hit?.kind==='edge'?hit.at:p);if(!at)return;
   const edge=hit?.kind==='edge'?[hit.a,hit.b] as [number,number]:undefined;after(session.addVertex(at,edge),()=>edge?`edge ${edge[0]}–${edge[1]} split by vertex ${lastAdded()}`:`vertex ${lastAdded()} added`);return;
  }
  if(mode==='delete'){
   if(hit?.kind==='vertex'){const v=hit.v;selected.delete(v);after(session.removeVertex(v),()=>`vertex ${v} removed with its edges`);}
   else if(hit?.kind==='edge'){const {a,b}=hit;after(session.deleteEdge(a,b),()=>`edge ${a}–${b} removed`);}
   return;
  }
  // Edges
  if(hit?.kind==='vertex'){
   if(pending===null||pending===hit.v){pending=pending===hit.v?null:hit.v;say(pending===null?'':`edge from ${hit.v}: click the second vertex`);host.changed();return;}
   const from=pending,to=hit.v,had=!!session.findEdge(from,to);pending=null;after(session.toggleConstraint(from,to),()=>`constraint edge ${from}–${to} ${had?'removed':'added'}`);return;
  }
  if(hit?.kind==='edge'){const {a,b}=hit;pending=null;after(session.toggleConstraint(a,b),()=>`constraint edge ${a}–${b} removed`);return;}
  pending=null;say('');host.changed();
 };
 const move=(event:PointerEvent)=>{
  if(drag&&event.pointerId===drag.pointer){
   event.stopPropagation();const p=local(event);
   if('box' in drag){drag.box=p;host.changed();return;}
   const m=cropToScreen(),d=m&&screenDeltaToCrop(m,p.x-drag.start.x,p.y-drag.start.y);if(!d||!session)return;
   drag.ops=session.moveOps(drag.ids,d[0],d[1],drag.base);
   try{preview=applyMeshOps(session.source,[...session.ops(),...drag.ops]);}catch{preview=null;}
   host.changed();return;
  }
  if(!active||!mode||space||!session)return;
  const next=hitMesh(screenPoints(),session.view().edges,local(event),event.pointerType==='touch');
  const key=(h:typeof next)=>h?h.kind==='vertex'?`v${h.v}`:`e${h.a}:${h.b}`:'';
  if(key(next)!==key(hover)){hover=next;if(next)host.pane.dataset.meshHover=next.kind;else delete host.pane.dataset.meshHover;host.changed();}
 };
 const end=(event:PointerEvent)=>{
  if(!drag||event.pointerId!==drag.pointer)return;const finished=drag;drag=null;preview=null;
  if(host.pane.hasPointerCapture(event.pointerId))host.pane.releasePointerCapture(event.pointerId);
  if('box' in finished){
   if(event.type!=='pointercancel'){const ids=verticesInBox(screenPoints(),finished.start,finished.box);if(!finished.add)selected.clear();for(const v of ids)selected.add(v);}
   host.changed();return;
  }
  if(event.type==='pointercancel'||!session){host.changed();return;}
  const moved=new Set(finished.ops.map(op=>op.op==='move'?op.v:-1)).size;after(session.record(finished.ops),()=>`moved ${moved} vertex${moved===1?'':'es'}`);
 };
 host.pane.addEventListener('pointerdown',down,true);host.pane.addEventListener('pointermove',move,true);
 for(const type of ['pointerup','pointercancel'] as const)host.pane.addEventListener(type,end,true);
 document.addEventListener('keydown',keyDown,true);window.addEventListener('keyup',keyUp,true);window.addEventListener('blur',blur);
 const observer=new MutationObserver(()=>sync());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});
 // The chest editor and mesh edit both own the pane's pointer; turning one on turns the other off.
 const chestObserver=new MutationObserver(()=>{if(active&&chestToggle?.getAttribute('aria-pressed')==='true'){setActive(false);}});
 if(chestToggle)chestObserver.observe(chestToggle,{attributes:true,attributeFilter:['aria-pressed']});
 const overlay=():OverlayMeshEdit|null=>{
  const v=view(),mapping=host.mapping();if(!active||!session||!v||!mapping.available)return null;
  const world=(p:Vec):OverlayPoint=>mapping.toWorld(p[0],p[1]),s=session.source,source=s.vertices;
  const hoverKey=hover?.kind==='edge'?`${Math.min(hover.a,hover.b)}:${Math.max(hover.a,hover.b)}`:'';
  const triangles:OverlayPoint[][]=[];for(let i=0;i+2<s.triangles.length;i+=3){const ids=[s.triangles[i]!,s.triangles[i+1]!,s.triangles[i+2]!];if(ids.every(id=>source[id]))triangles.push(ids.map(id=>world(source[id]!)));}
  type EdgeRow=OverlayMeshEdit['edges'][number];type VertexRow=OverlayMeshEdit['vertices'][number];
  const edges:EdgeRow[]=[];
  for(const e of v.removedEdges){const a=v.vertices[e.a]??source[e.a]??null,b=v.vertices[e.b]??source[e.b]??null;if(a&&b)edges.push({from:world(a),to:world(b),kind:'removed'});}
  for(const e of v.edges){const a=v.vertices[e.a],b=v.vertices[e.b];if(a&&b)edges.push({from:world(a),to:world(b),kind:e.kind,hover:`${e.a}:${e.b}`===hoverKey});}
  const ghosts=[...v.moved].flatMap(([id,from])=>{const to=v.vertices[id];return to?[{from:world(from),to:world(to)}]:[];});
  const vertices=v.vertices.flatMap((p,id):VertexRow[]=>{
   if(!p){const at=source[id];return at?[{at:world(at),state:'removed',selected:false,hover:false,pending:false}]:[];}
   return [{at:world(p),state:v.added.has(id)?'added':v.moved.has(id)?'moved':'source',selected:selected.has(id),hover:hover?.kind==='vertex'&&hover.v===id,pending:pending===id}];
  });
  const box=drag&&'box' in drag?{from:drag.start,to:drag.box}:undefined;
  const t=host.token;
  return {triangles,edges,ghosts,vertices,...(box?{box}:{}),colors:{veil:t('--rv-mesh-veil'),edge:t('--rv-mesh-edge'),hull:t('--rv-mesh-hull'),constraint:t('--rv-mesh-constraint'),removed:t('--rv-mesh-removed'),vertex:t('--rv-mesh-vertex'),ink:t('--rv-mesh-ink'),selected:t('--rv-mesh-selected'),added:t('--rv-mesh-added'),hover:t('--rv-mesh-hover'),box:t('--rv-mesh-box'),boxFill:t('--rv-mesh-box-fill')}};
 };
 const selectionChanged=()=>{
  if(!active||!session)return;const result=host.source();
  if(!result.ok){leave();sync();host.message(result.code,true);host.changed();return;}
  if(result.source.slot!==session.source.slot||result.source.attachment!==session.source.attachment||result.source.skin!==session.source.skin){leave();void enter();}
 };
 sync();
 return {
  active:()=>active,overlay,sync,selectionChanged,session:()=>session,mode:()=>mode,
  dispose:()=>{observer.disconnect();chestObserver.disconnect();host.pane.removeEventListener('pointerdown',down,true);host.pane.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel'] as const)host.pane.removeEventListener(type,end,true);document.removeEventListener('keydown',keyDown,true);window.removeEventListener('keyup',keyUp,true);window.removeEventListener('blur',blur);},
 };
}
export {MODELING_TARGET_UNSUPPORTED};
