/** #715 ordinary Nova: shared Comments, source-bound record drafts and mixed rig asks.
 * #1229: converted from the retired checkpoint Pass/Fail form and secondary #workspace-pending-record-ask opener
 * to verifying plan record comment-only acts (act@10), fresh checkpoint ask refusals, Question-only package asks, and read-only copied links. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {realJobWindowFixture,scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession,type CdpPageEvent,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {feedbackItemComments,projectComments} from '../src/stage-comment.ts';
import {parseCommentOnlyAct,parseCommentsAct} from '../src/job-api.ts';
import {JOB_API_SCHEMA,type JobDisplayAcknowledgment,type JobDisplayReceipt,type JobResult,type PendingAskV3,type PublicationV3,type UISubmissionV3} from '../src/job-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {tr} from '../web/i18n.ts';
const arg=(key:string)=>{const at=Bun.argv.indexOf(key);return at<0?undefined:Bun.argv[at+1];};
const restsOnQuestions=Bun.argv.includes('--rests-on-questions');
const modalPreload=Bun.argv.includes('--modal-preload');
const holdMixedDisplayed=Bun.argv.includes('--hold-mixed-displayed');
const plain715=Bun.argv.includes('--plain-715');
const heldRecordOnly=Bun.argv.includes('--held-record-receipt');
const output=resolve(arg('--out')??(heldRecordOnly?'.captures/1260':'artifacts/715'));await mkdir(output,{recursive:true});
if(Bun.argv.includes('--serve')){
 const kinds=(arg('--kind')?[arg('--kind')]:['checkpoint']) as RecordScreenKind[];
 const fixtures=[];
 for(const kind of kinds){const fixture=await recordScreenFixture(kind,true);fixtures.push(fixture);const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',arg('--lang')??'en');console.log(JSON.stringify({url:url.href,pid:process.pid,kind,sourceHash:fixture.display.publication.source.sourceHash,fixture:'synthetic trusted record host; shared screen'}));}
 await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});for(const fixture of fixtures)await fixture.close();process.exit(0);
}
const profile=await mkdtemp(join(tmpdir(),'review-715-browser-'));let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const visualRequests:{id:string;path:string;status?:number}[]=[];
const errors:unknown[]=[],cases:unknown[]=[],commentPosts:string[]=[],actTransport:{method:string;path:string}[]=[];
const dialogViewer='dialog :is(.viewport,.interview-view,.interview-viewport,#reference-content,#rig-viewport,#zoom-in,#zoom-out,#fit,#native-one,#view-menu)';
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('715_WAIT '+label);}
async function shot(out:string,name:string){await writeFile(join(out,name+'.png'),await page!.screenshot());}
type ObservedPost={id:string;postData?:string;networkId?:string};
function observeMixedDisplay(owner:URL){
 const url=new URL('ui/displayed',owner).href,actUrl=new URL('ui/acts',owner).href;
 let onHeld!:(post:ObservedPost)=>void,onFinished!:(failure?:string)=>void;
 const held=new Promise<ObservedPost>(resolve=>{onHeld=resolve;});
 const finished=new Promise<string|undefined>(resolve=>{onFinished=resolve;});
 const requests:ObservedPost[]=[],acts:ObservedPost[]=[];
 let status:number|undefined;
 return {url,held,finished,requests,acts,get status(){return status;},observe({method,params}:CdpPageEvent){
  if(!params)return;
  const id=String(params.requestId),request=params.request as {method:string;url:string;postData?:string}|undefined;
  if(request?.method==='POST'){
   const post={id,postData:request.postData};
   if(method==='Fetch.requestPaused'&&request.url===url)onHeld({...post,networkId:params.networkId as string|undefined});
   if(method==='Network.requestWillBeSent'){
    if(request.url===url)requests.push(post);
    if(request.url===actUrl)acts.push(post);
   }
  }
  if(id!==requests[0]?.id)return;
  if(method==='Network.responseReceived')status=(params.response as {status:number}).status;
  if(method==='Network.loadingFinished')onFinished();
  if(method==='Network.loadingFailed')onFinished(String(params.errorText));
 }};
}
let mixedDisplay:ReturnType<typeof observeMixedDisplay>|undefined;
async function postData<T>(post:ObservedPost):Promise<T>{
 const body=post.postData??(await command!('Network.getRequestPostData',{requestId:post.networkId??post.id}) as {postData:string}).postData;
 return JSON.parse(body) as T;
}
type SaveClicks={ready:boolean;earlyClicks:number;trustedSaveClicks:number};
type HeldDisplay=SaveClicks&{acts:number;actPosts:number;labelDisplayed:boolean};
const saveClicks='globalThis.__mixedSaveClicks';
const countSaveClicks=`(()=>{
 const counts=${saveClicks}={ready:false,earlyClicks:0,trustedSaveClicks:0};
 document.addEventListener('click',event=>{
  const save=document.getElementById('save');
  if(!event.isTrusted||!save||!event.composedPath().includes(save))return;
  counts.trustedSaveClicks++;
  if(!counts.ready)counts.earlyClicks++;
 },true);
})()`;
async function waitForMixedDisplay(display:ReturnType<typeof observeMixedDisplay>,
 expected:Pick<JobDisplayAcknowledgment,'publicationId'|'sourceHash'>,label:string):Promise<JobDisplayReceipt>{
 const failure=await withDeadline('715 mixed displayed response',20_000,()=>display.finished);
 assert.equal(failure,undefined,'displayed response finished');
 assert.equal(display.status,200,'displayed response succeeded');
 assert.equal(display.requests.length,1,'one displayed POST for the active publication');
 const post=display.requests[0]!;
 const request=await postData<JobDisplayAcknowledgment>(post);
 assert.ok(request?.publicationId===expected.publicationId&&request.sourceHash===expected.sourceHash&&request.pageId,
  'displayed POST identifies the active publication, source and page');
 const {body,base64Encoded}=await command!('Network.getResponseBody',{requestId:post.id}) as {body:string;base64Encoded:boolean};
 const result=JSON.parse(base64Encoded?Buffer.from(body,'base64').toString('utf8'):body) as JobResult<JobDisplayReceipt>;
 assert.ok(result.ok&&result.value.publicationId===expected.publicationId&&result.value.pageId===request.pageId&&result.value.displayedNonce,
  'displayed response carries the exact publication and page receipt');
 // The fresh mixed screen emits this footer label from changed() after installing the receipt and clearing preparing.
 await page!.evaluate(`new Promise(resolve=>{
  const node=document.getElementById('message');
  if(!node)throw new Error('715 mixed display status missing');
  const observer=new MutationObserver(check);
  function check(){if(node.textContent!==${JSON.stringify(label)})return;observer.disconnect();${saveClicks}.ready=true;resolve(true);}
  observer.observe(node,{childList:true,characterData:true,subtree:true});check();
 })`);
 return result.value;
}
const bottomState=`(()=>{const i=document.getElementById('workspace-inspector');return JSON.stringify({hidden:i?.hidden??null,rows:getComputedStyle(document.querySelector('.layout').parentElement).gridTemplateRows,height:Math.round(i?.getBoundingClientRect().height??0),tab:document.querySelector('.block-row [aria-selected=true]')?.dataset.blockTarget??null});})()`;
const removedAnswerSelector='form.interview'+'-answer';
const generalCommentButton='#stage-comment-list button[data-comment-general]';
function observeRecordDisplay(url:string,publicationId:string,sourceHash:string,selector:string){
 const fetcher=window.fetch.bind(window);
 let settle!:(failure:string|null)=>void;
 const ready=new Promise<string|null>(resolve=>{settle=resolve;});
 Object.assign(window,{__recordCommentsReady715:ready,fetch(input:RequestInfo|URL,init?:RequestInit){
  const pending=fetcher(input,init);
  if(typeof input!=='string'||init?.method!=='POST'||typeof init.body!=='string'||new URL(input,location.href).href!==url)return pending;
  const request=JSON.parse(init.body) as JobDisplayAcknowledgment;
  if(request.publicationId!==publicationId||request.sourceHash!==sourceHash||!request.pageId)return pending;
  return pending.then(response=>{
   if(response.status!==200||response.url!==url)return response;
   const json=response.json.bind(response);
   response.json=async()=>{
    const result=await json() as JobResult<JobDisplayReceipt>;
    if(result.ok&&result.value.publicationId===publicationId&&result.value.pageId===request.pageId&&result.value.displayedNonce){
     const original=document.querySelector<HTMLButtonElement>(selector),list=original?.parentElement;
     if(!original||!list)settle('Add general missing before display receipt');
     else{
      let removed=false;
      const observer=new MutationObserver(records=>{
       removed ||= records.some(record=>Array.from(record.removedNodes).includes(original));
      });
      observer.observe(list,{childList:true});
      // Yield the real receipt to the app. Its acknowledgment continuations run before the next task.
      const {port1,port2}=new MessageChannel();
      port1.onmessage=()=>{
       observer.disconnect();port1.close();port2.close();
       const current=document.querySelector<HTMLButtonElement>(selector);
       settle(!init.signal?.aborted&&removed&&!original.isConnected&&current?.parentElement===list&&!current.disabled
        ?null:'Add general was not replaced with an enabled button after display receipt');
      };
      port2.postMessage(null);
     }
    }
    return result;
   };
   return response;
  });
 }});
}
async function openRecord(url:URL,{publicationId,source:{sourceHash}}:PublicationV3){
 const args=[new URL('ui/displayed',url).href,publicationId,sourceHash,generalCommentButton];
 const source=`(${observeRecordDisplay.toString()})(...${JSON.stringify(args)})`;
 const {identifier}=await command!('Page.addScriptToEvaluateOnNewDocument',{source}) as {identifier:string};
 try{await page!.goto(url.href);}finally{await command!('Page.removeScriptToEvaluateOnNewDocument',{identifier});}
}
async function ensureComment(){if(await page!.evaluate(`document.getElementById('stage-comment')?.getAttribute('aria-pressed')!=='true'`))await click(page!,'#stage-comment');}
async function addGeneral(text:string){
 const failure=await withDeadline('715 record Comments list finalized',20_000,()=>page!.evaluate<string|null>('window.__recordCommentsReady715'));
 assert.equal(failure,null,'record Comments ready after the exact display acknowledgment');
 await click(page!,generalCommentButton);await wait(`!!document.querySelector('.stage-comment-composer input')`,'general composer');await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'general saved');
}

const composerSelector='.stage-comment-composer';
const commentRows=`[...document.querySelectorAll('#stage-comment-list [data-comment-id]')].map(row=>({id:row.dataset.commentId,text:row.querySelector('.stage-comment-summary').textContent}))`;
function watchOpenComposer(selector:string,generalButton:string){
 const form=document.querySelector<HTMLFormElement>(selector)!;
 const field=form.querySelector<HTMLInputElement>('input')!;
 const list=document.getElementById('stage-comment-list')!;
 const pane=form.parentElement;
 const rowSelector=':scope > :is([data-comment-id], p)';
 const add=document.querySelector(generalButton);
 const row=list.querySelector(rowSelector);
 const tracked=new Set<Node>([field,form]);
 for(let ancestor=pane;ancestor;ancestor=ancestor.parentElement)tracked.add(ancestor);
 let removals=0,focusLosses=0,trustedInputs=0;
 const observe=(records:MutationRecord[])=>{
  for(const {removedNodes} of records)for(const node of Array.from(removedNodes))if(tracked.has(node))removals++;
 };
 // Observe ancestors too. Comparing connected nodes only before and after would miss a remove/reinsert.
 const observer=new MutationObserver(observe);
 observer.observe(document,{childList:true,subtree:true});
 field.addEventListener('blur',()=>focusLosses++);
 field.addEventListener('input',event=>{if(event.isTrusted)trustedInputs++;});
 return ()=>{
  observe(observer.takeRecords());
  return {sameForm:document.querySelector(selector)===form,sameField:form.querySelector('input')===field,
   connected:form.isConnected&&field.isConnected,location:form.parentElement?.id,focused:document.activeElement===field,
   editable:!field.readOnly&&!field.disabled,text:field.value,selection:[field.selectionStart,field.selectionEnd],
   removals,focusLosses,trustedInputs,listRefreshed:!!add&&!add.isConnected&&!!row&&!row.isConnected&&
    !!document.querySelector(generalButton)&&!!list.querySelector(rowSelector)};
 };
}
type ComposerState=ReturnType<ReturnType<typeof watchOpenComposer>>;
const composerState=()=>page!.evaluate<ComposerState>('window.__receiptComposer1260()');

function holdRecordReceipt(fixture:Awaited<ReturnType<typeof recordScreenFixture>>){
 const {publication}=fixture.display,acknowledge=fixture.ports.ackDisplayed;
 let capture!:(value:{result:JobResult<JobDisplayReceipt>;request:JobDisplayAcknowledgment;authorized:boolean})=>void;
 let release!:()=>void;
 const held=new Promise<Parameters<typeof capture>[0]>(resolve=>{capture=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 fixture.ports.ackDisplayed=async(jobId,request)=>{
  const body=await request.clone().json() as JobDisplayAcknowledgment;
  const result=await acknowledge(jobId,request);
  if(body.publicationId===publication.publicationId&&body.sourceHash===publication.source.sourceHash){
   capture({result,request:body,authorized:request.headers.has('X-Review-Capability')});
   await gate;
  }
  return result;
 };
 return {held,release,restore(){fixture.ports.ackDisplayed=acknowledge;release();}};
}

async function pressComposerKey(key:'ArrowLeft'|'Enter'|'Escape'){
 const windowsVirtualKeyCode={ArrowLeft:37,Enter:13,Escape:27}[key];
 for(const type of ['keyDown','keyUp'])await command!('Input.dispatchKeyEvent',{
  type,key,code:key,windowsVirtualKeyCode,...(key==='Enter'&&type==='keyDown'?{text:'\r'}:{}),
 });
}

async function recordComposerReceiptCase(language:'en'|'ko'){
 const out=join(output,'held-record-receipt',language);
 await mkdir(out,{recursive:true});
 const fixture=await recordScreenFixture('checkpoint',true,out);
 const trace:Record<string,unknown>={language};
 const text=language==='en'?'Keep this exact draft · EN':'이 댓글을 그대로 남겨요 · KO';
 const catalog=language==='en'?enCatalog:koCatalog;
 const {publicationId,source:{sourceHash}}=fixture.display.publication;
 const rows=()=>page!.evaluate<{id:string;text:string}[]>(commentRows);
 const actPostCount=()=>actTransport.filter(row=>row.path===`/jobs/${fixture.session.jobId}/ui/acts`).length;
 const evidence=()=>writeFile(join(out,'observations.json'),JSON.stringify(trace,null,2)+'\n');
 async function refreshWithComposer(owner:boolean,draft:string){
  const mode=owner?'pinned':'copied',url=new URL(fixture.ownerUrl);
  url.searchParams.set('lang',language);
  if(!owner)url.hash='';
  const hold=holdRecordReceipt(fixture);
  try{
   await page!.goto(url.href);
   await wait(`globalThis.__access756==='pending'`,`${mode} rig access`);
   await page!.evaluate(`globalThis.__releaseAccess756()`);
   const {result,request,authorized}=await withDeadline(`1260 ${mode} held displayed receipt`,20_000,()=>hold.held);
   assert.equal(authorized,owner);
   assert.ok(result.ok&&request.pageId&&result.value.pageId===request.pageId&&
    result.value.publicationId===publicationId&&result.value.displayedNonce,'receipt for exact displayed record and page');
   await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#rig-root canvas')`,`${mode} rig mounted`);
   assert.equal(await page!.evaluate('document.documentElement.lang'),language);
   if(!owner)assert.equal(await page!.evaluate(`document.getElementById('message')?.textContent`),catalog['Read-only view: reopen with rig-review open to edit.']);
   await ensureComment();
   const target=owner?'#rig-viewport.stage-comment-mode':generalCommentButton;
   await wait(`document.querySelector(${JSON.stringify(target)})?.checkVisibility()`,`${mode} composer opener`);
   await click(page!,target);
   await wait(`!!document.querySelector('${composerSelector} input')`,`${mode} composer opened with receipt held`);
   await page!.evaluate(`void (window.__receiptComposer1260=(${watchOpenComposer.toString()})(${JSON.stringify(composerSelector)},${JSON.stringify(generalCommentButton)}))`);
   await command!('Input.insertText',{text:draft});
   await pressComposerKey('ArrowLeft');
   const before=await composerState(),beforeRows=await rows();
   const phase={receiptHeldAtOpen:true,authorized,before,beforeRows,after:undefined as ComposerState|undefined,afterRows:undefined as typeof beforeRows|undefined};
   trace[mode]=phase;
   const expected={sameForm:true,sameField:true,connected:true,location:owner?'rig-viewport':'stage-comment-list',
    focused:true,editable:true,text:draft,selection:[draft.length-1,draft.length-1],removals:0,focusLosses:0,trustedInputs:1,listRefreshed:false};
   assert.deepEqual(before,expected,`${mode} trusted typing and interior caret before receipt release`);
   assert.equal(beforeRows.length,owner?1:0);
   assert.equal(actPostCount(),0);
   await shot(out,`${mode}-held`);
   hold.release();
   await wait(`window.__receiptComposer1260().listRefreshed`,`${mode} receipt refreshed neighboring list rows`);
   phase.after=await composerState();
   phase.afterRows=await rows();
   assert.deepEqual(phase.after,{...expected,listRefreshed:true},`${mode} composer survives the receipt refresh without losing focus, caret or draft`);
   assert.deepEqual(phase.afterRows,beforeRows,`${mode} refresh preserves the comment rows`);
   await shot(out,`${mode}-refreshed`);
   return result.value;
  }finally{hold.restore();}
 }

 try{
  // Replay only the active publication. The retained backdrop is still available by ID, and no pending event can race the receipt refresh.
  const recordEvent=fixture.fake.events.find(event=>event.type==='published'&&event.publication.publicationId===publicationId);
  assert.ok(recordEvent);
  fixture.fake.events.splice(0,fixture.fake.events.length,recordEvent);
  const before=await jobInputHashes(fixture.root);
  const copiedReceipt=await refreshWithComposer(false,text);
  await pressComposerKey('Enter');
  await wait(`!document.querySelector('${composerSelector}')`, '1260 copied general saved locally');
  const localRows=await rows(),row=localRows[0];
  assert.ok(row?.id);
  assert.deepEqual(localRows,[{id:row.id,text:`1 · ${catalog['General comment']} · ${text}`}]);
  const drafts=await page!.evaluate<{publicationId:string;sourceHash:string;comments:unknown[]}[]>(
   `Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-record-comments/1:')).map(([,value])=>JSON.parse(value))`);
  assert.equal(drafts.length,1);
  assert.equal(drafts[0]!.publicationId,publicationId);
  assert.equal(drafts[0]!.sourceHash,sourceHash);
  assert.deepEqual(drafts[0]!.comments,[{id:row.id,summary:text}]);
  assert.equal(await page!.evaluate(`document.getElementById('send-comments')?.disabled`),true,'copied link keeps Send comments disabled');
  const copiedPosts=actPostCount();
  assert.equal(copiedPosts,0);
  assert.equal(fixture.submissions.length,0);
  trace.copiedSave={localDraftRows:drafts[0]!.comments,actPosts:copiedPosts,sendDisabled:true};
  await shot(out,'copied-local-draft');

  await page!.goto('about:blank');
  const ownerReceipt=await refreshWithComposer(true,'Unsent pin · '+language);
  assert.notEqual(ownerReceipt.pageId,copiedReceipt.pageId);
  assert.deepEqual(await rows(),localRows,'the owner opens the same source-bound general draft');
  // This viewport shows the prior rig. Its pins bind to the prior rig source, while the act binds to the plan.
  await pressComposerKey('Escape');
  await wait(`!document.querySelector('${composerSelector}')`, '1260 owner pin dismissed');
  await click(page!,'#send-comments');
  await wait(`document.getElementById('review-draft-state')?.dataset.saveState==='saved'`, '1260 owner sent comments');
  assert.equal(await page!.evaluate(`document.getElementById('send-comments')?.disabled`),true,'submitted row cannot be sent again');
  const ownerPosts=actPostCount();
  assert.equal(ownerPosts,1);
  assert.equal(fixture.submissions.length,1);
  const submission=fixture.submissions[0]!;
  assert.equal(submission.kind,'comments');
  assert.equal(submission.publicationId,publicationId);
  assert.equal(submission.pageId,ownerReceipt.pageId);
  assert.equal(submission.displayedNonce,ownerReceipt.displayedNonce);
  assert.deepEqual(submission.value,{comments:[{text}]});
  assert.equal(fixture.files.length,1);
  const act=parseCommentOnlyAct(JSON.parse(await readFile(fixture.files[0]!,'utf8')));
  assert.equal(act.publicationId,publicationId);
  assert.equal(act.source.sourceHash,sourceHash);
  assert.deepEqual(act.value,{comments:[{text}]});
  assert.deepEqual(await jobInputHashes(fixture.root),before);
  trace.ownerSend={actPosts:ownerPosts,comments:act.value.comments,receiptBound:true,sourceImmutable:true};
  await shot(out,'owner-submitted');
  await evidence();
  cases.push({kind:'held-record-receipt',...trace});
  console.log(`1260_RECORD_COMPOSER_PASS ${language} copiedDrafts=1 copiedActs=0 pinnedRetained=true ownerActs=1`);
 }catch(error){
  trace.error=String(error);
  if(!trace.copiedSave||!trace.ownerSend)trace.composer=await composerState().catch(()=>null);
  await evidence();
  await shot(out,'failure');
  throw error;
 }finally{try{await page!.goto('about:blank');}finally{await fixture.close();}}
}
type RecordScreenState={
 open:boolean;workspaceReady?:string;dialogState:{id:string;open:boolean}[];language:string;capabilityState:string;
 sendCommentsVisible:boolean;backdropMessage:string;visibleText:string;width:number;height:number;
 topbars:number;viewports:number;retiredRecordDomCount:number;removedInterviewCount:number;legacy:number;notes:number;viewers:number;controls:string[];
};
async function screen(out:string,fixture?:Awaited<ReturnType<typeof recordScreenFixture>>){
 const state=await page!.evaluate<RecordScreenState>(`(()=>{const c=document.querySelector('#workspace-communication'),answer=${JSON.stringify(removedAnswerSelector)};return {open:!!c&&!c.hidden,workspaceReady:document.body.dataset.ready,dialogState:[...document.querySelectorAll('dialog')].map(n=>({id:n.id,open:n.open})),language:document.documentElement.lang,capabilityState:globalThis.__access756??'not-requested',sendCommentsVisible:!!document.getElementById('send-comments')?.checkVisibility(),backdropMessage:document.getElementById('message')?.textContent??'',visibleText:document.body.innerText,width:innerWidth,height:innerHeight,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,retiredRecordDomCount:document.querySelectorAll('[id="job-record-asks"],[id="workspace-pending-record-ask"]').length,removedInterviewCount:document.querySelectorAll('#workspace-interview-answer,'+answer).length,legacy:document.querySelectorAll('[data-job-forms],[data-job-plan-workspace]').length,notes:document.querySelectorAll('textarea[name=note]').length,viewers:document.querySelectorAll(${JSON.stringify(dialogViewer)}).length,controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id)};})()`);
 await writeFile(join(out,'screen-state.json'),JSON.stringify(state,null,2)+'\n');
 assert.equal(state.open,true,'communication panel shows on the right');
 assert.equal(state.dialogState.filter(d=>d.open).length,0,'no modal dialog is open');
 assert.equal(state.viewers,0);
 assert.equal(state.width,1600);assert.equal(state.height,1000);
 assert.equal(state.topbars,1);assert.equal(state.viewports,1);
 assert.equal(state.retiredRecordDomCount,0,'#1229: retired #job-record-asks and #workspace-pending-record-ask are absent');
 assert.equal(state.removedInterviewCount,0,'#1230: retired #workspace-interview-answer and form.interview-answer are absent');
 assert.equal(state.legacy,0);assert.equal(state.notes,0);
 assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
 if(fixture){
  const source=fixture.display.publication.source,metadata=await fixture.metadata();
  if(fixture.backdrop){
   assert.equal(state.capabilityState,'resolved');
   assert.equal(state.sendCommentsVisible,true);
   for(const value of [enCatalog,koCatalog])assert.equal(state.visibleText.includes(value['Read-only view: reopen with rig-review open to edit.']),false);
  }
  for(const raw of [source.sourceHash,source.projectHash,...(source.plan?.steps.flatMap(step=>[step.id,step.hash])??[])].filter((v):v is string=>Boolean(v)))
   assert.equal(state.visibleText.includes(raw),false,'raw identity '+raw);
  if(restsOnQuestions){
   // #1229: the checkpoint form that rendered [data-job-plan-field="rests_on"] is retired; raw question IDs stay off screen while planText metadata keeps its projected step references.
   for(const raw of ['post_timing','rig_type','bones_guide'])assert.equal(state.visibleText.includes(raw),false,'raw question identity '+raw);
   assert.equal(await page!.evaluate<number>(`document.querySelectorAll('[data-job-plan-field="rests_on"]').length`),0);
   assert.deepEqual(metadata.planText?.steps?.[0]?.rests_on,['post_timing','rig_type','bones_guide','step_weights','unknown_question_id']);
  }
  if('record' in source&&source.subject==='plan'){
   assert.equal(source.subjects.some(subject=>subject.kind==='checkpoint'),true);
   assert.equal(source.subjects.some(subject=>subject.kind==='reopen'),true);
   assert.equal(source.subjects.some(subject=>subject.kind==='signoff'),true);
  }
  await writeFile(join(out,'human-labels.json'),JSON.stringify({planText:metadata.planText},null,2)+'\n');
 }
 await shot(out,'modal');return state;
}
try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;mixedDisplay?.observe(event);if(event.method==='Network.responseReceived'){const row=visualRequests.find(row=>row.id===event.params?.requestId);if(row)row.status=(event.params!.response as {status:number}).status;}if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request?.method==='GET')visualRequests.push({id:String(event.params!.requestId),path:new URL(request.url).pathname});}if(event.method==='Runtime.exceptionThrown')errors.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request?.method==='POST'){const path=new URL(request.url).pathname;if(path.endsWith('/comment'))commentPosts.push(request.url);if(path.endsWith('/ui/acts'))actTransport.push({method:request.method,path});}}}});await command!('Network.enable');
 // Hold the exact access result at the existing main-screen bootstrap boundary. Host reads normally
 // resolve in memory, so a network-only delay would never exercise this capability-pending state.
 await command!('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const all=Promise.all;Promise.all=function(values){return all.call(this,values).then(rows=>{if(rows.length===2&&rows.some(row=>row&&typeof row==='object'&&'capabilityRequired' in row)){globalThis.__access756='pending';return new Promise(resolve=>{globalThis.__releaseAccess756=()=>{globalThis.__access756='resolved';resolve(rows);};});}return rows;});};})();`});
 await page.setViewport(1600,1000);
 const boundary=Bun.argv.includes('--parts-only'),sample=Bun.argv.includes('--sample'),kinds:RecordScreenKind[]=modalPreload?[]:['checkpoint'];
 if(!heldRecordOnly){
 const planOptions=restsOnQuestions?{
  text:{does:'Assemble post scene',produces:'Post composition pass',bar:'Matches declared timing and framing',rests_on:['post_timing','rig_type','bones_guide','step_weights','unknown_question_id']},
  interview:{
   framing:[{id:'rig_type',text:'What is this: a character rig or a full-screen scene?'}],
   waypoints:[{id:'bones_guide',text:'How many segments should the limb bones use?'}],
   post:{items:[{id:'post_timing',text:'How long, does it loop, and where are the beats?'}]},
  },
 }:undefined;
 // #1229: converted from checkpoint Pass/Fail form submission to plan record comment-only (act@10) submission while keeping legacy pending asks inert.
 for(const kind of kinds)for(const picture of restsOnQuestions||sample?[false]:[false,true,'parts'] as const)for(const language of sample?['en'] as const:['en','ko'] as const){
  if(boundary&&picture!=='parts')continue;
  const fixture=await recordScreenFixture(kind,picture,undefined,'plan-approved',false,true,undefined,false,false,undefined,planOptions),out=join(output,kind,picture==='parts'?'parts':picture?'picture':'empty',language);await mkdir(out,{recursive:true});fixture.output(out);
  fixture.fake.pending({askId:'ask-reopen',publicationId:fixture.display.publication.publicationId,source:fixture.display.publication.source,subject:{kind:'reopen',stage:'plan-approved'},status:'pending'},fixture.display.publication.generation);
  fixture.fake.pending({askId:'ask-signoff',publicationId:fixture.display.publication.publicationId,source:fixture.display.publication.source,subject:{kind:'signoff',stage:'plan-approved'},status:'pending'},fixture.display.publication.generation);
  const before=await jobInputHashes(fixture.root),catalog=language==='en'?enCatalog:koCatalog;
  try{
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await openRecord(url,fixture.display.publication);
   if(picture){
    await wait(`globalThis.__access756==='pending'`,'capability result held');
    const pending:{state:string;text:string}=await page.evaluate<{state:string;text:string}>(`({state:globalThis.__access756,text:document.body.innerText})`);
    for(const value of [enCatalog,koCatalog])assert.equal(pending.text.includes(value['Read-only view: reopen with rig-review open to edit.']),false,'no read-only before capability settles');
    await writeFile(join(out,'capability-pending.json'),JSON.stringify(pending,null,2)+'\n');await shot(out,'capability-pending');
    await page.evaluate(`globalThis.__releaseAccess756()`);
   }
   const planReady=`document.body.dataset.ready==='true'&&!!document.querySelector('#stage-comment-list')&&!!document.getElementById('send-comments')&&!document.getElementById('send-comments').hidden&&document.getElementById('workspace-pending-ask').hidden`;
   await wait(planReady,'receipt');
   const bottomBefore:string=await page.evaluate<string>(bottomState);
   const state=await screen(out,fixture);assert.equal(state.language,language);
   assert.equal(await page.evaluate<string>(bottomState),bottomBefore,'record screen keeps the bottom panel unchanged');
   await ensureComment();
   if(picture==='parts'){const posts=commentPosts.length;await ensureComment();assert.equal(await page.evaluate(`document.getElementById('stage-comment-refusal').textContent`),catalog['JOB_REVIEW_READ_ONLY']);assert.equal(await page.evaluate(`document.querySelectorAll('.stage-comment-composer').length`),0);assert.equal(commentPosts.length,posts);await shot(out,'pointed-read-only-refusal');}
   await addGeneral('First comment · 원문 '+language);await addGeneral('Second comment · 둘째 '+language);
   if(picture===true){
    await ensureComment();const box=await page.evaluate<any>(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await command!('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await command!('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    await wait(`!!document.querySelector('.stage-comment-composer input')`,'point composer');await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value='Pointed comment · 그림';f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'point saved');
   }
   const drafts:[string,string][]=await page.evaluate<[string,string][]>(`Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-record-comments/1:'))`);assert.equal(drafts.length,1);const [key,raw]=drafts[0]!,draft=JSON.parse(raw);assert.equal(draft.publicationId,fixture.ask.publicationId);assert.equal(draft.sourceHash,fixture.display.publication.source.sourceHash);assert.equal(draft.comments.length,picture===true?3:2);
   const expected=projectComments(draft.comments.filter((row:any)=>!row.target).map((row:any)=>({text:row.summary})));
   await page.goto('about:blank');await page.goto(url.href);if(picture){await wait(`globalThis.__access756==='pending'`,'reload capability');await page.evaluate(`globalThis.__releaseAccess756()`);}await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===${draft.comments.length}&&(${planReady})`,'source draft restore');
   await shot(out,'comments-restored');
   if(picture===true){
    // #1229: act@10 requires comment anchors bound to the record sourceHash; remove the prior-package rig pin after verifying local draft restore so the plan comments submit cleanly.
    await page.evaluate<void>(`[...document.querySelectorAll('#stage-comment-list .stage-comment-summary')].find(n=>n.textContent?.includes('Pointed comment'))?.click()`);
    await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'prior-rig pin composer');
    await click(page,'.stage-comment-composer .stage-comment-delete');
    await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===2`,'prior-rig pin removed');
   }
   await shot(out,'before-submit');await click(page,'#send-comments');
   await wait(`document.getElementById('review-draft-state')?.dataset.saveState==='saved'`,'plan comments submitted');
   const act=parseCommentOnlyAct(JSON.parse(await readFile(join(out,'one-screen.json'),'utf8')));assert.equal(act.source.sourceHash,fixture.display.publication.source.sourceHash);assert.equal(act.kind,'comments');
   const plainComments=act.value.comments.map(({context:_context,...comment})=>comment);
   assert.equal(projectComments(plainComments),expected);
   await shot(out,'submitted');await page.evaluate(`(()=>{const d=JSON.parse(localStorage.getItem(${JSON.stringify(key)}));d.sourceHash='0'.repeat(64);localStorage.setItem(${JSON.stringify(key)},JSON.stringify(d));})()`);await page.goto('about:blank');await page.goto(url.href);if(picture){await wait(`globalThis.__access756==='pending'`,'reload capability');await page.evaluate(`globalThis.__releaseAccess756()`);}await wait(planReady,'mismatched reload');assert.equal(await page.evaluate(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length`),0);
   assert.deepEqual(await jobInputHashes(fixture.root),before);const result={kind,picture,language,state,comments:draft.comments.length,sourceHash:act.source.sourceHash,sourceDraftRestored:true,mismatchedDraftRefused:true,pointedRefusedByReadOnly:picture==='parts',words:expected,actPath:join(out,'one-screen.json')};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_CASE_PASS '+kind+' '+picture+' '+language);
  }catch(error){await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 if(!sample&&!restsOnQuestions)for(const parts of boundary?[true]:[false,true])for(const language of ['en','ko'] as const){
  const fixture=parts?await scriptedJobWindowFixture({c5Parts:'mesh'}):await realJobWindowFixture(),out=join(output,parts?'mixed-parts':'mixed',language);await mkdir(out,{recursive:true});
  let intercepting=false;
  try{
   const publication=parts?await (fixture as Awaited<ReturnType<typeof scriptedJobWindowFixture>>).publish('parts'):await (fixture as Awaited<ReturnType<typeof realJobWindowFixture>>).publish(),asks:PendingAskV3[]=[];
   const verdictSubject=parts?{kind:'parts-verdict',draftId:'synthetic-parts'} as const:{kind:'review-verdict',stage:'rig-review'} as const;
   {const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject:verdictSubject});const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));asks.push(value.value);}
   // #1227 / #1229: fresh signoff and checkpoint asks on packages refuse JOB_ASK_INVALID; the verdict ask continues uninterrupted.
   for(const retiredSubject of [{kind:'signoff',stage:'plan-approved'},{kind:'checkpoint',checkpointId:'step-one'}] as const){
    const refused=await (await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject:retiredSubject})).json();
    assert.equal(refused.ok,false,JSON.stringify(refused));assert.equal(refused.error.code,'JOB_ASK_INVALID');
   }
   const before=await jobInputHashes(fixture.input.root),url=new URL(fixture.host.ownerUrl);url.searchParams.set('lang',language);
   const displayWatch=mixedDisplay=observeMixedDisplay(url),{publicationId,source:{sourceHash}}=publication;
   const label=tr(publication.label,language);
   if(holdMixedDisplayed){
    await command!('Fetch.enable',{patterns:[{urlPattern:displayWatch.url,requestStage:'Request'}]});intercepting=true;
   }
   await page.goto(url.href);await wait(`globalThis.__access756==='pending'`,'mixed capability');
   await page.evaluate(countSaveClicks);
   await page.evaluate(`globalThis.__releaseAccess756()`);await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#stage-comment-list')&&!!document.querySelector(${parts?"'#parts-canvas'":"'#rig-root canvas'"})&&!document.querySelector('#save').disabled&&document.querySelector('#workspace-pending-ask').hidden`,'mixed ready');
   const readActs=async()=>{
    const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0});
    const next=await response.json();assert.equal(next.ok,true);
    return next.value.events.filter((event:any)=>event.type==='act').map((event:any)=>event.act);
   };
   if(modalPreload){
    const display=fixture.host.session.displayPublication(publication.publicationId),prefix=new URL(display.routes.entry,url.origin).pathname;
    if(parts){
     const expected=(await (await fetch(url.origin+display.routes.apiBase+'stage-parts')).json()).items as {index:number;name:string}[];
     const images=visualRequests.filter(row=>row.path.startsWith(prefix)&&row.path.includes('/api/stage-parts/image/'));
     assert.deepEqual(images.map(row=>Number(row.path.split('/').at(-1))).sort((a,b)=>a-b),expected.map(item=>item.index).sort((a,b)=>a-b),'only the shared workspace fetches every part once');
     assert.ok(images.every(row=>row.status===200));
     await wait(`(()=>{const canvas=document.querySelector('#parts-canvas');return canvas?.width>0&&[...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data].some((value,index)=>index%4===3&&value>0);})()`,'visible parts pixels');
     await wait(`(()=>{const canvas=document.querySelector('#reference-content canvas');return canvas?.width===32&&canvas.height===24&&JSON.stringify([...canvas.getContext('2d').getImageData(0,0,1,1).data])==='[40,50,100,255]';})()`,'painting pixels loaded by workspace');
     const paintings=visualRequests.filter(row=>row.path.startsWith(prefix)&&row.path.endsWith('/review-painting'));assert.equal(paintings.length,1);assert.equal(paintings[0]!.status,200);
     await writeFile(join(out,'workspace-visuals.json'),JSON.stringify({parts:expected,partRequests:images,paintings},null,2)+'\n');
    }else{
     await page.evaluate(`(()=>{const select=document.getElementById('reference-select');if(select.value!=='raster'){select.value='raster';select.dispatchEvent(new Event('change'));}})()`);
     await wait(`(()=>{const image=document.querySelector('#reference-content img');return image?.complete&&image.naturalWidth>0&&image.naturalHeight>0;})()`,'reference image loaded by workspace');
     const references=visualRequests.filter(row=>row.path.startsWith(prefix)&&row.path.endsWith('/assets/rigid.png'));assert.ok(references.length>0,'shared workspace requests the reference');assert.ok(references.every(row=>row.status===200));
     await writeFile(join(out,'workspace-visuals.json'),JSON.stringify({references},null,2)+'\n');
    }
    if(!await page.evaluate(`document.getElementById('view-menu').open`))await click(page,'#view-menu summary');
    await click(page,'#view-menu [data-view="reference"]');
    await wait(`document.getElementById('reference-pane').getBoundingClientRect().width>0`,'workspace reference visible');await shot(out,parts?'workspace-painting':'workspace-reference');
    if(!await page.evaluate(`document.getElementById('view-menu').open`))await click(page,'#view-menu summary');await click(page,'#view-menu [data-view="rig"]');await shot(out,'workspace-parts-or-rig');
   }
   const catalog=language==='en'?enCatalog:koCatalog;
   const [receipt,heldSave]=await Promise.all([
    waitForMixedDisplay(displayWatch,{publicationId,sourceHash},label),
    holdMixedDisplayed?(async():Promise<HeldDisplay>=>{
     const paused=await withDeadline('715 mixed displayed hold',20_000,()=>displayWatch.held);
     const body=await postData<JobDisplayAcknowledgment>(paused);
     assert.ok(body?.publicationId===publicationId&&body.sourceHash===sourceHash&&body.pageId,'hold the active publication acknowledgment');
     const acts=await readActs();
     const snapshot:HeldDisplay={...await page!.evaluate<SaveClicks>(saveClicks),acts:acts.length,actPosts:displayWatch.acts.length,
      labelDisplayed:await page!.evaluate<boolean>(`document.getElementById('message')?.textContent===${JSON.stringify(label)}`)};
     await writeFile(join(out,'display-held.json'),JSON.stringify(snapshot,null,2)+'\n');
     assert.deepEqual(snapshot,{ready:false,earlyClicks:0,trustedSaveClicks:0,acts:0,actPosts:0,labelDisplayed:false});
     assert.equal(displayWatch.status,undefined,'acknowledgment has no response before release');
     await command!('Fetch.continueRequest',{requestId:paused.id});
     return snapshot;
    })():undefined,
   ]);
   await click(page,'#save');await wait(`(()=>{const node=document.getElementById('review-draft-state');return node?.textContent===${JSON.stringify(catalog['job.review.approved'])}&&node.dataset.saveState==='saved';})()`,'mixed verdict approved');
   const acts=await readActs();assert.equal(acts.length,1);
   const act=parseCommentsAct(acts[0]);assert.ok(act.kind===(parts?'parts-verdict':'review-verdict'));
   assert.equal(act.value.verdict,'approved');assert.equal(act.askId,asks[0]!.askId);
   assert.equal(act.publicationId,publicationId);assert.equal(act.source.sourceHash,sourceHash);
   assert.equal(displayWatch.acts.length,1,'one approval POST');
   const submission=await postData<UISubmissionV3>(displayWatch.acts[0]!);
   assert.ok(submission.publicationId===receipt.publicationId&&submission.pageId===receipt.pageId&&
    submission.displayedNonce===receipt.displayedNonce,'approval POST uses the observed display receipt');
   const clicks:SaveClicks=await page.evaluate<SaveClicks>(saveClicks);
   assert.deepEqual(clicks,{ready:true,earlyClicks:0,trustedSaveClicks:1});
   assert.deepEqual(await jobInputHashes(fixture.input.root),before);await shot(out,'submitted');const submittedUi=await page.evaluate(`({message:document.getElementById('message')?.textContent,dirty:document.getElementById('dirty')?.textContent,review:document.querySelector('#review-status')?.value,saveDisabled:document.querySelector('#save')?.disabled,actState:['dirty','review-draft-state','draft-state'].map(id=>{const node=document.getElementById(id);return {id,text:node?.textContent,kind:node?.dataset.saveState,visible:!!node?.getClientRects().length};})})`);const result={kind:parts?'mixed-parts':'mixed',language,submittedUi,transport:actTransport.filter(event=>event.path.includes('/jobs/'+fixture.host.session.jobId+'/')),acts,displayed:{publicationId,sourceHash,status:displayWatch.status,label,receiptBound:true,clicks,heldSave},sourceImmutable:true};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_MIXED_PASS '+language);
  }catch(error){const ui=await page.evaluate(`({message:document.getElementById('message')?.textContent,dirty:document.getElementById('dirty')?.textContent,review:document.querySelector('#review-status')?.value,saveDisabled:document.querySelector('#save')?.disabled,activeElement:document.activeElement?.id,dialogs:[...document.querySelectorAll('dialog')].map(n=>({id:n.id,open:n.open}))})`);const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0});const next=await response.json();await writeFile(join(out,'failure-state.json'),JSON.stringify({error:String(error),ui,next,actTransport},null,2)+'\n');await shot(out,'failure');throw error;}finally{
   try{await page.goto('about:blank');}finally{
    mixedDisplay=undefined;
    try{if(intercepting)await command!('Fetch.disable');}finally{await fixture.close();}
   }
  }
 }
 // #1229 / #1230: both the checkpoint Pass/Fail form and the Question answer form are retired; mixed package Question + checkpoint case is retired.
 // A copied capability-free link has no act authority (#send-comments stays disabled), even though its backdrop is still readable.
 if(!sample&&!boundary&&!restsOnQuestions&&!modalPreload)for(const picture of [true,'parts'] as const)for(const language of ['en','ko'] as const){
  const fixture=await recordScreenFixture('option-set',picture),out=join(output,'readonly-link',picture===true?'rig':'parts',language);await mkdir(out,{recursive:true});
  try{
   const url=new URL(fixture.ownerUrl);url.hash='';url.searchParams.set('lang',language);const before=await jobInputHashes(fixture.root);
   await openRecord(url,fixture.display.publication);await wait(`globalThis.__access756==='pending'`,'copied link pending access');
   const pending:{state:string;text:string}=await page.evaluate<{state:string;text:string}>(`({state:globalThis.__access756,text:document.body.innerText})`);
   for(const catalog of [enCatalog,koCatalog])assert.equal(pending.text.includes(catalog['Read-only view: reopen with rig-review open to edit.']),false);
   await shot(out,'pending');await page.evaluate(`globalThis.__releaseAccess756()`);
   const catalog=language==='en'?enCatalog:koCatalog;
   await wait(`document.body.dataset.ready==='true'&&!!document.getElementById('send-comments')?.disabled&&document.getElementById('message')?.textContent===${JSON.stringify(catalog['Read-only view: reopen with rig-review open to edit.'])}`,'copied link resolved readonly');
   await addGeneral('Readonly comment attempt · '+language);
   const resolved:{state:string;message:string;disabled:boolean;forms:number}=await page.evaluate<{state:string;message:string;disabled:boolean;forms:number}>(`({state:globalThis.__access756,message:document.getElementById('message').textContent,disabled:document.getElementById('send-comments').disabled,forms:document.querySelectorAll('form[data-job-ask]').length})`);
   assert.equal(resolved.state,'resolved');assert.equal(resolved.disabled,true);assert.equal(resolved.forms,0);
   await page.evaluate(`document.getElementById('send-comments')?.click()`);await new Promise(resolve=>setTimeout(resolve,50));
   assert.equal(fixture.submissions.length,0);assert.deepEqual(await jobInputHashes(fixture.root),before);
   await shot(out,'resolved');const result={kind:'readonly-link',picture,language,pending,resolved,sourceImmutable:true,submissions:fixture.submissions.length};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('756_READONLY_LINK_PASS '+picture+' '+language);
  }catch(error){await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 }
 if(heldRecordOnly||!plain715&&!boundary&&!sample&&!restsOnQuestions&&!modalPreload&&!holdMixedDisplayed){
  for(const language of ['en','ko'] as const)await recordComposerReceiptCase(language);
 }
 assert.equal(errors.length,0,JSON.stringify(errors));await writeFile(join(output,'result.json'),JSON.stringify({cases:cases.length,viewport:[1600,1000],errors,sample,results:cases},null,2)+'\n');console.log('715_BROWSER_PASS cases='+cases.length);
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,cases},null,2)+'\n');if(page)await shot(output,'failure');throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
