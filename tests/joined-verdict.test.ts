import {expect,spyOn,test} from 'bun:test';
import {link,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {parseOpenInputs} from '../src/cli.ts';
import {frontRoute} from '../src/front.ts';
import {digest} from '../src/interview-project.ts';
import {loadOpenPackage} from '../src/open.ts';
import {loadPartsView,readVerdict} from '../src/parts-view.ts';
import {startServer} from '../src/server.ts';
import {stageVerdictLimit} from '../src/stage-parts.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';

test('verdict directory is explicit and only single joined open supports it',()=>{
  const project=['--project','project','--project-draft','chain','--picks-dir','picks','--parts-verdict-dir','verdicts'];
  expect(parseOpenInputs(['out',...project]).project?.partsVerdictDir).toBe('verdicts');
  expect(()=>parseOpenInputs(['out',...project,'--view-only'])).toThrow('--parts-verdict-dir');
  expect(()=>parseOpenInputs(['out','--parts-verdict-dir','verdicts'])).toThrow('--project');
  expect(frontRoute('single','POST','/api/stage-parts/verdict')?.limit).toBe(stageVerdictLimit);
  expect(frontRoute('compare','POST','/api/stage-parts/verdict')).toBeNull();
  expect(frontRoute('single','GET','/api/stage-parts/verdict')).toBeNull();
});

test('joined verdict is bound to the inspected source and saves through the standalone writer',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-verdict-'));
  const servers:Awaited<ReturnType<typeof startServer>>[]=[];
  try {
    const f=await joinedVerdictFixture(root);
    await expect(loadOpenPackage({input:f.input,project:{...f.project,draftId:'wrong'}})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
    for(const partsVerdictDir of ['derived/drafts/chain/out',f.project.picksDir,'../outside','evidence']){
      await expect(loadOpenPackage({input:f.input,project:{...f.project,partsVerdictDir}})).rejects.toThrow('PARTS_VERDICT_OUTPUT');
    }
    const stateDir=join(root,'state'),capability='a'.repeat(64),nonce='b'.repeat(64);
    const options={port:0,capability,stateDir,open:{nonce,key:'c'.repeat(64),contentHash:f.p.sourceHash,fingerprint:'d'.repeat(64)}};
    const serve=async(joined:typeof f.joined,viewOnly=false)=>{
      const server=await startServer(f.p,{...options,joined,viewOnly});servers.push(server);
      return 'http://127.0.0.1:'+server.port;
    };
    const origin=await serve(f.joined),api='/api/stage-parts',path=origin+api;
    const get=async(suffix='')=>(await fetch(path+suffix)).json();
    const post=(body:unknown,overrides:Record<string,string>={},base=path)=>fetch(base+'/verdict',{
      method:'POST',headers:{Origin:new URL(base).origin,'X-Review-Capability':capability,'Content-Type':'application/json',...overrides},
      body:JSON.stringify(body),
    });
    const refusal=async(response:Promise<Response>,code:string,status:number)=>{
      const res=await response;expect(await res.json()).toEqual({error:code});expect(res.status).toBe(status);
    };
    const data=await get();
    expect(data.draft?.mappings).toEqual([{part:'torso',skin:'default',slot:'torso',attachment:'torso',vertices:30,triangles:40}]);
    expect(data.readOnly).toBe(false);expect(data.verdict).toBeNull();
    expect(await readdir(f.output)).toEqual([]);
    const note='파츠 확인 · keep these words.\nsecond line';
    const payload={binding:data.joinedVerdictBinding,status:'approved',
      parts:Object.fromEntries(data.items.map((item:{name:string;mesh?:unknown})=>[item.name,{outcome:'clean',note,...(item.mesh?{mesh:{outcome:'clean',note}}:{})}]))};
    await refusal(fetch(path+'/export/json'),'PARTS_VERDICT_UNAVAILABLE',409);
    await refusal(post(payload,{'X-Review-Capability':'0'.repeat(64)}),'REVIEW_CAPABILITY_REQUIRED: reopen with rig-review open to edit',403);
    await refusal(post(payload,{Origin:'https://foreign.invalid'}),'Same-origin Origin required',403);
    await refusal(post(payload,{'X-Review-Open-Nonce':'0'.repeat(64)}),'OPEN_INSTANCE_REPLACED',409);
    await refusal(post({...payload,binding:'0'.repeat(64)}),'PARTS_VERDICT_SOURCE_MISMATCH',409);
    await refusal(post(payload,{'X-Review-Stage-Build':'1'.repeat(64)}),'PARTS_VERDICT_READ_ONLY',409);
    await refusal(post({...payload,padding:'x'.repeat(stageVerdictLimit)}),'PARTS_VERDICT_BODY_LIMIT',400);
    await refusal(post({...payload,parts:{}}),'PARTS_VERDICT_MISSING_PART',400);
    const {partsVerdictDir:_,...readOnlyProject}=f.project;
    const readOnly=await loadOpenPackage({input:f.input,project:readOnlyProject});
    if(readOnly.mode!=='single'||!readOnly.joined)throw new Error('Expected read-only join');
    for(const base of [await serve(readOnly.joined),await serve(f.joined,true)]){
      expect((await (await fetch(base+api)).json()).readOnly).toBe(true);
      await refusal(post(payload,{},base+api),'PARTS_VERDICT_READ_ONLY',409);
    }
    expect(await readdir(f.output)).toEqual([]);
    const target=join(f.output,data.verdictFile);
    await link(join(root,'project.json'),target);
    try{await refusal(post(payload),'PARTS_VERDICT_OUTPUT',409);}
    finally{await rm(target);}
    const review=await (await fetch(origin+'/api/review')).json();
    expect(review.manifest.model).toBeUndefined();
    expect(review.capabilities).toMatchObject({preRig:true,playback:false});
    const response=await post(payload);const saved=await response.json();
    expect(response.status).toBe(200);expect(saved.verdict.schema).toBe('rig-review-parts-verdict/2');
    expect(Object.values(saved.verdict.parts).every((entry:any)=>entry.note===note)).toBe(true);
    const bytes=await readFile(target);
    expect(await get('/export/json')).toEqual(JSON.parse(bytes.toString()));
    expect(await (await fetch(path+'/export/issue')).text()).toContain(note);
    expect((await get()).verdict).toEqual(saved.verdict);
    const standalone=await loadPartsView(f.draft.parts,{rig:f.draft.rig,meshReport:f.draft.meshReport,verdict:target});
    expect((await readVerdict(standalone)).verdict).toEqual(saved.verdict);
    for(const file of saved.verdict.source.files)expect(digest(await readFile(resolve(dirname(target),file.path)))).toBe(file.sha256);
    for(const source of ['project.json','derived/drafts/chain/config.json','derived/drafts/chain/interview-requirements.json','derived/drafts/chain/input/parts/torso.png']){
      const file=join(root,source),before=await readFile(file);
      try{
        await writeFile(file,Buffer.concat([before,Buffer.from(' ')]));
        await refusal(post(payload),'INTERVIEW_OPTIONS_STALE',409);
        await refusal(fetch(path+'/export/json'),'INTERVIEW_OPTIONS_STALE',409);
      }finally{await writeFile(file,before);}
    }
    await f.joined.assertCurrent();
    expect(await readFile(target)).toEqual(bytes);
    await f.assertFixture();
    expect(await Bun.file(join(root,'evidence/parts-review.json')).exists()).toBe(false);
  } finally {
    for(const server of servers)server.stop(true);
    await rm(root,{recursive:true,force:true});
  }
},15_000);


test('checkpoint 2 exposes only the registered pending bones set, while its parts verdict stays read-only',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-interview-'));
  let server:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    const fixture=await joinedVerdictFixture(root,'2-rigging-answers');
    const capability='a'.repeat(64);
    server=await startServer(fixture.p,{port:0,capability,joined:fixture.joined});
    const origin='http://127.0.0.1:'+server.port;
    const interview=await (await fetch(origin+'/api/interview')).json();
    expect(interview.binding).toEqual({projectHash:fixture.joined.opened.hash,sourceHash:fixture.p.sourceHash,draftId:'chain'});
    const pending=interview.questions.filter((question:{editable:boolean})=>question.editable);
    expect(pending.map((question:{set:{id:string}})=>question.set.id)).toEqual(['chain-bones']);
    const [question]=pending;
    const submission={schema:'rig-review/interview-picks@1',set:question.ref,by:'user',at:new Date().toISOString(),
      picks:question.set.asks.map((ask:{id:string})=>({ask:ask.id,option_id:'keep'})),note:'Keep the chain · 본 체인 유지'};
    const headers={Origin:origin,'X-Review-Capability':capability,'Content-Type':'application/json'};
    const saved=await fetch(origin+'/api/interview/picks',{method:'POST',headers,body:JSON.stringify(submission)});
    expect(saved.status,await saved.clone().text()).toBe(200);
    expect(await saved.json()).toEqual(submission);
    const parts=await (await fetch(origin+'/api/stage-parts')).json();
    expect(parts.readOnly).toBe(true);
    expect(parts.verdictReadOnlyReason).toStartWith('PARTS_VERDICT_READ_ONLY');
    const verdict=await fetch(origin+'/api/stage-parts/verdict',{method:'POST',headers,body:'{}'});
    expect(verdict.status).toBe(409);
    expect(await verdict.json()).toEqual({error:'PARTS_VERDICT_READ_ONLY'});
    await fixture.assertFixture();
    expect(await readdir(fixture.output)).toEqual([]);
  }finally{server?.stop(true);await rm(root,{recursive:true,force:true});}
});

test('draft source identity includes the project hash independently of the package',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-project-'));
  try{
    const f=await joinedVerdictFixture(root);
    const before=await loadOpenPackage({input:f.input});
    const file=join(root,'project.json'),bytes=await readFile(file);
    try{
      // A whitespace-only project change leaves every recorded artifact and the package identity intact.
      await writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));
      const standalone=await loadOpenPackage({input:f.input});
      const joined=await loadOpenPackage({input:f.input,project:f.project});
      if(joined.mode!=='single'||!joined.joined?.draft)throw new Error('Expected joined draft');
      expect(standalone.contentHash).toBe(before.contentHash);
      expect(joined.joined.opened.hash).not.toBe(f.joined.opened.hash);
      expect(joined.contentHash).not.toBe(f.p.sourceHash);
    }finally{await writeFile(file,bytes);}
    await f.assertFixture();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('joined draft binds the same inventory through project and package aliases', async () => {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'review-draft-alias-'));
  try {
    const f = await joinedVerdictFixture(join(scratch, 'project'));
    const projectAlias = join(scratch, 'project-alias'), packageAlias = join(scratch, 'package-alias');
    await symlink(f.project.root, projectAlias, 'dir');
    await symlink(f.input, packageAlias, 'dir');
    const opened = await loadOpenPackage({ input: packageAlias, project: { ...f.project, root: projectAlias } });
    if (opened.mode !== 'single' || !opened.joined?.draft) throw new Error('Expected joined draft through both aliases');
    expect(opened.joined.draft).toEqual(f.draft);
    expect(opened.contentHash).toBe(f.p.sourceHash);
    await opened.joined.assertCurrent();
    await f.assertFixture();
    expect(await readdir(f.output)).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('draft source identity includes the package hash independently of the project',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-package-'));
  try{
    const f=await joinedVerdictFixture(join(root,'project'));
    const before=await loadOpenPackage({input:f.input});
    // Open's explicit reference changes package identity without editing the draft or its project.
    const reference=join(root,'identity-reference.mp4');
    await writeFile(reference,'Reference bytes for package identity');
    const standalone=await loadOpenPackage({input:f.input,reference});
    const joined=await loadOpenPackage({input:f.input,project:f.project,reference});
    if(joined.mode!=='single'||!joined.joined?.draft)throw new Error('Expected joined draft');
    expect(standalone.contentHash).not.toBe(before.contentHash);
    expect(joined.joined.opened.hash).toBe(f.joined.opened.hash);
    expect(joined.contentHash).not.toBe(f.p.sourceHash);
    await f.assertFixture();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('#562A reopened history binds its selected original draft without producer jobs',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-reopened-draft-'));
  const asynchronous=spyOn(Bun,'spawn');
  const synchronous=spyOn(Bun,'spawnSync');
  try{
    // This retained four-version, region-only archive is a binding control, not five-version mesh acceptance.
    const fixture=await joinedVerdictFixture(root,'reopened');
    const record=fixture.joined.opened.project.drafts as unknown[];
    expect(fixture.joined.opened.project.versions).toHaveLength(4);
    expect(fixture.draft).toMatchObject({record:record[0],editable:true});
    expect(fixture.joined.verdictDirectory?.()).toBe(fixture.output);
    const original=await loadOpenPackage({input:fixture.input});
    expect(fixture.p.sourceHash).toBe(digest(JSON.stringify({schema:'rig-review-joined-draft/1',
      draftId:'example',projectHash:fixture.joined.opened.hash,packageSourceHash:original.contentHash})));
    expect(fixture.p.manifest.model).toBeUndefined();
    expect(fixture.p.handoff).toBeNull();
    const ordered=(record[0] as {config:unknown;config_inputs:unknown[];parts:{files:unknown[]};files:unknown[]});
    expect([...fixture.draft.files.values()]).toEqual([
      ordered.config,...ordered.config_inputs,...ordered.parts.files,...ordered.files,
    ].map(ref=>(ref as {sha256:string}).sha256));
    await fixture.joined.assertCurrent();
    await fixture.assertFixture();
    expect(await readdir(fixture.output)).toEqual([]);
    expect(await readdir(join(root,'reviewer-picks'))).toEqual([]);
    expect(asynchronous).not.toHaveBeenCalled();
    expect(synchronous.mock.calls).toHaveLength(1);
    expect(synchronous.mock.calls[0]![0]).toEqual(['tar','-xzf','-','-C',root]);
  }finally{
    asynchronous.mockRestore();
    synchronous.mockRestore();
    await rm(root,{recursive:true,force:true});
  }
});

test('#562A retains published reference order and rejects incomplete or ambiguous bindings',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-bindings-'));
  try{
    const fixture=await joinedVerdictFixture(root);
    const path=join(root,'project.json'),bytes=await readFile(path);
    // Metadata variants are local negative controls over retained producer bytes.
    const changed=async(edit:(project:any)=>void)=>{
      const project=JSON.parse(bytes.toString());
      edit(project);
      await writeFile(path,JSON.stringify(project));
      return loadOpenPackage({input:fixture.input,project:fixture.project});
    };
    try{
      const ordered=await changed(project=>{
        project.drafts[0].parts.files.reverse();
        project.drafts[0].files.reverse();
      });
      if(ordered.mode!=='single'||!ordered.joined?.draft)throw new Error('Expected ordered draft');
      const selected=(ordered.joined.opened.project.drafts as unknown[])[0];
      expect(JSON.stringify(ordered.joined.draft.record)).toBe(JSON.stringify(selected));
      expect(ordered.joined.draft.editable).toBe(true);
      expect(ordered.joined.draft.record.producer).toEqual(fixture.draft.record.producer);
      expect(ordered.p.reviewedSource).toEqual(fixture.p.reviewedSource);
      for(const edit of [
        (project:any)=>{project.versions=null;},
        (project:any)=>{project.drafts.push(project.drafts[0]);},
        (project:any)=>{delete project.drafts[0].config_inputs;},
        (project:any)=>{project.drafts[0].config_inputs=[];},
        (project:any)=>{project.drafts[0].parts.files.splice(1,1);},
        (project:any)=>{project.drafts[0].files=project.drafts[0].files.filter((file:{path:string})=>!file.path.includes('/images/'));},
        (project:any)=>{project.drafts[0].config.sha256='0'.repeat(64);},
        (project:any)=>{project.drafts[0].files.find((file:{path:string})=>file.path.endsWith('/skeleton.model.json')).sha256='0'.repeat(64);},
        (project:any)=>{project.drafts[0].config_inputs[0].path='../outside.json';},
        (project:any)=>{delete project.drafts[0].producer;},
      ])await expect(changed(edit)).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
    }finally{await writeFile(path,bytes);}
    const extra=join(root,'derived/drafts/chain/out/unrecorded.json');
    await writeFile(extra,'{}\n');
    try{
      await expect(loadOpenPackage({input:fixture.input,project:fixture.project})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
      await expect(fixture.joined.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');
    }finally{await rm(extra);}
    await fixture.joined.assertCurrent();
    await fixture.assertFixture();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('#562A optional config dependencies require their own raw bindings',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-config-inputs-'));
  try{
    const fixture=await joinedVerdictFixture(root);
    const projectPath=join(root,'project.json'),projectBytes=await readFile(projectPath);
    const configPath=join(root,fixture.draft.record.config.path),configBytes=await readFile(configPath);
    const inputPath=join(root,'derived/drafts/chain/motion-input.json');
    const inputBytes=await readFile(join(root,'derived/drafts/chain/out/motion.json'));
    await writeFile(inputPath,inputBytes);
    try{
      const project=JSON.parse(projectBytes.toString()),record=project.drafts[0];
      const config=JSON.parse(configBytes.toString());
      config.motion.animations_from='motion-input.json';
      const text=JSON.stringify(config);
      await writeFile(configPath,text);
      record.config.sha256=digest(text);
      await writeFile(projectPath,JSON.stringify(project));
      await expect(loadOpenPackage({input:fixture.input,project:fixture.project})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
      record.config_inputs.push({path:'derived/drafts/chain/motion-input.json',sha256:digest(inputBytes)});
      await writeFile(projectPath,JSON.stringify(project));
      const bound=await loadOpenPackage({input:fixture.input,project:fixture.project});
      if(bound.mode!=='single'||!bound.joined?.draft)throw new Error('Expected bound config input');
      expect(bound.joined.draft.record.config_inputs).toEqual(record.config_inputs);
      await bound.joined.assertCurrent();
      await writeFile(inputPath,Buffer.concat([inputBytes,Buffer.from(' ')]));
      await expect(bound.joined.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');

      // A dependency-free legacy config may omit the optional inventory altogether.
      delete config.motion.animations_from;
      delete config.requirements;
      config.generation={control:{skeleton:'stand_sides'}};
      const independent=JSON.stringify(config);
      await writeFile(configPath,independent);
      record.config.sha256=digest(independent);
      delete record.config_inputs;
      await writeFile(projectPath,JSON.stringify(project));
      const legacy=await loadOpenPackage({input:fixture.input,project:fixture.project});
      if(legacy.mode!=='single'||!legacy.joined?.draft)throw new Error('Expected dependency-free draft');
      expect(Object.hasOwn(legacy.joined.draft.record,'config_inputs')).toBe(false);
      expect(legacy.joined.draft.record.producer).toEqual(fixture.draft.record.producer);
    }finally{
      await writeFile(projectPath,projectBytes);
      await writeFile(configPath,configBytes);
      await rm(inputPath);
    }
    await fixture.assertFixture();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('#562A current stage and effective approval chronology determine editability',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-eligibility-'));
  try{
    const fixture=await joinedVerdictFixture(root,'reopened');
    const path=join(root,'project.json'),bytes=await readFile(path);
    const original=JSON.parse(bytes.toString());
    const prior=original.signoffs.find((entry:{stage:string})=>entry.stage==='parts-review');
    const after=new Date(Date.parse(original.reopens[0].at)+1000).toISOString();
    const cases:[string,boolean,(project:any)=>void][]=[
      ['covering reopen',true,()=>{}],
      ['no reopen',false,project=>{project.reopens=[];}],
      ['later human approval',false,project=>{project.signoffs.push({...prior,at:after});}],
      ['downstream reopen',false,project=>{project.reopens[0].stage='rig-review';}],
      ['covering amendment',true,project=>{project.amendments=[{target:{stage:'parts-review'},at:project.reopens[0].at}];project.reopens=[];}],
      ['checkpoint only',true,project=>{project.signoffs=project.signoffs.map((entry:any)=>entry.stage==='parts-review'?{...entry,checkpoint:'assemble'}:entry);} ],
      ['rig review stage',false,project=>{project.stage='rig-review';}],
      ['accepted stage',false,project=>{project.stage='accepted';}],
      ['malformed approval time',false,project=>{project.signoffs.push({...prior,at:'invalid'});}],
      ['malformed reopen time',false,project=>{project.reopens[0].at='invalid';}],
      ['malformed reopen collection',false,project=>{project.reopens={};}],
    ];
    try{
      for(const [name,editable,edit] of cases){
        const project=JSON.parse(bytes.toString());
        edit(project);
        await writeFile(path,JSON.stringify(project));
        const opened=await loadOpenPackage({input:fixture.input,project:fixture.project});
        if(opened.mode!=='single'||!opened.joined?.draft)throw new Error('Expected selected draft');
        expect(opened.joined.draft.editable,name).toBe(editable);
        expect(Boolean(opened.joined.verdictDirectory),name).toBe(editable);
        expect(opened.joined.draft.record,name).toEqual(project.drafts[0]);
        expect(opened.joined.opened.project.versions,name).toEqual(original.versions);
        expect(opened.joined.opened.project.signoffs,name).toEqual(project.signoffs);
      }
    }finally{await writeFile(path,bytes);}
    await fixture.assertFixture();
  }finally{await rm(root,{recursive:true,force:true});}
});
