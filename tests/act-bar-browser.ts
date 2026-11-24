/** Synthetic #809/#825 screen coverage. Ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {joinProject} from '../src/joined-project.ts';
import {startServer} from '../src/server.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {loadReview} from '../src/manifest.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
const out=Bun.argv[Bun.argv.indexOf('--out')+1]??'artifacts/act-bar';await mkdir(out,{recursive:true});
const observations:unknown[]=[],failures:string[]=[];
const flashOnly=Bun.argv.includes('--flash-only');
const saveRetryOnly=Bun.argv.includes('--save-retry-only');
type SaveRetrySnapshot={stateKind:string;stateText:string;stateTitle:string;messageText:string;messageError:boolean;messageVisible:boolean;saveDisabled:boolean};
const sampleActBar=`(()=>{
 const samples=[];window.__actFlashSamples=samples;
 const visible=n=>!!n&&!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden'&&!n.closest('dialog:not([open])');
 function sample(){const bar=document.querySelector('#workspace-review-act');if(bar){
  const save=document.querySelector('#save'),status=document.querySelector('#review-status'),label=document.querySelector('label[for="review-status"]');
  const row={at:performance.now(),ready:document.body.dataset.ready==='true',legacySave:visible(save)&&/^(Submit review|리뷰 제출)$/.test(save.textContent.trim()),status:visible(status),label:visible(label),answer:visible(save)&&/^(Approve|승인)$/.test(save.textContent.trim())||visible(document.querySelector('#workspace-pending-ask')),barVisible:visible(bar)};
  if(samples.length<2000)samples.push(row);
 }requestAnimationFrame(sample);}requestAnimationFrame(sample);
})()`;

async function until(page:InputCdpSession,expression:string){const end=Date.now()+20000;while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(100);}throw Error('ACT_BAR_WAIT: '+expression);}
for(const lang of ['en','ko'] as const)for(const mode of ['rig','direction','parts','signoff-model','signoff-record','checkpoint-pass','checkpoint-fail','interview','interview-rig','interview-parts','joined-interview','standalone'] as const){
 if(saveRetryOnly&&!['rig','parts'].includes(mode))continue;
 const profile=await mkdtemp(join(tmpdir(),'review809-browser-'));let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 try{
  let url:string,draftKey:string|undefined;
  if(mode==='standalone'){
   const f=await jobFixture(),capability='b'.repeat(64);const server=await startServer(await loadReview(join(f.root,'out')),{port:0,capability,stateDir:f.state});
   close=async()=>{server.stop(true);await f.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(mode==='joined-interview'){
   const f=await interviewOpenFixture(2);const capability='a'.repeat(64);
   const server=await startServer(null,{port:0,capability,joined:joinProject(null,f.inputs.project),stateDir:f.stateDir});
   close=async()=>{server.stop(true);await f.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(['rig','direction','parts','signoff-model'].includes(mode)){
   const f=await scriptedJobWindowFixture({c5Parts:'mesh'});close=()=>f.close();
   const stage=mode==='signoff-model'?'rig':mode as 'rig'|'direction'|'parts';
   const p=await f.publish(stage);draftKey=`rig-review-draft/1:single:${p.source.package.id}:${p.source.sourceHash}:${p.source.sourceHash}`;
   await f.ask(p,mode==='signoff-model'?{kind:'signoff',stage:'plan-approved'}:mode==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:mode==='rig'?'rig-review':'direction-review'});
   url=f.locator+'/#cap='+f.credentials.ui;
  }else{
   const f=await recordScreenFixture(mode.startsWith('interview')?'interview-picks':mode==='signoff-record'?'signoff':'checkpoint',mode==='interview-rig'?true:mode==='interview-parts'?'parts':false);close=()=>f.close();url=f.ownerUrl;
  }
  const localized=new URL(url);localized.searchParams.set('lang',lang);url=localized.href;
  let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined;let held=0,actSaveStep=0,heldActRequest:string|undefined;
  page=await launchCdpSession(profile,{browserArgs:['--force-device-scale-factor=2'],onEvent:async(event,send)=>{
   if(event.sessionId)control=(method,params)=>(send as any)(method,params,event.sessionId);
   if(event.method==='Fetch.requestPaused'&&control){
    const cdp=control,request=event.params as {requestId:string;request?:{url?:string}};
    if(request.request?.url?.endsWith('/ui/acts')){
     actSaveStep++;heldActRequest=request.requestId;return;
    }
    const state=await cdp('Runtime.evaluate',{expression:`!!document.querySelector('#workspace-review-act')&&document.body.dataset.ready!=='true'`,returnByValue:true});
    if(state.result?.value){held++;await Bun.sleep(1000);}
    await cdp('Fetch.continueResponse',{requestId:request.requestId});
   }
  }});await page.setViewport(1440,900);
  assert.ok(control);await control('Page.addScriptToEvaluateOnNewDocument',{source:sampleActBar});
  await control('Network.enable');await control('Network.setCacheDisabled',{cacheDisabled:true});
  await control('Fetch.enable',{patterns:[{urlPattern:'*api/review*',requestStage:'Response'},{urlPattern:'*review-painting*',requestStage:'Response'},{urlPattern:'*api/stage-parts/image/*',requestStage:'Response'},{urlPattern:'*assets/*',requestStage:'Response'}]});
  await page.goto(url,lang);
  await until(page,`(${mode==='standalone'}?!!document.querySelector('#rig-root canvas'):document.body.dataset.ready==='true')&&!document.body.inert&&(${mode==='joined-interview'||mode==='standalone'}||!!document.querySelector('#workspace-ask-headline')?.textContent)`);
  const interview=mode.startsWith('interview')||mode==='joined-interview';
  const answerRoot=interview?'#workspace-interview-answer':'#job-record-asks';
  // #1041: the question is shown in the right communication panel, not a bottom tab.
  const questionSelected=`(()=>{const n=document.querySelector('#workspace-interview-answer');return !!n&&!n.hidden&&!!n.closest('#workspace-communication:not([hidden])')&&n.getClientRects().length>0;})()`;
  const recordDialogClosed=`!document.querySelector('#workspace-communication:not([hidden]) #job-record-asks:not([hidden])')`;
  const questionReady=`${questionSelected}&&${recordDialogClosed}&&!!document.querySelector('${answerRoot} form.interview-answer fieldset:not(:disabled)')`;
  const questionSaved=`${questionSelected}&&${recordDialogClosed}&&!!document.querySelector('${answerRoot} form.interview-answer[data-interview-answered=true]')`;
  if(interview)await until(page,questionReady);
  const boot=await page.evaluate<any>(`(()=>{const visible=n=>!!n&&!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden'&&!n.closest('dialog:not([open])');const bar=document.querySelector('#workspace-review-act');const nodes=['review-message','review-draft-state','draft-state','dirty'].map(id=>{const n=document.getElementById(id);return {id,text:n?.textContent.trim(),visible:visible(n),inBar:!!n&&bar.contains(n)};});const primary=nodes.find(n=>n.id==='review-draft-state')?.text;return {samples:window.__actFlashSamples,held:${held},nodes,saveStates:nodes.filter(n=>n.visible&&n.inBar&&n.text&&(n.text===primary||/^(Not submitted|제출되지 않음)$/.test(n.text))),home:bar.parentElement?.id,inHeading:!!bar.closest('.inspector-heading'),rowVisible:!!document.querySelector('#workspace-act-row')?.getClientRects().length,visibleStates:nodes.filter(n=>n.visible&&['review-draft-state','draft-state','dirty'].includes(n.id)&&n.text).map(n=>n.id),standaloneSave:document.querySelector('#save').textContent};})()`);
  observations.push({mode,lang,boot});
  await writeFile(join(out,'loading-observations.json'),JSON.stringify(observations,null,2));
  await writeFile(join(out,`${mode}-${lang}-loaded.png`),await page.screenshot());
  const legacy=boot.samples.filter((row:any)=>row.legacySave||row.status||row.label);
  if(legacy.length)failures.push(mode+'/'+lang+' legacy controls in '+legacy.length+' frames');
  if(boot.saveStates.length!==1)failures.push(mode+'/'+lang+' save-state count '+boot.saveStates.length);
  assert.equal(boot.home,'workspace-act-row');assert.equal(boot.inHeading,false);assert.equal(boot.rowVisible,true);assert.deepEqual(boot.visibleStates,['review-draft-state']);
  if(flashOnly||mode==='standalone')continue;
  const state=await page.evaluate<any>(`(()=>{const visible=n=>n.getClientRects().length>0&&!n.closest('dialog:not([open])');const headline=document.querySelector('#workspace-ask-headline');return {language:document.documentElement.lang,primary:[...document.querySelectorAll('#workspace-review-act button.primary')].filter(visible).map(n=>n.id),question:headline.textContent,whiteSpace:getComputedStyle(headline).whiteSpace,overflow:getComputedStyle(headline).textOverflow,changesDisabled:document.querySelector('#request-changes').disabled,saveHidden:document.querySelector('#save').hidden};})()`);
  assert.equal(state.language,lang);assert.equal(state.primary.length,1,mode+' one emphasised act-bar answer');assert.notEqual(state.whiteSpace,'nowrap');assert.notEqual(state.overflow,'ellipsis');
  if(['rig','direction','parts'].includes(mode))assert.equal(state.changesDisabled,true);
  await writeFile(join(out,`${mode}-${lang}-pending.png`),await page.screenshot());
  if(mode==='rig'){
   await click(page,'#zoom-in');await until(page,`Object.keys(localStorage).some(key=>key.startsWith('rig-review-draft/1:'))`);
   draftKey=await page.evaluate<string>(`Object.keys(localStorage).find(key=>key.startsWith('rig-review-draft/1:'))`);
   // Leave the app before planting so its departure flush cannot overwrite the planted bytes.
   await page.goto(new URL('/favicon.ico',url).href);
   await page.evaluate(`localStorage.setItem(${JSON.stringify(draftKey)},'{corrupt saved draft')`);await page.goto(url,lang);
   await until(page,`document.body.dataset.ready==='true'&&!document.body.inert`);
   const recovery=await page.evaluate<any>(`({blocked:document.querySelector('#save').disabled&&document.querySelector('#request-changes').disabled,text:document.querySelector('#review-draft-state').textContent,recoveryVisible:!!document.querySelector('#workspace-act-row #review-draft-recovery').getClientRects().length&&document.querySelector('#review-draft-recovery').children.length>0})`);
   assert.equal(recovery.blocked,true);assert.equal(recovery.recoveryVisible,true);assert.ok(recovery.text.includes(lang==='ko'?'초안을 불러오지':'Saved draft could not be restored'));
   await writeFile(join(out,`restore-failure-${lang}.png`),await page.screenshot());
   await page.evaluate(`document.querySelector('#workspace-act-row #review-draft-recovery button:last-child').click()`);
   await until(page,`!document.querySelector('#save').disabled`);
  }
  if(!['rig','direction','parts'].includes(mode)){
   await click(page,'#workspace-pending-ask');await until(page,interview?questionReady:`!!document.querySelector('#workspace-communication:not([hidden]) #job-record-asks:not([hidden])')`);
   assert.equal(await page.evaluate(`!!document.querySelector('[data-job-checkpoint-evidence]')`),false);
   const chooseDefaults=`(()=>{const seen=new Set();for(const radio of document.querySelectorAll(${JSON.stringify(answerRoot+' input[type=radio]')}))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`;
   if(interview)await page.evaluate<void>(chooseDefaults);
   const selector=mode==='checkpoint-fail'?'#job-record-asks button[data-job-text="job.fail"]':mode==='checkpoint-pass'?'#job-record-asks button[data-job-text="Pass"]':answerRoot+' button[type=submit]';
   await writeFile(join(out,`${mode}-${lang}-answer.png`),await page.screenshot());
   const scrollToSubmit=`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`;
   if(interview)await page.evaluate<void>(scrollToSubmit);
   await click(page,selector);
   await until(page,`${interview?questionSaved:recordDialogClosed}&&document.querySelector('#review-draft-state')?.textContent.toLowerCase().includes(${JSON.stringify(lang==='ko'?'저장':'saved')})`);
   await writeFile(join(out,`${mode}-${lang}-saved.png`),await page.screenshot());
   if(mode==='joined-interview'){
    assert.equal(await page.evaluate(`document.querySelector('#workspace-pending-ask').disabled`),false,'saved first answer leaves the opener enabled');
    await click(page,'#workspace-pending-ask');await until(page,questionSaved);
    const secondQuestion=answerRoot+' .interview-questions li:nth-child(2) button';
    await page.evaluate<void>(`document.querySelector(${JSON.stringify(secondQuestion)}).scrollIntoView({block:'nearest'})`);
    await click(page,secondQuestion);
    await until(page,`${questionReady}&&!document.querySelector('${answerRoot} form.interview-answer').matches('[data-interview-answered=true]')`);
    await page.evaluate<void>(chooseDefaults);
    await page.evaluate<void>(scrollToSubmit);
    await click(page,selector);
    await until(page,`${questionSaved}&&!document.querySelector('#workspace-pending-ask').disabled`);
    const saved=await page.evaluate<number>(`fetch('/api/interview').then(r=>r.json()).then(data=>data.questions.filter(question=>question.saved).length)`);
    assert.equal(saved,2,'both joined interview questions reached the real picks route');
    await writeFile(join(out,`${mode}-${lang}-second-saved.png`),await page.screenshot());
   }
  }
  if(['rig','direction','parts'].includes(mode)){
   if(mode==='rig'||mode==='parts'){
    const readSaveState=`(()=>{const s=document.getElementById('review-draft-state'),m=document.getElementById('review-message'),v=!!m&&!!m.getClientRects().length&&getComputedStyle(m).display!=='none'&&getComputedStyle(m).visibility!=='hidden';return {stateKind:s?.dataset.saveState??'',stateText:s?.textContent??'',stateTitle:s?.getAttribute('title')??'',messageText:m?.textContent??'',messageError:m?.classList.contains('error')??false,messageVisible:v,saveDisabled:document.getElementById('save')?.disabled??false};})()`;
    await control('Fetch.enable',{patterns:[{urlPattern:'*ui/acts*',requestStage:'Request'}]});
    const waitHeldAct=async()=>{const end=Date.now()+20000;while(Date.now()<end){if(heldActRequest)return heldActRequest;await Bun.sleep(50);}throw Error('ACT_BAR_WAIT: heldActRequest');};
    const fulfillRefusal=async(requestId:string,code:string,status:number)=>{
     heldActRequest=undefined;
     await control!('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],
      body:Buffer.from(JSON.stringify({ok:false,error:{code,message:code}})).toString('base64')});
    };
    const expectedSaving=lang==='ko'?'저장 중…':'Saving…';
    await click(page,'#save');
    const firstReq=await waitHeldAct();
    const firstSaving=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(firstSaving.stateKind!=='saving'||firstSaving.stateText!==expectedSaving)
     failures.push(`${mode}/${lang} first saving expected ${expectedSaving}, got ${firstSaving.stateKind}:${firstSaving.stateText}`);
    await fulfillRefusal(firstReq,'JOB_ACT_INVALID',400);
    await until(page,`!document.getElementById('save').disabled&&document.getElementById('review-draft-state')?.dataset.saveState==='failed'`);
    const firstFailed=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(!firstFailed.messageError||!firstFailed.messageText||firstFailed.stateKind!=='failed'||firstFailed.stateText!==firstFailed.messageText||!firstFailed.stateTitle.startsWith('JOB_ACT_INVALID'))
     failures.push(`${mode}/${lang} first failed state mismatch: ${JSON.stringify(firstFailed)}`);
    await click(page,'#save');
    const secondReq=await waitHeldAct();
    const retrySaving=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(retrySaving.stateKind!=='saving'||retrySaving.stateText!==expectedSaving)
     failures.push(`${mode}/${lang} retry saving expected ${expectedSaving}, got ${retrySaving.stateKind}:${retrySaving.stateText}`);
    if(retrySaving.stateTitle!==''||retrySaving.messageError||retrySaving.messageText!==''||retrySaving.messageVisible)
     failures.push(`${mode}/${lang} stale failure remained during retry: ${JSON.stringify(retrySaving)}`);
    await fulfillRefusal(secondReq,'JOB_BODY_LIMIT',413);
    await until(page,`!document.getElementById('save').disabled&&document.getElementById('review-draft-state')?.dataset.saveState==='failed'`);
    const secondFailed=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(!secondFailed.messageError||!secondFailed.messageText||secondFailed.stateKind!=='failed'||secondFailed.stateText!==secondFailed.messageText||!secondFailed.stateTitle.startsWith('JOB_BODY_LIMIT')||secondFailed.messageText===firstFailed.messageText)
     failures.push(`${mode}/${lang} second failed state mismatch: ${JSON.stringify(secondFailed)}`);
    await click(page,'#save');
    const thirdReq=await waitHeldAct();
    const finalSaving=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(finalSaving.stateKind!=='saving'||finalSaving.stateText!==expectedSaving||finalSaving.messageError||finalSaving.messageText!=='')
     failures.push(`${mode}/${lang} final retry saving mismatch: ${JSON.stringify(finalSaving)}`);
    heldActRequest=undefined;
    await control('Fetch.continueRequest',{requestId:thirdReq});
   }else{
    await click(page,'#save');
   }
   await until(page,`document.querySelector('#save').hidden&&document.querySelector('#workspace-pending-ask').hidden`);
   const done=await page.evaluate<any>(`({question:document.querySelector('#workspace-ask-headline').textContent,primary:[...document.querySelectorAll('#workspace-review-act button.primary')].filter(n=>n.getClientRects().length>0&&!n.closest('dialog:not([open])')).length})`);
   assert.equal(done.primary,0);
   assert.equal(await page.evaluate(`document.getElementById('workspace-act-row').hidden`),true);
   assert.deepEqual(await page.evaluate(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['dirty']);
   await writeFile(join(out,`${mode}-${lang}-submitted.png`),await page.screenshot());
  }
  observations.push({mode,...state});
 }catch(error){await writeFile(join(out,`${mode}-${lang}-failure.json`),JSON.stringify({error:String(error),html:await page?.evaluate('document.body.innerText')},null,2));throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});}
}
await writeFile(join(out,'observations.json'),JSON.stringify(observations,null,2));console.log(JSON.stringify({observations:observations.length,output:out,failures}));assert.deepEqual(failures,[]);
