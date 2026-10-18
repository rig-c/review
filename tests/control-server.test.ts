import {afterEach,expect,test} from 'bun:test';
import {createControlServer,readControlBody} from '../src/control-server.ts';
import type {ControlInspection,ControlRequest} from '../src/control.ts';
import {startServer} from '../src/server.ts';
import {loadReview} from '../src/manifest.ts';
import {mkdtemp,cp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openReview,controlReview} from '../src/open.ts';
import {stat} from 'node:fs/promises';
const servers:{stop:(force?:boolean)=>void}[]=[],roots:string[]=[];
afterEach(async()=>{for(const server of servers.splice(0))server.stop(true);for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function state():ControlInspection{return {theme:'system',layout:'auto',effectiveLayout:'row',cameras:{rig:{zoom:1,pan:{x:0,y:0}},reference:{zoom:1,pan:{x:0,y:0}}},animation:'idle',time:0,playing:false,loop:'off',layers:{images:true,meshes:false,bones:false},ready:true,seeking:false,dirty:false,busy:false,feedbackEligible:true,capabilities:{camera:true,referenceCamera:true,animation:true,time:true,playback:true,layers:{images:true,meshes:true,bones:true}}};}
async function fixture(){
 let clock=0,changed=false;const sourceHash='a'.repeat(64),instanceKey='b'.repeat(64),token='agent-private-capability';
 const handle=createControlServer({identity:{token,instanceKey},sourceHash,mode:'single',now:()=>clock,unchanged:async()=>{if(changed)throw new Error('Review inputs changed');}});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req,server){return await handle(req,`http://127.0.0.1:${server.port}`)??new Response('not found',{status:404});}});servers.push(server);const origin=`http://127.0.0.1:${server.port}`;
 const call=(path:string,value?:unknown,bearer?:string,extra:Record<string,string>={})=>fetch(origin+path,{method:value===undefined?'GET':'POST',headers:{...(value===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...extra},...(value===undefined?{}:{body:JSON.stringify(value)})});
 const register=async()=>{const r=await call('/api/control/register',{sourceHash,inspection:state()});expect(r.status).toBe(201);return await r.json() as {pageId:string;pageToken:string;revision:number};};
 const command=(pageId:string,requestId='request',expectedRevision=0):ControlRequest=>({schema:'rig-review-control-command/1',requestId,pageId,instanceKey,sourceHash,expectedRevision,command:{type:'theme',value:'light'}});
 return {origin,handle,call,register,command,sourceHash,instanceKey,token,advance:(n:number)=>{clock+=n;},change:()=>{changed=true;}};
}
test('localhost control requires separate capabilities, exact origin and bounded closed payloads',async()=>{
 const f=await fixture();expect((await f.call('/api/control')).status).toBe(403);expect((await f.call('/api/control',undefined,'wrong')).status).toBe(403);
 const page=await f.register(),request=f.command(page.pageId);
 expect((await f.call('/api/control/commands',request)).status).toBe(403);expect((await f.call('/api/control/commands',request,f.token,{Origin:'https://other.example'})).status).toBe(403);
 expect((await f.call('/api/control/commands',request,page.pageToken)).status).toBe(403);expect((await f.call('/api/control/poll',{pageId:page.pageId,revision:0,inspection:state(),active:false},f.token)).status).toBe(403);
 expect((await f.call('/api/control/commands',{...request,command:{type:'eval',code:'x'}},f.token)).status).toBe(400);expect((await f.call('/api/control/commands',{...request,extra:'x'.repeat(17000)},f.token)).status).toBe(400);
 expect((await f.handle(new Request('http://other.example/api/control/config'),f.origin))?.status).toBe(403);
 const snapshot=await (await f.call('/api/control',undefined,f.token)).json();expect(JSON.stringify(snapshot)).not.toContain(f.token);expect(JSON.stringify(snapshot)).not.toContain(page.pageToken);expect(snapshot.pages).toHaveLength(1);
});
test('queued is not applied: actual acknowledged state and idempotency are separate',async()=>{
 const f=await fixture(),page=await f.register(),request=f.command(page.pageId),queued=await f.call('/api/control/commands',request,f.token);expect(queued.status).toBe(202);const receipt=await queued.json();expect(receipt.status).toBe('queued');expect(receipt.inspection).toBeNull();
 expect((await (await f.call('/api/control/commands',request,f.token)).json()).commandId).toBe(receipt.commandId);expect((await f.call('/api/control/commands',{...request,command:{type:'theme',value:'dark'}},f.token)).status).toBe(409);
 const delivered=await (await f.call('/api/control/poll',{pageId:page.pageId,revision:0,inspection:state(),active:true},page.pageToken)).json();expect(delivered.command.commandId).toBe(receipt.commandId);expect((await (await f.call('/api/control/receipts/'+receipt.commandId,undefined,f.token)).json()).status).toBe('dispatched');
 const applied={...state(),theme:'light'};expect((await f.call('/api/control/ack',{pageId:page.pageId,revision:1,inspection:applied,commandId:receipt.commandId,status:'applied'},page.pageToken)).status).toBe(200);
 const result=await (await f.call('/api/control/receipts/'+receipt.commandId,undefined,f.token)).json();expect(result.status).toBe('applied');expect(result.inspection).toEqual(applied);expect(result.revision).toBe(1);
 expect((await f.call('/api/control/commands',f.command(page.pageId,'old-revision'),f.token)).status).toBe(409);expect((await f.call('/api/control/ack',{pageId:page.pageId,revision:1,inspection:applied,commandId:receipt.commandId,status:'applied'},page.pageToken)).status).toBe(409);
});
test('local gesture supersedes queued state; expired pages, wrong source and changed inputs refuse',async()=>{
 const f=await fixture(),page=await f.register();const receipt=await (await f.call('/api/control/commands',f.command(page.pageId),f.token)).json();
 const next=await (await f.call('/api/control/poll',{pageId:page.pageId,revision:1,inspection:{...state(),dirty:true},active:true},page.pageToken)).json();expect(next.command).toBeNull();expect((await (await f.call('/api/control/receipts/'+receipt.commandId,undefined,f.token)).json()).status).toBe('superseded');
 expect((await f.call('/api/control/commands',{...f.command(page.pageId,'wrong',1),sourceHash:'c'.repeat(64)},f.token)).status).toBe(409);
 f.change();expect((await f.call('/api/control/commands',f.command(page.pageId,'changed',1),f.token)).status).toBe(409);
 const expired=await fixture(),other=await expired.register();expired.advance(30001);expect((await expired.call('/api/control/commands',expired.command(other.pageId),expired.token)).status).toBe(409);
 const dispatched=await fixture(),p=await dispatched.register(),q=await (await dispatched.call('/api/control/commands',dispatched.command(p.pageId),dispatched.token)).json();await dispatched.call('/api/control/poll',{pageId:p.pageId,revision:0,inspection:state(),active:false},p.pageToken);dispatched.advance(30001);expect((await (await dispatched.call('/api/control/receipts/'+q.commandId,undefined,dispatched.token)).json()).status).toBe('outcome-unknown');
});
test('concurrent input hashing cannot enqueue an obsolete revision or duplicate request',async()=>{
 let release:(()=>void)|undefined,entered:(()=>void)|undefined,block=false;const hashBarrier=new Promise<void>(resolve=>{release=resolve;}),hashEntered=new Promise<void>(resolve=>{entered=resolve;}),sourceHash='a'.repeat(64),instanceKey='b'.repeat(64),token='private';
 const handle=createControlServer({identity:{token,instanceKey},sourceHash,mode:'single',unchanged:async()=>{if(block){entered!();await hashBarrier;}}}),origin='http://127.0.0.1:4321';
 const call=(path:string,value:unknown,cap?:string)=>handle(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cap?{Authorization:'Bearer '+cap}:{})},body:JSON.stringify(value)}),origin);
 const page=await (await call('/api/control/register',{sourceHash,inspection:state()}))!.json();
 const command={schema:'rig-review-control-command/1',requestId:'race',pageId:page.pageId,instanceKey,sourceHash,expectedRevision:0,command:{type:'theme',value:'dark'}};
 block=true;const pending=call('/api/control/commands',command,token);await hashEntered;
 await call('/api/control/poll',{pageId:page.pageId,revision:1,inspection:{...state(),theme:'light'},active:true},page.pageToken);
 release!();expect((await pending)!.status).toBe(409);
});
test('opt-in actual single server leaves source/session identity and feedback bytes unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-control-'));roots.push(root);const input=join(root,'input');await cp(join(import.meta.dir,'../examples/demo'),input,{recursive:true});const p=await loadReview(join(input,'review.json')),before=await readFile(join(input,'review.json'));
 const plain=await startServer(p,{port:0,stateDir:join(root,'state')});servers.push(plain);expect((await fetch(`http://127.0.0.1:${plain.port}/api/control/config`)).status).toBe(404);
 const server=await startServer(p,{port:0,stateDir:join(root,'state'),control:{token:'private',instanceKey:'b'.repeat(64)}});servers.push(server);const origin=`http://127.0.0.1:${server.port}`,initial=await (await fetch(origin+'/api/session')).json();
 const page=await (await fetch(origin+'/api/control/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({sourceHash:p.sourceHash,inspection:state()})})).json();
 const request={schema:'rig-review-control-command/1',requestId:'readonly',pageId:page.pageId,instanceKey:'b'.repeat(64),sourceHash:p.sourceHash,expectedRevision:0,command:{type:'theme',value:'dark'}};
 expect((await fetch(origin+'/api/control/commands',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer private'},body:JSON.stringify(request)})).status).toBe(202);
 expect(await (await fetch(origin+'/api/session')).json()).toEqual(initial);expect(initial.status).toBe('pending');expect(await readFile(join(input,'review.json'))).toEqual(before);expect(await readdir(root)).toEqual(['input']);
});
test('bounded body cancels both oversized chunked and stalled requests',async()=>{
 let cancelled=false;const oversized=new Request('http://127.0.0.1/',{method:'POST',headers:{'Content-Type':'application/json'},body:new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(17000));},cancel(){cancelled=true;}})});
 await expect(readControlBody(oversized)).rejects.toThrow('BODY_LIMIT');expect(cancelled).toBe(true);
 let stopped=false;const stalled=new Request('http://127.0.0.1/',{method:'POST',headers:{'Content-Type':'application/json'},body:new ReadableStream<Uint8Array>({cancel(){stopped=true;}})});await expect(readControlBody(stalled,10)).rejects.toThrow('BODY_TIMEOUT');expect(stopped).toBe(true);
});
test('real opted-in worker/CLI discovers an existing page and distinguishes timeout from applied',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-control-cli-'));roots.push(root);const input=join(root,'input'),stateDir=join(root,'state');await cp(join(import.meta.dir,'../examples/demo'),input,{recursive:true});const before=await readFile(join(input,'review.json'));
 const opened=await openReview({input:join(input,'review.json'),control:true},{stateDir,idleMs:10000,direct:true});const origin=new URL(opened.url).origin;
 const file=(await readdir(join(stateDir,'open'))).find(name=>/^[a-f0-9]{64}\.json$/.test(name))!;const record=JSON.parse(await readFile(join(stateDir,'open',file),'utf8'));
 try{
  expect((await stat(join(stateDir,'open',file))).mode&0o077).toBe(0);const queried=await controlReview({input:join(input,'review.json')},{stateDir}) as {pages:unknown[];sourceHash:string};expect(queried.pages).toEqual([]);expect(JSON.stringify(queried)).not.toContain(record.controlToken);
  const headers={Origin:origin,'Content-Type':'application/json','X-Review-Capability':record.capability},page=await (await fetch(origin+'/api/control/register',{method:'POST',headers,body:JSON.stringify({sourceHash:queried.sourceHash,inspection:state()})})).json();
  const args=['src/cli.ts','control',join(input,'review.json'),'--page',page.pageId,'--expected-revision','0','--request-id','actual-cli','--command','{"type":"theme","value":"light"}','--wait-ms','10'];
  const cli=Bun.spawn([process.execPath,...args],{env:{...process.env,RIG_REVIEW_STATE_DIR:stateDir},stdout:'pipe',stderr:'pipe'}),text=await new Response(cli.stdout).text();expect(await cli.exited).toBe(2);const queued=JSON.parse(text);expect(queued.status).toBe('queued');expect(queued.timedOut).toBe(true);
  const pageHeaders={...headers,Authorization:'Bearer '+page.pageToken};const delivered=await (await fetch(origin+'/api/control/poll',{method:'POST',headers:pageHeaders,body:JSON.stringify({pageId:page.pageId,revision:0,inspection:state(),active:false})})).json();expect(delivered.command.commandId).toBe(queued.commandId);
  await fetch(origin+'/api/control/ack',{method:'POST',headers:pageHeaders,body:JSON.stringify({pageId:page.pageId,revision:1,inspection:{...state(),theme:'light'},commandId:queued.commandId,status:'applied'})});
  const retry=Bun.spawn([process.execPath,...args],{env:{...process.env,RIG_REVIEW_STATE_DIR:stateDir},stdout:'pipe',stderr:'pipe'}),result=JSON.parse(await new Response(retry.stdout).text());expect(await retry.exited).toBe(0);expect(result.commandId).toBe(queued.commandId);expect(result.status).toBe('applied');
  expect(await readFile(join(input,'review.json'))).toEqual(before);expect((await (await fetch(origin+'/api/session')).json()).status).toBe('pending');expect((await readdir(stateDir)).sort()).toEqual(['open']);
 }finally{
  const response=await fetch(origin+'/api/open-status',{headers:{Authorization:'Bearer '+record.nonce}});expect((await response.json()).nonce).toBe(record.nonce);process.kill(record.pid,'SIGTERM');let stopped=false;for(let i=0;i<40;i++){try{await fetch(origin+'/api/open-status',{signal:AbortSignal.timeout(100)});}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}expect(stopped).toBe(true);
 }
},30000);
