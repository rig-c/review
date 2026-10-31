/**
 * Apply · Rebuild, page side (#99): the chest editor's rows become the producer's region entries, one typed request
 * goes to `/api/rebuild`, the job's lines stream back by polling, and the applied state is recorded. No DOM here
 * (main.ts owns the elements and the player); the server owns every path and the producer's flags.
 */
import {ellipsePolygon} from '../src/chest-regions.ts';
import type {BustSpec} from '../src/chest-landmarks.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch,type PatchCmd,type PatchOp} from '../src/config-patch.ts';
import {APPLIED_ANIMATION_SCHEMA,APPLIED_DELTA_SCHEMA,APPLIED_PATCH_SCHEMA,APPLIED_RETARGET_SCHEMA,filesDiffText,type AppliedAnimation,type AppliedAssembled,type AppliedDelta,type AppliedPatch,type AppliedRetarget,type CheckSummary,type FilesDiff} from '../src/applied-context.ts';
import type {AnimationSourceOp} from '../src/animation-ops.ts';
import type {MotionSummary,RetargetFlags,RetargetLine,RetargetRecord} from '../src/retarget.ts';
export type {ConfigPatch,PatchOp,AppliedPatch,AppliedDelta,AppliedRetarget,AppliedAnimation,AnimationSourceOp,CheckSummary,BustSpec};
import {chestContourFields,chestRegionRows,chestRowId,type ChestFieldReader} from './chest-regions-tool.ts';
import type {InspectedCheckView} from '../src/physics-tuning.ts';
import {samplesClock,type StageClock} from '../src/frame-clock.ts';

export type RegionEntry=
 |{name:string;shape:'circle';cx:number;cy:number;r:number;bone:string;spacing:number;band:number}
 |{name:string;bone:string;shape:'polygon';points:[number,number][];spacing:number;band:number};
/** The producer handoff (#101) as `/api/rebuild` reports it: paths relative to the package root, how it was found. */
export interface HandoffView {how:'declared'|'discovered';via:string;outside:boolean;config:{path:string;sha256:string};parts:string|null;rig:string|null;files:{path:string;sha256:string}[];missing:string[]}
export interface BaselineView {status:'running'|'reproduced'|'not-reproduced'|'refused'|'failed';firstDifference:string|null;hashes:{baseline:{rigJson:string|null;tree:string};inspected:{rigJson:string|null;tree:string}}|null;line:string;wallMs:number|null}
export interface RetargetStatusView {available:boolean;reason:string|null;producer:{package:string;version:string}|null;compiler:{package:string;version:string}|null;rig:string|null;sequences:{id:string;label:string;path:string;cleaned:boolean;frames:number;people:string[]}[];bones:string[];animations:string[]}
export interface RebuildStatusView {retarget?:RetargetStatusView;available:boolean;handoff:HandoffView|null;baseline:BaselineView|null;inputs:{config:string;parts:string|null;rig:string|null;configHash:string}|null;parts:{name:string;regions:unknown[]}[];contour:Record<string,Record<string,unknown>>;meshes?:Record<string,unknown>;constraints?:unknown[]|null;bones?:unknown[]|null;fields?:Record<string,unknown>|null;cuts?:{config:Record<string,unknown>;build:string|null}|null;inspectedCheck?:InspectedCheckView|null;idle?:import('../src/idle-tracks.ts').IdleStatus|null;cloth?:ClothStatusView|null;producer:{package:string;version:string}|null;compiler:{package:string;version:string}|null;reason:string|null}
/** #111: the cloth recipe form's status — the reader's tags, the recipes as written, each tag's parts and chains, the keypoints, the route and why Apply cannot run. */
export interface ClothStatusView {targets:string[];targetsRead:boolean;recipes:Record<string,unknown>|null;tags:import('../src/cloth-recipe.ts').ClothTagView[];keypoints:{path:string;sha256:string}|null;route:'build'|'rig';reason:string|null}
export interface RebuildJobView {id:string;status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;hint?:string;exitCode:number|null;wallMs:{remesh:number|null;compile:number|null};build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{part:string;regions:RegionEntry[];configHash:string;entrySha256:string;bust?:BustSpec};producer:{package:string;version:string};compiler:{package:string;version:string}}
export interface RebuildRefusal {status:'refused';error:string;producerLine:string|null}
/** #99 regions or #105 landmarks: exactly one of `regions` and `bust`. */
export type RebuildRequestBody={part:string;regions:RegionEntry[];configHash:string}|{part:string;bust:BustSpec;configHash:string};
/** What the draft keeps and the feedback context carries: the exact last applied inputs and the producer's line. */
export interface AppliedRecord {schema:'rig-review-applied/1';buildId:string;part:string;regions:RegionEntry[];bust?:BustSpec;configHash:string;entrySha256:string;producer:{package:string;version:string};compiler:{package:string;version:string};line:string|null;modelHash:string}

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

/** The part a landmarks Apply rebuilds: the contour part whose entry already states `contour.bust`, else as for regions. */
export function pickBustPart(status:Pick<RebuildStatusView,'parts'|'contour'>,derived:readonly RegionEntry[]):string|null {
 const stated=status.parts.filter(p=>{const c=status.contour[p.name]?.contour;return !!c&&typeof c==='object'&&'bust' in (c as Record<string,unknown>);});
 return stated.length===1?stated[0]!.name:pickPart(status,derived);
}
/**
 * A landmarks Apply (#105): `{part, bust, configHash}`, or the line that refuses it before anything is sent — a point not
 * placed, or review's pre-check of the producer's `CONFIG_BUST_CLEARANCE` on the same numbers. Bone names are the
 * producer's to resolve (`CONFIG_NAME_RESOLVES` comes back verbatim).
 */
export function landmarksRequest(status:Pick<RebuildStatusView,'parts'|'contour'|'inputs'>,read:import('./chest-editor.ts').LandmarkRead):{body:RebuildRequestBody;part:string}|{error:string} {
 if('error' in read)return {error:read.error};
 if('missing' in read)return {error:`LANDMARKS_INCOMPLETE: place ${read.missing.join(', ')}`};
 if(read.derived.refusal)return {error:read.derived.refusal};
 if(!status.inputs)return {error:'REBUILD_STATUS_UNAVAILABLE'};
 const part=pickBustPart(status,read.derived.regions);
 if(!part)return {error:`REBUILD_PART_AMBIGUOUS: the config states ${status.parts.length} contour meshes and the landmark bones name none of them alone`};
 return {part,body:{part,bust:read.spec,configHash:status.inputs.configHash}};
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

/**
 * Landmark field values (#105) from a config entry that already states `contour.bust`, for an untouched Landmarks mode
 * only (`null` once any landmark has a value). Absent alpha / clearance seed the producer's defaults.
 */
export function seedLandmarks(status:Pick<RebuildStatusView,'parts'|'contour'>,read:ChestFieldReader):Record<string,string>|null {
 if(['apex_r','apex_l','cleavage'].some(k=>(read(`lm-${k}-x`)?.value??'').trim()||(read(`lm-${k}-y`)?.value??'').trim()))return null;
 for(const p of status.parts){
  const bust=(status.contour[p.name]?.contour as Record<string,unknown>|undefined)?.bust as Record<string,unknown>|undefined;if(!bust||typeof bust!=='object')continue;
  const out:Record<string,string>={};
  for(const k of ['apex_r','apex_l','cleavage'])if(Array.isArray(bust[k])&&(bust[k] as unknown[]).length===2){out[`lm-${k}-x`]=String((bust[k] as number[])[0]);out[`lm-${k}-y`]=String((bust[k] as number[])[1]);}
  for(const k of ['alpha','clearance'])if(typeof bust[k]==='number')out[`lm-${k}`]=String(bust[k]);
  for(const k of ['bone_r','bone_l'])if(typeof bust[k]==='string')out[`lm-${k}`]=bust[k] as string;
  return Object.keys(out).length?out:null;
 }
 return null;
}

export const appliedRecord=(job:RebuildJobView):AppliedRecord=>({schema:'rig-review-applied/1',buildId:job.id,part:job.request.part,regions:job.request.regions,...(job.request.bust?{bust:job.request.bust}:{}),configHash:job.request.configHash,entrySha256:job.request.entrySha256,producer:job.producer,compiler:job.compiler,line:job.producerLine,modelHash:job.build!.modelHash});
export function parseApplied(text:string):AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|AppliedAnimation|null {try{const value=JSON.parse(text);return value?.schema==='rig-review-applied/1'||value?.schema===APPLIED_PATCH_SCHEMA||value?.schema===APPLIED_DELTA_SCHEMA||value?.schema===APPLIED_RETARGET_SCHEMA||value?.schema===APPLIED_ANIMATION_SCHEMA?value as AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|AppliedAnimation:null;}catch{return null;}}

/** A patch Apply's job (#102): the patch and its hash, the op/compile/check wall clocks, check's summary and the rig.json diff. */
/** #115: a build job's assemble readout (`AssembledView` in src/rebuild.ts). */
export type AssembledJobView=import('../src/rebuild.ts').AssembledView;
export interface PatchJobView {id:string;kind:'patch';op?:'rig'|'retune'|'remesh'|'build'|'cloth';assembled?:AssembledJobView;cloth?:import('../src/rebuild.ts').ClothJob;status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;hint?:string;exitCode:number|null;wallMs:{op:number|null;compile:number|null;check:number|null};check:CheckSummary|null;diff:{count:number;paths:string[]}|null;files?:FilesDiff|null;remesh?:import('../src/mesh-entry.ts').RemeshCounts&{modelTriangles:number|null}|null;build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{patch:ConfigPatch;patchSha256:string;configHash:string};producer:{package:string;version:string};compiler:{package:string;version:string};environment?:{sha256:string;steps:number}}
/** #112: `environment` is the exported `rigc-environment/1` schedule Apply's check reads, when "Use for readings" is on. */
export interface PatchRequestBody {patch:ConfigPatch;environment?:import('../src/environment-schedule.ts').EnvironmentSchedule}
/** Edit Mesh's delta Apply (#135): `remesh --delta`, the per-file diff and the part's counts; remesh's own gate holds check. */
export interface DeltaJobView {id:string;kind:'delta';op:'remesh';status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;hint?:string;exitCode:number|null;wallMs:{op:number|null;compile:number|null};files:FilesDiff|null;remesh:import('../src/mesh-entry.ts').RemeshCounts&{modelTriangles:number|null}|null;build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{part:string;delta:Record<string,unknown>;deltaSha256:string;configHash:string};producer:{package:string;version:string};compiler:{package:string;version:string}}
/** `{part, delta, configHash}`: the server owns every path and flag; the delta is the editor's export as it stands. */
export interface DeltaRequestBody {part:string;delta:import('../src/mesh-edit.ts').MeshEditDocument;configHash:string}
/** A retarget Apply's job (#114): clean, retarget, compile; every FAIL line of the step that refused, verbatim; the listed lines. */
export interface RetargetJobView {id:string;kind:'retarget';op:'retarget';status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;refusals:string[];exitCode:number|null;wallMs:{clean:number|null;retarget:number|null;compile:number|null};files:FilesDiff|null;motion:MotionSummary|null;readings:RetargetLine[];frameTimes?:number[]|null;build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{record:RetargetRecord;recordSha256:string;configHash:string};producer:{package:string;version:string};compiler:{package:string;version:string}}
/** `{retarget: {sequence, map, flags, configHash}}`: a declared reference id, the map by content and typed flags — no path, no flag string. */
export interface RetargetRequestBody {retarget:{sequence:string;map:Record<string,unknown>;flags:RetargetFlags;configHash:string}}
/** What the draft keeps and `context.applied` carries for a retarget: the record, the producer's line, the motion summary, the diff and the lines. */
export const retargetAppliedRecord=(job:RetargetJobView):AppliedRetarget=>({schema:APPLIED_RETARGET_SCHEMA,buildId:job.id,retarget:JSON.parse(JSON.stringify(job.request.record)),recordSha256:job.request.recordSha256,configHash:job.request.configHash,producer:job.producer,compiler:job.compiler,line:job.producerLine,motion:JSON.parse(JSON.stringify(job.motion)),files:job.files,readings:job.readings.map(r=>({...r})),modelHash:job.build!.modelHash});
/** A retarget job's status line: built (wall clocks, the new animation, the diff) or the producer's line verbatim. */
export function retargetOutcomeLine(result:RetargetJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:result.producerLine??`REBUILD_FAILED: exit ${result.exitCode}`,error:true};
 const r=result.request.record,wall=result.reused?'reused the scratch build of this exact retarget':`${r.op.clean?`clean ${seconds(result.wallMs.clean)} + `:''}retarget ${seconds(result.wallMs.retarget)} + compile ${seconds(result.wallMs.compile)}`;
 const kept=result.motion?(result.motion.kept?'the rig\'s own animations unchanged':`changed: ${result.motion.changed.join(', ')}`):'';
 return {text:`Retargeted "${r.flags.animation}" from ${r.sequence.reference} with ${result.producer.package} ${result.producer.version} · ${wall} · ${kept} · ${result.files?filesDiffText(result.files):'no diff'} · Reset returns to the inspected build`,error:!!result.motion&&!result.motion.kept};
}
/** A keyed animation Apply's job (#235): spliced animations_from, `rig-parts rig`, compile, `rig-parts check`, per-file diff. */
export interface AnimationJobView {id:string;kind:'animation';op:'rig';status:'running'|'built'|'refused'|'failed';reused:boolean;lines:string[];producerLine:string|null;hint?:string;exitCode:number|null;wallMs:{op:number|null;compile:number|null;check:number|null};check:CheckSummary|null;files:FilesDiff|null;build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null;request:{configHash:string;animationsFrom:{path:string;beforeSha256:string;afterSha256:string};ops:AnimationSourceOp[];opsSha256:string;args?:string[]};producer:{package:string;version:string};compiler:{package:string;version:string}}
export interface AnimationRequestBody {animation:{configHash:string;animationsFromHash:string;ops:AnimationSourceOp[];args?:string[]}}
export const animationAppliedRecord=(job:AnimationJobView):AppliedAnimation=>({schema:APPLIED_ANIMATION_SCHEMA,buildId:job.id,configHash:job.request.configHash,animationsFrom:{...job.request.animationsFrom},ops:JSON.parse(JSON.stringify(job.request.ops)),opsSha256:job.request.opsSha256,producer:job.producer,compiler:job.compiler,line:job.producerLine,check:job.check,files:job.files,modelHash:job.build!.modelHash});
export function animationOutcomeLine(result:AnimationJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:refusedText(result),error:true};
 const check=result.check?(result.check.pass===null?`check refused: ${result.check.line??`exit ${result.check.exitCode}`}`:`check ${result.check.pass?'PASS':'FAIL'}`):'check not run';
 const wall=result.reused?'reused the scratch build of this exact animation edit':`rig ${seconds(result.wallMs.op)} + compile ${seconds(result.wallMs.compile)} + check ${seconds(result.wallMs.check)}`;
 const anims=[...new Set(result.request.ops.map(o=>o.animation))];
 return {text:`Applied animation ${result.request.opsSha256.slice(0,12)}… (${result.request.ops.length} op(s) on ${anims.join(', ')}) with ${result.producer.package} ${result.producer.version} · ${wall} · ${check} · ${result.files?filesDiffText(result.files):'no diff'} · Reset returns to the inspected build`,error:!!result.check&&result.check.pass!==true};
}
export type AnyJobView=RebuildJobView|PatchJobView|DeltaJobView|RetargetJobView|AnimationJobView;
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
export const patchAppliedRecord=(job:PatchJobView):AppliedPatch=>({schema:APPLIED_PATCH_SCHEMA,buildId:job.id,patch:job.request.patch,patchSha256:job.request.patchSha256,configHash:job.request.configHash,producer:job.producer,compiler:job.compiler,line:job.producerLine,check:job.check,diff:job.diff,...(job.files?{files:job.files}:{}),modelHash:job.build!.modelHash,...(job.op?{op:job.op}:{}),...(job.remesh?{mesh:{part:job.remesh.part,before:{...job.remesh.before},after:{...job.remesh.after}}}:{}),...(job.op==='cloth'&&job.cloth?{cloth:{route:job.cloth.route,keypoints:{...job.cloth.inputs.keypoints},written:{count:job.cloth.written?.count??0,paths:[...(job.cloth.written?.paths??[])]}}}:{}),...(job.op==='build'||(job.op==='cloth'&&job.cloth?.route==='build')?{assembled:assembledRecord(job)}:{}),...(job.environment?{environment:{...job.environment}}:{})});
/** #115: what a build Apply records: the build's own wall clock, the recomposite figures, the parts it changed and its `seam pair` lines. */
export function assembledRecord(job:PatchJobView):AppliedAssembled {
 const a=job.assembled,fig=(f:Record<string,number>|null|undefined)=>f?{...f}:null;
 return {wallMs:job.op==='cloth'?job.cloth?.wallMs.build??null:job.wallMs.op,recomposite:{before:fig(a?.recomposite.before as Record<string,number>|null),after:fig(a?.recomposite.after as Record<string,number>|null)},partsChanged:[...(a?.parts?.changed??[])],seamPairs:(a?.seamPairs??[]).slice(0,64)};
}
/** What the draft keeps and `context.applied` carries for a delta: the document and its hash, the producer's line, op "remesh", the diff and the counts. */
export const deltaAppliedRecord=(job:DeltaJobView):AppliedDelta=>({schema:APPLIED_DELTA_SCHEMA,buildId:job.id,part:job.request.part,delta:JSON.parse(JSON.stringify(job.request.delta)),deltaSha256:job.request.deltaSha256,configHash:job.request.configHash,producer:job.producer,compiler:job.compiler,line:job.producerLine,op:'remesh',files:job.files,...(job.remesh?{mesh:{part:job.remesh.part,before:{...job.remesh.before},after:{...job.remesh.after}}}:{}),modelHash:job.build!.modelHash});
/** A delta job's status line: built (wall clocks, counts, the per-file diff) or the producer's line verbatim. */
export function deltaOutcomeLine(result:DeltaJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:refusedText(result),error:true};
 const ops=Array.isArray(result.request.delta.ops)?result.request.delta.ops.length:0;
 const wall=result.reused?'reused the scratch build of this exact delta':`remesh --delta ${seconds(result.wallMs.op)} + compile ${seconds(result.wallMs.compile)}`;
 const counts=result.remesh?` · ${result.remesh.part} v ${result.remesh.before.vertices} t ${result.remesh.before.triangles} → v ${result.remesh.after.vertices} t ${result.remesh.after.triangles}`:'';
 return {text:`Applied mesh edit ${result.request.deltaSha256.slice(0,12)}… (${ops} op(s) on ${result.request.part}) with ${result.producer.package} ${result.producer.version} · ${wall}${counts} · ${result.files?filesDiffText(result.files):'no diff'} · Reset returns to the inspected build`,error:false};
}
/**
 * What the stage draws after an Apply: the scratch build when the job built one, else what it drew before — a
 * refusal, a failure or a busy reply leaves the stage's model (and its hash) as it was.
 */
export function stageModel(result:AnyJobView|RebuildRefusal,current:{url:string;hash:string}):{url:string;hash:string;id:string|null} {
 if('id' in result&&result.status==='built'&&result.build)return {url:result.build.modelUrl,hash:result.build.modelHash,id:result.id};
 return {...current,id:null};
}
/** #148: a refused job's line — the producer's line as printed, then review's reading of it when the server added one. */
export const refusedText=(job:{producerLine:string|null;exitCode:number|null;hint?:string}):string=>`${job.producerLine??`REBUILD_FAILED: exit ${job.exitCode}`}${job.hint?` · review: ${job.hint}`:''}`;
const seconds=(ms:number|null)=>ms===null?'—':`${(ms/1000).toFixed(1)} s`;
/** A patch job's status line: built (wall clocks, check's verdict, the per-file diff — #125) or the producer's line verbatim. */
export function patchOutcomeLine(result:PatchJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:refusedText(result),error:true};
 const check=result.check?(result.check.pass===null?`check refused: ${result.check.line??`exit ${result.check.exitCode}`}`:`check ${result.check.pass?'PASS':'FAIL'}${result.check.source==='retune'||result.check.source==='remesh'?` (${result.check.source}'s own check of this revision, not run again)`:''}`):'check not run';
 // #115: a build's own wall clock covers assemble, rig and check; the recorded figure is the same number.
 const building=result.op==='build'||(result.op==='cloth'&&result.cloth?.route==='build');
 const propose=result.op==='cloth'&&result.cloth?`propose ${seconds(result.cloth.wallMs.propose)} (wrote a config differing at ${result.cloth.written?.count??'?'} path(s)) + `:'';
 const wall=building?`${result.reused?'reused the scratch build of this exact patch · ':''}${propose}build ${seconds(result.op==='cloth'?result.cloth?.wallMs.build??null:result.wallMs.op)} (assemble → rig → check) + compile ${seconds(result.wallMs.compile)}`:result.reused?'reused the scratch build of this exact patch':`${propose}${result.op==='cloth'?'rig':result.op??result.request.patch.op.cmd} ${seconds(result.op==='cloth'?result.cloth?.wallMs.build??null:result.wallMs.op)} + compile ${seconds(result.wallMs.compile)}${result.check?.source==='retune'||result.check?.source==='remesh'?'':` + check ${seconds(result.wallMs.check)}`}`;
 return {text:`Applied patch ${result.request.patchSha256.slice(0,12)}… (${result.request.patch.ops.length} op(s)) with ${result.producer.package} ${result.producer.version} · ${wall} · ${check}${result.environment?` under the exported world (${result.environment.steps} step(s), sha256 ${result.environment.sha256.slice(0,16)})`:''} · ${result.files?filesDiffText(result.files):`rig.json differs at ${result.diff?.count??'?'} path(s)`} · Reset returns to the inspected build`,error:!!result.check&&result.check.pass!==true};
}
/** The status line after a job: built (with the wall clock and whether the scratch build was reused) or the producer's line verbatim. */
export function outcomeLine(result:RebuildJobView|RebuildRefusal):{text:string;error:boolean} {
 if(!('id' in result))return {text:result.producerLine??result.error,error:true};
 if(result.status!=='built')return {text:refusedText(result),error:true};
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

/** #166: `GET /api/rebuild/history` — the session's applied records in order; the last is on the stage; `kept`: its build is on disk. */
export interface AppliedHistoryView {schema:'rig-review-applied-history/1';depth:number;records:{id:string;kind:'regions'|'patch'|'delta'|'retarget'|'animation';op:string;what:string;modelHash:string;kept:boolean}[]}
/** #166: `POST /api/rebuild/undo {from}` — the predecessor's build (kept, or re-run and still running), the inspected build, or a refusal. */
export type UndoView=
 |{status:'inspected';undone:string;history:AppliedHistoryView}
 |{status:'built';undone:string;job:AnyJobView;history:AppliedHistoryView}
 |{status:'running';undone:string;job:AnyJobView}
 |RebuildRefusal;
/** #166: the applied record a job carries into `context.applied` (the same shapes each Apply records). */
export function recordFor(job:AnyJobView):AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|AppliedAnimation {
 const kind=(job as {kind?:string}).kind;
 return kind==='patch'?patchAppliedRecord(job as PatchJobView):kind==='delta'?deltaAppliedRecord(job as DeltaJobView):kind==='retarget'?retargetAppliedRecord(job as RetargetJobView):kind==='animation'?animationAppliedRecord(job as AnimationJobView):appliedRecord(job as RebuildJobView);
}
/**
 * What a retarget build on the stage sets beside its model (#164, #186): its new animation, to select, and that
 * animation's own clock (the run's report frameTimes) bound to the build's model hash. The same for an Apply and for an
 * Undo that restores a retarget build; null for any other job (it restores no retarget selection or clock).
 */
export function retargetStage(job:AnyJobView,modelHash:string):{animation:string;clock:StageClock|null}|null {
 if((job as {kind?:string}).kind!=='retarget')return null;
 const r=job as RetargetJobView,animation=r.request.record.flags.animation,own=samplesClock(r.frameTimes);
 return {animation,clock:own?{animation,modelHash,clock:own}:null};
}
/** #166: one record's line in the list: its place, what it applied, the op and the model; the stage's last is marked. */
export function historyRow(history:AppliedHistoryView,index:number):string {
 const r=history.records[index]!,last=index===history.records.length-1;
 return `${index+1}. ${r.kind} (${r.op}) · ${r.what} · model ${r.modelHash.slice(0,12)}…${last?' · on the stage':r.kept?'':' · build evicted, an undo to it re-runs its step'}`;
}
/** #166: the Undo control's label and whether it can run: the depth, and what the stage returns to. */
export function undoControl(history:AppliedHistoryView|null,stageId:string|null,busy:boolean):{label:string;enabled:boolean;title:string} {
 const depth=history?.depth??0,top=history?.records.at(-1)??null;
 const label=`Undo last Apply (${depth} deep)`;
 if(!top)return {label,enabled:false,title:'No Apply is on the stage'};
 if(stageId!==top.id)return {label,enabled:false,title:'The stage does not show the last Apply (Reset shows the inspected build); undo acts on the last Apply only'};
 const back=depth>1?`record ${depth-1} (model ${history!.records[depth-2]!.modelHash.slice(0,12)}…)`:'the inspected build';
 return {label,enabled:!busy,title:`Return the stage to ${back}; the package is unchanged`};
}
/**
 * #183: a density-strip row pending on the stage after a stage change. Every landed Apply — whichever block sent it
 * (regions, any patch block, Edit Mesh's delta, retarget) — and every Reset and Undo replaces the stage the row was
 * loaded over and moves the server's stack, so the row stops being pending and Back has nothing to return to (returning
 * would restore a stale stage over the applied record). A refused or failed step leaves the stage, and the row, as they
 * were; only Load puts a row on the stage.
 */
export type StageChange<P>=
 |{kind:'apply';via:'regions'|'mesh'|'physics'|'idle'|'cuts'|'cloth'|'rig-fields'|'bones'|'patch'|'delta'|'retarget'|'animation'}
 |{kind:'reset'}|{kind:'undo'}|{kind:'refused'}
 |{kind:'load';row:P};
export function stripPendingAfter<P>(pending:P|null,change:StageChange<P>):P|null {
 if(change.kind==='load')return change.row;
 if(change.kind==='refused')return pending;
 return null;
}
