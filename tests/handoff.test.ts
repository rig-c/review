import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {assertReviewUnchanged} from '../src/reference.ts';
import {readSession,saveSession,sessionFile,freshSession} from '../src/session.ts';
import {startServer} from '../src/server.ts';
import {DISCOVERY_PLACES,MODELING_INPUT_UNAVAILABLE,resolveHandoff,HandoffError} from '../src/handoff.ts';
import {assertWholeRigBaseline,BaselineError,compareBaseline,firstDifference,rigTree,type BaselineResult} from '../src/baseline.ts';
import {loadOpenPackage,openKey,openFingerprint} from '../src/open.ts';
import {handoffText} from '../web/rebuild-client.ts';

const config={key:'k',motion:{animations_from:'clips.json'},meshes:{topwear:{contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,bridges:true,regions:[{name:'bust',shape:'circle',cx:414,cy:342,r:50,bone:'chest_jiggle',spacing:13,band:30}]},r:15}}};
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** A stand-in `rig-parts rig` (copies <parts>/rig to --out; FAKE_PERTURB writes a different rig.json) and `rigc`. */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));if(process.env.FAKE_PERTURB)fs.writeFileSync(path.join(out,'rig.json'),'{"perturbed":true}');console.log('rig-parts rig: wrote');process.exit(0);}
process.exit(3);`;
async function install(root:string){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),'process.exit(0)');
}
/** `rig-parts build` output at `<base>/<out>`: parts.json, parts/a.png, rig/{rig,motion,mesh_report}.json. */
async function buildOutput(dir:string){
 await mkdir(join(dir,'rig'),{recursive:true});await mkdir(join(dir,'parts'),{recursive:true});
 await writeFile(join(dir,'parts.json'),JSON.stringify({parts:[{name:'a'}]}));await writeFile(join(dir,'parts/a.png'),'png-a');
 for(const name of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(dir,'rig',name),`{"${name}":1}`);
}
async function scratch(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-handoff-')));return {root,state:join(root,'state'),done:()=>rm(root,{recursive:true,force:true})};}
/** A folder-adapter package (motion.json is recognized) with its config at `configAt` and build output under `out`. */
async function pkg(root:string,configAt:'config.json'|'rig/config.json'){
 const dir=join(root,'pkg'),cfg=join(dir,configAt),base=join(cfg,'..');await mkdir(base,{recursive:true});
 await writeFile(join(dir,'motion.json'),'{}');await writeFile(cfg,JSON.stringify(config,null,1));await writeFile(join(base,'clips.json'),'{"clips":1}');await buildOutput(join(base,'out'));
 return dir;
}
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}

test('discovery order: config.json, then rig/config.json inside the folder; the record hashes the config, what it names, parts.json, parts and the rig',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json');let p=await loadReview(dir);
  expect(p.reviewedSource.handoff).toEqual({schema:'rig-review-handoff/1',how:'discovered',via:'discovery',outside:false,config:{path:'rig/config.json',sha256:sha(await readFile(join(dir,'rig/config.json')))},parts:'rig/out',rig:'rig/out/rig',source:null,full:null,head:null,
   files:['rig/clips.json','rig/config.json','rig/out/parts.json','rig/out/parts/a.png','rig/out/rig/mesh_report.json','rig/out/rig/motion.json','rig/out/rig/rig.json'].map(path=>({path,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})),missing:[]});
  // config.json comes first when both exist.
  await writeFile(join(dir,'config.json'),JSON.stringify({key:'root'}));p=await loadReview(dir);
  expect(p.reviewedSource.handoff?.config.path).toBe('config.json');expect(p.reviewedSource.handoff?.missing).toEqual(['parts out']);
 }finally{await s.done();}
});

test('discovery\'s last step: ../config.json beside an opened out/ is named discovered and outside, with its path and hash; never beside any other folder',async()=>{
 const s=await scratch();
 try{
  const base=join(s.root,'proj');await mkdir(base);await writeFile(join(base,'config.json'),JSON.stringify(config));await writeFile(join(base,'clips.json'),'{}');await buildOutput(join(base,'out'));await writeFile(join(base,'out/motion.json'),'{}');
  const p=await loadReview(join(base,'out'));
  expect(p.reviewedSource.handoff).toMatchObject({how:'discovered',outside:true,config:{path:'../config.json',sha256:sha(await readFile(join(base,'config.json')))},parts:'.',rig:'rig',missing:[]});
  expect(p.reviewedSource.handoff!.files.map(f=>f.path)).toEqual(['../clips.json','../config.json','parts.json','parts/a.png','rig/mesh_report.json','rig/motion.json','rig/rig.json']);
  expect(handoffText({handoff:p.reviewedSource.handoff!,baseline:null,reason:null}).text).toStartWith('Handoff discovered outside the opened folder: ../config.json sha256 ');
  // The same layout opened under another name is not an out/: nothing outside the folder is looked at.
  const other=join(s.root,'proj2');await mkdir(other);await writeFile(join(other,'config.json'),'{}');await mkdir(join(other,'build'));await writeFile(join(other,'build/motion.json'),'{}');
  const none=await loadReview(join(other,'build'));expect(none.reviewedSource.handoff).toBeUndefined();expect(none.handoffReason).toBe(MODELING_INPUT_UNAVAILABLE);
 }finally{await s.done();}
});

test('nothing found: MODELING_INPUT_UNAVAILABLE names the three places and the declaration; the identity stays the pre-handoff one',async()=>{
 const s=await scratch();
 try{
  const dir=join(s.root,'bare');await mkdir(dir);await writeFile(join(dir,'motion.json'),'{}');const p=await loadReview(dir);
  expect(p.handoff).toBeNull();expect('handoff' in p.reviewedSource).toBe(false);
  expect(p.handoffReason).toBe('MODELING_INPUT_UNAVAILABLE: config.json — looked at config.json, rig/config.json, ../config.json (beside an opened out/); declare it with rig-review open <dir> --config <path> [--parts <dir>] or the review.json "producer" block');
  for(const place of DISCOVERY_PLACES)expect(p.handoffReason).toContain(place);
 }finally{await s.done();}
});

test('declared wins over discovery: --config beats the review.json producer block, which beats config.json',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'config.json');await mkdir(join(dir,'alt'));await writeFile(join(dir,'alt/config.json'),JSON.stringify({key:'alt'}));await writeFile(join(dir,'alt/cli.json'),JSON.stringify({key:'cli'}));
  await writeFile(join(dir,'review.json'),JSON.stringify({schema:'rig-review/1',id:'p',title:'P',revision:'1',motion:'motion.json',producer:{config:'alt/config.json',parts:'out'}}));
  const block=await loadReview(dir);expect(block.reviewedSource.handoff).toMatchObject({how:'declared',via:'review.json producer',config:{path:'alt/config.json'},parts:'out',rig:'out/rig'});
  const flag=await loadReview(dir,{handoff:{config:join(dir,'alt/cli.json'),parts:join(dir,'out')}});expect(flag.reviewedSource.handoff).toMatchObject({how:'declared',via:'open --config',config:{path:'alt/cli.json'}});
  expect(flag.handoffInputs).toEqual({config:join(dir,'alt/cli.json'),parts:join(dir,'out')});
  await expect(loadReview(dir,{handoff:{config:join(dir,'alt/cli.json'),source:join(dir,'motion.json')}})).rejects.toThrow('HANDOFF_FLAGS_INVALID --source');
 }finally{await s.done();}
});

test('bar 2: a handoff path outside its root, or a symlink that leaves it, is refused by name',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'config.json'),outside=join(s.root,'outside.json');await writeFile(outside,'{}');
  const refused=async(run:()=>Promise<unknown>,code:string,field:string)=>{const error=await run().then(()=>null,e=>e);expect(error).toBeInstanceOf(HandoffError);expect({code:(error as HandoffError).code,field:(error as HandoffError).field}).toEqual({code,field});};
  await refused(()=>loadReview(dir,{handoff:{config:outside}}),'HANDOFF_PATH_OUTSIDE_ROOT','--config');
  await symlink(outside,join(dir,'escape.json'));
  await refused(()=>loadReview(dir,{handoff:{config:join(dir,'escape.json')}}),'HANDOFF_SYMLINK_ESCAPE','--config');
  await refused(()=>loadReview(dir,{handoff:{config:join(dir,'config.json'),parts:s.root}}),'HANDOFF_PATH_OUTSIDE_ROOT','--parts');
  const manifest=(producer:unknown)=>writeFile(join(dir,'review.json'),JSON.stringify({schema:'rig-review/1',id:'p',title:'P',revision:'1',motion:'motion.json',producer}));
  await manifest({config:'../outside.json'});await refused(()=>loadReview(dir),'HANDOFF_PATH_OUTSIDE_ROOT','producer.config');
  await manifest({config:'escape.json'});await refused(()=>loadReview(dir),'HANDOFF_SYMLINK_ESCAPE','producer.config');
  await rm(join(dir,'review.json'));
  // Discovered: a config.json that is a symlink out of the folder is refused, never followed or skipped.
  await rm(join(dir,'config.json'));await symlink(outside,join(dir,'config.json'));await refused(()=>loadReview(dir),'HANDOFF_SYMLINK_ESCAPE','config.json');
  // A file the config names must stay inside the root too.
  await rm(join(dir,'config.json'));await writeFile(join(dir,'config.json'),JSON.stringify({motion:{animations_from:'../outside.json'}}));await refused(()=>loadReview(dir),'HANDOFF_PATH_OUTSIDE_ROOT','config motion.animations_from');
  // The ../config.json step accepts only the regular file beside out/, not a symlink there.
  const base=join(s.root,'proj');await mkdir(join(base,'out'),{recursive:true});await writeFile(join(base,'out/motion.json'),'{}');await symlink(outside,join(base,'config.json'));
  await refused(()=>loadReview(join(base,'out')),'HANDOFF_SYMLINK_ESCAPE','../config.json');
 }finally{await s.done();}
});

test('bar 3: changing the config bytes starts a new pending session; the old binding refuses as changed',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json'),before=await loadReview(dir);
  await saveSession(before,{...freshSession(before),status:'approved'},s.state);expect((await readSession(before,s.state)).status).toBe('approved');
  await writeFile(join(dir,'rig/config.json'),JSON.stringify({...config,key:'changed'},null,1));
  const after=await loadReview(dir);
  expect(after.sourceHash).toBe(before.sourceHash);// the package bytes are the same; only the handoff changed
  expect(sessionFile(after,s.state)).not.toBe(sessionFile(before,s.state));
  expect((await readSession(after,s.state)).status).toBe('pending');
  await expect(assertReviewUnchanged(before)).rejects.toThrow('Package inputs changed');
  // A parts file counts the same way.
  const again=await loadReview(dir);await writeFile(join(dir,'rig/out/parts/a.png'),'png-a2');expect(sessionFile(await loadReview(dir),s.state)).not.toBe(sessionFile(again,s.state));
 }finally{await s.done();}
});

test('open identity: the same handoff gives the same key; a changed config gives another; flags are canonical',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'config.json'),fp=await openFingerprint();
  const one=await loadOpenPackage({input:dir,config:join(dir,'config.json')}),two=await loadOpenPackage({input:dir,config:join(dir,'config.json')});
  expect(openKey(one,fp)).toBe(openKey(two,fp));expect(one.inputs.config).toBe(join(dir,'config.json'));
  expect(openKey(await loadOpenPackage({input:dir}),fp)).not.toBe(openKey(one,fp));// discovered vs declared are different identities
  await writeFile(join(dir,'config.json'),JSON.stringify({key:'x'}));expect(openKey(await loadOpenPackage({input:dir,config:join(dir,'config.json')}),fp)).not.toBe(openKey(one,fp));
 }finally{await s.done();}
});

test('baseline comparison: the first differing path in sorted order; reproduced only when every rig output matches',()=>{
 const a={'rig.json':'1','motion.json':'2','images/a.png':'3'};
 expect(firstDifference(a,{...a})).toBeNull();
 expect(firstDifference({...a,'rig.json':'x'},a)).toBe('rig.json');
 expect(firstDifference(a,{...a,'images/b.png':'4'})).toBe('images/b.png');
 expect(firstDifference(a,{...a,'notes.txt':'5'})).toBeNull();expect(firstDifference({...a,'sets.json':'6'},a)).toBe('sets.json');
 expect(firstDifference({},{})).toBe('rig.json');
 const result=(status:BaselineResult['status'],first:string|null):BaselineResult=>({schema:'rig-review-baseline/1',key:'k',status,producer:{package:'@rig-c/parts',version:'1.42.0'},firstDifference:first,hashes:null,line:'',exitCode:0,wallMs:1});
 expect(()=>assertWholeRigBaseline(result('reproduced',null))).not.toThrow();
 expect(()=>assertWholeRigBaseline(result('not-reproduced','rig/out/rig/rig.json'))).toThrow('EDIT_BASELINE_MISMATCH: rig/out/rig/rig.json');
 expect(()=>assertWholeRigBaseline(null)).toThrow(BaselineError);
});

test('bar 1 + bar 4: the baseline reproduces the inspected rig with both hashes; a perturbed rig.json is EDIT_BASELINE_MISMATCH naming it; the package is unchanged',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json');await install(s.root);const before=await treeMd5(dir);
  const p=await loadReview(dir),server=await startServer(p,{port:0,stateDir:s.state,cwd:s.root}),base=`http://127.0.0.1:${server.port}`;
  try{
   const status=await (await fetch(base+'/api/rebuild')).json();expect(status.baseline.status).toBe('running');expect(status.handoff.config.path).toBe('rig/config.json');
   const review=await (await fetch(base+'/api/review')).json();expect(review.reviewedSource.handoff).toEqual(p.reviewedSource.handoff);expect(JSON.stringify(review)).not.toContain(s.root);
   let settled=status.baseline;for(let i=0;settled.status==='running'&&i<200;i++){await Bun.sleep(25);settled=(await (await fetch(base+'/api/rebuild')).json()).baseline;}
   const inspected=sha(await readFile(join(dir,'rig/out/rig/rig.json')));
   expect(settled).toMatchObject({status:'reproduced',firstDifference:null,hashes:{baseline:{rigJson:inspected},inspected:{rigJson:inspected}}});
   expect(settled.hashes.baseline.tree).toBe(settled.hashes.inspected.tree);expect(settled.line).toStartWith('baseline: reproduced — rig.json ');
   expect(await readdir(join(s.state,'baseline'))).toEqual([settled.key]);
   // Perturbed: the producer's rig.json differs from the inspected one.
   const out=join(s.state,'baseline',settled.key,'baseline');await writeFile(join(out,'rig.json'),'{"perturbed":true}');
   const compared=await compareBaseline(out,join(dir,'rig/out/rig'),rel=>`rig/out/rig/${rel}`);
   expect(compared).toMatchObject({status:'not-reproduced',firstDifference:'rig/out/rig/rig.json'});
   expect(()=>assertWholeRigBaseline({...settled,...compared})).toThrow('EDIT_BASELINE_MISMATCH: rig/out/rig/rig.json');
  }finally{await server.stop(true);}
  // A fresh session whose producer writes a different rig.json: not reproduced, by name.
  await rm(join(s.state,'baseline'),{recursive:true});process.env.FAKE_PERTURB='1';
  const again=await startServer(await loadReview(dir),{port:0,stateDir:s.state,cwd:s.root});
  try{
   await fetch(`http://127.0.0.1:${again.port}/api/rebuild`);let b=(await (await fetch(`http://127.0.0.1:${again.port}/api/rebuild`)).json()).baseline;
   for(let i=0;b.status==='running'&&i<200;i++){await Bun.sleep(25);b=(await (await fetch(`http://127.0.0.1:${again.port}/api/rebuild`)).json()).baseline;}
   expect(b).toMatchObject({status:'not-reproduced',firstDifference:'rig/out/rig/rig.json',line:expect.stringMatching(/^baseline: not reproduced — rig\/out\/rig\/rig\.json · /)});
  }finally{delete process.env.FAKE_PERTURB;await again.stop(true);}
  expect(await treeMd5(dir)).toBe(before);
  expect(await rigTree(join(dir,'rig/out/rig'))).toEqual({'rig.json':expect.any(String),'motion.json':expect.any(String),'mesh_report.json':expect.any(String)});
 }finally{await s.done();}
},20000);

test('without any handoff, Apply refuses MODELING_HANDOFF_MISSING naming --config; the bar shows MODELING_INPUT_UNAVAILABLE',async()=>{
 const s=await scratch();
 try{
  const dir=join(s.root,'bare');await mkdir(dir);await writeFile(join(dir,'motion.json'),'{}');await install(s.root);
  const server=await startServer(await loadReview(dir),{port:0,stateDir:s.state,cwd:s.root}),base=`http://127.0.0.1:${server.port}`;
  try{
   const status=await (await fetch(base+'/api/rebuild')).json();expect(status).toMatchObject({available:false,handoff:null,baseline:null,reason:MODELING_INPUT_UNAVAILABLE});
   expect(handoffText(status)).toEqual({text:MODELING_INPUT_UNAVAILABLE,error:true});
   const refused=await (await fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({part:'topwear',regions:[config.meshes.topwear.contour.regions[0]],configHash:'a'.repeat(64)})})).json();
   expect(refused.status).toBe('refused');expect(refused.error).toStartWith('MODELING_HANDOFF_MISSING: no producer handoff — declare it with rig-review open <dir> --config <path>');
   expect(await Bun.file(join(s.state,'baseline')).exists()).toBe(false);
  }finally{await server.stop(true);}
 }finally{await s.done();}
});

test('resolveHandoff is the one lookup: the same root and inputs give the same record',async()=>{
 const s=await scratch();
 try{const dir=await pkg(s.root,'rig/config.json');const a=await resolveHandoff(dir,undefined,undefined),b=await resolveHandoff(dir,undefined,undefined);expect(a.handoff!.record).toEqual(b.handoff!.record);}
 finally{await s.done();}
});
