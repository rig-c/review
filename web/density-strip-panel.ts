/**
 * Mesh panel · density strip (#173), page side: "N values from A to B" next to the selected part's density field
 * (`grid` on a lattice entry, `contour.spacing` on a contour entry), Build strip, and the table — one row per
 * candidate with `remesh.json`'s counts, the folds count, the part's TEXTURE_STRETCH severity and worst frame, every bar
 * the part is measured on as a ratio against its floor or ceiling, and the verdict (PASS, or the producer's refusal
 * verbatim). The two labels name rows; the table has no Apply. Load puts a built row on the stage as pending (the
 * Mesh panel's Apply then applies it, reusing its build); Refine between builds the next strip inside two rows.
 */
import {panelNode as node,panelMake as make} from './view-controls.ts';
import {barText,densityField,densityPath,refineValues,stripValues,type DensityField,type StripRow} from '../src/density-strip.ts';
import {assertMeshPatch,entryValue,meshPatchOps,setEntryValue,type MeshEntry} from '../src/mesh-entry.ts';
import {jsonPost,makePatch,type ConfigPatch,type RebuildStatusView,type ScopedJobUiSink} from './rebuild-client.ts';
import type {MeshPanel} from './mesh-panel.ts';

export interface DensityStripViewLike {
 id:string;status:'running'|'done';part:string;field:DensityField;concurrency:number;wallMs:number|null;rows:StripRow[];labels:{fewest:number|null;widest:number|null};
}
export interface DensityStripHost {
 part():string|null;
 entry():MeshEntry|null;
 build(values:number[]):Promise<unknown>;
 load(index:number):Promise<void>;
 back():Promise<void>;
 close():Promise<unknown>;
}
export interface DensityStripPanel {
 /** The selected part or its pending entry changed: the field line and the default range follow it. */
 changed():void;
 show(view:DensityStripViewLike|null,pending:number|null,busy:boolean):void;
 status(text:string,error:boolean):void;
}

interface DensityStripJobs {
 api:<T>(path:string,init?:RequestInit)=>Promise<T>;
 path:string;
 ui:ScopedJobUiSink;
 view:()=>DensityStripViewLike|null;
 save:(view:DensityStripViewLike|null)=>void;
 render:()=>void;
 busy:()=>boolean;
 setBusy:(value:boolean)=>void;
 pendingId:()=>string|undefined;
 back:()=>Promise<void>;
 panel:()=>DensityStripPanel|null;
 footer:(text:string)=>void;
 clearFooter?:()=>void;
 readOnly:()=>string|null;
 status:()=>RebuildStatusView|null;
 loadStatus:()=>Promise<RebuildStatusView|null>;
 mesh:()=>MeshPanel|null;
 selected?:()=>boolean;
 initial:(part:string,values:number[])=>string;
 summary:(view:DensityStripViewLike,passing:number)=>string;
}
const densityErrorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export function densityStripPatches(status:RebuildStatusView|null,part:string|null,entry:MeshEntry|null,
 precheck:()=>string[],values:number[]):{part:string;patches:ConfigPatch[]}|{error:string} {
 if(!status||!part||!entry)return {error:status?.reason??'MESH_PANEL_NO_PART: select a mesh part'};
 const problems=precheck();
 if(problems.length)return {error:`${problems[0]} (review pre-check; nothing sent)`};
 try{
  const field=densityField(entry,part);
  const patches=values.map(value=>{
   const patch=makePatch(status,meshPatchOps(part,setEntryValue(entry,densityPath(field),value)),{cmd:'remesh',args:['--part',part]});
   if(!patch)throw new Error(status.reason??'REBUILD_STATUS_UNAVAILABLE');
   assertMeshPatch(patch,part);
   return patch;
  });
  return {part,patches};
 }catch(error){return {error:densityErrorText(error)};}
}

export function bindDensityStripJobs({
 api,path,ui,view,save,render,busy,setBusy,pendingId,back,panel,footer,clearFooter=()=>{},
 readOnly,status,loadStatus,mesh,selected,initial,summary,
}:DensityStripJobs) {
 const draw=()=>ui.render(render);
 const clear=()=>panel()?.status('',false);
 const outcome=(text:string,error:boolean)=>{
  ui.outcome('density',()=>panel()?.status(text,error),clear);
  if(error)ui.outcome('message',()=>footer(text),clearFooter);
 };
 const progress=(text:string)=>ui.transient('density',()=>panel()?.status(text,false),clear);
 const clearOutcomes=()=>{ui.clearOutcome('density');ui.clearOutcome('message');};

 async function refresh():Promise<void> {
  try{const result=await api<{strip:DensityStripViewLike|null}>(path);save(result.strip);}
  catch{/* Keep the last view. */}
  draw();
 }

 async function close():Promise<{status:string;error?:string}> {
  const current=view();
  if(!current)return {status:'closed'};
  clearOutcomes();
  if(pendingId()===current.id)await back();
  try{
   const result=await api<{status:string;error?:string}>(`${path}/close`,jsonPost({id:current.id}));
   if(result.status!=='closed'){outcome(result.error??'DENSITY_STRIP_CLOSE_REFUSED',true);return result;}
   save(null);draw();outcome('Strip closed; its scratch is removed.',false);
   return result;
  }catch(error){
   const text=densityErrorText(error);
   outcome(text,true);
   return {status:'refused',error:text};
  }
 }

 async function build(values:number[]):Promise<DensityStripViewLike|{error:string}> {
  if(busy())return {error:'DENSITY_STRIP_BUSY: a strip is still building'};
  clearOutcomes();
  const refused=readOnly();
  if(refused){outcome(refused,true);return {error:refused};}
  const cached=status();
  // Compare may switch sides during the status read. Keep the originating selection for that case.
  const origin=!cached&&selected?mesh():null;
  const snapshot=origin&&{part:origin.part(),entry:origin.entry(),problems:origin.precheck()};
  const ready=cached??await loadStatus();
  const offside=selected?.()===false;
  const current=offside?null:mesh(),picked=offside?snapshot:null;
  const request=densityStripPatches(ready,picked?.part??current?.part()??null,
   picked?.entry??current?.entry()??null,()=>picked?.problems??current?.precheck()??[],values);
  if('error' in request){outcome(request.error,true);return request;}
  // A pending row goes back first: the strip it came from is about to be replaced.
  if(pendingId()!==undefined){await back();ui.clearOutcome('density');}
  setBusy(true);draw();progress(initial(request.part,values));
  const started=performance.now();
  try{
   let result:DensityStripViewLike|{status:string;error:string};
   try{result=await api<DensityStripViewLike|{status:string;error:string}>(path,jsonPost({patches:request.patches}));}
   catch(error){result={status:'refused',error:densityErrorText(error)};}
   if('error' in result){outcome(result.error,true);return {error:result.error};}
   save(result);draw();
   while(result.status==='running'){
    await new Promise(resolve=>setTimeout(resolve,1500));
    result=await api<DensityStripViewLike>(`${path}/${result.id}`);
    save(result);draw();
    const settled=result.rows.filter(row=>row.status!=='running').length;
    progress(`Strip ${result.id.slice(0,12)}…: ${settled} of ${result.rows.length} settled · ${((performance.now()-started)/1000).toFixed(0)} s`);
   }
   const passing=result.rows.filter(row=>row.verdict==='PASS').length;
   outcome(summary(result,passing),false);
   return result;
  }finally{setBusy(false);draw();}
 }
 return {refresh,build,close,outcome};
}

const fieldLabel=(f:DensityField)=>f==='grid'?'grid':'contour.spacing';

export function bindDensityStrip(host:DensityStripHost):DensityStripPanel {
 const fieldLine=node('density-strip-field'),n=node<HTMLInputElement>('density-strip-n'),from=node<HTMLInputElement>('density-strip-from'),to=node<HTMLInputElement>('density-strip-to');
 const buildButton=node<HTMLButtonElement>('density-strip-build'),backButton=node<HTMLButtonElement>('density-strip-back'),closeButton=node<HTMLButtonElement>('density-strip-close');
 const statusOut=node('density-strip-status'),table=node('density-strip-table');
 let view:DensityStripViewLike|null=null,pending:number|null=null,busy=false,lastPart:string|null=null;
 const status=(text:string,error:boolean)=>{statusOut.textContent=text;statusOut.title=text;statusOut.classList.toggle('error',error);};
 /** The selected part's density field and its pending value, or the reason a strip cannot run on it. */
 const current=():{part:string;field:DensityField;value:number}|{error:string}=>{
  const part=host.part(),entry=host.entry();
  if(!part||!entry)return {error:'Select a mesh part (grid or contour entry) to build a density strip.'};
  try{const field=densityField(entry,part),value=entryValue(entry,densityPath(field));return typeof value==='number'?{part,field,value}:{error:`meshes.${part}.${fieldLabel(field)} is not a number`};}
  catch(error){return {error:error instanceof Error?error.message:String(error)};}
 };
 function changed(){
  const c=current();
  if('error' in c){fieldLine.textContent=c.error;buildButton.disabled=true;lastPart=null;return;}
  fieldLine.textContent=`${c.part} · ${fieldLabel(c.field)} (pending ${c.value}) · each value runs as its own replace /meshes/${c.part} patch through remesh, at most ${view?.concurrency??'cores/2'} at once`;
  if(lastPart!==c.part){from.value=String(c.value);to.value=String(c.field==='grid'?Math.round(c.value*3):Math.round(c.value*2*100)/100);lastPart=c.part;}
  buildButton.disabled=busy||view?.status==='running';
 }
 buildButton.onclick=()=>{
  const c=current();if('error' in c){status(c.error,true);return;}
  try{void host.build(stripValues(Number(from.value),Number(to.value),Number(n.value),c.field==='grid'));}catch(error){status(error instanceof Error?error.message:String(error),true);}
 };
 backButton.onclick=()=>{void host.back();};
 closeButton.onclick=()=>{void host.close();};
 const cell=(text:string,title=text,cls='')=>make('td',{textContent:text,title,className:cls});
 function show(next:DensityStripViewLike|null,pendingIndex:number|null,isBusy:boolean){
  view=next;pending=pendingIndex;busy=isBusy;changed();
  backButton.disabled=pending===null||busy;closeButton.disabled=!view||view.status==='running'||busy;
  if(!view){table.replaceChildren();return;}
  const v=view,integer=v.field==='grid',head=make('tr',{},...[fieldLabel(v.field),'v / t (remesh.json)','folds','TEXTURE_STRETCH','bars (ratio vs floor / ceiling)','verdict',''].map(h=>make('th',{textContent:h,scope:'col'})));
  const rows=v.rows.map((r,i)=>{
   const labels:string[]=[];if(v.labels.fewest===i)labels.push('fewest triangles passing');if(v.labels.widest===i)labels.push('widest margin among ties');
   const valueCell=make('td',{className:'density-strip-value'},make('strong',{textContent:String(r.value)}),...labels.map(l=>make('span',{className:'density-strip-label',textContent:l})));
   const counts=r.counts?`v ${r.counts.vertices} · t ${r.counts.triangles}`:'—';
   const stretch=r.stretch?`${r.stretch.severity}${r.stretch.frame?` @ ${r.stretch.frame}`:''}`:'—';
   const bars=r.bars.length?make('td',{className:'density-strip-bars'},...r.bars.map(b=>make('div',{textContent:barText(b),title:`${b.bar} ${b.status}`,className:b.margin<1?'error':''}))):cell('—');
   const verdictCell=cell(r.verdict,r.verdict,`density-strip-verdict${r.verdict==='PASS'?' pass':r.status==='running'?'':' error'}`);
   const load=make('button',{type:'button',textContent:pending===i?'On stage':r.applied?'Applied':'Load',disabled:busy||!r.modelUrl||pending===i||v.status==='running'});
   load.title=r.modelUrl?'Load this revision on the stage as pending — nothing is applied; the Mesh panel\'s Apply applies it':r.status==='running'?'Still building':r.applied?'Applied: it is an applied record now':'Refused: there is no revision to load';
   load.setAttribute('aria-label',`Load ${fieldLabel(v.field)} ${r.value}`);load.onclick=()=>{void host.load(i);};
   const actions=make('td',{className:'density-strip-actions'},load);
   if(i<v.rows.length-1){
    const refine=make('button',{type:'button',textContent:'Refine ↓',disabled:busy||v.status==='running'});
    refine.title=`Build the next strip between ${r.value} and ${v.rows[i+1]!.value}`;refine.setAttribute('aria-label',`Refine between ${r.value} and ${v.rows[i+1]!.value}`);
    refine.onclick=()=>{try{void host.build(refineValues(r.value,v.rows[i+1]!.value,Number(n.value)||5,integer));}catch(error){status(error instanceof Error?error.message:String(error),true);}};
    actions.append(refine);
   }
   const tr=make('tr',{className:[pending===i?'pending':'',r.status==='refused'||r.status==='failed'?'refused':''].filter(Boolean).join(' ')},valueCell,cell(counts),cell(r.folds===null?'—':String(r.folds)),cell(stretch),bars,verdictCell,actions);
   tr.dataset.candidate=r.id;return tr;
  });
  table.replaceChildren(make('table',{className:'density-strip-rows'},make('thead',{},head),make('tbody',{},...rows)));
 }
 changed();
 return {changed,show,status};
}
