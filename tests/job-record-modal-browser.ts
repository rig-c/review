/** #715 ordinary Nova: shared ask dialog and Comments, source-bound record drafts and mixed rig asks.
 * Synthetic trusted record reader/writer and real shared UI. Scalar-only words transport; no producer conformance claim. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {realJobWindowFixture,scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {feedbackItemComments,projectComments} from '../src/stage-comment.ts';
import {parseRecordAct,parseCommentsAct,parseRecordSubject} from '../src/job-api.ts';
import {JOB_API_SCHEMA,type PendingAskV3} from '../src/job-contract.ts';
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
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('715_WAIT '+label);}
async function shot(out:string,name:string){await writeFile(join(out,name+'.png'),await page!.screenshot());}
async function closeDialog(){await click(page!,'#job-record-asks .workspace-drawer-close');await wait(`!document.querySelector('#job-record-asks[open]')`,'dialog closed');assert.equal(await page!.evaluate(`document.activeElement.id`),'workspace-pending-ask');}
async function addGeneral(text:string){await click(page!,'[data-comment-general]');await wait(`!!document.querySelector('.stage-comment-composer input')`,'general composer');await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'general saved');}
async function screen(out:string,fixture?:Awaited<ReturnType<typeof recordScreenFixture>>){const state=await page!.evaluate<any>(`(()=>{const d=document.querySelector('#job-record-asks'),r=d.getBoundingClientRect();return {open:d.open,workspaceReady:document.body.dataset.ready,activeElement:{tag:document.activeElement?.tagName,id:document.activeElement?.id,name:document.activeElement?.getAttribute('name')},dialogState:[...document.querySelectorAll('dialog')].map(n=>({id:n.id,open:n.open,containsFocus:n.contains(document.activeElement)})),language:document.documentElement.lang,capabilityState:globalThis.__access756??'not-requested',ownerFieldsEnabled:!!d.querySelector('form fieldset:not(:disabled)'),backdropMessage:document.getElementById('message')?.textContent??'',visibleText:document.body.innerText,width:innerWidth,height:innerHeight,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,dialogs:document.querySelectorAll('#job-record-asks').length,legacy:document.querySelectorAll('[data-job-forms],[data-job-plan-workspace]').length,notes:d.querySelectorAll('textarea[name=note]').length,focusContained:d.contains(document.activeElement),rect:{x:r.x,y:r.y,width:r.width,height:r.height},controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id)};})()`);
 await writeFile(join(out,'screen-state.json'),JSON.stringify(state,null,2)+'\n');assert.equal(state.open,true,'ask dialog opens before focus and geometry checks');assert.equal(state.width,1600);assert.equal(state.height,1000);assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.dialogs,1);assert.equal(state.legacy,0);assert.equal(state.notes,0);assert.equal(state.focusContained,true);assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);assert.ok(state.rect.x>=0&&state.rect.y>=0&&state.rect.x+state.rect.width<=1600&&state.rect.y+state.rect.height<=1000);if(fixture){
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
   await click(page,'#stage-comment');
   if(picture==='parts'){const posts=commentPosts.length;await click(page,'#stage-comment');assert.equal(await page.evaluate(`document.getElementById('stage-comment-refusal').textContent`),catalog['JOB_REVIEW_READ_ONLY']);assert.equal(await page.evaluate(`document.querySelectorAll('.stage-comment-composer').length`),0);assert.equal(commentPosts.length,posts);await shot(out,'pointed-read-only-refusal');}
   await addGeneral('First comment · 원문 '+language);await addGeneral('Second comment · 둘째 '+language);
   if(picture===true){
    await click(page,'#stage-comment');const box=await page.evaluate<any>(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await command!('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await command!('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    await wait(`!!document.querySelector('.stage-comment-composer input')`,'point composer');await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value='Pointed comment · 그림';f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'point saved');
   }
   const drafts:[string,string][]=await page.evaluate<[string,string][]>(`Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-record-comments/1:'))`);assert.equal(drafts.length,1);const [key,raw]=drafts[0]!,draft=JSON.parse(raw);assert.equal(draft.publicationId,fixture.ask.publicationId);assert.equal(draft.sourceHash,fixture.display.publication.source.sourceHash);assert.equal(draft.comments.length,picture===true?3:2);
   const expected=projectComments(draft.comments.map((row:any)=>row.target?feedbackItemComments([row])[0]:{text:row.summary}));
   await page.goto('about:blank');await page.goto(url.href);if(picture){await wait(`globalThis.__access756==='pending'`,'reload capability');await page.evaluate(`globalThis.__releaseAccess756()`);}await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===${draft.comments.length}&&!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'source draft restore');
   await shot(out,'comments-restored');
   await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'reopen after reload');
   if(kind==='checkpoint')await page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.querySelector('select[name=outcome]').value='pass';f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await shot(out,'before-submit');await click(page,selector+' button[type=submit]');await wait(`document.querySelector(${JSON.stringify(selector+' [role=status]')})?.textContent===${JSON.stringify(catalog['job.saved'])}`,'saved');
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
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'mixed ask dialog opens');const state=await screen(out);const form=`form[data-job-ask="${asks[1]!.askId}"]`;await click(page,form+' button[type=submit]');await wait(`document.querySelector(${JSON.stringify(form+' [role=status]')})?.textContent===${JSON.stringify(catalog['job.saved'])}`,'mixed signoff');await wait(`!document.querySelector('#job-record-asks[open]')`,'mixed save auto-closed');assert.equal(await page.evaluate(`document.querySelector('#job-record-asks').open`),false,'#809 saving automatically closes the answer dialog');if(await page.evaluate(`!!document.querySelector('#job-record-asks[open]')`))await closeDialog();
   // #845 coalesces the completed answer's save state into the topbar; the verdict was asserted above.
   const answeredLabel=language==='en'?'Answer saved':koCatalog['Answer saved'];
   await wait(`['review-draft-state','dirty'].every(id=>{const node=document.getElementById(id);return node?.textContent===${JSON.stringify(answeredLabel)}&&node.dataset.saveState==='saved';})&&document.getElementById('workspace-act-row').hidden&&['dirty','review-draft-state','draft-state'].filter(id=>document.getElementById(id).getClientRects().length>0).join(',')==='dirty'`,'mixed answer saved phase has one visible topbar save state');
   const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0}),next=await response.json();assert.equal(next.ok,true);const acts=next.value.events.filter((event:any)=>event.type==='act').map((event:any)=>event.act);assert.deepEqual(acts.map((act:any)=>act.kind),[parts?'parts-verdict':'review-verdict','signoff']);for(const act of acts){parseCommentsAct(act);assert.equal(act.source.sourceHash,publication.source.sourceHash);}assert.deepEqual(await jobInputHashes(fixture.input.root),before);await shot(out,'submitted');const submittedUi=await page.evaluate(`({message:document.getElementById('message')?.textContent,dirty:document.getElementById('dirty')?.textContent,review:document.querySelector('#review-status')?.value,saveDisabled:document.querySelector('#save')?.disabled,actState:['dirty','review-draft-state','draft-state'].map(id=>{const node=document.getElementById(id);return {id,text:node?.textContent,kind:node?.dataset.saveState,visible:!!node?.getClientRects().length};})})`);const result={kind:parts?'mixed-parts':'mixed',language,state,submittedUi,transport:actTransport.filter(event=>event.path.includes('/jobs/'+fixture.host.session.jobId+'/')),acts,sourceImmutable:true};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_MIXED_PASS '+language);
  }catch(error){const ui=await page.evaluate(`({message:document.getElementById('message')?.textContent,dirty:document.getElementById('dirty')?.textContent,review:document.querySelector('#review-status')?.value,saveDisabled:document.querySelector('#save')?.disabled,activeElement:document.activeElement?.id,dialogs:[...document.querySelectorAll('dialog')].map(n=>({id:n.id,open:n.open}))})`);const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0});const next=await response.json();await writeFile(join(out,'failure-state.json'),JSON.stringify({error:String(error),ui,next,actTransport},null,2)+'\n');await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
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
