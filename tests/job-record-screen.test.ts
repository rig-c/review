import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {createJobRigScreen} from '../web/job-rig-screen.ts';
import {rigHost,setRigHost} from '../web/rig-host.ts';
import {createJobFormDrafts,createJobFormHelpers,formFor,jobCheckpointContext,jobPublicationRoutes,prepareJobForms,prepareJobInspection,type JobFormDependencies} from '../web/job-session.ts';
import type {DisplayPublicationV3,PendingAskV3,UISubmissionV3} from '../src/job-contract.ts';
import {recordScreenDom,recordScreenFixture} from './helpers/job-record-screen-fixture.ts';

async function harness(picture=false){
 const f=await recordScreenFixture('checkpoint',picture),dom=await recordScreenDom();dom.set('location',{origin:f.origin});
 const state={pending:[f.ask] as PendingAskV3[],receipt:null as {publicationId:string;pageId:string;displayedNonce:string}|null,generation:f.display.publication.generation,preparing:false,closed:false};
 const submitted:UISubmissionV3[]=[],store=new Map<string,string>();
 const node=((tag:string,key?:string)=>{const value=dom.document.createElement(tag);if(key)value.textContent=key;return value;}) as JobFormDependencies['node'];
 let screen:ReturnType<typeof createJobRigScreen>;
 const drafts=createJobFormDrafts({jobId:f.session.jobId,current:()=>screen.mounted()?.record?.inspection??null,forms:()=>screen.mounted()?.record?.forms??new Map(),storage:()=>({setItem:(k,v)=>{store.set(k,v);}})});
 const deps:JobFormDependencies={node,translate:key=>key,helpers:{...createJobFormHelpers(node,key=>key),jobCheckpointContext,assertJobAskSource:(ask,display)=>{prepareJobForms(display,[ask],()=>null);}},draftStorage:()=>({getItem:k=>store.get(k)??null}),...drafts,access:{capability:'fixture'},pageId:'fixture-page',window:{state:()=>state,submit:async input=>{submitted.push(input);return {ok:false,error:{code:'JOB_ACT_INVALID',message:'fixture refusal'}};}}};
 const reads:string[]=[];
 const options:Parameters<typeof createJobRigScreen>[0]={host:{classList:{remove(){}},replaceChildren(){}} as unknown as HTMLElement,pageId:deps.pageId,access:{capability:'fixture',headers:()=>new Headers({'X-Review-Capability':'fixture'})},window:deps.window,formDependencies:deps,
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
  const note=entry.form.querySelector('textarea')!;note.value='  retained reviewer words\n';entry.form.oninput!({} as never);
  const saved=[...h.store.values()][0]!;expect(saved).toContain('retained reviewer words');
  h.state.preparing=true;h.screen.changed(h.state);expect(entry.fieldset.disabled).toBe(true);
  h.state.preparing=false;h.state.receipt={publicationId:h.f.ask.publicationId,pageId:h.deps.pageId,displayedNonce:'rearmed'};
  h.state.pending.push({...h.f.ask,askId:'later-signoff',subject:{kind:'signoff',stage:'plan-approved'}});h.screen.changed(h.state);
  expect(ready!.record!.forms.size).toBe(2);expect(ready!.record!.forms.get(h.f.ask.askId)).toBe(entry);expect(note.value).toBe('  retained reviewer words\n');expect(entry.fieldset.disabled).toBe(false);
  const restored=formFor(h.f.ask,ready!.record!.inspection,h.deps);expect(restored.read()).toEqual(entry.read());
  h.state.closed=true;h.screen.changed(h.state);expect(entry.fieldset.disabled).toBe(true);await entry.form.onsubmit!({preventDefault(){}} as never);expect(h.submitted).toHaveLength(0);
 }finally{await h.close();}
});

test('#750 record metadata mismatch refuses',async()=>{
 const h=await harness(),original=globalThis.fetch;try{
  globalThis.fetch=(async(input,init)=>{const response=await original(input,init);if(String(input).endsWith('/api/review')){const body=await response.json();body.sourceHash='f'.repeat(64);return Response.json(body);}return response;}) as typeof fetch;
  await expect(h.screen.prepare(h.f.display,new AbortController().signal)).rejects.toThrow('JOB_DISPLAY_MISMATCH');
 }finally{globalThis.fetch=original;await h.close();}
});

test('#750 missing record form dependencies refuse before legacy fallback',async()=>{
 const h=await harness();try{const screen=createJobRigScreen({...h.options,formDependencies:undefined});await expect(screen.prepare(h.f.display,new AbortController().signal)).rejects.toThrow('JOB_PANEL_UNAVAILABLE');expect(screen.mounted()).toBeNull();}finally{await h.close();}
});

test('#750 unsupported fallback drains its first stream and starts legacy only once; supported records do not fall back',async()=>{
 const source=await readFile(new URL('../web/job-session.ts',import.meta.url),'utf8');
 const start=source.indexOf('export async function mountJobScreen('),end=source.indexOf('/** Browser mount is explicit',start);
 let body=source.slice(start,end).replace('export async function mountJobScreen','async function mountJobScreen').replace("await import('./i18n.ts')",'i18nDouble');
 const run=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(body)};return mountJobScreen;}`);
 for(const variant of ['unsupported','supported','stop-during-fallback']){
  const supported=variant==='supported';
  let adapter:any,drained=false,legacy=0,streams=0,aborted=false,disposed=0,finishLegacy:(()=>void)|undefined;const document={createElement:()=>({dataset:{},setAttribute(){}})};
  const environment={document,sessionStorage:{},localStorage:{},location:{href:'http://127.0.0.1/jobs/fixture/',origin:'http://127.0.0.1'},history:{replaceState(){}},crypto,AbortController,URL,jobWindowAccess:()=>({jobId:'fixture'}),i18nDouble:{onLanguageChange:()=>()=>{}},t:(key:string)=>key,createJobFormHelpers:()=>({}),createJobFormDrafts:()=>({saveDraft(){}}),createJobWindowTransport:()=>({}),createJobRigScreen:()=>({mounted:()=>null,prepare:async()=>supported?{}:null,changed(){},painted:async()=>{}}),createJobWindow:(options:any)=>{adapter=options.adapter;return {stop(){aborted=true;},state:()=>({}),event(){}};},startJobWindowEvents:()=>{streams++;return {done:Promise.resolve().then(()=>{drained=true;}),displayed(){}};},mountJobSession:async(_host:any,flag:boolean)=>{expect(flag).toBe(true);expect(aborted).toBe(true);expect(drained).toBe(true);legacy++;if(variant==='stop-during-fallback')await new Promise<void>(resolve=>{finishLegacy=resolve;});return ()=>{disposed++;};},assertJobAskSource(){},jobCheckpointContext,jobPublicationRoutes,jobWindowRefusal:String,globalThis:{addEventListener(){},removeEventListener(){}},JOB_HUB_READY:'ready',jobHubMessageMatches(){}};
  const stop=await run(environment)({append(){},querySelectorAll:()=>[]});
  if(!supported){const signal=new AbortController().signal;const pending=Promise.all([adapter.painted(null,signal),adapter.painted(null,signal)]);if(variant==='stop-during-fallback'){while(!finishLegacy)await Bun.sleep(1);stop();finishLegacy();}await pending;expect(legacy).toBe(1);}else{const prepared=await adapter.prepare({},new AbortController().signal);expect(prepared).toBeTruthy();await adapter.painted(prepared,new AbortController().signal);expect(legacy).toBe(0);}
  expect(streams).toBe(1);stop();expect(disposed).toBe(supported?0:1);
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
  const radios=[...entry.form.querySelectorAll<HTMLInputElement>('input[type=radio]')],identities=radios.map(input=>({name:input.name,value:input.value}));
  for(const input of radios){input.checked=['topology_other','density_auto'].includes(input.value);if(input.checked)input.dispatchEvent(new Event('change'));}
  entry.form.querySelector<HTMLTextAreaElement>('textarea[name="other.topology"]')!.value='  직접 입력\n';
  expect(entry.form.querySelector('textarea[name="note"]')).toBeNull();
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
 }finally{inspection?.dispose();dom.restore();await f.close();}
});
