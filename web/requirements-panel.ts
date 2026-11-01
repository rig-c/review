/**
 * Animate · Requirements (#113), page side: declare what the scene asks of the motion — pick a slot (its mesh
 * attachment, its bone) on the stage or by name, an animation and a kind, then set the bar with a slider that shows the
 * last measured value — and Check: review writes the `spine-parts-requirements/1` file and the installed producer's
 * `rig-parts check --requirements` measures it, on the inspected rig or the latest scratch build. Each requirement gets
 * one line with its worst frame, a button that seeks there; `REQUIREMENTS_*` refusals and `CHECK_REQUIREMENT_*` lines are
 * shown verbatim. The file rides submitted feedback by hash and content (`context.requirements`).
 * A kind the rig cannot offer (no mesh slot, no ik or transform constraint, fewer than two slots) is disabled with the
 * reason. Scene targets, stage-point targets, the part exception lists and waivers (`may_fold`) are not written here.
 */
import {KIND_FIELDS,REQUIREMENT_KINDS,REQUIREMENT_NAME,REQUIREMENTS_CONTEXT_SCHEMA,requirementEntry,requirementsDocument,requirementsFileText,type BonePoint,type Requirement,type RequirementKind,type RequirementRow,type RequirementsBuild,type RequirementsContext} from '../src/requirements.ts';

export interface RequirementsCatalogView {status:'ready'|'unavailable';reason:string|null;bones:string[];slots:string[];meshes:Record<string,string[]>;slotBones:Record<string,string>;constraints:{name:string;type:'ik'|'transform';bones:string[];drives:string[]}[];animations:{name:string;duration:number|null}[];scratch:string|null}
export interface RequirementsJobView {id:string;status:'running'|'checked'|'refused'|'failed';build:RequirementsBuild;buildId:string|null;file:{sha256:string;size:number;text:string};producer:{package:string;version:string};exitCode:number|null;wallMs:number|null;rows:RequirementRow[];summary:string|null;checkLine:string|null;refusals:string[];problems:string[];error:string|null;lines:string[]}
export interface RequirementsRefusal {status:'refused';error:string}
export interface RequirementsPanelDeps {
 /** Runs the check of this file text's requirements; the panel shows what comes back. */
 check:(body:{fps:number;build:RequirementsBuild;requirements:Record<string,unknown>[]})=>Promise<RequirementsJobView|RequirementsRefusal|null>;
 seek:(animation:string,frame:number,time:number|null,label:string)=>void;
 /** The drawn animation and the slot picked on the stage. */
 animation:()=>string;slot:()=>string|null;
 /** The file's sha256 (hex) for the feedback context. */
 hash:(text:string)=>Promise<string>;
}
export interface RequirementsPanel {
 load(catalog:RequirementsCatalogView|null,reason:string|null):void;
 /** Prefill the subject from the stage's selection. */
 selectionChanged():void;
 requirements():Requirement[];
 add(r:Requirement):void;remove(name:string):void;setBar(name:string,field:string,value:number):void;
 text():string|null;
 checked(job:RequirementsJobView|RequirementsRefusal|null):void;
 context():RequirementsContext|null;
 shownLines():string[];
}
/** A kind the catalog cannot offer, and why; null when it can. */
export function kindUnavailable(kind:RequirementKind,c:Pick<RequirementsCatalogView,'bones'|'slots'|'meshes'|'constraints'>):string|null {
 if(kind==='stretch'&&!Object.values(c.meshes).some(list=>list.length))return 'no slot of the rig spec holds a mesh attachment';
 if(kind==='follow'&&!c.constraints.length)return 'the rig spec declares no ik or transform constraint';
 if(kind==='seam'&&c.slots.length<2)return 'a seam needs two slots';
 if((kind==='contact'||kind==='aim'||kind==='range')&&!c.bones.length)return 'the rig spec declares no bone';
 return null;
}
/** Each kind's bar fields and the slider's span; the span grows to hold a measured value past it. */
export const BAR_FIELDS:Record<RequirementKind,{field:string;min:number;max:number;step:number;initial:number}[]>={
 contact:[{field:'within_px',min:0,max:50,step:.1,initial:1}],
 aim:[{field:'within_degrees',min:0,max:180,step:.5,initial:5}],
 range:[{field:'lo_degrees',min:-180,max:180,step:1,initial:-45},{field:'hi_degrees',min:-180,max:180,step:1,initial:45}],
 stretch:[{field:'within_ratio',min:1,max:3,step:.01,initial:1.3}],
 follow:[{field:'fraction',min:-1,max:2,step:.01,initial:.5}],
 seam:[{field:'within_px',min:0,max:20,step:.1,initial:1}],
};
/** A requirement name the reader takes, unique among `taken`: `KIND_SUBJECT`, then `_2`, `_3`… */
export function requirementName(kind:RequirementKind,subject:string,taken:readonly string[]):string {
 let base=`${kind}_${subject}`.toUpperCase().replace(/[^A-Z0-9_]+/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');if(!/^[A-Z]/.test(base))base=`R_${base}`;
 let name=base;for(let n=2;taken.includes(name);n++)name=`${base}_${n}`;return name;
}
/**
 * A contact against its own bone and point, or an aim at its own bone, measures 0 by construction and the producer
 * reports it as PASS (rig-c/review#142; the reader's refusal is asked in rig-c/parts#540). Refused here by name.
 */
export function selfTargetRefusal(r:{kind:RequirementKind;bone?:string;point?:BonePoint;target?:{bone:string;point:BonePoint}}):string|null {
 if(!r.target||!r.bone)return null;
 if(r.kind==='contact'&&r.target.bone===r.bone&&r.target.point===r.point)return `REQUIREMENTS_SELF_TARGET: contact of bone "${r.bone}" ${r.point} against itself measures 0 in every frame; pick another bone or point`;
 if(r.kind==='aim'&&r.target.bone===r.bone)return `REQUIREMENTS_SELF_TARGET: aim of bone "${r.bone}" at its own ${r.target.point} has no line to measure; pick another target bone`;
 return null;
}
/** The catalog the form renders from: only a ready rig spec. An unavailable one (no producer handoff) is no catalog, so picking a part with no handoff never renders fields from it (#150). */
export function readyCatalog<C extends {status:'ready'|'unavailable'}>(next:C|null):C|null {return next&&next.status==='ready'?next:null;}
/** The target a fresh form proposes: a bone other than the subject (the next one in rig order, else the first other one). */
export function defaultTargetBone(bones:readonly string[],subject:string):string|null {
 const i=bones.indexOf(subject),next=i>=0?bones.slice(i+1).find(b=>b!==subject):undefined;
 return next??bones.find(b=>b!==subject)??null;
}
/** The measured figure a bar field is read against, from a row. */
export function measuredFor(row:RequirementRow|undefined,field:string):number|null {
 if(!row)return null;if(field==='lo_degrees')return row.least;if(field==='hi_degrees')return row.greatest;return row.measured;
}

const node=<T extends HTMLElement>(id:string)=>{const found=document.getElementById(id);if(!found)throw new Error(`Missing UI element: ${id}`);return found as T;};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,props:Record<string,unknown>={},...children:(Node|string)[]):HTMLElementTagNameMap[K]=>{const item=document.createElement(tag);Object.assign(item,props);item.append(...children);return item;};
const options=(select:HTMLSelectElement,values:readonly string[],label=(v:string)=>v)=>{const keep=select.value;select.replaceChildren(...values.map(v=>make('option',{value:v,textContent:label(v)})));if(values.includes(keep))select.value=keep;};
const labelled=(text:string,control:HTMLElement)=>make('label',{},text,control);

export function bindRequirementsPanel(deps:RequirementsPanelDeps):RequirementsPanel {
 const body=node('requirements-body');
 const state=make('p',{className:'hint',id:'requirements-state',textContent:'Reading the producer handoff…'});
 const kind=make('select',{id:'requirements-kind'}),animation=make('select',{id:'requirements-animation'});
 const fields=make('div',{className:'requirements-fields',id:'requirements-fields'}),note=make('p',{className:'hint',id:'requirements-note'});
 const name=make('input',{type:'text',id:'requirements-name',autocomplete:'off',placeholder:'NAME (letters, digits, _)'});
 const add=make('button',{type:'button',id:'requirements-add',textContent:'Add requirement'});
 const list=make('ol',{className:'requirements-list',id:'requirements-list'});
 const build=make('select',{id:'requirements-build'}),fps=make('input',{type:'number',id:'requirements-fps',min:'1',max:'240',step:'1',value:'12'});
 const check=make('button',{type:'button',id:'requirements-check',className:'primary',textContent:'Check',disabled:true});
 const status=make('output',{id:'requirements-status',className:'environment-readout'}),refusals=make('ul',{className:'requirements-refusals',id:'requirements-refusals'}),summary=make('p',{className:'hint',id:'requirements-summary'});
 options(build,['inspected','scratch'],v=>v==='inspected'?'Inspected rig':'Latest scratch build');
 body.replaceChildren(state,make('div',{className:'row'},labelled('Kind ',kind),labelled('Animation ',animation)),fields,note,make('div',{className:'row'},name,add),list,
  make('div',{className:'row'},labelled('Check on ',build),labelled('fps ',fps),check),status,refusals,summary);
 let catalog:RequirementsCatalogView|null=null,declared:Requirement[]=[],job:RequirementsJobView|null=null,busy=false,shown:string[]=[];
 let hashed:{text:string;sha256:string}|null=null;
 const controls:Record<string,HTMLSelectElement|HTMLInputElement>={};

 const sel=(id:string,values:readonly string[],label?:(v:string)=>string)=>{const s=make('select',{id:`requirements-${id}`});options(s,values,label);controls[id]=s;return s;};
 const numberField=(id:string,value:number,min?:number)=>{const i=make('input',{type:'number',id:`requirements-${id}`,value:String(value),step:'any',...(min===undefined?{}:{min:String(min)})});controls[id]=i;return i;};
 /** The subject inputs for the chosen kind, prefilled from the stage's slot (its bone, its mesh). */
 function renderFields(){
  fields.replaceChildren();for(const k of Object.keys(controls))delete controls[k];
  if(!catalog)return;
  const k=kind.value as RequirementKind,slot=deps.slot(),slotBone=slot?catalog.slotBones[slot]??null:null;
  const bones=catalog.bones,points=['origin','tip'];
  const pickBone=(id:string)=>{const s=sel(id,bones);if(slotBone&&bones.includes(slotBone))s.value=slotBone;return s;};
  /** The subject and target selects, the target defaulting to another bone and moved off the subject when the subject changes to it. */
  const pickPair=()=>{const subject=pickBone('bone'),target=sel('target-bone',bones);const away=()=>{const d=defaultTargetBone(bones,subject.value);if(d&&target.value===subject.value)target.value=d;};away();subject.addEventListener('change',away);return [subject,target] as const;};
  if(k==='contact'){const [b,t]=pickPair();fields.append(make('div',{className:'row'},labelled('Bone ',b),labelled('point ',sel('point',points))),make('div',{className:'row'},labelled('Target bone ',t),labelled('point ',sel('target-point',points))));}
  else if(k==='aim'){const [b,t]=pickPair();fields.append(make('div',{className:'row'},labelled('Bone ',b)),make('div',{className:'row'},labelled('Target bone ',t),labelled('point ',sel('target-point',points))));}
  else if(k==='range'){fields.append(make('div',{className:'row'},labelled('Bone ',pickBone('bone'))));}
  else if(k==='stretch'){
   const meshSlots=catalog.slots.filter(s=>catalog!.meshes[s]?.length),slotSel=sel('slot',meshSlots);if(slot&&meshSlots.includes(slot))slotSel.value=slot;
   const att=sel('attachment',catalog.meshes[slotSel.value]??[]);slotSel.onchange=()=>options(att as HTMLSelectElement,catalog!.meshes[slotSel.value]??[]);
   fields.append(make('div',{className:'row'},labelled('Slot ',slotSel),labelled('mesh ',att)));
  } else if(k==='seam'){
   const part=sel('part',catalog.slots);if(slot&&catalog.slots.includes(slot))part.value=slot;const neighbour=sel('neighbour',catalog.slots.filter(s=>s!==part.value));
   part.onchange=()=>options(neighbour as HTMLSelectElement,catalog!.slots.filter(s=>s!==part.value));
   fields.append(make('div',{className:'row'},labelled('Part ',part),labelled('neighbour ',neighbour)));
  } else {
   const keys=catalog.constraints.map(c=>`${c.type}:${c.name}`),constraint=sel('constraint',keys,v=>v.replace(':',' '));
   const pick=()=>catalog!.constraints[Math.max(0,keys.indexOf(constraint.value))];
   const bone=sel('bone',pick()?.bones??[]),prop=sel('property',pick()?.drives??[]);
   constraint.onchange=()=>{options(bone as HTMLSelectElement,pick()?.bones??[]);options(prop as HTMLSelectElement,pick()?.drives??[]);};
   fields.append(make('div',{className:'row'},labelled('Constraint ',constraint)),make('div',{className:'row'},labelled('Bone ',bone),labelled('property ',prop)),
    make('div',{className:'row'},labelled('tolerance ',numberField('tolerance',.05,0)),labelled('least drive ',numberField('least-drive',2,0))));
  }
  const why=kindUnavailable(k,catalog);note.textContent=why?`${k} is not offered here: ${why}.`:`The bar (${BAR_FIELDS[k].map(b=>b.field).join(', ')}) is set on the slider once added; the producer reads ${KIND_FIELDS[k].join(', ')}.`;note.classList.toggle('error',!!why);
  add.disabled=!!why||busy;
  name.placeholder=requirementName(k,subjectOf(k)??'',declared.map(r=>r.name));
 }
 const v=(id:string)=>controls[id]?.value??'';
 function subjectOf(k:RequirementKind):string|null {return k==='stretch'?v('slot'):k==='seam'?`${v('part')}_${v('neighbour')}`:v('bone')||null;}
 /** The requirement the inputs describe, with each bar at its initial value; a missing name says which. */
 function fromInputs():Requirement|string {
  if(!catalog)return 'REQUIREMENTS_UNAVAILABLE: no rig spec loaded';
  const k=kind.value as RequirementKind,anim=animation.value;if(!anim)return 'an animation is required';
  const why=kindUnavailable(k,catalog);if(why)return `${k} is not offered here: ${why}`;
  const subject=subjectOf(k);if(!subject)return 'pick the subject';
  const n=name.value.trim()||requirementName(k,subject,declared.map(r=>r.name));
  if(!REQUIREMENT_NAME.test(n))return `name ${JSON.stringify(n)}: a letter, then letters, digits and underscores`;
  if(declared.some(r=>r.name===n))return `name ${n} is declared already`;
  const bar=Object.fromEntries(BAR_FIELDS[k].map(b=>[b.field,b.initial]));const common={name:n,animation:anim};
  const target=()=>({bone:v('target-bone'),point:v('target-point') as BonePoint});
  for(const id of Object.keys(controls))if(!v(id))return `${id.replace('-',' ')} is required`;
  if(k==='contact'||k==='aim'){const self=selfTargetRefusal({kind:k,bone:v('bone'),point:v('point') as BonePoint,target:target()});if(self)return self;}
  if(k==='contact')return {...common,kind:k,bone:v('bone'),point:v('point') as BonePoint,target:target(),within_px:bar.within_px!};
  if(k==='aim')return {...common,kind:k,bone:v('bone'),target:target(),within_degrees:bar.within_degrees!};
  if(k==='range')return {...common,kind:k,bone:v('bone'),lo_degrees:bar.lo_degrees!,hi_degrees:bar.hi_degrees!};
  if(k==='stretch')return {...common,kind:k,slot:v('slot'),attachment:v('attachment'),within_ratio:bar.within_ratio!};
  if(k==='seam')return {...common,kind:k,part:v('part'),neighbour:v('neighbour'),within_px:bar.within_px!};
  const [type,...rest]=v('constraint').split(':'),tolerance=Number(v('tolerance')),least=Number(v('least-drive'));
  if(!Number.isFinite(tolerance)||tolerance<0)return 'tolerance: a number 0 or more';if(!Number.isFinite(least)||least<=0)return 'least drive: a number above 0';
  return {...common,kind:'follow',constraint:rest.join(':'),constraint_type:type as 'ik'|'transform',bone:v('bone'),property:v('property') as 'rotate'|'translate',fraction:bar.fraction!,tolerance,least_drive:least};
 }
 const fpsValue=()=>{const n=Number(fps.value);return Number.isFinite(n)&&n>0&&n<=240?n:null;};
 function fileText():string|null {const f=fpsValue();return declared.length&&f!==null?requirementsFileText(requirementsDocument(f,declared.map(requirementEntry))):null;}
 function rehash(){const text=fileText();if(text===null){hashed=null;return;}void deps.hash(text).then(sha256=>{if(fileText()===text)hashed={text,sha256};});}
 function panelStatus(text:string,error:boolean){status.textContent=text;status.title=text;status.classList.toggle('error',error);}
 /** One row per declared requirement: its bar slider(s) (the last measured value marked on the track), its line, a seek to its worst frame. */
 function renderList(){
  list.replaceChildren();shown=[];
  const current=job&&job.file.text===fileText()?job:null;
  for(const r of declared){
   const row=job?.rows.find(x=>x.name===r.name),stale=!!row&&!current;
   const item=make('li',{className:`requirements-item${row?` ${row.status==='PASS'?'pass':'fail'}`:''}`});item.dataset.name=r.name;
   const head=make('div',{className:'row'},make('code',{textContent:`${r.name} · ${r.kind} · ${r.animation}`}));
   const remove=make('button',{type:'button',textContent:'Remove',title:`Remove ${r.name}`});remove.onclick=()=>panel.remove(r.name);head.append(remove);item.append(head);
   for(const b of BAR_FIELDS[r.kind]){
    const value=(r as unknown as Record<string,number>)[b.field]!,measured=measuredFor(row,b.field);
    const lo=Math.min(b.min,value,measured??b.min),hi=Math.max(b.max,value,measured===null?b.max:Math.ceil(measured*1.25*100)/100);
    const slider=make('input',{type:'range',min:String(lo),max:String(hi),step:String(b.step),value:String(value)});slider.setAttribute('aria-label',`${r.name} ${b.field}`);
    if(measured!==null){const marks=make('datalist',{id:`requirements-mark-${r.name}-${b.field}`},make('option',{value:String(measured)}));slider.setAttribute('list',marks.id);item.append(marks);}
    const out=make('output',{textContent:`${b.field} ${value}`});
    slider.oninput=()=>{out.textContent=`${b.field} ${slider.value}`;};slider.onchange=()=>panel.setBar(r.name,b.field,Number(slider.value));
    item.append(make('div',{className:'row requirements-bar'},slider,out,make('span',{className:'subtle',textContent:measured===null?'not measured yet':`measured ${measured}${stale?' (before this change)':''}`})));
   }
   if(row){
    const text=row.line,worst=row.worst;shown.push(text);
    if(worst){const go=make('button',{type:'button',className:'readings-go',textContent:text,title:`Seek to ${worst.text}`});go.onclick=()=>deps.seek(row.animation||r.animation,worst.frame,worst.time,`${r.name} worst`);item.append(go);}
    else item.append(make('code',{textContent:text,title:text}));
   }
   list.append(item);
  }
  check.disabled=busy||!declared.length||!catalog||catalog.status!=='ready';
 }
 function changed(){rehash();renderList();renderFields();}

 kind.onchange=renderFields;
 add.onclick=()=>{const r=fromInputs();if(typeof r==='string'){panelStatus(r,true);return;}declared.push(r);name.value='';panelStatus(`Added ${r.name}; set its bar, then Check.`,false);changed();};
 fps.onchange=changed;
 check.onclick=()=>{void (async()=>{
  const f=fpsValue();if(f===null){panelStatus('fps: a number above 0, at most 240',true);return;}
  busy=true;check.disabled=true;check.textContent='Checking…';panelStatus(`rig-parts check --requirements on the ${build.value==='inspected'?'inspected rig':'latest scratch build'}…`,false);
  try{panel.checked(await deps.check({fps:f,build:build.value as RequirementsBuild,requirements:declared.map(requirementEntry)}));}
  finally{busy=false;check.textContent='Check';renderList();renderFields();}
 })();};

 const panel:RequirementsPanel={
  load(next,reason){
   // Only a ready spec is a catalog: an unavailable one (no producer handoff, #150) leaves the form empty, so selecting a part never renders fields from it.
   catalog=readyCatalog(next);
   if(!next||next.status!=='ready'){state.textContent=reason??next?.reason??'REQUIREMENTS_UNAVAILABLE: no producer handoff';state.classList.add('error');kind.disabled=animation.disabled=true;add.disabled=check.disabled=true;fields.replaceChildren();return;}
   state.textContent=`Rig spec: ${next.bones.length} bones, ${next.slots.length} slots, ${Object.keys(next.meshes).length} mesh slot(s), ${next.constraints.length} ik/transform constraint(s), ${next.animations.length} animation(s)${next.scratch?' · a scratch build exists':''}.`;state.classList.remove('error');
   kind.disabled=animation.disabled=false;
   options(kind,REQUIREMENT_KINDS,k=>{const why=kindUnavailable(k as RequirementKind,next);return why?`${k} — unavailable`:k;});
   options(animation,next.animations.map(a=>a.name));const drawn=deps.animation();if(next.animations.some(a=>a.name===drawn))animation.value=drawn;
   renderFields();renderList();
  },
  selectionChanged(){const drawn=deps.animation();if(catalog?.animations.some(a=>a.name===drawn))animation.value=drawn;renderFields();},
  requirements:()=>declared.map(r=>JSON.parse(JSON.stringify(r)) as Requirement),
  add(r){declared.push(JSON.parse(JSON.stringify(r)) as Requirement);changed();},
  remove(n){declared=declared.filter(r=>r.name!==n);changed();},
  setBar(n,field,value){const r=declared.find(x=>x.name===n) as unknown as Record<string,unknown>|undefined;if(!r||!(KIND_FIELDS[(r.kind as RequirementKind)]??[]).includes(field)||!Number.isFinite(value))return;r[field]=value;changed();},
  text:fileText,
  checked(result){
   refusals.replaceChildren();summary.textContent='';
   if(!result){panelStatus('REQUIREMENTS_FAILED: no answer from the check',true);return;}
   if(!('id' in result)){panelStatus(result.error,true);return;}
   job=result;
   for(const line of [...result.refusals,...result.problems])refusals.append(make('li',{},make('code',{textContent:line,title:line})));
   summary.textContent=[result.summary,result.checkLine].filter(Boolean).join(' · ');
   if(result.status==='checked')panelStatus(`${result.producer.package} ${result.producer.version} check on the ${result.build==='inspected'?'inspected rig':'scratch build'}: ${result.rows.length} line(s)${result.wallMs===null?'':` · ${(result.wallMs/1000).toFixed(1)} s`}`,result.rows.some(r=>r.status!=='PASS'));
   else panelStatus(result.error??`requirements check ${result.status}`,true);
   renderList();
  },
  context(){
   const text=fileText();if(text===null||!hashed||hashed.text!==text)return null;
   const last=job&&job.file.text===text&&job.status!=='running'&&job.status!=='failed'?job:null;
   return {schema:REQUIREMENTS_CONTEXT_SCHEMA,sha256:hashed.sha256,size:new TextEncoder().encode(text).length,text,
    checked:last?{build:last.build,producer:{...last.producer},summary:last.summary,refusals:[...last.refusals],rows:last.rows.map(r=>({name:r.name,status:r.status,worst:r.worst?{...r.worst}:null}))}:null};
  },
  shownLines:()=>[...shown],
 };
 return panel;
}
