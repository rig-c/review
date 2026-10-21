/**
 * Animate · Physics tuning panel (#103), page side: the rows `tuningRows` reads, one row editor (sliders, number fields
 * and x / y / rotate toggles from `rowControls`), the chain ramp, the pending-ops list with per-op revert, Apply and
 * Reset, the Apply status and the check readout. The panel's inputs carry no ids, so the source draft keeps only the
 * pending-ops record (`#physics-pending`) and never counts a control per constraint.
 */
import {applyRamp,componentValue,draftEdits,draftText,nearestChain,patchOps,physicsChains,rowControls,setEdit,TUNING_FIELDS,COMPONENT_FIELDS,type PendingEdit,type PhysicsChain,type PhysicsField,type TuningRow,type TuningTable} from '../src/physics-tuning.ts';
import type {PatchOp} from '../src/config-patch.ts';
import type {PhysicsPreviewRead} from './preview.ts';

export interface PhysicsPanelDeps {
 apply:(ops:PatchOp[])=>Promise<void>;
 reset:()=>Promise<void>;
 /** Link bones as pane pixels on the drawn frame, for picking a chain on stage; null when nothing is drawn. */
 bonePoints:(bones:readonly string[])=>Map<string,{x:number;y:number}>|null;
 pane:HTMLElement;
 /** The draft record changed (the panel already wrote `#physics-pending`). */
 saved:()=>void;
 /** Pending six-field overrides only; the caller uses Play's public live API. */
 preview:(edits:readonly PendingEdit[])=>PhysicsPreviewRead[];
 previewRead:()=>PhysicsPreviewRead[];
}
export interface PhysicsPanel {
 load(table:TuningTable,bones:readonly {name:string;parent?:string|null}[]):void;
 rows():TuningRow[];chains():PhysicsChain[];edits():PendingEdit[];
 set(name:string,field:PhysicsField,value:number):void;
 ramp(chainId:string,field:PhysicsField,root:number,tip:number):void;
 select(name:string):void;
 restore():void;clear():void;
 clearPreview():void;refreshPreview():void;
 applied(ops:readonly PatchOp[]|null):void;
 status(text:string,error:boolean):void;
 readout(lines:{name:string;before:string;after:string}[]):void;
 busy(value:boolean):void;
 dispose():void;
}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const shown=(value:number|undefined)=>value===undefined?'—':String(Number(value.toPrecision(6)));

export function bindPhysicsPanel(deps:PhysicsPanelDeps):PhysicsPanel {
 const state=node('physics-panel-state'),rowsArea=node('physics-rows'),editor=node('physics-row-editor'),locked=node('physics-locked'),pending=node('physics-pending-list');
 const chainSelect=node<HTMLSelectElement>('physics-chain'),pick=node<HTMLButtonElement>('physics-chain-pick'),rampField=node<HTMLSelectElement>('physics-ramp-field'),rampRoot=node<HTMLInputElement>('physics-ramp-root'),rampTip=node<HTMLInputElement>('physics-ramp-tip'),rampButton=node<HTMLButtonElement>('physics-ramp');
 const applyButton=node<HTMLButtonElement>('physics-apply'),resetButton=node<HTMLButtonElement>('physics-reset-build'),status=node('physics-apply-status'),readoutArea=node('physics-readout'),draft=node<HTMLTextAreaElement>('physics-pending');
 const previewBox=document.querySelector<HTMLInputElement>('#physics-panel [data-physics-preview]')!,previewClear=node<HTMLButtonElement>('physics-preview-clear'),previewLabel=node('physics-preview-label');
 let table:TuningRow[]=[],chains:PhysicsChain[]=[],edits=new Map<string,PendingEdit>(),selected:string|null=null,appliedOps:string[]=[],busy=false,picking=false;
 rampField.replaceChildren(...[...TUNING_FIELDS,...COMPONENT_FIELDS].map(f=>make('option',{value:f,textContent:f})));
 rampField.value='damping';

 const save=()=>{draft.value=draftText(edits);draft.dispatchEvent(new Event('input',{bubbles:true}));deps.saved();};
 let previewActive=false;
 const change=(next:Map<string,PendingEdit>,live=false)=>{edits=next;save();drivePreview();if(live){renderRows();renderPending();}else render();};
 const tryChange=(make:()=>Map<string,PendingEdit>)=>{try{change(make());}catch(error){panelStatus(error instanceof Error?error.message:String(error),true);}};
 function panelStatus(text:string,error:boolean){status.textContent=text;status.title=text;status.classList.toggle('error',error);}
 const row=(name:string)=>table.find(r=>r.name===name&&r.configIndex!==null)??table.find(r=>r.name===name);
 function showPreview(reads:PhysicsPreviewRead[]){
  const message=reads.length?`preview — Apply decides · ${reads.map(({name,read})=>`${name}: pending ${JSON.stringify(read.override)} · last evaluated ${JSON.stringify(read.effective)}`).join(' · ')}`:'Preview off · mass and x/y/rotate require Apply. Clear resumes authored values on the next evaluation; integrated history is kept.';
  if(message!==previewLabel.textContent){previewLabel.textContent=message;previewLabel.title=message;}
  previewLabel.classList.remove('error');
 }
 function drivePreview(){
  try{
   const reads=deps.preview(previewBox.checked&&!busy?[...edits.values()].filter(e=>!appliedOps.includes(JSON.stringify({op:e.op,path:e.path,value:e.value,name:e.name}))):[]);
   previewActive=reads.length>0;showPreview(reads);
  }catch(error){previewActive=false;previewLabel.textContent=error instanceof Error?error.message:String(error);previewLabel.title=previewLabel.textContent;previewLabel.classList.add('error');}
 }
 function clearPreview(){deps.preview([]);previewActive=false;showPreview([]);}
 previewBox.onchange=()=>drivePreview();
 previewClear.onclick=()=>{previewBox.checked=false;clearPreview();};

 function renderRows(){
  const editable=table.filter(r=>r.editable);
  const head=make('tr',{},...['Constraint','#',...TUNING_FIELDS,'x','y','rotate'].map(label=>make('th',{scope:'col',textContent:label})));
  const body=make('tbody');
  for(const r of editable){
   const current=(field:PhysicsField)=>edits.get(`/constraints/${r.configIndex}/${field}`)?.value;
   const name=make('button',{type:'button',textContent:r.name,className:'physics-row-pick',title:`config.constraints[${r.configIndex}] · bone ${r.bone??'—'}`});name.setAttribute('aria-pressed',String(selected===r.name));
   name.onclick=()=>{selected=r.name;render();};
   const cells=[...TUNING_FIELDS,...COMPONENT_FIELDS].map(field=>{const now=current(field),cell=make('td',{textContent:shown(now??r.values[field])});if(now!==undefined)cell.className='pending';else if(r.values[field]===undefined){cell.className='absent';cell.title='Not in the config (the producer default applies)';}return cell;});
   const line=make('tr',{},make('th',{scope:'row'},name),make('td',{textContent:String(r.configIndex)}),...cells);if(selected===r.name)line.className='selected';body.append(line);
  }
  rowsArea.replaceChildren(make('table',{className:'physics-table'},make('thead',{},head),body));
  const others=table.filter(r=>!r.editable);
  const lockedBody=make('tbody');
  for(const r of others){const line=make('tr',{},make('th',{scope:'row',textContent:r.name}),make('td',{textContent:r.kind}),make('td',{className:'physics-reason',textContent:r.reason??''}));line.dataset.notEditable='true';lockedBody.append(line);}
  locked.replaceChildren(make('p',{className:'eyebrow',textContent:`NOT EDITABLE · ${others.length}`}),make('table',{className:'physics-table physics-locked-table'},make('thead',{},make('tr',{},...['Constraint','Kind','Reason'].map(l=>make('th',{scope:'col',textContent:l})))),lockedBody));
  locked.hidden=!others.length;
 }
 function renderEditor(){
  const r=selected?row(selected):undefined;
  if(!r){editor.replaceChildren(make('p',{className:'hint',textContent:'Pick a constraint row or a chain to edit it.'}));return;}
  const view=rowControls(r,edits),title=make('p',{className:'physics-editor-title'},make('strong',{textContent:r.name}),` · ${r.kind} · bone ${r.bone??'—'} · ${r.configIndex===null?'not in the config':`/constraints/${r.configIndex}`}`);
  if(!view.editable){const reason=make('p',{className:'hint error physics-reason',textContent:view.reason});editor.replaceChildren(title,reason);return;}
  const list=make('div',{className:'physics-controls'});
  for(const control of view.controls){
   if(control.kind==='slider'){
    const label=`${r.name} ${control.field}`;
    const range=make('input',{type:'range',min:String(control.min),max:String(control.max),step:String(control.step),value:String(control.value),disabled:busy});range.setAttribute('aria-label',label);range.dataset.field=control.field;
    const number=make('input',{type:'number',step:'any',value:String(control.value),disabled:busy,inputMode:'decimal'});number.setAttribute('aria-label',`${label} value`);number.dataset.field=control.field;
    const commit=(raw:string,live=false)=>{const value=Number(raw);if(raw.trim()===''||!Number.isFinite(value)){panelStatus(`PHYSICS_VALUE_INVALID: ${r.name}.${control.field} must be a finite number`,true);return;}try{change(setEdit(edits,r,control.field,value),live);}catch(error){panelStatus(error instanceof Error?error.message:String(error),true);}};
    range.onchange=()=>commit(range.value);range.oninput=()=>{number.value=range.value;commit(range.value,true);};number.onchange=()=>commit(number.value);
    list.append(make('label',{className:control.pending?'physics-control pending':'physics-control'},make('span',{textContent:control.field}),range,number,make('output',{textContent:control.pending?`was ${shown(control.base)}`:''})));
   }else{
    const box=make('input',{type:'checkbox',checked:control.on,disabled:busy});box.setAttribute('aria-label',`${r.name} ${control.field} component`);box.dataset.field=control.field;
    box.onchange=()=>tryChange(()=>setEdit(edits,r,control.field,componentValue(r,control.field,box.checked)));
    list.append(make('label',{className:control.pending?'physics-toggle pending':'physics-toggle'},box,`${control.field}${control.base===null?'':` (${shown(control.base)})`}`));
   }
  }
  editor.replaceChildren(title,list);
 }
 function renderPending(){
  const items=[...edits.values()];
  pending.replaceChildren(...items.map(e=>{
   const revert=make('button',{type:'button',textContent:'Revert',disabled:busy});revert.setAttribute('aria-label',`Revert ${e.path}`);
   revert.onclick=()=>{const next=new Map(edits);next.delete(e.path);change(next);};
   const applied=appliedOps.includes(JSON.stringify({op:e.op,path:e.path,value:e.value,name:e.name}));
   return make('li',{className:applied?'applied':''},make('code',{textContent:`${e.op} ${e.path}`}),` ${e.from===null?'(absent)':shown(e.from)} → ${shown(e.value)} · ${e.name}${applied?' · applied':''}`,revert);
  }));
  if(!items.length)pending.append(make('li',{className:'hint',textContent:'No pending ops.'}));
  applyButton.disabled=busy||!items.length;resetButton.disabled=busy;
 }
 function renderChains(){
  const keep=chainSelect.value;
  chainSelect.replaceChildren(make('option',{value:'',textContent:chains.length?'Select a chain':'No chain of two or more links'}),...chains.map(c=>make('option',{value:c.id,textContent:c.label})));
  if(chains.some(c=>c.id===keep))chainSelect.value=keep;
  for(const control of [chainSelect,rampField,rampRoot,rampTip,rampButton,pick])control.disabled=busy||!chains.length;
 }
 function render(){renderRows();renderEditor();renderPending();renderChains();previewBox.disabled=busy;previewClear.disabled=busy;}

 chainSelect.onchange=()=>{const chain=chains.find(c=>c.id===chainSelect.value);if(chain){selected=chain.links[0]!.name;seedRamp(chain);render();}};
 rampField.onchange=()=>{const chain=chains.find(c=>c.id===chainSelect.value);if(chain)seedRamp(chain);};
 function seedRamp(chain:PhysicsChain){const field=rampField.value as PhysicsField,value=(r:TuningRow)=>edits.get(`/constraints/${r.configIndex}/${field}`)?.value??r.values[field];const root=value(chain.links[0]!),tip=value(chain.links.at(-1)!);rampRoot.value=root===undefined?'':String(root);rampTip.value=tip===undefined?'':String(tip);}
 rampButton.onclick=()=>{const chain=chains.find(c=>c.id===chainSelect.value);if(!chain){panelStatus('PHYSICS_CHAIN_NONE: select a chain first',true);return;}
  const root=Number(rampRoot.value),tip=Number(rampTip.value);if(!rampRoot.value.trim()||!rampTip.value.trim()||!Number.isFinite(root)||!Number.isFinite(tip)){panelStatus('PHYSICS_VALUE_INVALID: the ramp needs a finite root and tip value',true);return;}
  tryChange(()=>applyRamp(edits,chain,rampField.value as PhysicsField,root,tip));panelStatus(`Ramped ${rampField.value} over ${chain.links.length} links (${root} → ${tip}); Apply rebuilds.`,false);};
 pick.onclick=()=>{picking=!picking;pick.setAttribute('aria-pressed',String(picking));deps.pane.dataset.physicsPick=String(picking);panelStatus(picking?'Click a chain on the stage (a link bone within 24 px).':'',false);};
 const onPick=(event:PointerEvent)=>{
  if(!picking||event.button!==0)return;
  const points=deps.bonePoints(chains.flatMap(c=>c.links.map(l=>l.bone!)));if(!points)return;
  const box=deps.pane.getBoundingClientRect(),chain=nearestChain(chains,points,{x:event.clientX-box.left,y:event.clientY-box.top});
  event.stopPropagation();event.preventDefault();picking=false;pick.setAttribute('aria-pressed','false');deps.pane.dataset.physicsPick='false';
  if(!chain){panelStatus('PHYSICS_CHAIN_NONE: no chain link bone within 24 px of the click',true);return;}
  chainSelect.value=chain.id;chainSelect.dispatchEvent(new Event('change'));panelStatus(`Picked ${chain.label}.`,false);
 };
 deps.pane.addEventListener('pointerdown',onPick,{capture:true});
 applyButton.onclick=()=>{if(!edits.size||busy)return;clearPreview();void deps.apply(patchOps(edits));};
 resetButton.onclick=()=>{if(busy)return;void deps.reset();};

 const panel:PhysicsPanel={
  load(value,bones){
   if(!value.available){clearPreview();table=[];chains=[];edits=new Map();state.textContent=value.reason;state.classList.add('error');render();return;}
   table=value.rows;chains=physicsChains(table,bones);
   const editable=table.filter(r=>r.editable).length;
   state.classList.remove('error');state.textContent=`${editable} physics constraints editable from the handoff config · ${table.length-editable} not editable (reasons below) · ${chains.length} chains from bone parentage`;
   edits=draftEdits(draft.value,table);if(previewActive)drivePreview();render();
  },
  rows:()=>table.map(r=>({...r,values:{...r.values}})),chains:()=>chains.map(c=>({...c,links:[...c.links]})),edits:()=>[...edits.values()].map(e=>({...e})),
  set(name,field,value){const r=row(name);if(!r)throw new Error(`PHYSICS_ROW_UNKNOWN: ${name}`);change(setEdit(edits,r,field,value));},
  ramp(chainId,field,root,tip){const chain=chains.find(c=>c.id===chainId);if(!chain)throw new Error(`PHYSICS_CHAIN_UNKNOWN: ${chainId}`);change(applyRamp(edits,chain,field,root,tip));},
  select(name){selected=name;chainSelect.value='';render();},
  restore(){clearPreview();edits=draftEdits(draft.value,table);render();},
  clear(){change(new Map());},
  clearPreview,
  refreshPreview(){if(previewActive)try{showPreview(deps.previewRead());}catch(error){previewLabel.textContent=error instanceof Error?error.message:String(error);previewLabel.classList.add('error');}},
  applied(ops){appliedOps=(ops??[]).map(o=>JSON.stringify({op:o.op,path:o.path,value:o.value,name:o.name}));renderPending();},
  status:panelStatus,
  readout(lines){readoutArea.replaceChildren(...lines.flatMap(l=>[make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'BEFORE'}),make('code',{textContent:l.before,title:l.before})),make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:'AFTER'}),make('code',{textContent:l.after,title:l.after}))]));},
  busy(value){busy=value;render();},
  dispose(){clearPreview();deps.pane.removeEventListener('pointerdown',onPick,{capture:true});},
 };
 showPreview([]);render();
 return panel;
}
