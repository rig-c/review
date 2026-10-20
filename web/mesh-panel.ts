/**
 * Setup · Mesh panel (#106), page side: for the selected mesh part, the config's `meshes.<part>` entry as a pending
 * entry — mode-specific sliders, regions (circles drawn as the chest overlay draws them, polygons placed and dragged
 * on the stage with a bone and a band), segments picked from the bone list, ribs stations per chain — its diff against
 * the config's entry, review's pre-check in the loader's names, Apply (`remesh --mesh` through the patch runner, one
 * op at `/meshes/<part>`), Reset, the counts and `TEXTURE_STRETCH` after a build and the folds reading on the
 * revision. The draft (`#mesh-pending`) keeps the part and its pending entry; nothing reaches the package.
 */
import {
 addSegment,entryChanges,entryRegions,entrySegments,entryValue,freeRegionName,hitRegionPoint,meshDraftText,meshMode,modeNotEditable,moveRegionPoint,
 paramsFor,parseMeshDraft,polygonRegion,precheckEntry,removeSegment,segmentChoices,setEntryValue,setRibs,snapPoint,withRegions,FLOORS,RULES,MESH_PANEL_SCHEMA,
 type MeshEntry,type MeshMode,type MeshParam,type MeshRegion,type Point,
} from '../src/mesh-entry.ts';
import type {JsonValue} from '../src/config-patch.ts';
import type {CropWorldMapping} from '../src/chest-regions.ts';
import type {OverlayCircle,OverlayProject,OverlayRegion} from './rig-overlays.ts';

export interface MeshPanelHost {
 pane:HTMLElement;
 project:()=>OverlayProject|null;
 mapping:()=>CropWorldMapping;
 /** The loaded model's bone names (segments and region bones are picked from them). */
 bones:()=>readonly string[];
 apply:(part:string,entry:MeshEntry)=>Promise<void>;
 reset:()=>Promise<void>;
 folds:()=>Promise<void>;
 changed:()=>void;
 saved:()=>void;
 token:(name:string)=>string;
}
export interface MeshPanel {
 /** The config's meshes entries (`GET /api/rebuild`), or the reason none can be read. */
 load(meshes:Record<string,unknown>|null,reason:string|null):void;
 select(part:string|null):void;
 part():string|null;
 entry():MeshEntry|null;
 configEntry():MeshEntry|null;
 set(path:readonly string[],value:JsonValue|undefined):void;
 setEntry(entry:MeshEntry):void;
 regions:{list():MeshRegion[];add(region:MeshRegion):void;move(region:number,vertex:number,to:Point):void;remove(index:number):void;draw(on:boolean):void;placing():Point[]|null};
 precheck():string[];
 restore():void;
 status(text:string,error:boolean):void;
 counts(lines:{label:string;text:string;error?:boolean}[]):void;
 readout(lines:{name:string;before:string;after:string}[]):void;
 busy(value:boolean):void;
 overlayRegions():OverlayRegion[];
 overlayCircles():OverlayCircle[];
 dispose():void;
}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const shown=(v:JsonValue|undefined)=>v===undefined?'(absent)':JSON.stringify(v);
const isObject=(v:unknown):v is Record<string,JsonValue>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Rig px (crop, y down) → world, and pane px → rig px, through the crop mapping and the camera's projection. */
export function paneToRig(project:OverlayProject,mapping:Extract<CropWorldMapping,{available:true}>,at:{x:number;y:number}):Point|null {
 const o=project(0,0),ux=project(1,0),uy=project(0,1),sx=ux.x-o.x,sy=uy.y-o.y;
 if(!sx||!sy||!Number.isFinite(sx)||!Number.isFinite(sy))return null;
 const world={x:(at.x-o.x)/sx,y:(at.y-o.y)/sy},w0=mapping.toWorld(0,0),w1=mapping.toWorld(1,1);
 const kx=w1.x-w0.x,ky=w1.y-w0.y;if(!kx||!ky)return null;
 return [(world.x-w0.x)/kx,(world.y-w0.y)/ky];
}

export function bindMeshPanel(host:MeshPanelHost):MeshPanel {
 const state=node('mesh-panel-state'),params=node('mesh-params'),regionsArea=node('mesh-regions'),segmentsList=node('mesh-segments'),diffList=node('mesh-diff'),precheckList=node('mesh-precheck');
 const addCircle=node<HTMLButtonElement>('mesh-add-circle'),drawPolygon=node<HTMLButtonElement>('mesh-add-polygon'),dragToggle=node<HTMLButtonElement>('mesh-regions-edit');
 const segmentBone=node<HTMLSelectElement>('mesh-segment-bone'),segmentAdd=node<HTMLButtonElement>('mesh-segment-add');
 const applyButton=node<HTMLButtonElement>('mesh-panel-apply'),resetButton=node<HTMLButtonElement>('mesh-panel-reset'),foldsButton=node<HTMLButtonElement>('mesh-folds');
 const statusOut=node('mesh-status'),countsArea=node('mesh-counts'),readoutArea=node('mesh-readout'),draft=node<HTMLTextAreaElement>('mesh-pending');
 let meshes:Record<string,unknown>|null=null,loadReason:string|null=null,part:string|null=null,base:MeshEntry|null=null,pending:MeshEntry|null=null,busy=false;
 let placing:Point[]|null=null,dragging=false,drag:{region:number;vertex:number;pointer:number}|null=null,activeRegion:number|null=null;

 function save(){draft.value=pending&&part&&base&&JSON.stringify(pending)!==JSON.stringify(base)?meshDraftText({schema:MESH_PANEL_SCHEMA,part,entry:pending}):'';draft.dispatchEvent(new Event('input',{bubbles:true}));host.saved();}
 function change(next:MeshEntry){pending=next;save();render();host.changed();}
 function status(text:string,error:boolean){statusOut.textContent=text;statusOut.title=text;statusOut.classList.toggle('error',error);}
 const mode=():MeshMode|null=>{if(!pending||!part)return null;const m=meshMode(pending,part);return 'mode' in m?m.mode:null;};
 const editable=()=>{const m=mode();return !!m&&!modeNotEditable(m);};

 function renderParams(){
  const m=mode();if(!pending||!m||!editable()){params.replaceChildren();return;}
  const rows:HTMLElement[]=[];
  for(const p of paramsFor(m))rows.push(paramRow(p));
  // rule and the floor are closed sets: a select each, absent first.
  rows.push(selectRow('rule',['rule'],['',...RULES],'the weight rule: "distance" (w = 1/(d + r)^exponent, what absent means) or "heat" (bone heat over the part\'s silhouette)'));
  rows.push(selectRow('floor',['influences','floor'],['',...FLOORS],'"cut" (shares under 0.03 dropped, what absent means) or "continuous"'));
  if(m==='contour'){
   const box=make('input',{type:'checkbox',checked:entryValue(pending,['contour','bridges'])===true,disabled:busy});box.setAttribute('aria-label','contour bridges');box.dataset.param='bridges';
   box.onchange=()=>change(setEntryValue(pending!,['contour','bridges'],box.checked?true:undefined));
   rows.push(make('label',{className:'physics-toggle mesh-param-toggle',title:'every island joined into one outline by bridges (true is its one value; absent is the one-island rule)'},box,'bridges'));
  }
  params.replaceChildren(make('p',{className:'physics-editor-title'},make('strong',{textContent:part!}),` · mode ${m} · config.meshes.${part}`),...rows);
 }
 function paramRow(p:MeshParam):HTMLElement {
  const value=entryValue(pending!,p.path),configValue=base?entryValue(base,p.path):undefined,present=typeof value==='number';
  const label=`${p.key}${p.path.length>1&&p.path[0]!=='contour'?` (${p.path[0]})`:''}`,current=present?value as number:p.min;
  const changed=JSON.stringify(value)!==JSON.stringify(configValue);
  const range=make('input',{type:'range',min:String(Math.min(p.min,current)),max:String(Math.max(p.max,current)),step:String(p.step),value:String(current),disabled:busy||!present});range.setAttribute('aria-label',label);range.dataset.param=p.path.join('.');
  const number=make('input',{type:'number',step:'any',value:present?String(value):'',disabled:busy||!present,inputMode:'decimal',placeholder:'absent'});number.setAttribute('aria-label',`${label} value`);number.dataset.param=p.path.join('.');
  const commit=(raw:string)=>{const v=Number(raw);if(raw.trim()===''||!Number.isFinite(v)){status(`MESH_VALUE_INVALID: ${p.path.join('.')} must be a finite number`,true);return;}change(setEntryValue(pending!,p.path,v));};
  range.oninput=()=>{number.value=range.value;};range.onchange=()=>commit(range.value);number.onchange=()=>commit(number.value);
  const parts:(Node|string)[]=[make('span',{textContent:label,title:p.rule}),range,number];
  if(p.optional){const on=make('input',{type:'checkbox',checked:present,disabled:busy});on.setAttribute('aria-label',`${label} declared`);on.onchange=()=>change(setEntryValue(pending!,p.path,on.checked?(typeof configValue==='number'?configValue:p.min):undefined));parts.push(on);}
  else parts.push(make('span'));
  parts.push(make('output',{textContent:changed?`was ${shown(configValue)}`:''}));
  return make('label',{className:changed?'physics-control mesh-param pending':'physics-control mesh-param',title:p.rule},...parts);
 }
 function selectRow(label:string,path:readonly string[],options:readonly string[],rule:string):HTMLElement {
  const value=entryValue(pending!,path),select=make('select',{disabled:busy});select.setAttribute('aria-label',label);select.dataset.param=path.join('.');
  select.replaceChildren(...options.map(o=>make('option',{value:o,textContent:o||'(absent)'})));select.value=typeof value==='string'?value:'';
  select.onchange=()=>change(setEntryValue(pending!,path,select.value||undefined));
  const changed=JSON.stringify(value)!==JSON.stringify(base?entryValue(base,path):undefined);
  return make('label',{className:changed?'physics-control mesh-param pending':'physics-control mesh-param',title:rule},make('span',{textContent:label}),select,make('span'),make('span'),make('output',{textContent:changed?`was ${shown(base?entryValue(base,path):undefined)}`:''}));
 }

 function renderRegions(){
  const contour=mode()==='contour'&&editable();
  for(const b of [addCircle,drawPolygon,dragToggle])b.disabled=busy||!contour;
  drawPolygon.setAttribute('aria-pressed',String(!!placing));dragToggle.setAttribute('aria-pressed',String(dragging));
  if(!contour||!pending){regionsArea.replaceChildren(make('p',{className:'hint',textContent:mode()==='grid'?'A lattice (grid) entry has no regions; regions belong to the contour mode.':''}));return;}
  const regions=entryRegions(pending),bones=host.bones();
  const items=regions.map((r,i)=>{
   const field=(key:string,value:JsonValue|undefined,commit:(v:string)=>void,type='number')=>{const box=make('input',{type,value:value===undefined?'':String(value),disabled:busy,step:'any'});box.setAttribute('aria-label',`${r.name} ${key}`);box.dataset.region=String(i);box.dataset.field=key;box.onchange=()=>commit(box.value);return make('label',{},key,box);};
   const set=(key:string,raw:string,numeric=true)=>{const next=entryRegions(pending!).map(x=>({...x})) as unknown as Record<string,JsonValue>[];const v=numeric?Number(raw):raw;if(numeric&&(raw.trim()===''||!Number.isFinite(v as number))){status(`MESH_VALUE_INVALID: ${r.name}.${key} must be a finite number`,true);return;}next[i]![key]=v as JsonValue;change(withRegions(pending!,next as unknown as MeshRegion[]));};
   const bone=make('select',{disabled:busy});bone.setAttribute('aria-label',`${r.name} bone`);bone.dataset.region=String(i);bone.dataset.field='bone';
   bone.replaceChildren(...[...new Set([r.bone,...bones])].map(b=>make('option',{value:b,textContent:b})));bone.value=r.bone;bone.onchange=()=>set('bone',bone.value,false);
   const remove=make('button',{type:'button',textContent:'Remove',disabled:busy});remove.setAttribute('aria-label',`Remove region ${r.name}`);remove.onclick=()=>{const next=entryRegions(pending!).filter((_,k)=>k!==i);activeRegion=null;change(withRegions(pending!,next));};
   const shape=r.shape==='circle'?[field('cx',r.cx,v=>set('cx',v)),field('cy',r.cy,v=>set('cy',v)),field('r',r.r,v=>set('r',v))]:[make('span',{className:'hint',textContent:`${r.points.length} points (drag them on the stage)`})];
   const row=make('fieldset',{className:activeRegion===i?'mesh-region selected':'mesh-region'},make('legend',{textContent:`${r.name} · ${r.shape}`}),field('name',r.name,v=>set('name',v,false),'text'),make('label',{},'bone',bone),field('spacing',r.spacing,v=>set('spacing',v)),field('band',r.band,v=>set('band',v)),...shape,remove);
   return row;
  });
  const bust=entryValue(pending,['contour','bust']);
  regionsArea.replaceChildren(...(items.length?items:[make('p',{className:'hint',textContent:'No regions. Add a circle, or draw a polygon on the stage.'})]),...(bust===undefined?[]:[make('p',{className:'hint',textContent:'contour.bust stays as written (the Chest regions editor\'s Landmarks mode edits it).'})]));
 }
 function renderSegments(){
  const ok=editable()&&!!pending;
  segmentBone.disabled=busy||!ok;segmentAdd.disabled=busy||!ok;
  if(!ok||!pending){segmentsList.replaceChildren();return;}
  const keep=segmentBone.value;
  segmentBone.replaceChildren(make('option',{value:'',textContent:'Pick a bone'}),...segmentChoices(host.bones(),pending).map(b=>make('option',{value:b,textContent:b})));
  if([...segmentBone.options].some(o=>o.value===keep))segmentBone.value=keep;
  const ribs=entryValue(pending,['ribs']),contour=mode()==='contour';
  segmentsList.replaceChildren(...entrySegments(pending).map((s,i)=>{
   const remove=make('button',{type:'button',textContent:'Remove',disabled:busy});remove.setAttribute('aria-label',`Remove segment ${i}`);remove.onclick=()=>change(removeSegment(pending!,i));
   const item=make('li',{},make('code',{textContent:typeof s==='string'?s:JSON.stringify(s)}),remove);
   if(typeof s==='string'&&contour){
    const value=isObject(ribs)&&isObject(ribs[s])?(ribs[s] as Record<string,JsonValue>).stations:undefined;
    const stations=make('input',{type:'number',step:'1',min:'0',value:value===undefined?'':String(value),placeholder:'no ribs',disabled:busy});stations.setAttribute('aria-label',`${s} ribs stations`);stations.dataset.ribs=s;
    stations.onchange=()=>{const raw=stations.value.trim();change(setRibs(pending!,s,raw===''?null:Number(raw)));};
    item.append(make('label',{className:'mesh-ribs',title:'ribs: a row of vertices across the part at each link origin and at stations points between (a chain the segments name; contour mode)'},'ribs stations',stations));
   }
   return item;
  }));
 }
 function renderDiff(){
  const changes=pending&&base?entryChanges(base,pending):[];
  diffList.replaceChildren(...changes.map(c=>make('li',{},make('code',{textContent:`/meshes/${part}${c.path}`}),` ${shown(c.before)} → ${shown(c.after)}`)));
  if(!changes.length)diffList.append(make('li',{className:'hint',textContent:pending?'The pending entry is the config\'s entry.':'No mesh part selected.'}));
  const problems=pending&&part&&editable()?precheckEntry(part,pending,host.bones()):[];
  precheckList.replaceChildren(...problems.map(p=>make('li',{className:'error',textContent:p})));
  applyButton.disabled=busy||!pending||!editable()||!changes.length||problems.length>0;
  resetButton.disabled=busy||!part;foldsButton.disabled=busy;
 }
 function renderState(){
  if(loadReason&&!meshes){state.textContent=loadReason;state.classList.add('error');return;}
  state.classList.remove('error');
  if(!part){state.textContent='Select a mesh part in the parts list.';return;}
  if(!base){state.textContent=`MESH_PANEL_NO_ENTRY: ${part} has no meshes entry in the handoff config`;state.classList.add('error');return;}
  const m=meshMode(base,part);
  if('error' in m){state.textContent=m.error;state.classList.add('error');return;}
  const why=modeNotEditable(m.mode);
  if(why){state.textContent=why;state.classList.add('error');return;}
  state.textContent=`${part}: ${m.mode} entry from the handoff config. Apply sends the whole entry to remesh --mesh (one op at /meshes/${part}).`;
 }
 function render(){renderState();renderParams();renderRegions();renderSegments();renderDiff();}

 function pick(next:string|null){
  if(next===part&&meshes)return;
  part=next;placing=null;activeRegion=null;
  const entry=part&&meshes&&isObject(meshes[part])?structuredClone(meshes[part]) as MeshEntry:null;
  base=entry;pending=entry?structuredClone(entry):null;
  const kept=parseMeshDraft(draft.value);if(kept&&kept.part===part&&pending)pending=kept.entry;
  render();host.changed();
 }
 addCircle.onclick=()=>{
  if(!pending)return;const regions=entryRegions(pending),mapping=host.mapping();
  // A new circle starts on the part: the first segment's bone start when it is a point segment, else the stage centre.
  const seg=entrySegments(pending).find(s=>Array.isArray(s)) as [string,Point,Point]|undefined;
  const centre:Point=seg?snapPoint((seg[1][0]+seg[2][0])/2,(seg[1][1]+seg[2][1])/2):mapping.available?snapPoint(mapping.crop.w/2,mapping.crop.h/2):[0,0];
  const bone=entryValue(pending,['contour','regions'])?regions[0]?.bone??host.bones()[0]??'':host.bones()[0]??'';
  change(withRegions(pending,[...regions,{name:freeRegionName(regions,'circle'),shape:'circle',cx:centre[0],cy:centre[1],r:24,bone,spacing:14,band:16}]));
  activeRegion=regions.length;status('Added a circle region; drag its centre on the stage (Drag on stage), set its bone, spacing and band here.',false);
 };
 drawPolygon.onclick=()=>{
  if(placing){finishPolygon();return;}
  placing=[];dragging=false;status('Click the stage to place polygon points; press Draw polygon again (or Enter) to close it (3 or more points), Escape to drop it.',false);render();host.changed();
 };
 dragToggle.onclick=()=>{dragging=!dragging;placing=null;status(dragging?'Drag a polygon vertex or a circle centre on the stage.':'',false);render();host.changed();};
 segmentAdd.onclick=()=>{if(pending&&segmentBone.value)change(addSegment(pending,segmentBone.value));};
 applyButton.onclick=()=>{if(pending&&part&&!busy)void host.apply(part,structuredClone(pending));};
 resetButton.onclick=()=>{if(busy)return;if(base)pending=structuredClone(base);placing=null;activeRegion=null;save();render();host.changed();void host.reset();};
 foldsButton.onclick=()=>{if(!busy)void host.folds();};
 function finishPolygon(){
  const points=placing??[];placing=null;
  if(points.length<3){status(`MESH_POLYGON_POINTS: ${points.length} point(s) placed; a polygon region needs 3 or more`,true);render();host.changed();return;}
  const regions=entryRegions(pending!),bone=regions[0]?.bone??host.bones()[0]??'';
  try{change(withRegions(pending!,[...regions,polygonRegion(freeRegionName(regions,'polygon'),points,bone,14,16)]));activeRegion=regions.length;status('Added a polygon region; drag its vertices on the stage (Drag on stage).',false);}
  catch(error){status(error instanceof Error?error.message:String(error),true);}
 }
 const local=(event:PointerEvent)=>{const box=host.pane.getBoundingClientRect();return {x:event.clientX-box.left,y:event.clientY-box.top};};
 const rigAt=(event:PointerEvent):Point|null=>{const project=host.project(),mapping=host.mapping();if(!project||!mapping.available)return null;return paneToRig(project,mapping,local(event));};
 const projectRig=()=>{const project=host.project(),mapping=host.mapping();if(!project||!mapping.available)return null;return (x:number,y:number)=>{const w=mapping.toWorld(x,y);return project(w.x,w.y);};};
 const down=(event:PointerEvent)=>{
  if(!event.isPrimary||event.button!==0||!pending||(!placing&&!dragging))return;
  const target=event.target;if(target instanceof Element&&target.closest('button,input,select,textarea,a'))return;
  if(placing){const at=rigAt(event);if(!at)return;event.stopPropagation();event.preventDefault();placing.push(snapPoint(at[0],at[1]));host.changed();return;}
  const project=projectRig();if(!project)return;
  const hit=hitRegionPoint(entryRegions(pending),project,local(event));if(!hit)return;
  // A vertex drag edits the region; it never reaches the viewport's pan.
  event.stopPropagation();event.preventDefault();drag={...hit,pointer:event.pointerId};activeRegion=hit.region;host.pane.setPointerCapture(event.pointerId);render();host.changed();
 };
 const move=(event:PointerEvent)=>{
  if(!drag||event.pointerId!==drag.pointer||!pending)return;event.stopPropagation();
  const at=rigAt(event);if(!at)return;
  pending=withRegions(pending,moveRegionPoint(entryRegions(pending),drag.region,drag.vertex,at));host.changed();
 };
 const end=(event:PointerEvent)=>{if(!drag||event.pointerId!==drag.pointer)return;drag=null;if(host.pane.hasPointerCapture(event.pointerId))host.pane.releasePointerCapture(event.pointerId);if(pending)change(pending);};
 const keyDown=(event:KeyboardEvent)=>{if(!placing)return;if(event.key==='Enter'){event.preventDefault();finishPolygon();}else if(event.key==='Escape'){event.preventDefault();placing=null;status('Polygon dropped.',false);render();host.changed();}};
 host.pane.addEventListener('pointerdown',down,true);host.pane.addEventListener('pointermove',move,true);
 for(const type of ['pointerup','pointercancel'] as const)host.pane.addEventListener(type,end,true);
 document.addEventListener('keydown',keyDown,true);

 const colors=()=>({stroke:host.token('--rv-mesh-region'),fill:host.token('--rv-mesh-region-fill'),handle:host.token('--rv-mesh-handle'),ink:host.token('--rv-bust-ink'),labelBg:host.token('--rv-bust-label-bg')});
 const toWorld=(p:Point)=>{const m=host.mapping();return m.available?m.toWorld(p[0],p[1]):null;};
 const panel:MeshPanel={
  load(value,reason){meshes=value;loadReason=reason;const keep=part;part=null;pick(keep);},
  select:pick,
  part:()=>part,entry:()=>pending?structuredClone(pending):null,configEntry:()=>base?structuredClone(base):null,
  set(path,value){if(!pending)throw new Error('MESH_PANEL_NO_PART');change(setEntryValue(pending,path,value));},
  setEntry(entry){change(structuredClone(entry));},
  regions:{
   list:()=>pending?entryRegions(pending):[],
   add(region){if(!pending)throw new Error('MESH_PANEL_NO_PART');change(withRegions(pending,[...entryRegions(pending),region]));},
   move(region,vertex,to){if(!pending)throw new Error('MESH_PANEL_NO_PART');activeRegion=region;change(withRegions(pending,moveRegionPoint(entryRegions(pending),region,vertex,to)));},
   remove(index){if(!pending)return;change(withRegions(pending,entryRegions(pending).filter((_,i)=>i!==index)));},
   draw(on){dragging=on;placing=null;render();host.changed();},
   placing:()=>placing?placing.map(p=>[p[0],p[1]] as Point):null,
  },
  precheck:()=>pending&&part?precheckEntry(part,pending,host.bones()):[],
  restore(){const kept=parseMeshDraft(draft.value);if(kept&&kept.part===part&&base){pending=kept.entry;render();host.changed();}},
  status,
  counts(lines){countsArea.replaceChildren(...lines.map(l=>make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:l.label}),make('code',{textContent:l.text,title:l.text,className:l.error?'error':''}))));},
  readout(lines){readoutArea.replaceChildren(...lines.flatMap(l=>[make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'BEFORE'}),make('code',{textContent:l.before,title:l.before})),make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'AFTER'}),make('code',{textContent:l.after,title:l.after}))]));},
  busy(value){busy=value;render();},
  overlayRegions(){
   if(!pending||mode()!=='contour')return [];const c=colors();
   const out:OverlayRegion[]=[];
   entryRegions(pending).forEach((r,i)=>{if(r.shape!=='polygon')return;const points=r.points.map(toWorld);if(points.some(p=>!p))return;out.push({name:r.name,points:points as {x:number;y:number}[],stroke:c.stroke,fill:c.fill,handles:dragging||activeRegion===i,active:activeRegion===i&&drag?drag.vertex:null,colors:{handle:c.handle,ink:c.ink,labelBg:c.labelBg}});});
   if(placing&&placing.length){const points=placing.map(toWorld);if(points.every(Boolean))out.push({name:'new polygon',points:points as {x:number;y:number}[],stroke:c.stroke,fill:c.fill,handles:true,open:true,active:placing.length-1,colors:{handle:c.handle,ink:c.ink,labelBg:c.labelBg}});}
   return out;
  },
  overlayCircles(){
   if(!pending||mode()!=='contour')return [];const c=colors();
   return entryRegions(pending).flatMap((r,i)=>{if(r.shape!=='circle')return [];const at=toWorld([r.cx,r.cy]);if(!at)return [];
    // Crop px are world px under the crop mapping (a translation and a y flip), so r and band carry over as lengths.
    return [{center:at,r:r.r,band:r.band,label:`${r.name} → ${r.bone}`,labelRow:i,handles:dragging||activeRegion===i,colors:{stroke:c.stroke,fill:c.fill,handle:c.handle,ink:c.ink,labelBg:c.labelBg,flash:c.handle}}];});
  },
  dispose(){host.pane.removeEventListener('pointerdown',down,true);host.pane.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel'] as const)host.pane.removeEventListener(type,end,true);document.removeEventListener('keydown',keyDown,true);},
 };
 render();
 return panel;
}
