import {afterEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {loadCompare} from '../src/compare.ts';
import {startServer} from '../src/server.ts';
import {startCompareServer} from '../src/compare-server.ts';
import {openFingerprint,openReview} from '../src/open.ts';
import type {ControlInspection} from '../src/control.ts';
import {INSTANCE_HEADER,startWorkspaceFrontend,type FrontendRegistration,type WorkspaceFrontend} from '../src/workspace-frontend.ts';
import {instanceBase,instanceRoute,instanceMutationHeaders} from '../web/instance-base.ts';
const roots:string[]=[],servers:{stop(force?:boolean):unknown}[]=[],frontends:WorkspaceFrontend[]=[],children:{pid:number;origin:string;nonce:string}[]=[];
afterEach(async()=>{
 for(const f of frontends.splice(0))await f.stop();
 for(const child of children.splice(0)){try{const response=await fetch(child.origin+'/api/open-status',{headers:{Authorization:'Bearer '+child.nonce},signal:AbortSignal.timeout(500)});const status=await response.json();if(status.nonce===child.nonce)process.kill(child.pid,'SIGTERM');}catch{}for(let i=0;i<40;i++){try{await fetch(child.origin+'/api/open-status',{signal:AbortSignal.timeout(50)});await Bun.sleep(25);}catch{break;}}}
 for(const server of servers.splice(0))await server.stop(true);
 for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'review-frontend-'));roots.push(root);const a=join(root,'a'),b=join(root,'b');
 for(const [dir,id,width]of [[a,'first',80],[b,'second',160]] as const){await mkdir(dir);await cp(new URL('./fixtures/strip-probe/build/',import.meta.url),join(dir,'build'),{recursive:true});const model=JSON.parse(await readFile(join(dir,'build/skeleton.model.json'),'utf8'));model.stage.width=width;await writeFile(join(dir,'build/skeleton.model.json'),JSON.stringify(model));await writeFile(join(dir,'review.json'),JSON.stringify({schema:'rig-review/1',id,title:id,revision:'1',model:'build/skeleton.model.json',authoring:[{label:'Streaming bytes',path:'large.bin'}],references:[{id:'video',label:'Byte fixture',type:'video',path:'clip.mp4'}]}));await writeFile(join(dir,'clip.mp4'),id==='first'?'0123456789':'ABCDEFGHIJ');await writeFile(join(dir,'large.bin'),Buffer.alloc(131072,id==='first'?65:66));}
 const state=join(root,'state'),fingerprint=await openFingerprint();
 return {root,a,b,state,fingerprint};
}
async function port(){const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('port probe')});const port=probe.port!;await probe.stop(true);return port;}
async function frontend(fingerprint:string,extra:{now?:()=>number;leaseMs?:number;idleMs?:number}={}){const value=startWorkspaceFrontend({fingerprint,port:await port(),...extra});frontends.push(value);return value;}
async function worker(input:string,stateDir:string,fingerprint:string,label:string){
 const p=await loadReview(input),identity={key:createHash('sha256').update(label+p.sourceHash).digest('hex'),contentHash:p.sourceHash,fingerprint,nonce:randomUUID()},token=randomUUID();
 const server=await startServer(p,{port:0,stateDir,open:identity,control:{token,instanceKey:identity.key}});servers.push(server);
 const registration:FrontendRegistration={origin:'http://127.0.0.1:'+server.port,identity,mode:'single'};
 return {p,identity,token,server,registration};
}
function state():ControlInspection{return {theme:'system',layout:'auto',effectiveLayout:'row',cameras:{rig:{zoom:1,pan:{x:0,y:0}},reference:{zoom:1,pan:{x:0,y:0}}},animation:'inspect',time:0,playing:false,loop:'off',layers:{images:true,meshes:false,bones:false},ready:true,seeking:false,dirty:false,busy:false,feedbackEligible:true,capabilities:{camera:true,referenceCamera:true,animation:true,time:true,playback:true,layers:{images:true,meshes:true,bones:true}}};}
function endpoint(front:WorkspaceFrontend,key:string,path:string){return front.origin+'/instances/'+key+path;}
function mutation(front:WorkspaceFrontend,key:string,body:unknown,extra:Record<string,string>={}){return {method:'POST',headers:{Origin:front.origin,[INSTANCE_HEADER]:key,'Content-Type':'application/json',...extra},body:JSON.stringify(body)};}

test('two actual workers retain API/model/page/range bytes, exact source isolation and one fixed frontend origin',async()=>{
 const f=await fixture(),front=await frontend(f.fingerprint),a=await worker(f.a,f.state,f.fingerprint,'a'),b=await worker(f.b,f.state,f.fingerprint,'b');
 const linkA=await front.register(a.registration),linkB=await front.register(b.registration);expect(new URL(linkA).origin).toBe(front.origin);expect(new URL(linkB).origin).toBe(front.origin);expect(a.p.sourceHash).not.toBe(b.p.sourceHash);
 for(const [link,w,expected]of [[linkA,a,'first'],[linkB,b,'second']] as const){
  const html=await fetch(link);if(html.status!==200)throw new Error(await html.text());expect(html.status).toBe(200);expect(html.headers.get(INSTANCE_HEADER)).toBe(w.identity.key);expect(await html.text()).toContain('rig-root');
  const path=(suffix:string)=>endpoint(front,w.identity.key,suffix);
  const actual=await (await fetch(path('/api/review'))).json();expect(actual.sourceHash).toBe(w.p.sourceHash);expect(actual.manifest.id).toBe(expected);expect(actual.reviewedSource).toEqual(w.p.reviewedSource);
  for(const asset of ['skeleton.model.json','mesh.png','rigid.png']){const direct=await fetch(w.registration.origin+'/assets/build/'+asset),routed=await fetch(path('/assets/build/'+asset));expect(routed.status).toBe(200);expect(new Uint8Array(await routed.arrayBuffer())).toEqual(new Uint8Array(await direct.arrayBuffer()));expect(routed.headers.get('content-type')).toBe(direct.headers.get('content-type'));expect(routed.headers.get('content-security-policy')).toContain('sandbox');expect(routed.headers.get('set-cookie')).toBeNull();}
  const range=await fetch(path('/assets/clip.mp4'),{headers:{Range:'bytes=2-5'}});expect(range.status).toBe(206);expect(await range.text()).toBe(expected==='first'?'2345':'CDEF');expect(range.headers.get('content-range')).toBe('bytes 2-5/10');expect(range.headers.get('content-length')).toBe('4');expect((await fetch(path('/assets/clip.mp4'),{headers:{Range:'bytes=99-100'}})).status).toBe(416);
  const head=await fetch(path('/assets/clip.mp4'),{method:'HEAD',headers:{Range:'bytes=1-2'}});expect(head.status).toBe(206);expect(await head.text()).toBe('');expect(head.headers.get('content-length')).toBe('2');
  const large=await fetch(path('/assets/large.bin'));expect(new Uint8Array(await large.arrayBuffer())).toEqual(new Uint8Array(await readFile(join(w.p.root,'large.bin'))));const largeRange=await fetch(path('/assets/large.bin'),{headers:{Range:'bytes=65535-131071'}});expect(largeRange.status).toBe(206);expect(largeRange.headers.get('content-range')).toBe('bytes 65535-131071/131072');expect(new Uint8Array(await largeRange.arrayBuffer())).toEqual(new Uint8Array(await readFile(join(w.p.root,'large.bin'))).subarray(65535));
  expect((await fetch(path('/main.js'))).status).toBe(200);expect((await fetch(path('/styles.css'))).status).toBe(200);expect((await fetch(path('/assets/not-declared'))).status).toBe(404);
 }
 const sessionA=await (await fetch(endpoint(front,a.identity.key,'/api/session'))).json(),sessionB=await (await fetch(endpoint(front,b.identity.key,'/api/session'))).json();
 const save=async(key:string,body:unknown,headers:Record<string,string>={})=>fetch(endpoint(front,key,'/api/session'),{...mutation(front,key,body,headers),method:'PUT'});
 expect((await save(b.identity.key,{...sessionA,status:'approved'})).status).toBe(400);expect((await save(a.identity.key,{...sessionB,status:'approved'})).status).toBe(400);
 expect((await save(b.identity.key,{...sessionB,status:'approved'},{[INSTANCE_HEADER]:a.identity.key})).status).toBe(403);
 expect((await save(a.identity.key,{...sessionA,status:'changes-requested'})).status).toBe(200);
 expect((await (await fetch(endpoint(front,b.identity.key,'/api/session'))).json()).status).toBe('pending');
 expect((await fetch(b.registration.origin+'/api/session')).status).toBe(200); // Direct workers remain available.
 // A distinct reopened underlying worker C retains the same frontend origin.
 const c=await worker(f.a,f.state,f.fingerprint,'c'),linkC=await front.register(c.registration);expect(new URL(linkC).origin).toBe(front.origin);expect((await (await fetch(endpoint(front,c.identity.key,'/api/review'))).json()).sourceHash).toBe(a.p.sourceHash);
 await a.server.stop(true);const restarted=await worker(f.a,f.state,f.fingerprint,'a'),restartedLink=await front.register(restarted.registration);expect(restarted.identity.key).toBe(a.identity.key);expect(restarted.identity.nonce).not.toBe(a.identity.nonce);expect(restartedLink).toBe(linkA);expect((await (await fetch(endpoint(front,restarted.identity.key,'/api/review'))).json()).sourceHash).toBe(a.p.sourceHash);
});

test('page/source/agent capabilities stay worker scoped after Origin translation; receipts expose no capability',async()=>{
 const f=await fixture(),front=await frontend(f.fingerprint),a=await worker(f.a,f.state,f.fingerprint,'a'),b=await worker(f.b,f.state,f.fingerprint,'b');await front.register(a.registration);await front.register(b.registration);
 const call=(w:typeof a,path:string,body?:unknown,token?:string)=>fetch(endpoint(front,w.identity.key,path),body===undefined?{headers:token?{Authorization:'Bearer '+token}:{}}:mutation(front,w.identity.key,body,token?{Authorization:'Bearer '+token}:{}));
 expect((await call(a,'/api/control')).status).toBe(403);expect((await call(a,'/api/control',undefined,b.token)).status).toBe(403);expect((await call(a,'/api/control/register')).status).toBe(404);
 const pageA=await (await call(a,'/api/control/register',{sourceHash:a.p.sourceHash,inspection:state()})).json(),pageB=await (await call(b,'/api/control/register',{sourceHash:b.p.sourceHash,inspection:state()})).json();expect(pageA.pageToken).toBeString();expect(pageB.pageId).not.toBe(pageA.pageId);
 expect((await call(b,'/api/control/register',{sourceHash:a.p.sourceHash,inspection:state()})).status).toBe(409);
 expect((await call(b,'/api/control/poll',{pageId:pageA.pageId,revision:0,inspection:state(),active:false},pageA.pageToken)).status).toBe(403);
 const command={schema:'rig-review-control-command/1',requestId:'one',instanceKey:a.identity.key,sourceHash:a.p.sourceHash,pageId:pageA.pageId,expectedRevision:0,command:{type:'theme',value:'light'}};
 expect((await call(b,'/api/control/commands',command,a.token)).status).toBe(403);expect((await call(b,'/api/control/commands',command,b.token)).status).toBe(409);
 const queued=await call(a,'/api/control/commands',command,a.token);expect(queued.status).toBe(202);const receipt=await queued.json();expect(receipt.status).toBe('queued');
 expect((await call(b,'/api/control/receipts/'+receipt.commandId,undefined,b.token)).status).toBe(404);expect((await call(a,'/api/control/receipts/'+receipt.commandId)).status).toBe(403);
 const poll=await (await call(a,'/api/control/poll',{pageId:pageA.pageId,revision:0,inspection:state(),active:false},pageA.pageToken)).json();expect(poll.command.commandId).toBe(receipt.commandId);
 expect((await call(a,'/api/control/ack',{pageId:pageA.pageId,revision:1,inspection:{...state(),theme:'light'},commandId:receipt.commandId,status:'applied'},pageA.pageToken)).status).toBe(200);
 const final=await (await call(a,'/api/control/receipts/'+receipt.commandId,undefined,a.token)).json();expect(final.status).toBe('applied');expect(final.inspection.theme).toBe('light');
 const bState=await (await call(b,'/api/control',undefined,b.token)).json();expect(bState.pages[0].inspection.theme).toBe('system');expect(JSON.stringify(bState)).not.toContain(b.token);expect(JSON.stringify(bState)).not.toContain(pageB.pageToken);
});

test('fixed routes refuse malformed hosts, origins, traversal, queries, overlimit bodies and stale workers',async()=>{
 const f=await fixture();let clock=0;const front=await frontend(f.fingerprint,{now:()=>clock,leaseMs:10000}),a=await worker(f.a,f.state,f.fingerprint,'a');const link=await front.register(a.registration),base=endpoint(front,a.identity.key,'');
 expect((await fetch(link,{headers:{Host:'evil.invalid'}})).status).toBe(403);
 expect((await fetch(base+'/api/review',{headers:{Origin:'http://localhost:'+front.port}})).status).toBe(403);
 expect((await fetch(base+'/api/review',{headers:{'Sec-Fetch-Site':'cross-site'}})).status).toBe(403);
 expect((await fetch(front.origin+'/instances/'+('f'.repeat(64))+'/api/review')).status).toBe(404);
 expect((await fetch(base+'/api/review?url=http://evil.invalid')).status).toBe(400);
 expect((await fetch(base+'/api/open-status')).status).toBe(404);
 expect((await fetch(base+'/assets/%2fetc/passwd')).status).toBe(400);
 expect((await fetch(base+'/assets/..%5csecret')).status).toBe(400);
 expect((await fetch(base+'/assets/http:secret')).status).toBe(400);
 expect((await fetch(base+'/api/register',mutation(front,a.identity.key,{url:'http://evil.invalid'}))).status).toBe(404);
 const linkWrong=new URL(link);linkWrong.searchParams.set('input','f'.repeat(64));expect((await fetch(linkWrong)).status).toBe(409);
 expect((await fetch(base+'/api/session',{...mutation(front,a.identity.key,{}),method:'PUT',headers:{'Content-Type':'application/json',[INSTANCE_HEADER]:a.identity.key}})).status).toBe(403);
 expect((await fetch(base+'/api/session',{...mutation(front,a.identity.key,{}),method:'PUT',headers:{Origin:front.origin,'Content-Type':'text/plain',[INSTANCE_HEADER]:a.identity.key}})).status).toBe(400);
 expect((await fetch(base+'/api/control/register',mutation(front,a.identity.key,{padding:'x'.repeat(16385)}))).status).toBe(400);
 const huge=await fetch(base+'/api/session',{...mutation(front,a.identity.key,{padding:'x'.repeat(1024*1024)}),method:'PUT'});expect(huge.status).toBe(400);
 await expect(front.register({...a.registration,identity:{...a.identity,fingerprint:'f'.repeat(64)}})).rejects.toThrow('FRONTEND_REGISTRATION_INVALID');
 await expect(front.register({...a.registration,identity:{...a.identity,key:'e'.repeat(64),nonce:randomUUID()}})).rejects.toThrow('FRONTEND_WORKER_UNVERIFIED');
 await expect(front.register({...a.registration,origin:'https://127.0.0.1:4317'})).rejects.toThrow('FRONTEND_REGISTRATION_INVALID');
 clock=10001;expect((await fetch(base+'/api/review')).status).toBe(409);await front.register(a.registration);await writeFile(join(f.a,'clip.mp4'),'CHANGED');expect((await fetch(base+'/api/review')).status).toBe(409);expect((await fetch(base+'/api/review')).status).toBe(404);
});

test('a revoked registration cannot finish a delayed mutation, and a conflicting occupied port is never replaced',async()=>{
 const f=await fixture(),front=await frontend(f.fingerprint),a=await worker(f.a,f.state,f.fingerprint,'a');await front.register(a.registration);
 const saved=await (await fetch(endpoint(front,a.identity.key,'/api/session'))).json();let continueBody:()=>void=()=>{},entered:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{continueBody=resolve;});
 const stream=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(new TextEncoder().encode('{'));entered();await release;controller.enqueue(new TextEncoder().encode(JSON.stringify({...saved,status:'approved'}).slice(1)));controller.close();}});
 const request=fetch(endpoint(front,a.identity.key,'/api/session'),{method:'PUT',headers:{Origin:front.origin,[INSTANCE_HEADER]:a.identity.key,'Content-Type':'application/json'},body:stream});await waiting;await Bun.sleep(30);front.revoke(a.identity.key);continueBody();expect((await request).status).toBe(409);expect((await (await fetch(a.registration.origin+'/api/session')).json()).status).toBe('pending');
 expect(()=>startWorkspaceFrontend({fingerprint:f.fingerprint,port:front.port})).toThrow('FRONTEND_PORT_CONFLICT');expect((await fetch(front.origin+'/nothing')).status).toBe(404);
});

test('compare worker retains side-specific assets, video ranges, shared binding and direct routing',async()=>{
 const f=await fixture(),front=await frontend(f.fingerprint),reference=join(f.a,'clip.mp4'),p=await loadCompare({a:f.a,b:f.b,reference,animation:'inspect'}),identity={key:createHash('sha256').update('compare'+p.response.sourceHash).digest('hex'),contentHash:p.response.sourceHash,fingerprint:f.fingerprint,nonce:randomUUID()};
 const server=await startCompareServer(p,{port:0,stateDir:f.state,open:identity});servers.push(server);const origin='http://127.0.0.1:'+server.port,link=await front.register({origin,identity,mode:'compare'});expect((await fetch(link)).status).toBe(200);
 const base=endpoint(front,identity.key,'');expect((await (await fetch(base+'/api/compare')).json()).binding).toEqual(p.response.binding);
 for(const side of ['a','b']){const path='/compare-assets/'+side+'/build/skeleton.model.json';expect(new Uint8Array(await (await fetch(base+path)).arrayBuffer())).toEqual(new Uint8Array(await (await fetch(origin+path)).arrayBuffer()));}
 const range=await fetch(base+'/compare-reference',{headers:{Range:'bytes=3-6'}});expect(range.status).toBe(206);expect(await range.text()).toBe('3456');expect(range.headers.get('content-range')).toBe('bytes 3-6/10');
 const session=await (await fetch(base+'/api/compare/session')).json();expect((await fetch(base+'/api/compare/session',{...mutation(front,identity.key,{...session,status:'approved'}),method:'PUT'})).status).toBe(200);expect((await (await fetch(origin+'/api/compare/session')).json()).status).toBe('approved');expect((await fetch(base+'/api/review')).status).toBe(404);
});

test('openReview explicit frontend option registers its real managed worker while explicit direct handoff stays available',async()=>{
 const f=await fixture(),front=await frontend(f.fingerprint),opened=await openReview({input:f.a,animation:'inspect'},{stateDir:f.state,frontend:front,idleMs:30000});
 for(const name of await readdir(join(f.state,'open')))if(name.endsWith('.json')){const row=JSON.parse(await readFile(join(f.state,'open',name),'utf8'));if(row.schema==='rig-review-open-instance/1')children.push(row);}
 expect(new URL(opened.url).origin).toBe(front.origin);expect(opened.directUrl).toBeString();expect((await fetch(opened.url)).status).toBe(200);
 const direct=await openReview({input:f.a,animation:'inspect'},{stateDir:f.state,direct:true});expect(direct.url).toBe(opened.directUrl!);expect(direct.reused).toBe(true);expect(direct.directUrl).toBeUndefined();expect((await fetch(direct.url)).status).toBe(200);
},30000);

test('instance helper prefixes only fixed local routes, attaches a binding assertion and preserves direct workers',()=>{
 const href='http://127.0.0.1:4318/instances/'+('a'.repeat(64))+'/?input='+('b'.repeat(64)),base='/instances/'+('a'.repeat(64))+'/';expect(instanceBase(href)).toBe(base);expect(instanceRoute('/api/review',href)).toBe(base+'api/review');expect(instanceMutationHeaders(href)).toEqual({[INSTANCE_HEADER]:'a'.repeat(64)});
 expect(instanceRoute('/assets/build/mesh.png','http://127.0.0.1:4317/')).toBe('/assets/build/mesh.png');expect(instanceMutationHeaders('http://127.0.0.1:4317/')).toEqual({});
 for(const bad of ['https://evil.invalid/','//evil.invalid','/assets/../api/session','/assets/%2e%2e/a','/assets/a%2fb','/assets/a%5cb','/api/session?url=http://evil.invalid','/instances/'+('c'.repeat(64))+'/api/review'])expect(()=>instanceRoute(bad,href)).toThrow('FRONTEND_ROUTE_INVALID');
 expect(()=>instanceBase('http://127.0.0.1:4318/instances/not-a-key/')).toThrow('FRONTEND_INSTANCE_PATH_INVALID');
});

test('frontend idle lifecycle releases only its owned listener, can reopen the same origin, and never follows worker redirects',async()=>{
 const f=await fixture();let clock=0;const front=await frontend(f.fingerprint,{now:()=>clock,idleMs:100,leaseMs:1000}),a=await worker(f.a,f.state,f.fingerprint,'a');await front.register(a.registration);const originalOrigin=front.origin;
 clock=101;await Bun.sleep(125);await expect(fetch(front.origin+'/instances/'+a.identity.key+'/api/review',{signal:AbortSignal.timeout(300)})).rejects.toThrow();expect((await fetch(a.registration.origin+'/api/session')).status).toBe(200);
 const reopened=startWorkspaceFrontend({fingerprint:f.fingerprint,port:front.port});frontends.push(reopened);expect(reopened.origin).toBe(originalOrigin);const link=await reopened.register(a.registration);expect((await fetch(link)).status).toBe(200);
 let targetHits=0;const target=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){targetHits++;return new Response('must not follow');}});servers.push(target);
 const identity={...a.identity,key:'e'.repeat(64),nonce:randomUUID()};let forwarded:Headers|null=null;
 const redirector=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const path=new URL(req.url).pathname;if(path==='/api/open-status')return Response.json({schema:'rig-review-open-status/1',...identity});forwarded=req.headers;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1:'+target.port+'/outside','Set-Cookie':'secret=must-not-propagate'}});}});servers.push(redirector);
 const bad=await reopened.register({origin:'http://127.0.0.1:'+redirector.port,identity,mode:'single'});
 const result=await fetch(bad,{headers:{Cookie:'workspace-preference=private','X-Client-Destination':'http://evil.invalid'}});expect(result.status).toBe(400);expect(targetHits).toBe(0);expect(result.headers.get('set-cookie')).toBeNull();expect(result.headers.get('location')).toBeNull();expect(forwarded).not.toBeNull();const received=forwarded as Headers|null;expect(received?.get('cookie')).toBeNull();expect(received?.get('x-client-destination')).toBeNull();
 await expect(reopened.register({...a.registration,origin:'http://127.0.0.1:'+redirector.port})).rejects.toThrow('FRONTEND_INSTANCE_CONFLICT');
});
