import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {REMESH_DELTA_SINCE,remeshDeltaArgs} from '../src/producer.ts';
import {deltaId,parseDeltaRequest,RebuildError} from '../src/rebuild.ts';
import {MESH_EDIT_BASIS,MESH_EDIT_SCHEMA,MeshEditSession,meshEditDocument,meshEditText,type MeshSource} from '../src/mesh-edit.ts';
import {APPLIED_DELTA_SCHEMA,appliedSummary,parseAppliedContext} from '../src/applied-context.ts';
import {deltaAppliedRecord,deltaOutcomeLine,stageModel,type DeltaJobView} from '../web/rebuild-client.ts';

/**
 * #135: Edit Mesh's Apply · Rebuild sends the exported setup-space delta through the shared runner as
 * `rig-parts remesh --delta mesh-edit.json --part <part>`. Stand-ins: `rig-parts remesh --delta` refuses a basis other
 * than "setup" (REMESH_DELTA_BASIS) and a source.hash other than the input's (REMESH_DELTA_SOURCE), each as the real
 * producer prints them (a FAIL line, then `refused:`), and otherwise writes a revision with the delta's moved vertex and
 * remesh.json; `rigc build` writes a model and one page.
 */
const INPUT_HASH='a'.repeat(64);
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,a.join(' ')+'\\n');
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));console.log('rig-parts rig: wrote '+out);process.exit(0);}
if(a[0]!=='remesh'||!a.includes('--delta')){console.log('  FAIL  STANDIN_ARGS: '+a.join(' '));process.exit(2);}
const file=f('--delta'),doc=JSON.parse(fs.readFileSync(file,'utf8')),part=f('--part');
console.log('rig-parts remesh: '+part+' of '+f('--rig')+'; the request is a mesh edit of '+doc.ops.length+' op(s)');
const refuse=(line)=>{console.log(line);console.log('refused: 1 problem(s)');process.exit(1);};
if(doc.basis!=='setup')refuse('  FAIL  REMESH_DELTA_BASIS: '+file+' basis is '+JSON.stringify(doc.basis)+'; "setup" is required — the producer binds setup positions, and a delta drawn over a pose (review before rig-c/review #100) is refused rather than posed back');
if(doc.source.hash!=='${INPUT_HASH}')refuse('  FAIL  REMESH_DELTA_SOURCE: '+file+' source.hash is '+doc.source.hash.slice(0,16)+'…; the input\\'s '+part+' in its skeleton.model.json hashes to ${INPUT_HASH.slice(0,16)}… — the delta was drawn over another mesh');
const out=f('--out'),src=f('--rig');fs.mkdirSync(out);for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));
const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.moved=doc.ops.filter(o=>o.op==='move').map(o=>[o.v,o.to]);fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part,delta:doc,ops:doc.ops.length,page_edges:'pot',pack_shape:'rect'},target:{before:{vertices:5,triangles:4,hull:4},after:{vertices:5,triangles:4,hull:4}}}));
console.log('rig-parts remesh: wrote 4 file(s) under '+out+', the provenance in remesh.json');`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,'rigc '+a.join(' ')+'\\n');
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],moved:rig.moved??null,skins:[{name:'default',attachments:{panel:{panel:{kind:'mesh',triangles:[0,1,4,1,2,4,2,3,4,3,0,4]}}}}]}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;

async function install(root:string,version:string){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
}
const config={key:'k',meshes:{panel:{grid:4}}};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'review-delta-')),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const name of ['rig.json','motion.json','mesh_report.json','sets.json'])await writeFile(join(pkg,'rig/out/rig',name),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');
 return {root,pkg,state:join(root,'state'),log:join(root,'calls.log')};
}
async function treeHash(dir:string):Promise<string>{
 const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};
 await walk(dir);return hash.digest('hex');
}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const configHash=async(pkg:string)=>sha(await readFile(join(pkg,'rig/config.json'),'utf8'));
const square=(hash=INPUT_HASH):MeshSource=>({slot:'panel',skin:'default',attachment:'panel',vertices:[[0,0],[10,0],[10,10],[0,10],[5,5]],triangles:[0,1,4,1,2,4,2,3,4,3,0,4],hull:4,hash});
/** One Modify move of vertex 4 by (+1.5, −1), exported as the editor exports it. */
function delta(hash=INPUT_HASH){const s=new MeshEditSession(square(hash));s.record(s.moveOps([4],1.5,-1));return meshEditDocument(s);}
async function settle(base:string,job:{id:string;status:string}):Promise<DeltaJobView>{let current=job as DeltaJobView;for(let i=0;current.status==='running'&&i<200;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
const calls=async(log:string)=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean);

test('#135 request: exactly {part, delta, configHash}; the delta is one document; flags are remesh\'s with --delta in place of --mesh',()=>{
 const doc=delta(),hash='f'.repeat(64);
 expect(parseDeltaRequest({part:'panel',delta:doc,configHash:hash})).toEqual({part:'panel',delta:doc as unknown as Record<string,unknown>,configHash:hash});
 for(const bad of [{part:'panel',delta:doc,configHash:hash,extra:1},{part:'panel',delta:doc},{part:'../x',delta:doc,configHash:hash},{part:'panel',delta:[doc],configHash:hash},{part:'panel',delta:'{}',configHash:hash},{part:'panel',delta:doc,configHash:'nope'},{part:'panel',delta:doc,configHash:hash,path:'/tmp/x'}])
  expect(()=>parseDeltaRequest(bad)).toThrow(RebuildError);
 expect(()=>parseDeltaRequest({part:'panel',delta:doc,configHash:hash,extra:1})).toThrow('REBUILD_REQUEST_INVALID: expected exactly {part, delta, configHash}');
 expect(remeshDeltaArgs({rig:'R',config:'C',parts:'P',part:'panel',delta:'mesh-edit.json',out:'rig'})).toEqual(['remesh','--rig','R','--config','C','--parts','P','--part','panel','--delta','mesh-edit.json','--out','rig']);
 expect(REMESH_DELTA_SINCE).toBe('1.43.0');
 const base={sourceHash:'s',configHash:hash,part:'panel',deltaText:meshEditText(doc),producer:'@rig-c/parts@1.44.0',compiler:'rig-c@2.64.1'};
 expect(deltaId(base)).toBe(deltaId({...base}));expect(deltaId(base)).not.toBe(deltaId({...base,deltaText:meshEditText(delta('b'.repeat(64)))}));
 expect(meshEditText(doc)).toBe(JSON.stringify(doc,null,2)+'\n');
});

test('#135 bar 1 (stand-in): Apply runs remesh --delta over the handoff rig, writes the download\'s bytes, records the delta by hash and content, op remesh, diff and counts; nothing in the package changes',async()=>{
 const {root,pkg,state,log}=await fixture();await install(root,'1.44.0');process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const doc=delta(),started=await post(base,{part:'panel',delta:doc,configHash:await configHash(pkg)});expect(started.status).toBe(202);
  const job=await settle(base,await started.json());
  expect(job.producerLine).toContain('rig-parts remesh: wrote 4 file(s)');
  expect(job).toMatchObject({kind:'delta',op:'remesh',status:'built',exitCode:0,request:{part:'panel',deltaSha256:sha(meshEditText(doc))},producer:{package:'@rig-c/parts',version:'1.44.0'}});
  expect(job.request.delta).toEqual(doc as unknown as Record<string,unknown>);expect(job.wallMs.op).toBeNumber();expect(job.wallMs.compile).toBeNumber();
  const remesh=(await calls(log)).filter(l=>l.startsWith('remesh '));expect(remesh).toEqual([`remesh --rig ${join(p.root,'rig/out/rig')} --config ${join(p.root,'rig/config.json')} --parts ${join(p.root,'rig/out')} --part panel --delta mesh-edit.json --out rig`]);
  const dir=join(state,'rebuild',p.sourceHash,job.id);expect(await readFile(join(dir,'mesh-edit.json'),'utf8')).toBe(meshEditText(doc));
  expect((await calls(log)).find(l=>l.startsWith('rigc '))).toContain('--page-edges pot --pack-shape rect');
  expect(job.files?.documents.find(d=>d.file==='rig.json')).toEqual({file:'rig.json',count:1,paths:['/moved']});
  expect(job.remesh).toEqual({part:'panel',before:{vertices:5,triangles:4,hull:4},after:{vertices:5,triangles:4,hull:4},modelTriangles:4});
  const model=JSON.parse(await (await fetch(base+job.build!.modelUrl)).text());expect(model.moved).toEqual([[4,[6.5,4]]]);
  const record=deltaAppliedRecord(job);
  expect(record).toMatchObject({schema:APPLIED_DELTA_SCHEMA,part:'panel',deltaSha256:sha(meshEditText(doc)),op:'remesh',line:job.producerLine,modelHash:job.build!.modelHash,mesh:{part:'panel'}});
  expect(record.delta).toEqual(doc as unknown as Record<string,unknown>);
  expect(()=>parseAppliedContext(record)).not.toThrow();
  expect(appliedSummary(record)).toStartWith(`mesh edit ${sha(meshEditText(doc)).slice(0,12)}… (remesh --delta; 1 op(s) on panel) with @rig-c/parts 1.44.0 · rig.json differs at 1 path(s)`);
  expect(deltaOutcomeLine(job).text).toContain('Reset returns to the inspected build');
  expect(stageModel(job,{url:'u',hash:'h'})).toEqual({url:job.build!.modelUrl,hash:job.build!.modelHash,id:job.id});
  // The same delta again reuses its build; nothing runs.
  const again=await (await post(base,{part:'panel',delta:doc,configHash:await configHash(pkg)})).json();expect(again).toMatchObject({id:job.id,status:'built',reused:true});
  expect((await calls(log)).filter(l=>l.startsWith('remesh '))).toHaveLength(1);
  expect(await treeHash(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#135 bars 2 and 3 (stand-in): a stale source hash and a posed (pre-#100) basis come back as the producer\'s line verbatim; no build, the stage keeps its model, the package unchanged',async()=>{
 const {root,pkg,state}=await fixture();await install(root,'1.44.0');
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const stale=await settle(base,await (await post(base,{part:'panel',delta:delta('b'.repeat(64)),configHash:await configHash(pkg)})).json());
  expect(stale).toMatchObject({status:'refused',exitCode:1,build:null,producerLine:`FAIL  REMESH_DELTA_SOURCE: mesh-edit.json source.hash is bbbbbbbbbbbbbbbb…; the input's panel in its skeleton.model.json hashes to aaaaaaaaaaaaaaaa… — the delta was drawn over another mesh`});
  expect(deltaOutcomeLine(stale)).toEqual({text:stale.producerLine!,error:true});expect(stageModel(stale,{url:'inspected',hash:'h'})).toEqual({url:'inspected',hash:'h',id:null});
  const posed={...delta(),basis:'posed'};
  const refused=await settle(base,await (await post(base,{part:'panel',delta:posed,configHash:await configHash(pkg)})).json());
  expect(refused.status).toBe('refused');expect(refused.producerLine).toStartWith('FAIL  REMESH_DELTA_BASIS: mesh-edit.json basis is "posed"; "setup" is required');
  expect(MESH_EDIT_BASIS).toBe('setup');expect(delta().basis).toBe('setup');expect(delta().schema).toBe(MESH_EDIT_SCHEMA);
  // A refusal leaves no scratch build behind.
  expect(await readdir(join(state,'rebuild',p.sourceHash))).toEqual([]);
  expect(await treeHash(pkg)).toBe(before);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#135 floor: a producer before 1.43.0 (no --delta) refuses MODELING_PRODUCER_TOO_OLD <found> <required> and runs nothing; a stale config hash and an oversized body are refused before anything runs',async()=>{
 const {root,pkg,state,log}=await fixture();await install(root,'1.42.0');process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const old=await post(base,{part:'panel',delta:delta(),configHash:await configHash(pkg)});expect(old.status).toBe(200);
  const line='MODELING_PRODUCER_TOO_OLD 1.42.0 1.43.0: rig-parts remesh --delta needs @rig-c/parts 1.43.0 or later — bun add -d @rig-c/parts@latest';
  expect(await old.json()).toEqual({status:'refused',error:line,producerLine:line});
  expect(await calls(log)).toEqual([]);
  await install(root,'1.43.0');
  const stale=await (await post(base,{part:'panel',delta:delta(),configHash:'0'.repeat(64)})).json();expect(stale.error).toStartWith('REBUILD_CONFIG_STALE: ');
  const malformed=await post(base,{part:'panel',delta:delta(),configHash:await configHash(pkg),extra:1});expect(malformed.status).toBe(400);
  const big={...delta(),units:'x'.repeat(70*1024)};expect((await (await post(base,{part:'panel',delta:big,configHash:await configHash(pkg)})).json()).error).toContain('REBUILD_BODY_LIMIT');
  expect(await calls(log)).toEqual([]);
  const built=await settle(base,await (await post(base,{part:'panel',delta:delta(),configHash:await configHash(pkg)})).json());expect(built.status).toBe('built');
  expect(await treeHash(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#135 context.applied: rig-review-applied/3 holds exactly the delta record; a wrong op, basis, part or an extra key is refused by name',()=>{
 const doc=delta() as unknown as Record<string,unknown>,hex=(c:string)=>c.repeat(64);
 const record={schema:APPLIED_DELTA_SCHEMA,buildId:hex('d'),part:'panel',delta:doc,deltaSha256:hex('c'),configHash:hex('f'),producer:{package:'@rig-c/parts',version:'1.44.0'},compiler:{package:'rig-c',version:'2.64.1'},line:'rig-parts remesh: wrote',op:'remesh',files:null,mesh:{part:'panel',before:{vertices:5,triangles:4,hull:4},after:{vertices:5,triangles:4,hull:4}},modelHash:hex('e')};
 expect(()=>parseAppliedContext(record)).not.toThrow();
 const {mesh:_m,...plain}=record;expect(()=>parseAppliedContext(plain)).not.toThrow();
 expect(()=>parseAppliedContext({...record,op:'rig'})).toThrow('feedback.context.applied.op');
 expect(()=>parseAppliedContext({...record,delta:{...doc,basis:'posed'}})).toThrow('feedback.context.applied.delta');
 expect(()=>parseAppliedContext({...record,part:'neck'})).toThrow('feedback.context.applied.delta');
 expect(()=>parseAppliedContext({...record,mesh:{...record.mesh,part:'neck'}})).toThrow('feedback.context.applied.mesh.part');
 expect(()=>parseAppliedContext({...record,extra:1})).toThrow('feedback.context.applied');
 expect(()=>parseAppliedContext({...record,deltaSha256:'x'})).toThrow('deltaSha256');
 expect(appliedSummary(record)).toBe(`mesh edit ${'c'.repeat(12)}… (remesh --delta; 1 op(s) on panel) with @rig-c/parts 1.44.0 · panel v 5 t 4 → v 5 t 4 · model ${'e'.repeat(12)}…`);
});
