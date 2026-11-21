/** #1004 ordinary Nova browser check: one record publication with K = 4 option sets on the real job page.
 * The question list shows the four sets with one "Submit review (n/4)" at its top. Submit sends only the answered
 * sets, one interview-picks act each; the rest stay pending and editable, and are submitted later. EN and KO.
 * Retry case: of two sets sent by one click, one request is refused after the other lands; the shared submit
 * re-enables, still counts both, and the refused set stays pending and submits on the next click. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {optionSetsJobFixture} from './helpers/job-record-screen-fixture.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const output=resolve(arg('--out')??'artifacts/job-option-sets-1004');await mkdir(output,{recursive:true});
const root='#workspace-interview-answer';
const headline=()=>page!.evaluate<string>(`document.querySelector('#workspace-ask-headline').textContent`);
type ListState={forms:{ask:string;visible:boolean;answered:boolean;editable:boolean}[];rows:{answered:boolean;current:boolean}[];
 action:{text:string;disabled:boolean;first:boolean;visible:boolean}|null;actions:number};
const profile=await mkdtemp(join(tmpdir(),'review-1004-browser-'));
const exceptions:unknown[]=[],consoleErrors:unknown[]=[],cases:unknown[]=[];
let page:InputCdpSession|undefined;
let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined;
/** The one ui/acts request held for the retry case, by its ask; every other request goes through. */
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

try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:async(event,send)=>{
  if(event.method==='Runtime.consoleAPICalled'&&event.params?.type==='error')consoleErrors.push(event.params);
  if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);
  if(event.sessionId)control=(method,params)=>(send as any)(method,params,event.sessionId);
  if(event.method==='Fetch.requestPaused'){const paused=event.params as {requestId:string;request:{postData?:string}};
   let ask:string|undefined;try{ask=JSON.parse(paused.request.postData??'{}').askId;}catch{}
   if(refuseAsk&&ask===refuseAsk&&!heldRequest)heldRequest=paused.requestId;
   else await (send as any)('Fetch.continueRequest',{requestId:paused.requestId},event.sessionId);}}});
 for(const language of ['en','ko'] as const){
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
 for(const language of ['en','ko'] as const){
  const catalog=language==='ko'?koCatalog:enCatalog,label=(n:number)=>catalog['interview.submitAnswered']!.replace('{0}',String(n)).replace('{1}','4');
  const fixture=await optionSetsJobFixture({count:4,answered:2}),out=join(output,language);await mkdir(out,{recursive:true});
  try{
   const asks=fixture.asks.map(ask=>ask.askId),pending=()=>fixture.session.status().pending.map(ask=>ask.askId);
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
   await page.setViewport(1440,900);await page.goto('about:blank');await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&document.querySelectorAll('${root} form[data-job-ask]').length===4&&!!document.querySelector('${visibleForm} [data-job-questions-submit]')`,'retry four forms');
   assert.deepEqual((await state()).action,{text:label(2),disabled:false,first:true,visible:true});
   // Hold the second set's request until the first set has landed, then refuse it: the refusal settles last.
   assert.ok(control);refuseAsk=asks[1];heldRequest=undefined;
   await control('Fetch.enable',{patterns:[{urlPattern:'*ui/acts*',requestStage:'Request'}]});
   await clickVisible(`${visibleForm} [data-job-questions-submit]`);
   await waitFor(()=>pending().length===3&&!!heldRequest,'one act landed, one request held');
   assert.deepEqual(pending(),asks.slice(1));
   await wait(`document.querySelectorAll('${root} form[data-job-ask]')[0].dataset.interviewAnswered==='true'`,'first set answered');
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
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));
 assert.equal(consoleErrors.length,0,JSON.stringify(consoleErrors));
 const result={cases:cases.length,languages:['en','ko'],exceptions:exceptions.length,consoleErrors:consoleErrors.length};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('1004_BROWSER_PASS '+JSON.stringify(result));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,consoleErrors,cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
