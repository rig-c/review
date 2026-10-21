/**
 * Setup · Cloth (#111), page side: one form per cloth tag the installed reader accepts, holding the recipe's fields as
 * the producer config states them, and a link preview on the stage — each chain the tag's parts are meshed on, drawn
 * from its config `points` and `tip` in rig px of the setup pose (the crop → world mapping the cuts, chest and bones
 * views use). Every change is a config patch op at `/cloth/<tag>/…` (`src/cloth-recipe.ts`); Apply sends them as one
 * `rig` patch, which the server runs as `rig-parts propose --cloth … --write-config` and then builds the written config
 * (`build` when the config declares limbs, else `rig --config`); the scratch build reloads in place under the stage's
 * Environment. After an Apply the preview adds the chains of the config the producer wrote. The producer's refusals
 * (`CONFIG_CLOTH_*`, `PROPOSE_CLOTH_DRAFTED`, `PROPOSE_CLOTH_PART`, `PROPOSE_WRITE_CONFIG_*`) come back verbatim.
 * Hand-editing the drafted constraints is the physics block's, after the draft. The draft keeps the pending edits
 * (`#cloth-pending`).
 */
import {ClothFieldError,fieldText,recipeFromFields,recipeOps,RECIPE_FIELDS,type ClothTagView,type RecipeField} from '../src/cloth-recipe.ts';
import type {PatchOp} from '../src/config-patch.ts';
import {itemApplied} from '../src/applied-blocks.ts';
import type {CropWorldMapping} from '../src/chest-regions.ts';
import type {OverlayPoint,OverlayProject,OverlayRegion} from './rig-overlays.ts';
import type {ClothStatusView,PatchJobView,RebuildRefusal} from './rebuild-client.ts';

export interface ClothPanelDeps {
 project:()=>OverlayProject|null;mapping:()=>CropWorldMapping;inspector:()=>string|undefined;
 pause:()=>void;changed:()=>void;saved:()=>void;
 apply:(ops:PatchOp[])=>Promise<PatchJobView|RebuildRefusal|null>;
 reset:()=>Promise<void>;
 token:(name:string)=>string;
}
export interface ClothPanel {
 load(status:ClothStatusView|null,reason:string|null):void;
 tag():string;select(tag:string):void;
 values(tag?:string):Record<string,string>;set(key:string,text:string,tag?:string):void;declare(on:boolean,tag?:string):void;
 ops():PatchOp[];
 active():boolean;setActive(on:boolean):void;
 overlayRegions():OverlayRegion[];
 links():{tag:string;inspected:ClothTagView|null;drafted:ClothTagView|null};
 apply():Promise<PatchJobView|RebuildRefusal|null>;
 shown(job:PatchJobView|RebuildRefusal|null):void;
 /** #172: the ops of the stage's applied record this block owns (`appliedBlockOps`); a pending op among them is marked applied. */
 applied(ops:readonly PatchOp[]|null):void;
 /** #172: the pending ops marked applied, by their op line. */
 appliedItems():string[];
 status(text:string,error:boolean):void;busy(value:boolean):void;
 restore():void;clear():void;sync():void;dispose():void;
}
const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function bindClothPanel(deps:ClothPanelDeps):ClothPanel {
 const state=node('cloth-panel-state'),toggle=node<HTMLButtonElement>('cloth-links'),picker=node<HTMLSelectElement>('cloth-tag'),declared=node<HTMLInputElement>('cloth-declared'),fields=node('cloth-fields'),pending=node('cloth-pending-list');
 const applyButton=node<HTMLButtonElement>('cloth-apply'),resetButton=node<HTMLButtonElement>('cloth-reset'),statusOut=node('cloth-status'),readout=node('cloth-readout'),draft=node<HTMLTextAreaElement>('cloth-pending');
 let status:ClothStatusView|null=null,reason:string|null=null,selected='',active=false,busy=false,appliedOps:PatchOp[]=[];
 /** Per touched tag: every form field's text, and whether the tag's recipe is declared. */
 let edits=new Map<string,{declared:boolean;values:Record<string,string>}>();
 let drafted:ClothTagView[]=[];

 const panelStatus=(text:string,error:boolean)=>{statusOut.textContent=text;statusOut.title=text;statusOut.classList.toggle('error',error);};
 const recipe=(tag:string)=>isObject(status?.recipes)?status!.recipes![tag]:undefined;
 const initial=(tag:string)=>({declared:recipe(tag)!==undefined,values:Object.fromEntries(RECIPE_FIELDS.map(f=>[f.key,fieldText(recipe(tag),f)]))});
 const current=(tag:string)=>edits.get(tag)??initial(tag);
 const touched=(tag:string)=>{const e=edits.get(tag),i=initial(tag);return !!e&&(e.declared!==i.declared||RECIPE_FIELDS.some(f=>(e.values[f.key]??'')!==(i.values[f.key]??'')));};
 const save=()=>{draft.value=JSON.stringify({cloth:Object.fromEntries([...edits].filter(([tag])=>touched(tag)))});draft.dispatchEvent(new Event('input',{bubbles:true}));deps.saved();};
 /** Every pending op, tag by tag in the reader's order; a field that does not read is named and stops the list. */
 function allOps():PatchOp[] {
  const config={cloth:status?.recipes??undefined},out:PatchOp[]=[];
  for(const tag of status?.targets??[]){if(!touched(tag))continue;const e=current(tag);out.push(...recipeOps(config,tag,e.declared?recipeFromFields(e.values):null));}
  return out;
 }
 const change=()=>{save();render();deps.changed();};

 function renderFields(){
  const tag=selected,e=current(tag),pendingKeys=new Set(edits.has(tag)?RECIPE_FIELDS.filter(f=>(e.values[f.key]??'')!==(initial(tag).values[f.key]??'')).map(f=>f.key):[]);
  declared.checked=e.declared;declared.disabled=busy||!tag;
  const input=(f:RecipeField)=>{
   const value=e.values[f.key]??'';let control:HTMLInputElement|HTMLSelectElement;
   if(f.kind==='bool'||f.kind==='shape'){const options=f.kind==='bool'?['','true','false']:['','linear','smooth'];control=make('select',{},...options.map(o=>make('option',{value:o,textContent:o||'(absent)'})));control.value=value;}
   else control=make('input',{type:'text',value,autocomplete:'off',inputMode:f.kind==='names'?'text':'decimal',placeholder:f.kind==='pair'?'root, tip':f.kind==='list'||f.kind==='names'?'a, b, …':'(absent)'});
   control.disabled=busy||!e.declared;control.dataset.clothField=f.key;control.setAttribute('aria-label',`${tag} ${f.label}`);
   control.onchange=()=>{panel.set(f.key,control.value);};
   return make('label',{className:pendingKeys.has(f.key)?'cloth-field pending':'cloth-field'},make('span',{textContent:f.label+(f.required?' *':'')}),control,make('code',{textContent:`/cloth/${tag}/${f.path.join('/')}`}));
  };
  fields.replaceChildren(...(tag?RECIPE_FIELDS.map(input):[make('p',{className:'hint',textContent:'No tag to edit.'})]));
 }
 function renderPending(){
  let ops:PatchOp[]=[],error:string|null=null;
  try{ops=allOps();}catch(err){if(err instanceof ClothFieldError)error=err.message;else throw err;}
  // #172: an op is marked applied only while the stage's applied record holds it.
  const items=ops.map(o=>{const on=itemApplied([o],appliedOps);return make('li',{className:on?'applied':''},make('code',{textContent:`${o.op} ${o.path}`}),`${o.op==='remove'?'':` → ${JSON.stringify(o.value)}`}${on?' · applied':''}`);});
  const revert=[...edits.keys()].filter(touched).map(tag=>{const b=make('button',{type:'button',textContent:`Revert ${tag}`,disabled:busy});b.onclick=()=>{edits.delete(tag);change();};return make('li',{},b);});
  pending.replaceChildren(...(error?[make('li',{className:'error',textContent:error})]:[]),...(items.length?items:[make('li',{className:'hint',textContent:'No pending ops.'})]),...revert);
  applyButton.disabled=busy||!items.length||!!error||!!reason||!!status?.reason;resetButton.disabled=busy;
  toggle.disabled=!status;toggle.setAttribute('aria-pressed',String(active));
 }
 function renderPicker(){
  const tags=status?.targets??[];
  picker.replaceChildren(...tags.map(t=>make('option',{value:t,textContent:`${t}${recipe(t)===undefined?' (no recipe)':''}${touched(t)?' · pending':''}`})));
  if(!tags.includes(selected))selected=tags[0]??'';picker.value=selected;picker.disabled=busy||!tags.length;
 }
 function renderState(){
  if(!status){state.textContent=reason??'CLOTH_UNAVAILABLE: no producer handoff';state.classList.add('error');return;}
  const view=status.tags.find(t=>t.tag===selected),mapping=deps.mapping();
  state.classList.toggle('error',!!status.reason||!mapping.available);
  state.textContent=`${status.targets.length} tag(s) the installed reader accepts${status.targetsRead?'':' (its list was not readable: the tags the config declares)'} · ${selected||'—'}: ${view?`${view.parts.length} part(s) (${view.parts.join(', ')||'none'}), ${view.chains.length} chain(s) in the config`:'—'} · built by ${status.route==='build'?'rig-parts build (the config declares limbs)':'rig --config'}${status.keypoints?` · keypoints ${status.keypoints.path}`:''}${status.reason?` · Apply: ${status.reason}`:''}${mapping.available?'':` · ${mapping.reason}: no links are drawn`}`;
 }
 function render(){renderPicker();renderFields();renderPending();renderState();}

 const setActive=(on:boolean)=>{active=on&&!!status;if(active)deps.pause();render();deps.changed();};
 toggle.onclick=()=>setActive(!active);
 picker.onchange=()=>{selected=picker.value;render();deps.changed();};
 declared.onchange=()=>panel.declare(declared.checked);
 applyButton.onclick=()=>{void panel.apply();};
 resetButton.onclick=()=>{if(!busy)void deps.reset();};
 const observer=new MutationObserver(()=>panel.sync());
 for(const selector of document.querySelectorAll('[data-inspector]'))observer.observe(selector,{attributes:true,attributeFilter:['aria-pressed','aria-selected']});
 const colors=()=>({stroke:deps.token('--rv-mesh-region'),fill:'transparent',handle:deps.token('--rv-mesh-handle'),ink:deps.token('--rv-bone-ink'),labelBg:deps.token('--rv-bone-label-bg'),pending:deps.token('--rv-bone-pending')});
 const world=(p:[number,number])=>{const m=deps.mapping();return m.available?m.toWorld(p[0],p[1]):null;};
 const restore=()=>{
  let doc:unknown=null;try{doc=JSON.parse(draft.value||'null');}catch{doc=null;}
  edits=new Map();
  const kept=isObject(doc)&&isObject(doc.cloth)?doc.cloth:{};
  for(const [tag,v] of Object.entries(kept))if((status?.targets??[]).includes(tag)&&isObject(v)&&typeof v.declared==='boolean'&&isObject(v.values))edits.set(tag,{declared:v.declared,values:Object.fromEntries(RECIPE_FIELDS.map(f=>[f.key,typeof (v.values as Record<string,unknown>)[f.key]==='string'?(v.values as Record<string,string>)[f.key]!:'']))});
 };

 const panel:ClothPanel={
  load(next,why){status=next;reason=next?null:why;drafted=[];if(!next)active=false;restore();render();deps.changed();},
  tag:()=>selected,
  select(tag){selected=tag;render();deps.changed();},
  values:(tag=selected)=>({...current(tag).values}),
  set(key,text,tag=selected){const f=RECIPE_FIELDS.find(x=>x.key===key);if(!f)throw new Error(`CLOTH_FIELD_UNKNOWN: ${key}`);const e=current(tag);edits.set(tag,{declared:e.declared,values:{...e.values,[key]:text}});change();},
  declare(on,tag=selected){const e=current(tag);edits.set(tag,{declared:on,values:{...e.values}});change();},
  ops:allOps,
  active:()=>active,setActive,
  links(){return {tag:selected,inspected:status?.tags.find(t=>t.tag===selected)??null,drafted:drafted.find(t=>t.tag===selected)??null};},
  overlayRegions(){
   if(!active||!status)return [];const c=colors(),out:OverlayRegion[]=[];
   // One label per set (the first chain carries it); every link joint is a handle square.
   const draw=(view:ClothTagView|undefined,stroke:string,label:string)=>{let first=true;for(const chain of view?.chains??[]){const w=chain.points.map(world);if(w.some(p=>!p))continue;out.push({name:first?label:'',points:w as OverlayPoint[],stroke,fill:c.fill,handles:true,open:true,active:null,colors:{handle:stroke,ink:c.ink,labelBg:c.labelBg}});first=false;}};
   const inspected=status.tags.find(t=>t.tag===selected),written=drafted.find(t=>t.tag===selected);
   // The written chains are drawn over the config's; when they are the same links, one label says so.
   const same=!!written&&JSON.stringify(written.chains)===JSON.stringify(inspected?.chains??[]);
   draw(inspected,c.stroke,`${selected} · ${inspected?.chains.length??0} chain(s) · config${same?' = written':''}`);
   if(!same)draw(written,c.pending,`${selected} · ${written?.chains.length??0} chain(s) · written`);
   return out;
  },
  async apply(){
   let ops:PatchOp[];try{ops=allOps();}catch(err){if(err instanceof ClothFieldError){panelStatus(err.message,true);return null;}throw err;}
   if(!ops.length||busy){panelStatus('CLOTH_NOTHING_PENDING: no pending ops',true);return null;}
   const result=await deps.apply(ops);panel.shown(result);return result;
  },
  shown(job){
   if(!job){readout.replaceChildren();drafted=[];deps.changed();return;}
   const lines:HTMLElement[]=[],line=(label:string,text:string,error=false)=>lines.push(make('div',{className:'physics-readout-line'},make('span',{className:'eyebrow',textContent:label}),make('code',{textContent:text,title:text,className:error?'error':''})));
   if(!('id' in job)){line('REFUSED',job.error,true);readout.replaceChildren(...lines);return;}
   const c=job.cloth;
   for(const r of c?.refusals??[])line('REFUSED',r,true);
   if(c?.line)line('WROTE',c.line);
   if(c?.written){line('WRITTEN DIFF',`${c.written.count} path(s) against cloth.json${c.written.sections.length?` · ${c.written.sections.join(', ')}`:''}${c.written.outside.length?` · outside the drafted sections: ${c.written.outside.slice(0,8).join(', ')}`:' · every one under the drafted sections'}`,c.written.outside.length>0);for(const p of c.written.paths.slice(0,12))line('PATH',p);}
   if(c)line('ROUTE',c.route==='build'?'rig-parts build --config config.json (the config declares limbs)':'rig-parts rig --config config.json');
   for(const r of job.assembled?.refusals??[])line('REFUSED',r,true);
   for(const r of job.assembled?.checkFails??[])line('CHECK FAIL',r,true);
   if(job.status!=='built'&&job.producerLine&&!(c?.refusals??[]).length)line('REFUSED',job.producerLine,true);
   if(job.status==='built'&&job.check?.line)line('CHECK',job.check.line,job.check.pass!==true);
   drafted=job.status==='built'&&c?c.links:[];
   readout.replaceChildren(...lines);deps.changed();
  },
  applied(ops){appliedOps=(ops??[]).map(o=>({...o}));renderPending();},
  appliedItems(){return [...pending.querySelectorAll('li.applied code')].map(c=>c.textContent??'');},
  status:panelStatus,
  busy(value){busy=value;render();},
  restore(){restore();render();deps.changed();},
  clear(){edits=new Map();change();},
  sync(){renderState();if(active&&deps.inspector()!=='rig')setActive(false);},
  dispose(){observer.disconnect();},
 };
 render();
 return panel;
}
