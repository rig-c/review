import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {parseAppliedContext} from '../src/applied-context.ts';
import {carriedCheck,RETUNE_CHECK_SINCE,retuneCheckSummary} from '../src/retune-check.ts';
import {patchAppliedRecord,patchOutcomeLine,type PatchJobView} from '../web/rebuild-client.ts';

/**
 * #139: a retune Apply reads the check retune already ran on its revision (retune.json `check.revision`, parts 1.49.0+)
 * instead of running `rig-parts check` again. The stand-in `check` judges a rig by its first constraint's damping (FAIL
 * under 0.7) and writes check.json; the stand-in `retune` (the inspected rig is a repaired build, so the baseline does
 * not reproduce and a damping patch routes to retune) runs the same judgment on its revision and carries it the way
 * parts' `checkSide` does — `line` byte for byte, `status` every block in check.json's order, gate/loop/seam lower-case.
 * `mode` beside the stand-in picks a producer: `carry` (1.49.1), `old` (no line/status), `other` (revision rows from
 * another revision), `altered` (a revision file changed after retune.json was written).
 */
const config={key:'k',bones:[{name:'chest',at:[400,300]}],constraints:[{type:'physics',name:'c0',bone:'chest',rotate:1,strength:100,damping:0.85}],motion:{duration:4,tracks:[]}};
const fakeParts=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const mode=fs.readFileSync(path.join(__dirname,'mode'),'utf8').trim();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const tree=root=>{const out=[];const walk=d=>{for(const n of fs.readdirSync(d).sort()){const p=path.join(d,n);if(fs.statSync(p).isDirectory())walk(p);else out.push(path.relative(root,p).split(path.sep).join('/'));}};walk(root);return out.sort();};
const judge=dir=>{const rig=JSON.parse(fs.readFileSync(path.join(dir,'rig.json'),'utf8'));const d=rig.constraints[0].damping,pass=d>=0.7;
 const json={gate_spine_html_green:true,loop_max_diff:1,seam_mean:null,BREATH_VISIBLE:{status:'PASS'},CHAIN_LAG:{status:pass?'PASS':'FAIL'},TEXTURE_STRETCH:{status:'SKIP'},CLOTH_SETTLES:{status:pass?'CLEAR':'WARN'},RECOMPOSITE_HOLES:{status:'REPORTED'},PASS:pass};
 const line=pass?'check: PASS; 3 of 4 bar(s) measured':'check: FAIL — 1 bar(s) not met; 3 of 4 bar(s) measured; 1 warning(s) (CLOTH_SETTLES, not a bar)';
 const status={gate:'PASS',loop:'PASS',seam:'SKIP',BREATH_VISIBLE:'PASS',CHAIN_LAG:json.CHAIN_LAG.status,TEXTURE_STRETCH:'SKIP',CLOTH_SETTLES:json.CLOTH_SETTLES.status,RECOMPOSITE_HOLES:'REPORTED'};
 return {json,line,status,pass};};
const copy=(src,out)=>{for(const r of tree(src)){fs.mkdirSync(path.dirname(path.join(out,r)),{recursive:true});fs.copyFileSync(path.join(src,r),path.join(out,r));}};
if(a[0]==='rig'){const cfg=JSON.parse(fs.readFileSync(path.resolve(f('--config')),'utf8')),out=f('--out');copy(path.join(f('--parts'),'rig'),out);
 const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));delete rig.repaired;rig.constraints=cfg.constraints;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='retune'){const out=f('--out'),input=f('--rig'),cfg=JSON.parse(fs.readFileSync(path.resolve(f('--config')),'utf8'));
 copy(input,out);const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.constraints=cfg.constraints;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 const j=judge(out),ji=judge(input);const side=(x)=>({pass:x.pass,measured:['gate','loop'],not_met:x.pass?[]:['CHAIN_LAG'],skipped:[],physics:null,...(mode==='old'?{}:{line:x.line,status:x.status})});
 const rows=tree(mode==='other'?input:out).map(p=>{const b=fs.readFileSync(path.join(mode==='other'?input:out,p));return {path:p,bytes:b.length,sha256:sha(b)};});
 console.log('  check: input '+(ji.pass?'PASS':'FAIL')+', revision '+(j.pass?'PASS':'FAIL'));
 fs.writeFileSync(path.join(out,'retune.json'),JSON.stringify({spec:'rig-parts-retune/1',request:{idle_keys:'ctl',page_edges:'free',pack_shape:'polygon'},revision:rows,check:{input:side(ji),revision:side(j),scope:'physics'}},null,2)+'\\n');
 if(mode==='altered')fs.appendFileSync(path.join(out,'motion.json'),' ');
 console.log('rig-parts retune: wrote '+(rows.length+1)+' file(s) under '+out+', the provenance in retune.json');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.appendFileSync(path.join(__dirname,'check-runs'),f('--rig')+'\\n');fs.mkdirSync(out,{recursive:true});const j=judge(f('--rig'));
 fs.writeFileSync(path.join(out,'check.json'),JSON.stringify(j.json));console.log('  gate: rig-play green');console.log(j.line);process.exit(j.pass?0:1);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],n:fs.readFileSync(f('--rig')).length}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;

async function fixture(mode:string,version:string){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-retune-check-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 // The inspected rig carries a repair the config does not state: the baseline does not reproduce, so damping routes to retune.
 await writeFile(join(rig,'rig.json'),JSON.stringify({bones:config.bones,constraints:config.constraints,repaired:true}));
 await writeFile(join(rig,'motion.json'),'{"animations":{"idle":{}}}');await writeFile(join(rig,'mesh_report.json'),'{"parts":{}}');await writeFile(join(rig,'images','topwear.png'),'png-topwear');
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

/** One retune Apply of damping 0.6 under `mode`: the settled job, how many times check ran, and the scratch root's entries. */
async function applyDamping(mode:string,version='1.49.1'){
 const {root,pkg,state,checkRuns}=await fixture(mode,version);
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  let status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string};baseline:{status:string}};
  for(let i=0;status.baseline?.status==='running'&&i<400;i++){await Bun.sleep(25);status=await (await fetch(base+'/api/rebuild')).json() as typeof status;}
  expect(status.baseline.status).toBe('not-reproduced');
  const patch:ConfigPatch={schema:CONFIG_PATCH_SCHEMA,config_sha256:status.inputs.configHash,ops:[{op:'replace',path:'/constraints/0/damping',value:0.6,name:'c0'}],producer:{name:'@rig-c/parts',version},op:{cmd:'rig',args:[]}};
  const job=await settle(base,await post(base,{patch}));
  let runs=0;try{runs=(await readFile(checkRuns,'utf8')).trim().split('\n').filter(Boolean).length;}catch{/* check never ran */}
  let scratch:string[]=[];try{const top=join(state,'rebuild');for(const d of await readdir(top))scratch.push(...(await readdir(join(top,d))));}catch{/* nothing kept */}
  return {job,runs,scratch};
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
}

test('#139 bar 1: a retune Apply records retune\'s carried check, equal field by field to what check reports on the same revision, and check does not run again',async()=>{
 const carried=await applyDamping('carry'),ran=await applyDamping('old');
 expect(carried.job).toMatchObject({status:'built',op:'retune'});expect(ran.job).toMatchObject({status:'built',op:'retune'});
 // The same revision bytes either way: the build is the same model.
 expect(carried.job.build!.modelHash).toBe(ran.job.build!.modelHash);
 expect(carried.runs).toBe(0);expect(ran.runs).toBe(1);
 const {source,...fields}=carried.job.check!;
 expect(source).toBe('retune');expect(Object.hasOwn(ran.job.check!,'source')).toBe(false);
 // Field by field, bars in check.json's order included.
 expect(fields).toEqual(ran.job.check!);
 expect(JSON.stringify(fields)).toBe(JSON.stringify(ran.job.check));
 expect(fields).toEqual({schema:'rig-review-check-summary/1',pass:false,exitCode:1,line:'check: FAIL — 1 bar(s) not met; 3 of 4 bar(s) measured; 1 warning(s) (CLOTH_SETTLES, not a bar)',bars:{BREATH_VISIBLE:'PASS',CHAIN_LAG:'FAIL',TEXTURE_STRETCH:'SKIP',CLOTH_SETTLES:'WARN',RECOMPOSITE_HOLES:'REPORTED'},gate:true});
 expect(carried.job.wallMs.check).toBeNull();
 expect(carried.job.lines).toContain('review: check not run again — retune.json carries retune\'s check of this revision, bound to it by 4 revision hash row(s): check: FAIL — 1 bar(s) not met; 3 of 4 bar(s) measured; 1 warning(s) (CLOTH_SETTLES, not a bar)');
 expect(carried.job.lines.some(l=>l.includes(' check --rig '))).toBe(false);
 // context.applied carries it and parses; the status line says where it came from.
 const record=patchAppliedRecord({...carried.job,build:{...carried.job.build!}});
 expect(record.check?.source).toBe('retune');expect(()=>parseAppliedContext(record)).not.toThrow();
 expect(()=>parseAppliedContext({...record,check:{...record.check!,source:'cache'}})).toThrow('feedback.context.applied.check.source');
 expect(patchOutcomeLine(carried.job).text).toContain('check FAIL (retune\'s own check of this revision, not run again)');
 expect(patchOutcomeLine(carried.job).text).not.toContain('+ check');
});

test('#139 version gate: a retune.json without line and status (before 1.49.0) is not refused — check runs, and the job says why',async()=>{
 expect(RETUNE_CHECK_SINCE).toBe('1.49.0');
 const {job,runs}=await applyDamping('old','1.48.0');
 expect(job).toMatchObject({status:'built',op:'retune'});expect(runs).toBe(1);
 expect(job.lines).toContain('review: retune.json carries no check line or block statuses (@rig-c/parts before 1.49.0), so check runs on the revision');
 expect(job.lines.some(l=>l.includes(' check --rig rig --out check'))).toBe(true);
 expect(carriedCheck({check:{revision:{pass:true}}})).toBeNull();
 expect(()=>carriedCheck({check:{revision:{pass:true,line:'check: PASS; x'}}})).toThrow('check.revision.status');
});

test('#139 bar 3: a retune.json from another revision, or a revision file altered after retune, is refused RETUNE_CHECK_STALE and records no build',async()=>{
 for(const mode of ['other','altered']){
  const {job,runs,scratch}=await applyDamping(mode);
  expect(job.status).toBe('refused');expect(job.build).toBeNull();expect(runs).toBe(0);expect(scratch).toEqual([]);
  expect(job.producerLine).toMatch(mode==='other'
   ?/^RETUNE_CHECK_STALE: rig\.json sha256 [0-9a-f]{64} in retune\.json … [0-9a-f]{64} on disk; retune's check is not this revision's, so no build is recorded$/
   :/^RETUNE_CHECK_STALE: motion\.json sha256 [0-9a-f]{64} in retune\.json … [0-9a-f]{64} on disk; retune's check is not this revision's, so no build is recorded$/);
  expect(job.lines.at(-1)).toBe(`review: ${job.producerLine}`);
 }
});

test('#139: the carried side maps by the one rule — upper-case blocks are bars, gate from status.gate, exit from pass',()=>{
 const s=retuneCheckSummary({pass:true,line:'check: PASS; 2 of 2 bar(s) measured',status:{gate:'FAIL',loop:'SKIP',seam:'PASS',BLINK_NO_HOLE:'PASS'}});
 expect(s).toEqual({schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS; 2 of 2 bar(s) measured',bars:{BLINK_NO_HOLE:'PASS'},gate:false,source:'retune'});
});
