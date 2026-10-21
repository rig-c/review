import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCheckPackage,loadReview,UnrecognizedOutputError} from '../src/manifest.ts';
import {BUILD_DISCOVERY_PLACES,BUILD_MODELING_INPUT_UNAVAILABLE,HandoffError,isBuildRoot,MODELING_INPUT_UNAVAILABLE} from '../src/handoff.ts';
import {buildOpenDiagnostic,loadOpenPackage,openKey} from '../src/open.ts';
import {sessionFile} from '../src/session.ts';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const config={key:'k',motion:{animations_from:'clips.json'}};
async function scratch(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-build-root-')));return {root,done:()=>rm(root,{recursive:true,force:true})};}
/** What `rig-parts build --config <proj>/config.json --out <proj>/out` leaves: the config beside out/, and out/ with parts, rig and the check package. */
async function built(root:string,name='proj'){
 const proj=join(root,name),out=join(proj,'out');
 await mkdir(join(out,'rig'),{recursive:true});await mkdir(join(out,'parts'),{recursive:true});await mkdir(join(out,'check/build'),{recursive:true});await mkdir(join(proj,'inputs'),{recursive:true});
 await writeFile(join(proj,'config.json'),JSON.stringify(config));await writeFile(join(proj,'clips.json'),'{}');await writeFile(join(proj,'inputs/painting.png'),'png');
 await writeFile(join(out,'parts.json'),JSON.stringify({parts:[{name:'a'}]}));await writeFile(join(out,'parts/a.png'),'png-a');
 for(const file of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(out,'rig',file),`{"${file}":1}`);
 await writeFile(join(out,'check/build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],animations:[{name:'idle',duration:1}]}));await writeFile(join(out,'check/build/skeleton.png'),'png');
 return {proj,out,check:join(out,'check')};
}
const refusal=async(run:()=>Promise<unknown>)=>{const error=await run().then(()=>null,e=>e);expect(error).toBeInstanceOf(HandoffError);return {code:(error as HandoffError).code,field:(error as HandoffError).field};};

test('a rig-parts build root opens as its check package, with the same identity as opening check/ itself',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root);
  expect(await isBuildRoot(b.out)).toBe(true);expect(await buildCheckPackage(b.out)).toBe(b.check);
  const viaOut=await loadReview(b.out),viaCheck=await loadReview(b.check);
  expect(viaOut.root).toBe(b.check);expect(viaOut.manifestPath).toBe(b.check);
  expect(viaOut.sourceHash).toBe(viaCheck.sourceHash);expect(viaOut.reviewedSource).toEqual(viaCheck.reviewedSource);expect(sessionFile(viaOut,'/state')).toBe(sessionFile(viaCheck,'/state'));
  expect(viaOut.manifest.model).toBe('build/skeleton.model.json');
  const one=await loadOpenPackage({input:b.out}),two=await loadOpenPackage({input:b.check});
  expect(one.inputs.input).toBe(b.check);expect(openKey(one,'fp')).toBe(openKey(two,'fp'));
 }finally{await s.done();}
});

test('the producer\'s own config beside the build root is discovered outside the opened folder, with its path and hash; parts are the build root',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root),p=await loadReview(b.out);
  expect(p.reviewedSource.handoff).toEqual({schema:'rig-review-handoff/1',how:'discovered',via:'discovery',outside:true,config:{path:'../../config.json',sha256:sha(await readFile(join(b.proj,'config.json')))},parts:'..',rig:'../rig',source:null,full:null,head:null,
   files:['../../clips.json','../../config.json','../parts.json','../parts/a.png','../rig/mesh_report.json','../rig/motion.json','../rig/rig.json'].map(path=>({path,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})),missing:[]});
  expect(p.handoff!.config).toBe(join(b.proj,'config.json'));expect(p.handoff!.parts).toBe(b.out);expect(p.handoff!.root).toBe(b.proj);
  // A config.json in the build root itself comes first, rooted there.
  await writeFile(join(b.out,'config.json'),JSON.stringify({key:'in-out'}));
  const inside=await loadReview(b.out);expect(inside.reviewedSource.handoff).toMatchObject({how:'discovered',outside:true,config:{path:'../config.json'},parts:'..',rig:'../rig'});expect(inside.handoff!.root).toBe(b.out);
  // The in-folder steps still come first: a config.json inside check/ is taken as before.
  await writeFile(join(b.check,'config.json'),JSON.stringify({key:'in-check'}));
  expect((await loadReview(b.out)).reviewedSource.handoff).toMatchObject({outside:false,config:{path:'config.json'},parts:null});
 }finally{await s.done();}
});

test('the build\'s own config may be declared with --config; its folder becomes the root for the other flags',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root);
  const p=await loadReview(b.check,{handoff:{config:join(b.proj,'config.json'),source:join(b.proj,'inputs/painting.png'),full:join(b.proj,'inputs')}});
  expect(p.reviewedSource.handoff).toMatchObject({how:'declared',via:'open --config',outside:true,config:{path:'../../config.json'},parts:'..',source:{path:'../../inputs/painting.png'},full:'../../inputs'});
  // Written relative to the working directory: the same file, the same record.
  const relative=await loadReview(b.out,{handoff:{config:resolve(b.check,'../../config.json')}});expect(relative.reviewedSource.handoff!.config.path).toBe('../../config.json');
 }finally{await s.done();}
});

test('bar 2: a config neither declared at nor discovered in one of those places is still HANDOFF_PATH_OUTSIDE_ROOT; other mutants refuse by name',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root);
  // Another file in the build's parent, a config one level further up, and another project's config: outside the root.
  await writeFile(join(b.proj,'other.json'),'{}');await writeFile(join(s.root,'config.json'),'{}');const elsewhere=await built(s.root,'proj2');
  for(const path of [join(b.proj,'other.json'),join(s.root,'config.json'),join(elsewhere.proj,'config.json')])expect(await refusal(()=>loadReview(b.out,{handoff:{config:path}}))).toEqual({code:'HANDOFF_PATH_OUTSIDE_ROOT',field:'--config'});
  // The build's own config does not open the root for a flag that leaves its folder.
  expect(await refusal(()=>loadReview(b.out,{handoff:{config:join(b.proj,'config.json'),keypoints:join(s.root,'config.json')}}))).toEqual({code:'HANDOFF_PATH_OUTSIDE_ROOT',field:'--keypoints'});
  // A config further up is never discovered: nothing at the two places is the build reason, not a widened search.
  await rm(join(b.proj,'config.json'));const none=await loadReview(b.out);
  expect(none.reviewedSource.handoff).toBeUndefined();expect(none.handoffReason).toBe(BUILD_MODELING_INPUT_UNAVAILABLE);for(const place of BUILD_DISCOVERY_PLACES)expect(none.handoffReason).toContain(place);
  // A symlink at the place is refused, never followed (even one that points at a file inside the folder).
  await symlink(join(b.proj,'other.json'),join(b.proj,'config.json'));
  expect(await refusal(()=>loadReview(b.out))).toEqual({code:'HANDOFF_SYMLINK_ESCAPE',field:'../../config.json'});
  expect(await refusal(()=>loadReview(b.out,{handoff:{config:join(b.proj,'config.json')}}))).toEqual({code:'HANDOFF_SYMLINK_ESCAPE',field:'--config'});
 }finally{await s.done();}
});

test('only a rig-parts build root is recognised: each missing build file, a symlinked check/, or a folder with its own model keeps the old behaviour',async()=>{
 const s=await scratch();
 try{
  for(const [name,mutate] of [['no-parts',(o:string)=>rm(join(o,'parts.json'))],['no-rig',(o:string)=>rm(join(o,'rig/rig.json'))],['no-model',(o:string)=>rm(join(o,'check/build/skeleton.model.json'))]] as const){
   const b=await built(s.root,name);await mutate(b.out);
   expect(await isBuildRoot(b.out)).toBe(false);await expect(loadReview(b.out)).rejects.toBeInstanceOf(UnrecognizedOutputError);
  }
  // check/ as a symlink to a real check package elsewhere is not the build's own.
  const real=await built(s.root,'real'),linked=await built(s.root,'linked');await rm(linked.check,{recursive:true});await symlink(real.check,linked.check);
  expect(await isBuildRoot(linked.out)).toBe(false);await expect(loadReview(linked.out)).rejects.toBeInstanceOf(UnrecognizedOutputError);
  // A build root that is also a package (the copied build/ of docs/LIVE_FIXTURE.md) opens as itself.
  const own=await built(s.root,'own');await mkdir(join(own.out,'build'));await writeFile(join(own.out,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[]}));
  expect(await buildCheckPackage(own.out)).toBeNull();expect((await loadReview(own.out)).root).toBe(own.out);
  // A check/ copied out of its build has no build around it: the old discovery and reason.
  const lone=join(s.root,'lone/check');await mkdir(join(lone,'build'),{recursive:true});await writeFile(join(lone,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[]}));await writeFile(join(s.root,'lone/config.json'),'{}');
  const p=await loadReview(lone);expect(p.reviewedSource.handoff).toBeUndefined();expect(p.handoffReason).toBe(MODELING_INPUT_UNAVAILABLE);
 }finally{await s.done();}
});

test('bar 3: an existing package records what it recorded — the fixture layout and the bundled demo are not redirected',async()=>{
 const s=await scratch();
 try{
  // docs/LIVE_FIXTURE.md: the package folder holds build/, config.json and out/; it stays the package and discovers config.json inside.
  const b=await built(s.root);await mkdir(join(b.proj,'build'));await writeFile(join(b.proj,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[]}));
  const p=await loadReview(b.proj);expect(p.root).toBe(b.proj);
  expect(p.reviewedSource.handoff).toMatchObject({how:'discovered',outside:false,config:{path:'config.json'},parts:'out',rig:'out/rig',missing:[]});
  const demo=await loadReview(join(import.meta.dir,'../examples/demo'));expect(demo.root).toBe(await realpath(join(import.meta.dir,'../examples/demo')));expect('handoff' in demo.reviewedSource).toBe(false);expect(demo.handoffReason).toBe(MODELING_INPUT_UNAVAILABLE);
 }finally{await s.done();}
});

test('open\'s stderr diagnostic names the check package and the config it took with its full hash',()=>{
 const hash='a'.repeat(64);
 expect(buildOpenDiagnostic({package:'/p/out/check',handoff:{schema:'rig-review-handoff/1',how:'discovered',via:'discovery',outside:true,config:{path:'../../config.json',sha256:hash},parts:'..',rig:'../rig',source:null,full:null,head:null,files:[],missing:[]},reason:null}))
  .toBe(`Package: rig-parts build check package /p/out/check\nHandoff discovered outside the opened folder: ../../config.json sha256 ${hash} · parts ..`);
 expect(buildOpenDiagnostic({package:'/p/out/check',handoff:null,reason:BUILD_MODELING_INPUT_UNAVAILABLE})).toBe(`Package: rig-parts build check package /p/out/check\nHandoff: ${BUILD_MODELING_INPUT_UNAVAILABLE}`);
});
