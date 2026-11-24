/** #1004 ordinary Nova browser check: one record publication with K = 4 option sets on the real job page.
 * The question list shows the four sets with one "Submit review (n/4)" at its top. Submit sends only the answered
 * sets, one interview-picks act each; the rest stay pending and editable, and are submitted later. EN and KO.
 * Retry case: of two sets sent by one click, one request is refused after the other lands; the shared submit
 * re-enables, still counts both, and the refused set stays pending and submits on the next click.
 * #1101 reuses the list on an accepted rig, leaving its third set pending after partial submit. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {optionSetsJobFixture} from './helpers/job-record-screen-fixture.ts';
import {JOB_COMMENTS_ACT_SCHEMA} from '../src/job-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const output=resolve(arg('--out')??'artifacts/job-option-sets-1004');await mkdir(output,{recursive:true});
const rigOnly=Bun.argv.includes('--rig-only');
const root='#workspace-interview-answer';
const headline=()=>page!.evaluate<string>(`document.querySelector('#workspace-ask-headline').textContent`);
type ListState={forms:{ask:string;visible:boolean;answered:boolean;editable:boolean}[];rows:{answered:boolean;current:boolean}[];
 action:{text:string;disabled:boolean;first:boolean;visible:boolean}|null;actions:number};
const profile=await mkdtemp(join(tmpdir(),'review-1004-browser-'));
const exceptions:unknown[]=[],consoleErrors:unknown[]=[],cases:unknown[]=[];
const sendingFailures:string[]=[];
let page:InputCdpSession|undefined;
let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined;
/** Hold one ui/acts request by its ask while the other requests go through. */
let refuseAsk:string|undefined,heldRequest:string|undefined;
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('1004_BROWSER_TIMEOUT '+label);}
async function waitFor(check:()=>boolean,label:string){const until=Date.now()+20000;while(Date.now()<until){if(check())return;await Bun.sleep(30);}throw new Error('1004_BROWSER_TIMEOUT '+label);}
const state=()=>page!.evaluate<ListState>(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getClientRects().length>0;
 const forms=[...document.querySelectorAll('${root} form[data-job-ask]')],shown=forms.find(visible);
 const nav=shown?.querySelector('nav.interview-questions'),action=nav?.querySelector('[data-job-questions-submit]');
 return {forms:forms.map(f=>({ask:f.dataset.jobAsk,visible:visible(f),answered:f.dataset.interviewAnswered==='true',editable:!f.querySelector('fieldset').disabled})),
  rows:[...(nav?.querySelectorAll('button.interview-question')??[])].map(b=>({answered:b.hasAttribute('data-answered'),current:b.getAttribute('aria-current')==='true'})),
  action:action?{text:action.textContent,disabled:action.disabled,first:nav.firstElementChild===action,visible:visible(action)}:null,
  actions:document.querySelectorAll('${root} [data-job-questions-submit]').length};})()`);
async function clickVisible(selector:string){
 await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
 await click(page!,selector);
}
const visibleForm=`${root} form[data-job-ask]:not([hidden])`;
async function selectRow(index:number){
 await clickVisible(`${visibleForm} nav.interview-questions li:nth-child(${index+1}) button`);
 await wait(`document.querySelector(${JSON.stringify(visibleForm+' nav.interview-questions li:nth-child('+(index+1)+') button')})?.getAttribute('aria-current')==='true'`,'select row '+(index+1));
}
/** Pick the recommended (first) value of the shown set, the way a reviewer does. */
async function answerShown(){
 await clickVisible(`${visibleForm} fieldset.interview-ask label.interview-option:first-of-type`);
}

type InterviewSubmitReadback = {
 text:string; width:number; disabled:boolean; busy:string|null; status:string; title:string;
 saved:boolean; actStatus:string|null; picks:string[]; note:string|null;
};

async function singleSetSubmission(language:'en'|'ko', outcome:'success'|'stale'|'network'){
 const catalog=language==='ko'?koCatalog:enCatalog;
 const fixture=await optionSetsJobFixture({count:1});
 const form=`${visibleForm}.interview-answer`, submit=`${form} button[type="submit"]`;
 const note='Public interview note\n선택 메모';
 const readback=()=>page!.evaluate<InterviewSubmitReadback>(`(()=>{
  const form=document.querySelector(${JSON.stringify(form)}), button=form.querySelector('button[type="submit"]');
  const status=form.querySelector(':scope > [role="status"]');
  return {text:button.textContent,width:button.getBoundingClientRect().width,disabled:button.matches(':disabled'),
   busy:button.getAttribute('aria-busy'),status:status.textContent,title:status.title,
   saved:form.dataset.interviewAnswered==='true',actStatus:document.querySelector('#review-draft-state')?.textContent??null,
   picks:[...form.querySelectorAll('input[type=radio]:checked')].map(input=>input.value),
   note:form.querySelector('textarea[name=note]')?.value??null};
 })()`);
 const capture=async(name:string)=>writeFile(join(output,`1153-${language}-${name}.png`),await page!.screenshot());
 const verify=(condition:boolean,message:string)=>{if(!condition)sendingFailures.push(`${language} ${outcome}: ${message}`);};
 try{
  const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
  await page!.setViewport(1440,900);await page!.goto(url.href,language);
  await wait(`document.documentElement.lang==='${language}' && document.body.dataset.ready==='true' &&
   document.querySelector('${submit}')?.checkVisibility()`,'1153 single set ready');
  await answerShown();
  await page!.evaluate<void>(`(()=>{
   const note=document.querySelector('${form} textarea[name=note]');
   note.value=${JSON.stringify(note)};note.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  const before=await readback();
  assert.equal(before.picks.length,1);
  assert.equal(before.note,note);
  assert.equal(before.disabled,false);
  assert.equal(before.text,catalog['interview.save']);
  assert.ok(control);
  refuseAsk=fixture.asks[0]!.askId;heldRequest=undefined;
  await control('Fetch.enable',{patterns:[{urlPattern:'*ui/acts*',requestStage:'Request'}]});
  await clickVisible(submit);
  await waitFor(()=>!!heldRequest,'1153 act POST held');
  assert.ok(heldRequest);
  const start=performance.now();
  await Bun.sleep(350);
  const held=await readback();
  const heldMs=performance.now()-start;
  if(outcome==='success')await capture('held');
  switch(outcome){
   case 'success': await control('Fetch.continueRequest',{requestId:heldRequest});break;
   case 'stale': await control('Fetch.fulfillRequest',{requestId:heldRequest,responseCode:409,
    responseHeaders:[{name:'Content-Type',value:'application/json'}],
    body:Buffer.from(JSON.stringify({ok:false,error:{code:'JOB_ACT_SOURCE_STALE',message:'JOB_ACT_SOURCE_STALE'}})).toString('base64')});break;
   case 'network': await control('Fetch.failRequest',{requestId:heldRequest,errorReason:'Failed'});break;
  }
  await wait(outcome==='success'
   ? `document.querySelector('${form}').dataset.interviewAnswered==='true' &&
      document.querySelector('#review-draft-state[data-save-state="saved"]')?.textContent.toLowerCase().includes(${JSON.stringify(language==='ko'?'저장':'saved')})`
   : `!document.querySelector('${submit}').matches(':disabled')`,'1153 act settled');
  const after=await readback();
  if(outcome==='stale')await capture('error');
  const acts=(await fixture.readEvents()).events.flatMap(event=>event.type==='act'?[event.act]:[]);
  const observation={language,outcome,heldMs,before,held,after,acts:acts.length};
  console.log('1153_SINGLE '+JSON.stringify(observation));
  verify(held.disabled&&held.busy==='true'&&held.text===catalog['Sending'],'disabled Sending button');
  verify(held.status===catalog['Sending'],'live status announces Sending');
  verify(held.width===before.width,'button width stays fixed during POST');
  verify(held.actStatus===before.actStatus,'act bar is unchanged during POST');
  if(outcome==='success'){
   assert.equal(after.status,catalog['job.saved']);
   assert.equal(acts.length,1);
   const act=acts[0]!;
   assert.equal(act.kind,'interview-picks');
   assert.equal(act.value.note,note);
   assert.deepEqual(act.value.selections.map(selection=>selection.optionId),before.picks);
  }else{
   const code=outcome==='stale'?'JOB_ACT_SOURCE_STALE':'JOB_ACT_INVALID';
   const reason=outcome==='stale'?catalog['job.submit.JOB_ACT_SOURCE_STALE']:catalog['job.submit.refused'];
   const refusal=catalog['Review was not submitted: {0}']!.replace('{0}',reason!);
   verify(after.status===refusal&&after.title.startsWith(code+' · '),'localized refusal and diagnostic code');
   verify(after.text===before.text&&after.width===before.width&&!after.disabled&&after.busy===null,'restored submit button');
   assert.deepEqual(after.picks,before.picks);
   assert.equal(after.note,note);
   assert.equal(after.saved,false);
   assert.equal(acts.length,0);
  }
  cases.push(observation);
 }finally{
  refuseAsk=undefined;
  await control?.('Fetch.disable').catch(()=>{});
  heldRequest=undefined;
  await page!.goto('about:blank');await fixture.close();
 }
}

type RigReadback = {
 language: string;
 viewport: {width: number; height: number};
 communication: boolean;
 visibleCanvasCount: number;
 sameCanvas: boolean;
 visibleAsk: string | null;
 checked: string | null;
 rows: {text: string; checkmark: boolean; current: boolean; visible: boolean}[];
 submit: {text: string; disabled: boolean; first: boolean} | null;
 visibleSubmitCount: number;
};
const rigCanvas='#rig-root canvas';
const rigReadback=()=>page!.evaluate<RigReadback>(`(()=>{
 const visible=node=>!!node&&node.checkVisibility()&&node.getClientRects().length>0;
 const form=document.querySelector(${JSON.stringify(visibleForm)});
 const nav=form?.querySelector('nav.interview-questions');
 const submit=nav?.querySelector('[data-job-questions-submit]');
 const canvases=[...document.querySelectorAll('${rigCanvas}')].filter(visible);
 const controls=[...document.querySelectorAll('${root} [data-job-questions-submit]')];
 return {language:document.documentElement.lang,viewport:{width:innerWidth,height:innerHeight},
  communication:!!form?.closest('#workspace-communication'),visibleCanvasCount:canvases.length,
  sameCanvas:canvases[0]===window.optionSetsRigCanvas,visibleAsk:form?.dataset.jobAsk??null,
  checked:form?.querySelector('input[type=radio]:checked')?.value??null,
  rows:[...(nav?.querySelectorAll('button.interview-question')??[])].map(row=>({text:row.textContent,
   checkmark:row.hasAttribute('data-answered')&&getComputedStyle(row,'::before').content.includes('✓'),
   current:row.getAttribute('aria-current')==='true',visible:visible(row)})),
  submit:submit?{text:submit.textContent,disabled:submit.disabled,first:nav.firstElementChild===submit}:null,
  visibleSubmitCount:controls.filter(visible).length};
})()`);

async function groupedRigCase(language:'en'|'ko'){
 const catalog=language==='ko'?koCatalog:enCatalog;
 const label=(n:number)=>catalog['interview.submitAnswered']!.replace('{0}',String(n)).replace('{1}','3');
 const out=join(output,'owner-look',language);
 await mkdir(out,{recursive:true});
 const fixture=await optionSetsJobFixture({count:3,boundRig:true});
 const asks=fixture.asks.map(ask=>ask.askId);
 const sets=fixture.workspace.result.sets!;
 const pending=()=>fixture.session.status().pending.map(ask=>ask.askId);
 async function capture(name:string,selected:number,answered:boolean[],submitDisabled:boolean){
  await page!.evaluate<void>(`document.querySelector('#workspace-communication').scrollTop=0;`);
  const readback=await rigReadback();
  await writeFile(join(out,name+'.png'),await page!.screenshot());
  await writeFile(join(out,name+'.json'),JSON.stringify(readback,null,2)+'\n');
  assert.deepEqual(readback.viewport,{width:1440,height:900});
  assert.equal(readback.language,language);
  assert.equal(readback.communication,true);
  assert.equal(readback.visibleCanvasCount,1);
  assert.equal(readback.sameCanvas,true);
  assert.equal(readback.visibleAsk,asks[selected]);
  assert.deepEqual(readback.rows,sets.map((set,index)=>({text:`${set.questionId} · ${set.setId}`,
   checkmark:answered[index],current:index===selected,visible:true})));
  assert.equal(readback.visibleSubmitCount,1);
  assert.deepEqual(readback.submit,{text:label(answered.filter(Boolean).length),disabled:submitDisabled,first:true});
  return readback;
 }
 try{
  const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
  await page!.setViewport(1440,900);
  await page!.goto('about:blank');await page!.goto(url.href,language);
  const refusal='[role="status"][title="JOB_DISPLAY_MISMATCH"], #review-message[title="JOB_DISPLAY_MISMATCH"]';
  await wait(`!!document.querySelector(${JSON.stringify(refusal)}) || (document.body.dataset.ready==='true' &&
   document.querySelector('#player-state')?.textContent===${JSON.stringify(catalog['@rig-c/play · Actual rig'])} &&
   document.querySelector('#animation-select')?.value==='idle' && document.querySelector('#rig-empty')?.hidden===true &&
   document.querySelectorAll('${root} form[data-job-ask]').length===3 &&
   !!document.querySelector('${visibleForm} [data-job-questions-submit]') &&
   document.querySelector('${visibleForm} .interview-answer-fields')?.disabled===false)`,'grouped rig '+language);
  const refusalCode=await page!.evaluate<string|null>(`document.querySelector(${JSON.stringify(refusal)})?.title??null`);
  assert.equal(refusalCode,null,`${language} grouped rig preparation refused: ${refusalCode}`);
  await page!.evaluate<void>(`window.optionSetsRigCanvas=[...document.querySelectorAll('${rigCanvas}')].find(node=>node.checkVisibility());`);
  assert.deepEqual(pending(),asks);
  const opened=await capture('01-open-0-of-3',0,[false,false,false],true);
  const selectedRows: {index:number;ask:string|null;sameCanvas:boolean}[]=[];
  const picks: (string|null)[]=[];
  for(const index of [0,1,2]){
   await selectRow(index);
   const readback=await rigReadback();
   assert.equal(readback.visibleAsk,asks[index]);
   assert.equal(readback.sameCanvas,true);
   selectedRows.push({index,ask:readback.visibleAsk,sameCanvas:readback.sameCanvas});
   if(index<2){await answerShown();picks.push((await rigReadback()).checked);}
  }
  const ready=await capture('02-ready-2-of-3',2,[true,true,false],false);
  assert.equal(ready.checked,null);
  await clickVisible(`${visibleForm} [data-job-questions-submit]`);
  await waitFor(()=>pending().length===1,'grouped rig partial submit '+language);
  await wait(`[...document.querySelectorAll('${root} form[data-job-ask]')].filter(form=>form.dataset.interviewAnswered==='true').length===2`,'grouped rig saved forms '+language);
  const pendingAfterSubmit=pending();
  assert.deepEqual(pendingAfterSubmit,asks.slice(2));
  const formsAfterSubmit=(await state()).forms;
  assert.deepEqual(formsAfterSubmit.map(form=>[form.answered,form.editable]),[[true,false],[true,false],[false,true]]);
  await selectRow(2);
  const partial=await capture('03-partial-third-pending',2,[true,true,false],true);
  assert.equal(partial.checked,null);
  await answerShown();
  const edited=await rigReadback();
  assert.ok(edited.checked,'the third set still accepts a pick');
  assert.equal(edited.sameCanvas,true);
  assert.deepEqual(edited.submit,{text:label(3),disabled:false,first:true});
  assert.deepEqual(pending(),pendingAfterSubmit);
  const {events}=await fixture.readEvents();
  const acts=events.flatMap(event=>event.type==='act'?[event.act]:[]).map(act=>{
   assert.equal(act.schema,JOB_COMMENTS_ACT_SCHEMA);
   assert.equal(act.kind,'interview-picks');
   return {ask:act.askId,publication:act.publicationId,sourceHash:act.source.sourceHash,
    question:act.value.questionId,selections:act.value.selections};
  });
  assert.deepEqual(acts.sort((a,b)=>asks.indexOf(a.ask)-asks.indexOf(b.ask)),sets.slice(0,2).map((set,index)=>({
   ask:asks[index],publication:fixture.publication.publicationId,sourceHash:fixture.publication.source.sourceHash,
   question:set.questionId,selections:[{itemId:set.questionId,optionId:picks[index],otherText:null}],
  })));
  const observation={language,opened,selectedRows,ready,partial,edited,formsAfterSubmit,pendingAfterSubmit,acts};
  await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');
  console.log('1101_GROUPED_RIG_CASE '+JSON.stringify({language,rows:partial.rows.length,acts:acts.length,pending:pendingAfterSubmit.length}));
  return observation;
 }catch(error){
  await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),dom:await rigReadback().catch(()=>null)},null,2)+'\n');
  await writeFile(join(out,'failure.png'),await page!.screenshot()).catch(()=>{});
  throw error;
 }finally{await page!.goto('about:blank');await fixture.close();}
}

try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:async(event,send)=>{
  if(event.method==='Runtime.consoleAPICalled'&&event.params?.type==='error')consoleErrors.push(event.params);
  if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);
  if(event.sessionId)control=(method,params)=>(send as any)(method,params,event.sessionId);
  if(event.method==='Fetch.requestPaused'){const paused=event.params as {requestId:string;request:{postData?:string}};
   let ask:string|undefined;try{ask=JSON.parse(paused.request.postData??'{}').askId;}catch{}
   if(refuseAsk&&ask===refuseAsk&&!heldRequest)heldRequest=paused.requestId;
   else await (send as any)('Fetch.continueRequest',{requestId:paused.requestId},event.sessionId);}}});
 if(!rigOnly)for(const language of ['en','ko'] as const){
  const catalog=language==='ko'?koCatalog:enCatalog,label=(n:number)=>catalog['interview.submitAnswered']!.replace('{0}',String(n)).replace('{1}','4');
  const fixture=await optionSetsJobFixture({count:4,answered:2}),out=join(output,language);await mkdir(out,{recursive:true});
  try{
   const asks=fixture.asks.map(ask=>ask.askId),acts=()=>fixture.session.status().pending.length;
   assert.equal(acts(),4);
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
   await page.setViewport(1440,900);await page.goto('about:blank');await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&document.querySelectorAll('${root} form[data-job-ask]').length===4&&!!document.querySelector('${visibleForm} [data-job-questions-submit]')`,'four forms');
   const before=await state();
   assert.deepEqual(before.forms.map(f=>f.ask),asks);
   assert.equal(before.forms.filter(f=>f.visible).length,1,JSON.stringify(before.forms));
   assert.deepEqual(before.rows.map(r=>r.answered),[true,true,false,false]);
   assert.deepEqual(before.action,{text:label(2),disabled:false,first:true,visible:true});
   // The header says the interview sentence once for four pending asks (HQ ruling on #1004).
   assert.equal(await headline(),catalog['Answer these questions.']);
   await writeFile(join(out,'before-2-of-4.png'),await page.screenshot());
   // Selecting another row shows that set's form; the list and its one submit stay at the top.
   await selectRow(0);
   const selected=await state();
   assert.equal(selected.forms.findIndex(f=>f.visible),0);assert.deepEqual(selected.action,before.action);
   assert.deepEqual(selected.rows,[{answered:true,current:true},{answered:true,current:false},{answered:false,current:false},{answered:false,current:false}]);
   // Partial submit: two acts, the other two asks stay pending, on the page and editable.
   await clickVisible(`${visibleForm} [data-job-questions-submit]`);
   await waitFor(()=>acts()===2,'two acts');
   assert.deepEqual(fixture.session.status().pending.map(ask=>ask.askId),asks.slice(2));
   await wait(`[...document.querySelectorAll('${root} form[data-job-ask]')].filter(f=>f.dataset.interviewAnswered==='true').length===2`,'two answered forms');
   const after=await state();
   assert.deepEqual(after.forms.map(f=>[f.answered,f.editable]),[[true,false],[true,false],[false,true],[false,true]]);
   assert.deepEqual(after.rows.map(r=>r.answered),[true,true,false,false]);
   assert.deepEqual(after.action,{text:label(2),disabled:true,first:true,visible:true});
   assert.equal(await headline(),catalog['Answer these questions.']);
   await writeFile(join(out,'after-partial-submit.png'),await page.screenshot());
   // Answer the remaining two later and submit: two more acts, nothing pending.
   for(const index of [2,3]){await selectRow(index);await answerShown();}
   await wait(`document.querySelector('${visibleForm} [data-job-questions-submit]')?.textContent===${JSON.stringify(label(4))}`,'four ready');
   assert.equal((await state()).action?.disabled,false);
   await clickVisible(`${visibleForm} [data-job-questions-submit]`);
   await waitFor(()=>acts()===0,'four acts');
   const sources=fixture.session.status();
   const observation={language,asks,before,selected,after,pendingAfter:sources.pending.length};
   await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');
   console.log('1004_BROWSER_CASE '+JSON.stringify({language,before:before.action?.text,after:after.action,pending:sources.pending.length}));
   cases.push(observation);
  }finally{await page.goto('about:blank');await fixture.close();}
 }
 if(!rigOnly)for(const language of ['en','ko'] as const){
  const catalog=language==='ko'?koCatalog:enCatalog,label=(n:number)=>catalog['interview.submitAnswered']!.replace('{0}',String(n)).replace('{1}','4');
  const fixture=await optionSetsJobFixture({count:4,answered:2}),out=join(output,language);await mkdir(out,{recursive:true});
  try{
   const asks=fixture.asks.map(ask=>ask.askId),pending=()=>fixture.session.status().pending.map(ask=>ask.askId);
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
   await page.setViewport(1440,900);await page.goto('about:blank');await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&document.querySelectorAll('${root} form[data-job-ask]').length===4&&!!document.querySelector('${visibleForm} [data-job-questions-submit]')`,'retry four forms');
   assert.deepEqual((await state()).action,{text:label(2),disabled:false,first:true,visible:true});
   const actionWidth=()=>page!.evaluate<number>(`document.querySelector('${visibleForm} [data-job-questions-submit]').getBoundingClientRect().width`);
   const readyWidth=await actionWidth();
   // Hold the second set's request until the first set has landed, then refuse it: the refusal settles last.
   assert.ok(control);refuseAsk=asks[1];heldRequest=undefined;
   await control('Fetch.enable',{patterns:[{urlPattern:'*ui/acts*',requestStage:'Request'}]});
   await clickVisible(`${visibleForm} [data-job-questions-submit]`);
   await waitFor(()=>pending().length===3&&!!heldRequest,'one act landed, one request held');
   assert.deepEqual(pending(),asks.slice(1));
   await wait(`document.querySelectorAll('${root} form[data-job-ask]')[0].dataset.interviewAnswered==='true'`,'first set answered');
   const heldAction=(await state()).action;
   const heldWidth=await actionWidth();
   console.log('1153_SHARED '+JSON.stringify({language,heldAction,readyWidth,heldWidth,pending:pending().length}));
   if(!heldAction?.disabled||heldAction.text!==catalog['Sending'])
    sendingFailures.push(`${language} shared: Sending stays disabled after the first set settles`);
   if(heldWidth!==readyWidth)sendingFailures.push(`${language} shared: button width stays fixed during POST`);
   await control('Fetch.fulfillRequest',{requestId:heldRequest!,responseCode:409,responseHeaders:[{name:'Content-Type',value:'application/json'}],
    body:Buffer.from(JSON.stringify({ok:false,error:{code:'JOB_ACT_INVALID',message:'JOB_ACT_INVALID'}})).toString('base64')});
   refuseAsk=undefined;await control('Fetch.disable');
   await wait(`!document.querySelectorAll('${root} form[data-job-ask]')[1].querySelector('fieldset').disabled`,'refused set editable again');
   const refused=await state();
   assert.deepEqual(refused.forms.map(f=>[f.answered,f.editable]),[[true,false],[false,true],[false,true],[false,true]]);
   assert.deepEqual(pending(),asks.slice(1));
   assert.deepEqual(refused.action,{text:label(2),disabled:false,first:true,visible:true},'shared submit re-enables after one set is refused');
   await writeFile(join(out,'after-refused-set.png'),await page.screenshot());
   await clickVisible(`${visibleForm} [data-job-questions-submit]`);
   await waitFor(()=>pending().length===2,'retried act');
   assert.deepEqual(pending(),asks.slice(2));
   await wait(`document.querySelectorAll('${root} form[data-job-ask]')[1].dataset.interviewAnswered==='true'`,'retried set answered');
   const retried=await state();
   assert.deepEqual(retried.action,{text:label(2),disabled:true,first:true,visible:true});
   const observation={language,case:'retry',asks,refused,retried,pendingAfter:pending().length};
   await writeFile(join(out,'retry-observations.json'),JSON.stringify(observation,null,2)+'\n');
   console.log('1004_BROWSER_RETRY_CASE '+JSON.stringify({language,refused:refused.action,retried:retried.action,pending:pending().length}));
   cases.push(observation);
  }finally{refuseAsk=undefined;if(heldRequest)await control?.('Fetch.disable').catch(()=>{});await page.goto('about:blank');await fixture.close();}
 }
 if(!rigOnly)for(const language of ['en','ko'] as const)
  for(const outcome of ['success','stale','network'] as const)await singleSetSubmission(language,outcome);
 const rigFailures: string[]=[];
 for(const language of ['en','ko'] as const){
  try{cases.push(await groupedRigCase(language));}
  catch(error){rigFailures.push(String(error));console.error('1101_GROUPED_RIG_RED '+language+' '+String(error));}
 }
 assert.deepEqual(rigFailures,[],'grouped rig browser scenario failed');
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));
 assert.deepEqual(sendingFailures,[],'1153 interview submission feedback');
 assert.equal(consoleErrors.length,0,JSON.stringify(consoleErrors));
 const result={cases:cases.length,languages:['en','ko'],exceptions:exceptions.length,consoleErrors:consoleErrors.length};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('1004_BROWSER_PASS '+JSON.stringify(result));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,consoleErrors,sendingFailures,cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
