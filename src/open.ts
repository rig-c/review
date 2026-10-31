import {parseControlCommand,type ControlCommand,type ControlReceipt} from './control.ts';
/** One fixed-package worker per exact binding. There is no general daemon API. */
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {mkdir,readFile,readdir,writeFile,rename,unlink,rm,rmdir,realpath,lstat,stat,open as openFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadReferencedReview,selectedReference,assertReviewUnchanged} from './reference.ts';
import {loadReview,UnrecognizedOutputError,type ReviewPackage} from './manifest.ts';
import {loadCompare,assertCompareUnchanged,type ComparePackage} from './compare.ts';
import {startServer} from './server.ts';
import {startCompareServer} from './compare-server.ts';
import {selectAnimation,AnimationSelectionError,type AnimationSelection} from './animation-selection.ts';
import {capabilityHeader,capabilityPattern,type OpenIdentity} from './open-protocol.ts';
import {ensureFront,frontPort} from './front.ts';
import {playPackagePath} from './versions.ts';
import {HandoffError,HANDOFF_FLAGS,isBuildRoot,type HandoffFlags,type HandoffRecord} from './handoff.ts';
import {stateDirInside,stateRoots} from './state-dir.ts';
import {DEFAULT_UNOPENED_TIMEOUT_MS} from './live-lifecycle.ts';
/** #149: an opened rig-parts build check package — its canonical path and the handoff record (or the refusal line). */
export interface BuildOpen {package:string;handoff:HandoffRecord|null;reason:string|null}
/** The stderr diagnostic for {@link BuildOpen}: the package opened, then how the config was found, its package-relative path and full SHA-256. */
export function buildOpenDiagnostic(build:BuildOpen):string{
 const h=build.handoff,how=!h?'':h.how==='declared'?`declared (${h.via})`:h.outside?'discovered outside the opened folder':'discovered';
 return `Package: rig-parts build check package ${build.package}\n${h?`Handoff ${how}: ${h.config.path} sha256 ${h.config.sha256}${h.parts?` · parts ${h.parts}`:''}`:`Handoff: ${build.reason??'none'}`}`;
}
/** `direct` chooses how the page is reached (own port instead of the managed front); it is not part of the instance identity. */
export interface OpenInputs {input:string;compare?:string;reference?:string;animation?:string;control?:boolean;direct?:boolean;config?:string;parts?:string;source?:string;full?:string;head?:string;keypoints?:string}
/** The producer handoff flags (#101) among the inputs, or undefined when none was given. */
export function handoffFlags(inputs:OpenInputs):HandoffFlags|undefined{const present=HANDOFF_FLAGS.filter(f=>inputs[f]!==undefined);if(!present.length)return undefined;return Object.fromEntries(present.map(f=>[f,inputs[f]])) as unknown as HandoffFlags;}
export type OpenPackage=({mode:'single';p:ReviewPackage;inputs:OpenInputs;contentHash:string}|{mode:'compare';p:ComparePackage;inputs:OpenInputs;contentHash:string})&{selection:AnimationSelection|null};
/** Private 0600 record. `capability` is the 256-bit page write capability, handed out only in the printed `#cap=` fragment. */
export interface RecordFile extends OpenIdentity {schema:'rig-review-open-instance/1';pid:number;origin:string;mode:'single'|'compare';capability:string;controlToken?:string}
/** `cwd` is the launcher's working directory: the worker runs in the state directory, so Apply · Rebuild looks for the producer from here after the package's own directories. */
interface WorkerRequest {schema:'rig-review-open-request/1';inputs:OpenInputs;identity:OpenIdentity;stateDir:string;registry:string;request:string;idleMs:number;graceMs?:number;controlToken?:string;cwd?:string}
const appRoot=fileURLToPath(new URL('..',import.meta.url));
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep=(ms:number)=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
export const defaultStateDir=()=>process.env.RIG_REVIEW_STATE_DIR??join(homedir(),'.local','state','rig-c-review');
export async function loadOpenPackage(inputs:OpenInputs):Promise<OpenPackage>{
 // Handoff flags become canonical absolute paths here, so the worker and every reload read exactly these files.
 if(!inputs.compare){const p=await loadReferencedReview(inputs.input,inputs.reference,handoffFlags(inputs)),selection=selectAnimation([{label:'single',catalog:p.feedbackCatalog,report:p.report}],inputs.animation,true);return {mode:'single',p,selection,contentHash:p.sourceHash,inputs:{input:p.manifestPath,...(selectedReference(p)?{reference:selectedReference(p)!.path}:{}),...(selection?{animation:selection.name}:{}),...(inputs.control?{control:true}:{}),...(p.handoffInputs??{})}};}
 if(handoffFlags(inputs))throw new HandoffError('HANDOFF_FLAGS_INVALID','--config','compare takes no producer handoff; open one package with --config');
 if(!inputs.reference)throw new Error('open compare: explicit --reference required');
 const [a,b]=await Promise.all([loadReview(inputs.input),loadReview(inputs.compare)]),selection=selectAnimation([{label:'a',catalog:a.feedbackCatalog,report:a.report},{label:'b',catalog:b.feedbackCatalog,report:b.report}],inputs.animation)!;
 const p=await loadCompare({a:inputs.input,b:inputs.compare,reference:inputs.reference,animation:selection.name});
 if(p.a.sourceHash!==a.sourceHash||p.b.sourceHash!==b.sourceHash)throw new Error('open inputs changed while selecting animation');
 return {mode:'compare',p,selection,contentHash:p.response.sourceHash,inputs:{input:p.inputs.a,compare:p.inputs.b,reference:p.inputs.reference,animation:selection.name,...(inputs.control?{control:true}:{})}};
}
/** Flat tool source/static files are small; no package or producer recursive scan. */
export async function openFingerprint():Promise<string>{
 const hash=createHash('sha256');for(const directory of ['src','web'])for(const entry of (await readdir(join(appRoot,directory),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1))if(entry.isFile()&&/\.(ts|css|html)$/.test(entry.name)){hash.update(directory+'/'+entry.name+'\0');hash.update(await readFile(join(appRoot,directory,entry.name)));}
 // An installed copy ships no lockfile; the resolved runtime manifest still binds its dependency.
 hash.update('package.json\0');hash.update(await readFile(join(appRoot,'package.json')));
 hash.update('bun.lock\0');try{hash.update(await readFile(join(appRoot,'bun.lock')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;hash.update('(absent)');}
 hash.update('@rig-c/play/package.json\0');hash.update(await readFile(playPackagePath()));return hash.digest('hex');
}
export function openKey(p:OpenPackage,fingerprint:string):string {return digest({fingerprint,installation:appRoot,mode:p.mode,inputs:p.inputs,content:p.contentHash,identity:p.mode==='single'?p.p.reviewedSource:p.p.response.binding});}
/** Handoff URL: the managed front's `/instances/<key>/` path (or the worker's own origin when direct). The
 * capability rides in the fragment, which browsers never send to a server; the page stores and strips it. */
export function openUrl(record:Pick<RecordFile,'origin'|'key'|'contentHash'|'capability'>,front?:string):string {const url=new URL(front?`${front}/instances/${record.key}/`:record.origin);url.searchParams.set('input',record.contentHash);url.searchParams.set('handoff',record.key);url.hash='cap='+record.capability;return url.href;}
export async function smallJson(file:string):Promise<unknown>{const handle=await openFile(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=await handle.stat();if(!before.isFile()||before.size>65536)throw new Error('open state: bounded regular file required');const buffer=Buffer.alloc(before.size+1);let size=0;while(size<buffer.length){const next=await handle.read(buffer,size,buffer.length-size,size);if(!next.bytesRead)break;size+=next.bytesRead;}const after=await handle.stat();if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('open state: changed while reading');return JSON.parse(buffer.subarray(0,size).toString('utf8'));}finally{await handle.close();}}
function recordValue(value:unknown,key:string):RecordFile|null {if(!value||typeof value!=='object')return null;const v=value as Partial<RecordFile>;return v.schema==='rig-review-open-instance/1'&&v.key===key&&/^[a-f0-9]{64}$/.test(v.contentHash??'')&&/^[a-f0-9]{64}$/.test(v.fingerprint??'')&&typeof v.nonce==='string'&&/^[a-f0-9-]{36}$/.test(v.nonce)&&typeof v.origin==='string'&&/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(v.origin)&&Number(v.origin.slice(v.origin.lastIndexOf(':')+1))<=65535&&Number.isSafeInteger(v.pid)&&v.pid!>0&&(v.mode==='single'||v.mode==='compare')&&capabilityPattern.test(v.capability??'')?v as RecordFile:null;}
export async function readRecord(file:string,key:string):Promise<RecordFile|null>{try{return recordValue(await smallJson(file),key);}catch(e){if(['ENOENT','ELOOP'].includes((e as NodeJS.ErrnoException).code??'')||e instanceof SyntaxError)return null;throw e;}}
/** Hard byte ceiling and body deadline, including stalled or chunked responses. */
export async function readOpenStatus(response:Response,timeoutMs=1500):Promise<unknown>{
 if(!response.body)throw new Error('open status: body required');const reader=response.body.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{const chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw new Error('open status: exceeds 64 KiB');chunks.push(next.value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('open status: body timeout')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export async function alive(record:RecordFile):Promise<boolean>{try{const response=await fetch(record.origin+'/api/open-status',{headers:{authorization:`Bearer ${record.nonce}`},redirect:'error',signal:AbortSignal.timeout(1500)});if(!response.ok){void response.body?.cancel();return false;}const v=await readOpenStatus(response) as OpenIdentity&{schema:string};return v.schema==='rig-review-open-status/1'&&v.key===record.key&&v.contentHash===record.contentHash&&v.nonce===record.nonce&&v.fingerprint===record.fingerprint;}catch{return false;}}

export function running(pid:number):boolean{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}}
async function claimOwner(claim:string):Promise<{file:string;pid:number;nonce:string}|null>{
 const info=await lstat(claim);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('open.state: claim must be an owned directory');const names=await readdir(claim);if(!names.length)return null;if(names.length!==1||!/^owner(?:\.[a-f0-9-]{36})?\.json$/.test(names[0]!))throw new Error('open.state: invalid startup claim');const file=join(claim,names[0]!),owner=await smallJson(file) as {pid?:number;nonce?:string};if(!Number.isSafeInteger(owner.pid)||owner.pid!<=0||typeof owner.nonce!=='string'||!/^([a-f0-9-]{36})$/.test(owner.nonce)||names[0]!=='owner.json'&&names[0]!==`owner.${owner.nonce}.json`)throw new Error('open.state: invalid startup claimant');return {file,pid:owner.pid!,nonce:owner.nonce};
}
async function removeClaimFile(claim:string,owner:{file:string;nonce:string}){try{const current=await smallJson(owner.file) as {nonce?:string};if(current.nonce!==owner.nonce)return;await unlink(owner.file);await rmdir(claim);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}
export async function releaseClaim(claim:string,nonce:string){await removeClaimFile(claim,{file:join(claim,`owner.${nonce}.json`),nonce});}
async function canonicalDestination(path:string):Promise<string>{try{return await realpath(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=dirname(path);if(parent===path)throw e;return join(await canonicalDestination(parent),basename(path));}}
/** Single-owner startup: publish a populated claim directory atomically (no live owner ever exposes an empty
 * claim; unique owner filenames make stale cleanup safe after replacement). A ready reuse wins while waiting. */
export async function acquireClaim<T>(control:string,name:string,nonce:string,reuse:()=>Promise<T|null>,deadline:number,busy:string):Promise<{row:T}|{claim:string}>{
 const claim=join(control,name+'.claim'),candidate=join(control,`${name}.${nonce}.claiming`);await mkdir(candidate,{mode:0o700});await writeFile(join(candidate,`owner.${nonce}.json`),JSON.stringify({pid:process.pid,nonce}),{mode:0o600,flag:'wx'});
 try{while(true){try{try{await lstat(claim);const occupied=new Error('claim exists') as NodeJS.ErrnoException;occupied.code='EEXIST';throw occupied;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await rename(candidate,claim);return {claim};}
 catch(e){if(!['EEXIST','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code??''))throw e;const row=await reuse();if(row){await rm(candidate,{recursive:true});return {row};}
 try{const before=await lstat(claim),owner=await claimOwner(claim);if(owner&&!running(owner.pid)){const again=await claimOwner(claim);if(again?.nonce===owner.nonce&&(await lstat(claim)).ino===before.ino)await removeClaimFile(claim,owner);}else if(!owner&&Date.now()-before.mtimeMs>=250&&(await lstat(claim)).ino===before.ino){try{await rmdir(claim);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(performance.now()>deadline)throw new Error(busy);await sleep(30);}}}
 catch(error){await rm(candidate,{recursive:true,force:true});throw error;}
}
/** Launcher contract (README "Launcher contract"): an `open` refusal's first line starts with a stable OPEN_* name.
 * The shared loaders keep their check/feedback text; only this path renames them. */
async function assertOpenInput(path:string):Promise<void>{
 let info;try{info=await stat(path);}catch(e){if(['ENOENT','ENOTDIR','ELOOP','ENAMETOOLONG'].includes((e as NodeJS.ErrnoException).code??''))throw new Error(`OPEN_INPUT_MISSING ${path}: no such path; expected an existing output directory or review.json`);throw e;}
 if(!info.isDirectory()&&!info.isFile())throw new Error(`OPEN_INPUT_MISSING ${path}: found a non-regular file; expected an output directory or a review.json manifest`);
 if(info.isFile()){try{JSON.parse(await readFile(path,'utf8'));}catch(e){throw new Error(`OPEN_INPUT_UNRECOGNIZED ${path}: not a JSON manifest; expected an output directory or a review.json manifest`,{cause:e});}}
}
async function openRefusal(error:unknown,inputs:OpenInputs):Promise<unknown>{
 if(error instanceof UnrecognizedOutputError){const first=await realpath(resolve(inputs.input)).catch(()=>null),path=inputs.compare!==undefined&&error.root!==first?inputs.compare:inputs.input;return new Error(`OPEN_INPUT_UNRECOGNIZED ${path}: ${error.message}`,{cause:error});}
 if(error instanceof HandoffError)return new Error(`OPEN_HANDOFF_INVALID ${error.field}: ${error.code}: ${error.detail}`,{cause:error});
 if(!(error instanceof AnimationSelectionError))return error;
 const detail=(error.label==='a'||error.label==='b'?`side ${error.label}: `:'')+error.message.replace(/^open\.(?:[a-z]+\.)?animation: /,'');
 const name=error.kind==='empty'?'OPEN_OPTION_INVALID --animation':error.kind==='unknown'?`OPEN_ANIMATION_UNKNOWN ${JSON.stringify(error.animation)}`:error.kind==='ambiguous'?'OPEN_ANIMATION_AMBIGUOUS':'OPEN_ANIMATION_UNVALIDATABLE';
 return new Error(`${name}: ${detail}`,{cause:error});
}
/** Managed is the default: the printed URL goes through the one loopback front (127.0.0.1:4318, or
 * RIG_REVIEW_FRONT_PORT) so browser storage keeps one origin across reopens. `direct` keeps the worker's own port. */
export async function openReview(inputs:OpenInputs,options:{stateDir?:string;idleMs?:number;graceMs?:number;direct?:boolean;frontPort?:number;frontIdleMs?:number}={}):Promise<{url:string;reused:boolean;nonce:string;inputs:OpenInputs;selection:AnimationSelection|null;direct:boolean;build:BuildOpen|null}>{
 const direct=options.direct??inputs.direct??false,port=direct?0:frontPort(options.frontPort);
 for(const path of [inputs.input,...(inputs.compare!==undefined?[inputs.compare]:[])])await assertOpenInput(path);
 if(inputs.compare!==undefined&&!inputs.reference)throw new Error('OPEN_REFERENCE_REQUIRED: compare: explicit --reference required');
 let p:OpenPackage;try{p=await loadOpenPackage(inputs);}catch(error){throw await openRefusal(error,inputs);}
 const fingerprint=await openFingerprint(),key=openKey(p,fingerprint);
 // #187: canonical (symlinks and ancestors resolved) and outside every supplied folder: the package, the build root a check package belongs to, the handoff root.
 const stateDir=await canonicalDestination(resolve(options.stateDir??defaultStateDir())),roots=p.mode==='single'?stateRoots(p.p):[...stateRoots(p.p.a),...stateRoots(p.p.b)];
 const inside=stateDirInside(stateDir,roots);if(inside)throw new Error(`OPEN_STATE_INSIDE_PACKAGE ${inside.kind}: the review state directory must be outside input packages; it is inside the ${inside.kind}; set RIG_REVIEW_STATE_DIR outside it`);
 const control=join(stateDir,'open');await mkdir(control,{recursive:true,mode:0o700});const canonicalControl=await realpath(control);if((await lstat(control)).isSymbolicLink())throw new Error('open.state: control directory cannot be a symlink');
 const worker=await ensureWorker(p,key,fingerprint,stateDir,canonicalControl,options.idleMs??DEFAULT_UNOPENED_TIMEOUT_MS,options.graceMs);
 const url=direct?openUrl(worker.row):openUrl(worker.row,await ensureFront({control:canonicalControl,port,fingerprint,idleMs:options.frontIdleMs}));
 // #149: the check package of a rig-parts build root says which package it opened and which config the handoff took.
 const build=p.mode==='single'&&basename(p.p.root)==='check'&&await isBuildRoot(dirname(p.p.root))?{package:p.p.root,handoff:p.p.reviewedSource.handoff??null,reason:p.p.handoffReason}:null;
 return {url,reused:worker.reused,nonce:worker.row.nonce,inputs:p.inputs,selection:p.selection,direct,build};
}
async function ensureWorker(p:OpenPackage,key:string,fingerprint:string,stateDir:string,canonicalControl:string,idleMs:number,graceMs?:number):Promise<{row:RecordFile;reused:boolean}>{
 const registry=join(canonicalControl,key+'.json'),claim=join(canonicalControl,key+'.claim'),nonce=randomUUID(),deadline=performance.now()+20000;
 const reuse=async()=>{const row=await readRecord(registry,key);return row&&row.fingerprint===fingerprint&&row.contentHash===p.contentHash&&row.mode===p.mode&&await alive(row)?row:null;};
 const ready=await reuse();if(ready)return {row:ready,reused:true};
 const claimed=await acquireClaim(canonicalControl,key,nonce,reuse,deadline,'OPEN_BUSY: instance startup claim did not become ready');if('row' in claimed)return {row:claimed.row,reused:true};
 let request:string|undefined,spawned:ReturnType<typeof spawn>|undefined,handedOff=false;
 try{
  const row=await reuse();if(row)return {row,reused:true};
  const identity:OpenIdentity={key,contentHash:p.contentHash,nonce,fingerprint};request=join(canonicalControl,`${key}.${nonce}.request.json`);const log=join(canonicalControl,`${key}.${nonce}.log`);
  const spec:WorkerRequest={schema:'rig-review-open-request/1',inputs:p.inputs,identity,stateDir,registry,request,idleMs,...(graceMs!==undefined?{graceMs}:{}),cwd:process.cwd(),...(p.inputs.control?{controlToken:randomUUID()}:{} )};await writeFile(request,JSON.stringify(spec),{mode:0o600,flag:'wx'});
  const logHandle=await openFile(log,'a',0o600);let child;try{child=spawn(process.execPath,[join(appRoot,'src/open-worker.ts'),request],{cwd:canonicalControl,detached:true,stdio:['ignore',logHandle.fd,logHandle.fd],env:process.env});spawned=child;child.unref();}finally{await logHandle.close();}
  let exited:string|undefined;child.on('error',error=>{exited=error.message;});child.on('exit',(code,signal)=>{exited=`exit ${code} ${signal??''}`;});
  while(performance.now()<deadline){const record=await reuse();if(record){handedOff=true;return {row:record,reused:false};}if(exited)throw new Error(`OPEN_START: ${exited}; worker log ${log}`);await sleep(30);}throw new Error(`OPEN_TIMEOUT: worker did not become ready; log ${log}`);
 }finally{if(spawned&&!handedOff&&spawned.exitCode===null&&spawned.signalCode===null)spawned.kill('SIGTERM');await releaseClaim(claim,nonce);if(request)await unlink(request).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function runOpenWorker(requestPath:string):Promise<void>{
 const raw=await smallJson(requestPath) as WorkerRequest;if(raw.schema!=='rig-review-open-request/1'||!raw.identity||!recordValue({schema:'rig-review-open-instance/1',...raw.identity,pid:process.pid,origin:'http://127.0.0.1:1',mode:'single',capability:'0'.repeat(64)},raw.identity.key))throw new Error('open worker: invalid request');
 const spec=raw,control=await realpath(join(spec.stateDir,'open'));if(dirname(await realpath(requestPath))!==control||spec.request!==requestPath||spec.registry!==join(control,spec.identity.key+'.json')||!Number.isSafeInteger(spec.idleMs)||spec.idleMs<100)throw new Error('open worker: invalid state locations or idle limit');
 const p=await loadOpenPackage(spec.inputs),fingerprint=await openFingerprint();if(fingerprint!==spec.identity.fingerprint||openKey(p,fingerprint)!==spec.identity.key||p.contentHash!==spec.identity.contentHash)throw new Error('open worker: inputs changed before startup');
 if(spec.inputs.control&&(!spec.controlToken||!/^[a-f0-9-]{36}$/.test(spec.controlToken)))throw new Error('open control: invalid private capability');
 // The worker mints its own page capability; it lives only in this process and the private record.
 const removeRecord=async()=>{const current=await readRecord(spec.registry,spec.identity.key);if(current?.nonce===spec.identity.nonce)await unlink(spec.registry).catch(()=>{});};
 const capability=randomBytes(32).toString('hex');const options={port:0,stateDir:spec.stateDir,open:spec.identity,capability,unopenedTimeoutMs:spec.idleMs,...(spec.graceMs!==undefined?{graceMs:spec.graceMs}:{}),exitOnClose:true,onClose:removeRecord,...(spec.inputs.control?{control:{token:spec.controlToken!,instanceKey:spec.identity.key}}:{})};
 const server=p.mode==='single'?await startServer(p.p,{...options,initialAnimation:p.selection?.name,...(typeof spec.cwd==='string'&&isAbsolute(spec.cwd)?{cwd:spec.cwd}:{})}):await startCompareServer(p.p,options);
 const check=()=>p.mode==='single'?assertReviewUnchanged(p.p):assertCompareUnchanged(p.p);
 await check();const record:RecordFile={schema:'rig-review-open-instance/1',...spec.identity,pid:process.pid,origin:`http://127.0.0.1:${server.port}`,mode:p.mode,capability,...(spec.inputs.control?{controlToken:spec.controlToken}:{})};const tmp=spec.registry+'.'+spec.identity.nonce+'.tmp';await writeFile(tmp,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(tmp,spec.registry);
 await unlink(requestPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
 let stopped=false;const stop=async(signal:string)=>{if(stopped)return;stopped=true;await removeRecord();server.stop(true);console.log(`review: exiting — received ${signal}.`);process.exit(0);};
 process.on('SIGTERM',()=>{void stop('SIGTERM');});process.on('SIGINT',()=>{void stop('SIGINT');});
}

/** Read/control an already running, explicitly opted-in exact binding. Never starts a worker. */
export async function controlReview(inputs:OpenInputs,commandOptions:{pageId?:string;expectedRevision?:number;requestId?:string;command?:ControlCommand;waitMs?:number;stateDir?:string}={}):Promise<unknown>{
 const wait=commandOptions.waitMs??10000;if(!Number.isSafeInteger(wait)||wait<0||wait>30000)throw new Error('CONTROL_WAIT: expected integer 0..30000');
 const p=await loadOpenPackage({...inputs,control:true}),fingerprint=await openFingerprint(),key=openKey(p,fingerprint),stateDir=await canonicalDestination(resolve(commandOptions.stateDir??defaultStateDir()));
 const controlDir=join(stateDir,'open');
 try{if((await lstat(controlDir)).isSymbolicLink())throw new Error('CONTROL_STATE: control directory cannot be a symlink');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('CONTROL_INSTANCE_UNAVAILABLE: open the exact inputs once with --control');throw error;}
 const file=join(controlDir,key+'.json');try{const info=await lstat(file);if(!info.isFile()||(info.mode&0o077)!==0)throw new Error('CONTROL_STATE: owner-only regular capability record required');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('CONTROL_INSTANCE_UNAVAILABLE: open the exact inputs once with --control');throw error;}
 const record=await readRecord(file,key);
 if(!record||!record.controlToken||!await alive(record))throw new Error('CONTROL_INSTANCE_UNAVAILABLE: open the exact inputs once with --control');
 const headers={Authorization:'Bearer '+record.controlToken,Origin:record.origin,'Content-Type':'application/json',[capabilityHeader]:record.capability};
 const get=async(path:string,body?:unknown)=>{const response=await fetch(record.origin+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});const value=await readOpenStatus(response,5000);if(!response.ok)throw new Error((value as {error?:string}).error??'CONTROL_REQUEST_FAILED');return value;};
 const state=await get('/api/control') as {sourceHash:string;instanceKey:string;pages:{pageId:string;revision:number}[]};
 if(state.sourceHash!==p.contentHash||state.instanceKey!==key)throw new Error('CONTROL_STALE_BINDING');
 if(!commandOptions.command)return state;
 const page=commandOptions.pageId?state.pages.find(row=>row.pageId===commandOptions.pageId):state.pages.length===1?state.pages[0]:undefined;
 if(!page)throw new Error(state.pages.length>1?'CONTROL_PAGE_REQUIRED: select exact --page from current state':'CONTROL_NO_PAGE');
 if(!Number.isSafeInteger(commandOptions.expectedRevision)||commandOptions.expectedRevision!<0)throw new Error('CONTROL_REVISION_REQUIRED: use the observed --expected-revision');
 const command=parseControlCommand(commandOptions.command),request={schema:'rig-review-control-command/1',requestId:commandOptions.requestId??randomUUID(),pageId:page.pageId,instanceKey:key,sourceHash:p.contentHash,expectedRevision:commandOptions.expectedRevision,command};
 const receipt=await get('/api/control/commands',request) as ControlReceipt;
 if(wait===0)return receipt;
 const deadline=performance.now()+wait;let current=receipt;
 while(['queued','dispatched'].includes(current.status)&&performance.now()<deadline){await sleep(Math.min(100,Math.max(1,deadline-performance.now())));current=await get('/api/control/receipts/'+encodeURIComponent(current.commandId)) as ControlReceipt;}
 return {...current,...(['queued','dispatched'].includes(current.status)?{timedOut:true}:{} )};
}
