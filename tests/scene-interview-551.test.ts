/** #551 phase1 TEST-FIRST. Product is unchanged.
 * Authority: frozen PROJECT f1868ee closed option gate (rule 4 only replaces
 * 9678 rule 4), original rules 1–3/5–6, INTERVIEW answer/decision own-at.
 * Writer archives are synthetic example projects produced by real Create writers.
 * Every project/scene mutation below is an explicitly SYNTHETIC UNIT CONTROL,
 * never producer provenance. No Create implementation is imported by this test.
 */
import {afterEach, expect, test} from 'bun:test';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest, readProject} from '../src/interview-project.ts';
import {captureJobRoot, prepareJobSource} from '../src/job-source.ts';
import {interviewRoutes} from '../src/interview-routes.ts';
import type {JobPublishRequest} from '../src/job-contract.ts';

const fixtureDir=join(import.meta.dir,'fixtures/scene-interview-551');
const runtime=resolve(import.meta.dir,'../.review-551-result/phase1/runtime');
const NOW=Date.parse('2026-11-08T12:00:10Z'), DRAFT=Date.parse('2026-11-08T12:00:01Z');
const SINCE=Date.parse('2026-11-08T00:00:00Z');
const roots:string[]=[];
const iso=(t:number)=>new Date(t).toISOString();
const json=(root:string,path:string)=>JSON.parse(readFileSync(join(root,path),'utf8'));
const save=(root:string,path:string,value:unknown)=>writeFileSync(join(root,path),JSON.stringify(value,null,2)+'\n');
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(name='writer-current') {
 mkdirSync(runtime,{recursive:true});const root=mkdtempSync(join(runtime,'case-'));roots.push(root);
 const archive=join(fixtureDir,name+'.tar.gz');
 const provenance=json(fixtureDir,'provenance.json');
 expect(digest(readFileSync(archive))).toBe(provenance.archives[name+'.tar.gz']);
 const extracted=spawnSync('tar',['-xzf',archive,'-C',root],{encoding:'utf8'});
 if(extracted.status!==0)throw new Error('Fixture extraction failed: '+extracted.stderr);
 return root;
}
const item=(p:any)=>p.interview.post.items.find((i:any)=>i.id==='post_composition');
function active(root:string) {const p=json(root,'project.json'),i=item(p);return {p,i,ref:i.pending_options,set:json(root,i.pending_options.path)};}
/** SYNTHETIC EXTRACTION for the two isolated currentness controls.
 * Keep the scene pending set and project evidence, and remove every unrelated
 * question and answer/history record from this disposable example copy.
 */
function sceneCurrentnessFixture() {
 const root = fixture();
 const {p: project, i: selected, ref, set} = active(root);
 expect(set.context.kind).toBe('scene');
 delete selected.guide;
 delete selected.history;
 project.interview.framing = [];
 project.interview.waypoints = [];
 project.interview.post.items = [selected];
 save(root, 'project.json', project);
 expect(selected.pending_options).toEqual(ref);
 expect(digest(readFileSync(join(root, ref.path)))).toBe(ref.sha256);
 return root;
}
function rewriteSet(root:string,p:any,set:any,path:string) {
 save(root,path,set);const ref={path,sha256:digest(readFileSync(join(root,path)))};item(p).pending_options=ref;save(root,'project.json',p);return ref;
}
function sceneMutation(root:string,mutate:(s:any)=>void) {
 const {p,set,ref}=active(root);const entry=p.scenes[0],s=json(root,entry.path);mutate(s);
 save(root,entry.path,s);entry.sha256=digest(readFileSync(join(root,entry.path)));set.context.scene.sha256=entry.sha256;
 rewriteSet(root,p,set,ref.path);
}
function opened(root:string,now=NOW) {return readProject(root,now);}
function question(root:string,now=NOW) {return opened(root,now).questions.find(q=>q.set.id==='review551-scene-current')!;}
function stale(root:string,now=NOW) {expect(()=>opened(root,now)).toThrow('INTERVIEW_OPTIONS_STALE');}
// SYNTHETIC UNIT CONTROL: dated record mutations are not human signatures or writer evidence.
function alterProject(root:string,mutate:(p:any)=>void) {const p=json(root,'project.json');mutate(p);save(root,'project.json',p);}
function addScene(p:any,root:string,at= DRAFT+1000) {
 const s=json(root,p.scenes[0].path);s.n=2;const path='evidence/scene/s2.json';save(root,path,s);
 p.scenes.push({n:2,path,sha256:digest(readFileSync(join(root,path))),at:iso(at),by:'synthetic-control'});
}
function rig3(p:any,at=DRAFT+1000) {
 const v=structuredClone(p.versions[0]);v.n=3;v.at=iso(at);
 v.verdicts=[{review:'rig-review',by:'synthetic-control',at:iso(at+1),verdict:'accepted'}];p.versions.push(v);
 const sign=structuredClone(p.signoffs.find((s:any)=>s.stage==='rig-review'));sign.at=iso(at+2);
 sign.target={...sign.target,version:3,verdict:`versions[${p.versions.length-1}].verdicts[0]`,review_package:{...sign.target.review_package,path:`versions[${p.versions.length-1}].review_package`}};
 p.signoffs.push(sign);
}
function legacy(root:string,offset=-1) {
 const {p,set,ref}=active(root);
 // Move only the recipe reopen before the synthetic draft, not across an answer.
 p.reopens[0].at=iso(SINCE-10000);rig3(p,SINCE-5000);
 set.drafted_at=iso(SINCE+offset);rewriteSet(root,p,set,ref.path);
}
function sealTree(root:string):Record<string,string> {
 const result:Record<string,string>={};
 function visit(dir:string,prefix='') {for(const e of readdirSync(dir,{withFileTypes:true})) {
  const path=prefix+e.name;if(e.isDirectory())visit(join(dir,e.name),path+'/');else if(e.isFile())result[path]=digest(readFileSync(join(dir,e.name)));
 }}visit(root);return result;
}
const diagnostics=(v:unknown)=>JSON.stringify(v);

test('bar1 writer-built current scene opens editable through actual readProject; source bytes stay frozen',()=>{
 const root=fixture(),before=sealTree(root),ref=active(root).ref;
 const q=question(root);expect(q.ref).toEqual(ref);expect(q.editable).toBe(true);
 expect(q.set.question).toBe('post_composition');expect(sealTree(root)).toEqual(before);
});
test('bar2 writer-built later scene refuses the earlier set by stale name',()=>stale(fixture('writer-later-scene')));
test('bar3 SYNTHETIC changed scene bytes refuse rather than fall back',()=>{
 const root=fixture();writeFileSync(join(root,'evidence/scene/s1.json'),'{}\n');stale(root);
});
test('bar4 SYNTHETIC later accepted rig makes old scene stale',()=>{
 const root=fixture();alterProject(root,p=>rig3(p));stale(root);
});
test('bar5 SYNTHETIC covering rig-review reopen removes a live accepted rig',()=>{
 const root=fixture();alterProject(root,p=>p.reopens.push({stage:'rig-review',at:iso(DRAFT+1),by:'synthetic-control'}));stale(root);
});
test('bar6/bar9 shipped writer chain rig-kind sets read unchanged when scenes are ignored',()=>{
 const root=fixture('writer-chain');const before=opened(root).questions.map(q=>({ref:q.ref,editable:q.editable,answer:q.answer,images:q.images}));
 alterProject(root,p=>delete p.scenes);
 expect(opened(root).questions.map(q=>({ref:q.ref,editable:q.editable,answer:q.answer,images:q.images}))).toEqual(before);
 expect(before.length).toBeGreaterThan(0);
});
test('bar7 writer-built scene answer in history remains readable with its original text and set',()=>{
 const root=fixture('writer-history'),p=json(root,'project.json');
 const historical=item(p).history.find((a:any)=>a.choice?.set?.path==='evidence/interview/review551-scene-current.json');
 expect(historical).toBeDefined();
 const q=opened(root).questions.find(q=>q.ref.path===historical.choice.set.path)!;
 expect(q.editable).toBe(false);expect(q.answer).toEqual(historical);
});
test('bar8 SYNTHETIC pre-SINCE currentness-only failure warns nonfatally on normal readProject',()=>{
 const root=fixture();legacy(root);const result=opened(root);
 expect(result.questions.find(q=>q.set.id==='review551-scene-current')?.editable).toBe(true);
 expect(diagnostics(result)).toContain('INTERVIEW_OPTIONS_SCENE_LEGACY');
});

// Closed structure controls follow the documented option gate, not the full scene check.
const closedPaths=[[],['rig'],['rig','animation'],['rig','animation','frames'],['rig','model'],
 ['rig','acceptance'],['rig','acceptance','signoff'],['rig','acceptance','review_package'],
 ['frame'],['frame','stage'],['plates',0],['plates',0,'rect'],['plates',0,'registered'],['plates',0,'citation']];
for(const path of closedPaths)test(`codec SYNTHETIC closed key refusal at ${path.join('.')||'document'}`,()=>{
 const root=fixture();sceneMutation(root,s=>{
  s.rig.animation.frames={path:'inputs/background.png',sha256:s.plates[0].sha256};
  let target=s;for(const key of path)target=target[key];target.unlisted='must refuse';
 });stale(root);
});
const malformed:[string,(s:any)=>void][]=[
 ['schema',s=>s.schema='rig-create/scene@2'],['missing key',s=>delete s.frame],['entry n mismatch',s=>s.n=2],
 ['unsafe count',s=>s.rig.version=Number.MAX_SAFE_INTEGER+1],['zero count',s=>s.plates[0].width=0],
 ['upper hash',s=>s.rig.model.sha256='A'.repeat(64)],['binding missing hash',s=>delete s.rig.model.sha256],
 ['absolute path',s=>s.rig.model.path='/tmp/model'],['dot segment',s=>s.plates[0].path='a/../b'],
 ['backslash',s=>s.rig.model.path='a\\b'],['drive prefix',s=>s.rig.model.path='C:/b'],['empty segment',s=>s.rig.model.path='a//b'],
 ['blank animation',s=>s.rig.animation.name=' '],['signoff checkpoint',s=>s.rig.acceptance.signoff.checkpoint='rig'],
 ['unreadable acceptance date',s=>s.rig.acceptance.signoff.at='bad'],['verdict locator',s=>s.rig.acceptance.verdict='file.json'],
 ['frame space',s=>s.frame.space='pixels'],['box string',s=>s.frame.stage.width='128'],['plates object',s=>s.plates={}],
 ['role enum',s=>s.plates[0].role='rig'],['registered kind',s=>s.plates[0].registered.kind='source'],
 ['blank registered ref',s=>s.plates[0].registered.ref=' '],['citation asks',s=>s.plates[0].citation.asks=[1]],
 ['citation delegated',s=>s.plates[0].citation.delegated='yes'],['layers strings',s=>s.layers=[1]],
];
for(const [name,mutate]of malformed)test('codec SYNTHETIC '+name,()=>{const root=fixture();sceneMutation(root,mutate);stale(root);});
test('codec SYNTHETIC optional citation and frames may be absent; no foreground is encoded by absence',()=>{
 const root=fixture();sceneMutation(root,s=>delete s.plates[0].citation);expect(question(root).editable).toBe(true);
});
test('codec SYNTHETIC full writer checks are outside the option gate',()=>{
 const root=fixture();sceneMutation(root,s=>{
  s.plates[0].width=7;s.plates[0].rect.width=123;s.plates[0].registered.ref='derived[999]';
  s.plates[0].citation={quote:'synthetic wording not in human record'};s.layers=['synthetic-layer'];
 });expect(question(root).editable).toBe(true);
});
for(const [name,mutate]of [
 ['extra entry key',(e:any)=>e.extra=true],['agent by',(e:any)=>e.by='AGENT'],['count order',(e:any)=>e.n=3],
 ['noncanonical path',(e:any)=>e.path='evidence/scene/other.json'],['non-Z time',(e:any)=>e.at='2026-11-06T01:00:57+00:00'],
] as const)test('entry SYNTHETIC '+name,()=>{const root=fixture();alterProject(root,p=>mutate(p.scenes[0]));stale(root);});
for(const [name,mutate]of [
 ['scene file missing',(root:string)=>rmSync(join(root,'evidence/scene/s1.json'))],
 ['scene file symlink',(root:string)=>{cpSync(join(root,'evidence/scene/s1.json'),join(root,'scene-copy.json'));rmSync(join(root,'evidence/scene/s1.json'));symlinkSync(join(root,'scene-copy.json'),join(root,'evidence/scene/s1.json'));}],
] as const)test('path SYNTHETIC '+name,()=>{const root=fixture();mutate(root);stale(root);});
test('SYNTHETIC malformed newest candidate never falls back to an earlier valid scene',()=>{
 const root=fixture();alterProject(root,p=>addScene(p,root));writeFileSync(join(root,'evidence/scene/s2.json'),'{}');stale(root);
});
for(const at of [DRAFT-1,DRAFT,DRAFT+1,NOW,NOW+1])test(`time SYNTHETIC candidate <= evaluation at ${at}`,()=>{
 const root=fixture();alterProject(root,p=>addScene(p,root,at));
 if(at<=NOW)stale(root);else expect(question(root).editable).toBe(true);
});
for(const field of ['reopens','amendments'])for(const at of [DRAFT-1,DRAFT,DRAFT+1,NOW,NOW+1])test(`freshness SYNTHETIC ${field} strict-after draft inclusive-through now ${at}`,()=>{
 const root=fixture();alterProject(root,p=>{
  p[field]??=[];p[field].push(field==='reopens'?{stage:'post-interview',at:iso(at),by:'synthetic-control'}:{target:{stage:'post-interview'},at:iso(at),by:'synthetic-control'});
 });if(at>DRAFT&&at<=NOW)stale(root);else expect(question(root).editable).toBe(true);
});
test('freshness SYNTHETIC later stage amendment is irrelevant',()=>{
 const root=fixture();alterProject(root,p=>p.amendments=[{target:{stage:'post'},at:iso(DRAFT+1)}]);expect(question(root).editable).toBe(true);
});
for(const [name,mutate]of [
 ['wrong signoff target',(p:any)=>p.signoffs.find((s:any)=>s.stage==='rig-review').target.version=99],
 ['missing checkpoint',(p:any)=>delete p.signoffs.find((s:any)=>s.stage==='rig-review').checkpoint],
 ['human bounce',(p:any)=>p.versions[0].verdicts.push({by:'synthetic-control',review:'rig-review',verdict:'rejected',at:iso(DRAFT+1)})],
 ['higher live unaccepted rig',(p:any)=>p.versions.push({...structuredClone(p.versions[0]),n:3,at:iso(DRAFT+1),verdicts:[]})],
] as const)test('currentness SYNTHETIC '+name,()=>{const root=fixture();alterProject(root,mutate);stale(root);});
test('currentness SYNTHETIC extraction non-null checkpoint', () => {
 const root = sceneCurrentnessFixture();
 alterProject(root, project => {
  project.signoffs.find((signoff: any) => signoff.stage === 'rig-review').checkpoint = 'rig';
 });
 stale(root);
});
test('currentness SYNTHETIC extraction undated and future events are excluded',()=>{
 const root=sceneCurrentnessFixture();alterProject(root,p=>{
  const undatedVersion = {...structuredClone(p.versions[0]), n: 3};
  delete undatedVersion.at;
  expect(Object.hasOwn(undatedVersion, 'at')).toBe(false);
  p.versions.push(undatedVersion);
  const futureVersion = {...structuredClone(p.versions[0]), n: 4, at: iso(NOW + 1)};
  expect(Date.parse(futureVersion.at)).toBe(NOW + 1);
  expect(Date.parse(futureVersion.at)).toBeGreaterThan(NOW);
  p.versions.push(futureVersion);
  p.signoffs.push({stage:'rig-review',by:'synthetic-control',checkpoint:null,target:{version:99}});
  p.reopens.push({stage:'rig-review'});p.amendments=[{target:{stage:'rig-review'}}];
 });expect(question(root).editable).toBe(true);
});
for(const offset of [0,1])test('legacy SYNTHETIC cutoff is strict at SINCE offset '+offset,()=>{const root=fixture();legacy(root,offset);stale(root);});
for(const fault of ['bytes','new-scene','reopen','amendment'])test('legacy SYNTHETIC warning cannot hide '+fault,()=>{
 const root=fixture();legacy(root);
 if(fault==='bytes')writeFileSync(join(root,'evidence/scene/s1.json'),'{}');
 else alterProject(root,p=>{
  if(fault==='new-scene')addScene(p,root,SINCE+1000);
  else if(fault==='reopen')p.reopens.push({stage:'post-interview',at:iso(SINCE+1)});
  else p.amendments=[{target:{stage:'post-interview'},at:iso(SINCE+1)}];
 });stale(root);
});

// SYNTHETIC history controls retain distinct records of the same exact set.
function historicalOnly(root:string) {
 const p=json(root,'project.json'),i=item(p);delete i.pending_options;
 i.history=i.history.filter((a:any)=>a.choice?.set?.path==='evidence/interview/review551-scene-current.json');
 i.guide={by:'synthetic-control',at:iso(NOW),verbatim:'Original replacement text\n한글'};
 save(root,'project.json',p);return i.history[0];
}
test('history SYNTHETIC later scene does not rewrite valid answer-time currentness',()=>{
 const root=fixture('writer-history'),answer=historicalOnly(root);alterProject(root,p=>addScene(p,root,DRAFT+2500));
 expect(opened(root).questions.find(q=>q.ref.path===answer.choice.set.path)?.answer).toEqual(answer);
});
test('history SYNTHETIC stale answer reports record name without unreadable-project throw',()=>{
 const root=fixture('writer-history');historicalOnly(root);alterProject(root,p=>{addScene(p,root,DRAFT+2500);item(p).history[0].at=iso(DRAFT+3000);});
 const r=opened(root);expect(diagnostics(r)).toContain('INTERVIEW_OPTIONS_STALE');expect(diagnostics(r)).toContain('post_composition');
 expect(diagnostics(r)).toContain('Use the synthetic post_composition');
});
test('history SYNTHETIC completed delegated decision uses its own at independently from answer at',()=>{
 const root=fixture('writer-history');historicalOnly(root);alterProject(root,p=>{
  addScene(p,root,DRAFT+2500);const a=item(p).history[0];a.delegated=true;a.verbatim='auto';
  const set=json(root,a.choice.set.path),ask=set.asks[0];a.choice.picks=[{ask:ask.id,option_id:'auto',shown:{label:'Auto',effect:'Delegate'}}];
  a.agent_decision={by:'agent',at:iso(DRAFT+3000),reasoning:'Synthetic negative control',covers:ask.id,fragments:[{ask:ask.id,fragment:{framing:'whole synthetic plate'}}],value:{framing:'whole synthetic plate'}};
 });const r=opened(root);expect(diagnostics(r)).toContain('INTERVIEW_OPTIONS_STALE');expect(diagnostics(r)).toContain('agent_decision');expect(diagnostics(r)).toContain('auto');
});
test('history SYNTHETIC pending covers-only delegation invents no decision instant',()=>{
 const root=fixture('writer-history');historicalOnly(root);alterProject(root,p=>{const a=item(p).history[0];a.delegated=true;a.agent_decision={covers:'post_composition'};addScene(p,root,DRAFT+2500);});
 const r=opened(root);expect(diagnostics(r)).not.toContain('INTERVIEW_OPTIONS_STALE');expect(diagnostics(r)).toContain('covers');
});
test('history SYNTHETIC shared set does not deduplicate away a later stale record',()=>{
 const root=fixture('writer-history');historicalOnly(root);alterProject(root,p=>{
  addScene(p,root,DRAFT+2500);const later=structuredClone(item(p).history[0]);later.at=iso(DRAFT+3000);later.verbatim='second historical answer';item(p).history.push(later);
 });const r=opened(root);expect(diagnostics(r)).toContain('INTERVIEW_OPTIONS_STALE');expect(diagnostics(r)).toContain('second historical answer');
});

// #555 guard is checked before the synthetic publication adapter and snapshot writes.
for (const kind of ['historical', 'legacy', 'diagnostics']) test(`standing ${kind} actual prepareJobSource refuses before publication or snapshot (#555 unmet)`, async () => {
 const root = fixture(kind === 'historical' ? 'writer-history' : kind === 'diagnostics' ? 'writer-chain' : 'writer-current');
 if (kind === 'historical') historicalOnly(root);
 if (kind === 'legacy') legacy(root);
 if (kind === 'diagnostics') alterProject(root, project => {
  project.amendments = [{target: {stage: 'post-interview'}, at: '2026-11-06T01:00:45Z'}];
 });
 const inspected = opened(root);
 if (kind === 'historical') expect(inspected.sceneAnswers).toBe(1);
 else {
  expect(inspected.sceneAnswers).toBe(0);
  expect(inspected.diagnostics.some(d => d.code === (kind === 'legacy' ? 'INTERVIEW_OPTIONS_SCENE_LEGACY' : 'INTERVIEW_OPTIONS_STALE'))).toBe(true);
 }
 const before = sealTree(root);
 const request = {result: {path: 'derived/review/v1/out', selector: null}, freeze: {kind: 'producer-held', holdId: 'synthetic-test-held',
  record: {path: 'project.json', sha256: digest(readFileSync(join(root, 'project.json')))}}} as JobPublishRequest;
 const state = join(runtime, 'standing-' + kind);
 mkdirSync(state, {recursive: true}); roots.push(state);
 writeFileSync(join(state, 'existing-state.txt'), 'retained state');
 const stateBefore = sealTree(state);
 let publicationReads = 0, snapshots = 0, error: unknown;
 try {
  await prepareJobSource({root: captureJobRoot(root), stateRoot: state, fingerprint: 'f'.repeat(64), request,
   readPublished: async () => {publicationReads++; throw new Error('Synthetic publication reader must not be reached');},
   afterSnapshot: () => {snapshots++;},
  });
 } catch (caught) {error = caught;}
 expect((error as {code: string}).code).toBe('JOB_RECORD_INCOMPLETE');
 expect((error as Error).message).toBe('JOB_RECORD_INCOMPLETE');
 expect(publicationReads).toBe(0); expect(snapshots).toBe(0);
 expect(sealTree(root)).toEqual(before); expect(sealTree(state)).toEqual(stateBefore);
 expect(readdirSync(state)).toEqual(['existing-state.txt']);
});
test('legacy transport SYNTHETIC nonfatal warning survives actual GET /api/interview',async()=>{
 const root=fixture();legacy(root);const output='review551-picks';mkdirSync(join(root,output));
 const routes=interviewRoutes(root,output,'test-capability');
 const response=await routes(new Request('http://127.0.0.1:19484/api/interview',{headers:{'X-Review-Capability':'test-capability'}}),'http://127.0.0.1:19484');
 expect(response?.status).toBe(200);expect(diagnostics(await response!.json())).toContain('INTERVIEW_OPTIONS_SCENE_LEGACY');
});

test('bar4 SYNTHETIC a new rig-kind draft uses the later rig when previous scene currentness fails',()=>{
 const root=fixture();const {p,set,ref}=active(root);rig3(p);
 const original=json(root,'evidence/interview/post_composition.json');
 set.context={...original.context,rig_version:3,signoff_at:p.signoffs.at(-1).at,config:p.versions.at(-1).provenance.config};
 set.drafted_at=iso(DRAFT+2000);rewriteSet(root,p,set,ref.path);
 expect(question(root).editable).toBe(true);
});
test('currentness SYNTHETIC no live post is needed for the scene option context',()=>{
 const root=fixture();alterProject(root,p=>{p.versions=p.versions.filter((v:any)=>v.kind!=='post');p.signoffs=p.signoffs.filter((s:any)=>s.stage!=='direction-review');});
 expect(question(root).editable).toBe(true);
});
test('time SYNTHETIC scene context must also equal the context at draft time',()=>{
 const root=fixture();const {p,set,ref}=active(root);set.drafted_at='2026-11-06T01:00:56Z';
 p.reopens=[];p.signoffs=p.signoffs.filter((s:any)=>s.stage!=='post-interview');rewriteSet(root,p,set,ref.path);stale(root);
});
test('codec SYNTHETIC context reference itself is closed',()=>{
 const root=fixture(),{p,set,ref}=active(root);set.context.scene.extra='not allowed';rewriteSet(root,p,set,ref.path);stale(root);
});
for(const [path,keys]of [
 [[],['schema','n','rig','frame','plates','layers']],
 [['rig'],['version','acceptance','model','animation']],
 [['rig','animation'],['name']],
 [['rig','animation','frames'],['path','sha256']],
 [['rig','model'],['path','sha256']],
 [['rig','acceptance'],['signoff','verdict','review_package']],
 [['rig','acceptance','signoff'],['stage','checkpoint','at']],
 [['rig','acceptance','review_package'],['path','sha256']],
 [['frame'],['space','stage']],
 [['frame','stage'],['x','y','width','height']],
 [['plates',0],['role','path','sha256','width','height','rect','registered']],
 [['plates',0,'rect'],['x','y','width','height']],
 [['plates',0,'registered'],['kind','ref']],
] as [Array<string|number>,string[]][])for(const key of keys)test(`codec SYNTHETIC required ${path.join('.')||'document'}.${key}`,()=>{
 const root=fixture();sceneMutation(root,s=>{
  s.rig.animation.frames={path:'inputs/background.png',sha256:s.plates[0].sha256};
  let target=s;for(const part of path)target=target[part];delete target[key];
 });stale(root);
});
test('history SYNTHETIC malformed historical scene is a named per-record issue, not unreadable project',()=>{
 const root=fixture('writer-history');historicalOnly(root);writeFileSync(join(root,'evidence/scene/s1.json'),'{}');
 const r=opened(root);expect(diagnostics(r)).toContain('INTERVIEW_OPTIONS_STALE');expect(diagnostics(r)).toContain('post_composition');
});
test('history SYNTHETIC valid completed decision retains its own instant and original human text',()=>{
 const root=fixture('writer-history');historicalOnly(root);alterProject(root,p=>{
  const a=item(p).history[0];a.delegated=true;a.verbatim='auto original human text';
  a.agent_decision={by:'agent',at:iso(DRAFT+1200),reasoning:'Synthetic decision-time control',covers:'post_composition',fragments:[{ask:'post_composition',fragment:{framing:'whole synthetic plate'}}],value:{framing:'whole synthetic plate'}};
  addScene(p,root,DRAFT+2500);
 });const r=opened(root);expect(diagnostics(r)).not.toContain('INTERVIEW_OPTIONS_STALE');expect(diagnostics(r)).toContain('auto original human text');expect(diagnostics(r)).toContain(iso(DRAFT+1200));
});

test('standing SYNTHETIC current editable scene reaches publication lookup without diagnostic metadata on questions', async () => {
 const root = sceneCurrentnessFixture();
 // Explicit test clock for the normal job-source read, whose default is Date.now.
 const {setSystemTime} = await import('bun:test');
 const state = join(runtime, 'standing-current'); mkdirSync(state); roots.push(state);
 const before = sealTree(state);
 const request = {result: {path: 'derived/review/v1/out', selector: null}, freeze: {kind: 'producer-held', holdId: 'synthetic-test-held',
  record: {path: 'project.json', sha256: digest(readFileSync(join(root, 'project.json')))}}} as JobPublishRequest;
 const sentinel = new Error('Synthetic publication lookup reached');
 let reads = 0, caught: unknown;
 try {
  setSystemTime(new Date(NOW));
  const result = readProject(root);
  expect(result.diagnostics).toEqual([]); expect(result.sceneAnswers).toBe(0);
  expect(Object.keys(result.questions[0]!).sort()).toEqual(['answer', 'editable', 'hasParts', 'images', 'ref', 'set']);
  await prepareJobSource({root: captureJobRoot(root), stateRoot: state, fingerprint: 'f'.repeat(64), request,
   readPublished: async () => {reads++; throw sentinel;},
  });
 } catch (error) {caught = error;} finally {setSystemTime();}
 expect(caught).toBe(sentinel); expect(reads).toBe(1); expect(sealTree(state)).toEqual(before);
});
test('history SYNTHETIC unavailable retained set preserves its original answer source, time and set binding', () => {
 const root = fixture('writer-history'), answer = historicalOnly(root);
 writeFileSync(join(root, answer.choice.set.path), '{}');
 const result = opened(root);
 expect(result.diagnostics.some(d => d.code === 'INTERVIEW_OPTIONS_STALE' && d.ref.path === answer.choice.set.path)).toBe(true);
 expect(result.historical.find(record => record.ref?.path === answer.choice.set.path)?.answer).toEqual(answer);
});
test('legacy transport SYNTHETIC historical issues keep full original records through actual GET', async () => {
 const root = fixture('writer-history'), answer = historicalOnly(root);
 alterProject(root, project => {addScene(project, root, DRAFT + 2500); item(project).history[0].at = iso(DRAFT + 3000);});
 const output = 'review551-picks'; mkdirSync(join(root, output));
 const route = interviewRoutes(root, output, 'test-capability');
 const response = await route(new Request('http://127.0.0.1:19484/api/interview'), 'http://127.0.0.1:19484');
 expect(response?.status).toBe(200);
 const body = await response!.json();
 expect(body.diagnostics.some((d: any) => d.code === 'INTERVIEW_OPTIONS_STALE' && d.record.includes('history'))).toBe(true);
 const retained = body.questions.find((q: any) => q.ref.path === answer.choice.set.path);
 expect(retained.answer.verbatim).toBe(answer.verbatim); expect(retained.answer.source).toBe(answer.source);
 expect(retained.answer.at).toBe(iso(DRAFT + 3000)); expect(retained.ref).toEqual(answer.choice.set);
});
