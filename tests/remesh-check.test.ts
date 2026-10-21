import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {parseAppliedContext} from '../src/applied-context.ts';
import {carriedCheck,carriedCheckSummary,REMESH_CHECK_SINCE,REMESH_CHECK_STALE,RETUNE_CHECK_STALE,revisionBinding} from '../src/retune-check.ts';
import {patchAppliedRecord,patchOutcomeLine,type PatchJobView} from '../web/rebuild-client.ts';

/**
 * #174: a remesh patch Apply reads the check remesh already ran on its revision (remesh.json `check.revision`, parts
 * 1.49.0+) instead of running `rig-parts check` a third time. The stand-in `check` judges a rig by its mesh's contour
 * spacing (FAIL under 25) and writes check.json; the stand-in `remesh` runs the same judgment on its revision and carries
 * it the way parts' `checkSide` does — `line` byte for byte, `status` every block in check.json's order, gate/loop/seam
 * lower-case. `mode` beside the stand-in picks a producer: `carry` (1.49.1), `old` (no line/status), `other` (revision
 * rows from another revision: the input's), `altered` (a revision file changed after remesh.json was written).
 */
const constraints=[{type:'physics',name:'c0',bone:'chest',rotate:1,strength:100,damping:0.85}];
const contour={contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,bridges:true},r:15};
const config={key:'k',constraints,meshes:{topwear:contour}};
const fakeParts=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const mode=fs.readFileSync(path.join(__dirname,'mode'),'utf8').trim();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const tree=root=>{const out=[];const walk=d=>{for(const n of fs.readdirSync(d).sort()){const p=path.join(d,n);if(fs.statSync(p).isDirectory())walk(p);else out.push(path.relative(root,p).split(path.sep).join('/'));}};walk(root);return out.sort();};
const judge=dir=>{const rig=JSON.parse(fs.readFileSync(path.join(dir,'rig.json'),'utf8'));const s=rig.mesh?rig.mesh.contour.spacing:28,pass=s>=25;
 const json={gate_spine_html_green:true,loop_max_diff:1,seam_mean:null,BREATH_VISIBLE:{status:'PASS'},TEXTURE_STRETCH:{status:pass?'PASS':'FAIL'},CHAIN_LAG:{status:'SKIP'},CLOTH_SETTLES:{status:pass?'CLEAR':'WARN'},RECOMPOSITE_HOLES:{status:'REPORTED'},PASS:pass};
 const line=pass?'check: PASS; 3 of 4 bar(s) measured':'check: FAIL — 1 bar(s) not met; 3 of 4 bar(s) measured; 1 warning(s) (CLOTH_SETTLES, not a bar)';
 const status={gate:'PASS',loop:'PASS',seam:'SKIP',BREATH_VISIBLE:'PASS',TEXTURE_STRETCH:json.TEXTURE_STRETCH.status,CHAIN_LAG:'SKIP',CLOTH_SETTLES:json.CLOTH_SETTLES.status,RECOMPOSITE_HOLES:'REPORTED'};
 return {json,line,status,pass};};
const copy=(src,out)=>{for(const r of tree(src)){fs.mkdirSync(path.dirname(path.join(out,r)),{recursive:true});fs.copyFileSync(path.join(src,r),path.join(out,r));}};
if(a[0]==='remesh'){const out=f('--out'),input=f('--rig'),part=f('--part'),entry=JSON.parse(fs.readFileSync(f('--mesh'),'utf8'));
 const pe=a.includes('--page-edges')?f('--page-edges'):'free',ps=a.includes('--pack-shape')?f('--pack-shape'):'polygon';
 copy(input,out);const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.mesh=entry;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 const j=judge(out),ji=judge(input);const side=x=>({pass:x.pass,measured:['gate','loop'],not_met:x.pass?[]:['TEXTURE_STRETCH'],skipped:[],physics:null,...(mode==='old'?{}:{line:x.line,status:x.status})});
 const rows=tree(mode==='other'?input:out).map(p=>{const b=fs.readFileSync(path.join(mode==='other'?input:out,p));return {path:p,bytes:b.length,sha256:sha(b)};});
 console.log('  check: input '+(ji.pass?'PASS':'FAIL')+', revision '+(j.pass?'PASS':'FAIL'));
 fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part,mesh:entry,idle_keys:'ctl',page_edges:pe,pack_shape:ps},target:{before:{vertices:178,triangles:296,hull:58},after:{vertices:200,triangles:330,hull:58}},revision:rows,check:{input:side(ji),revision:side(j),scope:'physics'}},null,2)+'\\n');
 if(mode==='altered')fs.appendFileSync(path.join(out,'motion.json'),' ');
 console.log('rig-parts remesh: wrote '+(rows.length+1)+' file(s) under '+out+', the provenance in remesh.json');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.appendFileSync(path.join(__dirname,'check-runs'),a.slice(1).filter((_,i,x)=>x[i]!=='--parts'&&x[i-1]!=='--parts').join(' ')+'\\n');fs.mkdirSync(out,{recursive:true});const j=judge(f('--rig'));
 fs.writeFileSync(path.join(out,'check.json'),JSON.stringify(j.json));console.log('  gate: rig-play green');console.log(j.line);process.exit(j.pass?0:1);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],n:fs.readFileSync(f('--rig')).length}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;

async function fixture(mode:string,version:string){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-remesh-check-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),JSON.stringify({bones:[{name:'chest'}],constraints}));
 await writeFile(join(rig,'motion.json'),'{"animations":{"idle":{}}}');await writeFile(join(rig,'mesh_report.json'),'{"parts":{"topwear":{"vertices":178,"triangles":296}}}');await writeFile(join(rig,'images','topwear.png'),'png-topwear');
 await writeFile(join(pkg,'motion.json'),'{}');
 const bin=join(root,'node_modules/@rig-c/parts/bin');
 await mkdir(bin,{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(bin,'rig-parts.cjs'),fakeParts);await writeFile(join(bin,'mode'),mode);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state'),checkRuns:join(bin,'check-runs')};
}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,started:Response):Promise<PatchJobView&{error?:string}>{let job=await started.json() as PatchJobView;for(let i=0;job.status==='running'&&i<400;i++){await Bun.sleep(25);job=await (await fetch(`${base}/api/rebuild/${job.id}`)).json() as PatchJobView;}return job;}

/** One remesh Apply of topwear's spacing → 20 under `mode`: the settled job, check's runs (its args), and the scratch root's entries. */
async function applySpacing(mode:string,version='1.49.1'){
 const {root,pkg,state,checkRuns}=await fixture(mode,version);
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string}};
  const patch:ConfigPatch={schema:CONFIG_PATCH_SCHEMA,config_sha256:status.inputs.configHash,ops:[{op:'replace',path:'/meshes/topwear/contour/spacing',value:20}],producer:{name:'@rig-c/parts',version},op:{cmd:'remesh',args:['--part','topwear','--page-edges','pot','--pack-shape','rect']}};
  const job=await settle(base,await post(base,{patch}));
  let runs:string[]=[];try{runs=(await readFile(checkRuns,'utf8')).trim().split('\n').filter(Boolean);}catch{/* check never ran */}
  const scratch:string[]=[];try{const top=join(state,'rebuild');for(const d of await readdir(top))scratch.push(...(await readdir(join(top,d))));}catch{/* nothing kept */}
  return {job,runs,scratch};
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
}

test('#174 bar 1: a remesh Apply records remesh\'s carried check, equal field by field to what check reports on the same revision, and check does not run again',async()=>{
 const carried=await applySpacing('carry'),ran=await applySpacing('old');
 expect(carried.job).toMatchObject({status:'built',op:'remesh'});expect(ran.job).toMatchObject({status:'built',op:'remesh'});
 expect(carried.job.build!.modelHash).toBe(ran.job.build!.modelHash);
 expect(carried.runs).toEqual([]);
 // Review's own check reads remesh.json's pack flags — the ones remesh checked with.
 expect(ran.runs).toEqual(['--rig rig --out check --page-edges pot --pack-shape rect']);
 const {source,...fields}=carried.job.check!;
 expect(source).toBe('remesh');expect(Object.hasOwn(ran.job.check!,'source')).toBe(false);
 expect(fields).toEqual(ran.job.check!);
 expect(JSON.stringify(fields)).toBe(JSON.stringify(ran.job.check));
 expect(fields).toEqual({schema:'rig-review-check-summary/1',pass:false,exitCode:1,line:'check: FAIL — 1 bar(s) not met; 3 of 4 bar(s) measured; 1 warning(s) (CLOTH_SETTLES, not a bar)',bars:{BREATH_VISIBLE:'PASS',TEXTURE_STRETCH:'FAIL',CHAIN_LAG:'SKIP',CLOTH_SETTLES:'WARN',RECOMPOSITE_HOLES:'REPORTED'},gate:true});
 expect(carried.job.wallMs.check).toBeNull();
 expect(carried.job.lines).toContain('review: check not run again — remesh.json carries remesh\'s check of this revision, bound to it by 4 revision hash row(s): check: FAIL — 1 bar(s) not met; 3 of 4 bar(s) measured; 1 warning(s) (CLOTH_SETTLES, not a bar)');
 expect(carried.job.lines.some(l=>l.includes(' check --rig '))).toBe(false);
 const record=patchAppliedRecord({...carried.job,build:{...carried.job.build!}});
 expect(record.check?.source).toBe('remesh');expect(()=>parseAppliedContext(record)).not.toThrow();
 expect(patchOutcomeLine(carried.job).text).toContain('check FAIL (remesh\'s own check of this revision, not run again)');
 expect(patchOutcomeLine(carried.job).text).not.toContain('+ check');
});

test('#174 version gate: a remesh.json without line and status (before 1.49.0) is not refused — check runs, and the job says why',async()=>{
 expect(REMESH_CHECK_SINCE).toBe('1.49.0');
 const {job,runs}=await applySpacing('old','1.48.0');
 expect(job).toMatchObject({status:'built',op:'remesh'});expect(runs.length).toBe(1);
 expect(job.lines).toContain('review: remesh.json carries no check line or block statuses (@rig-c/parts before 1.49.0), so check runs on the revision');
 expect(job.lines.some(l=>l.includes(' check --rig rig --out check'))).toBe(true);
 expect(carriedCheck({check:{revision:{pass:true}}},'remesh')).toBeNull();
 expect(()=>carriedCheck({check:{revision:{pass:true,line:'check: PASS; x'}}},'remesh')).toThrow('remesh.json: check.revision.status');
});

test('#174 bar 3: a remesh.json from another revision, or a revision file altered after remesh, is refused REMESH_CHECK_STALE and records no build',async()=>{
 for(const mode of ['other','altered']){
  const {job,runs,scratch}=await applySpacing(mode);
  expect(job.status).toBe('refused');expect(job.build).toBeNull();expect(runs).toEqual([]);expect(scratch).toEqual([]);
  expect(job.producerLine).toMatch(mode==='other'
   ?/^REMESH_CHECK_STALE: rig\.json sha256 [0-9a-f]{64} in remesh\.json … [0-9a-f]{64} on disk; remesh's check is not this revision's, so no build is recorded$/
   :/^REMESH_CHECK_STALE: motion\.json sha256 [0-9a-f]{64} in remesh\.json … [0-9a-f]{64} on disk; remesh's check is not this revision's, so no build is recorded$/);
  expect(job.lines.at(-1)).toBe(`review: ${job.producerLine}`);
 }
});

test('#174: one binding for both ops — the stale name and file follow the op; retune\'s name is unchanged',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'review-remesh-bind-')));
 try{
  await writeFile(join(dir,'rig.json'),'{}');await writeFile(join(dir,'remesh.json'),'{}');
  const rows=[{path:'rig.json',bytes:2,sha256:'0'.repeat(64)}];
  expect(REMESH_CHECK_STALE).toBe('REMESH_CHECK_STALE');expect(RETUNE_CHECK_STALE).toBe('RETUNE_CHECK_STALE');
  expect(await revisionBinding(dir,{revision:rows},'remesh')).toMatch(/^REMESH_CHECK_STALE: rig\.json sha256 0{64} in remesh\.json … [0-9a-f]{64} on disk; remesh's check/);
  // remesh.json is the provenance a remesh revision may carry beside its rows; retune's binding does not take it.
  expect(await revisionBinding(dir,{revision:[{...rows[0],sha256:'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'}]},'remesh')).toBeNull();
  expect(await revisionBinding(dir,{revision:[{...rows[0],sha256:'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'}]})).toMatch(/^RETUNE_CHECK_STALE: remesh\.json sha256 absent in retune\.json/);
  expect(await revisionBinding(dir,{},'remesh')).toBe('REMESH_CHECK_STALE: remesh.json names no revision hash rows; its check is bound to no files');
 }finally{await rm(dir,{recursive:true,force:true});}
 expect(carriedCheckSummary({pass:true,line:'check: PASS; 1 of 1 bar(s) measured',status:{gate:'PASS',TEXTURE_STRETCH:'PASS'}},'remesh')).toEqual({schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS; 1 of 1 bar(s) measured',bars:{TEXTURE_STRETCH:'PASS'},gate:true,source:'remesh'});
});
