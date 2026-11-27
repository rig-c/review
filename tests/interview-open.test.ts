import {expect,test} from 'bun:test';
import {mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseOpenInputs,parseOpenTargets,main} from '../src/cli.ts';
import {joinProject} from '../src/joined-project.ts';
import {digest} from '../src/interview-project.ts';
import {loadOpenPackage,openKey,prepareOpenTarget} from '../src/open.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {startOpenWorkspace} from '../src/open-workspace.ts';
import {parseDesignation,targetCapability} from '../src/open-workspace-state.ts';
import {WORKSPACE_SCHEMA} from '../src/open-workspace-contract.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {setSourceAttribute,sourceTextContent,t} from '../web/i18n.ts';

test('#725 parser admits only the approved interview-root form without weakening explicit selectors',()=>{
 const args=['project','--project','project'];
 expect(parseOpenInputs([...args])).toEqual({input:'project',project:{root:'project'}});
 expect(parseOpenTargets(args)).toEqual([parseOpenInputs([...args])]);
 expect(()=>parseOpenInputs([...args,'--picks-dir','picks'])).toThrow('OPEN_OPTION_INVALID --picks-dir: Unknown open option --picks-dir');
 for(const rest of [['--project-version','1'],
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
  expect(await jobInputHashes(f.root)).toEqual(before);expect(await readdir(f.root)).toEqual(dirs);
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

test('#725 stage, artifacts, source and explicit package selectors remain strict refusals',async()=>{
 const f=await interviewOpenFixture();
 try{
  const path=join(f.root,'project.json'),raw=await readFile(path);
  for(const patch of [{stage:'parts'},{stage:'rigging-interview'},{drafts:[{id:'a'}]},{versions:[{n:1,kind:'rig',review_package:{files:[]}}]},{versions:[{n:1,kind:'demo',review_package:{files:[]}}]},{versions:null},{drafts:{}},
   {interview:{...f.project.interview,framing:[]}}]){
   await writeFile(path,JSON.stringify({...f.project,...patch}));
   await expect(loadOpenPackage(f.inputs)).rejects.toThrow(/INTERVIEW_SOURCE_MISMATCH|INTERVIEW_UNAVAILABLE/);
  }
  await writeFile(path,raw);
  for(const explicit of [{version:1},{draftId:'missing'}])await expect(loadOpenPackage({...f.inputs,project:{root:f.root,...explicit}})).rejects.toThrow();
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
  const picksDir=join(f.root,'picks'),picksFile=join(picksDir,payload.set.sha256+'.json');
  const request=(method:string)=>context.handle(new Request(origin+'/api/interview/picks',{method,headers:{Origin:origin,'Content-Type':'application/json','X-Review-Capability':capability},body:JSON.stringify({...payload,note:'Attempted replacement'})}),4321,{} as never);
  expect(await readdir(picksDir)).toEqual([]);
  for(const method of ['POST','PUT','PATCH','DELETE']){
   const refused=await request(method);
   expect(refused?.status).toBe(404);expect(await refused?.json()).toEqual({error:'Not found'});
   expect(await readdir(picksDir)).toEqual([]);
   expect(await jobInputHashes(f.root)).toEqual(before);
  }
  const saved=JSON.stringify(payload)+'\n';await writeFile(picksFile,saved);
  const planted=await jobInputHashes(f.root);
  for(const method of ['POST','PUT','PATCH','DELETE']){
   expect((await request(method))?.status).toBe(404);
   expect(await readdir(picksDir)).toEqual([payload.set.sha256+'.json']);
   expect(await jobInputHashes(f.root)).toEqual(planted);
  }
  expect(await readFile(picksFile,'utf8')).toBe(saved);
  expect((await (await get('/api/interview'))!.json()).questions[0]).not.toHaveProperty('saved');
  await writeFile(join(f.root,'project.json'),JSON.stringify({...f.project,name:'Changed'}));
  expect((await get('/api/review'))!.status).toBe(409);
 }finally{context.stop();await f.close();}
});

test('#725 managed workspace registers and reuses interview-only targets through the existing single entry',async()=>{
 const f=await interviewOpenFixture(),fingerprint='b'.repeat(64);
 const prepared=await prepareOpenTarget(f.inputs,{stateDir:f.stateDir},fingerprint);
 let host=await startOpenWorkspace({stateDir:f.stateDir,fingerprint,port:0});
 try{
  const before=await jobInputHashes(f.root),dirs=await readdir(f.root);
  const designation={key:prepared.key,contentHash:prepared.package.contentHash,cwd:prepared.cwd,viewOnly:false,inputs:{...prepared.package.inputs,viewOnly:false}};
  expect(designation.inputs.project).toEqual({root:f.root});
  const legacy={...designation,inputs:{...designation.inputs,project:{...designation.inputs.project,picksDir:'missing-old-directory'}}};
  expect(parseDesignation(designation)).toEqual(designation);
  expect(parseDesignation(legacy)).toEqual(designation);
  const register=()=>fetch(host.record.origin+'/workspace/api/register',{method:'POST',headers:{Authorization:'Bearer '+host.record.registrationCapability,'Content-Type':'application/json'},body:JSON.stringify({schema:WORKSPACE_SCHEMA,incarnation:host.record.incarnation,targets:[designation]})});
  expect((await register()).status).toBe(200);expect((await register()).status).toBe(200);
  const list=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json();
  expect(list.targets).toHaveLength(1);expect(list.targets[0].mode).toBe('single');expect(list.targets[0].title).toBe('Synthetic interview');
  const entry=await fetch(host.record.origin+list.targets[0].entry);expect(entry.status).toBe(200);expect(await entry.text()).toContain('id="app"');
  const base=host.record.origin+'/instances/'+prepared.key;
  expect((await fetch(base+'/api/interview')).status).toBe(200);
  expect((await fetch(base+'/api/session')).status).toBe(409);
  expect((await fetch(base+'/api/interview/picks',{method:'POST',headers:{Origin:host.record.origin,'Content-Type':'application/json','X-Review-Capability':targetCapability(host.record.ownerCapability,host.record.incarnation,prepared.key)},body:'{}'})).status).toBe(404);
  expect(await jobInputHashes(f.root)).toEqual(before);expect(await readdir(f.root)).toEqual(dirs);
  const first=host.record,port=Number(new URL(first.origin).port);
  await host.stop();
  const registryPath=join(f.stateDir,'owner-workspace','targets.json');
  const registry=JSON.parse(await readFile(registryPath,'utf8'));
  expect(registry.targets[0].designation.inputs.project).toEqual({root:f.root});
  registry.targets[0].designation=legacy;
  await writeFile(registryPath,JSON.stringify(registry));
  host=await startOpenWorkspace({stateDir:f.stateDir,fingerprint,port});
  expect(host.record.incarnation).not.toBe(first.incarnation);expect(host.record.ownerCapability).not.toBe(first.ownerCapability);
  const replay=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json();
  expect(replay.targets).toHaveLength(1);expect(replay.targets[0].key).toBe(prepared.key);expect(replay.targets[0].contentHash).toBe(prepared.package.contentHash);
  expect((await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':first.ownerCapability}})).status).toBe(403);
  expect((await fetch(host.record.origin+'/instances/'+prepared.key+'/api/interview')).status).toBe(200);
  expect((await register()).status).toBe(200);expect(await jobInputHashes(f.root)).toEqual(before);
  expect(JSON.parse(await readFile(registryPath,'utf8')).targets[0].designation.inputs.project).toEqual({root:f.root});
 }finally{await host.stop();await f.close();}
},10000);

test('#725 feedback and control do not acquire the new interview-only grammar',async()=>{
 const f=await interviewOpenFixture();
 try{for(const verb of ['feedback','control'])await expect(main([verb,f.root,'--project',f.root],{stateDir:f.stateDir})).rejects.toThrow('OPEN_OPTION_INVALID --project');}
 finally{await f.close();}
});

test('#1230 interview-only open screen renders a named refusal in EN and KO without mounting an answer form',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function startRecord('),source.indexOf('/** #1041 B: checkpoint, signoff and plan-approval forms'));
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(body);
 const nodes=new Map<string,{id:string;hidden:boolean;disabled:boolean;title:string;textContent:string;dataset:Record<string,string>;attributes:Map<string,string>;children:never[];classList:{error:boolean;contains(n:string):boolean;toggle(n:string,on:boolean):void};setAttribute(k:string,v:string):void;getAttribute(k:string):string|null;removeAttribute(k:string):void}>();
 const el=(id:string)=>{
  let node=nodes.get(id);
  if(!node){
   node={id,hidden:false,disabled:false,title:'',textContent:'',dataset:{},attributes:new Map(),children:[],
    classList:{error:false,contains(n){return n==='error'&&this.error;},toggle(n,on){if(n==='error')this.error=on;}},
    setAttribute(k,v){this.attributes.set(k,v);},getAttribute(k){return this.attributes.get(k)??null;},removeAttribute(k){this.attributes.delete(k);}};
   nodes.set(id,node);
  }
  return node;
 };
 const act={hidden:true,querySelectorAll:()=>[]};
 const document={body:{dataset:{} as Record<string,string>},querySelectorAll:()=>[]};
 const cameraButtons=Array.from({length:4},()=>({disabled:false}));
 const disposers:Function[]=[];
 const scope={
  document,host:null,readOnly:null,actReadOnly:null,access:{capability:'owner'},readOnlyReason:()=>null,
  rigInput:null,referenceInput:null,parts:null,disposed:false,tr:String,t,
  controls:{zoomButtons:cameraButtons.slice(0,3),nativeOne:cameraButtons[3],replaceViewSwitch:()=>()=>{}},
  chooseInspectionView(){},inspectionViewSwitch:()=>({}),
  bindWorkspace(){},bindInspector(){},renderLayout(){},
  el,button:el,text:(id:string,value:string)=>{el(id).textContent=value;},
  setSourceAttribute:(node:any,k:string,v:string)=>setSourceAttribute(node,k,v),sourceTextContent,
  message(value:string,error=false,_footerOnly=false,diagnostic?:string){
   if(!error)el('message').textContent=value;
   el('review-message').textContent=value;el('review-message').classList.toggle('error',error);
   if(diagnostic)el('review-message').title=diagnostic;
   if(error)act.hidden=false;
  },
  restoreRecordComments(){throw new Error('must not restore record comments on interview open');},
  setupComments(){throw new Error('must not setup comments on interview open');},
  showRecordComments(){throw new Error('must not show record comments on interview open');},
  rigInspector:{act,comments:{button:el('comments-button')},collapse:el('collapse')},
  PartExplorer:class{},workspace:{settle:async()=>{}},viewport:{observeResize:()=>({disconnect(){}})},viewDisposers:disposers,
  renderRecordForms(){throw new Error('must not mount forms');},renderPendingSubjects(){},setJobProgress(){},syncJobActRow(){},
  suspendScreen(){},resumeScreen:async()=>{},disposeScreen(){},
 };
 await new Function('scope',`with(scope){${js};return startRecord({subject:'interview',label:'Synthetic interview',sourceHash:'a'.repeat(64)});}`)(scope);
 const refusal='INTERVIEW_PICKS_DISABLED: the interview answer form has been removed; discuss options through live job comments.';
 expect(document.body.dataset.ready).toBe('true');
 expect(act.hidden).toBe(false);
 expect(el('stage-comment').hidden).toBe(true);
 expect(el('save').disabled).toBe(true);
 expect(el('review-message').classList.contains('error')).toBe(true);
 expect(el('review-message').title).toBe('INTERVIEW_PICKS_DISABLED');
 expect(el('review-message').textContent).toBe(refusal);
 expect(el('message').textContent).toBe(refusal);
 expect(el('rig-empty').textContent).toBe(refusal);
 expect(enCatalog[refusal]).toBe(refusal);
 expect(koCatalog[refusal]).toStartWith('INTERVIEW_PICKS_DISABLED: ');
});
