/** CLI-only historical retrieval. Current UI/save identities remain strict. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { object, string, type ReviewedSource, type ReviewPackage } from './manifest.ts';
import { freshSession, parseSession, sessionFile, type ReviewSession } from './session.ts';
import { freshCompareSession, parseCompareSession, compareSessionFile, type CompareSession } from './compare-session.ts';
import { assertCompareUnchanged, type CompareBinding, type ComparePackage } from './compare.ts';

type Tools=Pick<ReviewedSource,'viewerVersion'|'runtimeVersion'>;
export interface HistoryRetrieval {kind:'prior-tools';toolsChangedSince:true;matchingSubmissions:number;currentTools:Tools|{a:Tools;b:Tools}}
export type FeedbackHistory<T> = T & {retrieval?:HistoryRetrieval;historyWarnings?:{file:string;error:string}[]};
const MAX_FILE_BYTES=32*1024*1024,MAX_SCAN_BYTES=64*1024*1024;
const tools=(source:ReviewedSource):Tools=>({viewerVersion:source.viewerVersion,runtimeVersion:source.runtimeVersion});
function content(source:unknown):unknown {if(!source||typeof source!=='object'||Array.isArray(source))return null;return {...source,viewerVersion:null,runtimeVersion:null};}
function recordedSource(value:unknown,current:ReviewedSource):ReviewedSource|null {
 if(!isDeepStrictEqual(content(value),content(current)))return null;
 const source=object(value,'history.reviewedSource');
 return {...current,viewerVersion:string(source.viewerVersion,'history.viewerVersion'),runtimeVersion:string(source.runtimeVersion,'history.runtimeVersion')};
}
/** Read a regular file through a no-follow descriptor with a fixed byte ceiling. */
async function readRecord(file:string,budget:{bytes:number}):Promise<unknown>{
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat();if(!before.isFile())throw new Error('not a regular file');
  if(before.size>MAX_FILE_BYTES)throw new Error('exceeds 32 MiB history file limit');
  budget.bytes+=before.size;if(budget.bytes>MAX_SCAN_BYTES)throw new Error('feedback history: exceeds 64 MiB search limit');
  const buffer=Buffer.alloc(before.size+1);let size=0;
  while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}
  const after=await handle.stat();if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('changed while reading');
  try{return JSON.parse(buffer.subarray(0,size).toString('utf8'));}catch{throw new Error('invalid JSON');}
 }finally{await handle.close();}
}
function submittedAt(value:unknown):number {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))throw new Error('feedback history.updatedAt: expected saved ISO timestamp');
 const time=Date.parse(value);if(!Number.isFinite(time)||new Date(time).toISOString()!==value)throw new Error('feedback history.updatedAt: expected saved ISO timestamp');return time;
}
/** Recheck at the return boundary: a concurrent current save beats history. */
export async function preferCurrentSession<T>(readCurrent:()=>Promise<T|null>,readHistory:()=>Promise<T>):Promise<T>{
 const current=await readCurrent();if(current!==null)return current;
 try{const historical=await readHistory();return (await readCurrent())??historical;}
 catch(error){const concurrent=await readCurrent();if(concurrent!==null)return concurrent;throw error;}
}
async function currentRecord<T>(file:string,parse:(value:unknown)=>T):Promise<T|null>{
 try{return parse(await readRecord(file,{bytes:0}));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
async function discover<T extends {updatedAt:string|null}>(file:string,readCurrent:()=>Promise<T|null>,fresh:T,candidate:(value:Record<string,unknown>,name:string)=>T|null,currentTools:HistoryRetrieval['currentTools']):Promise<FeedbackHistory<T>>{
 return preferCurrentSession<FeedbackHistory<T>>(readCurrent,async()=>{
 let directory:Awaited<ReturnType<typeof opendir>>;
 try{directory=await opendir(dirname(file));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fresh;throw e;}
 let best:{session:T;time:number;name:string}|undefined,count=0;const warnings:{file:string;error:string}[]=[],budget={bytes:0};
 for await(const entry of directory){
  if(entry.name===basename(file)||!/^[a-f0-9]{64}\.json$/.test(entry.name))continue;
  if(!entry.isFile()){warnings.push({file:entry.name,error:'not a regular file'});if(warnings.length>100)throw new Error('feedback history: more than 100 unreadable state files');continue;}
  let raw:unknown;
  try{raw=await readRecord(join(dirname(file),entry.name),budget);}catch(e){
   const error=e instanceof Error?e.message:String(e);if(error.includes('64 MiB'))throw e;
   warnings.push({file:entry.name,error});if(warnings.length>100)throw new Error('feedback history: more than 100 unreadable state files');continue;
  }
  if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
  // Matching records with corrupt provenance/timestamps fail by name. Unrelated
  // records never become a substitute for the current package's review.
  const session=candidate(raw as Record<string,unknown>,entry.name);if(!session)continue;
  const time=submittedAt(session.updatedAt);count++;
  if(!best||time>best.time||(time===best.time&&entry.name<best.name))best={session,time,name:entry.name};
 }
 return {...(best?{...best.session,retrieval:{kind:'prior-tools' as const,toolsChangedSince:true as const,matchingSubmissions:count,currentTools}}:fresh),...(warnings.length?{historyWarnings:warnings}:{})};
 });
}

export async function readFeedbackSession(p:ReviewPackage,stateDir?:string):Promise<FeedbackHistory<ReviewSession>>{
 const file=sessionFile(p,stateDir);
 return discover(file,()=>currentRecord(file,value=>({...parseSession(value,p,false),updatedAt:object(value,'session').updatedAt as string|null})),freshSession(p),(value,name)=>{
  if(value.schema!=='rig-review-session/1'||value.id!==p.manifest.id||value.revision!==p.manifest.revision||value.sourceHash!==p.sourceHash)return null;
  const reviewedSource=recordedSource(value.reviewedSource,p.reviewedSource);if(!reviewedSource)return null;
  const historical={...p,reviewedSource};if(basename(sessionFile(historical,stateDir))!==name)throw new Error('feedback history: session filename does not match recorded binding');
  if(isDeepStrictEqual(tools(reviewedSource),tools(p.reviewedSource)))throw new Error('feedback history: unexpected current-tools record');
  return {...parseSession(value,historical,false),updatedAt:value.updatedAt as string|null};
 },tools(p.reviewedSource));
}

export async function readFeedbackCompareSession(p:ComparePackage,stateDir?:string):Promise<FeedbackHistory<CompareSession>>{
 const file=compareSessionFile(p,stateDir);
 return discover(file,async()=>{await assertCompareUnchanged(p);return currentRecord(file,value=>({...parseCompareSession(value,p,false),updatedAt:object(value,'compare session').updatedAt as string|null}));},freshCompareSession(p),(value,name)=>{
  if(value.schema!=='rig-review-compare-session/1')return null;
  const binding=value.binding;if(!binding||typeof binding!=='object'||Array.isArray(binding))return null;
  const old=binding as Record<string,unknown>;if(!isDeepStrictEqual(old.reference,p.response.binding.reference)||old.animation!==p.response.animation)return null;
  const sides:ReviewPackage[]=[];
  for(const side of ['a','b'] as const){const raw=old[side];if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;const row=raw as Record<string,unknown>;if(row.sourceHash!==p[side].sourceHash)return null;const reviewedSource=recordedSource(row.reviewedSource,p[side].reviewedSource);if(!reviewedSource)return null;sides.push({...p[side],reviewedSource});}
  const a=sides[0]!,b=sides[1]!,historicalBinding:CompareBinding={a:{sourceHash:a.sourceHash,reviewedSource:a.reviewedSource},b:{sourceHash:b.sourceHash,reviewedSource:b.reviewedSource},reference:p.response.binding.reference,animation:p.response.animation};
  const sourceHash=createHash('sha256').update(JSON.stringify(historicalBinding)).digest('hex');
  const historical:ComparePackage={...p,a,b,response:{...p.response,id:'compare-'+sourceHash.slice(0,16),sourceHash,binding:historicalBinding}};
  if(basename(compareSessionFile(historical,stateDir))!==name)throw new Error('feedback history: comparison filename does not match recorded binding');
  if(isDeepStrictEqual(historicalBinding,p.response.binding))throw new Error('feedback history: unexpected current-tools comparison');
  return {...parseCompareSession(value,historical,false),updatedAt:value.updatedAt as string|null};
 },{a:tools(p.a.reviewedSource),b:tools(p.b.reviewedSource)});
}
