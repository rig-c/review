import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {frontRoute} from '../src/front.ts';
import {compileArgs,firstRefusal,MODELING_PRODUCER_NOT_INSTALLED,remeshArgs,resolveProducer,REMESH_SINCE,versionAtLeast} from '../src/producer.ts';
import {designationId,meshEntryText,parseRebuildRequest,RebuildError} from '../src/rebuild.ts';
import {appliedRecord,designatedRegions,outcomeLine,pickPart,runRebuild,seedFields,type RebuildJobView} from '../web/rebuild-client.ts';
import {chestRowId,type ChestFieldValue} from '../web/chest-regions-tool.ts';

const bust={name:'bust',shape:'circle' as const,cx:414,cy:342,r:50,bone:'chest_jiggle',spacing:13,band:30};
const config={key:'k',meshes:{topwear:{contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,bridges:true,regions:[bust]},r:15,segments:[['chest',[416,230],[416,600]]]},neck:{grid:10}}};
const REFUSAL='  FAIL  REMESH_TARGET_MESH: refuse — a linked mesh is bound to it (see rig-parts guide REMESH_TARGET_MESH)';

/** A stand-in `rig-parts` (remesh writes a rig spec; a part named "refuse" is refused) and `rigc` (build writes a model and one page). */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='--version'){console.log(process.env.FAKE_VERSION||'0');process.exit(0);}
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,a.join(' ')+'\\n');
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));if(process.env.FAKE_PERTURB)fs.writeFileSync(path.join(out,'rig.json'),'{"perturbed":true}');console.log('rig-parts rig: wrote '+out);process.exit(0);}
console.log('rig-parts remesh: '+f('--part'));console.error('[baseline:rig] stderr line');
if(f('--part')==='refuse'){console.log(${JSON.stringify(REFUSAL)});console.log('refused: 1 problem(s)');process.exit(1);}
const out=f('--out');fs.mkdirSync(out);const mesh=fs.readFileSync(f('--mesh'),'utf8');
fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify({mesh:JSON.parse(mesh)}));fs.writeFileSync(path.join(out,'motion.json'),'{}');
fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{page_edges:'free',pack_shape:'polygon'}}));
console.log('rig-parts remesh: wrote 3 file(s) under '+out+', the provenance in remesh.json');`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,'rigc '+a.join(' ')+'\\n');
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],regions:rig.mesh.contour.regions}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote '+path.join(out,'skeleton.model.json'));`;

async function install(root:string,version:string){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'review-rebuild-')),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const name of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(pkg,'rig/out/rig',name),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');
 return {root,pkg,state:join(root,'state'),log:join(root,'calls.log')};
}
/** Every file's path and bytes under a directory. */
async function treeHash(dir:string):Promise<string>{
 const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};
 await walk(dir);return hash.digest('hex');
}
const configHash=async(pkg:string)=>createHash('sha256').update(await readFile(join(pkg,'rig/config.json'))).digest('hex');

test('the producer resolves from node_modules beside the package, by version, never from PATH',async()=>{
 const {root,pkg}=await fixture();
 try{
  const none=resolveProducer([pkg]);expect(none).toEqual({ok:false,error:MODELING_PRODUCER_NOT_INSTALLED});
  expect(MODELING_PRODUCER_NOT_INSTALLED).toContain('bun add -d @rig-c/parts');expect(MODELING_PRODUCER_NOT_INSTALLED).toStartWith('MODELING_PRODUCER_NOT_INSTALLED: ');
  await install(root,'1.39.9');
  expect(resolveProducer([pkg])).toEqual({ok:false,error:'MODELING_PRODUCER_TOO_OLD 1.39.9 1.40.0: rig-parts remesh needs @rig-c/parts 1.40.0 or later — bun add -d @rig-c/parts@latest'});
  await install(root,'1.42.0');const found=resolveProducer([pkg]);
  expect(found.ok&&found.producer).toMatchObject({package:'@rig-c/parts',version:'1.42.0',bin:join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs')});
  expect(found.ok&&found.compiler).toMatchObject({package:'rig-c',version:'2.64.1'});
  await rm(join(root,'node_modules/rig-c'),{recursive:true});expect(resolveProducer([pkg]).ok).toBe(false);expect((resolveProducer([pkg]) as {error:string}).error).toStartWith('MODELING_COMPILER_NOT_INSTALLED');
  expect(REMESH_SINCE).toBe('1.40.0');expect(versionAtLeast('1.40.0','1.40.0')).toBe(true);expect(versionAtLeast('1.39.12','1.40.0')).toBe(false);expect(versionAtLeast('2.0.0','1.40.0')).toBe(true);expect(versionAtLeast('1.41.0-beta','1.40.0')).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('remesh and compile flags are the producer\'s documented ones; the first named refusal is quoted verbatim',()=>{
 expect(remeshArgs({rig:'R',config:'C',parts:'P',part:'topwear',mesh:'mesh.json',out:'revision'})).toEqual(['remesh','--rig','R','--config','C','--parts','P','--part','topwear','--mesh','mesh.json','--out','revision']);
 expect(compileArgs({rig:'revision/rig.json',motion:'revision/motion.json',out:'build',pageEdges:'free',packShape:'polygon'})).toEqual(['build','--rig','revision/rig.json','--motion','revision/motion.json','--out','build','--profile','rig-play','--pack','--page-edges','free','--pack-shape','polygon']);
 expect(firstRefusal(['[baseline:rig] mesh topwear v=178','  FAIL  REMESH_REQUEST_HELD: rig.json bones — the request changes it','  FAIL  OTHER_CODE: x','refused: 2 problem(s)'])).toBe('FAIL  REMESH_REQUEST_HELD: rig.json bones — the request changes it');
 expect(firstRefusal(['x','refused: 1 problem(s)'])).toBe('refused: 1 problem(s)');expect(firstRefusal(['ok'])).toBeNull();
});

test('a request is {part, regions, configHash} only; the entry replaces that part\'s regions and nothing else; the scratch name has no clock',async()=>{
 const hash='a'.repeat(64);
 expect(parseRebuildRequest({part:'topwear',regions:[bust],configHash:hash},['chest_jiggle'])).toEqual({part:'topwear',regions:[bust],configHash:hash});
 for(const extra of [{out:'/tmp/x'},{config:'../x'},{command:'rm'}])expect(()=>parseRebuildRequest({part:'topwear',regions:[bust],configHash:hash,...extra},null)).toThrow('REBUILD_REQUEST_INVALID');
 expect(()=>parseRebuildRequest({part:'../topwear',regions:[bust],configHash:hash},null)).toThrow('REBUILD_REQUEST_INVALID: part');
 expect(()=>parseRebuildRequest({part:'topwear',regions:[{...bust,bone:'nope'}],configHash:hash},['chest_jiggle'])).toThrow('REBUILD_REGION_BONE_UNKNOWN');
 expect(()=>parseRebuildRequest({part:'topwear',regions:[{...bust,cx:414.001}],configHash:hash},null)).toThrow('off the 1/256 px grid');
 expect(()=>parseRebuildRequest({part:'topwear',regions:[],configHash:hash},null)).toThrow('regions must hold');
 const moved={...bust,cx:424},text=JSON.stringify(config,null,1),entry=JSON.parse(meshEntryText(text,'topwear',[moved]));
 expect(entry).toEqual({...config.meshes.topwear,contour:{...config.meshes.topwear.contour,regions:[moved]}});
 expect(()=>meshEntryText(text,'neck',[moved])).toThrow(RebuildError);expect(()=>meshEntryText(text,'neck',[moved])).toThrow('REBUILD_PART_NOT_CONTOUR');
 const id={sourceHash:'s',configHash:'c',part:'topwear',entry:meshEntryText(text,'topwear',[moved]),producer:'@rig-c/parts@1.42.0',compiler:'rig-c@2.64.1'};
 const first=designationId(id);await Bun.sleep(5);expect(designationId(id)).toBe(first);expect(first).toMatch(/^[a-f0-9]{64}$/);
 expect(designationId({...id,entry:meshEntryText(text,'topwear',[bust])})).not.toBe(first);expect(designationId({...id,producer:'@rig-c/parts@1.43.0'})).not.toBe(first);
});

async function settle(base:string,job:{id:string;status:string}):Promise<RebuildJobView>{let current=job as RebuildJobView;for(let i=0;current.status==='running'&&i<200;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const post=(base:string,body:unknown,origin=base)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});

test('bar 1: Apply runs remesh then the compile into <state>/rebuild/<package>/<designation>/, serves the build read-only, reuses an identical designation and replaces the previous one',async()=>{
 const {root,pkg,state,log}=await fixture();await install(root,'1.42.0');process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json();
  expect(status).toMatchObject({schema:'rig-review-rebuild-status/1',available:true,reason:null,inputs:{config:'rig/config.json',parts:'rig/out',rig:'rig/out/rig',configHash:await configHash(pkg)},handoff:{how:'discovered',via:'discovery',outside:false,config:{path:'rig/config.json',sha256:await configHash(pkg)}},parts:[{name:'topwear',regions:[bust]}],producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'}});
  const moved={...bust,cx:424},request={part:'topwear',regions:[moved],configHash:status.inputs.configHash};
  const started=await post(base,request);expect(started.status).toBe(202);const job=await settle(base,await started.json());
  expect(job).toMatchObject({schema:'rig-review-rebuild/1',status:'built',reused:false,exitCode:0,producerLine:expect.stringContaining('rig-parts remesh: wrote 3 file(s)'),request:{part:'topwear',regions:[moved]},producer:{version:'1.42.0'}});
  expect(job.lines).toContain('[baseline:rig] stderr line');expect(job.wallMs.remesh).toBeNumber();expect(job.wallMs.compile).toBeNumber();
  const dir=join(state,'rebuild',p.sourceHash,job.id);expect(job.build!.modelUrl).toBe(`/rebuild/${job.id}/skeleton.model.json`);
  expect(await readFile(join(dir,'mesh.json'),'utf8')).toBe(meshEntryText(JSON.stringify(config,null,1),'topwear',[moved]));
  const model=await fetch(base+job.build!.modelUrl);expect(model.status).toBe(200);expect(model.headers.get('content-security-policy')).toContain('sandbox');
  const bytes=await model.text();expect(JSON.parse(bytes).regions).toEqual([moved]);expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.build!.modelHash);
  expect((await fetch(`${base}/rebuild/${job.id}/skeleton.png`)).status).toBe(200);
  for(const path of [`/rebuild/${job.id}/remesh.json`,`/rebuild/${job.id}/..%2Fmesh.json`,`/rebuild/${job.id}/%2E%2E/mesh.json`,`/rebuild/${'0'.repeat(64)}/skeleton.model.json`])expect((await fetch(base+path)).status).toBe(404);
  const calls=(await readFile(log,'utf8')).trim().split('\n');expect(calls.filter(l=>l.startsWith('remesh '))).toHaveLength(1);
  expect(calls.find(l=>l.startsWith('remesh '))).toBe(`remesh --rig ${join(p.root,'rig/out/rig')} --config ${join(p.root,'rig/config.json')} --parts ${join(p.root,'rig/out')} --part topwear --mesh mesh.json --out revision`);
  // The same designation again: the same path, nothing run.
  const again=await (await post(base,request)).json();expect(again).toMatchObject({id:job.id,status:'built',reused:true});
  expect((await readFile(log,'utf8')).trim().split('\n').filter(l=>l.startsWith('remesh '))).toHaveLength(1);
  // A new designation replaces the previous scratch build.
  const next=await settle(base,await (await post(base,{...request,regions:[{...bust,cy:350}]})).json());expect(next.status).toBe('built');expect(next.id).not.toBe(job.id);
  expect(await readdir(join(state,'rebuild',p.sourceHash))).toEqual([next.id]);expect((await fetch(base+job.build!.modelUrl)).status).toBe(404);
  expect(await treeHash(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 3: no producer installed — the named refusal with the install line, nothing run, nothing written, the package unchanged',async()=>{
 const {root,pkg,state}=await fixture();const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json();expect(status).toMatchObject({available:false,reason:MODELING_PRODUCER_NOT_INSTALLED,producer:null});
  const response=await post(base,{part:'topwear',regions:[bust],configHash:await configHash(pkg)});expect(response.status).toBe(200);
  expect(await response.json()).toEqual({status:'refused',error:MODELING_PRODUCER_NOT_INSTALLED,producerLine:MODELING_PRODUCER_NOT_INSTALLED});
  expect(await Bun.file(join(state,'rebuild')).exists()).toBe(false);expect(await readdir(root)).toEqual(['pkg']);expect(await treeHash(pkg)).toBe(before);
  await install(root,'1.39.0');expect((await (await post(base,{part:'topwear',regions:[bust],configHash:await configHash(pkg)})).json()).error).toStartWith('MODELING_PRODUCER_TOO_OLD 1.39.0 1.40.0');
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 4: a producer refusal comes back as its line verbatim and serves no build; mutations stay same-origin, typed and bounded',async()=>{
 const {root,pkg,state}=await fixture();await install(root,'1.42.0');
 const text=JSON.stringify({...config,meshes:{...config.meshes,refuse:config.meshes.topwear}},null,1);await writeFile(join(pkg,'rig/config.json'),text);
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const hash=await configHash(pkg),job=await settle(base,await (await post(base,{part:'refuse',regions:[bust],configHash:hash})).json());
  expect(job).toMatchObject({status:'refused',exitCode:1,producerLine:REFUSAL.trim(),build:null});
  expect(outcomeLine(job)).toEqual({text:REFUSAL.trim(),error:true});
  expect((await fetch(`${base}/rebuild/${job.id}/skeleton.model.json`)).status).toBe(404);
  expect(await Bun.file(join(state,'rebuild',p.sourceHash,job.id,'mesh.json')).exists()).toBe(false);
  expect((await post(base,{part:'topwear',regions:[bust],configHash:hash},'http://evil.test')).status).toBe(403);
  expect((await post(base,{part:'topwear',regions:[bust],configHash:hash,out:'/tmp'})).status).toBe(400);
  expect((await post(base,{part:'topwear',regions:[{...bust,name:'x'.repeat(70*1024)}],configHash:hash})).status).toBe(400);
  // A valid request padded past 64 KiB with JSON whitespace: refused by its size alone, nothing run.
  const padded=await fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({part:'topwear',regions:[bust],configHash:hash})+' '.repeat(65*1024)});
  expect(padded.status).toBe(400);expect(await padded.json()).toEqual({error:'REBUILD_BODY_LIMIT: maximum 64 KiB'});
  expect(await (await post(base,{part:'topwear',regions:[bust],configHash:'b'.repeat(64)})).json()).toMatchObject({status:'refused',error:expect.stringMatching(/^REBUILD_CONFIG_STALE/)});
  expect(await treeHash(pkg)).toBe(before);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('the producer beside the package wins over one beside review\'s working directory',async()=>{
 const {root,pkg,state}=await fixture(),elsewhere=join(root,'elsewhere');await install(root,'1.42.0');await install(elsewhere,'1.39.0');
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:elsewhere}),base=`http://127.0.0.1:${server.port}`;
 try{expect(await (await fetch(base+'/api/rebuild')).json()).toMatchObject({available:true,producer:{version:'1.42.0'}});}
 finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('the managed front passes the rebuild routes for a single review only',()=>{
 const id='c'.repeat(64);
 expect(frontRoute('single','GET','/api/rebuild')).toMatchObject({mutation:false});expect(frontRoute('single','POST','/api/rebuild')).toMatchObject({mutation:true,limit:65536});
 expect(frontRoute('single','GET',`/api/rebuild/${id}`)).toMatchObject({mutation:false});expect(frontRoute('single','GET',`/rebuild/${id}/skeleton.model.json`)).toMatchObject({mutation:false});
 expect(frontRoute('single','POST',`/api/rebuild/${id}`)).toBeNull();expect(frontRoute('single','GET','/rebuild/x/skeleton.png')).toBeNull();expect(frontRoute('compare','POST','/api/rebuild')).toBeNull();
});

test('the page turns rows into region entries, starts an untouched editor from the config and streams each line once',async()=>{
 const values:Record<string,ChestFieldValue>={};const read=(id:string)=>values[id];
 const seed=seedFields({parts:[{name:'topwear',regions:[bust]}],contour:{topwear:config.meshes.topwear}},read)!;
 expect(seed).toEqual({[chestRowId(0,'name')]:'bust',[chestRowId(0,'bone')]:'chest_jiggle',[chestRowId(0,'cx')]:'414',[chestRowId(0,'cy')]:'342',[chestRowId(0,'ax')]:'50',[chestRowId(0,'ay')]:'50',[chestRowId(0,'spacing')]:'13',[chestRowId(0,'band')]:'30','chest-tolerance':'2','chest-margin':'2','chest-spacing':'28','chest-max-edge':'45','chest-stray':'300','chest-bridges':'true','chest-r':'15','chest-segments':'[["chest",[416,230],[416,600]]]'});
 for(const [id,value] of Object.entries(seed))values[id]={value};
 expect(seedFields({parts:[{name:'topwear',regions:[bust]}],contour:{topwear:config.meshes.topwear}},read)).toBeNull();
 values[chestRowId(0,'cx')]={value:'424'};
 expect(designatedRegions(read)).toEqual({regions:[{...bust,cx:424}]});
 values[chestRowId(0,'ay')]={value:'40'};const polygon=designatedRegions(read) as {regions:{shape:string;points:unknown[]}[]};expect(polygon.regions[0]!.shape).toBe('polygon');expect(polygon.regions[0]!.points).toHaveLength(32);
 values[chestRowId(0,'ay')]={value:'50'};values[chestRowId(0,'name')]={value:''};expect(designatedRegions(read)).toEqual({error:'REBUILD_REGION_INCOMPLETE: row 1 name'});
 expect(pickPart({parts:[{name:'topwear',regions:[bust]},{name:'skirt',regions:[]}]},[bust])).toBe('topwear');expect(pickPart({parts:[{name:'a',regions:[]},{name:'b',regions:[]}]},[bust])).toBeNull();
 const job=(status:RebuildJobView['status'],lines:string[]):RebuildJobView=>({id:'d'.repeat(64),status,reused:false,lines,producerLine:status==='built'?'wrote':null,exitCode:status==='running'?null:0,wallMs:{remesh:79605,compile:1611},build:status==='built'?{modelUrl:'/m',modelHash:'e'.repeat(64),files:{}}:null,request:{part:'topwear',regions:[bust],configHash:'f'.repeat(64),entrySha256:'0'.repeat(64)},producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'}});
 const polls=[job('running',['a','b']),job('built',['a','b','c'])],seen:[string,number][]=[];
 const result=await runRebuild({part:'topwear',regions:[bust],configHash:'f'.repeat(64)},{post:async()=>job('running',['a']),get:async()=>polls.shift()!,onLine:(line,i)=>seen.push([line,i]),sleep:async()=>{}});
 expect(seen).toEqual([['a',0],['b',1],['c',2]]);expect(result.status).toBe('built');
 expect(outcomeLine(result)).toEqual({text:'Applied topwear with @rig-c/parts 1.42.0 · remesh 79.6 s + compile 1.6 s · Reset returns to the inspected build',error:false});
 expect(appliedRecord(result as RebuildJobView)).toEqual({schema:'rig-review-applied/1',buildId:'d'.repeat(64),part:'topwear',regions:[bust],configHash:'f'.repeat(64),entrySha256:'0'.repeat(64),producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'},line:'wrote',modelHash:'e'.repeat(64)});
 const refusal={status:'refused' as const,error:MODELING_PRODUCER_NOT_INSTALLED,producerLine:MODELING_PRODUCER_NOT_INSTALLED};
 expect(await runRebuild({part:'topwear',regions:[bust],configHash:'f'.repeat(64)},{post:async()=>refusal,get:async()=>{throw new Error('no poll');},onLine:()=>{throw new Error('no line');},sleep:async()=>{}})).toEqual(refusal);
});
