import {test,expect} from 'bun:test';
import {mkdir,mkdtemp,writeFile,readFile,rm,symlink,realpath,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadReview} from '../src/manifest.ts';
import {assertReviewUnchanged} from '../src/reference.ts';
import {createRebuilds,MAX_KEPT_BUILDS,rebuildDir,keptRoot} from '../src/rebuild.ts';
import {startServer} from '../src/server.ts';
import {freshSession} from '../src/session.ts';
import {appliedRecord,type RebuildJobView} from '../web/rebuild-client.ts';

const region={name:'right',shape:'circle',cx:20,cy:20,r:8,bone:'chest',spacing:4,band:2};
/** Small deterministic executables exercise the actual rebuild tail and session HTTP boundary. */
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'stage1-evidence-'))),pkg=join(root,'pkg'),state=join(root,'state');
 await mkdir(join(pkg,'out/rig'),{recursive:true});await mkdir(join(pkg,'out/parts'),{recursive:true});
 await writeFile(join(pkg,'config.json'),JSON.stringify({key:'evidence',meshes:{torso:{contour:{regions:[region]}}}}));
 await writeFile(join(pkg,'out/parts.json'),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');
 for(const name of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(pkg,'out/rig',name),'{}');
 for(const [name,version,bin,script] of [
  ['@rig-c/parts','1.42.0','rig-parts',`const fs=require('fs'),path=require('path'),a=process.argv.slice(2),f=n=>a[a.indexOf(n)+1],out=f('--out');
if(a[0]==='check'){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:true}));console.log('check: PASS');process.exit(0);}
if(a[0]!=='remesh')process.exit(3);fs.mkdirSync(out,{recursive:true});const mesh=JSON.parse(fs.readFileSync(f('--mesh'),'utf8'));
fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify({mesh}));fs.writeFileSync(path.join(out,'motion.json'),'{}');fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({request:{part:f('--part'),page_edges:'free',pack_shape:'polygon'}}));console.log('remesh: wrote revision');`],
  ['rig-c','2.64.1','rigc',`const fs=require('fs'),path=require('path'),a=process.argv.slice(2),f=n=>a[a.indexOf(n)+1],out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],revision:fs.readFileSync(f('--rig'),'utf8')}));fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`],
 ] as const){const dir=join(root,'node_modules',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({name,version,bin:{[bin]:'./cli.cjs'}}));await writeFile(join(dir,'cli.cjs'),script);}
 const p=await loadReview(pkg);
 return {root,p,state,options:{stateDir:state,starts:[p.root,root],unchanged:()=>assertReviewUnchanged(p),bones:p.feedbackCatalog.bones}};
}
async function settle(rebuilds:ReturnType<typeof createRebuilds>,input:unknown){
 const result=await rebuilds.start(input);let job=result.body as RebuildJobView;
 for(let i=0;job.status==='running'&&i<200;i++){await Bun.sleep(20);job=rebuilds.read(job.id) as RebuildJobView;}
 return job;
}

test('an explicitly symlinked state root builds; a revision symlink escaping the real root still refuses',async()=>{
 const f=await fixture();const alias=join(f.root,'state-link');await mkdir(f.state);await symlink(f.state,alias,'dir');
 const rebuilds=createRebuilds(f.p,{...f.options,stateDir:alias});
 try{
  const status=await rebuilds.describe();const job=await settle(rebuilds,{part:'torso',regions:[region],configHash:status.inputs!.configHash});
  expect({status:job.status,line:job.producerLine}).toMatchObject({status:'built'});
  expect((await rebuilds.stageDraft(job.id)).id).toBe(job.id);
  const revision=join(rebuildDir(alias,f.p.sourceHash,job.id),'revision/rig.json'),input=await readFile(revision),record=appliedRecord(job);
  await writeFile(revision,Buffer.concat([input,Buffer.from(' ')]));
  await expect(rebuilds.stageDraft(job.id)).rejects.toThrow('STAGE_DRAFT_CHANGED');
  await rebuilds.validateApplied(record); // Historical evidence does not assert the changed file is current.
  await writeFile(revision,input);
  const compiled=join(rebuildDir(alias,f.p.sourceHash,job.id),'build/skeleton.model.json'),model=await readFile(compiled);
  await writeFile(compiled,Buffer.concat([model,Buffer.from(' ')]));
  await expect(rebuilds.stageDraft(job.id)).rejects.toThrow('STAGE_DRAFT_CHANGED');
  await writeFile(compiled,model);expect((await rebuilds.stageDraft(job.id)).id).toBe(job.id);
  const outside=join(f.root,'outside.txt');await writeFile(outside,'not a revision input');
  await symlink(outside,join(rebuildDir(alias,f.p.sourceHash,job.id),'revision','escape'));
  await expect(rebuilds.stageDraft(job.id)).rejects.toThrow('BUILD_INPUT_OUTSIDE_ROOT');
  await rm(join(rebuildDir(alias,f.p.sourceHash,job.id),'revision','escape'));
  expect((await rebuilds.undo({from:job.id})).body).toMatchObject({status:'inspected'});
  await rebuilds.validateApplied(record);
  await expect(rebuilds.stageDraft(job.id)).rejects.toThrow('STAGE_DRAFT_STALE');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('historical exact made claims survive nine Applies, first submit after eviction, Undo and restart; new forged or unsealed claims refuse',async()=>{
 const f=await fixture();let server:Awaited<ReturnType<typeof startServer>>|undefined;
 try{
  server=await startServer(f.p,{port:0,stateDir:f.state,cwd:f.root});let base=`http://127.0.0.1:${server.port}`;
  const request=async(path:string,body:unknown,method='POST')=>fetch(base+path,{method,headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const status=await (await fetch(base+'/api/rebuild')).json() as any;const jobs:RebuildJobView[]=[];
  for(let n=0;n<=MAX_KEPT_BUILDS;n++){
   let job=await (await request('/api/rebuild',{part:'torso',regions:[{...region,cx:20+n}],configHash:status.inputs.configHash})).json() as RebuildJobView;
   for(let i=0;job.status==='running'&&i<200;i++){await Bun.sleep(20);job=await (await fetch(base+'/api/rebuild/'+job.id)).json() as RebuildJobView;}
   expect(job.status).toBe('built');expect(job.check?.pass).toBe(true);jobs.push(job);
  }
  const first=jobs[0]!,last=jobs.at(-1)!;
  expect(await access(rebuildDir(f.state,f.p.sourceHash,first.id)).then(()=>true,()=>false)).toBe(false);
  expect(await access(join(keptRoot(f.state,f.p.sourceHash),first.id)).then(()=>true,()=>false)).toBe(false);
  const session=freshSession(f.p),row=(job:RebuildJobView,id:string)=>({id,frameStart:0,frameEnd:0,target:{kind:'rig' as const,name:f.p.feedbackCatalog.rig},category:'quality' as const,summary:'Historical correction',context:{applied:appliedRecord(job)}});
  session.feedback=[row(first,'first') as any];
  let response=await request('/api/session',session,'PUT');expect({status:response.status,text:await response.text()}).toMatchObject({status:200});
  // The last correction has only a local row when Undo removes its live directory.
  session.feedback.push(row(last,'undone') as any);expect((await (await request('/api/rebuild/undo',{from:last.id})).json() as any).status).toBe('built');
  response=await request('/api/session',session,'PUT');expect(response.status).toBe(200);
  server.stop(true);server=await startServer(f.p,{port:0,stateDir:f.state,cwd:f.root});base=`http://127.0.0.1:${server.port}`;
  response=await request('/api/session',session,'PUT');expect(response.status).toBe(200);
  const forged=structuredClone(session);(forged.feedback[0]!.context as any).applied.regions[0].cx++;
  response=await request('/api/session',forged,'PUT');expect(response.ok).toBe(false);expect(await response.text()).toContain('STAGE_DRAFT_STALE');
  const sealPath=join(f.state,'applied-evidence',f.p.sourceHash,first.id+'.json'),seal=await readFile(sealPath);await rm(sealPath);
  response=await request('/api/session',session,'PUT');expect(response.ok).toBe(false);expect(await response.text()).toContain('STAGE_DRAFT_STALE');
  // Even a forged result.json in a reconstructed cache directory is not authority.
  const dir=rebuildDir(f.state,f.p.sourceHash,first.id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'result.json'),JSON.stringify(first));
  response=await request('/api/session',session,'PUT');expect(response.ok).toBe(false);
  await writeFile(sealPath,seal);const damaged=JSON.parse(seal.toString());damaged.digest='0'.repeat(64);await writeFile(sealPath,JSON.stringify(damaged));
  response=await request('/api/session',session,'PUT');expect(response.ok).toBe(false);expect(await response.text()).toContain('STAGE_DRAFT_STALE');
  await writeFile(sealPath,seal);response=await request('/api/session',session,'PUT');expect(response.status).toBe(200);
  const other=structuredClone(session);(other.feedback[0]!.context as any).applied.buildId='f'.repeat(64);
  response=await request('/api/session',other,'PUT');expect(response.ok).toBe(false);expect(await response.text()).toContain('STAGE_DRAFT_STALE');
  expect(createHash('sha256').update(await readFile(sealPath)).digest('hex')).toBe(createHash('sha256').update(seal).digest('hex'));
 }finally{server?.stop(true);await rm(f.root,{recursive:true,force:true});}
});
