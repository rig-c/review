/** Managed loopback front: one stable origin (127.0.0.1:4318 by default) routing `/instances/<key>/…` to the
 * worker named by that key's private open record. It is a router, not an authority: it never reads packages,
 * never serves or logs a capability, and forwards a mutation (rewriting Origin) only with the page capability. */
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lstat,readFile,readdir,realpath,rename,unlink,writeFile,open as openFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireClaim,alive,openFingerprint,readRecord,releaseClaim,running,smallJson,type RecordFile} from './open.ts';
import {capabilityHeader,openKeyHeader,openNonceHeader,sameSecret} from './open-protocol.ts';
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
 const {control,port,fingerprint}=options,name=frontName(port),recordPath=join(control,name+'.json'),nonce=randomUUID(),deadline=performance.now()+20000,idleMs=options.idleMs??30*60*1000;
 const reuse=async()=>{const row=await readFront(recordPath,port);if(!row||!await frontAlive(row))return null;if(row.fingerprint===fingerprint)return row;
  try{process.kill(row.pid,'SIGTERM');}catch{}for(let n=0;n<100&&await frontAlive(row);n++)await sleep(30);return null;};
 const ready=await reuse();if(ready)return ready.origin;
 const claimed=await acquireClaim(control,name,nonce,reuse,deadline,'FRONT_BUSY: front startup claim did not become ready');if('row' in claimed)return claimed.row.origin;
 let request:string|undefined,child:ReturnType<typeof spawn>|undefined,handedOff=false;
 try{
  const row=await reuse();if(row)return row.origin;
  request=join(control,`${name}.${nonce}.request.json`);const log=join(control,`${name}.${nonce}.log`);
  const spec:FrontRequest={schema:'rig-review-front-request/1',control,request,record:recordPath,port,nonce,fingerprint,idleMs};await writeFile(request,JSON.stringify(spec),{mode:0o600,flag:'wx'});
  const logHandle=await openFile(log,'a',0o600);try{child=spawn(process.execPath,[join(appRoot,'src/front-worker.ts'),request],{cwd:control,detached:true,stdio:['ignore',logHandle.fd,logHandle.fd],env:process.env});child.unref();}finally{await logHandle.close();}
  let exited:string|undefined;child.on('error',error=>{exited=error.message;});child.on('exit',(code,signal)=>{exited=`exit ${code} ${signal??''}`;});
  while(performance.now()<deadline){const live=await reuse();if(live){handedOff=true;return live.origin;}
   if(exited){if(/FRONT_PORT_BUSY/.test(await readFile(log,'utf8').catch(()=>'')))throw new Error(`FRONT_PORT_BUSY: 127.0.0.1:${port} is held by another listener; use --direct (or set RIG_REVIEW_FRONT_PORT)`);throw new Error(`FRONT_START: ${exited}; front log ${log}`);}
   await sleep(30);}
  throw new Error(`FRONT_TIMEOUT: front did not become ready; log ${log}`);
 }finally{if(child&&!handedOff&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await releaseClaim(join(control,name+'.claim'),nonce);if(request)await unlink(request).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
interface Route {mutation:boolean;limit:number;timeoutMs:number;control:boolean}
/** Closed allowlist per method. Agent control endpoints, open-status and anything unlisted are refused. */
export function frontRoute(mode:'single'|'compare',method:string,path:string):Route|null{
 const read=method==='GET'||method==='HEAD',get:Route={mutation:false,limit:0,timeoutMs:30000,control:false};
 if(['/','/index.html','/main.js','/styles.css','/api/access'].includes(path))return read?get:null;
 if(path==='/api/control/config')return method==='GET'?{...get,control:true}:null;
 if(['/api/control/register','/api/control/poll','/api/control/ack','/api/control/close'].includes(path))return method==='POST'?{mutation:true,limit:16384,timeoutMs:10000,control:true}:null;
 const session=mode==='single'?'/api/session':'/api/compare/session',strip=mode==='single'?'/api/strip':'/api/compare/strip';
 if(path===session)return read?get:method==='PUT'?{mutation:true,limit:1024*1024,timeoutMs:30000,control:false}:null;
 if(path===strip)return method==='POST'?{mutation:true,limit:1024*1024,timeoutMs:120000,control:false}:null;
 const reads=mode==='single'?['/api/review','/review-reference']:['/api/compare','/api/compare/reference-frames','/compare-reference'];
 if(reads.includes(path))return read?get:null;
 if((mode==='single'?/^\/assets\/[^/]/:/^\/compare-assets\/(a|b)\/[^/]/).test(path))return read?get:null;
 // Apply · Rebuild (single only): status, one typed request, a job's status and its served scratch build.
 if(mode==='single'&&path==='/api/rebuild')return read?get:method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(mode==='single'&&(/^\/api\/rebuild\/[a-f0-9]{64}$/.test(path)||/^\/rebuild\/[a-f0-9]{64}\/[^/]/.test(path)))return read?get:null;
 // Bones check (#109, single only): one typed request {ops, configHash}, answered in the response.
 if(mode==='single'&&path==='/api/bones-check')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:60000,control:false}:null;
 // Readings (#108, single only): one typed request, then its job's status.
 if(mode==='single'&&path==='/api/readings')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(mode==='single'&&/^\/api\/readings\/[a-f0-9]{64}$/.test(path))return read?get:null;
 // Declared requirements (#113, single only): the stage's catalog, one typed request, then its job's status.
 if(mode==='single'&&path==='/api/requirements')return read?get:method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(mode==='single'&&/^\/api\/requirements\/[a-f0-9]{64}$/.test(path))return read?get:null;
 // Check under this world (#112, single only): one typed request {build, schedule}, then its job's status.
 if(mode==='single'&&path==='/api/environment-check')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(mode==='single'&&/^\/api\/environment-check\/[a-f0-9]{64}$/.test(path))return read?get:null;
 return null;
}
async function boundedBody(req:Request,limit:number,timeoutMs=10000):Promise<ArrayBuffer>{
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('FRONT_JSON_REQUIRED');
 const declared=req.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('FRONT_BODY_LIMIT');
 if(!req.body)throw new Error('FRONT_JSON_REQUIRED');const reader=req.body.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{const chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new Error('FRONT_BODY_LIMIT');chunks.push(next.value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes.buffer;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('FRONT_BODY_TIMEOUT')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
/** Owner-only regular record for this key, or null. */
async function instanceRecord(control:string,key:string):Promise<RecordFile|null>{const file=join(control,key+'.json');try{const info=await lstat(file);if(!info.isFile()||(info.mode&0o077)!==0)return null;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}return readRecord(file,key);}
/** Worker statuses map to named front codes; worker text never reaches the client. */
const upstreamFailure:Record<number,string>={400:'FRONT_UPSTREAM_REJECTED',403:'FRONT_UPSTREAM_FORBIDDEN',404:'FRONT_UPSTREAM_NOT_FOUND',405:'FRONT_UPSTREAM_METHOD',409:'FRONT_UPSTREAM_CONFLICT'};
const responseHeaders=['content-type','content-length','content-range','accept-ranges','content-disposition','cache-control','content-security-policy','x-content-type-options','referrer-policy'];
export const maximumUpstreamStreams=32;
export function startFront(options:{control:string;port:number;nonce:string;fingerprint:string}){
 const origin=`http://127.0.0.1:${options.port}`;let active=0,last=performance.now();
 const server=Bun.serve({hostname:'127.0.0.1',port:options.port,async fetch(req){
  last=performance.now();
  try{
   const url=new URL(req.url);if(url.origin!==origin)return refuse('FRONT_LOOPBACK_REQUIRED',403);
   if(url.pathname==='/api/front-status'){if(req.method!=='GET'||!sameSecret(req.headers.get('authorization'),'Bearer '+options.nonce))return refuse('FRONT_STATUS_CAPABILITY_REQUIRED',403);return Response.json({schema:'rig-review-front-status/1',nonce:options.nonce,fingerprint:options.fingerprint},{headers:noStore});}
   const match=/^\/instances\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);if(!match)return refuse('FRONT_ROUTE_REFUSED',404);
   const key=match[1]!,path=match[2]!,sentOrigin=req.headers.get('origin');
   if(req.headers.get('sec-fetch-site')==='cross-site'||sentOrigin!==null&&sentOrigin!==origin)return refuse('FRONT_SAME_ORIGIN_REQUIRED',403);
   const record=await instanceRecord(options.control,key);if(!record)return refuse('FRONT_INSTANCE_UNKNOWN: reopen with rig-review open',404);
   const route=frontRoute(record.mode,req.method,path);if(!route)return refuse('FRONT_ROUTE_REFUSED',404);
   const landing=path==='/'||path==='/index.html';if(!landing&&url.search)return refuse('FRONT_QUERY_REFUSED',400);
   let body:ArrayBuffer|undefined;
   if(route.mutation){
    // Never rewrite Origin without this instance's capability; the worker compares it again itself.
    if(sentOrigin!==origin)return refuse('FRONT_SAME_ORIGIN_REQUIRED',403);
    if(!sameSecret(req.headers.get(capabilityHeader),record.capability))return refuse('FRONT_CAPABILITY_REQUIRED: reopen with rig-review open to edit',403);
    body=await boundedBody(req,route.limit);
    if(!await alive(record))return refuse('FRONT_INSTANCE_EXPIRED: reopen with rig-review open',410);
   }
   if(active>=maximumUpstreamStreams)return refuse('FRONT_BUSY: too many concurrent upstream streams',503);
   const headers=new Headers({[openNonceHeader]:record.nonce});for(const name of ['accept','range','if-range',...(route.mutation?['content-type']:[]),...(route.control?['authorization']:[])]){const value=req.headers.get(name);if(value!==null)headers.set(name,value);}
   if(route.mutation){headers.set('origin',record.origin);headers.set(capabilityHeader,record.capability);}
   active++;let released=false;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),route.timeoutMs);const release=()=>{if(released)return;released=true;active--;clearTimeout(timer);};
   req.signal.addEventListener('abort',()=>abort.abort(),{once:true});
   let upstream:Response;
   try{upstream=await fetch(record.origin+path+(landing?url.search:''),{method:req.method,headers,...(body?{body}:{}),redirect:'manual',signal:abort.signal});}
   catch{release();return abort.signal.aborted&&!req.signal.aborted?refuse('FRONT_UPSTREAM_TIMEOUT',504):refuse('FRONT_INSTANCE_EXPIRED: reopen with rig-review open',410);}
   if(upstream.headers.get(openKeyHeader)!==key){void upstream.body?.cancel().catch(()=>{});release();return refuse('FRONT_INSTANCE_REPLACED: reopen with rig-review open',410);}
   if(upstream.status>=400&&upstream.status!==416){void upstream.body?.cancel().catch(()=>{});release();const code=upstreamFailure[upstream.status];return refuse(code??'FRONT_UPSTREAM_FAILED',code?upstream.status:502);}
   const out=new Headers();for(const name of responseHeaders){const value=upstream.headers.get(name);if(value!==null)out.set(name,value);}
   if(!upstream.body||req.method==='HEAD'){void upstream.body?.cancel().catch(()=>{});release();return new Response(null,{status:upstream.status,headers:out});}
   clearTimeout(timer);const reader=upstream.body.getReader();
   // Media/model streams stay counted until finished or cancelled by the browser.
   const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();release();}else controller.enqueue(next.value);}catch(error){release();controller.error(error);}},cancel(reason){release();abort.abort();return reader.cancel(reason).catch(()=>{});}});
   return new Response(stream,{status:upstream.status,headers:out});
  }catch(error){const message=error instanceof Error?error.message:'';return refuse(message.startsWith('FRONT_')?message:'FRONT_REQUEST_FAILED',message==='FRONT_BODY_LIMIT'?413:message==='FRONT_BODY_TIMEOUT'?408:400);}
 }});
 return {origin,stop:()=>server.stop(true),idleMs:()=>performance.now()-last,active:()=>active};
}
async function liveInstances(control:string):Promise<boolean>{for(const name of await readdir(control))if(/^[a-f0-9]{64}\.json$/.test(name)){const row=await readRecord(join(control,name),name.slice(0,64)).catch(()=>null);if(row&&running(row.pid))return true;}return false;}
export async function runFront(requestPath:string):Promise<void>{
 const spec=await smallJson(requestPath) as FrontRequest;if(spec?.schema!=='rig-review-front-request/1'||!uuid.test(spec.nonce??'')||!hex64.test(spec.fingerprint??'')||!Number.isSafeInteger(spec.port)||spec.port<1||spec.port>65535||!Number.isSafeInteger(spec.idleMs)||spec.idleMs<100)throw new Error('front: invalid request');
 const control=await realpath(spec.control);if(dirname(await realpath(requestPath))!==control||spec.request!==requestPath||spec.record!==join(control,frontName(spec.port)+'.json'))throw new Error('front: invalid state locations');
 if(await openFingerprint()!==spec.fingerprint)throw new Error('front: tool changed before startup');
 let front:ReturnType<typeof startFront>;
 try{front=startFront({control,port:spec.port,nonce:spec.nonce,fingerprint:spec.fingerprint});}catch(error){if((error as NodeJS.ErrnoException).code==='EADDRINUSE'||/in use/i.test(error instanceof Error?error.message:''))throw new Error(`FRONT_PORT_BUSY: 127.0.0.1:${spec.port}`);throw error;}
 const record:FrontRecord={schema:'rig-review-front/1',origin:front.origin,port:spec.port,nonce:spec.nonce,fingerprint:spec.fingerprint,pid:process.pid},tmp=spec.record+'.'+spec.nonce+'.tmp';await writeFile(tmp,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(tmp,spec.record);
 await unlink(requestPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
 let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;clearInterval(timer);front.stop();const current=await readFront(spec.record,spec.port).catch(()=>null);if(current?.nonce===spec.nonce)await unlink(spec.record).catch(()=>{});process.exit(0);};
 // Idle exit only once no request arrived for idleMs and no live worker record remains.
 const timer=setInterval(()=>{if(front.idleMs()>=spec.idleMs&&front.active()===0)void liveInstances(control).then(live=>{if(!live)void stop();}).catch(()=>{});},Math.min(1000,spec.idleMs));
 process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
}
