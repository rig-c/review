import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,realpath,symlink,rename,readdir,utimes,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {initialReviewSelection} from '../src/open-selection.ts';
import {loadReview} from '../src/manifest.ts';
import {loadReferencedReview,referenceBinding,selectedReference,assertReviewUnchanged,safeSelectedReference,serveReference} from '../src/reference.ts';
import {freshSession,parseSession,saveSession} from '../src/session.ts';
import {readFeedbackSession} from '../src/session-history.ts';
import {startServer} from '../src/server.ts';
import {exportReviewStrip} from '../src/strip-export.ts';
const dirs:string[]=[];afterEach(async()=>{for(const path of dirs.splice(0))await rm(path,{recursive:true,force:true});});
export async function referenceFixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-reference-')));dirs.push(root);const producer=join(root,'producer');await mkdir(producer);await cp(join(import.meta.dir,'fixtures/strip-probe/build'),join(producer,'build'),{recursive:true});await cp(join(import.meta.dir,'fixtures/strip-probe/motion.json'),join(producer,'motion.json'));await writeFile(join(producer,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:[0,.500003,.999997]}));const reference=join(root,'original.mov');await cp(join(import.meta.dir,'fixtures/strip-probe/reference.mov'),reference);return {root,producer,reference,state:join(root,'state')};}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
test('CLI-only selected reference binds content/session without mutating the source manifest or files',async()=>{const f=await referenceFixture(),base=await loadReview(f.producer),p=await loadReferencedReview(f.producer,f.reference);expect(p.sourceHash).not.toBe(base.sourceHash);expect(p.files).toEqual(base.files);expect(p.reviewedSource).toEqual(base.reviewedSource);expect(base.manifest.references).toHaveLength(0);expect(p.manifest.references[0].id).toBe(selectedReference(p)!.binding.reference.id);expect(referenceBinding(p)).toEqual({packageSourceHash:base.sourceHash,reference:{id:p.manifest.references[0].id,name:'original.mov',sha256:sha(await readFile(f.reference))}});expect(JSON.stringify(referenceBinding(p))).not.toContain(f.root);expect((await readdir(f.producer)).sort()).toEqual(['build','motion.json','report.json']);const input={...freshSession(p),status:'changes-requested',feedback:[{id:'one',frameStart:1,frameEnd:2,target:{kind:'bone',name:'rigid'},category:'defect',summary:'Review this interval',context:{animation:'inspect'}}]};await saveSession(p,input,f.state);expect((await readFeedbackSession(p,f.state)).status).toBe('changes-requested');expect((await readFeedbackSession(base,f.state)).status).toBe('pending');expect(()=>parseSession({...input,referenceBinding:{...referenceBinding(p),reference:{name:'fake',sha256:'0'.repeat(64)}}},p)).toThrow('referenceBinding');expect(()=>parseSession({...input,referenceBinding:undefined},p)).toThrow('referenceBinding');await writeFile(f.reference,(await readFile(f.reference)).subarray(0,-1));const changed=await loadReferencedReview(f.producer,f.reference);expect(changed.sourceHash).not.toBe(p.sourceHash);expect((await readFeedbackSession(changed,f.state)).status).toBe('pending');await expect(assertReviewUnchanged(p)).rejects.toThrow('inputs changed');});
test('reference-bound historical retrieval retains the original versions and cannot borrow plain approval',async()=>{const f=await referenceFixture(),p=await loadReferencedReview(f.producer,f.reference),old={...p,reviewedSource:{...p.reviewedSource,viewerVersion:'0.0.0',runtimeVersion:'0.0.0'}};await saveSession(old,{...freshSession(old),status:'approved'},f.state);const read=await readFeedbackSession(p,f.state);expect(read.status).toBe('approved');expect(read.reviewedSource.viewerVersion).toBe('0.0.0');expect(read.referenceBinding).toEqual(referenceBinding(p));expect(read.retrieval?.kind).toBe('prior-tools');expect((await readFeedbackSession(await loadReview(f.producer),f.state)).status).toBe('pending');});
test('selected reference serves fixed URL with sandbox/ranges, exports the same strip binding and refuses replacement',async()=>{const f=await referenceFixture(),p=await loadReferencedReview(f.producer,f.reference),server=await startServer(p,{port:0,stateDir:f.state}),base=`http://127.0.0.1:${server.port}`;try{const response=await fetch(base+'/api/review'),data=await response.json();expect(data.explicitReference.url).toBe('/review-reference');expect(data.manifest.references[0].id).toBe(data.explicitReference.id);expect(JSON.stringify(data)).not.toContain(f.root);const partial=await fetch(base+'/review-reference',{headers:{Range:'bytes=0-7'}});expect(partial.status).toBe(206);expect(partial.headers.get('content-security-policy')).toContain('sandbox');expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array((await readFile(f.reference)).subarray(0,8)));expect((await fetch(base+'/review-reference',{method:'HEAD'})).status).toBe(200);expect((await fetch(base+'/review-reference',{headers:{Range:'bytes=99999999-'}})).status).toBe(416);const request={format:'json',sourceHash:p.sourceHash,animation:'inspect',referenceId:data.explicitReference.id,intervals:[{id:'one',basis:'single',frameStart:0,frameEnd:2}]};const plan=await exportReviewStrip(p,request);expect(plan.plan.binding.sourceHash).toBe(p.sourceHash);expect(plan.plan.binding.packages[0].sourceHash).toBe(referenceBinding(p)!.packageSourceHash);expect(plan.plan.binding.reference.sha256).toBe(referenceBinding(p)!.reference.sha256);const png=await exportReviewStrip(p,{...request,format:'png'});expect(png.png!.length).toBeGreaterThan(1000);expect(png.rendering?.samples.map(s=>s.presentedTime)).toEqual([0,.5,1]);await rename(f.reference,f.reference+'.original');await writeFile(join(f.root,'secret.mov'),'secret');await symlink(join(f.root,'secret.mov'),f.reference);await expect(safeSelectedReference(p)).rejects.toThrow('canonical');for(const method of ['GET','HEAD'])expect((await fetch(base+'/review-reference',{method})).status).toBe(400);}finally{server.stop(true);}},30000);

test('explicit CLI video wins automatic checkpoint startup without overriding a requested checkpoint',()=>{const manifest={references:[{id:'selected',label:'Selected',type:'video' as const,path:'virtual.mp4'},{id:'producer',label:'Generated',type:'video' as const,path:'clip.mp4'}],checkpoints:[{id:'first',title:'First',reference:'producer'}]};const automatic=initialReviewSelection(manifest,null,'selected');expect(automatic.referenceId).toBe('selected');expect(automatic.checkpoint?.id).toBe('first');expect(automatic.updateUrl).toBe(false);const requested=initialReviewSelection(manifest,'first','selected');expect(requested.referenceId).toBe('producer');expect(requested.updateUrl).toBe(true);expect(initialReviewSelection(manifest,null).referenceId).toBe('producer');expect(initialReviewSelection(manifest,null).updateUrl).toBe(true);});


test('reference byte serving hashes before GET/HEAD/ranges and accepts byte-identical touches',async()=>{
 for(const replacement of ['overwrite','atomic']){const f=await referenceFixture(),p=await loadReferencedReview(f.producer,f.reference),server=await startServer(p,{port:0,stateDir:f.state}),url=`http://127.0.0.1:${server.port}/review-reference`;try{
  const original=await readFile(f.reference);await utimes(f.reference,new Date(0),new Date(1000));
  const same=await fetch(url,{headers:{Range:'bytes=0-7'}});expect(same.status).toBe(206);expect(new Uint8Array(await same.arrayBuffer())).toEqual(new Uint8Array(original.subarray(0,8)));expect((await fetch(url,{method:'HEAD'})).status).toBe(200);
  const changed=Buffer.from(original);changed[0]^=255;
  if(replacement==='overwrite')await writeFile(f.reference,changed);else{await writeFile(f.reference+'.next',changed);await rename(f.reference+'.next',f.reference);}
  // Restore mtime as well: metadata equality never substitutes for the pinned SHA.
  await utimes(f.reference,new Date(0),new Date(1000));
  for(const init of [{method:'GET'},{method:'HEAD'},{headers:{Range:'bytes=0-7'}}]){const response=await fetch(url,init);expect(response.status).toBe(409);if(init.method!=='HEAD'){expect(await response.text()).toContain('Reference inputs changed');}}
 }finally{await server.stop(true);}}
});

test('verified reference streams the same descriptor and closes HEAD, 416, completion and cancel',async()=>{
 const f=await referenceFixture(),bytes=Buffer.alloc(256*1024,37);await writeFile(f.reference,bytes);const digest=sha(bytes),request=(headers?:Record<string,string>,method='GET')=>new Request('http://localhost/reference',{headers,method});
 const descriptors=async()=>{if(process.platform!=='linux')return [];const result:string[]=[];for(const fd of await readdir('/proc/self/fd'))try{if((await readlink('/proc/self/fd/'+fd)).replace(/ \(deleted\)$/,'')===f.reference)result.push(fd);}catch{}return result;};
 const baseline=await descriptors();
 for(const [headers,method,status] of [[undefined,'HEAD',200],[{Range:'bytes=9999999-'},'GET',416]] as const){expect((await serveReference(request(headers,method),f.reference,digest,{})).status).toBe(status);expect(await descriptors()).toEqual(baseline);}
 const completed=await serveReference(request(),f.reference,digest,{});expect(new Uint8Array(await completed.arrayBuffer())).toEqual(new Uint8Array(bytes));expect(await descriptors()).toEqual(baseline);
 const canceled=await serveReference(request(),f.reference,digest,{});await canceled.body!.cancel();expect(await descriptors()).toEqual(baseline);
 // A response already opened before pathname replacement never switches to new bytes.
 const opened=await serveReference(request(),f.reference,digest,{}),reader=opened.body!.getReader(),first=await reader.read();expect(first.value!.length).toBeLessThanOrEqual(65536);expect([...first.value!].every(value=>value===37)).toBe(true);
 await writeFile(f.reference+'.next',Buffer.alloc(bytes.length,99));await rename(f.reference+'.next',f.reference);
 let failed=false,wrongBytes=false;try{while(true){const part=await reader.read();if(part.done)break;if(![...part.value].every(value=>value===37))wrongBytes=true;}}catch{failed=true;}expect(wrongBytes).toBe(false);expect(failed).toBe(true);expect(await descriptors()).toEqual(baseline);
});

test('stage2 P1 reference pull cleanup joins the actual pending file close', async () => {
 const f = await referenceFixture();
 await writeFile(f.reference, Buffer.alloc(256 * 1024, 37));
 const script = `
  import {mock} from 'bun:test';
  import * as fs from 'node:fs/promises';
  import {createHash} from 'node:crypto';
  const original = {...fs};
  const input = JSON.parse(await Bun.stdin.text());
  const bytes = await original.readFile(input.path);
  const deferred = () => {let resolve; const promise = new Promise(yes => {resolve=yes;}); return {promise,resolve};};
  const reading=deferred(), readGate=deferred(), closing=deferred(), closeGate=deferred(), enqueue=deferred();
  let closeCalls=0, actualFileClosed=false, pullSettled=false, pullPromise;
  mock.module('node:fs/promises', () => ({...original, async open(...args) {
   const file = await original.open(...args);
   if (args[0] === input.path) {
    const read=file.read.bind(file), close=file.close.bind(file);
    let reads=0;
    file.read=async (...values) => {
     if (++reads > Math.ceil(bytes.length/65536)) {reading.resolve(); await readGate.promise;}
     return read(...values);
    };
    file.close=async () => {closeCalls++; closing.resolve(); await closeGate.promise; await close(); actualFileClosed=true;};
   }
   return file;
  }}));
  const NativeStream=globalThis.ReadableStream;
  globalThis.ReadableStream=class extends NativeStream {
   constructor(source, strategy) {
    super({...source, pull(controller) {
     const wrapped=new Proxy(controller,{get(target,key) {
      if (key==='enqueue') return value => {enqueue.resolve(); return target.enqueue(value);};
      const value=Reflect.get(target,key); return typeof value==='function' ? value.bind(target) : value;
     }});
     pullPromise=Promise.resolve(source.pull(wrapped)).finally(() => {pullSettled=true;});
     return pullPromise;
    }}, strategy);
   }
  };
  const {serveReference}=await import(input.module);
  const response=await serveReference(new Request('http://localhost/reference'),input.path,
   createHash('sha256').update(bytes).digest('hex'),{});
  const reader=response.body.getReader(), pending=reader.read();
  await reading.promise;
  const cancellation=reader.cancel();
  await closing.promise;
  await pending;
  readGate.resolve();
  await enqueue.promise;
  for(let index=0;index<8;index++) await Promise.resolve();
  const earlyPullSettled=pullSettled;
  closeGate.resolve();
  await cancellation;
  await pullPromise;
  console.log(JSON.stringify({control:'STAGE2_REFERENCE_CLOSE',earlyPullSettled,actualFileClosed,closeCalls}));
 `;
 const child=Bun.spawn([process.execPath,'-e',script],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 child.stdin.write(JSON.stringify({path:f.reference,module:new URL('../src/reference.ts',import.meta.url).href}));
 child.stdin.end();
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(exit).toBe(0);
 expect(stderr).toBe('');
 const result=JSON.parse(stdout);
 console.log(JSON.stringify(result));
 expect(result.actualFileClosed).toBe(true);
 expect(result.closeCalls).toBe(1);
 expect(result.earlyPullSettled).toBe(false);
});
