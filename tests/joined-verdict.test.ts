import {expect,test} from 'bun:test';
import {link,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
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
