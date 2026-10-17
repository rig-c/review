import { createHash } from 'node:crypto';
import { toolVersions } from './versions.ts';
import { validatePoseSequence } from './pose.ts';
import { parseReport, type ReportSeeds } from './report.ts';
import { readFile, realpath, stat, lstat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, posix } from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Reference { id: string; label: string; type: 'image' | 'video' | 'pose'; path: string; width?: number; height?: number }
export interface Checkpoint { id: string; title: string; time?: number; animation?: string; reference?: string; note?: string; workspace?: 'modeling' | 'motion'; camera?: { zoom: number; x: number; y: number }; axis?: {id:string;value:number} }
export interface ReviewManifest {
  schema: 'rig-review/1'; id: string; title: string; revision: string; model?: string; motion?: string;
  references: Reference[]; animations: { id: string; label?: string; duration?: number }[];
  checkpoints: Checkpoint[]; authoring: { label: string; path: string }[];
  axes: { id: string; label: string; animation: string; min: number; max: number }[];
  audio: { clips: { id: string; label?: string; path: string }[]; cues: { id: string; clip: string; time: number; animation?: string }[] };
}
export interface ReviewedSource { readonly packageRevision:string; readonly viewerVersion:string; readonly runtimeVersion:string; readonly rig:{readonly path:string;readonly sha256:string}|null; readonly motion:{readonly path:string;readonly sha256:string}|null }
export interface ReviewPackage { root: string; manifestPath: string; manifest: ReviewManifest; sourceHash: string; reviewedSource:ReviewedSource; files: Set<string>; report:ReportSeeds|null }
function fail(field: string, expected: string): never { throw new Error(`${field}: expected ${expected}`); }
export function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'object'); return value as Record<string, unknown>; }
export function string(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 10000) fail(field, 'nonempty string (at most 10000 characters)'); return value; }
function id(value: unknown, field: string): string { const s = string(value, field); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(s)) fail(field, 'identifier [A-Za-z0-9][A-Za-z0-9._-], at most 128 characters'); return s; }
export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T { if (!choices.includes(value as T)) fail(field, choices.join(' | ')); return value as T; }
function number(value: unknown, field: string, min = 0): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(field, `finite number >= ${min}`); return value; }
function optionalString(value: unknown, field: string): string | undefined { return value === undefined ? undefined : string(value, field); }
function optionalNumber(value: unknown, field: string): number | undefined { return value === undefined ? undefined : number(value, field); }
function list<T>(value: unknown, field: string, parse: (v: Record<string, unknown>, field: string) => T): T[] {
  if (value === undefined) return []; if (!Array.isArray(value) || value.length > 10000) fail(field, 'array of at most 10000 entries');
  const result = value.map((v, i) => parse(object(v, `${field}[${i}]`), `${field}[${i}]`));
  const ids = result.filter((v): v is T & { id: string } => !!v && typeof v === 'object' && 'id' in v);
  if (new Set(ids.map(v => v.id)).size !== ids.length) fail(field, 'unique ids'); return result;
}
/** Manifest paths are literal portable relative paths, never encoded URLs. */
export function packagePath(value: unknown, field = 'path'): string {
  const p = string(value, field);
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p) || /[:\\%?#\x00-\x1f]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..') || posix.normalize(p) !== p) fail(field, 'literal relative path inside package; no traversal, encoding, backslash, query or fragment');
  return p;
}
export async function safeFile(root: string, path: string): Promise<string> {
  packagePath(path); const full = await realpath(resolve(root, path)); const rel = relative(root, full);
  if (!rel || rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) fail(path, 'file inside package (symlinks may not escape)');
  if (!(await stat(full)).isFile()) fail(path, 'regular file'); return full;
}
export function parseManifest(input: unknown): ReviewManifest {
  const m = object(input, 'review'); if (m.schema !== 'rig-review/1') fail('schema', 'rig-review/1');
  const audio = m.audio === undefined ? {} : object(m.audio, 'audio');
  const manifest: ReviewManifest = {
    schema: 'rig-review/1', id: id(m.id, 'id'), title: string(m.title, 'title'), revision: string(m.revision, 'revision'),
    model: m.model === undefined ? undefined : packagePath(m.model, 'model'),
    motion:m.motion===undefined?undefined:packagePath(m.motion,'motion'),
    references: list(m.references, 'references', (v,f) => ({ id:id(v.id,f+'.id'), label:string(v.label,f+'.label'), type:choice(v.type,['image','video','pose'],f+'.type'), path:packagePath(v.path,f+'.path'), width:v.width===undefined?undefined:number(v.width,f+'.width',Number.EPSILON), height:v.height===undefined?undefined:number(v.height,f+'.height',Number.EPSILON) })),
    animations: list(m.animations,'animations',(v,f) => ({id:id(v.id,f+'.id'),label:optionalString(v.label,f+'.label'),duration:optionalNumber(v.duration,f+'.duration')})),
    checkpoints: list(m.checkpoints,'checkpoints',(v,f) => ({id:id(v.id,f+'.id'),title:string(v.title,f+'.title'),time:optionalNumber(v.time,f+'.time'),animation:optionalString(v.animation,f+'.animation'),reference:optionalString(v.reference,f+'.reference'),note:optionalString(v.note,f+'.note'),workspace:v.workspace === undefined ? undefined : choice(v.workspace,['modeling','motion'] as const,f+'.workspace'),axis:v.axis===undefined?undefined:(()=>{const a=object(v.axis,f+'.axis');return {id:id(a.id,f+'.axis.id'),value:number(a.value,f+'.axis.value',-Number.MAX_VALUE)};})(),camera:v.camera === undefined ? undefined : (() => {const c=object(v.camera,f+'.camera'); const zoom=number(c.zoom,f+'.camera.zoom',Number.EPSILON); return {zoom,x:number(c.x,f+'.camera.x',-Number.MAX_VALUE),y:number(c.y,f+'.camera.y',-Number.MAX_VALUE)};})()})),
    authoring:list(m.authoring,'authoring',(v,f)=>({label:string(v.label,f+'.label'),path:packagePath(v.path,f+'.path')})),
    axes:list(m.axes,'axes',(v,f)=>({id:id(v.id,f+'.id'),label:string(v.label,f+'.label'),animation:string(v.animation,f+'.animation'),min:number(v.min,f+'.min',-Number.MAX_VALUE),max:number(v.max,f+'.max',-Number.MAX_VALUE)})),
    audio:{clips:list(audio.clips,'audio.clips',(v,f)=>({id:id(v.id,f+'.id'),label:optionalString(v.label,f+'.label'),path:packagePath(v.path,f+'.path')})),cues:list(audio.cues,'audio.cues',(v,f)=>({id:id(v.id,f+'.id'),clip:string(v.clip,f+'.clip'),time:number(v.time,f+'.time'),animation:optionalString(v.animation,f+'.animation')}))}
  };
  if(manifest.model&&!manifest.model.endsWith('.model.json'))fail('model','compiled model path ending .model.json (the play runtime input)');
  for (const c of manifest.checkpoints) { if(c.reference && !manifest.references.some(r=>r.id===c.reference)) fail(`checkpoint ${c.id}.reference`,'declared reference id'); if(c.animation && !manifest.animations.some(a=>a.id===c.animation)) fail(`checkpoint ${c.id}.animation`,'declared animation id'); }
  for (const c of manifest.audio.cues) { if(!manifest.audio.clips.some(a=>a.id===c.clip)) fail(`cue ${c.id}.clip`,'declared audio clip id'); if(c.animation && !manifest.animations.some(a=>a.id===c.animation)) fail(`cue ${c.id}.animation`,'declared animation id'); }
  for (const a of manifest.axes) { if(a.min >= a.max) fail(`axis ${a.id}`,'min < max'); if(!manifest.animations.some(v=>v.id===a.animation)) fail(`axis ${a.id}.animation`,'declared animation id'); }
  for(const c of manifest.checkpoints) if(c.axis){const a=manifest.axes.find(a=>a.id===c.axis!.id);if(!a)fail(`checkpoint ${c.id}.axis`,'declared axis id');if(c.axis.value<a.min||c.axis.value>a.max)fail(`checkpoint ${c.id}.axis.value`,`number in [${a.min}, ${a.max}]`);}
  return manifest;
}
export async function loadReview(input: string): Promise<ReviewPackage> {
  const inputPath=await realpath(resolve(input));const directory=(await stat(inputPath)).isDirectory();
  if(directory){try{await stat(resolve(inputPath,'review.json'));return loadReview(resolve(inputPath,'review.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  const manifestPath=inputPath;const root=directory?inputPath:await realpath(dirname(inputPath));
  const manifest=directory?await folderManifest(root):parseManifest(JSON.parse(await readFile(manifestPath,'utf8')));
  const files = new Set([...(directory?[]:[relative(root,manifestPath)]),...manifest.references.map(v=>v.path),...manifest.authoring.map(v=>v.path),...manifest.audio.clips.map(v=>v.path)]);
  const rootFile=async(name:string):Promise<string|undefined>=>{try{await safeFile(root,name);return name;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}};
  const authoringPath=(name:string):string|undefined=>{const paths=manifest.authoring.filter(v=>posix.basename(v.path)===name);return paths.length===1?paths[0].path:undefined;};
  const rigPath=manifest.model??await rootFile('skeleton.json')??authoringPath('skeleton.json')??await rootFile('skeleton.skel')??authoringPath('skeleton.skel');
  const motionPath=manifest.motion??await rootFile('motion.json')??authoringPath('motion.json');
  if(rigPath)files.add(rigPath);if(motionPath)files.add(motionPath);
  if(manifest.model) {
    files.add(manifest.model); const model = object(JSON.parse(await readFile(await safeFile(root,manifest.model),'utf8')),'model');
    if(model.spec !== 'rigc-compiled/3') fail('model.spec','rigc-compiled/3, produced by a gated rigc build');
    if(!Array.isArray(model.pages)) fail('model.pages','array');
    for(const page of model.pages) { const p = object(page,'model.pages[]'); const name = string(p.name,'model.pages[].name'); if(isAbsolute(name)||/[:\\%?#\x00-\x1f]/.test(name)||name.split('/').some(v=>!v))fail('model.pages[].name','literal relative model page path'); files.add(packagePath(posix.join(posix.dirname(manifest.model),name),'model page resolved inside package')); }
  }
  for(const r of manifest.references.filter(r=>r.type==='pose')) {
    const pose=object(JSON.parse(await readFile(await safeFile(root,r.path),'utf8')),`pose ${r.id}`);
    if(pose.spec==='rig-pose-sequence/1'){validatePoseSequence(pose,`pose ${r.id}`);continue;}
    if(pose.schema!=='rig-review-pose/1'||pose.coordinateSystem!=='image-pixels-y-down') fail(`pose ${r.id}`,'rig-review-pose/1 with image-pixels-y-down coordinates');
    number(pose.width,`pose ${r.id}.width`,Number.EPSILON); number(pose.height,`pose ${r.id}.height`,Number.EPSILON);
    const joints=list(pose.joints,`pose ${r.id}.joints`,(v,f)=>({id:id(v.id,f+'.id'),x:number(v.x,f+'.x',-Number.MAX_VALUE),y:number(v.y,f+'.y',-Number.MAX_VALUE),parent:optionalString(v.parent,f+'.parent')}));
    for(const j of joints) if(j.parent&&!joints.some(v=>v.id===j.parent&&v.id!==j.id)) fail(`pose ${r.id} joint ${j.id}.parent`,'another declared joint id');
  }
  const reportPath=files.has('report.json')?'report.json':authoringPath('report.json');let report:ReportSeeds|null=null;
  const hash = createHash('sha256');hash.update(JSON.stringify(manifest));hash.update('\0');const fileHashes=new Map<string,string>();
  for(const p of [...files].sort()) { const full=await safeFile(root,p); const before=await stat(full); hash.update(p);hash.update('\0');hash.update(String(before.size));hash.update('\0'); const fileHash=createHash('sha256');const reportChunks:Buffer[]=[];for await(const chunk of createReadStream(full)){hash.update(chunk);fileHash.update(chunk);if(p===reportPath)reportChunks.push(chunk);}fileHashes.set(p,fileHash.digest('hex')); const after=await stat(full); if(before.size!==after.size||before.mtimeMs!==after.mtimeMs) throw new Error(`Asset ${p} changed while hashing; retry with stable package inputs`);
    // The parser and package hash consume the same bytes, never two file reads.
    if(p===reportPath){let value:unknown;try{value=JSON.parse(Buffer.concat(reportChunks).toString('utf8'));}catch(e){throw new Error(`${p}: ${e instanceof Error?e.message:String(e)}`);}report=parseReport(value,p);}
  }
  const reviewedSource:ReviewedSource={packageRevision:manifest.revision,...await toolVersions(),rig:rigPath?{path:rigPath,sha256:fileHashes.get(rigPath)!}:null,motion:motionPath?{path:motionPath,sha256:fileHashes.get(motionPath)!}:null};
  return {root,manifestPath,manifest,sourceHash:hash.digest('hex'),reviewedSource,files,report};
}

/** An adapter over an existing output directory; never writes a manifest there. */
async function folderManifest(root:string):Promise<ReviewManifest>{
  const entries=(await readdir(root,{withFileTypes:true})).filter(v=>v.isFile()||v.isSymbolicLink()).map(v=>v.name).sort();
  const has=(name:string)=>entries.includes(name);const references:Reference[]=[];
  let model:string|undefined;
  // These are named layouts, not a recursive search. Check existence separately
  // so an existing broken symlink is refused rather than treated as absent.
  for(const candidate of ['skeleton.model.json','build/skeleton.model.json']){
    try{await lstat(resolve(root,candidate));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
    await safeFile(root,candidate);model=candidate;break;
  }
  for(const name of entries){
    if(/\.(mp4|webm|mov)$/i.test(name))references.push({id:`video-${references.length+1}`,label:name,type:'video',path:name});
    if(/(strip|contact|sheet|띠|filmstrip)/i.test(name)&&/\.(png|jpe?g|webp|svg)$/i.test(name))references.push({id:`strip-${references.length+1}`,label:name,type:'image',path:name});
    if(/pose/i.test(name)&&/\.json$/i.test(name)){const value=JSON.parse(await readFile(await safeFile(root,name),'utf8'));if(value?.spec==='rig-pose-sequence/1'||value?.schema==='rig-review-pose/1')references.push({id:`pose-${references.length+1}`,label:name,type:'pose',path:name});}
  }
  const name=basename(root);const packageId=name.replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^[^a-zA-Z0-9]+/,'').slice(0,128)||'output-bundle';
  const authoring=entries.filter(n=>n==='motion.json'||n==='report.json'||(/^skeleton\./i.test(n)&&n!=='skeleton.model.json')).map(path=>({label:path+' · read only',path}));
  if(!references.length&&!authoring.length&&!model)throw new Error('Output folder: no recognized skeleton.*, build/skeleton.model.json, motion.json, report.json, source video, pose sequence or contact strip');
  return parseManifest({schema:'rig-review/1',id:packageId,title:name,revision:'folder-adapter/1',model,motion:has('motion.json')?'motion.json':undefined,references,authoring,checkpoints:references.map(r=>({id:r.id,title:'Inspect '+r.label,reference:r.id,workspace:'motion'}))});
}
