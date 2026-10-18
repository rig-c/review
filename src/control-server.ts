import {randomUUID,timingSafeEqual} from 'node:crypto';
import {controlInteger,controlObject,controlString,parseControlInspection,parseControlRequest,type ControlDelivery,type ControlInspection,type ControlMode,type ControlReceipt,type ControlRequest} from './control.ts';
export interface ControlIdentity {token:string;instanceKey:string}
interface Page {id:string;token:string;revision:number;inspection:ControlInspection;seen:number;queue:string[];inflight:string|null}
interface Entry {request:ControlRequest;receipt:ControlReceipt;created:number;dispatched?:number}
const response=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function bearer(req:Request,token:string):boolean{const actual=Buffer.from(req.headers.get('authorization')??''),expected=Buffer.from('Bearer '+token);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export async function readControlBody(req:Request,timeoutMs=2000):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('CONTROL_JSON_REQUIRED');
 if(!req.body)throw new Error('CONTROL_JSON_REQUIRED');const reader=req.body.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{const chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16384)throw new Error('CONTROL_BODY_LIMIT: maximum 16 KiB');chunks.push(next.value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('CONTROL_BODY_TIMEOUT')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
/** Per-worker bounded ephemeral inspection mailbox. No file, package or feedback mutation. */
export function createControlServer(options:{identity:ControlIdentity;sourceHash:string;mode:ControlMode;unchanged:()=>Promise<void>;activity?:()=>void;now?:()=>number}){
 const pages=new Map<string,Page>(),entries=new Map<string,Entry>(),requests=new Map<string,string>();const now=options.now??Date.now;
 function expire(){
  const time=now();for(const [id,page]of pages)if(time-page.seen>30000||page.inflight&&time-(entries.get(page.inflight)?.dispatched??time)>30000){for(const entry of entries.values())if(entry.request.pageId===id&&['queued','dispatched'].includes(entry.receipt.status)){entry.receipt.status=entry.receipt.status==='queued'?'rejected':'outcome-unknown';entry.receipt.error='CONTROL_PAGE_EXPIRED';}pages.delete(id);}
  for(const entry of entries.values())if(entry.receipt.status==='queued'&&time-entry.created>10000){entry.receipt.status='rejected';entry.receipt.error='CONTROL_COMMAND_EXPIRED';}
 }
 function snapshot(){return {schema:'rig-review-control-state/1',instanceKey:options.identity.instanceKey,sourceHash:options.sourceHash,mode:options.mode,pages:[...pages.values()].map(p=>({pageId:p.id,revision:p.revision,inspection:p.inspection}))};}
 function pageFor(req:Request,id:unknown):Page{const page=pages.get(controlString(id,'control.pageId'));if(!page||!bearer(req,page.token))throw new Error('CONTROL_PAGE_CAPABILITY_REQUIRED');return page;}
 function errorStatus(message:string){return /CAPABILITY_REQUIRED/.test(message)?403:/STALE|INPUTS_CHANGED|BUSY|EXPIRED|NO_PAGE/.test(message)?409:400;}
 return async function handle(req:Request,origin:string):Promise<Response|null>{
  const url=new URL(req.url);if(!url.pathname.startsWith('/api/control'))return null;
  try{
   if(url.origin!==origin||url.search)return response({error:'CONTROL_LOOPBACK_PATH_REQUIRED'},403);
   expire();
   if(url.pathname==='/api/control/config'&&req.method==='GET')return response({schema:'rig-review-control-config/1',enabled:true,sourceHash:options.sourceHash,instanceKey:options.identity.instanceKey,mode:options.mode});
   const agent=bearer(req,options.identity.token);
   if(url.pathname==='/api/control'&&req.method==='GET'){if(!agent)return response({error:'CONTROL_CAPABILITY_REQUIRED'},403);await options.unchanged();return response(snapshot());}
   if(url.pathname.startsWith('/api/control/receipts/')&&req.method==='GET'){
    if(!agent)return response({error:'CONTROL_CAPABILITY_REQUIRED'},403);const entry=entries.get(url.pathname.slice('/api/control/receipts/'.length));return entry?response(entry.receipt):response({error:'CONTROL_RECEIPT_NOT_FOUND'},404);
   }
   if(req.method!=='POST')return response({error:'CONTROL_METHOD_NOT_ALLOWED'},405);
   if(req.headers.get('origin')!==origin||req.headers.get('sec-fetch-site')==='cross-site')return response({error:'CONTROL_SAME_ORIGIN_REQUIRED'},403);
   if(url.pathname==='/api/control/commands'){
    if(!agent)return response({error:'CONTROL_CAPABILITY_REQUIRED'},403);
    const input=parseControlRequest(await readControlBody(req));if(input.sourceHash!==options.sourceHash||input.instanceKey!==options.identity.instanceKey)return response({error:'CONTROL_STALE_BINDING'},409);
    const existing=requests.get(input.requestId);if(existing){const entry=entries.get(existing)!;if(JSON.stringify(entry.request)!==JSON.stringify(input))return response({error:'CONTROL_REQUEST_ID_CONFLICT'},409);return response(entry.receipt);}
    const page=pages.get(input.pageId);if(!page)return response({error:'CONTROL_NO_PAGE'},409);
    if(input.expectedRevision!==page.revision)return response({error:'CONTROL_STALE_STATE'},409);
    if(page.queue.filter(id=>entries.get(id)?.receipt.status==='queued').length>=8)return response({error:'CONTROL_QUEUE_BUSY'},409);
    await options.unchanged();
    // Recheck after asynchronous hashing: a concurrent poll/command may have won.
    const concurrent=requests.get(input.requestId);if(concurrent){const entry=entries.get(concurrent)!;return JSON.stringify(entry.request)===JSON.stringify(input)?response(entry.receipt):response({error:'CONTROL_REQUEST_ID_CONFLICT'},409);}
    if(pages.get(page.id)!==page||input.expectedRevision!==page.revision)return response({error:'CONTROL_STALE_STATE'},409);
    page.queue=page.queue.filter(id=>entries.get(id)?.receipt.status==='queued');if(page.queue.length>=8)return response({error:'CONTROL_QUEUE_BUSY'},409);
    while(entries.size>=64){const old=[...entries].find(([,v])=>!['queued','dispatched'].includes(v.receipt.status));if(!old)return response({error:'CONTROL_RECEIPTS_BUSY'},409);requests.delete(old[1].request.requestId);entries.delete(old[0]);}
    const commandId=randomUUID(),receipt:ControlReceipt={commandId,requestId:input.requestId,pageId:page.id,status:'queued',revision:page.revision,inspection:null};entries.set(commandId,{request:input,receipt,created:now()});requests.set(input.requestId,commandId);page.queue.push(commandId);options.activity?.();return response(receipt,202);
   }
   if(url.pathname==='/api/control/register'){
    const input=controlObject(await readControlBody(req),['sourceHash','inspection'],'control.register');if(input.sourceHash!==options.sourceHash)return response({error:'CONTROL_STALE_BINDING'},409);
    const inspection=parseControlInspection(input.inspection);if(pages.size>=4)return response({error:'CONTROL_PAGES_BUSY'},409);await options.unchanged();if(pages.size>=4)return response({error:'CONTROL_PAGES_BUSY'},409);
    const page:Page={id:randomUUID(),token:randomUUID(),revision:0,inspection,seen:now(),queue:[],inflight:null};pages.set(page.id,page);options.activity?.();return response({pageId:page.id,pageToken:page.token,revision:0},201);
   }
   if(url.pathname!=='/api/control/poll'&&url.pathname!=='/api/control/ack'&&url.pathname!=='/api/control/close')return response({error:'CONTROL_NOT_FOUND'},404);
   // Read the bounded body only after identifying a live page capability.
   const tokenPage=[...pages.values()].find(p=>bearer(req,p.token));if(!tokenPage)return response({error:'CONTROL_PAGE_CAPABILITY_REQUIRED'},403);
   const input=controlObject(await readControlBody(req),url.pathname.endsWith('/ack')?['pageId','revision','inspection','commandId','status','error']:url.pathname.endsWith('/close')?['pageId']:['pageId','revision','inspection','active'],'control.page');
   const page=pageFor(req,input.pageId);if(url.pathname.endsWith('/close')){for(const entry of entries.values())if(entry.request.pageId===page.id&&['queued','dispatched'].includes(entry.receipt.status)){entry.receipt.status=entry.receipt.status==='dispatched'?'outcome-unknown':'rejected';entry.receipt.error='CONTROL_PAGE_CLOSED';}pages.delete(page.id);return response({closed:true});}
   const revision=controlInteger(input.revision,'control.revision'),inspection=parseControlInspection(input.inspection);if(revision<page.revision)return response({error:'CONTROL_STALE_STATE'},409);page.seen=now();
   if(url.pathname.endsWith('/ack')){
    const id=controlString(input.commandId,'control.commandId'),entry=entries.get(id);if(!entry||entry.request.pageId!==page.id||page.inflight!==id)return response({error:'CONTROL_STALE_ACK'},409);
    if(!['applied','rejected','failed','superseded'].includes(String(input.status)))throw new Error('control.status: invalid acknowledgment');
    if(input.status==='applied'&&revision!==entry.request.expectedRevision+1)throw new Error('control.revision: applied acknowledgment must advance exactly once');
    await options.unchanged();if(pages.get(page.id)!==page||page.inflight!==id||page.revision>revision)return response({error:'CONTROL_STALE_ACK'},409);entry.receipt={...entry.receipt,status:input.status as ControlReceipt['status'],revision,inspection,...(input.error===undefined?{}:{error:controlString(input.error,'control.error',1024)})};page.inflight=null;
   }
   page.revision=revision;page.inspection=inspection;
   if(input.active===true)options.activity?.();
   if(url.pathname.endsWith('/ack'))return response({acknowledged:true});
   if(input.active!==true&&input.active!==false)throw new Error('control.active: expected boolean');
   if(page.inflight)return response({command:null});
   while(page.queue.length){const id=page.queue.shift()!,entry=entries.get(id);if(!entry||entry.receipt.status!=='queued')continue;
    if(entry.request.expectedRevision!==revision){entry.receipt.status='superseded';entry.receipt.error='CONTROL_STALE_STATE';continue;}
    try{await options.unchanged();}catch(error){entry.receipt.status='rejected';entry.receipt.error='CONTROL_INPUTS_CHANGED';throw error;}
    if(page.inflight||pages.get(page.id)!==page||page.revision!==revision){entry.receipt.status='superseded';entry.receipt.error='CONTROL_STALE_STATE';return response({command:null});}
    page.inflight=id;entry.dispatched=now();entry.receipt.status='dispatched';const command:ControlDelivery={commandId:id,request:entry.request};return response({command});
   }
   return response({command:null});
  }catch(error){const message=error instanceof Error?error.message:String(error);return response({error:message},/inputs changed/i.test(message)?409:errorStatus(message));}
 };
}
