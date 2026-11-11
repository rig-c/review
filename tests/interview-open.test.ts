import {expect,test} from 'bun:test';
import {mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseOpenInputs,parseOpenTargets,main} from '../src/cli.ts';
import {joinProject} from '../src/joined-project.ts';
import {digest} from '../src/interview-project.ts';
import {loadOpenPackage,openKey,prepareOpenTarget} from '../src/open.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {startOpenWorkspace} from '../src/open-workspace.ts';
import {targetCapability} from '../src/open-workspace-state.ts';
import {WORKSPACE_SCHEMA} from '../src/open-workspace-contract.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';

test('#725 parser admits only the approved interview-root form without weakening explicit selectors',()=>{
 const args=['project','--project','project','--picks-dir','picks'];
 expect(parseOpenInputs([...args])).toEqual({input:'project',project:{root:'project',picksDir:'picks'}});
 expect(parseOpenTargets(args)).toEqual([parseOpenInputs([...args])]);
 for(const rest of [['--project','project'],['--picks-dir','picks'],
  ['--project','project','--project-version','1'],
  [...args.slice(1),'--project-version','0'],[...args.slice(1),'--project-version','1','--project-draft','a'],
  [...args.slice(1),'--post-version','1'],[...args.slice(1),'--parts-verdict-dir','verdicts']]){
  expect(()=>parseOpenInputs(['project',...rest])).toThrow('OPEN_OPTION_INVALID');
 }
 for(const rest of [['--view-only'],['--direct'],['--control'],['--animation','idle'],['--reference','r.mov'],['--config','config.json'],['--compare','other']]){
  expect(()=>parseOpenInputs([...args,...rest])).toThrow('OPEN_OPTION_INVALID');
 }
 expect(()=>parseOpenTargets([...args,'other'])).toThrow('OPEN_OPTION_INVALID --project');
 expect(()=>parseOpenInputs([...args],{interview:false})).toThrow('OPEN_OPTION_INVALID --project');
});

test('#725 root-only join binds real input hashes without a manifest, model or package session',async()=>{
 const f=await interviewOpenFixture();
 try{
  const before=await jobInputHashes(f.root),dirs=await readdir(f.root);
  const opened=await loadOpenPackage(f.inputs);
  expect(opened.mode).toBe('interview');if(opened.mode!=='interview')throw new Error('Expected interview');
  expect(opened.p).toBeNull();expect(opened.selection).toBeNull();expect(opened.joined.opened.project.drafts).toBeNull();
  expect(opened.joined.opened.project.versions).toEqual(f.project.versions);
  expect(opened.joined.opened.questions).toHaveLength(1);expect(opened.joined.opened.questions[0]!.editable).toBe(true);
  expect(opened.joined.opened.questions[0]!.hasParts).toBe(false);
  expect(opened.joined).not.toHaveProperty('review');expect(opened.joined).not.toHaveProperty('draft');
  expect(openKey(await loadOpenPackage(opened.inputs),'tool')).toBe(openKey(opened,'tool'));
  await mkdir(join(f.root,'other-picks'));expect(openKey(await loadOpenPackage({...f.inputs,project:{root:f.root,picksDir:'other-picks'}}),'tool')).not.toBe(openKey(opened,'tool'));
  await rm(join(f.root,'other-picks'),{recursive:true});expect(await jobInputHashes(f.root)).toEqual(before);expect(await readdir(f.root)).toEqual(dirs);
  const raw=await readFile(join(f.root,'project.json'));
  await writeFile(join(f.root,'project.json'),JSON.stringify({...f.project,versions:[]}));await loadOpenPackage(f.inputs);
  const {drafts:_absent,...withoutDrafts}=f.project;
  await writeFile(join(f.root,'project.json'),JSON.stringify({...withoutDrafts,versions:[{n:1,kind:'rig'}]}));
  const noDraft=await loadOpenPackage(f.inputs);expect(noDraft.mode).toBe('interview');
  if(noDraft.mode==='interview')expect(noDraft.joined.opened.project).not.toHaveProperty('drafts');
  await writeFile(join(f.root,'project.json'),raw);
  await mkdir(join(f.root,'derived'));await loadOpenPackage(f.inputs);
  await expect(loadOpenPackage({...f.inputs,input:join(f.root,'derived')})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
  await expect(prepareOpenTarget(f.inputs,{stateDir:join(f.root,'state')},'a'.repeat(64))).rejects.toThrow('OPEN_STATE_INSIDE_PACKAGE');
 }finally{await f.close();}
});

test('#725 stage, artifacts, source, output and explicit package selectors remain strict refusals',async()=>{
 const f=await interviewOpenFixture();
 try{
  const path=join(f.root,'project.json'),raw=await readFile(path);
  for(const patch of [{stage:'parts'},{stage:'rigging-interview'},{drafts:[{id:'a'}]},{versions:[{n:1,kind:'rig',review_package:{files:[]}}]},{versions:[{n:1,kind:'demo',review_package:{files:[]}}]},{versions:null},{drafts:{}},
   {interview:{...f.project.interview,framing:[]}}]){
   await writeFile(path,JSON.stringify({...f.project,...patch}));
   await expect(loadOpenPackage(f.inputs)).rejects.toThrow(/INTERVIEW_SOURCE_MISMATCH|INTERVIEW_UNAVAILABLE/);
  }
  await writeFile(path,raw);
  for(const explicit of [{version:1},{draftId:'missing'}])await expect(loadOpenPackage({...f.inputs,project:{root:f.root,picksDir:'picks',...explicit}})).rejects.toThrow();
  for(const picksDir of ['missing','evidence','../outside','picks/../picks','source.svg'])expect(()=>joinProject(null,{root:f.root,picksDir})).toThrow('INTERVIEW_PICKS_OUTPUT');
  // Unrelated derived evidence is neither a draft nor a recorded review package.
  await mkdir(join(f.root,'derived'));await writeFile(join(f.root,'derived','evidence.json'),'{}');
  expect(joinProject(null,f.inputs.project).interviewOnly).toBe(true);await rm(join(f.root,'derived'),{recursive:true});
  const opened=joinProject(null,f.inputs.project),source=join(f.root,'source.svg'),art=await readFile(source);
  await writeFile(source,'changed');await expect(opened.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');await writeFile(source,art);
  await writeFile(path,Buffer.concat([raw,Buffer.from('\n')]));await expect(opened.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');await writeFile(path,raw);
  const set=join(f.root,'evidence/options.json'),options=await readFile(set);await writeFile(set,'{}');await expect(opened.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');await writeFile(set,options);
  await opened.assertCurrent();expect(digest(await readFile(source))).toBe(f.project.inputs[0].sha256);
 }finally{await f.close();}
});

test('#725 existing server context exposes the interview and refuses model APIs without writing sources',async()=>{
 const f=await interviewOpenFixture(),capability='a'.repeat(64),origin='http://127.0.0.1:4321';
 const opened=joinProject(null,f.inputs.project);
 const context=await createReviewRequestContext(null,{joined:opened,capability,stateDir:f.stateDir,bundle:new Blob(['// synthetic unit bundle'])});
 const get=(path:string)=>context.handle(new Request(origin+path),4321,{} as never);
 try{
  const before=await jobInputHashes(f.root),dirs=await readdir(f.root);
  const metadata=await (await get('/api/review'))!.json();expect(metadata.subject).toBe('interview');
  expect(metadata.project).toEqual({path:'project.json',sha256:digest(await readFile(join(f.root,'project.json')))});
  for(const key of ['manifest','model','session','reviewedSource'])expect(metadata).not.toHaveProperty(key);
  expect(metadata.capabilities).toEqual({interview:true,playback:false,modeling:false,motion:false,feedback:false,audio:false});
  const interview=await (await get('/api/interview'))!.json();expect(interview).not.toHaveProperty('binding');expect(interview.questions).toHaveLength(1);
  const image=await get(interview.questions[0].images[0].url);expect(image!.status).toBe(200);expect(image!.headers.get('Content-Security-Policy')).toContain('sandbox');
  for(const path of ['/api/session','/api/stage-parts','/api/rebuild','/api/requirements','/api/readings']){
   const result=await get(path);expect(result!.status).toBe(409);expect(await result!.json()).toEqual({error:'MODEL_UNAVAILABLE'});
  }
  for(const path of ['/stage-interview.html','/interview.js','/interview.css','/assets/project.json'])expect((await get(path))!.status).toBe(404);
  expect((await get('/'))!.status).toBe(200);expect((await get('/main.js'))!.status).toBe(200);
  expect(await jobInputHashes(f.root)).toEqual(before);expect(await readdir(f.root)).toEqual(dirs);
  const payload={schema:'rig-review/interview-picks@1',set:f.project.interview.framing[0].pending_options,picks:[{ask:'reference',option_id:'keep'}],note:'Verbatim note',by:'user',at:new Date().toISOString()};
  const post=(key:string,requestOrigin:string,body:unknown=payload)=>context.handle(new Request(origin+'/api/interview/picks',{method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json','X-Review-Capability':key},body:JSON.stringify(body)}),4321,{} as never);
  expect((await post('',origin))!.status).toBe(403);expect((await post(capability,'https://foreign.test'))!.status).toBe(403);
  expect((await post(capability,origin,{...payload,note:'x'.repeat(256*1024)}))!.status).toBe(400);
  expect((await post(capability,origin))!.status).toBe(200);
  expect(JSON.parse(await readFile(join(f.root,'picks',payload.set.sha256+'.json'),'utf8'))).toEqual(payload);
  const saved=await readFile(join(f.root,'picks',payload.set.sha256+'.json'));
  await writeFile(join(f.root,'project.json'),JSON.stringify({...f.project,name:'Changed'}));
  expect((await get('/api/review'))!.status).toBe(409);expect((await post(capability,origin))!.status).toBe(409);
  expect(await readFile(join(f.root,'picks',payload.set.sha256+'.json'))).toEqual(saved);
 }finally{context.stop();await f.close();}
});

test('#725 managed workspace registers and reuses interview-only targets through the existing single entry',async()=>{
 const f=await interviewOpenFixture(),fingerprint='b'.repeat(64);
 const prepared=await prepareOpenTarget(f.inputs,{stateDir:f.stateDir},fingerprint);
 let host=await startOpenWorkspace({stateDir:f.stateDir,fingerprint,port:0});
 try{
  const before=await jobInputHashes(f.root),dirs=await readdir(f.root);
  const designation={key:prepared.key,contentHash:prepared.package.contentHash,cwd:prepared.cwd,viewOnly:false,inputs:{...prepared.package.inputs,viewOnly:false}};
  const register=()=>fetch(host.record.origin+'/workspace/api/register',{method:'POST',headers:{Authorization:'Bearer '+host.record.registrationCapability,'Content-Type':'application/json'},body:JSON.stringify({schema:WORKSPACE_SCHEMA,incarnation:host.record.incarnation,targets:[designation]})});
  expect((await register()).status).toBe(200);expect((await register()).status).toBe(200);
  const list=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json();
  expect(list.targets).toHaveLength(1);expect(list.targets[0].mode).toBe('single');expect(list.targets[0].title).toBe('Synthetic interview');
  const entry=await fetch(host.record.origin+list.targets[0].entry);expect(entry.status).toBe(200);expect(await entry.text()).toContain('id="app"');
  const base=host.record.origin+'/instances/'+prepared.key;
  expect((await fetch(base+'/api/interview')).status).toBe(200);
  expect((await fetch(base+'/api/session')).status).toBe(409);
  expect((await fetch(base+'/api/interview/picks',{method:'POST',headers:{Origin:host.record.origin,'Content-Type':'application/json','X-Review-Capability':targetCapability(host.record.ownerCapability,host.record.incarnation,prepared.key)},body:'{}'})).status).toBe(400);
  expect(await jobInputHashes(f.root)).toEqual(before);expect(await readdir(f.root)).toEqual(dirs);
  const first=host.record,port=Number(new URL(first.origin).port);
  await host.stop();host=await startOpenWorkspace({stateDir:f.stateDir,fingerprint,port});
  expect(host.record.incarnation).not.toBe(first.incarnation);expect(host.record.ownerCapability).not.toBe(first.ownerCapability);
  const replay=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json();
  expect(replay.targets).toHaveLength(1);expect(replay.targets[0].key).toBe(prepared.key);expect(replay.targets[0].contentHash).toBe(prepared.package.contentHash);
  expect((await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':first.ownerCapability}})).status).toBe(403);
  expect((await fetch(host.record.origin+'/instances/'+prepared.key+'/api/interview')).status).toBe(200);
  expect((await register()).status).toBe(200);expect(await jobInputHashes(f.root)).toEqual(before);
 }finally{await host.stop();await f.close();}
},10000);

test('#725 feedback and control do not acquire the new interview-only grammar',async()=>{
 const f=await interviewOpenFixture();
 try{for(const verb of ['feedback','control'])await expect(main([verb,f.root,'--project',f.root,'--picks-dir','picks'],{stateDir:f.stateDir})).rejects.toThrow('OPEN_OPTION_INVALID --project');}
 finally{await f.close();}
});
