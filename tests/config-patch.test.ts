import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {applyConfigPatch,assertPatchFresh,CONFIG_PATCH_SCHEMA,ConfigPatchError,formatPointer,jsonDiff,parseConfigPatch,parsePointer,patchSha256,remeshPart,type ConfigPatch} from '../src/config-patch.ts';
import {patchId,scratchConfigText} from '../src/rebuild.ts';
import {appliedSummary,checkSummary,parseAppliedContext} from '../src/applied-context.ts';
import {validatePackageFeedback} from '../src/session.ts';
import {groupFeedbackIssues,formatFeedbackIssues} from '../src/feedback-export.ts';
import {makePatch,patchAppliedRecord,patchOutcomeLine,runRebuild,stageModel,type PatchJobView} from '../web/rebuild-client.ts';

const constraints=[{type:'physics',name:'c0',bone:'b',rotate:1,strength:100,damping:0.85},{type:'physics',name:'c1',bone:'b',rotate:1,strength:100,damping:0.85}];
const config={key:'k',motion:{animations_from:'clips.json'},constraints,meshes:{topwear:{contour:{tolerance:2,regions:[]},r:15},neck:{grid:10}}};
const inspectedRig=JSON.stringify({bones:[{name:'b'}],constraints});
const REFUSAL='  FAIL  CONFIG_CONSTRAINT_RANGE: constraints[0].damping 7 is outside 0..1 (see rig-parts guide)';
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');

/**
 * Stand-ins: `rig-parts rig` copies <parts>/rig and writes rig.json's constraints from --config (a config naming a
 * motion.animations_from that does not resolve from the config's directory, or with a damping above 1, is refused by a
 * FAIL line); `check` writes check.json; `remesh` writes the entry into rig.json. `rigc build` writes a model carrying
 * the rig's constraints.
 */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,a.join(' ')+'\\n');
if(a[0]==='rig'){const cfgPath=path.resolve(f('--config')),cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
 const from=cfg.motion&&cfg.motion.animations_from;if(from&&!fs.existsSync(path.resolve(path.dirname(cfgPath),from))){console.log('  FAIL  CONFIG_FILE_PRESENT: config.motion.animations_from — names '+from+', which is not a file');process.exit(1);}
 if((cfg.constraints||[]).some(c=>c.damping>1)){console.log('[rig] reading');console.log(${JSON.stringify(REFUSAL)});console.log('refused: 1 problem(s)');process.exit(1);}
 const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});
 for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));
 const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));if(cfg.constraints)rig.constraints=cfg.constraints;if(process.env.FAKE_PERTURB)rig.perturbed=true;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,TEXTURE_STRETCH:{status:'PASS'},CLOTH_SETTLES:{status:'WARN'},PASS:true}));console.log('  TEXTURE_STRETCH: PASS');console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
if(a[0]==='remesh'){const out=f('--out');fs.mkdirSync(out);const rig=JSON.parse(fs.readFileSync(path.join(f('--rig'),'rig.json'),'utf8'));rig.mesh=JSON.parse(fs.readFileSync(f('--mesh'),'utf8'));
 fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));fs.writeFileSync(path.join(out,'motion.json'),'{}');fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({request:{page_edges:'free',pack_shape:'polygon'}}));console.log('rig-parts remesh: wrote');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],constraints:rig.constraints||null,mesh:rig.mesh||null}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
async function install(root:string){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
}
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-patch-'))),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/clips.json'),'{}');await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(pkg,'rig/out/rig/rig.json'),inspectedRig);for(const name of ['motion.json','mesh_report.json'])await writeFile(join(pkg,'rig/out/rig',name),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');await install(root);
 return {root,pkg,state:join(root,'state'),log:join(root,'calls.log')};
}
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}
const patchFor=(configSha:string,ops:ConfigPatch['ops'],op:ConfigPatch['op']={cmd:'rig',args:[]}):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version:'1.42.0'},op});
const damping=(sha256:string,value=0.8)=>patchFor(sha256,[{op:'replace',path:'/constraints/0/damping',value}]);
async function settle(base:string,job:{id:string;status:string}):Promise<PatchJobView>{let current=job as PatchJobView;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const post=(base:string,body:unknown,origin=base)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});

test('JSON Pointer (RFC 6901): escapes, the empty pointer, and a "~" that is not ~0/~1 refused by name',()=>{
 expect(parsePointer('')).toEqual([]);expect(parsePointer('/a~1b/c~0d/0')).toEqual(['a/b','c~d','0']);expect(formatPointer(['a/b','c~d',0])).toBe('/a~1b/c~0d/0');
 expect(()=>parsePointer('a/b')).toThrow('EDIT_PATCH_POINTER_INVALID');expect(()=>parsePointer('/a~2')).toThrow('EDIT_PATCH_POINTER_INVALID');expect(()=>parsePointer('/a~')).toThrow('EDIT_PATCH_POINTER_INVALID');
});

test('apply: replace, add (key, index, "-"), remove, in order on a copy; a missing path or index is EDIT_PATCH_PATH_MISSING',()=>{
 const doc={a:{b:[1,2,3]},c:1};
 expect(applyConfigPatch(doc,[{op:'replace',path:'/a/b/1',value:9},{op:'add',path:'/a/b/-',value:4},{op:'add',path:'/a/b/0',value:0},{op:'add',path:'/d',value:{e:1}},{op:'remove',path:'/c'}])).toEqual({a:{b:[0,1,9,3,4]},d:{e:1}});
 expect(doc).toEqual({a:{b:[1,2,3]},c:1});
 for(const [op,code] of [[{op:'replace',path:'/x',value:1},'EDIT_PATCH_PATH_MISSING'],[{op:'remove',path:'/a/b/3'},'EDIT_PATCH_PATH_MISSING'],[{op:'replace',path:'/a/b/01',value:1},'EDIT_PATCH_POINTER_INVALID'],[{op:'add',path:'/a/x/y',value:1},'EDIT_PATCH_PATH_MISSING'],[{op:'add',path:'/a/b/4',value:1},'EDIT_PATCH_PATH_MISSING']] as const)
  expect(()=>applyConfigPatch(doc,[op as ConfigPatch['ops'][number]])).toThrow(code);
});

test('the patch document: exactly its keys, a known op and cmd, flags from a closed set, no path anywhere',()=>{
 const good=damping('a'.repeat(64));expect(parseConfigPatch(good)).toEqual(good);
 expect(()=>parseConfigPatch({...good,ops:[{op:'move',path:'/a',from:'/b'}]})).toThrow('EDIT_PATCH_OP_UNKNOWN');
 expect(()=>parseConfigPatch({...good,ops:[{op:'replace',path:'constraints/0',value:1}]})).toThrow('EDIT_PATCH_POINTER_INVALID');
 expect(()=>parseConfigPatch({...good,ops:[{op:'replace',path:'',value:{}}]})).toThrow('EDIT_PATCH_POINTER_INVALID');
 expect(()=>parseConfigPatch({...good,ops:[{op:'remove',path:'/a',value:1}]})).toThrow('EDIT_PATCH_INVALID');
 expect(()=>parseConfigPatch({...good,op:{cmd:'mesh-draft',args:[]}})).toThrow('EDIT_PATCH_CMD_UNKNOWN');
 expect(()=>parseConfigPatch({...good,op:{cmd:'rig',args:['--out','/tmp/x']}})).toThrow('EDIT_PATCH_ARG_UNKNOWN');
 expect(()=>parseConfigPatch({...good,op:{cmd:'rig',args:['--idle-keys','sideways']}})).toThrow('EDIT_PATCH_INVALID');
 expect(parseConfigPatch({...good,op:{cmd:'rig',args:['--idle-keys','direct']}}).op.args).toEqual(['--idle-keys','direct']);
 expect(()=>parseConfigPatch({...good,op:{cmd:'remesh',args:[]}})).toThrow('remesh needs --part');
 expect(()=>parseConfigPatch({...good,extra:1})).toThrow('EDIT_PATCH_INVALID');expect(()=>parseConfigPatch({...good,config_sha256:'x'})).toThrow('config_sha256');
 const remesh=patchFor('a'.repeat(64),[{op:'replace',path:'/meshes/topwear/contour/tolerance',value:3}],{cmd:'remesh',args:['--part','topwear']});expect(remeshPart(parseConfigPatch(remesh))).toBe('topwear');
 expect(()=>remeshPart(parseConfigPatch({...remesh,ops:[...remesh.ops,{op:'replace',path:'/constraints/0/damping',value:0.8}]}))).toThrow('EDIT_PATCH_OUT_OF_SCOPE');
 expect(patchSha256(good)).toBe(patchSha256(JSON.parse(JSON.stringify(good))));expect(patchSha256(damping('a'.repeat(64),0.7))).not.toBe(patchSha256(good));
});

test('structural diff: the JSON Pointers where two documents differ, one per changed leaf, key or index',()=>{
 expect(jsonDiff({a:1,b:[1,2],c:{d:'x'}},{a:1,b:[1,2],c:{d:'x'}})).toEqual([]);
 expect(jsonDiff({a:1,b:[1,2],c:{d:'x',e:1}},{a:2,b:[1,2,3],c:{d:'y'},'f/g':null})).toEqual(['/a','/b/2','/c/d','/c/e','/f~1g']);
 expect(jsonDiff({a:[1]},{a:{0:1}})).toEqual(['/a']);
});

test('bar 2: a patch made against another config hash is refused EDIT_PATCH_STALE, before anything is written or run',async()=>{
 expect(()=>assertPatchFresh({config_sha256:'b'.repeat(64)},'a'.repeat(64))).toThrow('EDIT_PATCH_STALE');
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const response=await post(base,{patch:damping('b'.repeat(64))});expect(response.status).toBe(200);
  const body=await response.json();expect(body.status).toBe('refused');expect(body.error).toStartWith('EDIT_PATCH_STALE: the patch was made against config bbbbbbbbbbbb…');
  expect(await Bun.file(join(state,'rebuild')).exists()).toBe(false);expect(await Bun.file(log).exists()).toBe(false);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 1 + bar 3: a one-value patch rebuilds the whole rig into scratch, rig.json differs at exactly that path, then compile and check; the scratch name has no clock; the package is unchanged',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeMd5(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json();const patch=makePatch(status,[{op:'replace',path:'/constraints/0/damping',value:0.8}])!;
  expect(patch).toEqual(damping(sha(await readFile(join(pkg,'rig/config.json')))));
  const started=await post(base,{patch});expect(started.status).toBe(202);const job=await settle(base,await started.json());
  expect(job).toMatchObject({kind:'patch',status:'built',reused:false,exitCode:0,producerLine:expect.stringContaining('rig-parts rig: wrote'),request:{patch,patchSha256:patchSha256(patch)},diff:{count:1,paths:['/constraints/0/damping']}});
  expect(job.check).toEqual({schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS; 1 of 1 bar(s) measured',bars:{TEXTURE_STRETCH:'PASS',CLOTH_SETTLES:'WARN'},gate:true});
  expect(job.wallMs.op).toBeNumber();expect(job.wallMs.compile).toBeNumber();expect(job.wallMs.check).toBeNumber();
  // The scratch config: the patched value, and the config-relative file made absolute so it resolves from scratch.
  const dir=join(state,'rebuild',p.sourceHash,job.id),scratch=JSON.parse(await readFile(join(dir,'config.json'),'utf8'));
  expect(scratch.constraints[0].damping).toBe(0.8);expect(scratch.motion.animations_from).toBe(join(pkg,'rig/clips.json'));
  expect(await readFile(join(dir,'config.json'),'utf8')).toBe(scratchConfigText(join(pkg,'rig/config.json'),{...config,constraints:[{...constraints[0]!,damping:0.8},constraints[1]!]}));
  const model=JSON.parse(await (await fetch(base+job.build!.modelUrl)).text());expect(model.constraints[0].damping).toBe(0.8);
  const calls=(await readFile(log,'utf8')).trim().split('\n');
  expect(calls).toContain(`rig --config config.json --parts ${join(p.root,'rig/out')} --out rig`);
  expect(calls).toContain(`check --rig rig --out check --parts ${join(p.root,'rig/out')} --page-edges free --pack-shape polygon`);
  // Bar 3: the id is a function of the inputs only; the same patch again is the same directory, reused, nothing run.
  const id={sourceHash:p.sourceHash,configHash:patch.config_sha256,patch,producer:'@rig-c/parts@1.42.0',compiler:'rig-c@2.64.1'};
  expect(patchId(id)).toBe(job.id);await Bun.sleep(5);expect(patchId(id)).toBe(job.id);expect(patchId({...id,patch:damping(patch.config_sha256,0.7)})).not.toBe(job.id);
  const runs=calls.filter(l=>l.startsWith('rig --config config.json')).length;
  expect(await (await post(base,{patch})).json()).toMatchObject({id:job.id,status:'built',reused:true});
  expect((await readFile(log,'utf8')).trim().split('\n').filter(l=>l.startsWith('rig --config config.json'))).toHaveLength(runs);
  expect(await readdir(join(state,'rebuild',p.sourceHash))).toEqual([job.id]);
  expect(await treeMd5(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 4: a producer refusal is its first named line byte for byte, no build is served, and the stage keeps its model',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),before=await treeMd5(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const configSha=sha(await readFile(join(pkg,'rig/config.json'))),job=await settle(base,await (await post(base,{patch:damping(configSha,7)})).json());
  expect(job).toMatchObject({status:'refused',exitCode:1,producerLine:REFUSAL.trim(),build:null});
  expect(patchOutcomeLine(job)).toEqual({text:REFUSAL.trim(),error:true});
  const current={url:'/assets/build/skeleton.model.json',hash:'e'.repeat(64)};
  expect(stageModel(job,current)).toEqual({...current,id:null});
  expect(stageModel({status:'refused',error:'REBUILD_BUSY: x',producerLine:null},current)).toEqual({...current,id:null});
  expect((await fetch(`${base}/rebuild/${job.id}/skeleton.model.json`)).status).toBe(404);
  expect(await Bun.file(join(state,'rebuild',p.sourceHash,job.id)).exists()).toBe(false);
  expect(await treeMd5(pkg)).toBe(before);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('whole-rig ops need the reproduced baseline (EDIT_BASELINE_MISMATCH names the path); remesh ops stay in their entry; named files and the producer are held',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const configSha=sha(await readFile(join(pkg,'rig/config.json')));
  expect(await (await post(base,{patch:patchFor(configSha,[{op:'replace',path:'/motion/animations_from',value:'/etc/hosts'}])})).json()).toMatchObject({status:'refused',error:expect.stringMatching(/^EDIT_PATCH_PATH_HELD: motion\.animations_from/)});
  expect(await (await post(base,{patch:{...damping(configSha),producer:{name:'@rig-c/parts',version:'1.41.0'}}})).json()).toMatchObject({status:'refused',error:expect.stringMatching(/^EDIT_PRODUCER_MISMATCH/)});
  expect(await (await post(base,{patch:patchFor(configSha,[{op:'replace',path:'/constraints/9/damping',value:1}])})).json()).toMatchObject({status:'refused',error:expect.stringMatching(/^EDIT_PATCH_PATH_MISSING/)});
  const malformed=await post(base,{patch:{...damping(configSha),ops:[{op:'copy',path:'/a',from:'/b'}]}});expect(malformed.status).toBe(400);expect((await malformed.json()).error).toStartWith('EDIT_PATCH_OP_UNKNOWN');
  expect((await post(base,{patch:damping(configSha),out:'/tmp'})).status).toBe(400);
  expect((await post(base,{patch:damping(configSha)},'http://evil.test')).status).toBe(403);
  // A remesh patch: its patched entry goes to remesh as mesh.json; the config it reads is the handoff's own.
  const remesh=patchFor(configSha,[{op:'replace',path:'/meshes/topwear/contour/tolerance',value:3}],{cmd:'remesh',args:['--part','topwear']});
  const job=await settle(base,await (await post(base,{patch:remesh})).json());expect(job).toMatchObject({status:'built',diff:{count:1,paths:['/mesh']}});
  expect((await readFile(log,'utf8'))).toContain(`remesh --rig ${join(p.root,'rig/out/rig')} --config ${join(p.root,'rig/config.json')} --parts ${join(p.root,'rig/out')} --part topwear --mesh mesh.json --out rig`);
  expect(JSON.parse(await (await fetch(base+job.build!.modelUrl)).text()).mesh).toEqual({...config.meshes.topwear,contour:{...config.meshes.topwear.contour,tolerance:3}});
  // A producer whose rig no longer reproduces the inspected one: the whole-rig op is refused naming the path.
  await rm(join(state,'baseline'),{recursive:true,force:true});
 }finally{delete process.env.FAKE_LOG;await server.stop(true);}
 try{
  process.env.FAKE_PERTURB='1';
  const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
  try{expect(await (await post(base,{patch:damping(sha(await readFile(join(pkg,'rig/config.json'))))})).json()).toMatchObject({status:'refused',error:expect.stringMatching(/^EDIT_BASELINE_MISMATCH: rig\/out\/rig\/rig\.json — .*whole-rig edits refuse \(EDIT_BASELINE_MISMATCH\); /)});}
  finally{await server.stop(true);}
 }finally{delete process.env.FAKE_PERTURB;await rm(root,{recursive:true,force:true});}
});

test('the client streams a patch job once per line, records patch + hash + line + check, and feedback context.applied validates and exports it',async()=>{
 const patch=damping('f'.repeat(64)),check=checkSummary({PASS:true,gate_spine_html_green:true,TEXTURE_STRETCH:{status:'PASS'},note:'x'},0,['a','check: PASS; 11 of 13 bar(s) measured'],null);
 const job=(status:PatchJobView['status'],lines:string[]):PatchJobView=>({id:'d'.repeat(64),kind:'patch',status,reused:false,lines,producerLine:status==='built'?'rig-parts rig: wrote':null,exitCode:status==='running'?null:0,wallMs:{op:1284,compile:995,check:16123},check:status==='built'?check:null,diff:status==='built'?{count:1,paths:['/constraints/0/damping']}:null,build:status==='built'?{modelUrl:'/rebuild/m',modelHash:'e'.repeat(64),files:{}}:null,request:{patch,patchSha256:patchSha256(patch),configHash:'f'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'}});
 const polls=[job('running',['a','b']),job('built',['a','b','c'])],seen:[string,number][]=[];
 const result=await runRebuild({patch},{post:async()=>job('running',['a']),get:async()=>polls.shift()!,onLine:(line,i)=>seen.push([line,i]),sleep:async()=>{}});
 expect(seen).toEqual([['a',0],['b',1],['c',2]]);
 expect(patchOutcomeLine(result)).toEqual({text:`Applied patch ${patchSha256(patch).slice(0,12)}… (1 op(s)) with @rig-c/parts 1.42.0 · rig 1.3 s + compile 1.0 s + check 16.1 s · check PASS · rig.json differs at 1 path(s) · Reset returns to the inspected build`,error:false});
 expect(stageModel(result,{url:'/x',hash:'0'.repeat(64)})).toEqual({url:'/rebuild/m',hash:'e'.repeat(64),id:'d'.repeat(64)});
 const applied=patchAppliedRecord(result as PatchJobView);
 expect(applied).toEqual({schema:'rig-review-applied/2',buildId:'d'.repeat(64),patch,patchSha256:patchSha256(patch),configHash:'f'.repeat(64),producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'},line:'rig-parts rig: wrote',check:{schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS; 11 of 13 bar(s) measured',bars:{TEXTURE_STRETCH:'PASS'},gate:true},diff:{count:1,paths:['/constraints/0/damping']},modelHash:'e'.repeat(64)});
 expect(()=>parseAppliedContext(applied)).not.toThrow();
 const regions={schema:'rig-review-applied/1',buildId:'d'.repeat(64),part:'topwear',regions:[],configHash:'f'.repeat(64),entrySha256:'0'.repeat(64),producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'},line:null,modelHash:'e'.repeat(64)};
 for(const older of [null,regions])expect(()=>parseAppliedContext(older)).not.toThrow();
 expect(()=>parseAppliedContext({...applied,patch:{...patch,config_sha256:'a'.repeat(64)}})).toThrow('patch.config_sha256 is not configHash');
 expect(()=>parseAppliedContext({...applied,extra:1})).toThrow('feedback.context.applied');expect(()=>parseAppliedContext({schema:'rig-review-applied/9'})).toThrow('feedback.context.applied.schema');
 expect(appliedSummary(applied)).toBe(`patch ${patchSha256(patch).slice(0,12)}… (rig; replace /constraints/0/damping) with @rig-c/parts 1.42.0 · check PASS · rig.json differs at 1 path(s) · model eeeeeeeeeeee…`);
 // A session record: absent and null stay valid, a malformed applied is refused by name; the export prints the Applied line.
 const p={feedbackCatalog:{rig:'r',bones:[],slots:[],animations:null,clock:null,clockAnimation:null}} as never;
 const note=(context:Record<string,unknown>)=>({id:'n',frameStart:0,frameEnd:0,target:{kind:'rig' as const,name:'r'},category:'quality' as const,summary:'s',context:context as never});
 for(const context of [{},{applied:null},{applied:regions},{applied}])expect(()=>validatePackageFeedback(note(context),p)).not.toThrow();
 expect(()=>validatePackageFeedback(note({applied:{...applied,patchSha256:'x'}}),p)).toThrow('feedback.context.applied');
 const session={schema:'rig-review-session/1',id:'r',revision:'1',sourceHash:'s'.repeat(64),reviewedSource:{packageRevision:'1',viewerVersion:'0',runtimeVersion:'0',rig:null,motion:null},status:'pending',checkpoints:{},feedback:[validatePackageFeedback(note({applied}),p)],feedbackWarnings:[],updatedAt:null};
 expect(formatFeedbackIssues(session as never)).toContain(`- Applied: patch ${patchSha256(patch).slice(0,12)}… &#40;rig; replace /constraints/0/damping&#41; with @rig&#45;c/parts 1&#46;42&#46;0 · check PASS · rig&#46;json differs at 1 path&#40;s&#41; · model eeeeeeeeeeee…`);
 expect(groupFeedbackIssues(session as never).counts.total).toBe(1);
});

test('ConfigPatchError carries its code',()=>{const e=new ConfigPatchError('EDIT_PATCH_STALE','x');expect(e.code).toBe('EDIT_PATCH_STALE');expect(e.message).toBe('EDIT_PATCH_STALE: x');});
