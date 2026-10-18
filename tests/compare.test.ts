import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCompare, assertCompareUnchanged, type ComparePackage } from '../src/compare.ts';
import { freshCompareSession, parseCompareSession, readCompareSession, saveCompareSession } from '../src/compare-session.ts';
import { startCompareServer } from '../src/compare-server.ts';

const dirs:string[]=[];afterEach(async()=>{for(const root of dirs.splice(0))await rm(root,{recursive:true,force:true});});
// Envelope-only transport probes; actual runtime controls use the separately gated fixture.
async function fixture(){const root=await mkdtemp(join(tmpdir(),'review-compare-'));dirs.push(root);for(const side of ['a','b']){await mkdir(join(root,side,'build'),{recursive:true});await writeFile(join(root,side,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'page.png'}],animations:[{name:'inspect',duration:2}],bones:[{name:'probe'}],slots:[],transportProbe:side}));await writeFile(join(root,side,'build/page.png'),side+' page bytes');await writeFile(join(root,side,'motion.json'),JSON.stringify({side}));}await writeFile(join(root,'ref.mp4'),'0123456789');return {root,inputs:{a:join(root,'a'),b:join(root,'b'),reference:join(root,'ref.mp4'),animation:'inspect'}};}
function note(){return {id:'one',side:'b' as const,frameStart:1,frameEnd:3,target:{kind:'bone' as const,name:'probe'},category:'quality' as const,summary:'Inspect the motion',context:{time:0.5,frame:null}};}
async function inventory(root:string){const names=(await readdir(root,{recursive:true})).sort();const values:Record<string,string>={};for(const n of names){const f=Bun.file(join(root,n));try{values[n]=await f.text();}catch{}}return values;}
test('comparison binds ordered package and reference identities without writing either source',async()=>{
 const f=await fixture(),before=await inventory(f.root);const p=await loadCompare(f.inputs);expect(p.response.mode).toBe('compare');expect(p.response.binding.a.reviewedSource.rig?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(p.response.binding.b.reviewedSource.motion?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(p.response.binding.a.reviewedSource.rig).not.toEqual(p.response.binding.b.reviewedSource.rig);expect(p.response.reference.url).toBe('/compare-reference');expect(JSON.stringify(p.response)).not.toContain(f.root);expect(p.response.a.assetsBase).toBe('/compare-assets/a/');expect(p.response.b.assetsBase).toBe('/compare-assets/b/');
 const swapped=await loadCompare({...f.inputs,a:f.inputs.b,b:f.inputs.a});expect(swapped.response.sourceHash).not.toBe(p.response.sourceHash);expect(freshCompareSession(p).status).toBe('pending');expect(await inventory(f.root)).toEqual(before);
});
test('comparison session requires side and exact complete immutable provenance on save',async()=>{
 const f=await fixture(),p=await loadCompare(f.inputs),state=join(f.root,'state');const input={...freshCompareSession(p),status:'changes-requested',feedback:[note()]};const saved=await saveCompareSession(p,input,state);expect(saved.feedback[0]?.side).toBe('b');expect(saved.binding).toEqual(p.response.binding);expect(saved.updatedAt).toBeString();expect((await readCompareSession(p,state)).binding).toEqual(p.response.binding);
 for(const side of [undefined,'both','c'])expect(()=>parseCompareSession({...input,feedback:[{...note(),side}]},p)).toThrow('feedback.side');
 for(const binding of [{...p.response.binding,a:{...p.response.binding.a,sourceHash:'forged'}},{...p.response.binding,b:{...p.response.binding.b,reviewedSource:{...p.response.binding.b.reviewedSource,motion:null}}},{...p.response.binding,reference:{...p.response.binding.reference,sha256:'forged'}},{...p.response.binding,animation:'other'}])expect(()=>parseCompareSession({...input,binding},p)).toThrow('session.binding');
 expect(()=>parseCompareSession({...input,feedback:[note(),note()]},p)).toThrow('duplicate ids');
});
test('changing A or B model page, motion, model, or reference refuses both read and save',async()=>{
 for(const path of ['a/build/page.png','b/build/page.png','a/motion.json','b/motion.json','a/build/skeleton.model.json','b/build/skeleton.model.json','ref.mp4']){const f=await fixture(),p=await loadCompare(f.inputs),file=join(f.root,path),old=await readFile(file,'utf8');await writeFile(file,old+' ');await expect(assertCompareUnchanged(p)).rejects.toThrow('inputs changed');await expect(saveCompareSession(p,{...freshCompareSession(p),feedback:[note()]},join(f.root,'state'))).rejects.toThrow('inputs changed');await expect(readCompareSession(p,join(f.root,'state'))).rejects.toThrow('inputs changed');}
});
test('comparison refuses missing rig, animation, external package symlink and non-video reference',async()=>{
 const f=await fixture();await writeFile(join(f.root,'ref.txt'),'bytes');await expect(loadCompare({...f.inputs,reference:join(f.root,'ref.txt')})).rejects.toThrow('compare.reference');await rm(join(f.root,'a/build/skeleton.model.json'));await expect(loadCompare(f.inputs)).rejects.toThrow('compare.a.model');
 const other=await fixture();await rm(join(other.root,'a/build/page.png'));await symlink(join(other.root,'ref.mp4'),join(other.root,'a/build/page.png'));await expect(loadCompare(other.inputs)).rejects.toThrow('symlinks may not escape');
});
test('comparison animation refusal identifies each invalid side independently of parallel read order',async()=>{
 for(const side of ['a','b'] as const){const f=await fixture(),other=side==='a'?'b':'a',modelPath=join(f.root,other,'build/skeleton.model.json'),model=JSON.parse(await readFile(modelPath,'utf8'));model.animations.push({name:'only-other-side',duration:2});await writeFile(modelPath,JSON.stringify(model));await expect(loadCompare({...f.inputs,animation:'only-other-side'})).rejects.toThrow(`compare.${side}.animation: model has no animation "only-other-side"`);}
});
test('compare HTTP isolates sides and reference, guards mutations and detects delayed changed input',async()=>{
 const f=await fixture(),p=await loadCompare(f.inputs);const server=await startCompareServer(p,{port:0,stateDir:join(f.root,'state')});const base=`http://127.0.0.1:${server.port}`;try{
  const response=await fetch(base+'/api/compare');expect(response.status).toBe(200);expect((await response.json()).binding).toEqual(p.response.binding);expect((await fetch(base+'/api/review')).status).toBe(404);expect((await fetch(base+'/api/compare/session')).status).toBe(200);expect((await fetch(base+'/api/compare',{headers:{Host:'evil.test'}})).status).toBe(403);
  expect(await (await fetch(base+'/compare-assets/a/build/page.png')).text()).toBe('a page bytes');expect(await (await fetch(base+'/compare-assets/b/build/page.png')).text()).toBe('b page bytes');expect((await fetch(base+'/compare-assets/c/build/page.png')).status).toBe(404);expect((await fetch(base+'/compare-assets/a/not-declared')).status).toBe(404);expect((await fetch(base+'/compare-reference/secret')).status).toBe(404);expect((await fetch(base+'/api/file?path=/etc/passwd')).status).toBe(404);expect((await fetch(base+'/compare-assets/a/%252e%252e/ref.mp4')).status).toBe(400);
  const video=await fetch(base+'/compare-reference',{headers:{Range:'bytes=2-5'}});expect(video.status).toBe(206);expect(video.headers.get('content-range')).toBe('bytes 2-5/10');expect(await video.text()).toBe('2345');expect((await fetch(base+'/compare-reference',{headers:{Range:'bytes=99-100'}})).status).toBe(416);
  const input={...freshCompareSession(p),feedback:[note()]},headers={Origin:base,'Content-Type':'application/json'};expect((await fetch(base+'/api/compare/session',{method:'PUT',headers:{...headers,Origin:'http://evil.test'},body:JSON.stringify(input)})).status).toBe(403);expect((await fetch(base+'/api/compare/session',{method:'PUT',headers:{...headers,'Content-Type':'text/plain'},body:'{}'})).status).toBe(400);expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify({padding:'x'.repeat(1024*1024)})})).status).toBe(400);expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify({...input,feedback:[{...note(),side:'both'}]})})).status).toBe(400);
  expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify(input)})).status).toBe(200);const stored=await(await fetch(base+'/api/compare/session')).json();expect(stored.feedback[0].side).toBe('b');expect(stored.binding).toEqual(p.response.binding);
  const body=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(new TextEncoder().encode('{'));await Bun.sleep(20);await writeFile(join(f.root,'b/motion.json'),'changed');controller.enqueue(new TextEncoder().encode(JSON.stringify(input).slice(1)));controller.close();}});expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body})).status).toBe(409);expect((await fetch(base+'/api/compare')).status).toBe(409);
 }finally{await server.stop(true);}
});
test('compare check and feedback CLI preserve single-mode syntax and require explicit inputs',async()=>{
 const f=await fixture();for(const command of ['check','feedback']){const proc=Bun.spawn([process.execPath,'src/cli.ts',command,'compare',f.inputs.a,f.inputs.b,'--reference',f.inputs.reference,'--animation','inspect'],{stdout:'pipe',stderr:'pipe'});const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);if(command==='check')expect(output).toContain('Playback: two compiled models present');else{const session=JSON.parse(output);expect(session.schema).toBe('rig-review-compare-session/1');expect(session.status).toBe('pending');expect(session.updatedAt).toBeNull();}}
 const missing=Bun.spawn([process.execPath,'src/cli.ts','check','compare',f.inputs.a,f.inputs.b],{stdout:'pipe',stderr:'pipe'});expect(await missing.exited).toBe(1);expect(await new Response(missing.stderr).text()).toContain('--reference and --animation are required');
});
test('reference GET, HEAD and ranges refuse replaced leaf or parent symlinks',async()=>{
 for(const replace of ['leaf','parent']){const f=await fixture();const referenceDir=join(f.root,'reference'),outside=join(f.root,'outside');await mkdir(referenceDir);await mkdir(outside);await writeFile(join(referenceDir,'ref.mp4'),'selected bytes');await writeFile(join(outside,'ref.mp4'),'OUTSIDE SECRET');const p=await loadCompare({...f.inputs,reference:join(referenceDir,'ref.mp4')});const server=await startCompareServer(p,{port:0,stateDir:join(f.root,'state')});try{
   if(replace==='leaf'){await rm(join(referenceDir,'ref.mp4'));await symlink(join(outside,'ref.mp4'),join(referenceDir,'ref.mp4'));}else{await rename(referenceDir,referenceDir+'-original');await symlink(outside,referenceDir);}
   for(const init of [{method:'GET'},{method:'HEAD'},{headers:{Range:'bytes=0-6'}}]){const response=await fetch(`http://127.0.0.1:${server.port}/compare-reference`,init);expect(response.status).toBe(400);expect(await response.text()).not.toContain('OUTSIDE SECRET');}
 }finally{await server.stop(true);}}
});


test('comparison reference refuses same-size overwritten and atomically replaced bytes for GET/HEAD/ranges',async()=>{
 for(const replacement of ['overwrite','atomic']){const f=await fixture(),p=await loadCompare(f.inputs),server=await startCompareServer(p,{port:0,stateDir:join(f.root,'state')}),url=`http://127.0.0.1:${server.port}/compare-reference`;try{
  await utimes(f.inputs.reference,new Date(0),new Date(1000));const original=await fetch(url,{headers:{Range:'bytes=2-5'}});expect(original.status).toBe(206);expect(await original.text()).toBe('2345');expect((await fetch(url,{method:'HEAD'})).status).toBe(200);
  if(replacement==='overwrite')await writeFile(f.inputs.reference,'9876543210');else{await writeFile(f.inputs.reference+'.next','9876543210');await rename(f.inputs.reference+'.next',f.inputs.reference);}await utimes(f.inputs.reference,new Date(0),new Date(1000));
  for(const init of [{method:'GET'},{method:'HEAD'},{headers:{Range:'bytes=2-5'}}]){const response=await fetch(url,init);expect(response.status).toBe(409);if(init.method!=='HEAD')expect(await response.text()).not.toContain('9876543210');}
 }finally{await server.stop(true);}}
});
