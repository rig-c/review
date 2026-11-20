/** #715 ordinary Nova: shared ask dialog and Comments, source-bound record drafts and mixed rig asks.
 * #986 also exercises a retained package with a pending Question and text-only checkpoint. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {realJobWindowFixture,scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {feedbackItemComments,projectComments} from '../src/stage-comment.ts';
import {parseRecordAct,parseCommentsAct,parseRecordSubject} from '../src/job-api.ts';
import {JOB_API_SCHEMA,type JobApiResponse,type PendingAskV3} from '../src/job-contract.ts';
import {readProject} from '../src/interview-project.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
const arg=(key:string)=>{const at=Bun.argv.indexOf(key);return at<0?undefined:Bun.argv[at+1];};
const directionSignoff=Bun.argv.includes('--direction-signoff');
const interviewSignoff=Bun.argv.includes('--interview-signoff');
const stageSignoff=directionSignoff||interviewSignoff;
const modalPreload=Bun.argv.includes('--modal-preload');
const signoffSubject=parseRecordSubject({kind:'signoff',stage:interviewSignoff?'interview':directionSignoff?'direction-review':'plan-approved'});
if(signoffSubject.kind!=='signoff')throw new Error('SYNTHETIC_SIGNOFF_STAGE_INVALID');
const output=resolve(arg('--out')??'artifacts/715');await mkdir(output,{recursive:true});
if(Bun.argv.includes('--serve')){
 const kinds=(arg('--kind')?[arg('--kind')]:['checkpoint','signoff','reopen']) as RecordScreenKind[];
 const fixtures=[];
 for(const kind of kinds){const fixture=await recordScreenFixture(kind,true,undefined,signoffSubject.stage);fixtures.push(fixture);const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',arg('--lang')??(directionSignoff?'ko':'en'));console.log(JSON.stringify({url:url.href,pid:process.pid,kind,sourceHash:fixture.display.publication.source.sourceHash,fixture:'synthetic trusted record host; shared screen'}));}
 await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});for(const fixture of fixtures)await fixture.close();process.exit(0);
}
const profile=await mkdtemp(join(tmpdir(),'review-715-browser-'));let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const visualRequests:{id:string;path:string;status?:number}[]=[];
const errors:unknown[]=[],cases:unknown[]=[],commentPosts:string[]=[],actTransport:{method:string;path:string}[]=[];
const dialogViewer='dialog :is(.viewport,.interview-view,.interview-viewport,#reference-content,#rig-viewport,#zoom-in,#zoom-out,#fit,#native-one,#view-menu)';
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('715_WAIT '+label);}
async function waitForRecordSaved(answeredLabel:string,label:string):Promise<void>{
 await wait(`(()=>{const state=document.getElementById('dirty');return state?.textContent===${JSON.stringify(answeredLabel)}&&state.dataset.saveState==='saved';})()&&
  !document.querySelector('#job-record-asks')`,label);
}
async function shot(out:string,name:string){await writeFile(join(out,name+'.png'),await page!.screenshot());}
async function closeDialog(){await click(page!,'#job-record-asks .workspace-drawer-close');await wait(`!document.querySelector('#job-record-asks[open]')`,'dialog closed');assert.equal(await page!.evaluate(`document.activeElement.id`),'workspace-pending-ask');}
async function assertTextOnlyDialog():Promise<void>{
 const state=await page!.evaluate<{modal:boolean;viewers:number;interviews:number}>(`({
  modal:!!document.querySelector('#job-record-asks:modal'),
  viewers:document.querySelectorAll(${JSON.stringify(dialogViewer)}).length,
  interviews:document.querySelectorAll('#job-record-asks form.interview-answer').length,
 })`);
 assert.deepEqual(state,{modal:true,viewers:0,interviews:0});
}
async function ensureComment(){if(await page!.evaluate(`document.getElementById('stage-comment')?.getAttribute('aria-pressed')!=='true'`))await click(page!,'#stage-comment');}
async function addGeneral(text:string){await click(page!,'[data-comment-general]');await wait(`!!document.querySelector('.stage-comment-composer input')`,'general composer');await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'general saved');}
type ModalScreen={
 open:boolean;workspaceReady?:string;activeElement:{tag?:string;id?:string;name?:string|null};
 dialogState:{id:string;open:boolean;containsFocus:boolean}[];language:string;capabilityState:string;
 ownerFieldsEnabled:boolean;backdropMessage:string;visibleText:string;width:number;height:number;
 topbars:number;viewports:number;dialogs:number;legacy:number;notes:number;
 editableInterviewSets:number;readOnlyInterviewNotes:number;focusContained:boolean;
 rect:{x:number;y:number;width:number;height:number};controls:string[];
};
async function screen(out:string,fixture?:Awaited<ReturnType<typeof recordScreenFixture>>){const state=await page!.evaluate<ModalScreen>(`(()=>{const d=document.querySelector('#job-record-asks'),r=d.getBoundingClientRect();return {open:d.open,workspaceReady:document.body.dataset.ready,activeElement:{tag:document.activeElement?.tagName,id:document.activeElement?.id,name:document.activeElement?.getAttribute('name')},dialogState:[...document.querySelectorAll('dialog')].map(n=>({id:n.id,open:n.open,containsFocus:n.contains(document.activeElement)})),language:document.documentElement.lang,capabilityState:globalThis.__access756??'not-requested',ownerFieldsEnabled:!!d.querySelector('form fieldset:not(:disabled)'),backdropMessage:document.getElementById('message')?.textContent??'',visibleText:document.body.innerText,width:innerWidth,height:innerHeight,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,dialogs:document.querySelectorAll('#job-record-asks').length,legacy:document.querySelectorAll('[data-job-forms],[data-job-plan-workspace]').length,notes:d.querySelectorAll('textarea[name=note]').length,editableInterviewSets:d.querySelectorAll('form.interview-answer:not([data-interview-answered=true]) fieldset.interview-answer-fields:not(:disabled)').length,readOnlyInterviewNotes:d.querySelectorAll('form.interview-answer[data-interview-answered=true] textarea[name=note],form.interview-answer fieldset.interview-answer-fields:disabled textarea[name=note]').length,focusContained:d.contains(document.activeElement),rect:{x:r.x,y:r.y,width:r.width,height:r.height},controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id)};})()`);
 await writeFile(join(out,'screen-state.json'),JSON.stringify(state,null,2)+'\n');await assertTextOnlyDialog();assert.equal(state.open,true,'ask dialog opens before focus and geometry checks');assert.equal(state.width,1600);assert.equal(state.height,1000);assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.dialogs,1);assert.equal(state.legacy,0);assert.equal(state.notes,0);assert.equal(state.editableInterviewSets,0);assert.equal(state.readOnlyInterviewNotes,0);assert.equal(state.focusContained,true);assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);assert.ok(state.rect.x>=0&&state.rect.y>=0&&state.rect.x+state.rect.width<=1600&&state.rect.y+state.rect.height<=1000);if(fixture){
  const chrome=await page!.evaluate<any>(`(()=>{const form=document.querySelector('form[data-job-ask]');return {text:form.textContent,source:{text:form.querySelector('.job-source').textContent,title:form.querySelector('.job-source').title},summaries:[...form.querySelectorAll('.job-plan-steps summary')].map(n=>({text:n.textContent,title:n.title})),heading:{text:form.querySelector('h3')?.textContent,title:form.querySelector('h3')?.title},stageTitle:form.querySelector('fieldset').title};})()`);
  const source=fixture.display.publication.source,catalog=state.language==='en'?enCatalog:koCatalog,metadata=await fixture.metadata();
  const label=(step:{id:string;hash:string})=>{const row=metadata.planText?.status==='projected'?metadata.planText.steps.find((row:{id:string;hash:string})=>row.id===step.id&&row.hash===step.hash):undefined;return row?.does??catalog['job.plan.field.'+(row?.issues.find((issue:{field:string})=>issue.field==='does')?.reason??'absent')];};
  if(fixture.backdrop){assert.equal(state.capabilityState,'resolved');assert.equal(state.ownerFieldsEnabled,true);assert.equal(state.backdropMessage,catalog['Not submitted']);for(const value of [enCatalog,koCatalog])assert.equal(state.visibleText.includes(value['Read-only view: reopen with rig-review open to edit.']),false);}
  assert.equal(chrome.source.text,fixture.display.publication.label);assert.equal(chrome.source.title,source.sourceHash);
  for(const raw of [source.sourceHash,source.projectHash,...(source.plan?.steps.flatMap(step=>[step.id,step.hash])??[])].filter(Boolean))assert.equal(chrome.text.includes(raw),false,'raw modal identity '+raw);
  for(const [index,summary]of chrome.summaries.entries()){const step=source.plan!.steps[index]!;assert.equal(summary.text,label(step));assert.ok(summary.title.includes(step.id)&&summary.title.includes(step.hash));}
  if(fixture.ask.subject.kind==='checkpoint'){assert.equal(chrome.heading.text,label(source.plan!.steps[0]!));assert.equal(chrome.heading.title,fixture.ask.subject.checkpointId);}
  if(fixture.ask.subject.kind==='signoff'||fixture.ask.subject.kind==='reopen'){assert.equal(chrome.text.includes(fixture.ask.subject.stage),false);assert.equal(chrome.stageTitle,fixture.ask.subject.stage);}
  await writeFile(join(out,'human-labels.json'),JSON.stringify(chrome,null,2)+'\n');
 }
 await shot(out,'modal');return state;}
try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;if(event.method==='Network.responseReceived'){const row=visualRequests.find(row=>row.id===event.params?.requestId);if(row)row.status=(event.params!.response as {status:number}).status;}if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request?.method==='GET')visualRequests.push({id:String(event.params!.requestId),path:new URL(request.url).pathname});}if(event.method==='Runtime.exceptionThrown')errors.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request?.method==='POST'){const path=new URL(request.url).pathname;if(path.endsWith('/comment'))commentPosts.push(request.url);if(path.endsWith('/ui/acts'))actTransport.push({method:request.method,path});}}}});await command!('Network.enable');
 // Hold the exact access result at the existing main-screen bootstrap boundary. Host reads normally
 // resolve in memory, so a network-only delay would never exercise this capability-pending state.
 await command!('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const all=Promise.all;Promise.all=function(values){return all.call(this,values).then(rows=>{if(rows.length===2&&rows.some(row=>row&&typeof row==='object'&&'capabilityRequired' in row)){globalThis.__access756='pending';return new Promise(resolve=>{globalThis.__releaseAccess756=()=>{globalThis.__access756='resolved';resolve(rows);};});}return rows;});};})();`});
 await page.setViewport(1600,1000);
 const boundary=Bun.argv.includes('--parts-only'),sample=Bun.argv.includes('--sample'),kinds:RecordScreenKind[]=modalPreload?[]:stageSignoff?['signoff']:sample?['checkpoint']:['checkpoint','signoff','reopen'];
 for(const kind of kinds)for(const picture of stageSignoff||sample?[false]:kind==='checkpoint'?[false,true,'parts'] as const:[false,true])for(const language of interviewSignoff?['en','ko'] as const:directionSignoff?['ko'] as const:sample?['en'] as const:['en','ko'] as const){
  if(boundary&&picture!=='parts')continue;
  const fixture=await recordScreenFixture(kind,picture,undefined,signoffSubject.stage),out=join(output,kind,picture==='parts'?'parts':picture?'picture':'empty',language);await mkdir(out,{recursive:true});fixture.output(out);
  const before=await jobInputHashes(fixture.root),selector=`form[data-job-ask="${fixture.ask.askId}"]`,catalog=language==='en'?enCatalog:koCatalog;
  try{
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href);
   if(picture){
    await wait(`globalThis.__access756==='pending'`,'capability result held');
    const pending:{state:string;text:string}=await page.evaluate<{state:string;text:string}>(`({state:globalThis.__access756,text:document.body.innerText})`);
    for(const value of [enCatalog,koCatalog])assert.equal(pending.text.includes(value['Read-only view: reopen with rig-review open to edit.']),false,'no read-only before capability settles');
    await writeFile(join(out,'capability-pending.json'),JSON.stringify(pending,null,2)+'\n');await shot(out,'capability-pending');
    await page.evaluate(`globalThis.__releaseAccess756()`);
   }
   await wait(`!!document.querySelector('#stage-comment-list')&&!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'receipt');
   await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'ask line opens');
   const state=await screen(out,fixture);assert.equal(state.language,language);await closeDialog();
   await ensureComment();
   if(picture==='parts'){const posts=commentPosts.length;await ensureComment();assert.equal(await page.evaluate(`document.getElementById('stage-comment-refusal').textContent`),catalog['JOB_REVIEW_READ_ONLY']);assert.equal(await page.evaluate(`document.querySelectorAll('.stage-comment-composer').length`),0);assert.equal(commentPosts.length,posts);await shot(out,'pointed-read-only-refusal');}
   await addGeneral('First comment · 원문 '+language);await addGeneral('Second comment · 둘째 '+language);
   if(picture===true){
    await ensureComment();const box=await page.evaluate<any>(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await command!('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await command!('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    await wait(`!!document.querySelector('.stage-comment-composer input')`,'point composer');await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value='Pointed comment · 그림';f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'point saved');
   }
   const drafts:[string,string][]=await page.evaluate<[string,string][]>(`Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-record-comments/1:'))`);assert.equal(drafts.length,1);const [key,raw]=drafts[0]!,draft=JSON.parse(raw);assert.equal(draft.publicationId,fixture.ask.publicationId);assert.equal(draft.sourceHash,fixture.display.publication.source.sourceHash);assert.equal(draft.comments.length,picture===true?3:2);
   const expected=projectComments(draft.comments.map((row:any)=>row.target?feedbackItemComments([row])[0]:{text:row.summary}));
   await page.goto('about:blank');await page.goto(url.href);if(picture){await wait(`globalThis.__access756==='pending'`,'reload capability');await page.evaluate(`globalThis.__releaseAccess756()`);}await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===${draft.comments.length}&&!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'source draft restore');
   await shot(out,'comments-restored');
   await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'reopen after reload');
   if(kind==='checkpoint')await page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.querySelector('select[name=outcome]').value='pass';f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await shot(out,'before-submit');await click(page,selector+' button[type=submit]');
   await waitForRecordSaved(catalog['Answer saved'],`${kind} ${picture} ${language} saved in the topbar and its drawer removed`);
   const act=parseRecordAct(JSON.parse(await readFile(join(out,'one-screen.json'),'utf8')));assert.equal(act.source.sourceHash,fixture.display.publication.source.sourceHash);assert.notEqual(act.kind,'interview-picks');if(act.kind!=='interview-picks')assert.equal(act.value.words,expected);if(stageSignoff){assert.equal(act.kind,'signoff');assert.equal((act.value as {stage:string}).stage,signoffSubject.stage);assert.equal((act.value as {decision:string}).decision,'approved');}assert.equal('feedback' in act.value,false);assert.equal('comments' in act.value,false);
   await shot(out,'submitted');await page.evaluate(`(()=>{const d=JSON.parse(localStorage.getItem(${JSON.stringify(key)}));d.sourceHash='0'.repeat(64);localStorage.setItem(${JSON.stringify(key)},JSON.stringify(d));})()`);await page.goto('about:blank');await page.goto(url.href);if(picture){await wait(`globalThis.__access756==='pending'`,'reload capability');await page.evaluate(`globalThis.__releaseAccess756()`);}await wait(`!!document.querySelector('#stage-comment-list')&&!!document.querySelector(${JSON.stringify(selector)})`,'mismatched reload');assert.equal(await page.evaluate(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length`),0);
   assert.deepEqual(await jobInputHashes(fixture.root),before);const result={kind,picture,language,state,comments:draft.comments.length,sourceHash:act.source.sourceHash,sourceDraftRestored:true,mismatchedDraftRefused:true,pointedRefusedByReadOnly:picture==='parts',scalarOnly:true,words:expected,actPath:join(out,'one-screen.json')};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_CASE_PASS '+kind+' '+picture+' '+language);
  }catch(error){await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 if(!sample&&!stageSignoff)for(const parts of boundary?[true]:[false,true])for(const language of ['en','ko'] as const){
  const fixture=parts?await scriptedJobWindowFixture({c5Parts:'mesh'}):await realJobWindowFixture(),out=join(output,parts?'mixed-parts':'mixed',language);await mkdir(out,{recursive:true});
  try{
   const publication=parts?await (fixture as Awaited<ReturnType<typeof scriptedJobWindowFixture>>).publish('parts'):await (fixture as Awaited<ReturnType<typeof realJobWindowFixture>>).publish(),asks:PendingAskV3[]=[];
   for(const subject of [parts?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:'rig-review'},{kind:'signoff',stage:'plan-approved'}] as const){const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject});const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));asks.push(value.value);}
   const before=await jobInputHashes(fixture.input.root),url=new URL(fixture.host.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href);await wait(`globalThis.__access756==='pending'`,'mixed capability');await page.evaluate(`globalThis.__releaseAccess756()`);await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#job-record-asks form fieldset:not(:disabled)')&&!!document.querySelector('#stage-comment-list')&&!!document.querySelector('#rig-root canvas')&&!document.querySelector('#save').disabled&&document.querySelector('#workspace-pending-ask').hidden`,'mixed ready');
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
   await click(page,'#save');await wait(`(()=>{const node=document.getElementById('review-draft-state');return node?.textContent===${JSON.stringify(catalog['job.review.approved'])}&&node.dataset.saveState==='saved';})()`,'mixed verdict approved before signoff');
   await wait(`!document.querySelector('#workspace-pending-ask').hidden&&!document.querySelector('#workspace-pending-ask').disabled`,'signoff offered after verdict');
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'mixed ask dialog opens');const state=await screen(out);const form=`form[data-job-ask="${asks[1]!.askId}"]`;await click(page,form+' button[type=submit]');
   // #845 coalesces the completed answer's save state into the topbar; the verdict was asserted above.
   const answeredLabel=language==='en'?'Answer saved':koCatalog['Answer saved'];
   await wait(`['review-draft-state','dirty'].every(id=>{const node=document.getElementById(id);return node?.textContent===${JSON.stringify(answeredLabel)}&&node.dataset.saveState==='saved';})&&document.getElementById('workspace-act-row').hidden&&['dirty','review-draft-state','draft-state'].filter(id=>document.getElementById(id).getClientRects().length>0).join(',')==='dirty'&&!document.querySelector('#job-record-asks')`,'mixed answer saved phase has one visible topbar save state and no drawer');
   assert.equal(await page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(form)}).length`),0,'saved signoff leaves the live forms');
   const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0}),next=await response.json();assert.equal(next.ok,true);const acts=next.value.events.filter((event:any)=>event.type==='act').map((event:any)=>event.act);assert.deepEqual(acts.map((act:any)=>act.kind),[parts?'parts-verdict':'review-verdict','signoff']);for(const act of acts){parseCommentsAct(act);assert.equal(act.source.sourceHash,publication.source.sourceHash);}assert.deepEqual(await jobInputHashes(fixture.input.root),before);await shot(out,'submitted');const submittedUi=await page.evaluate(`({message:document.getElementById('message')?.textContent,dirty:document.getElementById('dirty')?.textContent,review:document.querySelector('#review-status')?.value,saveDisabled:document.querySelector('#save')?.disabled,actState:['dirty','review-draft-state','draft-state'].map(id=>{const node=document.getElementById(id);return {id,text:node?.textContent,kind:node?.dataset.saveState,visible:!!node?.getClientRects().length};})})`);const result={kind:parts?'mixed-parts':'mixed',language,state,submittedUi,transport:actTransport.filter(event=>event.path.includes('/jobs/'+fixture.host.session.jobId+'/')),acts,sourceImmutable:true};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_MIXED_PASS '+language);
  }catch(error){const ui=await page.evaluate(`({message:document.getElementById('message')?.textContent,dirty:document.getElementById('dirty')?.textContent,review:document.querySelector('#review-status')?.value,saveDisabled:document.querySelector('#save')?.disabled,activeElement:document.activeElement?.id,dialogs:[...document.querySelectorAll('dialog')].map(n=>({id:n.id,open:n.open}))})`);const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0});const next=await response.json();await writeFile(join(out,'failure-state.json'),JSON.stringify({error:String(error),ui,next,actTransport},null,2)+'\n');await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 // A package publication can carry both an interview and a checkpoint bound to the same source.
 if(!sample&&!boundary&&!stageSignoff&&!modalPreload)for(const language of ['en','ko'] as const){
  const fixture=await realJobWindowFixture(),out=join(output,'mixed-question-checkpoint',language);
  await mkdir(out,{recursive:true});
  try{
   await cp(new URL('./fixtures/interview-open-725/',import.meta.url),fixture.input.root,{recursive:true});
   fixture.input.setRecordPath('project.json');
   const [question]=readProject(fixture.input.root).questions;
   assert.ok(question?.editable);
   const before=await jobInputHashes(fixture.input.root),publication=await fixture.publish();
   const asks:PendingAskV3[]=[];
   // Deliver the text ask first to check that the Question takes the primary trigger on mixed load.
   for(const subject of [{kind:'checkpoint',checkpointId:'step-one'},
    {kind:'interview-picks',questionId:question.set.question,setId:question.set.id}] as const){
    const response=await fixture.call({...fixture.input.base(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,
     idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject});
    const result=await response.json() as JobApiResponse;
    assert.ok(result.ok&&result.verb==='ask',JSON.stringify(result));asks.push(result.value);
   }
   const [checkpoint,interview]=asks;
   const form=`#workspace-interview-answer form[data-job-ask="${interview!.askId}"]`;
   const checkpointForm=`form[data-job-ask="${checkpoint!.askId}"]`;
   const selectedQuestion='.block-row:not([hidden]) [data-block-target="question"][aria-selected="true"]';
   const awayTab='.block-row:not([hidden]) [data-block-target="animation-dock"]';
   const questionTrigger='#workspace-pending-ask',recordTrigger='#workspace-pending-record-ask';
   const visiblePainting=`(()=>{const img=document.querySelector('#reference-content img');return img?.naturalWidth===32&&img.getBoundingClientRect().width>0?img.currentSrc:'';})()`;
   const url=new URL(fixture.host.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href);
   await wait(`globalThis.__access756==='pending'`,'mixed Question capability');await page.evaluate<void>(`globalThis.__releaseAccess756()`);
   await wait(`document.body.dataset.ready==='true'&&!!document.querySelector(${JSON.stringify(selectedQuestion)})&&
    !!document.querySelector('${form} fieldset:not(:disabled)')&&!!document.querySelector('#job-record-asks ${checkpointForm} fieldset:not(:disabled)')&&
    ['${questionTrigger}','${recordTrigger}'].every(selector=>{const button=document.querySelector(selector);return button&&!button.hidden&&!button.disabled;})&&Boolean(${visiblePainting})`,'mixed Question and text triggers ready');
   assert.equal(await page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`),false,'neither ask auto-opens a dialog');
   const firstPainting=await page.evaluate<string>(visiblePainting);
   await shot(out,'question');
   await click(page,awayTab);
   await wait(`document.querySelector('${awayTab}')?.getAttribute('aria-selected')==='true'&&document.querySelector('#workspace-interview-answer').hidden`,'different bottom tab selected');
   assert.equal(await page.evaluate<number>(`document.querySelectorAll('${form}').length`),1,'Question form remains mounted');
   assert.equal(await page.evaluate<string>(visiblePainting),firstPainting,'painting stays visible on a different bottom tab');
   await click(page,questionTrigger);
   await wait(`!!document.querySelector(${JSON.stringify(selectedQuestion)})&&document.querySelector('${form}').getClientRects().length>0`,'primary trigger returns to Question');
   assert.equal(await page.evaluate<boolean>(`!!document.querySelector('#job-record-asks[open]')`),false);
   assert.equal(await page.evaluate<string>(visiblePainting),firstPainting);
   await click(page,recordTrigger);
   await wait(`!!document.querySelector('#job-record-asks:modal')`,'secondary trigger opens checkpoint');
   const modal=await screen(out);
   assert.equal(await page.evaluate<boolean>(`!!document.querySelector('#job-record-asks:modal ${checkpointForm} fieldset:not(:disabled)')&&!!document.querySelector(${JSON.stringify(selectedQuestion)})`),true);
   await click(page,'#job-record-asks .workspace-drawer-close');
   await wait(`!document.querySelector('#job-record-asks[open]')`,'mixed checkpoint closed');
   assert.equal(await page.evaluate<string>(`document.activeElement.id`),recordTrigger.slice(1));
   assert.equal(await page.evaluate<string>(visiblePainting),firstPainting);
   const pick=`${form} input[type="radio"][value="keep"]`,submit=`${form} button[type="submit"]`;
   await page.evaluate<void>(`document.querySelector('${pick}').scrollIntoView({block:'center'})`);
   await click(page,pick);
   await page.evaluate<void>(`document.querySelector('${submit}').scrollIntoView({block:'center'})`);
   await click(page,submit);
   await wait(`document.querySelector('${form}')?.dataset.interviewAnswered==='true'&&
    document.querySelector('${form} > [role="status"]')?.dataset.jobText==='job.saved'`,'mixed Question saved');
   assert.equal(await page.evaluate<string>(visiblePainting),firstPainting,'painting stays visible with the answered Question mounted');
   await wait(`document.querySelector('${questionTrigger}').hidden&&
    !document.querySelector('${recordTrigger}').hidden&&!document.querySelector('${recordTrigger}').disabled&&
    !!document.querySelector(${JSON.stringify(selectedQuestion)})`,'answered Question stays selected while the separate checkpoint trigger remains');
   await click(page,recordTrigger);
   await wait(`!!document.querySelector('#job-record-asks:modal ${checkpointForm}')`,'separate trigger opens the remaining checkpoint');
   await assertTextOnlyDialog();
   await click(page,`#job-record-asks ${checkpointForm} button[data-job-text="Pass"]`);
   const catalog=language==='en'?enCatalog:koCatalog;
   await waitForRecordSaved(catalog['Answer saved'],'remaining checkpoint saved and its drawer removed');
   assert.equal(await page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selectedQuestion)})&&!!document.querySelector('${form}[data-interview-answered=true]')`),true);
   assert.equal(await page.evaluate<string>(visiblePainting),firstPainting);
   await shot(out,'question-saved');
   const response=await fixture.call({...fixture.input.base(),verb:'next',after:null,waitMs:0});
   const next=await response.json() as JobApiResponse;
   assert.ok(next.ok&&next.verb==='next',JSON.stringify(next));
   const acts=next.value.events.flatMap(event=>event.type==='act'?[event.act]:[]);
   assert.deepEqual(acts.map(act=>act.askId),[interview!.askId,checkpoint!.askId]);
   const [picks,rawCheckpoint]=acts;
   assert.ok(picks?.kind==='interview-picks');
   assert.deepEqual(picks.source.optionSet,{id:question.set.id,sha256:question.ref.sha256});
   assert.deepEqual(picks.value,{questionId:question.set.question,selections:[{itemId:'reference',optionId:'keep',otherText:null}],note:''});
   const checkpointAct=parseCommentsAct(rawCheckpoint);
   assert.equal(checkpointAct.kind,'checkpoint');
   assert.equal(checkpointAct.source.sourceHash,publication.source.sourceHash);
   assert.deepEqual(checkpointAct.value,{checkpointId:'step-one',planStepId:'step-one',outcome:'pass',comments:[]});
   assert.deepEqual(await jobInputHashes(fixture.input.root),before);
   const result={kind:'mixed-question-checkpoint',language,modal,paintingPath:new URL(firstPainting).pathname,acts,sourceImmutable:true};
   cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');
   console.log('986_MIXED_QUESTION_PASS '+language);
  }catch(error){await shot(out,'failure');throw error;}
  finally{await page.goto('about:blank');await fixture.close();}
 }
 // A copied capability-free link has no act authority, even though its backdrop is still readable.
 if(!sample&&!boundary&&!stageSignoff&&!modalPreload)for(const picture of [true,'parts'] as const)for(const language of ['en','ko'] as const){
  const fixture=await recordScreenFixture('checkpoint',picture),out=join(output,'readonly-link',picture===true?'rig':'parts',language);await mkdir(out,{recursive:true});
  try{
   const url=new URL(fixture.ownerUrl);url.hash='';url.searchParams.set('lang',language);const before=await jobInputHashes(fixture.root);
   await page.goto(url.href);await wait(`globalThis.__access756==='pending'`,'copied link pending access');
   const pending:{state:string;text:string}=await page.evaluate<{state:string;text:string}>(`({state:globalThis.__access756,text:document.body.innerText})`);
   for(const catalog of [enCatalog,koCatalog])assert.equal(pending.text.includes(catalog['Read-only view: reopen with rig-review open to edit.']),false);
   await shot(out,'pending');await page.evaluate(`globalThis.__releaseAccess756()`);
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`,catalog=language==='en'?enCatalog:koCatalog;
   await wait(`!!document.querySelector(${JSON.stringify(selector+' fieldset:disabled')})&&document.getElementById('message')?.textContent===${JSON.stringify(catalog['Read-only view: reopen with rig-review open to edit.'])}`,'copied link resolved readonly');
   const resolved:{state:string;message:string;disabled:boolean}=await page.evaluate<{state:string;message:string;disabled:boolean}>(`({state:globalThis.__access756,message:document.getElementById('message').textContent,disabled:document.querySelector(${JSON.stringify(selector+' fieldset')}).disabled})`);
   assert.equal(resolved.state,'resolved');assert.equal(resolved.disabled,true);
   await page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.querySelector('select[name=outcome]').value='pass';f.requestSubmit();})()`);await new Promise(resolve=>setTimeout(resolve,50));
   assert.equal(fixture.submissions.length,0);assert.deepEqual(await jobInputHashes(fixture.root),before);
   await shot(out,'resolved');const result={kind:'readonly-link',picture,language,pending,resolved,sourceImmutable:true,submissions:fixture.submissions.length};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('756_READONLY_LINK_PASS '+picture+' '+language);
  }catch(error){await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));await writeFile(join(output,'result.json'),JSON.stringify({cases:cases.length,viewport:[1600,1000],errors,sample,results:cases},null,2)+'\n');console.log('715_BROWSER_PASS cases='+cases.length);
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,cases},null,2)+'\n');if(page)await shot(output,'failure');throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
