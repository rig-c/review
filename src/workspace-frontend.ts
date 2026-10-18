/** App-owned stable loopback origin. Registrations are an in-process trusted API,
 * never a browser-supplied URL/port/path or a generic HTTP proxy endpoint. */
import type {Server} from 'bun';
import {packagePath} from './manifest.ts';
import type {OpenIdentity} from './open-protocol.ts';
import {readOpenStatus} from './open.ts';

export const DEFAULT_WORKSPACE_PORT=4318; // Foreground review already owns the default4317.
export const INSTANCE_HEADER='X-Review-Instance';
export interface FrontendRegistration {origin:string;identity:OpenIdentity;mode:'single'|'compare'}
export interface WorkspaceFrontend {
 readonly origin:string;readonly port:number;
 register(value:FrontendRegistration):Promise<string>;
 revoke(key:string):void;
 stop():Promise<void>;
}
interface Registration extends FrontendRegistration {expires:number}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const json=(error:string,status:number)=>Response.json({error},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
function loopbackOrigin(value:string):boolean {try{const url=new URL(value);return url.origin===value&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&/^[1-9]\d{0,4}$/.test(url.port)&&Number(url.port)<=65535;}catch{return false;}}
function checkedRegistration(value:FrontendRegistration,fingerprint:string,origin:string):FrontendRegistration {
 const i=value.identity;if(!loopbackOrigin(value.origin)||value.origin===origin||value.mode!=='single'&&value.mode!=='compare'||!i||!hash(i.key)||!hash(i.contentHash)||i.fingerprint!==fingerprint||!hash(i.fingerprint)||typeof i.nonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(i.nonce))throw new Error('FRONTEND_REGISTRATION_INVALID: exact compatible loopback worker identity required');
 return {origin:value.origin,identity:{key:i.key,contentHash:i.contentHash,nonce:i.nonce,fingerprint:i.fingerprint},mode:value.mode};
}
async function workerReady(row:FrontendRegistration):Promise<boolean> {
 try{const response=await fetch(row.origin+'/api/open-status',{headers:{Authorization:'Bearer '+row.identity.nonce},redirect:'error',signal:AbortSignal.timeout(1500)});if(!response.ok){void response.body?.cancel();return false;}const status=await readOpenStatus(response) as Partial<OpenIdentity>&{schema?:string;ready?:boolean};return status.schema==='rig-review-open-status/1'&&status.ready!==false&&status.key===row.identity.key&&status.contentHash===row.identity.contentHash&&status.fingerprint===row.identity.fingerprint&&status.nonce===row.identity.nonce;}catch{return false;}
}
function permitted(path:string,method:string,mode:FrontendRegistration['mode']):boolean {
 const read=method==='GET'||method==='HEAD';
 if(read&&['/','/index.html','/main.js','/styles.css'].includes(path))return true;
 if(path==='/api/control/config'||path==='/api/control')return method==='GET';
 if(/^\/api\/control\/receipts\/[a-f0-9-]{36}$/.test(path))return method==='GET';
 if(['/api/control/register','/api/control/poll','/api/control/ack','/api/control/close','/api/control/commands'].includes(path))return method==='POST';
 if(mode==='single'){
  if(path==='/api/session')return read||method==='PUT';
  if(path==='/api/review'||path==='/review-reference')return read;
  if(path==='/api/strip')return method==='POST';
  if(path.startsWith('/assets/')&&read){packagePath(decodeURIComponent(path.slice('/assets/'.length)));return true;}
 }else{
  if(path==='/api/compare/session')return read||method==='PUT';
  if(path==='/api/compare'||path==='/api/compare/reference-frames'||path==='/compare-reference')return read;
  if(path==='/api/compare/strip')return method==='POST';
  const match=/^\/compare-assets\/(a|b)\/(.+)$/.exec(path);if(match&&read){packagePath(decodeURIComponent(match[2]!));return true;}
 }
 return false;
}
async function boundedJson(req:Request,limit:number):Promise<Uint8Array> {
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('FRONTEND_JSON_REQUIRED');
 const size=req.headers.get('content-length');if(size!==null&&(!/^\d+$/.test(size)||Number(size)>limit))throw new Error('FRONTEND_BODY_LIMIT');
 if(!req.body)throw new Error('FRONTEND_JSON_REQUIRED');const reader=req.body.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{let size=0;const chunks:Uint8Array[]=[];while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new Error('FRONTEND_BODY_LIMIT');chunks.push(next.value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return bytes;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('FRONTEND_BODY_TIMEOUT')),2000);})]);}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
/** A caller explicitly starts this listener and owns its lifetime. Default open
 * remains direct until the instance-base UI wiring and managed lifecycle land. */
export function startWorkspaceFrontend(options:{fingerprint:string;port?:number;idleMs?:number;leaseMs?:number;now?:()=>number;application?:{nonce:string;resolve:(key:string,contentHash:string)=>Promise<FrontendRegistration>}}):WorkspaceFrontend {
 if(!hash(options.fingerprint))throw new Error('FRONTEND_FINGERPRINT_REQUIRED');
 if(options.application&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.application.nonce))throw new Error('FRONTEND_APP_CAPABILITY_REQUIRED');
 const port=options.port??DEFAULT_WORKSPACE_PORT,idleMs=options.idleMs??30*60*1000,leaseMs=options.leaseMs??30*60*1000,now=options.now??Date.now;
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('FRONTEND_PORT_REQUIRED: fixed port1..65535; no ephemeral fallback');
 if(!Number.isSafeInteger(idleMs)||idleMs<100||!Number.isSafeInteger(leaseMs)||leaseMs<100)throw new Error('FRONTEND_LIFETIME_REQUIRED');
 const origin='http://127.0.0.1:'+port,rows=new Map<string,Registration>();let stopped=false,last=now(),server:Server<undefined>,timer:ReturnType<typeof setInterval>;
 const active=new Set<AbortController>();
 const register=async(input:FrontendRegistration):Promise<string>=>{
  if(stopped)throw new Error('FRONTEND_STOPPED');const checked=checkedRegistration(input,options.fingerprint,origin),key=checked.identity.key,previous=rows.get(key);
  if(previous&&current(key,previous)&&JSON.stringify({origin:previous.origin,identity:previous.identity,mode:previous.mode})!==JSON.stringify(checked)&&await workerReady(previous))throw new Error('FRONTEND_INSTANCE_CONFLICT: live immutable registration differs');
  if(!await workerReady(checked))throw new Error('FRONTEND_WORKER_UNVERIFIED');
  if(stopped)throw new Error('FRONTEND_STOPPED');
  if(rows.size>=64&&!rows.has(key))throw new Error('FRONTEND_INSTANCES_BUSY');
  const observed=rows.get(key);if(observed!==previous&&(!observed||JSON.stringify({origin:observed.origin,identity:observed.identity,mode:observed.mode})!==JSON.stringify(checked)))throw new Error('FRONTEND_REGISTRATION_SUPERSEDED');
  const same=observed&&JSON.stringify({origin:observed.origin,identity:observed.identity,mode:observed.mode})===JSON.stringify(checked);const row=same&&observed?observed:{...checked,expires:now()+leaseMs};row.expires=now()+leaseMs;rows.set(key,row);last=now();
  const url=new URL(origin+'/instances/'+key+'/');url.searchParams.set('input',row.identity.contentHash);url.searchParams.set('handoff',key);return url.href;
 };
 const current=(key:string,row:Registration)=>!stopped&&rows.get(key)===row&&now()<row.expires;
 const stop=async()=>{if(stopped)return;stopped=true;clearInterval(timer);rows.clear();for(const request of active)request.abort();await server.stop(true);};
 try{server=Bun.serve({hostname:'127.0.0.1',port,async fetch(req){
  try{
   const url=new URL(req.url);if(url.origin!==origin)return json('FRONTEND_LOOPBACK_REQUIRED',403);
   if(stopped)return json('FRONTEND_STOPPED',503);
   if(req.headers.get('sec-fetch-site')==='cross-site'||req.headers.has('origin')&&req.headers.get('origin')!==origin)return json('FRONTEND_SAME_ORIGIN_REQUIRED',403);
   if(url.pathname.startsWith('/api/workspace/')){
    const app=options.application;if(!app||req.headers.get('authorization')!=='Bearer '+app.nonce||req.headers.has('origin')||req.headers.has('sec-fetch-site')||url.search)return json('FRONTEND_APP_CAPABILITY_REQUIRED',403);
    if(url.pathname==='/api/workspace/status'&&req.method==='GET')return Response.json({schema:'rig-review-workspace-status/1',nonce:app.nonce,fingerprint:options.fingerprint},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    if(url.pathname==='/api/workspace/register'&&req.method==='POST'){
     const raw=JSON.parse(new TextDecoder().decode(await boundedJson(req,16384))) as Record<string,unknown>;
     if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='contentHash,key'||!hash(raw.key)||!hash(raw.contentHash))return json('FRONTEND_APP_REGISTRATION_INVALID',400);
     const descriptor=await app.resolve(raw.key,raw.contentHash);return Response.json({url:await register(descriptor)},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    return json('FRONTEND_APP_ROUTE_REFUSED',404);
   }
   const match=/^\/instances\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);if(!match)return json('FRONTEND_INSTANCE_REQUIRED',404);
   const key=match[1]!,path=match[2]!,row=rows.get(key);if(!row)return json('FRONTEND_INSTANCE_UNKNOWN',404);
   if(!current(key,row)){rows.delete(key);return json('FRONTEND_INSTANCE_EXPIRED',409);}
   if(!permitted(path,req.method,row.mode))return json('FRONTEND_ROUTE_REFUSED',404);
   const landing=path==='/'||path==='/index.html';
   if(!landing&&url.search)return json('FRONTEND_QUERY_REFUSED',400);
   if(landing&&(url.searchParams.get('input')!==row.identity.contentHash||url.searchParams.get('handoff')!==key))return json('FRONTEND_STALE_BINDING',409);
   const mutation=req.method!=='GET'&&req.method!=='HEAD';
   if(mutation&&(req.headers.get('origin')!==origin||req.headers.get(INSTANCE_HEADER)!==key))return json('FRONTEND_INSTANCE_ORIGIN_REQUIRED',403);
   // Buffer BEFORE the final liveness check. An identity that expires/replaces
   // while a body is arriving must not reach any worker mutation endpoint.
   const body=mutation?await boundedJson(req,path.startsWith('/api/control')?16384:1024*1024):undefined;
   if(!await workerReady(row)){if(rows.get(key)===row)rows.delete(key);return json('FRONTEND_WORKER_STALE: reopen the exact package',409);}
   if(!current(key,row))return json('FRONTEND_INSTANCE_EXPIRED',409);
   const headers=new Headers();for(const name of ['accept','range','authorization','content-type']){const value=req.headers.get(name);if(value!==null)headers.set(name,value);}
   if(mutation)headers.set('Origin',row.origin);
   const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),30000);active.add(abort);let streaming=false;const release=()=>{clearTimeout(timeout);active.delete(abort);};
   req.signal.addEventListener('abort',()=>abort.abort(),{once:true});
   try{
    const result=await fetch(row.origin+path+url.search,{method:req.method,headers,...(body?{body:new Uint8Array(body).buffer}:{}),redirect:'error',signal:abort.signal});
    if(!current(key,row)){void result.body?.cancel();return json('FRONTEND_INSTANCE_EXPIRED',409);}
    row.expires=now()+leaseMs;last=now();
    const responseHeaders=new Headers();for(const name of ['content-type','content-length','content-range','accept-ranges','content-disposition','cache-control','content-security-policy','x-content-type-options','referrer-policy']){const value=result.headers.get(name);if(value!==null)responseHeaders.set(name,value);}
    responseHeaders.set(INSTANCE_HEADER,key);responseHeaders.set('X-Review-Source',row.identity.contentHash);
    // No Set-Cookie, CORS, redirect or arbitrary upstream response-header escape.
    if(!result.body)return new Response(null,{status:result.status,headers:responseHeaders});
    // Bun may choose chunked framing for custom streams. Keep bounded small
    // responses (including inspection range probes) byte/length exact without
    // buffering unbounded models or media. Large responses remain streaming.
    const length=result.headers.get('content-length');if(length!==null&&/^\d+$/.test(length)&&Number(length)<=65536){const reader=result.body.getReader(),chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536){await reader.cancel();throw new Error('FRONTEND_RESPONSE_LIMIT');}chunks.push(next.value);}if(size!==Number(length))throw new Error('FRONTEND_RESPONSE_LENGTH_MISMATCH');const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return new Response(bytes,{status:result.status,headers:responseHeaders});}
    clearTimeout(timeout);const reader=result.body.getReader();streaming=true;const responseStream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();release();}else controller.enqueue(next.value);}catch(error){controller.error(error);release();}},async cancel(reason){try{await reader.cancel(reason);}finally{abort.abort();release();}}});
    return new Response(responseStream,{status:result.status,headers:responseHeaders});
   }finally{if(!streaming)release();}
  }catch(error){const detail=error instanceof Error?error.message:'Request failed';return json(detail.startsWith('FRONTEND_')?detail:'FRONTEND_REQUEST_FAILED: '+detail,400);}
 }});}catch(error){if((error as NodeJS.ErrnoException).code==='EADDRINUSE')throw new Error(`FRONTEND_PORT_CONFLICT: ${origin}; listener was not replaced`);throw error;}
 timer=setInterval(()=>{for(const [key,row]of rows)if(now()>=row.expires)rows.delete(key);if(now()-last>=idleMs)void stop();},Math.min(1000,idleMs,leaseMs));
 return {origin,port,register,revoke(key){rows.delete(key);},stop};
}
