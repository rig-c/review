/**
 * Apply · Rebuild, page side (#99): the chest editor's rows become the producer's region entries, one typed request
 * goes to `/api/rebuild`, the job's lines stream back by polling, and the applied state is recorded. No DOM here
 * (main.ts owns the elements and the player); the server owns every path and the producer's flags.
 */
import {ellipsePolygon} from '../src/chest-regions.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch,type PatchCmd,type PatchOp} from '../src/config-patch.ts';
import {APPLIED_PATCH_SCHEMA,type AppliedPatch,type CheckSummary} from '../src/applied-context.ts';
export type {ConfigPatch,PatchOp,AppliedPatch,CheckSummary};
import {chestContourFields,chestRegionRows,chestRowId,type ChestFieldReader} from './chest-regions-tool.ts';

export type RegionEntry=
 |{name:string;shape:'circle';cx:number;cy:number;r:number;bone:string;spacing:number;band:number}
 |{name:string;bone:string;shape:'polygon';points:[number,number][];spacing:number;band:number};
/** The producer handoff (#101) as `/api/rebuild` reports it: paths relative to the package root, how it was found. */
export interface HandoffView {how:'declared'|'discovered';via:string;outside:boolean;config:{path:string;sha256:string};parts:string|null;rig:string|null;files:{path:string;sha256:string}[];missing:string[]}
export interface BaselineView {status:'running'|'reproduced'|'not-reproduced'|'refused'|'failed';firstDifference:string|null;hashes:{baseline:{rigJson:string|null;tree:string};inspected:{rigJson:string|null;tree:string}}|null;line:string;wallMs:number|null}
export interface RebuildStatusView {available:boolean;handoff:HandoffView|null;baseline:BaselineView|null;inputs:{config:string;parts:string|null;rig:string|null;configHash:string}|null;parts:{name:string;regions:unknown[]}[];contour:Record<string,Record<string,unknown>>;producer:{package:string;version:string}|null;compiler:{package:string;version:string}|null;reason:string|null}
export interface RebuildJobView {id:string;status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;exitCode:number|null;wallMs:{remesh:number|null;compile:number|null};build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{part:string;regions:RegionEntry[];configHash:string;entrySha256:string};producer:{package:string;version:string};compiler:{package:string;version:string}}
export interface RebuildRefusal {status:'refused';error:string;producerLine:string|null}
export interface RebuildRequestBody {part:string;regions:RegionEntry[];configHash:string}
/** What the draft keeps and the feedback context carries: the exact last applied inputs and the producer's line. */
export interface AppliedRecord {schema:'rig-review-applied/1';buildId:string;part:string;regions:RegionEntry[];configHash:string;entrySha256:string;producer:{package:string;version:string};compiler:{package:string;version:string};line:string|null;modelHash:string}

const number=(read:ChestFieldReader,id:string)=>{const raw=(read(id)?.value??'').trim();if(!raw)return null;const value=Number(raw);return Number.isFinite(value)?value:Number.NaN;};

/** Rows with a centre x are designated; a row with equal semi-axes and no clip is the config's circle, else the 32-sample polygon. */
export function designatedRegions(read:ChestFieldReader):{regions:RegionEntry[]}|{error:string} {
 const regions:RegionEntry[]=[];
 for(const row of chestRegionRows){
  if(number(read,chestRowId(row,'cx'))===null)continue;
  const name=(read(chestRowId(row,'name'))?.value??'').trim(),bone=(read(chestRowId(row,'bone'))?.value??'').trim(),tag=`row ${row+1}`;
  if(!name)return {error:`REBUILD_REGION_INCOMPLETE: ${tag} name`};if(!bone)return {error:`REBUILD_REGION_INCOMPLETE: ${name} bone`};
  const values:Record<string,number|null>={};
  for(const field of ['cx','cy','ax','ay','spacing','band','clip'] as const){values[field]=number(read,chestRowId(row,field));if(Number.isNaN(values[field]))return {error:`REBUILD_REGION_INCOMPLETE: ${name} ${field}`};}
  for(const field of ['cy','ax','spacing','band'] as const)if(values[field]===null)return {error:`REBUILD_REGION_INCOMPLETE: ${name} ${field}`};
  const {cx,cy,ax,spacing,band,clip}=values as Record<string,number>,ay=values.ay??ax;
  if(ax===ay&&values.clip===null)regions.push({name,shape:'circle',cx,cy,r:ax,bone,spacing,band});
  else regions.push({name,bone,shape:'polygon',points:ellipsePolygon([cx,cy],[ax,ay],32,values.clip===null?undefined:clip),spacing,band});
 }
 return regions.length?{regions}:{error:'REBUILD_REGION_INCOMPLETE: no region has a centre'};
}

/** The contour part to rebuild: the one whose regions name the first designated bone, else the only one, else none. */
export function pickPart(status:Pick<RebuildStatusView,'parts'>,regions:readonly RegionEntry[]):string|null {
 const bones=new Set(regions.map(r=>r.bone));
 const named=status.parts.filter(p=>p.regions.some(r=>!!r&&typeof r==='object'&&bones.has(String((r as {bone?:unknown}).bone))));
 if(named.length===1)return named[0]!.name;
 return status.parts.length===1?status.parts[0]!.name:null;
}

/**
 * Field values that start the editor from the producer config: the first contour part's circle regions (at most two
 * rows) and its contour numbers. Only for an untouched editor — `null` once any row has a centre.
 */
export function seedFields(status:Pick<RebuildStatusView,'parts'|'contour'>,read:ChestFieldReader):Record<string,string>|null {
 if(chestRegionRows.some(row=>(read(chestRowId(row,'cx'))?.value??'').trim()))return null;
 const part=status.parts.find(p=>p.regions.length),entry=part?status.contour[part.name]:undefined;if(!part||!entry)return null;
 const out:Record<string,string>={},contour=(entry.contour??{}) as Record<string,unknown>;
 part.regions.slice(0,chestRegionRows.length).forEach((value,row)=>{
  const r=value as Record<string,unknown>;if(r.shape!=='circle')return;
  for(const [field,key] of [['name','name'],['bone','bone'],['cx','cx'],['cy','cy'],['ax','r'],['ay','r'],['spacing','spacing'],['band','band']] as const)if(r[key]!==undefined)out[chestRowId(row,field)]=String(r[key]);
 });
 for(const [key,id] of chestContourFields)if(typeof contour[key]==='number')out[id]=String(contour[key]);
 if(typeof contour.bridges==='boolean')out['chest-bridges']=String(contour.bridges);
 if(typeof entry.r==='number')out['chest-r']=String(entry.r);
 if(Array.isArray(entry.segments))out['chest-segments']=JSON.stringify(entry.segments);
 return Object.keys(out).length?out:null;
}

export const appliedRecord=(job:RebuildJobView):AppliedRecord=>({schema:'rig-review-applied/1',buildId:job.id,part:job.request.part,regions:job.request.regions,configHash:job.request.configHash,entrySha256:job.request.entrySha256,producer:job.producer,compiler:job.compiler,line:job.producerLine,modelHash:job.build!.modelHash});
export function parseApplied(text:string):AppliedRecord|AppliedPatch|null {try{const value=JSON.parse(text);return value?.schema==='rig-review-applied/1'||value?.schema===APPLIED_PATCH_SCHEMA?value as AppliedRecord|AppliedPatch:null;}catch{return null;}}

/** A patch Apply's job (#102): the patch and its hash, the op/compile/check wall clocks, check's summary and the rig.json diff. */
export interface PatchJobView {id:string;kind:'patch';status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;exitCode:number|null;wallMs:{op:number|null;compile:number|null;check:number|null};check:CheckSummary|null;diff:{count:number;paths:string[]}|null;build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{patch:ConfigPatch;patchSha256:string;configHash:string};producer:{package:string;version:string};compiler:{package:string;version:string}}
export interface PatchRequestBody {patch:ConfigPatch}
export type AnyJobView=RebuildJobView|PatchJobView;
export const isPatchJob=(job:AnyJobView):job is PatchJobView=>(job as PatchJobView).kind==='patch';

export interface RebuildDeps<B=RebuildRequestBody|PatchRequestBody,J extends AnyJobView=AnyJobView> {post:(body:B)=>Promise<J|RebuildRefusal>;get:(id:string)=>Promise<J>;onLine:(line:string,index:number)=>void;sleep:(ms:number)=>Promise<void>;intervalMs?:number}
/** One Apply: post, then poll until the job leaves `running`, handing every new line over once, in order. */
export async function runRebuild<B,J extends AnyJobView>(body:B,deps:RebuildDeps<B,J>):Promise<J|RebuildRefusal> {
 let job=await deps.post(body);if(job.status==='refused'&&!('id' in job))return job;
 let seen=0;const deliver=(lines:string[])=>{for(;seen<lines.length;seen++)deps.onLine(lines[seen]!,seen);};
 deliver((job as J).lines);
 while(job.status==='running'){await deps.sleep(deps.intervalMs??700);job=await deps.get((job as J).id);deliver(job.lines);}
 return job;
}

/**
 * A patch from the config the status read: `config_sha256` is the handoff config's hash and the producer is the
 * installed one, so an edit card only states its ops and the op. Null when Apply cannot run here.
 */
export function makePatch(status:Pick<RebuildStatusView,'inputs'|'producer'>,ops:PatchOp[],op:{cmd:PatchCmd;args?:string[]}={cmd:'rig'}):ConfigPatch|null {
 if(!status.inputs||!status.producer)return null;
 return {schema:CONFIG_PATCH_SCHEMA,config_sha256:status.inputs.configHash,ops:ops.map(o=>({...o})),producer:{name:status.producer.package,version:status.producer.version},op:{cmd:op.cmd,args:[...(op.args??[])]}};
}
/** What the draft keeps and `context.applied` carries for a patch: the patch, its hash, the producer's line and check's summary. */
export const patchAppliedRecord=(job:PatchJobView):AppliedPatch=>({schema:APPLIED_PATCH_SCHEMA,buildId:job.id,patch:job.request.patch,patchSha256:job.request.patchSha256,configHash:job.request.configHash,producer:job.producer,compiler:job.compiler,line:job.producerLine,check:job.check,diff:job.diff,modelHash:job.build!.modelHash});
/**
 * What the stage draws after an Apply: the scratch build when the job built one, else what it drew before — a
 * refusal, a failure or a busy reply leaves the stage's model (and its hash) as it was.
 */
export function stageModel(result:AnyJobView|RebuildRefusal,current:{url:string;hash:string}):{url:string;hash:string;id:string|null} {
 if('id' in result&&result.status==='built'&&result.build)return {url:result.build.modelUrl,hash:result.build.modelHash,id:result.id};
 return {...current,id:null};
}
const seconds=(ms:number|null)=>ms===null?'—':`${(ms/1000).toFixed(1)} s`;
/** A patch job's status line: built (wall clocks, check's verdict, the diff count) or the producer's line verbatim. */
export function patchOutcomeLine(result:PatchJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:result.producerLine??`REBUILD_FAILED: exit ${result.exitCode}`,error:true};
 const check=result.check?(result.check.pass===null?`check refused: ${result.check.line??`exit ${result.check.exitCode}`}`:`check ${result.check.pass?'PASS':'FAIL'}`):'check not run';
 const wall=result.reused?'reused the scratch build of this exact patch':`${result.request.patch.op.cmd} ${seconds(result.wallMs.op)} + compile ${seconds(result.wallMs.compile)} + check ${seconds(result.wallMs.check)}`;
 return {text:`Applied patch ${result.request.patchSha256.slice(0,12)}… (${result.request.patch.ops.length} op(s)) with ${result.producer.package} ${result.producer.version} · ${wall} · ${check} · rig.json differs at ${result.diff?.count??'?'} path(s) · Reset returns to the inspected build`,error:!!result.check&&result.check.pass!==true};
}
/** The status line after a job: built (with the wall clock and whether the scratch build was reused) or the producer's line verbatim. */
export function outcomeLine(result:RebuildJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:result.producerLine??`REBUILD_FAILED: exit ${result.exitCode}`,error:true};
 const wall=[result.wallMs.remesh,result.wallMs.compile].every(v=>v!==null)?` · remesh ${(result.wallMs.remesh!/1000).toFixed(1)} s + compile ${(result.wallMs.compile!/1000).toFixed(1)} s`:'';
 return {text:`Applied ${result.request.part} with ${result.producer.package} ${result.producer.version}${result.reused?' · reused the scratch build of this exact designation':wall} · Reset returns to the inspected build`,error:false};
}

/**
 * The editor bar's handoff line, shown before any Apply: how the config was found (declared, or discovered — and
 * outside the opened folder when it is the `../config.json` beside an opened out/), its path and hash, then the
 * baseline. Without a handoff it is the refusal naming where it was looked for and how to declare it.
 */
export function handoffText(status:Pick<RebuildStatusView,'handoff'|'baseline'|'reason'>):{text:string;error:boolean} {
 const h=status.handoff;
 if(!h)return {text:status.reason??'MODELING_HANDOFF_MISSING',error:true};
 const how=h.how==='declared'?`declared (${h.via})`:h.outside?'discovered outside the opened folder':'discovered';
 const parts=h.parts?` · parts ${h.parts==='.'?'(the opened folder)':h.parts}`:'';
 const base=status.baseline?` · ${status.baseline.wallMs!==null&&status.baseline.status!=='running'?`${status.baseline.line} (${(status.baseline.wallMs/1000).toFixed(1)} s)`:status.baseline.line}`:' · baseline: waits for the producer';
 return {text:`Handoff ${how}: ${h.config.path} sha256 ${h.config.sha256.slice(0,12)}…${parts}${base}`,error:!!status.baseline&&['not-reproduced','refused','failed'].includes(status.baseline.status)};
}
