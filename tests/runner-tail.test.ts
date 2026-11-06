import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';

/**
 * #121: both runners — the #99 designation remesh (`execute`) and the #102 patch (`executePatch`, a whole-rig `rig` and
 * a one-part `remesh`) — go through one compile/check/hash/keep/cleanup tail. This replays one session of five Applies
 * (three built, two refused) with stand-in producers and compares every settled response, every job line, every build
 * hash and the whole scratch tree after each Apply against the record taken from the runners before the refactor
 * (`tests/fixtures/runner-tail.json`). Wall clocks are the only field normalized (a number becomes "ms").
 * #367 adds checked mesh evidence; it is asserted separately while every historical field/file stays exact.
 * #369 adds `check.source` to direct checks in the response and stored result. The replay asserts it before
 * comparing the rest to the historical record.
 * `RUNNER_TAIL_RECORD=1` rewrites the record (not used for evidence-only extensions).
 */
const RECORD=join(import.meta.dir,'fixtures/runner-tail.json');
const constraints=[{type:'physics',name:'c0',bone:'chest',rotate:1,strength:100,damping:0.85}];
const bust={name:'bust',shape:'circle' as const,cx:414,cy:342,r:50,bone:'chest_jiggle',spacing:13,band:30};
const contour={contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,bridges:true,regions:[bust]},r:15};
const config={key:'k',constraints,meshes:{topwear:contour,refuse:contour,neck:{grid:10}}};
const inspected={
 'rig.json':JSON.stringify({bones:[{name:'chest'}],constraints}),
 'motion.json':JSON.stringify({tracks:[]}),
 'sets.json':JSON.stringify({sets:[{name:'base'}]}),
 'mesh_report.json':JSON.stringify({parts:{topwear:{vertices:178,triangles:296}}}),
};
/**
 * Stand-ins. `rig-parts rig` copies <parts>/rig and writes the config's constraints into rig.json (a damping above 1 is
 * refused by a FAIL line); `remesh` copies --rig, writes the entry into rig.json, the part's counts into mesh_report.json
 * and remesh.json's request and counts (a part named "refuse" is refused); `check` writes check.json. `rigc build`
 * writes a model carrying the rig's bytes' hash and one page. Nothing goes to stderr: its interleaving with stdout is the
 * pipes' race, not the runner's.
 */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const copy=(src,out)=>{fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));for(const n of fs.readdirSync(path.join(src,'images')))fs.copyFileSync(path.join(src,'images',n),path.join(out,'images',n));};
if(a[0]==='rig'){const cfg=JSON.parse(fs.readFileSync(path.resolve(f('--config')),'utf8')),out=f('--out');
 if((cfg.constraints||[]).some(c=>c.damping>1)){console.log('[rig] reading');console.log('  FAIL  CONFIG_CONSTRAINT_RANGE: constraints[0].damping is outside 0..1');console.log('refused: 1 problem(s)');process.exit(1);}
 copy(path.join(f('--parts'),'rig'),out);const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.constraints=cfg.constraints;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='remesh'){const out=f('--out'),part=f('--part');console.log('rig-parts remesh: '+part);
 if(part==='refuse'){console.log('  FAIL  REMESH_TARGET_MESH: refuse — a linked mesh is bound to it');console.log('refused: 1 problem(s)');process.exit(1);}
 const entry=JSON.parse(fs.readFileSync(f('--mesh'),'utf8'));copy(f('--rig'),out);
 const after={vertices:Math.round(5000/entry.contour.spacing),triangles:Math.round(8300/entry.contour.spacing),hull:58};
 const report=JSON.parse(fs.readFileSync(path.join(out,'mesh_report.json'),'utf8'));report.parts[part]={vertices:after.vertices,triangles:after.triangles};fs.writeFileSync(path.join(out,'mesh_report.json'),JSON.stringify(report));
 const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.mesh=entry;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part,page_edges:'pot',pack_shape:'rect'},target:{before:{vertices:178,triangles:296,hull:58},after}}));
 console.log('rig-parts remesh: wrote under '+out);process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,TEXTURE_STRETCH:{status:'PASS'},PASS:true}));console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=fs.readFileSync(f('--rig'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],rig:crypto.createHash('sha256').update(rig).digest('hex'),flags:a.slice(a.indexOf('--page-edges'))}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png-'+rig.length);console.log('rigc: wrote');`;

async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-runner-tail-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const [name,text] of Object.entries(inspected))await writeFile(join(rig,name),text);
 for(const name of ['topwear.png','chest.png'])await writeFile(join(rig,'images',name),`png-${name}`);
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state')};
}
const md5=(bytes:Uint8Array|string)=>createHash('md5').update(bytes).digest('hex');
/** Wall clocks are the one field a replay cannot repeat. */
const normalize=(value:unknown):unknown=>JSON.parse(JSON.stringify(value,(key,v)=>key==='wallMs'&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,n])=>[k,typeof n==='number'?'ms':n])):v));
/** Every file under the package's scratch root, by relative path: its md5, or result.json's normalized JSON. */
async function scratchTree(dir:string):Promise<Record<string,unknown>>{
 const out:Record<string,unknown>={};
 const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name),rel=relative(dir,full);if(e.isDirectory()){out[rel+'/']=null;await walk(full);}else out[rel]=e.name==='result.json'?normalize(JSON.parse(await readFile(full,'utf8'))):md5(await readFile(full));}};
 await walk(dir);return out;
}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,job:{id:string;status:string}):Promise<{id:string;status:string;build:{files:Record<string,string>}|null}>{let current=job as never as {id:string;status:string;build:null};for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const patchFor=(configSha:string,ops:ConfigPatch['ops'],op:ConfigPatch['op']):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version:'1.42.0'},op});

interface Step { name: string; response: unknown; tree: Record<string,unknown> }
async function replay():Promise<Step[]>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string}};const hash=status.inputs.configHash;
  const steps:[string,unknown][]=[
   ['designation remesh (#99), built',{part:'topwear',regions:[{...bust,cx:424}],configHash:hash}],
   ['patch rig (#102), built',{patch:patchFor(hash,[{op:'replace',path:'/constraints/0/damping',value:0.8}],{cmd:'rig',args:['--page-edges','pot']})}],
   ['patch remesh (#106), built',{patch:patchFor(hash,[{op:'replace',path:'/meshes/topwear/contour/spacing',value:20}],{cmd:'remesh',args:['--part','topwear']})}],
   ['designation remesh (#99), refused',{part:'refuse',regions:[bust],configHash:hash}],
   ['patch rig (#102), refused',{patch:patchFor(hash,[{op:'replace',path:'/constraints/0/damping',value:7}],{cmd:'rig',args:[]})}],
  ];
  const out:Step[]=[];
  for(const [name,body] of steps){
   const started=await post(base,body);expect(started.status).toBe(202);
   const job=await settle(base,await started.json() as {id:string;status:string});
   out.push({name,response:normalize(job),tree:await scratchTree(join(state,'rebuild',p.sourceHash))});
  }
  return out;
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
}

const meshCheck={schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS; 1 of 1 bar(s) measured',bars:{TEXTURE_STRETCH:'PASS'},gate:true,source:'check'};
/** Only explicit evidence additions are projected away after independent assertions; unknown drift still fails the old record. */
function historicalResponse(current:unknown,old:unknown,index:number):unknown {
 const value=structuredClone(current) as Record<string,any>,before=old as Record<string,any>;
 const extra=index===0?['check','files','remesh','stageInputHash']:index===2?['stageInputHash']:index===3?['check']:[];
 expect(Object.keys(value).filter(k=>!Object.hasOwn(before,k)).sort()).toEqual([...extra].sort());
 if(index===0){
  expect(value.check).toEqual(meshCheck);
  expect(value.files).toEqual({documents:[{file:'rig.json',count:1,paths:['/mesh']},{file:'motion.json',count:0,paths:[]},{file:'sets.json',count:0,paths:[]},{file:'mesh_report.json',count:1,paths:['/parts/topwear/vertices']}],images:{changed:0,unchanged:2,names:[]}});
  // Fixture remesh writes these counts; the stand-in compiled model has no skin table to measure, so null stays explicit.
  expect(value.remesh).toEqual({part:'topwear',before:{vertices:178,triangles:296,hull:58},after:{vertices:179,triangles:296,hull:58},modelTriangles:null});
  expect(value.lines).toEqual([...before.lines.slice(0,3),
   'review: against the inspected rig — rig.json differs at 1 path(s) · mesh_report.json differs at 1 path(s) · motion.json, sets.json unchanged · 2 images unchanged',
   'review: rig.json: /mesh','review: mesh_report.json: /parts/topwear/vertices',...before.lines.slice(3),
   'review: remesh.json carries no check line or block statuses (@rig-c/parts before 1.49.0), so check runs on the revision',
   'review: @rig-c/parts 1.42.0 check --rig revision --out check --parts <handoff parts>',meshCheck.line]);
  value.lines=before.lines;
 }
 if(index===1||index===2){
  expect(value.check).toEqual({...before.check,source:'check'});
  delete value.check.source;
 }
 if(index===0||index===2)expect(value.stageInputHash).toMatch(/^[a-f0-9]{64}$/);
 if(index===3)expect(value.check).toBeNull(); // A producer refusal is never given a synthetic PASS.
 for(const key of extra)delete value[key];
 return value;
}

test('#121 bar: both runners give the same responses, job lines, build hashes and scratch trees as before the shared tail',async()=>{
 const steps=await replay();
 if(process.env.RUNNER_TAIL_RECORD){await writeFile(RECORD,JSON.stringify(steps,null,1)+'\n');return;}
 const record=JSON.parse(await readFile(RECORD,'utf8')) as Step[];
 expect(steps.map(s=>s.name)).toEqual(record.map(s=>s.name));
 // The statuses the replay is about: three built, two refused, and nothing left of a refusal.
 expect(steps.map(s=>(s.response as {status:string}).status)).toEqual(['built','built','built','refused','refused']);
 for(const [i,step] of steps.entries()){
  // Build hashes first, so a skipped hash names itself before the larger comparisons.
  expect({step:step.name,build:(step.response as {build:unknown}).build}).toEqual({step:record[i]!.name,build:(record[i]!.response as {build:unknown}).build});
  expect({step:step.name,response:historicalResponse(step.response,record[i]!.response,i)}).toEqual({step:record[i]!.name,response:record[i]!.response});
  const tree=structuredClone(step.tree);
  if(i===0){
   const id=(step.response as {id:string}).id,dir=id+'/check/',file=dir+'check.json';
   expect(tree[dir]).toBeNull();expect(tree[file]).toBe(md5(JSON.stringify({gate_spine_html_green:true,TEXTURE_STRETCH:{status:'PASS'},PASS:true})));
   delete tree[dir];delete tree[file];
  }
  for(const path of Object.keys(tree).filter(p=>p.endsWith('/result.json'))){
   const result=tree[path] as Record<string,any>,old=record[i]!.tree[path];
   const owner=record.findIndex(s=>(s.response as {id:string}).id===result.id);expect(owner).toBeGreaterThanOrEqual(0);
   if(owner===0||owner===2){const response=steps[owner]!.response as Record<string,unknown>;expect(result.stageInputHash).toBe(response.stageInputHash);}
   tree[path]=historicalResponse(result,old,owner);
  }
  expect({step:step.name,tree}).toEqual({step:record[i]!.name,tree:record[i]!.tree});
 }
});
