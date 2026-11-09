import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {connect} from 'node:net';
import {digest} from '../src/interview-project.ts';
import {startFront} from '../src/front.ts';
import {startServer} from '../src/server.ts';
import {loadOpenPackage,openFingerprint,openReview,running,type RecordFile} from '../src/open.ts';
import {instanceAccess,readOnlyReason} from '../web/instance-access.ts';
const roots:string[]=[],owned:{pid:number;origin:string;nonce:string;status:string}[]=[];
// Stop only processes whose private nonce still answers, then prove they are gone.
afterEach(async()=>{for(const row of owned.splice(0)){try{const r=await fetch(row.origin+row.status,{headers:{authorization:`Bearer ${row.nonce}`},signal:AbortSignal.timeout(500)});if((await r.json()).nonce===row.nonce)process.kill(row.pid,'SIGTERM');}catch{}let stopped=false;for(let n=0;n<80;n++){try{const r=await fetch(row.origin+row.status,{headers:{authorization:`Bearer ${row.nonce}`},signal:AbortSignal.timeout(100)});if((await r.json()).nonce!==row.nonce){stopped=true;break;}}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}for(let n=0;n<80&&running(row.pid);n++)await new Promise(resolve=>setTimeout(resolve,25));expect(stopped).toBe(true);}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-front-')));roots.push(root);const producer=join(root,'producer');await mkdir(producer);await cp(join(import.meta.dir,'fixtures/strip-probe/build'),join(producer,'build'),{recursive:true});await cp(join(import.meta.dir,'fixtures/strip-probe/motion.json'),join(producer,'motion.json'));await writeFile(join(producer,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.500003,.999997]}));const reference=join(root,'original.mov');await cp(join(import.meta.dir,'fixtures/strip-probe/reference.mov'),reference);return {root,producer,reference,state:join(root,'state')};}
async function track(state:string){for(const name of await readdir(join(state,'open'))){const front=/^front-\d+\.json$/.test(name);if(!front&&!/^[a-f0-9]{64}\.json$/.test(name))continue;const data=JSON.parse(await readFile(join(state,'open',name),'utf8'));if(!owned.some(row=>row.nonce===data.nonce))owned.push({pid:data.pid,origin:data.origin,nonce:data.nonce,status:front?'/api/front-status':'/api/open-status'});}}
async function record(state:string,url:string){const key=new URL(url).pathname.split('/')[2]||new URL(url).searchParams.get('handoff');return JSON.parse(await readFile(join(state,'open',key+'.json'),'utf8'));}
function freePort(){const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=server.port!;server.stop(true);return port;}
function rawHost(port:number,host:string,path:string):Promise<string>{return new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1');let out='';socket.on('data',chunk=>{out+=chunk;});socket.on('end',()=>resolve(out));socket.on('error',reject);socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);});}
const cap=(url:string)=>new URL(url).hash.slice(5);
async function cli(args:string[],state:string,env:Record<string,string>={}){const child=Bun.spawn([process.execPath,'src/cli.ts',...args],{env:{...process.env,RIG_REVIEW_STATE_DIR:state,...env},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit};}

test('managed front relays the named stale interview picks refusal', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(),'review-front-')));
 roots.push(root);
 const project = join(root,'project'), control = join(root,'open');
 await mkdir(project);
 await mkdir(control);
 const archive = await readFile(new URL('./fixtures/create-reopened-v2/project.tar.gz',import.meta.url));
 expect(digest(archive)).toBe('35fb7799f48336e10c7999dbeeacdfa87b2e6e015b59a76c6a37d33966f311ff');
 const extracted = Bun.spawnSync(['tar','-xzf','-','-C',project],{stdin:archive});
 if(extracted.exitCode!==0)throw new Error(extracted.stderr.toString());
 await mkdir(join(project,'reviewer-picks'));
 const input = join(project,'derived/review/v2/out');
 const loaded = await loadOpenPackage({input,project:{root:project,version:2,picksDir:'reviewer-picks'}});
 if(loaded.mode!=='single'||!loaded.joined)throw new Error('Expected a joined inspection');
 const identity = {key:'a'.repeat(64),nonce:crypto.randomUUID(),fingerprint:await openFingerprint(),contentHash:loaded.contentHash};
 const capability = 'b'.repeat(64);
 const worker = await startServer(loaded.p,{port:0,stateDir:join(root,'state'),open:identity,joined:loaded.joined,capability});
 try{
  const record:RecordFile = {schema:'rig-review-open-instance/1',...identity,pid:process.pid,origin:`http://127.0.0.1:${worker.port}`,mode:'single',capability};
  await writeFile(join(control,identity.key+'.json'),JSON.stringify(record),{mode:0o600});
  const front = startFront({control,port:freePort(),nonce:crypto.randomUUID(),fingerprint:identity.fingerprint});
  try{
   const base = `${front.origin}/instances/${identity.key}`;
   const healthy = await fetch(base+'/api/interview',{signal:AbortSignal.timeout(5000)});
   expect(healthy.status).toBe(200);
   await healthy.body?.cancel();
   const image = join(input,'parts/torso.png');
   await writeFile(image,Buffer.concat([await readFile(image),Buffer.from([0])]));
   const response = await fetch(base+'/api/interview/picks',{
    method:'POST',headers:{Origin:front.origin,'Content-Type':'application/json','X-Review-Capability':capability},
    body:'{}',signal:AbortSignal.timeout(5000),
   });
   expect(response.status).toBe(409);
   expect(await response.json()).toEqual({error:'INTERVIEW_OPTIONS_STALE'});
  }finally{front.stop();}
 }finally{worker.stop(true);}
});

test('managed front relays only the exact joined direction stale refusal on the bootstrap routes', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(),'review-front-')));
 roots.push(root);
 const project = join(root,'project'), control = join(root,'open');
 await mkdir(project);
 await mkdir(control);
 const archive = await readFile(new URL('./fixtures/create-example-chain/project.tar.gz',import.meta.url));
 const extracted = Bun.spawnSync(['tar','-xzf','-','-C',project],{stdin:archive});
 if(extracted.exitCode!==0)throw new Error(extracted.stderr.toString());
 await mkdir(join(project,'picks'));
 const loaded = await loadOpenPackage({input:join(project,'derived/review/v1/out'),project:{root:project,version:1,postVersion:2,picksDir:'picks'}});
 if(loaded.mode!=='single'||!loaded.joined||!loaded.p.direction)throw new Error('Expected a joined authored direction');
 const identity = {key:'a'.repeat(64),nonce:crypto.randomUUID(),fingerprint:await openFingerprint(),contentHash:loaded.contentHash};
 const capability = 'b'.repeat(64);
 const worker = await startServer(loaded.p,{port:0,stateDir:join(root,'state'),open:identity,joined:loaded.joined,capability});
 const front = startFront({control,port:freePort(),nonce:crypto.randomUUID(),fingerprint:identity.fingerprint});
 const writeRecord = async (port: number, override: Partial<RecordFile> = {}) => {
  const row:RecordFile = {schema:'rig-review-open-instance/1',...identity,pid:process.pid,origin:`http://127.0.0.1:${port}`,mode:'single',capability,...override};
  await writeFile(join(control,identity.key+'.json'),JSON.stringify(row),{mode:0o600});
 };
 const get = (path = '/api/review') => fetch(`${front.origin}/instances/${identity.key}${path}`,{signal:AbortSignal.timeout(5000)});
 const direction = join(project,loaded.p.direction.file.path);
 const bytes = await readFile(direction);
 const body = {error:'DIRECTION_SOURCE_STALE'};
 let reply = new Response();
 const mock = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => reply});
 try{
  await writeRecord(worker.port!);
  const healthy = await get();
  expect(healthy.status).toBe(200);
  expect((await healthy.json()).direction.joined.postVersion).toBe(2);
  await writeFile(direction,Buffer.concat([bytes,Buffer.from(' ')]));
  const stale = await get();
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual(body);
  expect(await (await get('/api/session')).json()).toEqual(body);
  await writeRecord(worker.port!,{nonce:crypto.randomUUID()});
  expect((await get()).status).toBe(410);
  await writeRecord(worker.port!,{fingerprint:'c'.repeat(64)});
  expect(await (await get()).json()).toEqual({error:'FRONT_UPSTREAM_CONFLICT'});
  await writeRecord(mock.port!);
  const headers = {'X-Review-Open-Key':identity.key};
  for(const [path,response,status,error] of [
   ['/api/review',Response.json({error:body.error+': /private/file'},{status:409,headers}),409,'FRONT_UPSTREAM_CONFLICT'],
   ['/api/review',Response.json({...body,path:'/private/file'},{status:409,headers}),409,'FRONT_UPSTREAM_CONFLICT'],
   ['/api/review',Response.json(body,{status:409}),410,'FRONT_INSTANCE_REPLACED: reopen with rig-review open'],
   ['/api/review',Response.json(body,{status:400,headers}),400,'FRONT_UPSTREAM_REJECTED'],
   ['/api/review',new Response(JSON.stringify(body),{status:409,headers}),409,'FRONT_UPSTREAM_CONFLICT'],
   ['/api/review',new Response(JSON.stringify(body)+' '.repeat(512),{status:409,headers:{...headers,'Content-Type':'application/json'}}),409,'FRONT_UPSTREAM_CONFLICT'],
   ['/api/access',Response.json(body,{status:409,headers}),409,'FRONT_UPSTREAM_CONFLICT'],
  ] as const){
   reply = response;
   const refused = await get(path);
   expect(refused.status).toBe(status);
   expect(await refused.json()).toEqual({error});
  }
 }finally{
  mock.stop(true);
  front.stop();
  worker.stop(true);
  await writeFile(direction,bytes);
 }
});

test('managed front routes by key, refuses unlisted/oversized/foreign-host requests and never serves a capability',async()=>{
 const f=await fixture(),other=join(f.root,'other');await cp(f.producer,other,{recursive:true});await writeFile(join(other,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.5,1]}));const port=freePort();
 const a=await openReview({input:f.producer,reference:f.reference,viewOnly:true},{stateDir:f.state,frontPort:port}),b=await openReview({input:other,control:true,viewOnly:true},{stateDir:f.state,frontPort:port});await track(f.state);
 const front=`http://127.0.0.1:${port}`,aBase=front+new URL(a.url).pathname,bBase=front+new URL(b.url).pathname,ra=await record(f.state,a.url),rb=await record(f.state,b.url);
 expect(new URL(a.url).origin).toBe(front);expect(new URL(a.url).pathname).toBe(`/instances/${ra.key}/`);expect(a.direct).toBe(false);expect(cap(a.url)).toBe(ra.capability);expect(cap(b.url)).toBe(rb.capability);expect(ra.capability).not.toBe(rb.capability);
 const again=await openReview({input:f.producer,reference:f.reference,viewOnly:true},{stateDir:f.state,frontPort:port});expect(again.url).toBe(a.url);expect(again.reused).toBe(true);expect((await readdir(join(f.state,'open'))).filter(n=>/^front-\d+\.json$/.test(n))).toEqual([`front-${port}.json`]);
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
 const fileB=join(f.state,'open',rb.key+'.json'),savedB=await readFile(fileB,'utf8');process.kill(rb.pid,'SIGTERM');
 // Wait for the process itself to exit: its own shutdown removes the record and must not race the rewrite below.
 for(let n=0;n<200;n++){try{process.kill(rb.pid,0);}catch{break;}await new Promise(r=>setTimeout(r,25));}expect(()=>process.kill(rb.pid,0)).toThrow();
 await writeFile(fileB,savedB,{mode:0o600});await refused(fetch(bBase+'api/review'),410,'FRONT_INSTANCE_EXPIRED');await rm(fileB);await refused(fetch(bBase+'api/review'),404,'FRONT_INSTANCE_UNKNOWN');
},60000);

test('page A holding instance B key cannot mutate B; only B capability can, and a fragment-less copied link is read-only',async()=>{
 const f=await fixture(),other=join(f.root,'other');await cp(f.producer,other,{recursive:true});await writeFile(join(other,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.5,1]}));const port=freePort();
 const a=await openReview({input:f.producer,viewOnly:true},{stateDir:f.state,frontPort:port}),b=await openReview({input:other,control:true,viewOnly:true},{stateDir:f.state,frontPort:port});await track(f.state);
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
 const access=await (await fetch(bBase+'api/access')).json();expect(access).toEqual({schema:'rig-review-access/1',capabilityRequired:true,control:true});
 const view=instanceAccess(copied.href,store,()=>{throw new Error('no fragment to strip');});expect(view.capability).toBeNull();expect(readOnlyReason(view,access.capabilityRequired)).toBe('Read-only view: reopen with rig-review open to edit.');
 expect((await fetch(copied)).status).toBe(200);
},60000);

test('a busy front port fails by name with the way out, and --direct keeps the per-port worker',async()=>{
 const f=await fixture(),holder=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({unrelated:true})});
 try{
  await expect(openReview({input:f.producer,viewOnly:true},{stateDir:f.state,frontPort:holder.port})).rejects.toThrow(/^FRONT_PORT_BUSY: 127\.0\.0\.1:\d+ is held by another listener; use --direct/);await track(f.state);
  expect(await (await fetch(`http://127.0.0.1:${holder.port}/`)).json()).toEqual({unrelated:true});
  const busy=await cli(['open',f.producer,'--view-only'],f.state,{RIG_REVIEW_FRONT_PORT:String(holder.port)});expect(busy.exit).toBe(1);expect(busy.stdout).toBe('');expect(busy.stderr).toContain('FRONT_PORT_BUSY');expect(busy.stderr).toContain('use --direct');
  const direct=await cli(['open',f.producer,'--view-only','--direct'],f.state,{RIG_REVIEW_FRONT_PORT:String(holder.port)});expect(direct.exit).toBe(0);const url=direct.stdout.trim(),origin=new URL(url).origin,row=await record(f.state,url);
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

test('front stays up while control directory has a live record and exits within bound when control directory is deleted, while planted .catch(()=>{}) form fails',async()=>{
 const f=await fixture(),port=freePort(),idleMs=120;
 await openReview({input:f.producer,viewOnly:true},{stateDir:f.state,frontPort:port,frontIdleMs:idleMs,idleMs:5000});await track(f.state);
 const control=join(f.state,'open'),frontRec=JSON.parse(await readFile(join(control,`front-${port}.json`),'utf8')) as {pid:number;origin:string;nonce:string;fingerprint:string};
 // Bar 3: while control directory exists with a live instance record, front stays up past idleMs.
 await Bun.sleep(idleMs*3);
 expect(running(frontRec.pid)).toBe(true);
 const aliveRes=await fetch(frontRec.origin+'/api/front-status',{headers:{authorization:`Bearer ${frontRec.nonce}`}});
 expect(aliveRes.status).toBe(200);
 // Any other read error (e.g. ENOTDIR when control path is a regular file) stays as it is and does not exit the front.
 await rm(control,{recursive:true,force:true});
 await writeFile(control,'not-a-directory');
 await Bun.sleep(idleMs*3);
 expect(running(frontRec.pid)).toBe(true);
 // Bar 1: deleting the control directory (ENOENT) makes the front exit within bound.
 await rm(control,{force:true});
 const deadline=performance.now()+1500;
 while(performance.now()<deadline&&running(frontRec.pid))await Bun.sleep(25);
 expect(running(frontRec.pid)).toBe(false);
 // Planted pre-#287 control: unguarded readdir(control) swallowed by .catch(()=>{}) stays alive past the bound when control is deleted.
 const plantedControl=join(f.root,'planted-open');await mkdir(plantedControl,{recursive:true,mode:0o700});
 const plantedPort=freePort(),plantedNonce=crypto.randomUUID(),plantedReq=join(plantedControl,`front-${plantedPort}.${plantedNonce}.request.json`),plantedRecPath=join(plantedControl,`front-${plantedPort}.json`);
 const frontSrc=await readFile(new URL('../src/front.ts',import.meta.url),'utf8');
 const plantedFrontSrc=frontSrc.replace(/async function liveInstances\(control:string\):Promise<boolean>\{[^\n]*\}/,'async function liveInstances(control:string):Promise<boolean>{for(const name of await readdir(control)){if(/^[a-f0-9]{64}\\.claim$/.test(name))return true;}return false;}');
 const plantedDir=join(f.root,'planted-src');await mkdir(plantedDir,{recursive:true});
 for(const name of ['build.ts','open.ts','open-protocol.ts','live-lifecycle.ts','control.ts','reference.ts','manifest.ts','compare.ts','server.ts','compare-server.ts','animation-selection.ts','versions.ts','handoff.ts','state-dir.ts','stage-parts.ts','interview-routes.ts','interview-picks.ts','joined-project.ts']){
  await writeFile(join(plantedDir,name),`export * from ${JSON.stringify(join(import.meta.dir,'../src',name))};\n`);
 }
 await writeFile(join(plantedDir,'front.ts'),plantedFrontSrc);
 await writeFile(plantedReq,JSON.stringify({schema:'rig-review-front-request/1',control:plantedControl,request:plantedReq,record:plantedRecPath,port:plantedPort,nonce:plantedNonce,fingerprint:await openFingerprint(),idleMs}),{mode:0o600});
 const plantedProc=Bun.spawn([process.execPath,'-e',`import {runFront} from ${JSON.stringify(join(plantedDir,'front.ts'))}; await runFront(process.argv[1]);`,plantedReq],{cwd:plantedControl,stdout:'ignore',stderr:'ignore'});
 try{
  for(let n=0;n<80;n++){try{const r=await fetch(`http://127.0.0.1:${plantedPort}/api/front-status`,{headers:{authorization:`Bearer ${plantedNonce}`}});if(r.ok)break;}catch{}await Bun.sleep(25);}
  await rm(plantedControl,{recursive:true,force:true});
  await Bun.sleep(idleMs*4);
  // The planted form fails the exit gate: the process is still running after 4x idleMs.
  expect(running(plantedProc.pid)).toBe(true);
 }finally{
  try{process.kill(plantedProc.pid,'SIGTERM');}catch{}
  await plantedProc.exited.catch(()=>{});
 }
},30000);


test('managed front preserves the malformed scene stale refusal as a closed named error', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'review-front-scene-')));
 roots.push(root);
 const projectRoot = join(root, 'project');
 const control = join(root, 'open');
 await mkdir(projectRoot);
 await mkdir(control);
 const archive = await readFile(new URL('./fixtures/create-reopened-v2/project.tar.gz', import.meta.url));
 expect(digest(archive)).toBe('35fb7799f48336e10c7999dbeeacdfa87b2e6e015b59a76c6a37d33966f311ff');
 const extracted = Bun.spawnSync(['tar', '-xzf', '-', '-C', projectRoot], {stdin: archive});
 expect(extracted.exitCode).toBe(0);
 const optionPath = 'evidence/interview/example-post-composition.json';
 const option = JSON.parse(await readFile(join(projectRoot, optionPath), 'utf8'));
 option.context = {kind: 'scene', scene: {n: 1, path: 'evidence/unsupported-scene.json', sha256: digest('{}')}};
 const optionBytes = JSON.stringify(option);
 await writeFile(join(projectRoot, optionPath), optionBytes);
 const project = JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8'));
 project.interview = {post: {items: [{id: 'post_composition', pending_options: {path: optionPath, sha256: digest(optionBytes)}}]}};
 await writeFile(join(projectRoot, 'project.json'), JSON.stringify(project));
 const error = await openReview({input: join(projectRoot, 'derived/review/v2/out'),
  project: {root: projectRoot, version: 2, picksDir: 'reviewer-picks'}}, {stateDir: join(root, 'state')})
  .then(() => null, error => error as Error);
  expect(error?.message).toBe('INTERVIEW_OPTIONS_STALE: example-post-composition');
 const code = error!.message.split(':')[0]!;
 const identity = {key: 'd'.repeat(64), nonce: crypto.randomUUID(), fingerprint: 'e'.repeat(64), contentHash: digest(optionBytes)};
 const capability = 'f'.repeat(64);
 // The real opener refuses before starting a worker. Exercise the front's closed
 // error transport separately with that opener's exact named failure.
 let body: unknown = {error: code};
 const worker = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () =>
  Response.json(body, {status: 400, headers: {'X-Review-Open-Key': identity.key}})});
 try {
  const record: RecordFile = {schema: 'rig-review-open-instance/1', ...identity,
   pid: process.pid, origin: `http://127.0.0.1:${worker.port}`, mode: 'single', capability};
  await writeFile(join(control, identity.key + '.json'), JSON.stringify(record), {mode: 0o600});
  const front = startFront({control, port: freePort(), nonce: crypto.randomUUID(), fingerprint: identity.fingerprint});
  try {
   const get = () => fetch(`${front.origin}/instances/${identity.key}/api/interview`, {signal: AbortSignal.timeout(5000)});
   const named = await get();
   expect(named.status).toBe(400);
   expect(await named.json()).toEqual({error: code});
   for (const rejected of [{error: code + ': scene'}, {error: code, path: '/private/scene'}]) {
    body = rejected;
    const response = await get();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: 'FRONT_UPSTREAM_REJECTED'});
   }
  } finally {front.stop();}
 } finally {worker.stop(true);}
});
