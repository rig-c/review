import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {assertReviewUnchanged} from '../src/reference.ts';
import {readSession,saveSession,sessionFile,freshSession} from '../src/session.ts';
import {startServer} from '../src/server.ts';
import producerPins from './fixtures/correction-producer-pins.json';
import {CONFIG_NAMED_FILES,CONFIG_SKELETON_NAMES,configNamedReferences,DIRECTORY_INPUT_RECEIPT,DISCOVERY_PLACES,findInstalledParts,locateInstalledParts,MODELING_INPUT_UNAVAILABLE,plateReceiptSpec,resolveHandoff,HandoffError} from '../src/handoff.ts';
import {MODELING_PRODUCER_NOT_INSTALLED} from '../src/producer.ts';
import {assertNamedFilesHeld,handoffGap,producerInputs,scratchConfigText} from '../src/rebuild.ts';
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

const literalStrings=(source:string)=>[...source.matchAll(/'([^']+)'/g)].map(match=>match[1]!);
function producerLoaderFields(source:string):string[]{
 const table=/^const CONFIG_FILE_FIELDS = \{([\s\S]*?)^} as const;/m.exec(source)?.[1];
 if(table)return [...table.matchAll(/path: \[([^\]]+)\]/g)].map(match=>literalStrings(match[1]!).join('.')).sort();
 // 1.78.0 had the same three file reads inline, before the shared table existed.
 const req=/checkRequirementsFile\(c, resolve\(base, t\.([a-z_]+)\)\)/.exec(source)?.[1];
 const anim=/const from = isPlainObject\(t\.\w+\) \? t\.([a-z_.]+) : undefined/.exec(source)?.[1];
 const generation=/poseBeside\(c, t\.([a-z_]+), base\)/.exec(source)?.[1];
 const skeleton=/const skel = gen\.([a-z_.]+);/.exec(source)?.[1];
 if(!req||!anim||!generation||!skeleton||!source.includes('readAnimationsFrom(c, base, from)')||
    !source.includes('readControlPose(c, resolve(base, skel), latent)'))throw Error('CONFIG_LOADER_FIELDS_STALE: unrecognized pinned loader');
 return [req,anim,generation+'.'+skeleton].sort();
}
function assertLoaderFields(source:string,fields:readonly (readonly string[])[]){
 if(JSON.stringify(producerLoaderFields(source))!==JSON.stringify(fields.map(field=>field.join('.')).sort())){
  throw Error('CONFIG_LOADER_FIELDS_STALE: Review fields differ from the pinned producer loader');
 }
 const names=/^export const SKELETON_NAMES:.*= \[([^\]]+)\];/m.exec(source)?.[1];
 if(!names||JSON.stringify(literalStrings(names))!==JSON.stringify(CONFIG_SKELETON_NAMES))throw Error('CONFIG_LOADER_FIELDS_STALE: built-in skeleton names differ');
}
function assertLoaderPins(pins:Record<string,{version:string;packageSha256:string}>,legacy:readonly string[],reviewFixes:string|undefined,excerpts:Map<string,string>){
 const versions=[...new Set(Object.values(pins).map(pin=>pin.version))].sort();
 if(legacy.some(version=>version!==pins.legacyStage1?.version)||reviewFixes!==pins.reviewRemesh?.version||
    JSON.stringify(versions)!==JSON.stringify([...excerpts.keys()].sort()))throw Error('CONFIG_LOADER_PIN_STALE: verification pins differ from loader excerpts');
 for(const {version,packageSha256} of Object.values(pins)){
  const source=excerpts.get(version);
  if(!source?.startsWith(`// Published npm @rig-c/parts@${version}; literal source excerpts.\n// package.json sha256 ${packageSha256}\n`)){
   throw Error('CONFIG_LOADER_PIN_STALE: pinned package metadata differs from excerpt provenance');
  }
 }
}

test('offline loader parity covers each declared correction verification pin',async()=>{
 const helpers=join(import.meta.dir,'helpers'), fixtures=join(import.meta.dir,'fixtures');
 const [browser,sample,fixes]=await Promise.all(['stage1-browser-job.sh','stage1-producer-sample.sh','stage1-review-fixes-job.sh'].map(file=>readFile(join(helpers,file),'utf8')));
 const defaultPin=/RV367_PARTS_VERSION:-([^}]+)}/.exec(browser)?.[1]??'';
 const samplePin=/"@rig-c\/parts":"([^"]+)"/.exec(sample)?.[1]??'';
 const fixesPin=/"@rig-c\/parts":"([^"]+)"/.exec(fixes)?.[1];
 const excerpts=new Map<string,string>();
 for(const file of await readdir(fixtures)){
  const version=/^parts-(\d+\.\d+\.\d+)-config-file-fields\.txt$/.exec(file)?.[1];
  if(version)excerpts.set(version,await readFile(join(fixtures,file),'utf8'));
 }
 assertLoaderPins(producerPins,[defaultPin,samplePin],fixesPin,excerpts);
 for(const source of excerpts.values()){
  assertLoaderFields(source,CONFIG_NAMED_FILES);
  expect(()=>assertLoaderFields(source,CONFIG_NAMED_FILES.filter(field=>field[0]!=='requirements'))).toThrow('CONFIG_LOADER_FIELDS_STALE');
 }
 expect(()=>assertLoaderPins(producerPins,['1.99.0',samplePin],fixesPin,excerpts)).toThrow('CONFIG_LOADER_PIN_STALE');
 expect(()=>assertLoaderPins({...producerPins,extra:{...producerPins.createStage1,version:'9.0.0'}},[defaultPin,samplePin],fixesPin,excerpts)).toThrow('CONFIG_LOADER_PIN_STALE');
 const missing=new Map(excerpts);missing.delete(producerPins.createStage1.version);
 expect(()=>assertLoaderPins(producerPins,[defaultPin,samplePin],fixesPin,missing)).toThrow('CONFIG_LOADER_PIN_STALE');
 expect(()=>assertLoaderPins({...producerPins,reviewRemesh:{...producerPins.reviewRemesh,packageSha256:'0'.repeat(64)}},[defaultPin,samplePin],fixesPin,excerpts)).toThrow('CONFIG_LOADER_PIN_STALE');
});

test('requirements bytes join the handoff without aliasing other named inputs or a built-in skeleton',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json'),configPath=join(dir,'rig/config.json');
  const declared={...config,requirements:'checks/shared.json',motion:{animations_from:'motion-inputs/shared.json'},generation:{control:{skeleton:'stand_sides'}}};
  await mkdir(join(dir,'rig/checks'),{recursive:true});
  const path=join(dir,'rig/checks/shared.json'),bytes='{"spec":"spine-parts-requirements/1"}\n';
  await writeFile(configPath,JSON.stringify(declared));
  await writeFile(path,bytes);
  await mkdir(join(dir,'rig/motion-inputs'));
  await writeFile(join(dir,'rig/motion-inputs/shared.json'),bytes);
  const before=await loadReview(dir), configDigest=sha(await readFile(configPath));
  expect(before.reviewedSource.handoff!.files).toContainEqual({path:'rig/checks/shared.json',sha256:sha(bytes)});
  expect(before.reviewedSource.handoff!.files).toContainEqual({path:'rig/motion-inputs/shared.json',sha256:sha(bytes)});
  expect(before.reviewedSource.handoff!.missing.some(value=>value.includes('stand_sides'))).toBe(false);
  await writeFile(path,bytes+' ');
  await expect(assertReviewUnchanged(before)).rejects.toThrow('Package inputs changed');
  const after=await loadReview(dir);
  expect(sessionFile(after,s.state)).not.toBe(sessionFile(before,s.state));
  await rm(path);
  expect((await loadReview(dir)).reviewedSource.handoff!.missing).toContain('requirements rig/checks/shared.json');
  const outside=join(s.root,'outside-requirements.json');
  await writeFile(outside,bytes);
  await symlink(outside,path);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_SYMLINK_ESCAPE config requirements');
  await rm(path);
  const alias=join(dir,'rig/checks/alias-target.json');
  await writeFile(alias,bytes);
  await symlink(alias,path);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_PATH_INVALID config requirements');
  await rm(path);await writeFile(path,bytes);
  await assertReviewUnchanged(before);
  expect(sha(await readFile(configPath))).toBe(configDigest);
  expect(sha(await readFile(path))).toBe(sha(bytes));
 }finally{await s.done();}
});

async function writeStubParts(root:string,version:string,configTs:string):Promise<string>{
 const realDir=join(root,`.stub-parts-${version}-${Math.random().toString(36).slice(2,8)}`);
 const linkPath=join(root,'node_modules/@rig-c/parts');
 await rm(linkPath,{recursive:true,force:true});
 await mkdir(join(realDir,'src'),{recursive:true});
 await mkdir(join(root,'node_modules/@rig-c'),{recursive:true});
 await writeFile(join(realDir,'package.json'),JSON.stringify({name:'@rig-c/parts',version}));
 await writeFile(join(realDir,'src/config.ts'),configTs);
 await symlink(realDir,linkPath);
 return realDir;
}

const legacy225ConfigTs=`export function configFileReferences(raw){
 const out=[];
 if(raw&&typeof raw==='object'){
  if(typeof raw.requirements==='string'&&raw.requirements)out.push({at:'requirements',value:raw.requirements,set(v){raw.requirements=v;}});
  if(raw.motion&&typeof raw.motion.animations_from==='string'&&raw.motion.animations_from)out.push({at:'motion.animations_from',value:raw.motion.animations_from,set(v){raw.motion.animations_from=v;}});
 }
 return out;
}\n`;

test('#591: derives assemble.occluders image and plate directory receipt bindings from installed @rig-c/parts@2.35.0 (create#326 93b361f shape) without hashing plate siblings',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json'),configPath=join(dir,'rig/config.json');
  const installedParts=locateInstalledParts([dir,process.cwd()]);
  const spec=plateReceiptSpec(installedParts);
  expect(spec).toBe('rig-parts-plate-receipt/1');

  await mkdir(join(dir,'rig/occluders'),{recursive:true});
  await mkdir(join(dir,'rig/plates/front'),{recursive:true});
  const imagePath=join(dir,'rig/occluders/front.png'),imageBytes='png-occluder-front';
  const receiptPath=join(dir,'rig/plates/front',DIRECTORY_INPUT_RECEIPT);
  const receiptBytes=JSON.stringify({spec,mode:'occluder',plate:'plate.png',mask:'mask.png'},null,2)+'\n';
  const siblingPlate=join(dir,'rig/plates/front/plate.png');
  const siblingMask=join(dir,'rig/plates/front/mask.png');
  await writeFile(imagePath,imageBytes);
  await writeFile(receiptPath,receiptBytes);
  await writeFile(siblingPlate,'sibling-plate-v1');
  await writeFile(siblingMask,'sibling-mask-v1');

  const declared={
   ...config,
   assemble:{
    occluders:[
     {part:'topwear',image:'occluders/front.png',plate:'plates/front'},
    ],
   },
  };
  await writeFile(configPath,JSON.stringify(declared,null,2));

  const opened=await loadReview(dir);
  const handoff=opened.reviewedSource.handoff!;
  expect(handoff.missing).toEqual([]);
  expect(handoff.files).toContainEqual({
   path:'rig/occluders/front.png',
   sha256:sha(imageBytes),
  });
  expect(handoff.files).toContainEqual({
   path:'rig/plates/front/receipt.json',
   sha256:sha(receiptBytes),
   directory:'rig/plates/front',
   spec:'rig-parts-plate-receipt/1',
  });
  expect(handoff.files.some(f=>f.path.endsWith('plate.png')||f.path.endsWith('mask.png'))).toBe(false);

  // Plate sibling changes do not invalidate the handoff or producerInputs when receipt.json is unchanged.
  await writeFile(siblingPlate,'sibling-plate-v2');
  await assertReviewUnchanged(opened);
  expect(handoffGap(opened.handoff!)).toBeNull();
  await expect(producerInputs(opened.handoff!,opened.handoffReason)).resolves.toMatchObject({
   config:join(dir,'rig/config.json'),
  });

  // Changing the bound receipt.json or image invalidates both assertReviewUnchanged and producerInputs.
  const modifiedReceipt=JSON.stringify({spec,mode:'occluder',plate:'plate-2.png'},null,2)+'\n';
  await writeFile(receiptPath,modifiedReceipt);
  await expect(assertReviewUnchanged(opened)).rejects.toThrow('Package inputs changed');
  await expect(producerInputs(opened.handoff!,opened.handoffReason)).rejects.toThrow('REBUILD_INPUTS_CHANGED: rig/plates/front/receipt.json changed');
  await writeFile(receiptPath,receiptBytes);
  await assertReviewUnchanged(opened);

  await writeFile(imagePath,'png-occluder-front-changed');
  await expect(assertReviewUnchanged(opened)).rejects.toThrow('Package inputs changed');
  await expect(producerInputs(opened.handoff!,opened.handoffReason)).rejects.toThrow('REBUILD_INPUTS_CHANGED: rig/occluders/front.png changed');
  await writeFile(imagePath,imageBytes);
  await assertReviewUnchanged(opened);

  // Scratch config resolution and held-path enforcement cover both image and plate references.
  const scratchCfg=JSON.parse(scratchConfigText(configPath,declared));
  expect(scratchCfg.assemble.occluders[0].image).toBe(imagePath);
  expect(scratchCfg.assemble.occluders[0].plate).toBe(join(dir,'rig/plates/front'));
  expect(()=>assertNamedFilesHeld(declared,declared,[dir,process.cwd()])).not.toThrow();
  expect(()=>assertNamedFilesHeld(declared,{...declared,assemble:{occluders:[{part:'topwear',image:'occluders/other.png',plate:'plates/front'}]}},[dir,process.cwd()])).toThrow('EDIT_PATCH_PATH_HELD: assemble.occluders[0].image');
  expect(()=>assertNamedFilesHeld(declared,{...declared,assemble:{occluders:[{part:'topwear',image:'occluders/front.png',plate:'plates/other'}]}},[dir,process.cwd()])).toThrow('EDIT_PATCH_PATH_HELD: assemble.occluders[0].plate');

  // Missing image or plate directory records in missing[] and blocks handoffGap / producerInputs.
  await rm(join(dir,'rig/plates/front'),{recursive:true,force:true});
  const missingPlate=await loadReview(dir);
  expect(missingPlate.reviewedSource.handoff!.missing).toContain('assemble.occluders[0].plate rig/plates/front/receipt.json');
  expect(handoffGap(missingPlate.handoff!)).toBe('MODELING_INPUT_UNAVAILABLE: assemble.occluders[0].plate rig/plates/front/receipt.json');
  await expect(producerInputs(missingPlate.handoff!,missingPlate.handoffReason)).rejects.toThrow('MODELING_INPUT_UNAVAILABLE: assemble.occluders[0].plate rig/plates/front/receipt.json');
 }finally{
  await s.done();
 }
});

test('#591: refuses invalid plate directory receipts, symlinks, older loaders omitting occluders, and unknown configFileReferences by name without mutating sources',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json'),configPath=join(dir,'rig/config.json');
  await mkdir(join(dir,'rig/occluders'),{recursive:true});
  await mkdir(join(dir,'rig/plates/front'),{recursive:true});
  await writeFile(join(dir,'rig/occluders/front.png'),'png-bytes');
  const receiptPath=join(dir,'rig/plates/front/receipt.json');
  await writeFile(receiptPath,JSON.stringify({spec:'rig-parts-plate-receipt/1'})+'\n');
  const declared={...config,assemble:{occluders:[{part:'topwear',image:'occluders/front.png',plate:'plates/front'}]}};
  await writeFile(configPath,JSON.stringify(declared));

  // 1) Older installed loader in package ancestry (e.g. 2.25.1 stub omitting assemble.occluders) refuses declared occluder inputs by name instead of falling back to OWN_ROOT or guessing.
  await writeStubParts(s.root,'2.25.1',legacy225ConfigTs);
  const beforeOlder=await treeMd5(dir);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_INPUT_INVALID config assemble.occluders[0].image: @rig-c/parts 2.25.1 configFileReferences does not declare assemble.occluders[0].image');
  expect(await treeMd5(dir)).toBe(beforeOlder);
  await writeFile(configPath,JSON.stringify({...config,assemble:{occluders:[{part:'topwear',plate:'plates/front'}]}}));
  const beforeOlderPlate=await treeMd5(dir);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_INPUT_INVALID config assemble.occluders[0].plate: @rig-c/parts 2.25.1 configFileReferences does not declare assemble.occluders[0].plate');
  expect(await treeMd5(dir)).toBe(beforeOlderPlate);
  await rm(join(s.root,'node_modules'),{recursive:true,force:true});
  await writeFile(configPath,JSON.stringify(declared));

  // 2) Under installed @rig-c/parts@2.35.0, missing receipt.json, wrong spec, symlinked receipt.json, and escaping plate directory refuse by name without mutating sources.
  await writeFile(receiptPath,JSON.stringify({spec:'wrong-spec/1'})+'\n');
  const beforeWrongSpec=await treeMd5(dir);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_INPUT_INVALID config assemble.occluders[0].plate: rig/plates/front/receipt.json declares spec "wrong-spec/1"');
  expect(await treeMd5(dir)).toBe(beforeWrongSpec);

  await rm(receiptPath);
  const beforeNoReceipt=await treeMd5(dir);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_INPUT_INVALID config assemble.occluders[0].plate: rig/plates/front holds no regular-file receipt.json');
  expect(await treeMd5(dir)).toBe(beforeNoReceipt);

  const realReceipt=join(dir,'rig/plates/real-receipt.json');
  await writeFile(realReceipt,JSON.stringify({spec:'rig-parts-plate-receipt/1'})+'\n');
  await symlink(realReceipt,receiptPath);
  const beforeSymlinkReceipt=await treeMd5(dir);
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_INPUT_INVALID config assemble.occluders[0].plate: rig/plates/front/receipt.json is not a regular file');
  expect(await treeMd5(dir)).toBe(beforeSymlinkReceipt);
  await rm(receiptPath);
  await rm(realReceipt);

  const outsideDir=join(s.root,'outside-plate');
  await mkdir(outsideDir,{recursive:true});
  await writeFile(join(outsideDir,'receipt.json'),JSON.stringify({spec:'rig-parts-plate-receipt/1'})+'\n');
  await rm(join(dir,'rig/plates/front'),{recursive:true,force:true});
  await symlink(outsideDir,join(dir,'rig/plates/front'));
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_SYMLINK_ESCAPE config assemble.occluders[0].plate');
  await rm(join(dir,'rig/plates/front'),{recursive:true,force:true});
  await mkdir(join(dir,'rig/plates/front'),{recursive:true});
  await writeFile(receiptPath,JSON.stringify({spec:'rig-parts-plate-receipt/1'})+'\n');

  // 3) Named plant: an unknown configFileReferences entry from @rig-c/parts is refused by name, never silently skipped.
  await writeStubParts(s.root,'9.99.0',`export function configFileReferences(raw){return [{at:'future.unknown_ref',value:'mystery.json',set(){}}];}\n`);
  await writeFile(configPath,JSON.stringify(config));
  const beforeUnknown=await treeMd5(dir);
  expect(()=>configNamedReferences(config,[dir])).toThrow('HANDOFF_INPUT_INVALID config future.unknown_ref: unsupported config file reference future.unknown_ref');
  await expect(loadReview(dir)).rejects.toThrow('HANDOFF_INPUT_INVALID config future.unknown_ref');
  expect(await treeMd5(dir)).toBe(beforeUnknown);
 }finally{
  await s.done();
 }
});

test('#591: threads logical options.cwd across loadReview, loadOpenPackage, assertReviewUnchanged, and producerInputs, and preserves read-only inspection when optional @rig-c/parts is absent',async()=>{
 const s=await scratch();
 const originalCwd=process.cwd();
 try{
  const installedParts=locateInstalledParts([originalCwd]);
  const dir=await pkg(s.root,'rig/config.json'),configPath=join(dir,'rig/config.json');
  await mkdir(join(dir,'rig/occluders'),{recursive:true});
  await mkdir(join(dir,'rig/plates/front'),{recursive:true});
  await writeFile(join(dir,'rig/occluders/front.png'),'png-bytes');
  await writeFile(join(dir,'rig/plates/front/receipt.json'),JSON.stringify({spec:'rig-parts-plate-receipt/1'})+'\n');

  // 1) When optional @rig-c/parts is completely absent (starts = [dir, s.root], no node_modules in package or cwd),
  // non-occluder packages still open for read-only inspection while rebuild reports MODELING_PRODUCER_NOT_INSTALLED.
  expect(findInstalledParts([dir,s.root])).toBeNull();
  const readOnlyOpened=await loadReview(dir,{cwd:s.root});
  expect(readOnlyOpened.reviewedSource.handoff?.files.map(f=>f.path)).toContain('rig/clips.json');
  await assertReviewUnchanged(readOnlyOpened);

  const srv=await startServer(readOnlyOpened,{port:0,stateDir:s.state,cwd:s.root});
  const base=`http://127.0.0.1:${srv.port}`;
  try{
   const res=await (await fetch(`${base}/api/rebuild`)).json() as {available:boolean;reason:string|null};
   expect(res.available).toBe(false);
   expect(res.reason).toBe(MODELING_PRODUCER_NOT_INSTALLED);
  }finally{await srv.stop(true);}

  // When @rig-c/parts is absent, a config declaring assemble.occluders fails closed by name with MODELING_PRODUCER_NOT_INSTALLED.
  const declared={...config,assemble:{occluders:[{part:'topwear',image:'occluders/front.png',plate:'plates/front'}]}};
  await writeFile(configPath,JSON.stringify(declared));
  await expect(loadReview(dir,{cwd:s.root})).rejects.toThrow(`HANDOFF_INPUT_INVALID config assemble.occluders[0].image: ${MODELING_PRODUCER_NOT_INSTALLED}`);

  // 2) Logical options.cwd resolution: even when process.cwd() is a bare directory (like the open worker's canonicalControl)
  // and the package directory has no node_modules, options.cwd (externalCwd) supplies the producer.
  const externalCwd=join(s.root,'external-cwd');
  const bareWorkerCwd=join(s.root,'worker-control');
  await mkdir(join(externalCwd,'node_modules/@rig-c'),{recursive:true});
  await mkdir(bareWorkerCwd,{recursive:true});
  await symlink(installedParts,join(externalCwd,'node_modules/@rig-c/parts'));

  process.chdir(bareWorkerCwd);
  const openedViaCwd=await loadReview(dir,{cwd:externalCwd});
  expect(openedViaCwd.reviewedSource.handoff?.files).toContainEqual(expect.objectContaining({
   path:'rig/plates/front/receipt.json',
   directory:'rig/plates/front',
   spec:'rig-parts-plate-receipt/1',
  }));
  await assertReviewUnchanged(openedViaCwd);
  await expect(producerInputs(openedViaCwd.handoff!,openedViaCwd.handoffReason)).resolves.toMatchObject({
   config:configPath,
  });

  const openTarget=await loadOpenPackage({input:dir},{cwd:externalCwd});
  if(openTarget.mode!=='single')throw new Error('Expected single package');
  await assertReviewUnchanged(openTarget.p);

  // If logical options.cwd holds an older producer (2.25.1 stub), loadOpenPackage / loadReview uses options.cwd and refuses.
  const olderCwd=join(s.root,'older-cwd');
  await writeStubParts(olderCwd,'2.25.1',legacy225ConfigTs);
  await expect(loadOpenPackage({input:dir},{cwd:olderCwd})).rejects.toThrow('HANDOFF_INPUT_INVALID config assemble.occluders[0].image: @rig-c/parts 2.25.1');
 }finally{
  process.chdir(originalCwd);
  await s.done();
 }
});

test('#623: review.json producer accepts source alone as a hashed painting file, while refusing source+head without full or full without source',async()=>{
 const s=await scratch();
 try{
  const dir=await pkg(s.root,'rig/config.json'),paintingPath=join(dir,'painting.png'),paintingBytes='source-only-painting-bytes';
  await writeFile(paintingPath,paintingBytes);
  await mkdir(join(dir,'head'),{recursive:true});await writeFile(join(dir,'head/h.png'),'head-bytes');
  await mkdir(join(dir,'full'),{recursive:true});await writeFile(join(dir,'full/f.png'),'full-bytes');
  const writeManifest=(producer:Record<string,unknown>)=>writeFile(join(dir,'review.json'),JSON.stringify({schema:'rig-review/1',id:'p',title:'P',revision:'1',motion:'motion.json',producer}));
  await writeManifest({config:'rig/config.json',parts:'rig/out',source:'painting.png'});
  const beforeTree=await treeMd5(dir);
  const opened=await loadReview(dir);
  expect(opened.handoff).toMatchObject({config:join(dir,'rig/config.json'),parts:join(dir,'rig/out'),rig:join(dir,'rig/out/rig'),source:paintingPath,full:null,head:null});
  expect(opened.reviewedSource.handoff).toMatchObject({how:'declared',via:'review.json producer',source:{path:'painting.png',sha256:sha(paintingBytes)},full:null,head:null});
  expect(opened.reviewedSource.handoff!.files).toContainEqual({path:'painting.png',sha256:sha(paintingBytes)});
  expect(opened.sourcePainting).toEqual({id:'source-painting',path:'painting.png',sha256:sha(paintingBytes)});
  await assertReviewUnchanged(opened);
  await writeFile(paintingPath,paintingBytes+'-changed');
  await expect(assertReviewUnchanged(opened)).rejects.toThrow('Package inputs changed');
  await writeFile(paintingPath,paintingBytes);
  await assertReviewUnchanged(opened);
  expect(await treeMd5(dir)).toBe(beforeTree);

  // source-only plus head (without full) is refused by name.
  await writeManifest({config:'rig/config.json',parts:'rig/out',source:'painting.png',head:'head'});
  await expect(loadReview(dir)).rejects.toMatchObject({code:'HANDOFF_FLAGS_INVALID',field:'producer'});

  // full without source is refused by name.
  await writeManifest({config:'rig/config.json',parts:'rig/out',full:'full'});
  await expect(loadReview(dir)).rejects.toMatchObject({code:'HANDOFF_FLAGS_INVALID',field:'producer'});

  // source must remain a regular file inside root.
  await writeManifest({config:'rig/config.json',parts:'rig/out',source:'head'});
  await expect(loadReview(dir)).rejects.toMatchObject({code:'HANDOFF_INPUT_INVALID',field:'producer.source'});
 }finally{await s.done();}
});
