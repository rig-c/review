import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {MAX_KEPT_BUILDS} from '../src/rebuild.ts';
import {historyRow,undoControl,type AppliedHistoryView} from '../web/rebuild-client.ts';

/**
 * #166: undo across Applies, N deep. Stand-in producers as in tests/runner-tail.test.ts: `rig-parts rig` copies the
 * handoff rig and writes the config's constraints into rig.json (FAKE_PERTURB adds a byte, so a re-run is not the
 * recorded build); `rigc build` writes a model carrying the rig's hash. Every producer call is logged (FAKE_LOG).
 */
const constraints=[{type:'physics',name:'c0',bone:'chest',rotate:1,strength:100,damping:0.85},{type:'physics',name:'c1',bone:'chest',rotate:1,strength:100,damping:0.9}];
const config={key:'k',constraints};
const inspected={'rig.json':JSON.stringify({bones:[{name:'chest'}],constraints}),'motion.json':JSON.stringify({tracks:[]}),'sets.json':JSON.stringify({sets:[{name:'base'}]}),'mesh_report.json':JSON.stringify({parts:{}})};
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,a.join(' ')+'\\n');
const copy=(src,out)=>{fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));for(const n of fs.readdirSync(path.join(src,'images')))fs.copyFileSync(path.join(src,'images',n),path.join(out,'images',n));};
if(a[0]==='rig'){const cfg=JSON.parse(fs.readFileSync(path.resolve(f('--config')),'utf8')),out=f('--out');
 copy(path.join(f('--parts'),'rig'),out);const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.constraints=cfg.constraints;
 fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig)+(process.env.FAKE_PERTURB||''));console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,PASS:true}));console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,'rigc '+a.join(' ')+'\\n');
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=fs.readFileSync(f('--rig'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],rig:crypto.createHash('sha256').update(rig).digest('hex')}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png-'+rig.length);console.log('rigc: wrote');`;

async function install(root:string,version:string){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
}
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-undo-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const [name,text] of Object.entries(inspected))await writeFile(join(rig,name),text);
 await writeFile(join(rig,'images','chest.png'),'png-chest');await writeFile(join(pkg,'motion.json'),'{}');
 await install(root,'1.42.0');
 return {root,pkg,state:join(root,'state'),log:join(root,'calls.log')};
}
/** Every file's path and bytes under a directory, as one md5. */
async function treeMd5(dir:string):Promise<string>{
 const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};
 await walk(dir);return hash.digest('hex');
}
const list=async(dir:string)=>{try{return (await readdir(dir)).sort();}catch{return [];}};
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type Job={id:string;status:string;producerLine:string|null;build:{modelUrl:string;modelHash:string;files:Record<string,string>}|null};
interface Session {base:string;hash:string;post:(path:string,body:unknown)=>Promise<Response>;settle:(job:Job)=>Promise<Job>;history:()=>Promise<AppliedHistoryView>;apply:(damping:number)=>Promise<Job>;undo:(from:string)=>Promise<Record<string,unknown>>;served:(url:string)=>Promise<string>}
async function session(base:string):Promise<Session>{
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const settle=async(job:Job)=>{let current=job;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json() as Job;}return current;};
 const hash=(await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string}}).inputs.configHash;
 const patch=(damping:number,version='1.42.0'):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:hash,ops:[{op:'replace',path:'/constraints/0/damping',value:damping,name:'c0'}],producer:{name:'@rig-c/parts',version},op:{cmd:'rig',args:[]}});
 return {base,hash,post,settle,
  history:async()=>await (await fetch(base+'/api/rebuild/history')).json() as AppliedHistoryView,
  apply:async damping=>settle(await (await post('/api/rebuild',{patch:patch(damping)})).json() as Job),
  undo:async from=>await (await post('/api/rebuild/undo',{from})).json() as Record<string,unknown>,
  served:async url=>sha(new Uint8Array(await (await fetch(base+url)).arrayBuffer()))};
}
const calls=async(log:string)=>(await readFile(log,'utf8').catch(()=>'')).trim().split('\n').filter(l=>l.startsWith('rig ')).length;

test('#166 bar 1 and 3: three Applies, three undos — each undo is the build recorded at that depth, then the inspected build; nothing re-runs; the package is unchanged',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeMd5(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),s=await session(`http://127.0.0.1:${server.port}`);
 const scratch=join(state,'rebuild',p.sourceHash),kept=join(state,'rebuild-kept',p.sourceHash);
 try{
  const inspectedHash=sha(await readFile(join(pkg,'rig/out/rig/rig.json')));
  const jobs:Job[]=[];
  for(const damping of [0.8,0.7,0.6]){const job=await s.apply(damping);expect(job.status).toBe('built');jobs.push(job);}
  const hashes=jobs.map(j=>j.build!.modelHash);expect(new Set(hashes).size).toBe(3);
  // The scratch root still holds only the build on the stage; the two earlier records' builds wait beside it.
  expect(await list(scratch)).toEqual([jobs[2]!.id]);expect(await list(kept)).toEqual([jobs[0]!.id,jobs[1]!.id].sort());
  const h=await s.history();expect(h.depth).toBe(3);expect(h.records.map(r=>r.modelHash)).toEqual(hashes);expect(h.records.every(r=>r.kept)).toBe(true);
  expect(historyRow(h,2)).toContain('on the stage');expect(undoControl(h,jobs[2]!.id,false)).toMatchObject({label:'Undo last Apply (3 deep)',enabled:true});
  expect(undoControl(h,null,false).enabled).toBe(false);
  const runs=await calls(log);
  // A stale page (the stage is not the last Apply) is refused by name.
  expect(await s.undo(jobs[0]!.id)).toMatchObject({status:'refused',error:expect.stringMatching(/^UNDO_STALE: /)});
  // Undo 1 and 2: the kept predecessor, byte for byte (the served model hashes to the recorded one), nothing re-run.
  for(const depth of [2,1]){
   const top=jobs[depth]!,pred=jobs[depth-1]!;
   const back=await s.undo(top.id) as {status:string;undone:string;job:Job;history:AppliedHistoryView};
   expect(back.status).toBe('built');expect(back.undone).toBe(top.id);expect(back.job.id).toBe(pred.id);
   expect(back.job.build!.modelHash).toBe(hashes[depth-1]);expect(await s.served(back.job.build!.modelUrl)).toBe(hashes[depth-1]);
   expect(back.history.depth).toBe(depth);expect(await list(scratch)).toEqual([pred.id]);expect(await list(kept)).toEqual(jobs.slice(0,depth-1).map(j=>j.id).sort());
   expect((await fetch(s.base+top.build!.modelUrl)).status).toBe(404);
  }
  // Undo 3: the inspected build; the scratch state holds no applied record.
  const last=await s.undo(jobs[0]!.id) as {status:string;history:AppliedHistoryView};
  expect(last).toMatchObject({status:'inspected',undone:jobs[0]!.id});expect(last.history).toEqual({schema:'rig-review-applied-history/1',depth:0,records:[]});
  expect(await list(scratch)).toEqual([]);expect(await list(kept)).toEqual([]);
  expect(sha(await readFile(join(pkg,'rig/out/rig/rig.json')))).toBe(inspectedHash);
  expect(await s.undo(jobs[0]!.id)).toMatchObject({status:'refused',error:expect.stringMatching(/^UNDO_NOTHING_APPLIED: /)});
  expect(await calls(log)).toBe(runs);
  // Malformed bodies are a 400; a cross-origin undo is refused.
  expect((await s.post('/api/rebuild/undo',{from:'x'})).status).toBe(400);
  expect((await fetch(s.base+'/api/rebuild/undo',{method:'POST',headers:{Origin:'http://elsewhere','Content-Type':'application/json'},body:'{"from":"'+'a'.repeat(64)+'"}'})).status).toBe(403);
  expect(await treeMd5(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#166 bar 2: an evicted predecessor re-runs its recorded step and must come back byte for byte; otherwise UNDO_PREDECESSOR_CHANGED, the stage left on the last Apply',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeMd5(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),s=await session(`http://127.0.0.1:${server.port}`);
 const kept=join(state,'rebuild-kept',p.sourceHash);
 const evict=async(id:string)=>{await rm(join(kept,id),{recursive:true,force:true});};
 try{
  const a=await s.apply(0.8),b=await s.apply(0.7),c=await s.apply(0.6);
  // Unchanged inputs: the evicted predecessor re-runs and lands with its recorded model hash.
  await evict(b.id);expect((await s.history()).records[1]!.kept).toBe(false);
  const runs=await calls(log);
  const rerun=await s.undo(c.id) as {status:string;job:Job};expect(rerun.status).toBe('running');
  const rebuilt=await s.settle(rerun.job);expect(rebuilt.status).toBe('built');expect(rebuilt.id).toBe(b.id);expect(rebuilt.build!.modelHash).toBe(b.build!.modelHash);
  expect(await calls(log)).toBe(runs+1);expect((await s.history()).records.map(r=>r.id)).toEqual([a.id,b.id]);
  // The producer re-run writes other bytes: refused after the run, by the first differing file; the stage stays on b.
  await s.apply(0.6);await evict(b.id);process.env.FAKE_PERTURB=' ';
  const perturbed=await s.settle(((await s.undo(c.id)) as {job:Job}).job);delete process.env.FAKE_PERTURB;
  expect(perturbed.status).toBe('refused');expect(perturbed.producerLine).toMatch(/^UNDO_PREDECESSOR_CHANGED: skeleton\.model\.json — the record's build has sha256 [a-f0-9]{12}…, the re-run wrote [a-f0-9]{12}…/);
  expect((await s.history()).records.map(r=>r.id)).toEqual([a.id,b.id,c.id]);expect(await list(join(state,'rebuild',p.sourceHash))).toEqual([c.id]);
  // The producer version is not the record's: refused before anything runs.
  await install(root,'1.42.1');const runs2=await calls(log);
  const version=await s.undo(c.id);expect(version).toEqual({status:'refused',error:'UNDO_PREDECESSOR_CHANGED: @rig-c/parts 1.42.0 → @rig-c/parts 1.42.1; the evicted build was made with the version its record names',producerLine:null});
  expect(await calls(log)).toBe(runs2);await install(root,'1.42.0');
  // The handoff config is not the bytes the record was built from: refused by its path, before anything runs.
  const text=await readFile(join(pkg,'rig/config.json'),'utf8');await writeFile(join(pkg,'rig/config.json'),text+' ');
  const handoff=await s.undo(c.id) as {error:string};expect(handoff.error).toMatch(/^UNDO_PREDECESSOR_CHANGED: rig\/config\.json sha256 [a-f0-9]{12}… → [a-f0-9]{12}…; the evicted build was made from the config as it was$/);
  await writeFile(join(pkg,'rig/config.json'),text);
  expect((await s.history()).depth).toBe(3);expect(await calls(log)).toBe(runs2);
  expect(await treeMd5(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;delete process.env.FAKE_PERTURB;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test(`#166: at most ${MAX_KEPT_BUILDS} builds stay on disk; the oldest record's build is evicted and its record kept`,async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),s=await session(`http://127.0.0.1:${server.port}`);
 try{
  const dampings=Array.from({length:MAX_KEPT_BUILDS+2},(_,i)=>Number((0.5+i/100).toFixed(2))),jobs:Job[]=[];for(const d of dampings)jobs.push(await s.apply(d));
  const h=await s.history();expect(h.depth).toBe(MAX_KEPT_BUILDS+2);
  expect(h.records.map(r=>r.kept)).toEqual([false,false,...Array(MAX_KEPT_BUILDS).fill(true)]);
  expect((await list(join(state,'rebuild-kept',p.sourceHash))).length).toBe(MAX_KEPT_BUILDS-1);
  // Applying an earlier record's request again brings its kept build back (reused) and stacks it once more.
  const again=await s.apply(dampings[MAX_KEPT_BUILDS]!);expect(again.id).toBe(jobs[MAX_KEPT_BUILDS]!.id);expect((again as unknown as {reused:boolean}).reused).toBe(true);
  expect((await s.history()).depth).toBe(MAX_KEPT_BUILDS+3);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});
