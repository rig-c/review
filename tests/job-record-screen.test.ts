import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {fixturePublication} from './helpers/job-window-fixture.ts';
import {parseManifest} from '../src/manifest.ts';
import {jobHash} from '../src/job-api.ts';
import {expect,test} from 'bun:test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createJobRigScreen} from '../web/job-rig-screen.ts';
import type {InterviewDisplayQuestion} from '../web/interview-panel.ts';
import {rigHost,setRigHost} from '../web/rig-host.ts';
import {createJobFormDrafts,createJobFormHelpers,formFor,jobCheckpointContext,jobPublicationRoutes,prepareJobForms,prepareJobInspection,type JobFormDependencies} from '../web/job-session.ts';
import {JOB_API_V3_SCHEMA,jobRawActMediaType,type ActV3,type DisplayPublicationV3,type JobFileIdentity,type PendingAskV3,type RecordSignoffStage,type UISubmissionV3} from '../src/job-contract.ts';
import {optionSetsJobFixture,recordScreenDom,recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {rigPictureCases,SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE,SYNTHETIC_RIG_ROOT,type PostPictureCase} from './helpers/job-record-fixture.ts';

async function harness(picture:boolean|'parts'=false,capability:string|null='fixture',kind:'checkpoint'|'interview-picks'|'signoff'='checkpoint',boundParts=false,signoffStage?:RecordSignoffStage,postPicture?:PostPictureCase){
 const f=await recordScreenFixture(kind,picture,undefined,signoffStage,boundParts,true,undefined,false,false,postPicture),dom=await recordScreenDom();dom.set('location',{origin:f.origin});
 const state={pending:[f.ask] as PendingAskV3[],receipt:null as {publicationId:string;pageId:string;displayedNonce:string}|null,generation:f.display.publication.generation,preparing:false,closed:false};
 const submitted:UISubmissionV3[]=[],store=new Map<string,string>();
 const node=((tag:string,key?:string)=>{const value=dom.document.createElement(tag);if(key)value.textContent=key;return value;}) as JobFormDependencies['node'];
 let screen:ReturnType<typeof createJobRigScreen>;
 const drafts=createJobFormDrafts({jobId:f.session.jobId,current:()=>screen.mounted()?.record?.inspection??null,forms:()=>screen.mounted()?.record?.forms??new Map(),storage:()=>({setItem:(k,v)=>{store.set(k,v);}})});
 const deps:JobFormDependencies={node,translate:key=>key,helpers:{...createJobFormHelpers(node,key=>key),jobCheckpointContext,assertJobAskSource:(ask,display)=>{prepareJobForms(display,[ask],()=>null);}},draftStorage:()=>({getItem:k=>store.get(k)??null}),...drafts,access:{capability},pageId:'fixture-page',window:{state:()=>state,submit:async input=>{submitted.push(input);return {ok:false,error:{code:'JOB_ACT_INVALID',message:'fixture refusal'}};}}};
 const reads:string[]=[];
 const options:Parameters<typeof createJobRigScreen>[0]={host:{classList:{remove(){}},replaceChildren(){}} as unknown as HTMLElement,pageId:deps.pageId,access:{capability,headers:()=>new Headers(capability?{'X-Review-Capability':capability}:{})},window:deps.window,formDependencies:deps,
  readPublication:async id=>{reads.push(id);const value=f.fake.publications.get(id);return value?{ok:true,value}:{ok:false,error:{code:'JOB_PUBLICATION_UNKNOWN',message:'unknown'}};},
  routes:display=>jobPublicationRoutes(display,f.origin),translate:key=>key,refusal:error=>error instanceof Error?error.message:String(error),
  async load(){rigHost()!.attach({stage:()=>null,redraw(){},message(){},recordForms(){}});rigHost()!.displayed();}};screen=createJobRigScreen(options);
 return {f,dom,state,deps,screen,options,reads,submitted,store,async close(){screen.mounted()?.record?.inspection.dispose();setRigHost(null);dom.restore();await f.close();}};
}

test('#750 record backdrop rejects every mutation, including a parts backdrop submitParts',async()=>{
 const h=await harness(true);try{
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);expect(ready?.record?.picture).toBeTruthy();
  Object.assign(ready!.record!.picture!,{parts:{sourceHash:'synthetic-parts'}});
  h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);
  const host=rigHost()!;expect(host.subject).toBe('parts');expect(host.access.capability).toBeNull();expect(host.access.headers().has('X-Review-Capability')).toBe(false);
  await expect(host.submitParts!([])).rejects.toThrow('JOB_REVIEW_READ_ONLY');
  await expect(host.submit({} as never,()=>{})).rejects.toThrow('JOB_REVIEW_READ_ONLY');
  for(const method of ['POST','PUT','PATCH','DELETE'])await expect(host.read('/api/stage-parts/verdict',method)).rejects.toThrow('JOB_REVIEW_READ_ONLY');
  expect(h.submitted).toHaveLength(0);
 }finally{await h.close();}
});

test('#750 latest picture loads despite incompatible historical pending asks and an intervening record',async()=>{
 const h=await harness(true);try{
  const picture=h.f.backdrop!,middle=structuredClone(h.f.display),current=structuredClone(h.f.display);
  Object.assign(middle.publication,{publicationId:'middle',generation:3,previousPublicationId:picture.publication.publicationId});
  for(const key of ['entry','apiBase','assetsBase'] as const)(middle.routes as any)[key]=middle.routes[key].replace(current.publication.publicationId,'middle');
  Object.assign(current.publication,{generation:4,previousPublicationId:'middle'});h.f.fake.publications.set('middle',middle);
  h.state.pending.push({askId:'old-unsupported',publicationId:picture.publication.publicationId,source:picture.publication.source,status:'pending',subject:{kind:'signoff',stage:'plan-approved'}});
  const ready=await h.screen.prepare(current,new AbortController().signal);
  expect(ready!.record!.picture!.display.publication.publicationId).toBe(picture.publication.publicationId);
  expect(h.reads).toEqual(['middle',picture.publication.publicationId]);ready!.record!.inspection.dispose();
 }finally{await h.close();}
});

for(const mutant of ['foreign-job','cycle','generation','source','cancel-before','cancel-during'] as const)test('#750 bounded history refusal: '+mutant,async()=>{
 const h=await harness(true);try{
  const current=structuredClone(h.f.display),picture=h.f.backdrop!,candidate=structuredClone(picture),abort=new AbortController();
  if(mutant==='foreign-job')for(const key of ['entry','apiBase','assetsBase'] as const)(candidate.routes as any)[key]=candidate.routes[key].replace('/jobs/'+h.f.session.jobId+'/','/jobs/another-job/');
  if(mutant==='cycle')(current.publication as any).previousPublicationId=current.publication.publicationId;
  if(mutant==='generation')(candidate.publication as any).generation=current.publication.generation;
  if(mutant==='source')(candidate.publication.source as any).package.id='different-source';
  h.f.fake.publications.set(picture.publication.publicationId,candidate);
  if(mutant==='cancel-before')abort.abort();
  if(mutant==='cancel-during')h.f.fake.publications.get=(()=>{abort.abort();return candidate;}) as typeof h.f.fake.publications.get;
  await expect(h.screen.prepare(current,abort.signal)).rejects.toThrow(mutant.startsWith('cancel')?'JOB_PRELOAD_CANCELLED':'JOB_DISPLAY_MISMATCH');
  expect(h.reads.length).toBeLessThanOrEqual(1);expect(h.screen.mounted()).toBeNull();
 }finally{await h.close();}
});

test('#750 no picture, receipt rearm, new ask, dirty form identity and closed submit refusal',async()=>{
 const h=await harness();try{
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);expect(ready?.record?.picture).toBeNull();h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);
  const entry=ready!.record!.forms.get(h.f.ask.askId)!;expect(entry.fieldset.disabled).toBe(true);
  h.state.receipt={publicationId:h.f.ask.publicationId,pageId:h.deps.pageId,displayedNonce:'first'};h.screen.changed(h.state);expect(entry.fieldset.disabled).toBe(false);
  expect(entry.form.querySelector('textarea')).toBeNull();
  entry.form.commentWords=()=> '[general]\nretained reviewer words';entry.form.oninput!({} as never);
  const saved=[...h.store.values()][0]!;expect(saved).toContain('retained reviewer words');
  h.state.preparing=true;h.screen.changed(h.state);expect(entry.fieldset.disabled).toBe(true);
  h.state.preparing=false;h.state.receipt={publicationId:h.f.ask.publicationId,pageId:h.deps.pageId,displayedNonce:'rearmed'};
  h.state.pending.push({...h.f.ask,askId:'later-checkpoint'},{...h.f.ask,askId:'ignored-signoff',subject:{kind:'signoff',stage:'plan-approved'}},{...h.f.ask,askId:'ignored-reopen',subject:{kind:'reopen',stage:'plan-approved'}});h.screen.changed(h.state);
  expect(ready!.record!.forms.size).toBe(2);expect(ready!.record!.forms.has('ignored-signoff')).toBe(false);expect(ready!.record!.forms.has('ignored-reopen')).toBe(false);expect(ready!.record!.forms.get(h.f.ask.askId)).toBe(entry);expect(entry.read()).toMatchObject({words:'[general]\nretained reviewer words'});expect(entry.fieldset.disabled).toBe(false);
  const restored=formFor(h.f.ask,ready!.record!.inspection,h.deps);restored.form.commentWords=entry.form.commentWords;expect(restored.read()).toEqual(entry.read());
  h.state.closed=true;h.screen.changed(h.state);expect(entry.fieldset.disabled).toBe(true);await entry.form.onsubmit!({preventDefault(){}} as never);expect(h.submitted).toHaveLength(0);
 }finally{await h.close();}
});

test('#989 and #1228 a publication resumed with historical pending reopen and signoff asks plus a checkpoint ask loads, shows only the checkpoint form and submits it',async()=>{
 const h=await harness();try{
  const checkpointAsk=h.f.ask;
  const signoffAsk:PendingAskV3={...h.f.ask,askId:'ask-signoff',subject:{kind:'signoff',stage:'plan-approved'}};
  const reopenAsk:PendingAskV3={...h.f.ask,askId:'ask-reopen',subject:{kind:'reopen',stage:'plan-approved'}};
  h.state.pending=[reopenAsk,signoffAsk,checkpointAsk];
  let mountedForms:readonly HTMLElement[]=[];
  h.options.load=async()=>{rigHost()!.attach({stage:()=>null,redraw(){},message(){},recordForms(forms){mountedForms=forms;}});rigHost()!.displayed();};
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);
  expect([...ready!.record!.forms.keys()]).toEqual([checkpointAsk.askId]);
  h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);
  h.state.receipt={publicationId:checkpointAsk.publicationId,pageId:h.deps.pageId,displayedNonce:'resumed-nonce'};
  h.screen.changed(h.state);
  expect(ready!.record!.forms.size).toBe(1);
  expect(ready!.record!.forms.has('ask-reopen')).toBe(false);
  expect(ready!.record!.forms.has('ask-signoff')).toBe(false);
  expect(mountedForms).toHaveLength(1);
  const entry=ready!.record!.forms.get(checkpointAsk.askId)!;
  expect(entry.fieldset.disabled).toBe(false);
  entry.form.querySelector<HTMLSelectElement>('select[name=outcome]')!.value='pass';
  entry.form.commentWords=()=>'[general]\ncheckpoint on resumed job';
  await entry.form.onsubmit!({preventDefault(){}} as never);
  expect(h.submitted).toEqual([{
   kind:'checkpoint',
   publicationId:checkpointAsk.publicationId,
   askId:checkpointAsk.askId,
   pageId:h.deps.pageId,
   displayedNonce:'resumed-nonce',
   expectedGeneration:h.state.generation,
   submissionId:entry.submissionId,
   value:{checkpointId:(checkpointAsk.subject as {checkpointId:string}).checkpointId,outcome:'pass',words:'[general]\ncheckpoint on resumed job'},
  }]);
 }finally{await h.close();}
});

test('#1228 a publication declaring signoff shows no form and no error on record, surfaces JOB_ASK_UNSUPPORTED on a model ask, and replays historical signoff acts byte-exact', async () => {
 const {parseRecordAct} = await import('../src/job-api.ts');
 const {matchesJobRecordAct, isPendingOwnerAsk} = await import('../web/job-session.ts');
 const h = await harness(true, 'fixture', 'signoff', false, 'direction-review');
 try {
  expect(isPendingOwnerAsk(h.f.ask)).toBe(false);
  // 1) Record publication carrying a sign-off subject: once with no ask sent, once with a pending signoff ask.
  for (const pending of [[] as PendingAskV3[], [h.f.ask]]) {
   h.state.pending = [...pending];
   let mountedForms: readonly HTMLElement[] = [];
   const messages: [string, boolean | undefined][] = [];
   h.options.load = async () => {
    rigHost()!.attach({stage: () => null, redraw() {}, message(text, error) {messages.push([text, error]);}, recordForms(forms) {mountedForms = forms;}});
    rigHost()!.displayed();
   };
   const ready = await h.screen.prepare(h.f.display, new AbortController().signal);
   expect(ready!.refusal).toBeUndefined();
   expect(ready!.record!.forms.size).toBe(0);
   expect(ready!.record!.picture).not.toBeNull();
   const tx = h.screen.commit(ready!);
   await h.screen.painted(ready!, new AbortController().signal);
   tx.finalize();
   expect(mountedForms).toEqual([]);
   expect(messages.filter(([, error]) => error)).toEqual([]);
   expect(rigHost()!.record?.hasPicture).toBe(true);
   ready!.record!.inspection.dispose();
  }
  // 2) Production-shaped rig publication: once without signoff ask (viewer + comment-only act@10 ready), once with a producer still sending signoff ask (named refusal JOB_ASK_UNSUPPORTED, not a broken page).
  const picture = h.f.backdrop!;
  h.state.pending = [];
  const cleanRig = await h.screen.prepare(picture, new AbortController().signal);
  expect(cleanRig!.refusal).toBeUndefined();
  const cleanTx = h.screen.commit(cleanRig!);
  await h.screen.painted(cleanRig!, new AbortController().signal);
  cleanTx.finalize();
  expect(typeof rigHost()!.submitComments).toBe('function');
  expect(rigHost()!.verdictComments?.available()).toBe(true);
  const staleProducerAsk: PendingAskV3 = {askId: 'producer-signoff', publicationId: picture.publication.publicationId, source: picture.publication.source, status: 'pending', subject: {kind: 'signoff', stage: 'plan-approved'}};
  h.state.pending = [staleProducerAsk];
  const refusedRig = await h.screen.prepare(picture, new AbortController().signal);
  expect(refusedRig!.refusal).toBe('JOB_ASK_UNSUPPORTED');
  const refusedTx = h.screen.commit(refusedRig!);
  await h.screen.painted(refusedRig!, new AbortController().signal);
  refusedTx.finalize();
  expect(rigHost()!.unavailable).toBe('JOB_ASK_UNSUPPORTED');
  // 3) Fresh signoff submissions refuse JOB_ACT_KIND_DISABLED, while historical signoff act@4 still reads and replays byte for byte.
  const refused = await h.f.ports.commitUIAct(h.f.session.jobId, new Request(h.f.origin + '/ui/acts', {
   method: 'POST',
   body: JSON.stringify({
    kind: 'signoff', publicationId: h.f.ask.publicationId, askId: h.f.ask.askId,
    pageId: 'historical-page', displayedNonce: 'historical-nonce',
    expectedGeneration: h.f.display.publication.generation, submissionId: 'fresh-signoff',
    value: {stage: 'direction-review', decision: 'approved', words: '[general]\nFresh approval'},
   }),
  }));
  expect(refused).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
  if (h.f.ask.source.subject !== 'plan') throw new Error('Expected plan source');
  const {directionReview: _summary, ...binding} = h.f.ask.source;
  const historical: ActV3 = {
   schema: 'rig-review/act@4', actId: 'act-historical-signoff', jobId: h.f.session.jobId,
   askId: h.f.ask.askId, publicationId: h.f.ask.publicationId, kind: 'signoff',
   authority: {actor: 'human', channel: 'review-ui', reviewer: {id: 'synthetic-owner', role: 'owner'}},
   at: '2026-11-08T12:00:00.000Z',
   source: binding,
   value: {stage: 'direction-review', decision: 'approved', words: '[general]\nHistorical approval'},
  };
  const storedBytes = JSON.stringify(historical);
  expect(JSON.stringify(parseRecordAct(JSON.parse(storedBytes)))).toBe(storedBytes);
  expect(matchesJobRecordAct(h.f.ask, historical, h.f.session.jobId)).toBe(true);
 } finally {
  await h.close();
 }
});

test('#750 record metadata mismatch refuses',async()=>{
 const h=await harness(),original=globalThis.fetch;try{
  globalThis.fetch=(async(input,init)=>{const response=await original(input,init);if(String(input).endsWith('/api/review')){const body=await response.json();body.sourceHash='f'.repeat(64);return Response.json(body);}return response;}) as typeof fetch;
  await expect(h.screen.prepare(h.f.display,new AbortController().signal)).rejects.toThrow('JOB_DISPLAY_MISMATCH');
 }finally{globalThis.fetch=original;await h.close();}
});

test('#750 missing record form dependencies refuse before legacy fallback',async()=>{
 const h=await harness();try{const screen=createJobRigScreen({...h.options,formDependencies:undefined});await expect(screen.prepare(h.f.display,new AbortController().signal)).rejects.toThrow('JOB_ACT_KIND_DISABLED');expect(screen.mounted()).toBeNull();}finally{await h.close();}
});

test('#774 all shared publications keep one stream; cancellation never mounts another screen',async()=>{
 const source=await readFile(new URL('../web/job-session.ts',import.meta.url),'utf8');
 const start=source.indexOf('export async function mountJobScreen(');
 const body=source.slice(start).replace('export async function mountJobScreen','async function mountJobScreen').replace("await import('./i18n.ts')",'i18nDouble');
 const run=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(body)};return mountJobScreen;}`);
 for(const mounted of [false,true]){
  let adapter:any,streams=0,aborted=false,paints=0,reports=0,changed=0;const notices:string[]=[];let notice:any;
  const prepared={},controller=new AbortController();
  const environment={enCatalog,koCatalog,document:{createElement:()=>notice=({dataset:{},setAttribute(){}})},sessionStorage:{},localStorage:{},location:{href:'http://127.0.0.1/jobs/fixture/',origin:'http://127.0.0.1'},history:{replaceState(){}},crypto,AbortController,URL,
   jobWindowAccess:()=>({jobId:'fixture'}),i18nDouble:{onLanguageChange:()=>()=>{}},t:(key:string)=>key,createJobFormHelpers:()=>({}),createJobFormDrafts:()=>({saveDraft(){}}),createJobWindowTransport:()=>({}),
   createJobRigScreen:()=>({waiting:async()=>{},mounted:()=>mounted?prepared:null,prepare:async()=>prepared,changed(){changed++;},report(){reports++;},painted:async()=>{paints++;}}),
   createJobWindow:(options:any)=>{adapter=options.adapter;return {stop(){aborted=true;},state:()=>({}),event(){}};},startJobWindowEvents:()=>{streams++;return {done:Promise.resolve(),displayed(){}};},
   assertJobAskSource(){},jobCheckpointContext,jobPublicationRoutes,jobWindowRefusal:String,globalThis:{addEventListener(){},removeEventListener(){}},JOB_HUB_READY:'ready',jobHubMessageMatches(){}};
  const stop=await run(environment)({append(){notices.push('append');},prepend(){notices.push('prepend');},querySelectorAll:()=>[]});
  expect(await adapter.prepare({},controller.signal)).toBe(prepared);await adapter.painted(prepared,controller.signal);expect(paints).toBe(1);
  adapter.changed({error:'fixture load failure'});expect(changed).toBe(1);expect(reports).toBe(mounted?0:0);expect(notices).toEqual(mounted?[]:['prepend']);
  if(!mounted){expect(notice.title).toBe('JOB_WINDOW_FAILED');adapter.changed({error:new Error('JOB_CAPABILITY_REQUIRED')});expect(notice.title).toBe('JOB_CAPABILITY_LINK_LOST');adapter.changed({error:'JOB_STREAM_FAILED'});expect(notice.title).toBe('JOB_STREAM_FAILED');}
  controller.abort();await adapter.painted(prepared,controller.signal);expect(paints).toBe(1);
  stop();expect(aborted).toBe(true);await adapter.painted(prepared,new AbortController().signal);expect(paints).toBe(1);expect(streams).toBe(1);stop();
 }
});

test('#750 deterministic interview writer persists inline Other and note at a valid past timestamp',async()=>{
 const f=await recordScreenFixture('interview-picks');try{
  const result=await f.ports.commitUIAct(f.session.jobId,new Request(f.origin+'/ui/acts',{method:'POST',body:JSON.stringify({kind:'interview-picks',publicationId:f.ask.publicationId,askId:f.ask.askId,pageId:'page',displayedNonce:'nonce',expectedGeneration:f.display.publication.generation,submissionId:'submission',value:{questionId:(f.ask.subject as {questionId:string}).questionId,selections:[{itemId:'topology',optionId:'topology_other',otherText:'  original Other\n'},{itemId:'detail_level',optionId:'density_high',otherText:null}],note:'  original note\n'}})}));
  expect(result.ok).toBe(true);const stored=JSON.parse(await readFile(f.files[0]!,'utf8'));expect(stored.at).toBe('2026-11-08T12:00:00.000Z');expect(stored.value.note).toBe('  original note\n');expect(stored.value.selections[0].otherText).toBe('  original Other\n');
 }finally{await f.close();}
});


test('#750 interview publication follows a genuinely retained picture before pending options',async()=>{
 const f=await recordScreenFixture('interview-picks',true);try{
  expect(f.display.publication.previousPublicationId).toBe(f.backdrop!.publication.publicationId);expect(f.display.publication.source.subject).toBe('option-set');
  const picture=f.session.retainedSourceV3(f.backdrop!.publication.publicationId);expect('record' in picture.source).toBe(false);expect((await f.metadata()).recordSource).toEqual(f.display.publication.source);
 }finally{await f.close();}
});


for(const picture of [false,true])test('#743 record host never inherits navigation or verdict status; picture='+picture,async()=>{
 const h=await harness(picture);try{
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);const tx=h.screen.commit(ready!);
  await h.screen.painted(ready!,new AbortController().signal);tx.finalize();
  expect(rigHost()!.record?.hasPicture).toBe(picture);expect(rigHost()!.navigation).toBeUndefined();expect(rigHost()!.reviewState).toBeUndefined();
 }finally{await h.close();}
});

test('#743 record inspection lifetime follows ack finalization; rollback retains old forms and navigation does not cross record boundary',async()=>{
 const h=await harness(true);try{
  h.options.load=async()=>{rigHost()!.attach({stage:()=>null,redraw(){},message(){},recordForms(){},navigation:()=>({subject:'rig',bookmark:{time:9}} as never)});rigHost()!.displayed();};
  const first=await h.screen.prepare(h.f.display,new AbortController().signal);let oldDisposed=0;
  const close=first!.record!.inspection.dispose.bind(first!.record!.inspection);first!.record!.inspection.dispose=()=>{oldDisposed++;close();};
  let tx=h.screen.commit(first!);await h.screen.painted(first!,new AbortController().signal);tx.finalize();
  const oldForms=first!.record!.forms,entry=oldForms.get(h.f.ask.askId)!;let formDisposed=0;
  const disposeForm=entry.dispose;entry.dispose=()=>{formDisposed++;disposeForm?.();};
  const candidate=await h.screen.prepare(h.f.display,new AbortController().signal);tx=h.screen.commit(candidate!);await h.screen.painted(candidate!,new AbortController().signal);
  expect(oldDisposed).toBe(0);await tx.rollback();candidate!.record!.inspection.dispose();
  expect(h.screen.mounted()).toBe(first);expect(first!.record!.forms).toBe(oldForms);expect(oldForms.get(h.f.ask.askId)).toBe(entry);expect(oldDisposed).toBe(0);expect(formDisposed).toBe(0);
  const picture=first!.record!.picture!;tx=h.screen.commit(picture);await h.screen.painted(picture,new AbortController().signal);
  expect(rigHost()!.navigation).toBeUndefined();expect(typeof rigHost()!.reviewState).toBe('function');expect(oldDisposed).toBe(0);
  tx.finalize();expect(oldDisposed).toBe(1);expect(formDisposed).toBe(1);expect(h.screen.mounted()).toBe(picture);
 }finally{await h.close();}
});

test('#743 picture modal forms survive rollback and dispose with their inspection only after finalization',async()=>{
 const h=await harness(true);try{
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal),record=ready!.record!;
  // Reuse real prepared forms and inspection to exercise the internal modal ownership seam.
  const modal={...record.picture!,modals:{inspection:record.inspection,forms:record.forms}};
  let inspectionDisposed=0,formDisposed=0;
  const close=record.inspection.dispose.bind(record.inspection);record.inspection.dispose=()=>{inspectionDisposed++;close();};
  const entry=record.forms.get(h.f.ask.askId)!,disposeForm=entry.dispose;entry.dispose=()=>{formDisposed++;disposeForm?.();};
  h.screen.commit(modal).finalize();
  let tx=h.screen.commit(record.picture!);expect(inspectionDisposed).toBe(0);expect(formDisposed).toBe(0);
  await tx.rollback();expect(h.screen.mounted()).toBe(modal);expect(modal.modals.forms.get(h.f.ask.askId)).toBe(entry);
  expect(inspectionDisposed).toBe(0);expect(formDisposed).toBe(0);
  tx=h.screen.commit(record.picture!);expect(inspectionDisposed).toBe(0);tx.finalize();
  expect(inspectionDisposed).toBe(1);expect(formDisposed).toBe(1);
 }finally{await h.close();}
});

test('#715 a parts-backed record uses the real parts host and source binding',async()=>{
 const h=await harness('parts');try{
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);
  expect(ready?.record?.picture?.parts?.items.map(item=>item.name)).toEqual(['body','front']);
  h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);
  expect(rigHost()!.subject).toBe('parts');expect(rigHost()!.record?.sourceHash).toBe(h.f.display.publication.source.sourceHash);
  const entry=ready!.record!.forms.get(h.f.ask.askId)!;expect(entry.form.querySelector('textarea')).toBeNull();
  entry.form.commentWords=()=> '[general]\nParts record comment';expect(entry.read()).toMatchObject({words:'[general]\nParts record comment'});
 }finally{await h.close();}
});

test('#722 real form saves only checked radios, restores Other with empty contract note without changing option identities',async()=>{
 const f=await recordScreenFixture('interview-picks'),dom=await recordScreenDom();
 let inspection:Awaited<ReturnType<typeof prepareJobInspection>>|undefined;
 try{
  dom.set('location',{origin:f.origin});
  inspection=await prepareJobInspection(f.display,new AbortController().signal);
  // Draft controls are the subject here; the ordinary Nova browser covers the bound-image viewport.
  for(const question of inspection.interview!.questions)question.images=[];
  const store=new Map<string,string>(),forms=new Map<string,ReturnType<typeof formFor>>();
  const node=((tag:string,key?:string)=>{const value=dom.document.createElement(tag);if(key)value.textContent=key;return value;}) as JobFormDependencies['node'];
  const drafts=createJobFormDrafts({jobId:f.session.jobId,current:()=>inspection!,forms:()=>forms,storage:()=>({setItem:(key,value)=>{store.set(key,value);}})});
  const deps:JobFormDependencies={node,translate:key=>key,helpers:{...createJobFormHelpers(node,key=>key),jobCheckpointContext,assertJobAskSource:(ask,display)=>{prepareJobForms(display,[ask],()=>null);}},draftStorage:()=>({getItem:key=>store.get(key)??null}),...drafts,access:{capability:'fixture'},pageId:'page',window:{state:()=>({pending:[f.ask],receipt:null,preparing:false,closed:false,generation:1}),submit:async()=>{throw new Error('No submission in draft test');}}};
  const entry=formFor(f.ask,inspection,deps);forms.set(f.ask.askId,entry);
  expect(entry.form.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden).toBe(false);
  const radios=[...entry.form.querySelectorAll<HTMLInputElement>('input[type=radio]')],identities=radios.map(input=>({name:input.name,value:input.value}));
  for(const input of radios){input.checked=['topology_other','density_auto'].includes(input.value);if(input.checked)input.dispatchEvent(new Event('change'));}
  entry.form.querySelector<HTMLTextAreaElement>('textarea[name="other.topology"]')!.value='  직접 입력\n';
  const noteInput=entry.form.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!;
  expect(noteInput).not.toBeNull();
  expect(noteInput.maxLength).toBe(10000);
  expect(noteInput.getAttribute('maxlength')).toBe('10000');
  expect(entry.form.querySelector(`label[for="${noteInput.id}"]`)?.textContent).toBe('interview.noteLabel');
  expect(noteInput.value).toBe('');
  entry.dirty=true;drafts.saveDraft();
  const saved=JSON.parse(store.get(drafts.localDraftKey(f.display))!);
  expect(saved.forms[0].controls.filter((input:{name:string})=>input.name.startsWith('choice.'))).toEqual([{name:'choice.topology',value:'topology_other'},{name:'choice.detail_level',value:'density_auto'}]);
  const restored=formFor(f.ask,inspection,deps),restoredRadios=[...restored.form.querySelectorAll<HTMLInputElement>('input[type=radio]')];
  expect(restoredRadios.map(input=>({name:input.name,value:input.value}))).toEqual(identities);
  expect(restoredRadios.filter(input=>input.checked).map(input=>input.value)).toEqual(['topology_other','density_auto']);
  expect(restored.form.querySelector<HTMLTextAreaElement>('textarea[name="other.topology"]')!.hidden).toBe(false);
  expect(restored.read()).toEqual(entry.read());
  expect(restored.read()).toEqual({questionId:'rig_type',selections:[{itemId:'topology',optionId:'topology_other',otherText:'  직접 입력\n'},{itemId:'detail_level',optionId:'density_auto',otherText:null}],note:''});
  expect(restored.form.querySelectorAll('select')).toHaveLength(0);
  // #851 review: a finalized answer reads back from its act even when this browser holds a different draft.
  const at=new Date().toISOString();
  const answered={...f.ask,status:'answered',act:{kind:'interview-picks',at,value:{questionId:'rig_type',selections:[{itemId:'topology',optionId:radios.find(input=>input.name==='choice.topology'&&input.value!=='topology_other')!.value,otherText:null},{itemId:'detail_level',optionId:'density_auto',otherText:null}],note:''}}} as any;
  const finalized=formFor(answered,inspection,deps);
  expect([...finalized.form.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(input=>input.checked).map(input=>input.value)).toEqual([answered.act.value.selections[0].optionId,'density_auto']);
  expect(finalized.dirty).toBe(false);
  expect(finalized.form.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden).toBe(true);
  expect(finalized.form.querySelector('textarea[name="note"]')).toBeNull();
  expect(finalized.form.querySelector('.interview-note')).toBeNull();
  restored.form.dataset.interviewAnswered='true';restored.form.dispatchEvent(new Event('change'));
  expect(restored.form.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden).toBe(true);
  expect(restored.form.querySelector('textarea[name="note"]')).toBeNull();
  // #901: a saved non-empty note round-trips into pre.interview-note when answered and accepts up to 10,000 characters.
  const note10000='가'.repeat(5000)+'b'.repeat(5000);
  const answeredWithNote={...answered,act:{...answered.act,value:{...answered.act.value,note:note10000}}};
  const finalizedWithNote=formFor(answeredWithNote,inspection,deps);
  expect(finalizedWithNote.form.querySelector('textarea[name="note"]')).toBeNull();
  expect(finalizedWithNote.form.querySelector('.interview-note')?.textContent).toBe(note10000);
  // #992 Bar 2 & Bar 5: form drafts survive republish of the same job, draft and source hash, and restore from legacy per-publication keys.
  const republishedDisplay:DisplayPublicationV3={...f.display,publication:{...f.display.publication,publicationId:'republished-publication-2',previousPublicationId:f.display.publication.publicationId,generation:f.display.publication.generation+1},routes:{entry:f.display.routes.entry.replace(f.display.publication.publicationId,'republished-publication-2'),apiBase:f.display.routes.apiBase.replace(f.display.publication.publicationId,'republished-publication-2'),assetsBase:f.display.routes.assetsBase.replace(f.display.publication.publicationId,'republished-publication-2')}};
  const republishedAsk:PendingAskV3={...f.ask,askId:'republished-ask-2',publicationId:'republished-publication-2'};
  const republishedRestored=formFor(republishedAsk,{...inspection,display:republishedDisplay},deps);
  expect([...republishedRestored.form.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(input=>input.checked).map(input=>input.value)).toEqual(['topology_other','density_auto']);
  expect(republishedRestored.read()).toEqual(entry.read());
  expect(republishedRestored.dirty).toBe(true);
  const legacySnapshot=store.get(drafts.localDraftKey(f.display))!;
  store.clear();
  store.set('rig-review-job-draft/1:'+f.session.jobId+':'+f.display.publication.publicationId+':'+f.display.publication.source.sourceHash,legacySnapshot);
  const fallbackRestored=formFor(f.ask,inspection,deps);
  expect(fallbackRestored.read()).toEqual(entry.read());
  expect(fallbackRestored.dirty).toBe(true);
  // Same-publication reconnect with an earlier pending ask for the same subject must match exact askId first.
  forms.clear();store.clear();
  const earlierAsk:PendingAskV3={...f.ask,askId:'earlier-unanswered-ask'};
  const activeAsk:PendingAskV3={...f.ask,askId:'active-answered-ask'};
  const earlierEntry=formFor(earlierAsk,inspection,deps);earlierEntry.dirty=true;forms.set(earlierAsk.askId,earlierEntry);
  const activeEntry=formFor(activeAsk,inspection,deps);
  for(const input of activeEntry.form.querySelectorAll<HTMLInputElement>('input[type=radio]')){input.checked=['topology_other','density_auto'].includes(input.value);if(input.checked)input.dispatchEvent(new Event('change'));}
  activeEntry.form.querySelector<HTMLTextAreaElement>('textarea[name="other.topology"]')!.value='Exact ask match';
  activeEntry.dirty=true;forms.set(activeAsk.askId,activeEntry);
  drafts.saveDraft();
  const multiSaved=JSON.parse(store.get(drafts.localDraftKey(f.display))!);
  // Control (c9e6a46): single .find(item => item.askId === ask.askId || item.value?.questionId === subject.questionId) matched earlierAsk at index 0
  const buggyMatch=multiSaved.forms.find((item:{askId:string;value?:{questionId?:string}})=>item.askId===activeAsk.askId||item.value?.questionId==='rig_type');
  expect(buggyMatch.askId).toBe(earlierAsk.askId);
  const activeRestored=formFor(activeAsk,inspection,deps);
  expect(activeRestored.read()).toEqual(activeEntry.read());
 }finally{inspection?.dispose();dom.restore();await f.close();}
});


// HQ 89f85831: projected prose is the label; source identities stay in tooltips.
for (const language of ['en','ko'] as const) for (const rule of [1,2,3,4,5,6]) test(`#756 human text/title rule ${rule} (${language})`,async()=>{
 const i18n=await import('../web/i18n.ts'),preference=i18n.getLanguagePreference(),link=i18n.getLinkLanguage();
 i18n.setLinkLanguage(null);i18n.setLanguagePreference(language);const h=await harness();
 try{
  const prepared=await h.screen.prepare(h.f.display,new AbortController().signal),inspection=prepared!.record!.inspection;
  const source=h.f.ask.source,plan=source.plan!,before=JSON.stringify(source),original=inspection.metadata.planText!;
  if(original.status!=='projected')throw new Error('Expected projected fixture');
  const descriptions=['  Inspect layout <literal> 한글\n','Inspect weights'];
  const projection={...original,steps:original.steps.map((row,index)=>({...row,does:descriptions[index]!,rests_on:[plan.steps[1]!.id,'external producer text',plan.steps[0]!.id],issues:row.issues.filter(issue=>!['does','rests_on'].includes(issue.field))}))};
  inspection.metadata.planText=projection;
  const node=((tag:string,key?:string)=>{const element=h.dom.document.createElement(tag);if(key)element.textContent=i18n.t(key);return element;}) as JobFormDependencies['node'];
  const helpers=createJobFormHelpers(node,i18n.t),deps={...h.deps,node,translate:i18n.t,helpers:{...helpers,jobCheckpointContext,assertJobAskSource:h.deps.helpers.assertJobAskSource}};
  if(rule<=3){
   const list=helpers.planTextList(plan,projection,rule===1?plan.steps[1]!.id:undefined);
   for(const step of plan.steps){expect(list.textContent).not.toContain(step.id);expect(list.textContent).not.toContain(step.hash);}
   expect(list.querySelector('[data-job-plan-field="does"]')).toBeNull();
   const summaries=[...list.querySelectorAll('summary')];
   if(rule===1){expect(summaries).toHaveLength(1);expect(summaries[0]!.textContent).toBe(descriptions[1]!);expect(summaries[0]!.title).toContain(plan.steps[1]!.id);}
   if(rule===2)for(const [index,summary]of summaries.entries()){expect(summary.textContent).toBe(descriptions[index]!);expect(summary.title).toContain(plan.steps[index]!.id);expect(summary.title).toContain(plan.steps[index]!.hash);}
   if(rule===3){const entries=[...list.querySelector('[data-job-plan-field="rests_on"]')!.querySelectorAll('li')];expect(entries.slice(0,3).map(item=>item.textContent)).toEqual([descriptions[1]!,'external producer text',descriptions[0]!]);expect(entries[0]!.title).toBe(plan.steps[1]!.id);expect(entries[2]!.title).toBe(plan.steps[0]!.id);}
  }else if(rule===4){
   const form=formFor(h.f.ask,inspection,deps).form,heading=form.querySelector('h3')!;
   expect(heading.textContent).toBe(descriptions[0]!);expect(heading.title).toBe((h.f.ask.subject as {checkpointId:string}).checkpointId);
   expect(form.textContent).not.toContain(plan.steps[0]!.id);expect(form.textContent).not.toContain(plan.steps[0]!.hash);
  }else if(rule===5){
   expect(()=>formFor({...h.f.ask,subject:{kind:'signoff',stage:'plan-approved'}},inspection,deps)).toThrow('JOB_ACT_KIND_DISABLED');
   expect(()=>formFor({...h.f.ask,subject:{kind:'reopen',stage:'plan-approved'}},inspection,deps)).toThrow('JOB_ACT_KIND_DISABLED');
   expect('job.signoff' in enCatalog).toBe(false);expect('job.signoff' in koCatalog).toBe(false);
   expect('Approve this stage.' in enCatalog).toBe(false);expect('Approve this stage.' in koCatalog).toBe(false);
   expect('job.reopen' in enCatalog).toBe(false);expect('job.reopen' in koCatalog).toBe(false);
   expect('Review the reopened stage.' in enCatalog).toBe(false);expect('Review the reopened stage.' in koCatalog).toBe(false);
  }else{
   const form=formFor(h.f.ask,inspection,deps).form,line=form.querySelector<HTMLElement>('.job-source')!;
   expect(line.textContent).toBe(h.f.display.publication.label);expect(line.title).toBe(source.sourceHash);
   for(const raw of [source.sourceHash,source.projectHash!,...plan.steps.map(item=>item.hash)])expect(form.textContent).not.toContain(raw);
  }
  expect(JSON.stringify(source)).toBe(before);inspection.dispose();
 }finally{await h.close();i18n.setLinkLanguage(link);i18n.setLanguagePreference(preference);}
});

for(const absence of ['absent','invalid','limit','no-issue','no-projection'] as const)test(`#756 missing plan prose uses existing ${absence} copy and refreshes checkpoint headings in place`,async()=>{
 const i18n=await import('../web/i18n.ts'),preference=i18n.getLanguagePreference(),link=i18n.getLinkLanguage();
 i18n.setLinkLanguage(null);i18n.setLanguagePreference('en');const h=await harness();let unbind:(()=>void)|undefined;
 try{
  const prepared=await h.screen.prepare(h.f.display,new AbortController().signal),inspection=prepared!.record!.inspection;
  const checkpointId=(h.f.ask.subject as {checkpointId:string}).checkpointId,plan=h.f.ask.source.plan!;
  const original=inspection.metadata.planText!;if(original.status!=='projected')throw new Error('Expected projected fixture');
  inspection.metadata.planText=absence==='no-projection'?undefined:{...original,steps:original.steps.map((row,index)=>{const {does,issues,...rest}=row;return {...rest,rests_on:[plan.steps[1-index]!.id],issues:[...issues.filter(issue=>!['does','rests_on'].includes(issue.field)),...absence==='no-issue'?[]:[{field:'does' as const,reason:absence as 'absent'|'invalid'|'limit'}]]};})};
  // A historical runtime row can exist without a title, although current manifests require one.
  inspection.metadata.manifest={checkpoints:[{id:checkpointId}]} as NonNullable<typeof inspection.metadata.manifest>;
  const node=((tag:string,key?:string)=>{const element=h.dom.document.createElement(tag);if(key){element.dataset.jobText=key;element.textContent=i18n.t(key);}return element;}) as JobFormDependencies['node'];
  const deps={...h.deps,node,translate:i18n.t,helpers:{...createJobFormHelpers(node,i18n.t),jobCheckpointContext,assertJobAskSource:h.deps.helpers.assertJobAskSource}};
  const form=formFor(h.f.ask,inspection,deps).form,heading=form.querySelector('h3')!,container=h.dom.document.createElement('div');container.append(form);
  inspection.metadata.manifest.checkpoints[0]!.title='Existing human title';const named=formFor(h.f.ask,inspection,deps).form,namedHeading=named.querySelector('h3')!;container.append(named);
  const source=await readFile(new URL('../web/job-session.ts',import.meta.url),'utf8'),subscription=source.split('\n').find(line=>line.includes('const localize=i18n.onLanguageChange('))!;
  expect(subscription).toBeDefined();unbind=new Function('i18n','t','host',new Bun.Transpiler({loader:'ts'}).transformSync(subscription+';return localize;'))(i18n,i18n.t,container);
  for(const language of ['ko','en'] as const){
   i18n.setLanguagePreference(language);const reason=absence==='no-issue'||absence==='no-projection'?'absent':absence,copy=i18n.t('job.plan.field.'+reason);
   expect(form.querySelector('h3')).toBe(heading);expect(heading.textContent).toBe(copy);expect(heading.title).toBe(checkpointId);
   expect(namedHeading.textContent).toBe('Existing human title');expect(namedHeading.title).toBe(checkpointId);
   for(const summary of form.querySelectorAll('summary')){expect(summary.textContent).toBe(copy);expect(summary.title).toContain(plan.steps[0]!.id);expect(summary.title).toContain(plan.steps[0]!.hash);}
   for(const rest of form.querySelector('[data-job-plan-field="rests_on"]')?.querySelectorAll('li')??[]){expect(rest.textContent).toBe(copy);expect(rest.title).toBe(plan.steps[1]!.id);}
   for(const step of plan.steps){expect(form.textContent).not.toContain(step.id);expect(form.textContent).not.toContain(step.hash);}
  }
  inspection.dispose();
 }finally{unbind?.();await h.close();i18n.setLinkLanguage(link);i18n.setLanguagePreference(preference);}
});

for(const picture of [true,'parts'] as const)for(const capability of ['fixture',null])test(`#756 ${picture} backdrop keeps source denial separate from ${capability?'owner':'copied-link'} act authority`,async()=>{
 const {readOnlyReason,readOnlyMessage}=await import('../web/instance-access.ts');const h=await harness(picture,capability);
 try{
  const prepared=await h.screen.prepare(h.f.display,new AbortController().signal);h.screen.commit(prepared!);await h.screen.painted(prepared!,new AbortController().signal);
  const host=rigHost()!;expect(host.access.capability).toBeNull();expect(host.access.headers().has('X-Review-Capability')).toBe(false);
  expect(host.ownerActAccess?.capability).toBe(capability);expect(readOnlyReason(host.access,null,host.ownerActAccess)).toBeNull();
  expect(readOnlyReason(host.access,true,host.ownerActAccess)).toBe(capability?null:readOnlyMessage);
  h.state.receipt={publicationId:h.f.ask.publicationId,pageId:h.deps.pageId,displayedNonce:'ready'};h.screen.changed(h.state);
  const entry=prepared!.record!.forms.get(h.f.ask.askId)!;expect(entry.fieldset.disabled).toBe(!capability);
  entry.form.querySelector<HTMLSelectElement>('select[name=outcome]')!.value='pass';await entry.form.onsubmit!({preventDefault(){}} as never);
  expect(h.submitted).toHaveLength(capability?1:0);
  for(const method of ['POST','PUT','PATCH','DELETE'])await expect(host.read('/api/stage-parts/verdict',method)).rejects.toThrow('JOB_REVIEW_READ_ONLY');
  expect(host.access.headers().has('X-Review-Capability')).toBe(false);
 }finally{await h.close();}
});

test('#784 model-less reference checkpoint survives preparation, receipt rearm and later ask refresh',async()=>{
 const h=await harness();
 try{
  const base=fixturePublication(),original=base.publication.source;
  const source={...original,model:null,selector:null,plan:{steps:[{id:'step-one',hash:'1'.repeat(64)}]}};
  const display={...base,publication:{...base.publication,source}} as DisplayPublicationV3,bytes=new Uint8Array([1,2,3]);
  const manifest=parseManifest({schema:'rig-review/1',...source.package,title:'Reference-only',references:[{id:'photo',type:'image',label:'Photo',path:'photo.png'}],checkpoints:[{id:'photo-check',title:'Check photo',reference:'photo'}]});
  const ask={askId:'photo-check',publicationId:base.publication.publicationId,status:'pending',source,subject:{kind:'checkpoint',checkpointId:'photo-check',planStepId:'step-one'}} as PendingAskV3;
  h.state.pending.splice(0,h.state.pending.length,ask);
  h.dom.set('fetch',async(input:RequestInfo|URL)=>String(input).endsWith('/review')?Response.json({manifest,sourceHash:source.sourceHash,reviewedSource:{packageRevision:'1',viewerVersion:'synthetic',runtimeVersion:'synthetic',rig:null,motion:null},referenceHashes:{photo:jobHash(bytes)},capabilities:{playback:false},feedbackCatalog:{slots:null}}):new Response(bytes));
  const ready=await h.screen.prepare(display,new AbortController().signal);
  expect(ready!.record!.inspection.references).toHaveLength(1);expect(ready!.record!.picture!.review!.manifest.references[0]!.id).toBe('photo');expect(ready!.refusal).toBeUndefined();
  h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);expect(rigHost()!.record!.hasPicture).toBe(true);
  const entry=ready!.record!.forms.get(ask.askId)!;expect(entry).toBeDefined();expect(entry.fieldset.disabled).toBe(true);
  h.state.receipt={publicationId:ask.publicationId,pageId:h.deps.pageId,displayedNonce:'reference-ready'};h.screen.changed(h.state);expect(entry.fieldset.disabled).toBe(false);
  h.state.pending.push({...ask,askId:'later-photo-check'});h.screen.changed(h.state);expect(ready!.record!.forms.has('later-photo-check')).toBe(true);expect(ready!.record!.forms.get(ask.askId)).toBe(entry);
  entry.form.querySelector<HTMLSelectElement>('select[name=outcome]')!.value='pass';entry.form.commentWords=()=> '[general]\nreference comment';await entry.form.onsubmit!({preventDefault(){}} as never);
  expect(h.submitted).toHaveLength(1);expect(h.submitted[0]).toMatchObject({kind:'checkpoint',askId:ask.askId,value:{checkpointId:'photo-check',outcome:'pass',words:'[general]\nreference comment'}});
 }finally{await h.close();}
});

test('#839 record parts pictures keep ordinary inspector eligibility without compiled rig data',async()=>{
 const h=await harness('parts','fixture','interview-picks'),f=h.f;try{
  h.dom.set('ResizeObserver',class{observe(){}disconnect(){}});h.dom.set('MutationObserver',class{observe(){}disconnect(){}});h.dom.set('window',new EventTarget());h.dom.set('requestAnimationFrame',()=>1);h.dom.set('cancelAnimationFrame',()=>{});
  Object.assign(h.dom.document,{addEventListener(){},removeEventListener(){}});
  const create=h.dom.document.createElement;h.dom.document.createElement=(tag:string)=>{const node=create(tag);node.style.setProperty=()=>{};return node;};
  const ready=await h.screen.prepare(f.display,new AbortController().signal);h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);
  const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
  const gate=source.slice(source.indexOf('function bindWorkspace('),source.indexOf('\nasync function start():'));
  const parts=source.slice(source.indexOf('async function startParts('),source.indexOf(" const base=host?'/api/stage-parts'"))+'\n}';
  const opened=await rigHost()!.read('/api/review','GET') as {subject:string};
  expect(opened.subject).toBe('parts');expect(f.workspace.result.kind).toBe('option-set');
  let available:unknown='not-bound',inspector=false;
  const element={querySelector:()=>({append(){}}),parentElement:{},checked:false},defaults={defaultCameraSync:false,defaultIdleRepeat:false,theme:'system'};
  const environment={questionPanel:{},recordPanel:{},host:{record:{hasPicture:true},ownerActAccess:null},partsOnly:true,data:undefined,screenRoot:element,shell:{language:{}},rigInspector:{body:{append(){}},strip:{},comments:{button:{},panel:{querySelector:()=>null}}},communicationPanel:{append(){}},communicationPending:()=>false,viewport:{state:{}},appearance:null,workspace:null,inspectorBlocks:null,liveIssueCount:null,readOnly:null,actReadOnly:null,
   el:()=>element,input:()=>element,select:()=>element,text(){},document:{},tr:(key:string)=>key,readOnlyReason:()=>null,access:{},fitCamera(){},bindAppearance:()=>({}),bindReviewDialog(){},bindInspector(){inspector=true;},
   bindWorkspaceUI:()=>({defaults:()=>defaults,refresh(){}}),bindInspectorBlocks:(options:{available:unknown})=>{available=options.available;return {};}};
  const run=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(gate+'\n'+parts)};return startParts;}`)(environment);
  await run(opened,{issues:[]},{capabilityRequired:true});expect(available).toBeUndefined();expect(inspector).toBe(true);
  // The same gate retains the existing rig and picture-free record decisions.
  const bind=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(gate)};return bindWorkspace;}`)(environment);
  environment.partsOnly=false;bind(true);expect(available).toBeUndefined();bind(false);expect(available).toEqual(['feedback']);
  environment.partsOnly=true;environment.host.record.hasPicture=false;bind(false);expect(available).toEqual(['feedback']);
 }finally{await h.close();}
});

test('#839 a question without option images retains its actual parts backdrop',async()=>{
 const fixture=await recordScreenFixture('interview-picks','parts',undefined,undefined,false,false);
 try{
  const interview=await (await fetch(fixture.origin+fixture.display.routes.apiBase+'interview')).json() as {questions:{images:unknown[]}[]};
  expect(interview.questions).toHaveLength(1);expect(interview.questions[0]!.images).toHaveLength(0);
  expect(fixture.backdrop?.publication.source.package).toBeDefined();
  expect(fixture.backdrop?.publication.source.selector?.kind).toBe('draft');
 }finally{await fixture.close();}
});

 test('#814 fresh-host option-set uses its own sealed parts without a previous publication',async()=>{
 const h=await harness(false,'fixture','interview-picks',true);try{
  expect(h.f.display.publication.previousPublicationId).toBeNull();
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);
  expect(ready?.record?.picture?.parts?.items.map(item=>item.name)).toEqual(['body']);
  expect(h.reads).toEqual([]);
  h.screen.commit(ready!);await h.screen.painted(ready!,new AbortController().signal);
  expect(rigHost()!.subject).toBe('parts');expect(rigHost()!.access.capability).toBeNull();
 }finally{await h.close();}
});

for(const mutant of ['hash','mode'] as const)test('#814 bound picture refuses mismatched '+mutant,async()=>{
 const h=await harness(false,'fixture','interview-picks',true),original=globalThis.fetch;
 try{
  h.dom.set('fetch',async(...args:Parameters<typeof fetch>)=>{
   const response=await original(...args);
   if(String(args[0]).endsWith('/stage-parts')){const parts=await response.json();if(mutant==='hash')parts.sourceHash='0'.repeat(64);else parts.mode='atlas';return Response.json(parts);}
   return response;
  });
  await expect(h.screen.prepare(h.f.display,new AbortController().signal)).rejects.toThrow('JOB_DISPLAY_MISMATCH');
  expect(h.screen.mounted()).toBeNull();
 }finally{await h.close();}
});
test('#814 bound record image route serves only the sealed part and rejects writes',async()=>{
 const h=await harness(false,'fixture','interview-picks',true);try{
  const base=h.f.origin+h.f.display.routes.apiBase;
  const image=await fetch(base+'stage-parts/image/0');expect(image.status).toBe(200);
  const retained=h.f.session.retainedSourceV3(h.f.display.publication.publicationId);
  expect(jobHash(Buffer.from(await image.arrayBuffer()))).toBe(retained.seals.find(file=>file.path.endsWith('/parts/body.png'))!.sha256);
  expect((await fetch(base+'stage-parts/image/1')).status).toBe(404);
  expect((await fetch(base+'stage-parts',{method:'POST'})).status).toBeGreaterThanOrEqual(400);
 }finally{await h.close();}
});

test('#809 checkpoint answers reuse the form contract without the evidence grid',async()=>{
 const h=await harness();try{
  const ready=await h.screen.prepare(h.f.display,new AbortController().signal);
  const entry=ready!.record!.forms.get(h.f.ask.askId)!;
  expect(entry.form.querySelector<HTMLSelectElement>('select[name=outcome]')!.hidden).toBe(true);
  expect(entry.form.querySelector('[data-job-checkpoint-evidence]')).toBeNull();
  const answers=[...entry.form.querySelectorAll<HTMLButtonElement>('button[type=submit]')];
  expect(answers.map((button:any)=>button.textContent).sort()).toEqual(['Pass','job.fail'].sort());
  for(const [label,outcome]of [['Pass','pass'],['job.fail','fail']]){
   const button=answers.find((item:any)=>item.textContent===label)!;
   button.click();
   expect(entry.read()).toMatchObject({checkpointId:h.f.ask.subject.kind==='checkpoint'?h.f.ask.subject.checkpointId:'',outcome,words:''});
  }
  ready!.record!.inspection.dispose();
 }finally{await h.close();}
});

test('#839 disposed workspace cannot re-enter the transient image while tabs unregister',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),start=source.indexOf('function syncQuestionImage():void {'),end=source.indexOf('/** Survey forms take the Question section',start);
 let released=0;const scope={disposed:true,releaseInterview:()=>{released++;}};
 const run=new Function('scope',`with(scope){${new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end))};return syncQuestionImage;}`)(scope);
 run();run();expect(released).toBe(1);expect(scope.releaseInterview).toBeNull();
});

test('#1112 a sealed rig question hides the option file row and exports the original binding', async () => {
 type RigQuestion = InterviewDisplayQuestion & {set:{context:{kind:'rig';rig_version:number;parts:{files:JobFileIdentity[]}}}};
 const f = await optionSetsJobFixture({count:1,boundRig:true,sealAcceptedParts:true});
 const dom = await recordScreenDom();
 const i18n = await import('../web/i18n.ts');
 const preference = i18n.getLanguagePreference(), link = i18n.getLinkLanguage();
 let inspection: Awaited<ReturnType<typeof prepareJobInspection>> | undefined;
 let entry: ReturnType<typeof formFor> | undefined;
 try {
  dom.set('location',{origin:f.origin});
  i18n.setLinkLanguage(null);
  i18n.setLanguagePreference('en');
  const ask = f.asks[0]!, source = f.publication.source;
  if (source.subject !== 'option-set' || ask.subject.kind !== 'interview-picks') throw new Error('Expected a record question');
  const ref = f.workspace.optionSetFile;
  const response = await fetch(f.origin+f.display.routes.apiBase+'interview');
  expect(response.status).toBe(200);
  const {questions} = await response.json() as {questions:RigQuestion[]};
  expect(questions).toHaveLength(1);
  const question = questions[0]!;
  expect(question.ref).toEqual(ref);
  expect(question).toMatchObject({hasParts:false,images:[],set:{context:{kind:'rig',rig_version:3}}});
  const context = question.set.context;
  expect(context.parts.files.map(file => file.path)).toEqual([
   'derived/drafts/synthetic/parts.json','derived/drafts/synthetic/parts/body.png',
  ]);
  const retained = f.session.retainedSourceV3(f.publication.publicationId);
  for (const file of context.parts.files) {
   expect(retained.seals).toContainEqual(file);
   expect(jobHash(await readFile(retained.snapshotRoot+'/'+file.path))).toBe(file.sha256);
  }
  inspection = await prepareJobInspection(f.display,new AbortController().signal,true,false);
  expect(inspection.metadata.manifest?.model).toBe(SYNTHETIC_RIG_MODEL);
  const pageId = 'page-review-1112';
  const receipt = f.session.ackDisplayed({publicationId:ask.publicationId,pageId,sourceHash:source.sourceHash});
  const node: JobFormDependencies['node'] = (tag,key) => {
   const element = dom.document.createElement(tag);
   if (key) {element.dataset.jobText=key;element.textContent=i18n.t(key);}
   return element;
  };
  let act: ActV3 | undefined;
  entry = formFor(ask,inspection,{node,translate:i18n.t,
   helpers:{...createJobFormHelpers(node,i18n.t),jobCheckpointContext,assertJobAskSource:(bound,display)=>{prepareJobForms(display,[bound],()=>null);}},
   draftStorage:()=>({getItem:()=>null}),localDraftKey:()=> 'review-1112',saveDraft(){},
   pageId,access:{capability:f.session.hostCredentials().ui},
   window:{state:()=>({...f.session.status(),receipt,preparing:false,closed:false}),
    async submit(input){act=await f.session.commitUIAct(input);return {ok:true,value:act};}},
  });
  const {form} = entry;
  const badge = form.querySelector('.job-source');
  expect(badge?.textContent).toBe(f.publication.label);
  expect(badge?.getAttribute('title')).toBe(source.sourceHash);
  expect(form.querySelector('h3')?.textContent).toBe(question.set.question);
  const assertQuestionList = (label:string,count:string,answered:boolean) => {
   const list = form.querySelector('.interview-questions')!;
   expect(list.getAttribute('aria-label')).toBe(label);
   expect(list.querySelector('p')?.textContent).toBe(count);
   const buttons = list.querySelectorAll<HTMLButtonElement>('.interview-question');
   expect(buttons).toHaveLength(1);
   expect(buttons[0]?.textContent).toBe(label);
   expect(buttons[0]?.getAttribute('aria-current')).toBe('true');
   expect(Object.hasOwn(buttons[0]!.dataset,'answered')).toBe(answered);
  };
  for (const [language,label,count,catalog] of [
   ['en','Interview question','Answered 0 / 1',enCatalog],
   ['ko','인터뷰 질문','답변 0 / 1',koCatalog],
  ] as const) {
   i18n.setLanguagePreference(language);
   assertQuestionList(label,count,false);
   expect(form.querySelector('.interview-image-context h2')?.textContent).toBe(catalog['interview.source']);
   expect(form.textContent).toContain(i18n.t('interview.provenance',[question.set.drafted_by,question.set.drafted_at]));
   expect(form.textContent).not.toContain(catalog['interview.noParts']);
   expect(form.textContent).not.toContain(catalog['This request has no picture.']);
   expect(form.textContent).not.toContain(ref.path);
   expect(form.textContent).not.toContain(ref.sha256);
   expect(form.querySelector('.interview-image-context code')).toBeNull();
  }
  const item = question.set.asks[0]!, option = item.options.find(item => item.recommended)!;
  const radio = [...form.querySelectorAll<HTMLInputElement>('input[type=radio]')].find(input => input.value === option.id)!;
  radio.click();
  expect(entry.read()).toEqual({questionId:question.set.question,selections:[{itemId:item.id,optionId:option.id,otherText:null}],note:''});
  assertQuestionList('인터뷰 질문','답변 0 / 1',false);
  const submitter = form.querySelector<HTMLButtonElement>('button[type=submit]');
  await form.onsubmit!(Object.assign(new Event('submit',{cancelable:true}),{submitter}));
  expect(act).toMatchObject({kind:'interview-picks',source:{optionSetFile:ref,optionSet:{id:question.set.id,sha256:ref.sha256}}});
  if (!act) throw new Error('Expected a committed interview act');
  assertQuestionList('인터뷰 질문','답변 1 / 1',true);
  i18n.setLanguagePreference('en');
  assertQuestionList('Interview question','Answered 1 / 1',true);
  const exported = await fetch(`${f.origin}/jobs/${f.session.jobId}/api`,{method:'POST',headers:{
   'Content-Type':'application/json',Accept:jobRawActMediaType,Authorization:'Bearer '+f.session.writerGrant().fetchCapability,
  },body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:f.session.jobId,requestId:'review-1112-export',verb:'fetch-act',actId:act.actId})});
  expect(exported.status).toBe(200);
  expect(exported.headers.get('Content-Type')).toBe(jobRawActMediaType);
  expect(await exported.text()).toBe(JSON.stringify(act));
 } finally {
  entry?.form.dispatchEvent(new Event('job-form-dispose'));
  inspection?.dispose();
  i18n.setLinkLanguage(link);
  i18n.setLanguagePreference(preference);
  dom.restore();
  await f.close();
 }
});

test.each([
 ['bound parts',true,undefined,undefined],
 ['missing rig',false,'rig','This question refers to a rig version that this publication does not include.'],
 ['missing scene',false,'unsealed-scene','This question refers to a scene that this publication does not include.'],
 ['no picture',false,'legacy','This request has no picture.'],
] as const)('#1112 record question keeps the source heading and genuine warnings (%s)', async (_name,boundParts,postPicture,warning) => {
 const h = await harness(false,'fixture','interview-picks',boundParts,undefined,postPicture);
 const forms: ReturnType<typeof formFor>[] = [];
 let inspection: Awaited<ReturnType<typeof prepareJobInspection>> | undefined;
 try {
  inspection = await prepareJobInspection(h.f.display,new AbortController().signal);
  const question = inspection.interview!.questions[0]!;
  expect(question.hasParts).toBe(boundParts);
  const entry = formFor(h.f.ask,inspection,h.deps);
  forms.push(entry);
  expect(entry.form.querySelector('.interview-image-context h2')?.textContent).toBe(boundParts?'interview.parts':'interview.source');
  expect(entry.form.textContent).not.toContain('interview.noParts');
  expect(entry.form.textContent).not.toContain(question.ref.path);
  expect(entry.form.textContent).not.toContain(question.ref.sha256);
  if (warning) expect(entry.form.textContent).toContain(warning);
  if (boundParts) {
   // Exercise the shared warning with an explicit unavailable signal on the decoded parts row.
   expect(question.set.context?.kind).toBe('parts');
   expect(entry.form.textContent).not.toContain('interview.partsUnavailable');
   const unavailable = formFor(h.f.ask,{...inspection,interview:{...inspection.interview!,questions:[{...question,hasParts:false,partsUnavailable:true}]}},h.deps);
   forms.push(unavailable);
   expect(unavailable.form.textContent).toContain('interview.partsUnavailable');
   expect(unavailable.form.textContent).not.toContain('interview.noParts');
  }
 } finally {
  for (const entry of forms) entry.form.dispatchEvent(new Event('job-form-dispose'));
  inspection?.dispose();
  await h.close();
 }
});

test.each(['scene','unsealed-scene','rig','rig-painting-second','legacy'] as const)('#929 projects only a sealed question picture for %s', async variant => {
 const fixture=await recordScreenFixture('interview-picks',false,undefined,undefined,false,true,undefined,false,false,variant);
 try {
  const base=fixture.origin+fixture.display.routes.apiBase;
  const response=await fetch(base+'interview');
  expect(response.status).toBe(200);
  const {questions:[question]}=await response.json() as {questions:{images:{name:string;url:string}[];scenePicture?:true;missingPicture?:string}[]};
  expect(question).toBeDefined();
  if(variant==='scene'){
   expect(question!.scenePicture).toBe(true);
   expect(question!.images.map(image=>image.name)).toEqual(['background']);
   const image=await fetch(base+'interview/image/'+question!.images[0]!.url.split('/').slice(-2).join('/'));
   expect(image.status).toBe(200);
   expect(Buffer.from(await image.arrayBuffer())).toEqual(await readFile(fixture.root+'/evidence/plate.png'));
  }else{
   expect(question!.images.map(image=>image.name)).toEqual(variant==='legacy'?[]:['reference.png']);
   if(variant!=='legacy'){
    const image=await fetch(base+'interview/image/'+question!.images[0]!.url.split('/').slice(-2).join('/'));
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(await readFile(fixture.root+'/inputs/reference.png'));
   }
   expect(question!.missingPicture).toBe(variant==='legacy'?undefined:(variant==='rig'||variant==='rig-painting-second')?'rig':'scene');
  }
 }finally{await fixture.close();}
});

test('#955 refuses a missing rig and an unsealed original painting', async () => {
 const fixture = await recordScreenFixture('interview-picks',false,undefined,undefined,false,true,undefined,false,false,'rig-no-painting');
 try {
  const response = await fetch(fixture.origin + fixture.display.routes.apiBase + 'interview');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ok:false,error:{code:'JOB_SOURCE_UNRETAINABLE'}});
 } finally {await fixture.close();}
});

test.each(rigPictureCases)('#929 variant B resolves the rig picture for %s', async variant => {
 const fixture = await recordScreenFixture('interview-picks',false,undefined,undefined,false,true,undefined,false,false,variant);
 try {
  const {publication,routes} = fixture.display;
  const base = fixture.origin + routes.apiBase;
  const assets = fixture.origin + routes.assetsBase;
  const build = SYNTHETIC_RIG_ROOT + '/out/check/';
  const source = publication.source;
  if (!('record' in source)) throw new Error('Expected a record publication');
  expect(publication.previousPublicationId).toBeNull();
  expect(fixture.reader.calls.map(call => call.phase)).toEqual(['inventory','retained']);
  if (variant === 'rig-retained-model-hash') {
   // Change only the retained bytes after publication, before either view route can cache a result.
   const retained = fixture.session.retainedSourceV3(publication.publicationId);
   const modelPath = build+SYNTHETIC_RIG_MODEL, retainedPath = retained.snapshotRoot+'/'+modelPath;
   const modelHash = source.files.find(row => row.path === modelPath)!.sha256;
   const bytes = await readFile(retainedPath);
   expect(retained.seals.find(row => row.path === modelPath)?.sha256).toBe(modelHash);
   expect(jobHash(bytes)).toBe(modelHash);
   const changed = Buffer.concat([bytes,Buffer.from('\n')]);
   expect(jobHash(changed)).not.toBe(modelHash);
   await writeFile(retainedPath,changed);
  }
  const interview = await fetch(base+'interview');
  expect(interview.status).toBe(200);
  const {questions:[question]} = await interview.json();
  expect(question).toMatchObject({editable:true,images:variant==='bound-rig'?[]:[{name:'reference.png'}],set:{question:'post_timing',id:'post-picture'}});
  const review = await fetch(base+'review');
  expect(review.status).toBe(200);
  const metadata = await review.json();
  expect(metadata.recordSource).toEqual(publication.source);
  expect(metadata.sourceHash).toBe(publication.source.sourceHash);
  if (variant !== 'bound-rig') {
   expect(question.missingPicture).toBe('rig');
   expect(metadata.capabilities.playback).toBe(false);
   expect(Object.hasOwn(metadata,'manifest')).toBe(false);
   expect(Object.hasOwn(metadata,'reviewedSource')).toBe(false);
   for (const path of [SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE,'config.json']) {
    const refused = await fetch(assets+path);
    expect(refused.status).toBe(404);
    expect((await refused.json()).error.code).toBe('JOB_SOURCE_UNRETAINABLE');
   }
   return;
  }
  const modelHash = source.files.find(row => row.path === build+SYNTHETIC_RIG_MODEL)!.sha256;
  expect(Object.hasOwn(question,'missingPicture')).toBe(false);
  expect(metadata.capabilities).toMatchObject({playback:true,interview:true,preRig:false});
  expect(metadata.manifest).toMatchObject({model:SYNTHETIC_RIG_MODEL,references:[]});
  expect(metadata.reviewedSource).toMatchObject({
   rig:{path:SYNTHETIC_RIG_MODEL,sha256:modelHash},
  });
  expect(metadata.reviewedSource.handoff).toBeUndefined();
  expect(metadata.capabilities.modeling).toBe(false);
  expect(source.files.filter(row => row.path.startsWith(build+'build/')).map(row => row.path.slice(build.length)))
   .toEqual(['build/run.json','build/skeleton.atlas','build/skeleton.json',SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE]);
  for (const path of [SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE]) {
   const response = await fetch(assets+path);
   expect(response.status).toBe(200);
   expect(jobHash(Buffer.from(await response.arrayBuffer())))
    .toBe(source.files.find(row => row.path === build+path)!.sha256);
  }
  for (const path of ['build/unsealed.png','config.json']) {
   const refused = await fetch(assets+path);
   expect(refused.status).toBe(404);
   expect((await refused.json()).error.code).toBe('JOB_SOURCE_UNRETAINABLE');
  }
  fixture.suppressRigPicture();
  const suppressed = await fixture.metadata();
  expect(suppressed.recordSource).toEqual(source);
  expect(suppressed.sourceHash).toBe(source.sourceHash);
  expect(suppressed.capabilities.playback).toBe(false);
  expect(Object.hasOwn(suppressed,'manifest')).toBe(false);
  expect(Object.hasOwn(suppressed,'reviewedSource')).toBe(false);
  const suppressedInterview = await (await fetch(base+'interview')).json();
  expect(suppressedInterview.questions).toEqual([{...question,missingPicture:'rig'}]);
 } finally { await fixture.close(); }
});

test.each(['none','record','model','version','partial'] as const)('#929 client verifies the record rig binding (%s)', async plant => {
 const fixture = await recordScreenFixture('interview-picks',false,undefined,undefined,false,true,undefined,false,false,'bound-rig');
 const dom = await recordScreenDom();
 const originalFetch = globalThis.fetch;
 const assetRequests: string[] = [];
 try {
  dom.set('location',{origin:fixture.origin});
  dom.set('fetch',async (...args: Parameters<typeof fetch>) => {
   const path = new URL(String(args[0])).pathname;
   if (path.startsWith(fixture.display.routes.assetsBase)) assetRequests.push(path);
   const response = await originalFetch(...args);
   if (path.endsWith('/api/review') && plant !== 'version') {
    const body = await response.json();
    if (plant === 'record') body.recordSource.projectHash = '0'.repeat(64);
    if (plant === 'model') body.reviewedSource.rig.sha256 = '0'.repeat(64);
    if (plant === 'partial') delete body.manifest;
    return Response.json(body);
   }
   if (path.endsWith('/api/interview') && plant === 'version') {
    const body = await response.json();
    body.questions[0].set.context.rig_version = 2;
    return Response.json(body);
   }
   return response;
  });
  const prepared = prepareJobInspection(fixture.display,new AbortController().signal);
  if (plant === 'none') {
   const ready = await prepared;
   try {
    expect(ready.metadata.manifest?.model).toBe(SYNTHETIC_RIG_MODEL);
    expect(ready.assets).toBeNull();
    expect(ready.player).toBeNull();
   } finally { ready.dispose(); }
  } else {
   await expect(prepared).rejects.toThrow('JOB_DISPLAY_MISMATCH');
  }
  expect(assetRequests).toEqual([]);
 } finally {
  dom.restore();
  await fixture.close();
 }
});

test.each(['same rig','third question names another rig'] as const)('#1101 verifies all three question bindings (%s)', async variant => {
 type RigQuestion = InterviewDisplayQuestion & {set:{context:{kind:'rig';rig_version:number}}};
 const fixture = await optionSetsJobFixture({count:3,boundRig:true});
 const dom = await recordScreenDom();
 const originalFetch = globalThis.fetch;
 const assetRequests: string[] = [];
 const questionVersions: number[] = [];
 try {
  dom.set('location',{origin:fixture.origin});
  dom.set('fetch',async (...args: Parameters<typeof fetch>) => {
   const path = new URL(String(args[0])).pathname;
   if (path.startsWith(fixture.display.routes.assetsBase)) assetRequests.push(path);
   const response = await originalFetch(...args);
   if (path !== fixture.display.routes.apiBase+'interview') return response;
   expect(response.status).toBe(200);
   const body: {questions: RigQuestion[]} = await response.json();
   expect(body.questions.map(question => question.set.question)).toEqual(['bones','meshes','constraints']);
   if (variant === 'third question names another rig') {
    const question = body.questions[2]!;
    body.questions[2] = {...question,set:{...question.set,context:{...question.set.context,rig_version:4}}};
   }
   questionVersions.push(...body.questions.map(question => question.set.context.rig_version));
   return Response.json(body);
  });
  const prepared = prepareJobInspection(fixture.display,new AbortController().signal,true,false);
  if (variant === 'same rig') {
   const ready = await prepared;
   try {
    expect(ready.metadata.manifest?.model).toBe(SYNTHETIC_RIG_MODEL);
    expect(ready.interview?.questions).toHaveLength(3);
    expect(questionVersions).toEqual([3,3,3]);
   } finally { ready.dispose(); }
  } else {
   await expect(prepared).rejects.toThrow('JOB_DISPLAY_MISMATCH');
   expect(questionVersions).toEqual([3,3,4]);
  }
  expect(assetRequests).toEqual([]);
 } finally {
  dom.restore();
  await fixture.close();
 }
});

test('#1123 and #974 plan grounds resolve interview IDs before overlapping steps and keep plain step and unknown IDs', async () => {
 const prompt = '  Keep the hat with the head?  ';
 const multiple = ['First question?\r\nContinue here.', '  Second question?  '];
 const absence = enCatalog['job.plan.field.absent'];
 const fixture = await recordScreenFixture('signoff', false, undefined, 'plan-approved', false, true, undefined, false, false, undefined, {
  text: {
   does: 'Assemble post scene',
   produces: 'Post composition pass',
   bar: 'Matches declared timing and framing',
   rests_on: ['post_timing', 'rig_type', 'bones_guide', 'step_layout', 'step_weights', 'unknown_question_id', 'missing', 'multiple'],
  },
  interview: {
   framing: [{ id: 'rig_type', text: 'What is this: a character rig or a full-screen scene?' }],
   waypoints: [
    { id: 'bones_guide', text: 'How many segments should the limb bones use?' },
    { id: 'step_layout', prompts: [{ text: prompt }] },
    { id: 'missing', prompts: [] },
    { id: 'multiple', text: 'Legacy label', prompts: [
     { text: multiple[0] }, { text: '  ' }, { id: 'no-text' }, { text: multiple[1] },
    ] },
   ],
   post: { items: [
    { id: 'post_timing', text: 'How long, does it loop, and where are the beats?' },
    { id: 'step_layout', text: 'Later duplicate question' },
   ] },
  },
 });
 const dom = await recordScreenDom();
 try {
  dom.set('location', { origin: fixture.origin });
  const path = join(fixture.root, 'project.json');
  const source = structuredClone(fixture.ask.source);
  const recordHash = jobHash(await readFile(path));
  const inspection = await prepareJobInspection(fixture.display, new AbortController().signal);
  try {
   const translate = (key: string) => key === 'job.plan.field.absent' ? absence : key;
   const node = ((tag: string, key?: string) => {
    const element = dom.document.createElement(tag);
    if (key) element.textContent = translate(key);
    return element;
   }) as JobFormDependencies['node'];
   const helpers = createJobFormHelpers(node, translate);
   expect(Object.keys(inspection.metadata.planText!)).toEqual(['schema', 'record', 'status', 'steps', 'questions']);
   expect(inspection.metadata.planText).toMatchObject({record: {sha256: recordHash}, questions: {step_layout: prompt}});
   const list = helpers.planTextList(fixture.ask.source.plan!, inspection.metadata.planText, 'step_layout');
   const rows = [...list.querySelector('[data-job-plan-field="rests_on"]')!.querySelectorAll('li')];
   const entries = rows.map(item => ({
    text: item.textContent,
    title: item.title,
   }));
   expect(entries).toEqual([
    { text: 'How long, does it loop, and where are the beats?', title: 'post_timing' },
    { text: 'What is this: a character rig or a full-screen scene?', title: 'rig_type' },
    { text: 'How many segments should the limb bones use?', title: 'bones_guide' },
    { text: prompt, title: 'step_layout' },
    { text: 'Assemble post scene', title: 'step_weights' },
    { text: 'unknown_question_id', title: '' },
    { text: absence, title: 'missing' },
    ...multiple.map(text => ({text, title: 'multiple'})),
   ]);
   expect(rows[3]?.getAttribute('translate')).toBe('no');
   expect(rows.slice(-2).map(row => row.getAttribute('translate'))).toEqual(['no', 'no']);
   expect(fixture.ask.source).toEqual(source);
   expect(jobHash(await readFile(path))).toBe(recordHash);
  } finally {
   inspection.dispose();
  }
 } finally {
  dom.restore();
  await fixture.close();
 }
});
