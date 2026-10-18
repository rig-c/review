import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {connect} from 'node:net';
import {openReview} from '../src/open.ts';
import {instanceAccess,readOnlyReason} from '../web/instance-access.ts';
const roots:string[]=[],owned:{pid:number;origin:string;nonce:string;status:string}[]=[];
// Stop only processes whose private nonce still answers, then prove they are gone.
afterEach(async()=>{for(const row of owned.splice(0)){try{const r=await fetch(row.origin+row.status,{headers:{authorization:`Bearer ${row.nonce}`},signal:AbortSignal.timeout(500)});if((await r.json()).nonce===row.nonce)process.kill(row.pid,'SIGTERM');}catch{}let stopped=false;for(let n=0;n<80;n++){try{const r=await fetch(row.origin+row.status,{headers:{authorization:`Bearer ${row.nonce}`},signal:AbortSignal.timeout(100)});if((await r.json()).nonce!==row.nonce){stopped=true;break;}}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}expect(stopped).toBe(true);}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-front-')));roots.push(root);const producer=join(root,'producer');await mkdir(producer);await cp(join(import.meta.dir,'fixtures/strip-probe/build'),join(producer,'build'),{recursive:true});await cp(join(import.meta.dir,'fixtures/strip-probe/motion.json'),join(producer,'motion.json'));await writeFile(join(producer,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.500003,.999997]}));const reference=join(root,'original.mov');await cp(join(import.meta.dir,'fixtures/strip-probe/reference.mov'),reference);return {root,producer,reference,state:join(root,'state')};}
async function track(state:string){for(const name of await readdir(join(state,'open'))){const front=/^front-\d+\.json$/.test(name);if(!front&&!/^[a-f0-9]{64}\.json$/.test(name))continue;const data=JSON.parse(await readFile(join(state,'open',name),'utf8'));if(!owned.some(row=>row.nonce===data.nonce))owned.push({pid:data.pid,origin:data.origin,nonce:data.nonce,status:front?'/api/front-status':'/api/open-status'});}}
async function record(state:string,url:string){const key=new URL(url).pathname.split('/')[2]||new URL(url).searchParams.get('handoff');return JSON.parse(await readFile(join(state,'open',key+'.json'),'utf8'));}
function freePort(){const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=server.port!;server.stop(true);return port;}
function rawHost(port:number,host:string,path:string):Promise<string>{return new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1');let out='';socket.on('data',chunk=>{out+=chunk;});socket.on('end',()=>resolve(out));socket.on('error',reject);socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);});}
const cap=(url:string)=>new URL(url).hash.slice(5);
async function cli(args:string[],state:string,env:Record<string,string>={}){const child=Bun.spawn([process.execPath,'src/cli.ts',...args],{env:{...process.env,RIG_REVIEW_STATE_DIR:state,...env},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit};}

test('managed front routes by key, refuses unlisted/oversized/foreign-host requests and never serves a capability',async()=>{
 const f=await fixture(),other=join(f.root,'other');await cp(f.producer,other,{recursive:true});await writeFile(join(other,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.5,1]}));const port=freePort();
 const a=await openReview({input:f.producer,reference:f.reference},{stateDir:f.state,frontPort:port}),b=await openReview({input:other,control:true},{stateDir:f.state,frontPort:port});await track(f.state);
 const front=`http://127.0.0.1:${port}`,aBase=front+new URL(a.url).pathname,bBase=front+new URL(b.url).pathname,ra=await record(f.state,a.url),rb=await record(f.state,b.url);
 expect(new URL(a.url).origin).toBe(front);expect(new URL(a.url).pathname).toBe(`/instances/${ra.key}/`);expect(a.direct).toBe(false);expect(cap(a.url)).toBe(ra.capability);expect(cap(b.url)).toBe(rb.capability);expect(ra.capability).not.toBe(rb.capability);
 const again=await openReview({input:f.producer,reference:f.reference},{stateDir:f.state,frontPort:port});expect(again.url).toBe(a.url);expect(again.reused).toBe(true);expect((await readdir(join(f.state,'open'))).filter(n=>/^front-\d+\.json$/.test(n))).toEqual([`front-${port}.json`]);
 const landing=await fetch(a.url);expect(landing.status).toBe(200);expect(await landing.text()).toContain('src="main.js"');expect((await fetch(aBase)).status).toBe(409);
 const reviewA=await (await fetch(aBase+'api/review')).json(),reviewB=await (await fetch(bBase+'api/review')).json();expect(reviewA.sourceHash).toBe(ra.contentHash);expect(reviewB.sourceHash).toBe(rb.contentHash);expect(reviewA.sourceHash).not.toBe(reviewB.sourceHash);
 const asset=await fetch(aBase+'assets/build/skeleton.model.json');expect(asset.status).toBe(200);expect(asset.headers.get('content-security-policy')).toContain('sandbox');expect(asset.headers.get('x-review-open-key')).toBeNull();
 const range=await fetch(aBase+'review-reference',{headers:{Range:'bytes=0-9'}});expect(range.status).toBe(206);expect(range.headers.get('content-range')).toMatch(/^bytes 0-9\//);expect((await range.arrayBuffer()).byteLength).toBe(10);
 const refused=async(response:Response|Promise<Response>,status:number,code:string)=>{const r=await response;expect(r.status).toBe(status);expect((await r.json()).error).toStartWith(code);};
 await refused(fetch(front+'/'),404,'FRONT_ROUTE_REFUSED');await refused(fetch(front+'/instances/'+'0'.repeat(64)+'/api/review'),404,'FRONT_INSTANCE_UNKNOWN');
 for(const path of ['api/open-status','api/control','api/control/receipts/'+crypto.randomUUID(),'api/compare','compare-assets/a/build/skeleton.model.json','assets'])await refused(fetch(bBase+path),404,'FRONT_ROUTE_REFUSED');
 await refused(fetch(bBase+'api/control/commands',{method:'POST',headers:{Origin:front,'Content-Type':'application/json','X-Review-Capability':rb.capability},body:'{}'}),404,'FRONT_ROUTE_REFUSED');
 await refused(fetch(aBase+'api/review?debug=1'),400,'FRONT_QUERY_REFUSED');
 for(const host of ['localhost:'+port,'evil.test',`127.0.0.1:${port+1}`]){const response=await rawHost(port,host,new URL(a.url).pathname+'api/review');expect(response).toStartWith('HTTP/1.1 403');expect(response).toContain('FRONT_LOOPBACK_REQUIRED');}
 const session=await (await fetch(bBase+'api/session')).json(),json={Origin:front,'Content-Type':'application/json','X-Review-Capability':rb.capability};
 await refused(fetch(bBase+'api/session',{method:'PUT',headers:json,body:JSON.stringify({padding:'x'.repeat(1024*1024)})}),413,'FRONT_BODY_LIMIT');
 await refused(fetch(bBase+'api/control/register',{method:'POST',headers:json,body:JSON.stringify({padding:'x'.repeat(17000)})}),413,'FRONT_BODY_LIMIT');
 // Worker validation text stays behind the front; only a named code is returned.
 const invalid=await fetch(bBase+'api/session',{method:'PUT',headers:json,body:JSON.stringify({...session,reviewedSource:{forged:true}})});expect(invalid.status).toBe(400);expect(await invalid.json()).toEqual({error:'FRONT_UPSTREAM_REJECTED'});
 // Scan every allowlisted read for both instances' capabilities and control token.
 const secrets=[ra.capability,rb.capability,rb.controlToken];expect(rb.controlToken).toMatch(/^[a-f0-9-]{36}$/);
 const landingQuery=(url:string)=>new URL(url).search;
 for(const [base,url,extra] of [[aBase,a.url,['review-reference']],[bBase,b.url,['api/control/config']]] as const)for(const path of ['',`index.html`,'main.js','styles.css','api/access','api/review','api/session','assets/build/skeleton.model.json',...extra]){
  const target=base+path+(path===''||path==='index.html'?landingQuery(url):''),response=await fetch(target);expect(response.status).toBe(200);const text=await response.text();for(const secret of secrets)expect(text.includes(secret)).toBe(false);for(const value of response.headers.values())for(const secret of secrets)expect(value.includes(secret)).toBe(false);
 }
 // The worker's own identity is re-verified per request: a replaced record nonce is refused by name.
 const fileA=join(f.state,'open',ra.key+'.json'),savedA=await readFile(fileA,'utf8');await writeFile(fileA,JSON.stringify({...ra,nonce:crypto.randomUUID()}),{mode:0o600});await refused(fetch(aBase+'api/review'),410,'FRONT_INSTANCE_REPLACED');await writeFile(fileA,savedA,{mode:0o600});expect((await fetch(aBase+'api/review')).status).toBe(200);
 const fileB=join(f.state,'open',rb.key+'.json'),savedB=await readFile(fileB,'utf8');process.kill(rb.pid,'SIGTERM');for(let n=0;n<80;n++){try{await fetch(rb.origin+'/api/access',{signal:AbortSignal.timeout(100)});}catch{break;}await new Promise(r=>setTimeout(r,25));}
 await writeFile(fileB,savedB,{mode:0o600});await refused(fetch(bBase+'api/review'),410,'FRONT_INSTANCE_EXPIRED');await rm(fileB);await refused(fetch(bBase+'api/review'),404,'FRONT_INSTANCE_UNKNOWN');
},60000);

test('page A holding instance B key cannot mutate B; only B capability can, and a fragment-less copied link is read-only',async()=>{
 const f=await fixture(),other=join(f.root,'other');await cp(f.producer,other,{recursive:true});await writeFile(join(other,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.5,1]}));const port=freePort();
 const a=await openReview({input:f.producer},{stateDir:f.state,frontPort:port}),b=await openReview({input:other,control:true},{stateDir:f.state,frontPort:port});await track(f.state);
 const front=`http://127.0.0.1:${port}`,bBase=front+new URL(b.url).pathname,ra=await record(f.state,a.url),rb=await record(f.state,b.url),session=await (await fetch(bBase+'api/session')).json();
 const page={sourceHash:rb.contentHash,inspection:{}},mutations:[string,string,unknown][]=[['PUT','api/session',{...session,status:'approved'}],['POST','api/strip',{format:'json',sourceHash:rb.contentHash,animation:'inspect',intervals:[]}],['POST','api/control/register',page],['POST','api/control/poll',{pageId:'x'}],['POST','api/control/ack',{pageId:'x'}],['POST','api/control/close',{pageId:'x'}]];
 for(const [method,path,body] of mutations)for(const capability of [ra.capability,null,'0'.repeat(64)]){
  const response=await fetch(bBase+path,{method,headers:{Origin:front,'Content-Type':'application/json',...(capability?{'X-Review-Capability':capability}:{})},body:JSON.stringify(body)});expect(response.status).toBe(403);expect((await response.json()).error).toStartWith('FRONT_CAPABILITY_REQUIRED');
 }
 // The worker enforces the same capability itself, before its Origin check, even when reached directly.
 for(const capability of [ra.capability,null]){const direct=await fetch(rb.origin+'/api/session',{method:'PUT',headers:{Origin:rb.origin,'Content-Type':'application/json',...(capability?{'X-Review-Capability':capability}:{})},body:JSON.stringify({...session,status:'approved'})});expect(direct.status).toBe(403);expect((await direct.json()).error).toStartWith('REVIEW_CAPABILITY_REQUIRED');}
 for(const origin of [null,'http://evil.test','null']){const response=await fetch(bBase+'api/session',{method:'PUT',headers:{...(origin?{Origin:origin}:{}),'Content-Type':'application/json','X-Review-Capability':rb.capability},body:JSON.stringify(session)});expect(response.status).toBe(403);}
 expect((await (await fetch(bBase+'api/session')).json()).status).toBe('pending');
 const own={Origin:front,'Content-Type':'application/json','X-Review-Capability':rb.capability};
 expect((await fetch(bBase+'api/session',{method:'PUT',headers:own,body:JSON.stringify({...session,status:'approved'})})).status).toBe(200);expect((await (await fetch(bBase+'api/session')).json()).status).toBe('approved');
 const registered=await fetch(bBase+'api/control/register',{method:'POST',headers:own,body:JSON.stringify({sourceHash:rb.contentHash,inspection:{theme:'system',layout:'auto',effectiveLayout:'row',cameras:{rig:{zoom:1,pan:{x:0,y:0}},reference:{zoom:1,pan:{x:0,y:0}}},animation:'inspect',time:0,playing:false,loop:'off',layers:{images:true,meshes:false,bones:false},ready:true,seeking:false,dirty:false,busy:false,feedbackEligible:true,capabilities:{camera:true,referenceCamera:true,animation:true,time:true,playback:true,layers:{images:true,meshes:true,bones:true}}}})});expect(registered.status).toBe(201);
 // A copied view link without the fragment: the page finds no capability and the server requires one.
 const copied=new URL(b.url);copied.hash='';const storage=new Map<string,string>(),store={getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v);}};
 const access=await (await fetch(bBase+'api/access')).json();expect(access).toEqual({schema:'rig-review-access/1',capabilityRequired:true});
 const view=instanceAccess(copied.href,store,()=>{throw new Error('no fragment to strip');});expect(view.capability).toBeNull();expect(readOnlyReason(view,access.capabilityRequired)).toBe('Read-only view: reopen with rig-review open to edit.');
 expect((await fetch(copied)).status).toBe(200);
},60000);

test('a busy front port fails by name with the way out, and --direct keeps the per-port worker',async()=>{
 const f=await fixture(),holder=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({unrelated:true})});
 try{
  await expect(openReview({input:f.producer},{stateDir:f.state,frontPort:holder.port})).rejects.toThrow(/^FRONT_PORT_BUSY: 127\.0\.0\.1:\d+ is held by another listener; use --direct/);await track(f.state);
  expect(await (await fetch(`http://127.0.0.1:${holder.port}/`)).json()).toEqual({unrelated:true});
  const busy=await cli(['open',f.producer],f.state,{RIG_REVIEW_FRONT_PORT:String(holder.port)});expect(busy.exit).toBe(1);expect(busy.stdout).toBe('');expect(busy.stderr).toContain('FRONT_PORT_BUSY');expect(busy.stderr).toContain('use --direct');
  const direct=await cli(['open',f.producer,'--direct'],f.state,{RIG_REVIEW_FRONT_PORT:String(holder.port)});expect(direct.exit).toBe(0);const url=direct.stdout.trim(),origin=new URL(url).origin,row=await record(f.state,url);
  expect(origin).toBe(row.origin);expect(new URL(url).pathname).toBe('/');expect(cap(url)).toBe(row.capability);expect((await fetch(url)).status).toBe(200);
  const session=await (await fetch(origin+'/api/session')).json(),put=(headers:Record<string,string>)=>fetch(origin+'/api/session',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify({...session,status:'approved'})});
  expect((await put({})).status).toBe(403);expect((await put({'X-Review-Capability':cap(url)})).status).toBe(200);
  expect((await readdir(join(f.state,'open'))).some(n=>/^front-\d+\.json$/.test(n))).toBe(false);
 }finally{holder.stop(true);}
},60000);

test('compare instances route through the front with their own assets, reference and session',async()=>{
 const f=await fixture(),other=join(f.root,'other');await cp(f.producer,other,{recursive:true});const port=freePort();
 const opened=await openReview({input:f.producer,compare:other,reference:f.reference},{stateDir:f.state,frontPort:port});await track(f.state);const base=`http://127.0.0.1:${port}`+new URL(opened.url).pathname,row=await record(f.state,opened.url);
 expect(row.mode).toBe('compare');const data=await (await fetch(base+'api/compare')).json();expect(data.sourceHash).toBe(row.contentHash);
 for(const path of ['compare-assets/a/build/skeleton.model.json','compare-assets/b/build/skeleton.model.json'])expect((await fetch(base+path)).headers.get('content-security-policy')).toContain('sandbox');
 expect((await fetch(base+'compare-reference',{headers:{Range:'bytes=0-3'}})).status).toBe(206);expect((await fetch(base+'api/review')).status).toBe(404);
 const session=await (await fetch(base+'api/compare/session')).json(),headers={Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json'};
 expect((await fetch(base+'api/compare/session',{method:'PUT',headers,body:JSON.stringify({...session,status:'approved'})})).status).toBe(403);
 expect((await fetch(base+'api/compare/session',{method:'PUT',headers:{...headers,'X-Review-Capability':cap(opened.url)},body:JSON.stringify({...session,status:'approved'})})).status).toBe(200);
},60000);
