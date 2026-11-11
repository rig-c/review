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
import {parseRecordAct,parseCommentsAct} from '../src/job-api.ts';
import {JOB_API_SCHEMA,type PendingAskV3} from '../src/job-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
const arg=(key:string)=>{const at=Bun.argv.indexOf(key);return at<0?undefined:Bun.argv[at+1];};
const output=resolve(arg('--out')??'artifacts/715');await mkdir(output,{recursive:true});
if(Bun.argv.includes('--serve')){
 const kinds=(arg('--kind')?[arg('--kind')]:['checkpoint','signoff','reopen']) as RecordScreenKind[];
 const fixtures=[];
 for(const kind of kinds){const fixture=await recordScreenFixture(kind,true);fixtures.push(fixture);const url=new URL(fixture.ownerUrl);url.searchParams.set('lang','en');console.log(JSON.stringify({url:url.href,pid:process.pid,kind,sourceHash:fixture.display.publication.source.sourceHash,fixture:'synthetic trusted record host; shared screen'}));}
 await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});for(const fixture of fixtures)await fixture.close();process.exit(0);
}
const profile=await mkdtemp(join(tmpdir(),'review-715-browser-'));let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const errors:unknown[]=[],cases:unknown[]=[],commentPosts:string[]=[];
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('715_WAIT '+label);}
async function shot(out:string,name:string){await writeFile(join(out,name+'.png'),await page!.screenshot());}
async function closeDialog(){await click(page!,'#job-record-asks .workspace-drawer-close');await wait(`!document.querySelector('#job-record-asks[open]')`,'dialog closed');assert.equal(await page!.evaluate(`document.activeElement.id`),'workspace-pending-ask');}
async function addGeneral(text:string){await click(page!,'[data-comment-general]');await wait(`!!document.querySelector('.stage-comment-composer input')`,'general composer');await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'general saved');}
async function screen(out:string){const state=await page!.evaluate<any>(`(()=>{const d=document.querySelector('#job-record-asks'),r=d.getBoundingClientRect();return {language:document.documentElement.lang,width:innerWidth,height:innerHeight,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,dialogs:document.querySelectorAll('#job-record-asks').length,legacy:document.querySelectorAll('[data-job-forms],[data-job-plan-workspace]').length,notes:d.querySelectorAll('textarea[name=note]').length,focusContained:d.contains(document.activeElement),rect:{x:r.x,y:r.y,width:r.width,height:r.height},controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id)};})()`);
 assert.equal(state.width,1600);assert.equal(state.height,1000);assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.dialogs,1);assert.equal(state.legacy,0);assert.equal(state.notes,0);assert.equal(state.focusContained,true);assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);assert.ok(state.rect.x>=0&&state.rect.y>=0&&state.rect.x+state.rect.width<=1600&&state.rect.y+state.rect.height<=1000);await shot(out,'modal');return state;}
try{
 page=await launchCdpSession(profile,{onEvent:(event,send)=>{command=send;if(event.method==='Runtime.exceptionThrown')errors.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request?.method==='POST'&&new URL(request.url).pathname.endsWith('/comment'))commentPosts.push(request.url);}}});await command!('Network.enable');await page.setViewport(1600,1000);
 const boundary=Bun.argv.includes('--parts-only'),sample=Bun.argv.includes('--sample'),kinds:RecordScreenKind[]=sample?['checkpoint']:['checkpoint','signoff','reopen'];
 for(const kind of kinds)for(const picture of sample?[false]:kind==='checkpoint'?[false,true,'parts'] as const:[false,true])for(const language of sample?['en'] as const:['en','ko'] as const){
  if(boundary&&picture!=='parts')continue;
  const fixture=await recordScreenFixture(kind,picture),out=join(output,kind,picture==='parts'?'parts':picture?'picture':'empty',language);await mkdir(out,{recursive:true});fixture.output(out);
  const before=await jobInputHashes(fixture.root),selector=`form[data-job-ask="${fixture.ask.askId}"]`,catalog=language==='en'?enCatalog:koCatalog;
  try{
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href);
   await wait(`!!document.querySelector('#stage-comment-list')&&!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'receipt');
   await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'ask line opens');
   const state=await screen(out);assert.equal(state.language,language);await closeDialog();
   await page.evaluate(`(()=>{const b=[...document.querySelectorAll('.inspector-heading button')].find(n=>n.textContent.includes(${JSON.stringify(language==='en'?'Comments':'코멘트')}));if(!b)throw new Error('COMMENTS_TAB_MISSING');b.click();})()`);
   if(picture==='parts'){const posts=commentPosts.length;await click(page,'#stage-comment');assert.equal(await page.evaluate(`document.getElementById('stage-comment-refusal').textContent`),catalog['Read-only view: reopen with rig-review open to edit.']);assert.equal(await page.evaluate(`document.querySelectorAll('.stage-comment-composer').length`),0);assert.equal(commentPosts.length,posts);await shot(out,'pointed-read-only-refusal');}
   await addGeneral('First comment · 원문 '+language);await addGeneral('Second comment · 둘째 '+language);
   if(picture===true){
    await click(page,'#stage-comment');const box=await page.evaluate<any>(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await command!('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await command!('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    await wait(`!!document.querySelector('.stage-comment-composer input')`,'point composer');await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value='Pointed comment · 그림';f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'point saved');
   }
   const drafts:[string,string][]=await page.evaluate<[string,string][]>(`Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-record-comments/1:'))`);assert.equal(drafts.length,1);const [key,raw]=drafts[0]!,draft=JSON.parse(raw);assert.equal(draft.publicationId,fixture.ask.publicationId);assert.equal(draft.sourceHash,fixture.display.publication.source.sourceHash);assert.equal(draft.comments.length,picture===true?3:2);
   const expected=projectComments(draft.comments.map((row:any)=>row.target?feedbackItemComments([row])[0]:{text:row.summary}));
   await page.goto('about:blank');await page.goto(url.href);await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===${draft.comments.length}&&!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'source draft restore');
   await shot(out,'comments-restored');
   await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'reopen after reload');
   if(kind==='checkpoint')await page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.querySelector('select[name=outcome]').value='pass';f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await shot(out,'before-submit');await click(page,selector+' button[type=submit]');await wait(`document.querySelector(${JSON.stringify(selector+' [role=status]')})?.textContent===${JSON.stringify(catalog['job.saved'])}`,'saved');
   const act=parseRecordAct(JSON.parse(await readFile(join(out,'one-screen.json'),'utf8')));assert.equal(act.source.sourceHash,fixture.display.publication.source.sourceHash);assert.notEqual(act.kind,'interview-picks');if(act.kind!=='interview-picks')assert.equal(act.value.words,expected);assert.equal('feedback' in act.value,false);assert.equal('comments' in act.value,false);
   await shot(out,'submitted');await page.evaluate(`(()=>{const d=JSON.parse(localStorage.getItem(${JSON.stringify(key)}));d.sourceHash='0'.repeat(64);localStorage.setItem(${JSON.stringify(key)},JSON.stringify(d));})()`);await page.goto('about:blank');await page.goto(url.href);await wait(`!!document.querySelector('#stage-comment-list')&&!!document.querySelector(${JSON.stringify(selector)})`,'mismatched reload');assert.equal(await page.evaluate(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length`),0);
   assert.deepEqual(await jobInputHashes(fixture.root),before);const result={kind,picture,language,state,comments:draft.comments.length,sourceHash:act.source.sourceHash,sourceDraftRestored:true,mismatchedDraftRefused:true,pointedRefusedByReadOnly:picture==='parts',scalarOnly:true,words:expected,actPath:join(out,'one-screen.json')};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_CASE_PASS '+kind+' '+picture+' '+language);
  }catch(error){await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 if(!sample)for(const parts of boundary?[true]:[false,true])for(const language of ['en','ko'] as const){
  const fixture=parts?await scriptedJobWindowFixture({c5Parts:'mesh'}):await realJobWindowFixture(),out=join(output,parts?'mixed-parts':'mixed',language);await mkdir(out,{recursive:true});
  try{
   const publication=parts?await (fixture as Awaited<ReturnType<typeof scriptedJobWindowFixture>>).publish('parts'):await (fixture as Awaited<ReturnType<typeof realJobWindowFixture>>).publish(),asks:PendingAskV3[]=[];
   for(const subject of [parts?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:'rig-review'},{kind:'signoff',stage:'plan-approved'}] as const){const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject});const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));asks.push(value.value);}
   const before=await jobInputHashes(fixture.input.root),url=new URL(fixture.host.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href);await wait(`!!document.querySelector('#stage-comment-list')&&!!document.querySelector('#rig-root canvas')&&!!document.querySelector('#workspace-pending-ask:not(:disabled):not([hidden])')`,'mixed ready');await click(page,'#workspace-pending-ask');const state=await screen(out);const form=`form[data-job-ask="${asks[1]!.askId}"]`;await click(page,form+' button[type=submit]');const catalog=language==='en'?enCatalog:koCatalog;await wait(`document.querySelector(${JSON.stringify(form+' [role=status]')})?.textContent===${JSON.stringify(catalog['job.saved'])}`,'mixed signoff');await closeDialog();
   if(!parts)await page.evaluate(`(()=>{const s=document.querySelector('#review-status');s.value='approved';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click(page,'#save');await wait(`document.querySelector('#message')?.textContent===${JSON.stringify(catalog['job.saved'])}`,'mixed verdict');
   const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'next',after:null,waitMs:0}),next=await response.json();assert.equal(next.ok,true);const acts=next.value.events.filter((event:any)=>event.type==='act').map((event:any)=>event.act);assert.deepEqual(acts.map((act:any)=>act.kind),['signoff',parts?'parts-verdict':'review-verdict']);for(const act of acts){parseCommentsAct(act);assert.equal(act.source.sourceHash,publication.source.sourceHash);}assert.deepEqual(await jobInputHashes(fixture.input.root),before);await shot(out,'submitted');const result={kind:parts?'mixed-parts':'mixed',language,state,acts,sourceImmutable:true};cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('715_MIXED_PASS '+language);
  }catch(error){await shot(out,'failure');throw error;}finally{await page.goto('about:blank');await fixture.close();}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));await writeFile(join(output,'result.json'),JSON.stringify({cases:cases.length,viewport:[1600,1000],errors,sample,results:cases},null,2)+'\n');console.log('715_BROWSER_PASS cases='+cases.length);
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),errors,cases},null,2)+'\n');if(page)await shot(output,'failure');throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
