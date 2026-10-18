import {instanceFetch} from './instance-base.ts';
import {parseControlCommand,parseControlInspection,preflightControl,type ControlCommand,type ControlDelivery,type ControlInspection,type ControlMode} from '../src/control.ts';
interface Adapter {sourceHash:string;mode:ControlMode;observe:()=>ControlInspection;apply:(command:ControlCommand,signal:AbortSignal)=>Promise<void>;onStatus?:(value:string)=>void}
/** Ongoing drags are local changes too; pointer hover is not a revision. */
export class ControlLocalRevision {
 revision=0;private pointers=new Set<number>();
 constructor(private changed:()=>void){}
 interaction(type:string,pointerId?:number):void{
  let change=false;
  if(type==='pointerdown'&&pointerId!==undefined){this.pointers.add(pointerId);change=true;}
  else if(type==='pointermove'&&pointerId!==undefined)change=this.pointers.has(pointerId);
  else if(['pointerup','pointercancel','lostpointercapture'].includes(type)&&pointerId!==undefined)change=this.pointers.delete(pointerId);
  else if(type==='blur'){change=this.pointers.size>0;this.pointers.clear();}
  else change=['wheel','keydown','input','change','hashchange','popstate'].includes(type);
  if(change){this.revision++;this.changed();}
 }
 applied():void{this.revision++;}
}
/** One current page; no DOM scripting, review writes or package replacement. */
export function connectControl(adapter:Adapter):()=>void{
 let closed=false,pageId='',token='',timer:ReturnType<typeof setTimeout>|undefined,inflight:AbortController|null=null,lastUser=Date.now();
 const local=new ControlLocalRevision(()=>{lastUser=Date.now();inflight?.abort(new Error('CONTROL_SUPERSEDED: local interaction'));});
 const status=(text:string)=>adapter.onStatus?.(text);
 const observe=()=>parseControlInspection(adapter.observe());
 async function call<T>(path:string,value?:unknown):Promise<T>{
  const response=await instanceFetch(path,{method:value===undefined?'GET':'POST',headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(5000)});
  const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'CONTROL_REQUEST_FAILED');return result as T;
 }
 function interaction(event:Event){if(!event.isTrusted)return;local.interaction(event.type,'pointerId' in event?(event as PointerEvent).pointerId:undefined);}
 const events=['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','blur','wheel','keydown','input','change','hashchange','popstate'] as const;
 for(const event of events)window.addEventListener(event,interaction,{capture:true,passive:true});
 async function apply(delivery:ControlDelivery){
  const startRevision=local.revision,abort=new AbortController();inflight=abort;let outcome:'applied'|'rejected'|'failed'|'superseded'='rejected',error:string|undefined;
  try{
   const request=delivery.request;if(request.sourceHash!==adapter.sourceHash||request.pageId!==pageId||request.expectedRevision!==local.revision)throw new Error('CONTROL_STALE_STATE');
   const command=parseControlCommand(request.command);preflightControl(command,observe(),adapter.mode);
   status('Remote inspection command applying');outcome='failed';await adapter.apply(command,abort.signal);
   if(abort.signal.aborted||local.revision!==startRevision){outcome='superseded';throw new Error('CONTROL_SUPERSEDED: local interaction');}
   observe();local.applied();outcome='applied';
  }catch(reason){error=(reason instanceof Error?reason.message:String(reason)).slice(0,1024);if(abort.signal.aborted||local.revision!==startRevision)outcome='superseded';else if(outcome!=='rejected')outcome='failed';}
  finally{inflight=null;}
  // A failed ack is deliberately not retried as another apply. Outcome is unknown
  // to the agent until it obtains current state or the original receipt.
  await call('/api/control/ack',{pageId,commandId:delivery.commandId,status:outcome,...(error?{error}:{}),revision:local.revision,inspection:observe()});
  status(outcome==='applied'?'Remote inspection command applied':error??'Remote inspection command refused');
 }
 async function poll(){
  if(closed)return;
  try{
   const state=observe();const result=await call<{command:ControlDelivery|null}>('/api/control/poll',{pageId,revision:local.revision,inspection:state,active:Date.now()-lastUser<60000||state.playing});
   if(result.command)await apply(result.command);
  }catch(error){status(error instanceof Error?error.message:'Remote control unavailable');closed=true;}
  if(!closed)timer=setTimeout(()=>{void poll();},document.hidden?1000:250);
 }
 void (async()=>{
  try{
   const response=await instanceFetch('/api/control/config',{signal:AbortSignal.timeout(5000)});if(response.status===404){closed=true;return;}if(!response.ok)throw new Error('CONTROL_UNAVAILABLE');
   const config=await response.json();if(!config.enabled){closed=true;return;}if(config.sourceHash!==adapter.sourceHash||config.mode!==adapter.mode)throw new Error('CONTROL_STALE_BINDING');
   const page=await call<{pageId:string;pageToken:string;revision:number}>('/api/control/register',{sourceHash:adapter.sourceHash,inspection:observe()});
   pageId=page.pageId;token=page.pageToken;
   if(closed){void call('/api/control/close',{pageId}).catch(()=>{});return;}
   status('Remote inspection enabled · page '+pageId);void poll();
  }catch(error){closed=true;status(error instanceof Error?error.message:'Remote control unavailable');}
 })();
 return ()=>{closed=true;if(timer)clearTimeout(timer);inflight?.abort();for(const event of events)window.removeEventListener(event,interaction,true);if(pageId)void instanceFetch('/api/control/close',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({pageId}),keepalive:true}).catch(()=>{});};
}
