import {fixturePublication} from './helpers/job-window-fixture.ts';
import {parseManifest} from '../src/manifest.ts';
import {jobHash} from '../src/job-api.ts';
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {createJobRigScreen} from '../web/job-rig-screen.ts';
import {rigHost,setRigHost} from '../web/rig-host.ts';
import {createJobFormDrafts,createJobFormHelpers,formFor,jobCheckpointContext,jobPublicationRoutes,prepareJobForms,prepareJobInspection,type JobFormDependencies} from '../web/job-session.ts';
import type {DisplayPublicationV3,PendingAskV3,UISubmissionV3} from '../src/job-contract.ts';
import {recordScreenDom,recordScreenFixture} from './helpers/job-record-screen-fixture.ts';

async function harness(picture:boolean|'parts'=false,capability:string|null='fixture',kind:'checkpoint'|'interview-picks'='checkpoint'){
 const f=await recordScreenFixture(kind,picture),dom=await recordScreenDom();dom.set('location',{origin:f.origin});
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
  h.state.pending.push({...h.f.ask,askId:'later-signoff',subject:{kind:'signoff',stage:'plan-approved'}});h.screen.changed(h.state);
  expect(ready!.record!.forms.size).toBe(2);expect(ready!.record!.forms.get(h.f.ask.askId)).toBe(entry);expect(entry.read()).toMatchObject({words:'[general]\nretained reviewer words'});expect(entry.fieldset.disabled).toBe(false);
  const restored=formFor(h.f.ask,ready!.record!.inspection,h.deps);restored.form.commentWords=entry.form.commentWords;expect(restored.read()).toEqual(entry.read());
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
 const h=await harness();try{const screen=createJobRigScreen({...h.options,formDependencies:undefined});await expect(screen.prepare(h.f.display,new AbortController().signal)).rejects.toThrow('JOB_ACT_KIND_DISABLED');expect(screen.mounted()).toBeNull();}finally{await h.close();}
});

test('#774 all shared publications keep one stream; cancellation never mounts another screen',async()=>{
 const source=await readFile(new URL('../web/job-session.ts',import.meta.url),'utf8');
 const start=source.indexOf('export async function mountJobScreen(');
 const body=source.slice(start).replace('export async function mountJobScreen','async function mountJobScreen').replace("await import('./i18n.ts')",'i18nDouble');
 const run=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(body)};return mountJobScreen;}`);
 for(const mounted of [false,true]){
  let adapter:any,streams=0,aborted=false,paints=0,reports=0,changed=0;
  const prepared={},controller=new AbortController();
  const environment={document:{createElement:()=>({dataset:{},setAttribute(){}})},sessionStorage:{},localStorage:{},location:{href:'http://127.0.0.1/jobs/fixture/',origin:'http://127.0.0.1'},history:{replaceState(){}},crypto,AbortController,URL,
   jobWindowAccess:()=>({jobId:'fixture'}),i18nDouble:{onLanguageChange:()=>()=>{}},t:(key:string)=>key,createJobFormHelpers:()=>({}),createJobFormDrafts:()=>({saveDraft(){}}),createJobWindowTransport:()=>({}),
   createJobRigScreen:()=>({mounted:()=>mounted?prepared:null,prepare:async()=>prepared,changed(){changed++;},report(){reports++;},painted:async()=>{paints++;}}),
   createJobWindow:(options:any)=>{adapter=options.adapter;return {stop(){aborted=true;},state:()=>({}),event(){}};},startJobWindowEvents:()=>{streams++;return {done:Promise.resolve(),displayed(){}};},
   assertJobAskSource(){},jobCheckpointContext,jobPublicationRoutes,jobWindowRefusal:String,globalThis:{addEventListener(){},removeEventListener(){}},JOB_HUB_READY:'ready',jobHubMessageMatches(){}};
  const stop=await run(environment)({append(){},querySelectorAll:()=>[]});
  expect(await adapter.prepare({},controller.signal)).toBe(prepared);await adapter.painted(prepared,controller.signal);expect(paints).toBe(1);
  adapter.changed({error:'fixture load failure'});expect(changed).toBe(1);expect(reports).toBe(mounted?0:0);
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
   for(const kind of ['signoff','reopen'] as const){const entry=formFor({...h.f.ask,subject:{kind,stage:'plan-approved'}},inspection,deps);expect(entry.form.textContent).not.toContain('plan-approved');expect(entry.fieldset.title).toBe('plan-approved');expect(entry.read()).toMatchObject({stage:'plan-approved',words:''});}
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

test('#805 record option-set with a parts picture reaches the existing inspector gate without rig data',async()=>{
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
  const element={querySelector:()=>({}),parentElement:{},checked:false},defaults={defaultCameraSync:false,defaultIdleRepeat:false,theme:'system'};
  const environment={host:{record:{hasPicture:true},ownerActAccess:null},partsOnly:true,data:undefined,screenRoot:element,shell:{language:{}},rigInspector:{strip:{},comments:{button:{},panel:{}}},viewport:{state:{}},appearance:null,workspace:null,inspectorBlocks:null,liveIssueCount:null,readOnly:null,actReadOnly:null,
   el:()=>element,input:()=>element,select:()=>element,text(){},document:{},tr:(key:string)=>key,readOnlyReason:()=>null,access:{},fitCamera(){},bindAppearance:()=>({}),bindReviewDialog(){},bindInspector(){inspector=true;},
   bindWorkspaceUI:()=>({defaults:()=>defaults}),bindInspectorBlocks:(options:{available:unknown})=>{available=options.available;return {};}};
  const run=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(gate+'\n'+parts)};return startParts;}`)(environment);
  await run(opened,{issues:[]},{capabilityRequired:true});expect(available).toEqual(['feedback']);expect(inspector).toBe(true);
  // The same gate retains the existing rig and picture-free record decisions.
  const bind=new Function('environment',`with(environment){${new Bun.Transpiler({loader:'ts'}).transformSync(gate)};return bindWorkspace;}`)(environment);
  bind(true);expect(available).toBeUndefined();environment.host.record.hasPicture=false;bind(false);expect(available).toEqual(['feedback']);
 }finally{await h.close();}
});
