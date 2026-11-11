import { interviewRefusals, interviewRequest } from './interview-routes.ts';
import { directionStale, interviewStale } from './joined-project.ts';
import { picksLimit } from './interview-picks.ts';
import {stageDraftRefusals,stageVerdictLimit,stageVerdictRefusals} from './stage-parts.ts';
/** Managed loopback front: one stable origin (127.0.0.1:4318 by default) routing `/instances/<key>/…` to the
 * worker named by that key's private open record. It is a router, not an authority: it never reads packages,
 * never serves or logs a capability, and forwards a mutation (rewriting Origin) only with the page capability. */
import type {ServerWebSocket} from 'bun';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lstat,readFile,readdir,realpath,rename,unlink,writeFile,open as openFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireClaim,alive,openFingerprint,readRecord,releaseClaim,running,smallJson,type RecordFile} from './open.ts';
import {playBuildConditions} from './build.ts';
import {capabilityHeader,openKeyHeader,openNonceHeader,sameSecret} from './open-protocol.ts';
import {DEFAULT_CLOSE_GRACE_MS,LIVE_PATH} from './live-lifecycle.ts';
export const defaultFrontPort=4318; // Foreground `review <dir>` keeps 4317.
interface FrontRecord {schema:'rig-review-front/1';origin:string;port:number;nonce:string;fingerprint:string;pid:number}
interface FrontRequest {schema:'rig-review-front-request/1';control:string;request:string;record:string;port:number;nonce:string;fingerprint:string;idleMs:number}
const appRoot=fileURLToPath(new URL('..',import.meta.url));
const sleep=(ms:number)=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,hex64=/^[a-f0-9]{64}$/;
const frontName=(port:number)=>`front-${port}`;
const noStore={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const refuse=(error:string,status:number)=>Response.json({error},{status,headers:noStore});
export function frontPort(value?:number):number{const raw=value??(process.env.RIG_REVIEW_FRONT_PORT===undefined?defaultFrontPort:Number(process.env.RIG_REVIEW_FRONT_PORT));if(!Number.isSafeInteger(raw)||raw<1||raw>65535)throw new Error('FRONT_PORT: RIG_REVIEW_FRONT_PORT expects an integer 1..65535');return raw;}
function frontValue(value:unknown,port:number):FrontRecord|null{if(!value||typeof value!=='object'||Array.isArray(value))return null;const v=value as Partial<FrontRecord>;return v.schema==='rig-review-front/1'&&v.port===port&&v.origin===`http://127.0.0.1:${port}`&&uuid.test(v.nonce??'')&&hex64.test(v.fingerprint??'')&&Number.isSafeInteger(v.pid)&&v.pid!>0?v as FrontRecord:null;}
async function readFront(file:string,port:number):Promise<FrontRecord|null>{try{return frontValue(await smallJson(file),port);}catch(e){if(['ENOENT','ELOOP'].includes((e as NodeJS.ErrnoException).code??'')||e instanceof SyntaxError)return null;throw e;}}
async function frontAlive(row:FrontRecord):Promise<boolean>{try{const response=await fetch(row.origin+'/api/front-status',{headers:{authorization:'Bearer '+row.nonce},redirect:'error',signal:AbortSignal.timeout(1500)});if(!response.ok){void response.body?.cancel();return false;}const v=await response.json() as {schema?:string;nonce?:string;fingerprint?:string};return v.schema==='rig-review-front-status/1'&&v.nonce===row.nonce&&v.fingerprint===row.fingerprint;}catch{return false;}}
/** Ensure this state directory's front on `port`; reuse a verified live one. A front from another tool
 * build is ours (verified nonce) and is replaced. Any other listener is FRONT_PORT_BUSY, never a fallback. */
export async function ensureFront(options:{control:string;port:number;fingerprint:string;idleMs?:number}):Promise<string>{
 const {control,port,fingerprint}=options,name=frontName(port),recordPath=join(control,name+'.json'),nonce=randomUUID(),deadline=performance.now()+20000,idleMs=options.idleMs??DEFAULT_CLOSE_GRACE_MS;
 const reuse=async()=>{const row=await readFront(recordPath,port);if(!row||!await frontAlive(row))return null;if(row.fingerprint===fingerprint)return row;
  try{process.kill(row.pid,'SIGTERM');}catch{}for(let n=0;n<100&&await frontAlive(row);n++)await sleep(30);return null;};
 const ready=await reuse();if(ready)return ready.origin;
 const claimed=await acquireClaim(control,name,nonce,reuse,deadline,'FRONT_BUSY: front startup claim did not become ready');if('row' in claimed)return claimed.row.origin;
 let request:string|undefined,child:ReturnType<typeof spawn>|undefined,handedOff=false;
 try{
  const row=await reuse();if(row)return row.origin;
  request=join(control,`${name}.${nonce}.request.json`);const log=join(control,`${name}.${nonce}.log`);
  const spec:FrontRequest={schema:'rig-review-front-request/1',control,request,record:recordPath,port,nonce,fingerprint,idleMs};await writeFile(request,JSON.stringify(spec),{mode:0o600,flag:'wx'});
  const logHandle=await openFile(log,'a',0o600);try{child=spawn(process.execPath,[...playBuildConditions().map(c=>`--conditions=${c}`),join(appRoot,'src/front-worker.ts'),request],{cwd:control,detached:true,stdio:['ignore',logHandle.fd,logHandle.fd],env:process.env});child.unref();}finally{await logHandle.close();}
  let exited:string|undefined;child.on('error',error=>{exited=error.message;});child.on('exit',(code,signal)=>{exited=`exit ${code} ${signal??''}`;});
  while(performance.now()<deadline){const live=await reuse();if(live){handedOff=true;return live.origin;}
   if(exited){if(/FRONT_PORT_BUSY/.test(await readFile(log,'utf8').catch(()=>'')))throw new Error(`FRONT_PORT_BUSY: 127.0.0.1:${port} is held by another listener; use --direct (or set RIG_REVIEW_FRONT_PORT)`);throw new Error(`FRONT_START: ${exited}; front log ${log}`);}
   await sleep(30);}
  throw new Error(`FRONT_TIMEOUT: front did not become ready; log ${log}`);
 }finally{if(child&&!handedOff&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await releaseClaim(join(control,name+'.claim'),nonce);if(request)await unlink(request).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
interface Route {mutation:boolean;limit:number;timeoutMs:number;control:boolean;live?:boolean}
/** Closed allowlist per method. Agent control endpoints, open-status and anything unlisted are refused. */
export function frontRoute(mode:'single'|'compare',method:string,path:string):Route|null{
 const read=method==='GET'||method==='HEAD',get:Route={mutation:false,limit:0,timeoutMs:30000,control:false};
 if(path===LIVE_PATH)return method==='GET'?{...get,live:true}:null;
 if(['/','/index.html','/main.js','/styles.css','/api/access'].includes(path))return read?get:null;
 if(['/stage-parts.html','/parts.js','/parts.css'].includes(path))return read?get:null;
 if((mode==='single'?/^\/api\/stage-parts(?:\/(?:image|page)\/\d+)?$/:/^\/api\/compare\/(?:a|b)\/stage-parts(?:\/(?:image|page)\/\d+)?$/).test(path))return read?get:null;
 if(mode==='single'){
  if(path==='/api/stage-parts/verdict')return method==='POST'?{...get,mutation:true,limit:stageVerdictLimit}:null;
  if(path==='/api/stage-parts/export/json'||path==='/api/stage-parts/export/issue')return read?get:null;
  if(path==='/stage-interview.html')return method==='GET'?get:null;
  if(interviewRequest(path))return path==='/api/interview/picks'?
   method==='POST'?{...get,mutation:true,limit:picksLimit}:null:method==='GET'?get:null;
 }
 if(path==='/api/control/config')return method==='GET'?{...get,control:true}:null;
 if(['/api/control/register','/api/control/poll','/api/control/ack','/api/control/close'].includes(path))return method==='POST'?{mutation:true,limit:16384,timeoutMs:10000,control:true}:null;
 const session=mode==='single'?'/api/session':'/api/compare/session',strip=mode==='single'?'/api/strip':'/api/compare/strip';
 if(path===session)return read?get:method==='PUT'?{mutation:true,limit:1024*1024,timeoutMs:30000,control:false}:null;
 if(path===strip)return method==='POST'?{mutation:true,limit:1024*1024,timeoutMs:120000,control:false}:null;
 const reads=mode==='single'?['/api/review','/review-reference','/review-painting']:['/api/compare','/api/compare/reference-frames','/compare-reference'];
 if(reads.includes(path))return read?get:null;
 if((mode==='single'?/^\/assets\/[^/]/:/^\/compare-assets\/(a|b)\/[^/]/).test(path))return read?get:null;
 // Apply · Rebuild and producer checks: un-prefixed in single mode, side-scoped (/api/compare/(a|b)/*, /compare-rebuild/(a|b)/*) in compare mode (#234).
 const toolPath=mode==='compare'?path.replace(/^\/api\/compare\/(?:a|b)(?=\/)/,'/api').replace(/^\/compare-rebuild\/(?:a|b)\//,'/rebuild/').replace(/^\/compare-density-strip\/(?:a|b)\//,'/density-strip/'):path;
 if(mode==='compare'&&toolPath===path)return null;
 if(toolPath==='/api/rebuild')return read?get:method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(toolPath==='/api/rebuild/history')return read?get:null;
 if(toolPath==='/api/rebuild/undo')return method==='POST'?{mutation:true,limit:1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/rebuild\/[a-f0-9]{64}$/.test(toolPath)||/^\/rebuild\/[a-f0-9]{64}\/[^/]/.test(toolPath))return read?get:null;
 if(toolPath==='/api/density-strip')return read?get:method==='POST'?{mutation:true,limit:320*1024,timeoutMs:30000,control:false}:null;
 if(toolPath==='/api/density-strip/close')return method==='POST'?{mutation:true,limit:1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/density-strip\/[a-f0-9]{64}(?:\/[a-f0-9]{64})?$/.test(toolPath)||/^\/density-strip\/[a-f0-9]{64}\/[a-f0-9]{64}\/[^/]/.test(toolPath))return read?get:null;
 if(toolPath==='/api/bones-check')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:60000,control:false}:null;
 if(toolPath==='/api/readings')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/readings\/[a-f0-9]{64}$/.test(toolPath))return read?get:null;
 if(toolPath==='/api/requirements')return read?get:method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/requirements\/[a-f0-9]{64}$/.test(toolPath))return read?get:null;
 if(toolPath==='/api/environment-check')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/environment-check\/[a-f0-9]{64}$/.test(toolPath))return read?get:null;
 return null;
}
export async function boundedBody(req:Request,limit:number,timeoutMs=10000):Promise<ArrayBuffer>{
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('FRONT_JSON_REQUIRED');
 const declared=req.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('FRONT_BODY_LIMIT');
 if(!req.body)throw new Error('FRONT_JSON_REQUIRED');const reader=req.body.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{const chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new Error('FRONT_BODY_LIMIT');chunks.push(next.value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes.buffer;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('FRONT_BODY_TIMEOUT')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
/** Owner-only regular record for this key, or null. */
async function instanceRecord(control:string,key:string):Promise<RecordFile|null>{const file=join(control,key+'.json');try{const info=await lstat(file);if(!info.isFile()||(info.mode&0o077)!==0)return null;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}return readRecord(file,key);}
/** Worker errors default to front codes unless an inspection refusal is allowlisted. */
const upstreamFailure:Record<number,string>={400:'FRONT_UPSTREAM_REJECTED',403:'FRONT_UPSTREAM_FORBIDDEN',404:'FRONT_UPSTREAM_NOT_FOUND',405:'FRONT_UPSTREAM_METHOD',409:'FRONT_UPSTREAM_CONFLICT'};
const responseHeaders=['content-type','content-length','content-range','accept-ranges','content-disposition','cache-control','content-security-policy','x-content-type-options','referrer-policy'];
/** The trusted atlas frame alone may carry this closed navigation query. */
export function stageFrameQuery(mode:'single'|'compare',search:string):boolean {
 const params=new URLSearchParams(search),keys=[...params.keys()];
 const allowed=mode==='single'?['stageEmbed','lang']:['stageEmbed','lang','side'];
 return keys.length===allowed.length&&new Set(keys).size===keys.length&&keys.every(k=>allowed.includes(k))&&params.get('stageEmbed')==='1'&&['en','ko'].includes(params.get('lang')??'')&&(mode==='single'||['a','b'].includes(params.get('side')??''));
}
// The submitted Apply can supply the check line. Accept the producer's structured
// summary fields, never an arbitrary suffix after the failed-check code.
const submitCheckPrefix = 'EDIT_SUBMIT_UNCHECKED: applied build failed check — ';
const checkBarName = '(?:[A-Z][A-Z0-9_]*|gate|loop|seam)';
const submitCheckSummary = new RegExp(
 String.raw`^check: FAIL — \d+ bar\(s\) not met(?:, \d+ declared requirement\(s\) not PASS)?; ` +
 String.raw`\d+ of \d+ bar\(s\) measured, \d+ skipped(?: \(${checkBarName}(?:, ${checkBarName})*\))?` +
 String.raw`(?:; \d+ warning\(s\) \((?:SEAM_OVER_MOTION(?:, CLOTH_SETTLES)?|CLOTH_SETTLES), not a bar\))?$`
);
const submitCheckFallback = new RegExp(String.raw`^(?:${checkBarName}: FAIL|check exited -?\d+)$`);
const fixedSubmitRefusals = new Set([
 'EDIT_SUBMIT_UNCHECKED: applied mesh has no successful producer check',
 'CORRECTION_CHECK_FAILED: the settled Apply requires a passing producer check',
]);
function isSubmitCheckRefusal(error: string): boolean {
 if(fixedSubmitRefusals.has(error))return true;
 if(!error.startsWith(submitCheckPrefix))return false;
 const detail=error.slice(submitCheckPrefix.length);
 return submitCheckSummary.test(detail)||submitCheckFallback.test(detail);
}
/** Preserve only closed, bounded inspection refusals. */
async function inspectionRefusal(mode:'single'|'compare',method:string,path:string,response:Response,sameFingerprint:boolean):Promise<string|null>{
 const stageData=mode==='single'?path==='/api/stage-parts':/^\/api\/compare\/(?:a|b)\/stage-parts$/.test(path);
 const interview=mode==='single'&&interviewRequest(path)&&[400,404,409].includes(response.status);
 // Both reads race during the single-package page bootstrap.
 const direction=sameFingerprint&&mode==='single'&&method==='GET'&&response.status===409&&
  (path==='/api/review'||path==='/api/session');
 const submit=sameFingerprint&&mode==='single'&&method==='PUT'&&path==='/api/session'&&response.status===400;
 const verdict=mode==='single'&&['/api/stage-parts/verdict','/api/stage-parts/export/json','/api/stage-parts/export/issue'].includes(path)&&[400,409].includes(response.status);
 if(!(submit||direction||interview||verdict||stageData&&method==='GET'&&response.status===409)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))return null;
 const limit=512,declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))return null;
 const reader=response.body?.getReader();if(!reader)return null;
 try{
  const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){void reader.cancel().catch(()=>{});return null;}chunks.push(value);}
  const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  const data:unknown=JSON.parse(new TextDecoder().decode(body)),named='PARTS_ATLAS_UNAVAILABLE: the inspected package has no usable atlas or its source changed.';
  if(data===null||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1)return null;
  const error=(data as {error?:unknown}).error;
  if(submit)return typeof error==='string'&&isSubmitCheckRefusal(error)?error:null;
  if(direction)return error===directionStale?directionStale:null;
  return typeof error==='string'&&(interview?[...interviewRefusals]:[...(stageData&&response.status===409?[named,...Object.values(stageDraftRefusals),...stageVerdictRefusals]:[]),interviewStale,...(verdict?stageVerdictRefusals:[])] as readonly string[]).some(code=>code===error)?error:null;
 }catch{return null;}finally{reader.releaseLock();}
}
export const maximumUpstreamStreams=32;
interface FrontLiveRelay {upstream:WebSocket;client:ServerWebSocket<FrontLiveRelay>|null}
export function startFront(options:{control:string;port:number;nonce:string;fingerprint:string}){
 const origin=`http://127.0.0.1:${options.port}`;let active=0,last=performance.now();
 const server=Bun.serve<FrontLiveRelay>({hostname:'127.0.0.1',port:options.port,websocket:{
  idleTimeout:0,
  open(ws){last=performance.now();ws.data.client=ws;if(ws.data.upstream.readyState!==WebSocket.OPEN){try{ws.close();}catch{}return;}try{ws.send('live');}catch{}},
  message(ws,msg){last=performance.now();try{ws.data.upstream.send(msg);}catch{}},
  close(ws){last=performance.now();try{ws.data.upstream.close();}catch{}},
 },async fetch(req,srv){
  last=performance.now();
  try{
   const url=new URL(req.url);if(url.origin!==origin)return refuse('FRONT_LOOPBACK_REQUIRED',403);
   if(url.pathname==='/api/front-status'){if(req.method!=='GET'||!sameSecret(req.headers.get('authorization'),'Bearer '+options.nonce))return refuse('FRONT_STATUS_CAPABILITY_REQUIRED',403);return Response.json({schema:'rig-review-front-status/1',nonce:options.nonce,fingerprint:options.fingerprint},{headers:noStore});}
   const match=/^\/instances\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);if(!match)return refuse('FRONT_ROUTE_REFUSED',404);
   const key=match[1]!,path=match[2]!,sentOrigin=req.headers.get('origin');
   if(req.headers.get('sec-fetch-site')==='cross-site'||sentOrigin!==null&&sentOrigin!==origin)return refuse('FRONT_SAME_ORIGIN_REQUIRED',403);
   const record=await instanceRecord(options.control,key);if(!record)return refuse('FRONT_INSTANCE_UNKNOWN: reopen with rig-review open',404);
   const route=frontRoute(record.mode,req.method,path);if(!route)return refuse('FRONT_ROUTE_REFUSED',404);
   const landing=path==='/'||path==='/index.html',stageFrame=path==='/stage-parts.html'||path==='/stage-interview.html';if(stageFrame?!stageFrameQuery(record.mode,url.search):!landing&&!!url.search)return refuse('FRONT_QUERY_REFUSED',400);
   if(route.live){
    if(sentOrigin!==origin)return refuse('FRONT_SAME_ORIGIN_REQUIRED',403);
    if(req.headers.get('upgrade')?.toLowerCase()!=='websocket')return refuse('FRONT_UPGRADE_REQUIRED',426);
    const upstreamWs=new WebSocket(record.origin.replace(/^http/,'ws')+path,{headers:{[openNonceHeader]:record.nonce}} as unknown as string[]);
    const outcome=await new Promise<'ok'|'replaced'|'timeout'|'closed'>(resolve=>{
     const timer=setTimeout(()=>resolve('timeout'),route.timeoutMs);
     const finish=(result:'ok'|'replaced'|'timeout'|'closed')=>{clearTimeout(timer);resolve(result);};
     req.signal.addEventListener('abort',()=>finish('closed'),{once:true});
     upstreamWs.onmessage=ev=>{try{const msg=JSON.parse(String(ev.data)) as {type?:string;key?:string};finish(msg?.type==='live'&&msg?.key===key?'ok':'replaced');}catch{finish('replaced');}};
     upstreamWs.onerror=()=>finish('closed');
     upstreamWs.onclose=()=>finish('closed');
    });
    if(outcome!=='ok'){
     try{upstreamWs.close();}catch{}
     if(outcome==='timeout'&&!req.signal.aborted)return refuse('FRONT_UPSTREAM_TIMEOUT',504);
     if(outcome==='replaced')return refuse('FRONT_INSTANCE_REPLACED: reopen with rig-review open',410);
     const probe=await fetch(record.origin+'/api/access',{headers:{[openNonceHeader]:record.nonce},redirect:'manual',signal:AbortSignal.timeout(1500)}).catch(()=>null);
     void probe?.body?.cancel().catch(()=>{});
     return probe?refuse('FRONT_INSTANCE_REPLACED: reopen with rig-review open',410):refuse('FRONT_INSTANCE_EXPIRED: reopen with rig-review open',410);
    }
    const relay:FrontLiveRelay={upstream:upstreamWs,client:null};
    upstreamWs.onmessage=ev=>{try{relay.client?.send(String(ev.data));}catch{}};
    upstreamWs.onerror=()=>{try{relay.client?.close();}catch{}};
    upstreamWs.onclose=()=>{try{relay.client?.close();}catch{}};
    if(!srv.upgrade(req,{data:relay,headers:noStore})){try{upstreamWs.close();}catch{}return refuse('FRONT_UPGRADE_FAILED',400);}
    return undefined as unknown as Response;
   }
   let body:ArrayBuffer|undefined;
   if(route.mutation){
    // Never rewrite Origin without this instance's capability; the worker compares it again itself.
    if(sentOrigin!==origin)return refuse('FRONT_SAME_ORIGIN_REQUIRED',403);
    if(!sameSecret(req.headers.get(capabilityHeader),record.capability))return refuse('FRONT_CAPABILITY_REQUIRED: reopen with rig-review open to edit',403);
    body=await boundedBody(req,route.limit);
    // A stale interview worker must still prove its identity before it receives picks.
    // It revalidates the join before saving and returns the specific stale refusal.
    if(!await alive(record,(path==='/api/interview/picks'||path==='/api/stage-parts/verdict')))return refuse('FRONT_INSTANCE_EXPIRED: reopen with rig-review open',410);
   }
   if(active>=maximumUpstreamStreams)return refuse('FRONT_BUSY: too many concurrent upstream streams',503);
   const headers=new Headers({[openNonceHeader]:record.nonce});for(const name of ['accept','range','if-range',...(route.mutation?['content-type']:[]),...(route.control?['authorization']:[])]){const value=req.headers.get(name);if(value!==null)headers.set(name,value);}
   if(/^\/api\/stage-parts(?:\/(?:image|page)\/\d+|\/verdict|\/export\/(?:json|issue))?$/.test(path)){const build=req.headers.get('X-Review-Stage-Build');if(build!==null){if(build!=='inspected'&&!/^[a-f0-9]{64}$/.test(build))return refuse('FRONT_QUERY_REFUSED',400);headers.set('X-Review-Stage-Build',build);}}
   if(route.mutation){headers.set('origin',record.origin);headers.set(capabilityHeader,record.capability);}
   active++;let released=false;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),route.timeoutMs);const release=()=>{if(released)return;released=true;active--;clearTimeout(timer);};
   req.signal.addEventListener('abort',()=>abort.abort(),{once:true});
   let upstream:Response;
   try{upstream=await fetch(record.origin+path+(landing||stageFrame?url.search:''),{method:req.method,headers,...(body?{body}:{}),redirect:'manual',signal:abort.signal});}
   catch{release();return abort.signal.aborted&&!req.signal.aborted?refuse('FRONT_UPSTREAM_TIMEOUT',504):refuse('FRONT_INSTANCE_EXPIRED: reopen with rig-review open',410);}
   if(upstream.headers.get(openKeyHeader)!==key){void upstream.body?.cancel().catch(()=>{});release();return refuse('FRONT_INSTANCE_REPLACED: reopen with rig-review open',410);}
   if(upstream.status>=400&&upstream.status!==416){const named=await inspectionRefusal(record.mode,req.method,path,upstream,record.fingerprint===options.fingerprint);void upstream.body?.cancel().catch(()=>{});release();if(named)return refuse(named,upstream.status);const code=upstreamFailure[upstream.status];return refuse(code??'FRONT_UPSTREAM_FAILED',code?upstream.status:502);}
   const out=new Headers();for(const name of responseHeaders){const value=upstream.headers.get(name);if(value!==null)out.set(name,value);}
   if(!upstream.body||req.method==='HEAD'){void upstream.body?.cancel().catch(()=>{});release();return new Response(null,{status:upstream.status,headers:out});}
   if(timer)clearTimeout(timer);const reader=upstream.body.getReader();
   // Media/model streams stay counted until finished or cancelled by the browser.
   const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();release();}else controller.enqueue(next.value);}catch(error){release();controller.error(error);}},cancel(reason){release();abort.abort();return reader.cancel(reason).catch(()=>{});}});
   return new Response(stream,{status:upstream.status,headers:out});
  }catch(error){const message=error instanceof Error?error.message:'';return refuse(message.startsWith('FRONT_')?message:'FRONT_REQUEST_FAILED',message==='FRONT_BODY_LIMIT'?413:message==='FRONT_BODY_TIMEOUT'?408:400);}
 }});
 return {origin,stop:()=>server.stop(true),idleMs:()=>performance.now()-last,active:()=>active};
}
/** A missing directory or record means gone; any other read error (readdir or a record) throws, and the caller keeps
 * the front up. A record read that failed with EACCES or ENOTDIR used to count as gone and stopped the front (#354). */
async function liveInstances(control:string):Promise<boolean>{let names:string[];try{names=await readdir(control);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}for(const name of names){if(/^[a-f0-9]{64}\.claim$/.test(name))return true;if(/^[a-f0-9]{64}\.json$/.test(name)){const row=await readRecord(join(control,name),name.slice(0,64));if(row&&running(row.pid))return true;}}return false;}
export async function runFront(requestPath:string):Promise<void>{
 const spec=await smallJson(requestPath) as FrontRequest;if(spec?.schema!=='rig-review-front-request/1'||!uuid.test(spec.nonce??'')||!hex64.test(spec.fingerprint??'')||!Number.isSafeInteger(spec.port)||spec.port<1||spec.port>65535||!Number.isSafeInteger(spec.idleMs)||spec.idleMs<100)throw new Error('front: invalid request');
 const control=await realpath(spec.control);if(dirname(await realpath(requestPath))!==control||spec.request!==requestPath||spec.record!==join(control,frontName(spec.port)+'.json'))throw new Error('front: invalid state locations');
 if(await openFingerprint()!==spec.fingerprint)throw new Error('front: tool changed before startup');
 let front:ReturnType<typeof startFront>;
 try{front=startFront({control,port:spec.port,nonce:spec.nonce,fingerprint:spec.fingerprint});}catch(error){if((error as NodeJS.ErrnoException).code==='EADDRINUSE'||/in use/i.test(error instanceof Error?error.message:''))throw new Error(`FRONT_PORT_BUSY: 127.0.0.1:${spec.port}`);throw error;}
 const record:FrontRecord={schema:'rig-review-front/1',origin:front.origin,port:spec.port,nonce:spec.nonce,fingerprint:spec.fingerprint,pid:process.pid},tmp=spec.record+'.'+spec.nonce+'.tmp';await writeFile(tmp,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(tmp,spec.record);
 await unlink(requestPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
 let stopped=false;const stop=async(reason:string)=>{if(stopped)return;stopped=true;clearInterval(timer);front.stop();const current=await readFront(spec.record,spec.port).catch(()=>null);if(current?.nonce===spec.nonce)await unlink(spec.record).catch(()=>{});console.log(`review front: exiting — ${reason}.`);process.exit(0);};
 // Idle exit only once no request arrived for idleMs and no live worker record remains.
 const timer=setInterval(()=>{if(front.idleMs()>=spec.idleMs&&front.active()===0)void liveInstances(control).then(live=>{if(!live)void stop(`no live review instances remain (idle for ${spec.idleMs}ms)`)}).catch(()=>{});},Math.min(250,spec.idleMs));
 process.on('SIGTERM',()=>{void stop('received SIGTERM');});process.on('SIGINT',()=>{void stop('received SIGINT');});
}
