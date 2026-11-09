import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {partsIssueSubmission} from './helpers/parts-comments-package.ts';
import ts from 'typescript';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {t} from '../web/i18n.ts';
import {expect,spyOn,test} from 'bun:test';
import {link,mkdir,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {parseOpenInputs} from '../src/cli.ts';
import {frontRoute} from '../src/front.ts';
import {digest} from '../src/interview-project.ts';
import {locateInstalledParts} from '../src/handoff.ts';
import {loadOpenPackage} from '../src/open.ts';
import {loadPartsView,readVerdict,verdictSource,exportPartsVerdict} from '../src/parts-view.ts';
import {draftProducerInputs,draftRebuildOption} from '../src/rebuild.ts';
import {startServer} from '../src/server.ts';
import {stageVerdictLimit,stageVerdictRefusals} from '../src/stage-parts.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';

test('verdict directory is explicit and only single joined open supports it',()=>{
  const project=['--project','project','--project-draft','chain','--picks-dir','picks','--parts-verdict-dir','verdicts'];
  expect(parseOpenInputs(['out',...project]).project?.partsVerdictDir).toBe('verdicts');
  expect(()=>parseOpenInputs(['out',...project,'--view-only'])).toThrow('--parts-verdict-dir');
  expect(()=>parseOpenInputs(['out','--parts-verdict-dir','verdicts'])).toThrow('--project');
  expect(frontRoute('single','POST','/api/stage-parts/verdict')?.limit).toBe(stageVerdictLimit);
  expect(frontRoute('compare','POST','/api/stage-parts/verdict')).toBeNull();
  expect(frontRoute('single','GET','/api/stage-parts/verdict')).toBeNull();
  expect(stageVerdictRefusals).toContain('PARTS_JOINED_ISSUE_UNSUPPORTED');
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
    const inspected=await loadPartsView(f.draft.parts,{rig:f.draft.rig,meshReport:f.draft.meshReport});
    const submission=await partsIssueSubmission(inspected,note);
    expect(submission.issues[0]!.sourceHash).toBe(data.sourceHash);
    const issuePayload={binding:data.joinedVerdictBinding,...submission};
    const payload={binding:data.joinedVerdictBinding,status:'approved',issues:[]};
    await refusal(fetch(path+'/export/json'),'PARTS_VERDICT_UNAVAILABLE',409);
    await refusal(post(payload,{'X-Review-Capability':'0'.repeat(64)}),'REVIEW_CAPABILITY_REQUIRED: reopen with rig-review open to edit',403);
    await refusal(post(issuePayload,{'X-Review-Capability':'0'.repeat(64)}),'REVIEW_CAPABILITY_REQUIRED: reopen with rig-review open to edit',403);
    await refusal(post(payload,{Origin:'https://foreign.invalid'}),'Same-origin Origin required',403);
    await refusal(post(issuePayload,{Origin:'https://foreign.invalid'}),'Same-origin Origin required',403);
    await refusal(post(payload,{'X-Review-Open-Nonce':'0'.repeat(64)}),'OPEN_INSTANCE_REPLACED',409);
    await refusal(post(issuePayload,{'X-Review-Open-Nonce':'0'.repeat(64)}),'OPEN_INSTANCE_REPLACED',409);
    await refusal(post({...payload,binding:'0'.repeat(64)}),'PARTS_VERDICT_SOURCE_MISMATCH',409);
    await refusal(post(payload,{'X-Review-Stage-Build':'1'.repeat(64)}),'PARTS_VERDICT_READ_ONLY',409);
    await refusal(post(issuePayload,{'X-Review-Stage-Build':'1'.repeat(64)}),'PARTS_VERDICT_READ_ONLY',409);
    await refusal(post({...issuePayload,binding:'0'.repeat(64)}),'PARTS_VERDICT_SOURCE_MISMATCH',409);
    await refusal(post({...payload,padding:'x'.repeat(stageVerdictLimit)}),'PARTS_VERDICT_BODY_LIMIT',400);
    await refusal(post({...payload,parts:{}}),'PARTS_VERDICT_INVALID',400);
    const {issues:_issues,...missingIssues}=payload;
    await refusal(post(missingIssues),'PARTS_COMMENT_LIMIT',400);
    const {partsVerdictDir:_,...readOnlyProject}=f.project;
    const readOnly=await loadOpenPackage({input:f.input,project:readOnlyProject});
    if(readOnly.mode!=='single'||!readOnly.joined)throw new Error('Expected read-only join');
    for(const base of [await serve(readOnly.joined),await serve(f.joined,true)]){
      expect((await (await fetch(base+api)).json()).readOnly).toBe(true);
      await refusal(post(payload,{},base+api),'PARTS_VERDICT_READ_ONLY',409);
      await refusal(post(issuePayload,{},base+api),'PARTS_VERDICT_READ_ONLY',409);
    }
    expect(await readdir(f.output)).toEqual([]);
    const target=join(f.output,data.verdictFile);
    await link(join(root,'project.json'),target);
    try{await refusal(post(payload),'PARTS_VERDICT_OUTPUT',409);await refusal(post(issuePayload),'PARTS_VERDICT_OUTPUT',409);}
    finally{await rm(target);}
    const review=await (await fetch(origin+'/api/review')).json();
    expect(review.manifest.model).toBeUndefined();
    expect(review.capabilities).toMatchObject({preRig:true,playback:false});
    const response=await post(payload),saved=await response.json();
    expect(response.status,JSON.stringify(saved)).toBe(200);
    expect(saved.verdict).toMatchObject({schema:'rig-review-parts-verdict/4',status:'approved',issues:[]});
    const bytes=await readFile(target);
    await refusal(post(issuePayload),'PARTS_JOINED_ISSUE_UNSUPPORTED',400);
    await refusal(post({...issuePayload,status:'approved'}),'PARTS_JOINED_ISSUE_UNSUPPORTED',400);
    await refusal(post({...issuePayload,issues:[null]}),'PARTS_JOINED_ISSUE_UNSUPPORTED',400);
    await refusal(post({...issuePayload,status:'pending'}),'PARTS_VERDICT_INVALID',400);
    await refusal(post({...payload,status:'changes-requested'}),'PARTS_VERDICT_NOTHING_FLAGGED',400);
    expect(await readFile(target)).toEqual(bytes);
    expect(await get('/export/json')).toEqual(JSON.parse(exportPartsVerdict(saved.verdict,'json')));
    expect(await (await fetch(path+'/export/issue')).text()).toContain('Status: approved');
    expect((await get()).verdict).toEqual(saved.verdict);
    const standalone=await loadPartsView(f.draft.parts,{rig:f.draft.rig,meshReport:f.draft.meshReport,verdict:target});
    expect((await readVerdict(standalone)).verdict).toEqual(saved.verdict);
    for(const file of saved.verdict.source.files)expect(digest(await readFile(resolve(dirname(target),file.path)))).toBe(file.sha256);
    for(const source of ['project.json','derived/drafts/chain/config.json','derived/drafts/chain/interview-requirements.json','derived/drafts/chain/input/parts/torso.png']){
      const file=join(root,source),before=await readFile(file);
      try{
        await writeFile(file,Buffer.concat([before,Buffer.from(' ')]));
        await refusal(post(payload),'INTERVIEW_OPTIONS_STALE',409);
        await refusal(post(issuePayload),'INTERVIEW_OPTIONS_STALE',409);
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


test('joined comment and adapter boundaries name the standing job route in EN and KO',async()=>{
  const code='PARTS_JOINED_ISSUE_UNSUPPORTED';
  const parts=await readFile('web/parts.ts','utf8'),page=await readFile('web/parts-page.ts','utf8');
  const expression=(source:string,name:string)=>{
    const tree=ts.createSourceFile('boundary.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const found:ts.Node[]=[];
    const visit=(node:ts.Node)=>{
      if(ts.isPropertyAssignment(node)&&node.name.getText(tree)===name)found.push(node.initializer);
      if(ts.isVariableDeclaration(node)&&node.name.getText(tree)===name&&node.initializer)found.push(node.initializer);
      if(ts.isMethodDeclaration(node)&&node.name.getText(tree)===name)found.push(node);
      ts.forEachChild(node,visit);
    };
    visit(tree);expect(found).toHaveLength(1);
    const node=found[0]!,value=ts.isMethodDeclaration(node)?`({${node.getText(tree)}}).${name}`:node.getText(tree);
    return new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(`const extracted = ${value};`);
  };
  const refusalCode=expression(parts,'refusal'),cropCode=expression(page,'crop'),saveCode=expression(page,'save');
  for(const language of ['en','ko'] as const){
    const message=(language==='en'?enCatalog:koCatalog)[code]!;
    expect(message).toContain('/jobs/<jobId>/');
    expect(t(code,undefined,language)).toBe(message);
    let phase='open';
    const scope={paintFailure:null as string|null,state:{data:{mode:'parts',legacyVerdict:null as {readOnly:boolean;code:string;flaggedCount:number}|null},view:'item'},stageEmbedded:true,host:{locked:()=>phase},t:(key:string)=>t(key,undefined,language)};
    const refusal=new Function('scope',`with(scope){${refusalCode};return extracted;}`)(scope) as ()=>string|null;
    expect(refusal()).toBe(code);
    scope.state.view='assembled';expect(refusal()).toBe(code);scope.state.view='item';
    phase='sent';expect(refusal()).toBe('Read-only view: reopen with rig-review open to edit.');phase='open';
    scope.state.data.legacyVerdict={readOnly:true,code:'PARTS_VERDICT_LEGACY_FORMAT',flaggedCount:1};expect(refusal()).toStartWith('PARTS_VERDICT_LEGACY_FORMAT');scope.state.data.legacyVerdict=null;
    scope.paintFailure='paint failure';expect(refusal()).toBe('paint failure');scope.paintFailure=null;
    scope.stageEmbedded=false;expect(refusal()).toBeNull();scope.stageEmbedded=true;
    let requests=0,outputs=0;
    const status={textContent:'',dataset:{} as Record<string,string>},button={disabled:false};
    const adapter={embedded:true,busy:false,disposed:false,currentView:{},host:{locked:()=>phase},output:{value:()=>{outputs++;return {verdict:'changes-requested',issues:[null]};}},required:(selector:string)=>selector==='#pv-save'?button:status,t:(key:string)=>t(key,undefined,language),fetch:async()=>{requests++;throw new Error('Unexpected joined issue request');}};
    const crop=new Function('scope',`with(scope){${cropCode};return extracted;}`)(adapter) as (issue:unknown)=>Promise<unknown>;
    await expect(crop({})).rejects.toThrow(code);expect(requests).toBe(0);
    const save=new Function('scope',`with(scope){${saveCode};return extracted;}`)(adapter) as ()=>Promise<void>;
    await save();expect(status.textContent).toBe(message);expect(status.dataset.result).toBe('refused');expect(requests).toBe(0);expect(button.disabled).toBe(false);
    phase='sent';await save();expect(outputs).toBe(1);expect(requests).toBe(0);
  }
});

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
    const verdict=await fetch(origin+'/api/stage-parts/verdict',{method:'POST',headers,body:JSON.stringify({status:'changes-requested',issues:[null]})});
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

test('#591 Stage 1 draft config_inputs binds assemble.occluders image and plate directory receipt (create#326 93b361f shape) and enforces draftProducerInputs consistency across logical options.cwd',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'review-draft-occluders-'));
  try{
    const fixture=await joinedVerdictFixture(root,'reopened');
    const projectPath=join(root,'project.json'),projectBytes=await readFile(projectPath);
    const configPath=join(root,fixture.draft.record.config.path),configBytes=await readFile(configPath);
    const draftDir=join(root,'derived/drafts/example');
    const occluderDir=join(draftDir,'occluders');
    const plateDir=join(draftDir,'plates/front');
    await mkdir(occluderDir,{recursive:true});
    await mkdir(plateDir,{recursive:true});
    const imagePath=join(occluderDir,'front.png'),imageBytes=Buffer.from('png-occluder-front');
    const receiptPath=join(plateDir,'receipt.json');
    const receiptBytes=Buffer.from(JSON.stringify({spec:'rig-parts-plate-receipt/1',mode:'occluder',plate:'plate.png',mask:'mask.png'},null,2)+'\n');
    const siblingPath=join(plateDir,'plate.png');
    await writeFile(imagePath,imageBytes);
    await writeFile(receiptPath,receiptBytes);
    await writeFile(siblingPath,'sibling-plate-v1');

    const config=JSON.parse(configBytes.toString());
    config.assemble={
      ...(config.assemble??{}),
      occluders:[{part:'torso',image:'occluders/front.png',plate:'plates/front'}],
    };
    const configText=JSON.stringify(config);
    await writeFile(configPath,configText);

    const baseProject=JSON.parse(projectBytes.toString());
    baseProject.drafts[0].config.sha256=digest(configText);
    const imageEntry={path:'derived/drafts/example/occluders/front.png',sha256:digest(imageBytes)};
    const plateEntry={
      path:'derived/drafts/example/plates/front/receipt.json',
      sha256:digest(receiptBytes),
      directory:'derived/drafts/example/plates/front',
      spec:'rig-parts-plate-receipt/1',
    };

    // With an older loader stub (2.25.1) in project ancestry, declared occluder inputs are refused instead of falling back to OWN_ROOT.
    const stubParts=join(root,'node_modules/@rig-c/parts');
    await mkdir(join(stubParts,'src'),{recursive:true});
    await writeFile(join(stubParts,'package.json'),JSON.stringify({name:'@rig-c/parts',version:'2.25.1'}));
    await writeFile(join(stubParts,'src/config.ts'),`export function configFileReferences(raw){
      const out=[];
      if(raw&&typeof raw==='object'){
        if(typeof raw.requirements==='string'&&raw.requirements)out.push({at:'requirements',value:raw.requirements,set(v){raw.requirements=v;}});
        if(raw.motion&&typeof raw.motion.animations_from==='string'&&raw.motion.animations_from)out.push({at:'motion.animations_from',value:raw.motion.animations_from,set(v){raw.motion.animations_from=v;}});
      }
      return out;
    }\n`);
    const withEntries=structuredClone(baseProject);
    withEntries.drafts[0].config_inputs.push(imageEntry,plateEntry);
    await writeFile(projectPath,JSON.stringify(withEntries));
    await expect(loadOpenPackage({input:fixture.input,project:fixture.project})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');
    await rm(join(root,'node_modules'),{recursive:true,force:true});

    // Missing image or plate entry in config_inputs is refused under installed @rig-c/parts@2.35.0.
    const missingPlate=structuredClone(baseProject);
    missingPlate.drafts[0].config_inputs.push(imageEntry);
    await writeFile(projectPath,JSON.stringify(missingPlate));
    await expect(loadOpenPackage({input:fixture.input,project:fixture.project})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');

    // Wrong spec on plate entry is refused.
    const wrongSpec=structuredClone(baseProject);
    wrongSpec.drafts[0].config_inputs.push(imageEntry,{...plateEntry,spec:'wrong-spec/1'});
    await writeFile(projectPath,JSON.stringify(wrongSpec));
    await expect(loadOpenPackage({input:fixture.input,project:fixture.project})).rejects.toThrow('INTERVIEW_SOURCE_MISMATCH');

    // Exact create#326 (93b361f) shape succeeds across joinProject, assertCurrent, and draftProducerInputs via logical options.cwd.
    const externalCwd=join(root,'external-cwd');
    await mkdir(join(externalCwd,'node_modules/@rig-c'),{recursive:true});
    await symlink(locateInstalledParts(),join(externalCwd,'node_modules/@rig-c/parts'));
    await writeFile(projectPath,JSON.stringify(withEntries));
    const opened=await loadOpenPackage({input:fixture.input,project:fixture.project},{cwd:externalCwd});
    if(opened.mode!=='single'||!opened.joined?.draft)throw new Error('Expected joined draft with occluders');
    expect(opened.joined.draft.record.config_inputs).toContainEqual(imageEntry);
    expect(opened.joined.draft.record.config_inputs).toContainEqual(plateEntry);
    await opened.joined.assertCurrent();

    // Changing sibling plate.png does not invalidate assertCurrent or draftProducerInputs.
    await writeFile(siblingPath,'sibling-plate-v2');
    await opened.joined.assertCurrent();
    const opt=draftRebuildOption(opened.joined)!;
    await expect(draftProducerInputs(opt,true)).resolves.toMatchObject({
      config:configPath,
      configHash:digest(configText),
    });

    // Mutating receipt.json or image invalidates assertCurrent and draftProducerInputs.
    await writeFile(receiptPath,Buffer.concat([receiptBytes,Buffer.from(' ')]));
    await expect(opened.joined.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');
    await expect(draftProducerInputs(opt,true)).rejects.toThrow('REBUILD_INPUTS_CHANGED');
    await writeFile(receiptPath,receiptBytes);
    await opened.joined.assertCurrent();

    await writeFile(imagePath,Buffer.concat([imageBytes,Buffer.from('x')]));
    await expect(opened.joined.assertCurrent()).rejects.toThrow('INTERVIEW_OPTIONS_STALE');
    await expect(draftProducerInputs(opt,true)).rejects.toThrow('REBUILD_INPUTS_CHANGED');
    await writeFile(imagePath,imageBytes);
    await opened.joined.assertCurrent();
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});
