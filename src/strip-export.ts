import { createHash } from 'node:crypto';
import { realpath, stat, lstat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, parse, sep, type posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadReview, safeFile, type ReviewPackage } from './manifest.ts';
import { assertCompareUnchanged, safeCompareReference, type ComparePackage } from './compare.ts';
import { parseStripRequest, planStrip, type StripBinding, type StripPlan, type StripRenderInput, type StripRenderResult } from './strip.ts';
export interface StripExportOptions {render?:(input:StripRenderInput)=>Promise<StripRenderResult>}
export interface StripExport {plan:StripPlan;rendering:(Omit<StripRenderResult,'png'>&{pngSha256:string})|null;png:Uint8Array|null}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function unchanged(p:ReviewPackage){try{const current=await loadReview(p.manifestPath);if(current.sourceHash!==p.sourceHash||!isDeepStrictEqual(current.reviewedSource,p.reviewedSource))throw new Error('source binding differs');}catch(e){throw new Error(`Strip inputs changed. Restart review before export. ${e instanceof Error?e.message:String(e)}`);}}
/** Streaming identity remains bounded even for long source videos and JSON plans. */
export async function hashStripReference(path:string,onChunk?:(size:number)=>void){
  const canonical=await realpath(path),before=await stat(canonical);if(!before.isFile())throw new Error('strip.reference: expected regular video');
  const hash=createHash('sha256');for await(const chunk of createReadStream(canonical,{highWaterMark:65536})){hash.update(chunk);onChunk?.(chunk.length);}
  const after=await stat(canonical);if(await realpath(path)!==canonical||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Strip inputs changed: reference changed while hashing');
  return {path:canonical,name:basename(canonical),sha256:hash.digest('hex')};
}
const referenceFile=hashStripReference;
async function verifyReference(original:{path:string;sha256:string}){const current=await referenceFile(original.path);if(current.path!==original.path||current.sha256!==original.sha256)throw new Error('Strip inputs changed: reference video changed during export');}
function requireAnimation(p:ReviewPackage,animation:string,png:boolean){const clips=p.feedbackCatalog.animations;if(clips&&!clips.some(c=>c.name===animation))throw new Error(`strip.animation: ${JSON.stringify(animation)} not in model`);if(png&&(!p.manifest.model||!clips))throw new Error('strip.model: compiled model required for PNG');}
async function finish(plan:StripPlan,referencePath:string,packages:{id:'single'|'a'|'b';p:ReviewPackage}[],png:boolean,verify:()=>Promise<void>,options:StripExportOptions):Promise<StripExport>{
  let rendered:StripRenderResult|null=null;
  if(png){const rigs:StripRenderInput['rigs']=[];for(const {id,p} of packages){requireAnimation(p,plan.animation,true);rigs.push({id,root:p.root,modelPath:await safeFile(p.root,p.manifest.model!),animation:plan.animation,clock:p.report?.animation===plan.animation?p.report.clock:null});}const render=options.render??(await import('./strip-render.ts')).renderStrip;rendered=await render({plan,referencePath,rigs});}
  await verify();
  if(!rendered)return {plan,rendering:null,png:null};
  const {png:bytes,...details}=rendered;return {plan,rendering:{...details,pngSha256:sha(bytes)},png:bytes};
}
export async function exportReviewStrip(p:ReviewPackage,input:unknown,options:StripExportOptions={}):Promise<StripExport>{
  const request=parseStripRequest(input);await unchanged(p);requireAnimation(p,request.animation,false);
  if(!request.referenceId)throw new Error('strip.referenceId: explicitly select a declared reference video');
  const selected=p.manifest.references.find(r=>r.id===request.referenceId&&r.type==='video');if(!selected)throw new Error('strip.referenceId: expected declared reference video id');
  const reference=await referenceFile(await safeFile(p.root,selected.path));
  const binding:StripBinding={sourceHash:p.sourceHash,packages:[{id:'single',label:p.manifest.title,sourceHash:p.sourceHash,reviewedSource:p.reviewedSource}],reference:{name:reference.name,sha256:reference.sha256},compare:null};
  const plan=planStrip(request,{mode:'single',binding,reports:{single:p.report}});
  return finish(plan,reference.path,[{id:'single',p}],request.format==='png',async()=>{await unchanged(p);const current=await safeFile(p.root,selected.path);if(current!==reference.path)throw new Error('Strip inputs changed: reference path changed');await verifyReference(reference);},options);
}
export async function exportCompareStrip(p:ComparePackage,input:unknown,options:StripExportOptions={}):Promise<StripExport>{
  const request=parseStripRequest(input);await assertCompareUnchanged(p);if(request.animation!==p.response.animation)throw new Error('strip.animation: expected fixed comparison animation');
  const reference=await referenceFile(await safeCompareReference(p));if(reference.sha256!==p.response.binding.reference.sha256)throw new Error('Strip inputs changed: reference hash differs');
  const binding:StripBinding={sourceHash:p.response.sourceHash,packages:(['a','b'] as const).map(id=>({id,label:`${id.toUpperCase()}: ${p[id].manifest.title}`,sourceHash:p[id].sourceHash,reviewedSource:p[id].reviewedSource})),reference:p.response.binding.reference,compare:p.response.binding};
  const plan=planStrip(request,{mode:'compare',binding,reports:{a:p.a.report,b:p.b.report}});
  return finish(plan,reference.path,[{id:'a',p:p.a},{id:'b',p:p.b}],request.format==='png',async()=>{await assertCompareUnchanged(p);await safeCompareReference(p);await verifyReference(reference);},options);
}
export function stripJson(result:StripExport):string{return JSON.stringify({plan:result.plan,rendering:result.rendering},null,2)+'\n';}
/** Pure boundary rules also exercise Windows paths on a non-Windows verifier. */
export function stripPathIsInside(root:string,target:string,paths:Pick<typeof posix,'relative'|'isAbsolute'|'sep'>={relative,isAbsolute,sep}):boolean{
  const rel=paths.relative(root,target);return rel===''||(!rel.startsWith('..'+paths.sep)&&rel!=='..'&&!paths.isAbsolute(rel));
}
export function stripParentPaths(target:string,paths:Pick<typeof posix,'relative'|'parse'|'dirname'|'resolve'|'sep'>={relative,parse,dirname,resolve,sep}):string[]{
  const base=paths.parse(target).root,parts=paths.relative(base,paths.dirname(target)).split(paths.sep).filter(Boolean),parents:string[]=[];let cursor=base;
  for(const part of parts){cursor=paths.resolve(cursor,part);parents.push(cursor);}return parents;
}
/** No symlink parent or package-contained path can become a derived output target. */
export async function validateStripOutput(output:string,roots:string[]):Promise<string>{
  const target=resolve(output);
  for(const parent of stripParentPaths(target)){const info=await lstat(parent);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('strip.output: parent must be an existing directory without symlinks');}
  for(const root of roots)if(stripPathIsInside(await realpath(root),target))throw new Error('strip.output: derived files must be outside every source package');
  try{await lstat(target);throw new Error('strip.output: destination already exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  return target;
}
export async function writeStripOutput(result:StripExport,output:string,roots:string[]):Promise<void>{
  const destination=await validateStripOutput(output,roots);const bytes=result.png??stripJson(result);
  if(result.png){const sidecar=await validateStripOutput(destination+'.json',roots);await writeFile(destination,bytes,{flag:'wx'});await writeFile(sidecar,stripJson(result),{flag:'wx'});}else await writeFile(destination,bytes,{flag:'wx'});
}
