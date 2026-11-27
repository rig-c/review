/** Synthetic #809/#825 screen coverage. Ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {startServer} from '../src/server.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {loadReview} from '../src/manifest.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {expectRecordActSubmitted} from './helpers/record-act-browser-status.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
const out=Bun.argv[Bun.argv.indexOf('--out')+1]??'artifacts/act-bar';await mkdir(out,{recursive:true});
const observations:unknown[]=[],failures:string[]=[];
const flashOnly=Bun.argv.includes('--flash-only');
const saveRetryOnly=Bun.argv.includes('--save-retry-only');
type SaveRetrySnapshot={stateKind:string;stateText:string;stateTitle:string;messageText:string;messageError:boolean;messageVisible:boolean;footerText:string;saveDisabled:boolean};
const sampleActBar=`(()=>{
 const samples=[];window.__actFlashSamples=samples;
 const visible=n=>!!n&&!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden'&&!n.closest('dialog:not([open])');
 function sample(){const bar=document.querySelector('#workspace-review-act');if(bar){
  const save=document.querySelector('#save'),status=document.querySelector('#review-status'),label=document.querySelector('label[for="review-status"]');
  const row={at:performance.now(),ready:document.body.dataset.ready==='true',legacySave:visible(save)||visible(document.getElementById('request-changes')),status:visible(status),label:visible(label),answer:visible(save)&&/^(Approve|승인)$/.test(save.textContent.trim())||visible(document.querySelector('#workspace-pending-ask')),barVisible:visible(bar)};
  if(samples.length<2000)samples.push(row);
 }requestAnimationFrame(sample);}requestAnimationFrame(sample);
})()`;

async function until(page:InputCdpSession,expression:string){const end=Date.now()+20000;while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(100);}throw Error('ACT_BAR_WAIT: '+expression);}
// #1229 / #1230: checkpoint-pass, checkpoint-fail and joined-interview modes are retired with their forms;
// option-set modes submit via Send comments (act@10), and standalone interview refusal is covered by tests/interview-open-browser.ts.
for(const lang of ['en','ko'] as const)for(const mode of ['rig','direction','parts','interview','interview-rig','interview-parts','standalone'] as const){
 if(saveRetryOnly&&!['rig','parts'].includes(mode))continue;
 const profile=await mkdtemp(join(tmpdir(),'review809-browser-'));let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 try{
  let url:string,draftKey:string|undefined;
  if(mode==='standalone'){
   const f=await jobFixture(),capability='b'.repeat(64);const server=await startServer(await loadReview(join(f.root,'out')),{port:0,capability,stateDir:f.state});
   close=async()=>{server.stop(true);await f.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(['rig','direction','parts'].includes(mode)){
   const f=await scriptedJobWindowFixture({c5Parts:'mesh'});close=()=>f.close();
   const stage=mode as 'rig'|'direction'|'parts';
   const p=await f.publish(stage);draftKey=`rig-review-draft/1:single:${p.source.package.id}:${p.source.sourceHash}:${p.source.sourceHash}`;
   url=f.locator+'/#cap='+f.credentials.ui;
  }else{
   const f=await recordScreenFixture('option-set',mode==='interview-rig'?true:mode==='interview-parts'?'parts':false);close=()=>f.close();url=f.ownerUrl;
  }
  const localized=new URL(url);localized.searchParams.set('lang',lang);url=localized.href;
  let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined;let held=0,heldActRequest:string|undefined;
  page=await launchCdpSession(profile,{browserArgs:['--force-device-scale-factor=2'],onEvent:async(event,send)=>{
   if(event.sessionId)control=(method,params)=>(send as any)(method,params,event.sessionId);
   if(event.method==='Fetch.requestPaused'&&control){
    const cdp=control,request=event.params as {requestId:string;request?:{url?:string}};
    if(request.request?.url?.endsWith('/ui/acts')){
     heldActRequest=request.requestId;return;
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
  await until(page,`(${mode==='standalone'}?!!document.querySelector('#rig-root canvas'):document.body.dataset.ready==='true')&&!document.body.inert&&document.querySelector('#send-comments')?.checkVisibility()&&!!document.querySelector('#workspace-ask-headline')?.textContent`);
  const interview=mode.startsWith('interview');
  const catalog=lang==='ko'?koCatalog:enCatalog;
  const optionReady=`!!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')&&!document.querySelector('#workspace-interview-answer')&&document.querySelector('#reference-content img')?.naturalWidth>0&&!!document.querySelector('#view-menu [data-view^="interview-image-"]')&&!document.querySelector('#send-comments')?.hidden`;
  if(interview)await until(page,optionReady);
  const boot=await page.evaluate<any>(`(()=>{
   const visible=n=>!!n?.checkVisibility()&&!n.closest('dialog:not([open])');
   const bar=document.querySelector('#workspace-review-act');
   const nodes=['review-message','review-draft-state','draft-state','dirty'].map(id=>{
    const n=document.getElementById(id);return {id,text:n?.textContent.trim(),visible:visible(n),inBar:!!n&&bar.contains(n)};
   });
   const primary=nodes.find(n=>n.id==='review-draft-state')?.text;
   return {samples:window.__actFlashSamples,held:${held},nodes,
    saveStates:nodes.filter(n=>n.visible&&n.inBar&&n.text&&(n.text===primary||/^(Not submitted|제출되지 않음)$/.test(n.text))),
    home:bar.parentElement?.id,inHeading:!!bar.closest('.inspector-heading'),rowVisible:visible(document.getElementById('workspace-act-row')),
    visibleStates:nodes.filter(n=>n.visible&&['review-draft-state','draft-state','dirty'].includes(n.id)&&n.text).map(n=>n.id)};
  })()`);
  observations.push({mode,lang,boot});
  await writeFile(join(out,'loading-observations.json'),JSON.stringify(observations,null,2));
  await writeFile(join(out,`${mode}-${lang}-loaded.png`),await page.screenshot());
  const legacy=boot.samples.filter((row:any)=>row.legacySave||row.status||row.label);
  if(legacy.length)failures.push(mode+'/'+lang+' legacy controls in '+legacy.length+' frames');
  if(boot.saveStates.length!==1)failures.push(mode+'/'+lang+' save-state count '+boot.saveStates.length);
  assert.equal(boot.home,'workspace-act-row');assert.equal(boot.inHeading,false);assert.equal(boot.rowVisible,true);assert.deepEqual(boot.visibleStates,['review-draft-state']);
  const state=await page.evaluate<any>(`(()=>{
   const visible=n=>!!n?.checkVisibility()&&!n.closest('dialog:not([open])');
   const headline=document.querySelector('#workspace-ask-headline');
   const actions=[...document.querySelectorAll('#workspace-review-act button')].filter(visible);
   return {language:document.documentElement.lang,primary:actions.filter(n=>n.classList.contains('primary')).map(n=>n.id),
    question:headline.textContent,whiteSpace:getComputedStyle(headline).whiteSpace,overflow:getComputedStyle(headline).textOverflow,
    legacyVisible:['save','request-changes','request-changes-reason','review-status'].some(id=>visible(document.getElementById(id)))};
  })()`);
  assert.equal(state.language,lang);assert.deepEqual(state.primary,['send-comments']);
  assert.equal(state.question,catalog["We're looking at the work together. Leave your thoughts as comments."]);
  assert.equal(state.legacyVisible,false);
  assert.notEqual(state.whiteSpace,'nowrap');assert.notEqual(state.overflow,'ellipsis');
  if(mode==='standalone')assert.equal(await page.evaluate(`document.getElementById('send-comments').disabled`),true);
  if(flashOnly||mode==='standalone')continue;
  await writeFile(join(out,`${mode}-${lang}-pending.png`),await page.screenshot());
  if(mode==='rig'){
   await click(page,'#zoom-in');await until(page,`Object.keys(localStorage).some(key=>key.startsWith('rig-review-draft/1:'))`);
   draftKey=await page.evaluate<string>(`Object.keys(localStorage).find(key=>key.startsWith('rig-review-draft/1:'))`);
   // Leave the app before planting so its departure flush cannot overwrite the planted bytes.
   await page.goto(new URL('/favicon.ico',url).href);
   await page.evaluate(`localStorage.setItem(${JSON.stringify(draftKey)},'{corrupt saved draft')`);await page.goto(url,lang);
   await until(page,`document.body.dataset.ready==='true'&&!document.body.inert`);
   const recovery=await page.evaluate<any>(`({blocked:document.querySelector('#send-comments').disabled,text:document.querySelector('#review-draft-state').textContent,recoveryVisible:!!document.querySelector('#workspace-act-row #review-draft-recovery').getClientRects().length&&document.querySelector('#review-draft-recovery').children.length>0})`);
   assert.equal(recovery.blocked,true);assert.equal(recovery.recoveryVisible,true);assert.ok(recovery.text.includes(lang==='ko'?'초안을 불러오지':'Saved draft could not be restored'));
   await writeFile(join(out,`restore-failure-${lang}.png`),await page.screenshot());
   await page.evaluate(`document.querySelector('#workspace-act-row #review-draft-recovery button:last-child').click()`);
   await until(page,`!document.querySelector('#review-draft-recovery button')`);
  }
  if(!['rig','direction','parts'].includes(mode)){
   assert.equal(await page.evaluate(`document.getElementById('workspace-pending-ask').hidden`),true);
   await page.evaluate<void>(`document.querySelector('[data-comment-general]').scrollIntoView({block:'nearest'})`);
   await click(page,'[data-comment-general]');
   await until(page,`!!document.querySelector('.stage-comment-composer input')`);
   await page.evaluate<void>(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value='Option set comment';form.requestSubmit();})()`);
   await until(page,`!document.querySelector('.stage-comment-composer')&&!document.querySelector('#send-comments').disabled`);
   await writeFile(join(out,`${mode}-${lang}-answer.png`),await page.screenshot());
   await click(page,'#send-comments');
   await expectRecordActSubmitted(page,expression=>until(page!,expression),lang,`${mode} submitted`);
   await writeFile(join(out,`${mode}-${lang}-saved.png`),await page.screenshot());
  }
  if(['rig','direction','parts'].includes(mode)){
   assert.equal(await page.evaluate(`document.getElementById('send-comments').disabled`),true);
   await click(page,'#stage-comment');
   await click(page,'[data-comment-general]');
   await until(page,`!!document.querySelector('.stage-comment-composer input')`);
   await page.evaluate(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value='Retry fixture comment';form.requestSubmit();})()`);
   await until(page,`!document.querySelector('.stage-comment-composer')&&!document.getElementById('send-comments').disabled`);
   if(mode==='rig'||mode==='parts'){
    const readSaveState=`(()=>{const s=document.getElementById('review-draft-state'),m=document.getElementById('review-message'),v=!!m&&!!m.getClientRects().length&&getComputedStyle(m).display!=='none'&&getComputedStyle(m).visibility!=='hidden';return {stateKind:s?.dataset.saveState??'',stateText:s?.textContent??'',stateTitle:s?.getAttribute('title')??'',messageText:m?.textContent??'',messageError:m?.classList.contains('error')??false,messageVisible:v,footerText:document.getElementById('message')?.textContent??'',saveDisabled:document.getElementById('send-comments')?.disabled??false};})()`;
    const clearedRefusal=(attempt:SaveRetrySnapshot,refusal:SaveRetrySnapshot)=>
     attempt.stateTitle===''&&!attempt.messageError&&!attempt.messageVisible&&
     attempt.messageText!==refusal.messageText&&(!attempt.messageText||attempt.messageText===attempt.footerText);
    await control('Fetch.enable',{patterns:[{urlPattern:'*ui/acts*',requestStage:'Request'}]});
    const waitHeldAct=async()=>{const end=Date.now()+20000;while(Date.now()<end){if(heldActRequest)return heldActRequest;await Bun.sleep(50);}throw Error('ACT_BAR_WAIT: heldActRequest');};
    const fulfillRefusal=async(requestId:string,code:string,status:number)=>{
     heldActRequest=undefined;
     await control!('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],
      body:Buffer.from(JSON.stringify({ok:false,error:{code,message:code}})).toString('base64')});
    };
    const expectedSaving=catalog['Sending'];
    await click(page,'#send-comments');
    const firstReq=await waitHeldAct();
    const firstSaving=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(firstSaving.stateKind!=='saving'||firstSaving.stateText!==expectedSaving)
     failures.push(`${mode}/${lang} first saving expected ${expectedSaving}, got ${firstSaving.stateKind}:${firstSaving.stateText}`);
    await fulfillRefusal(firstReq,'JOB_ACT_INVALID',400);
    await until(page,`!document.getElementById('send-comments').disabled&&document.getElementById('review-draft-state')?.dataset.saveState==='failed'`);
    const firstFailed=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(!firstFailed.messageError||!firstFailed.messageText||firstFailed.stateKind!=='failed'||firstFailed.stateText!==firstFailed.messageText||!firstFailed.stateTitle.startsWith('JOB_ACT_INVALID'))
     failures.push(`${mode}/${lang} first failed state mismatch: ${JSON.stringify(firstFailed)}`);
    await click(page,'#send-comments');
    const secondReq=await waitHeldAct();
    const retrySaving=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(retrySaving.stateKind!=='saving'||retrySaving.stateText!==expectedSaving)
     failures.push(`${mode}/${lang} retry saving expected ${expectedSaving}, got ${retrySaving.stateKind}:${retrySaving.stateText}`);
    if(!clearedRefusal(retrySaving,firstFailed))
     failures.push(`${mode}/${lang} stale failure remained during retry: ${JSON.stringify(retrySaving)}`);
    await fulfillRefusal(secondReq,'JOB_BODY_LIMIT',413);
    await until(page,`!document.getElementById('send-comments').disabled&&document.getElementById('review-draft-state')?.dataset.saveState==='failed'`);
    const secondFailed=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(!secondFailed.messageError||!secondFailed.messageText||secondFailed.stateKind!=='failed'||secondFailed.stateText!==secondFailed.messageText||!secondFailed.stateTitle.startsWith('JOB_BODY_LIMIT')||secondFailed.messageText===firstFailed.messageText)
     failures.push(`${mode}/${lang} second failed state mismatch: ${JSON.stringify(secondFailed)}`);
    await click(page,'#send-comments');
    const thirdReq=await waitHeldAct();
    const finalSaving=await page.evaluate<SaveRetrySnapshot>(readSaveState);
    if(finalSaving.stateKind!=='saving'||finalSaving.stateText!==expectedSaving||!clearedRefusal(finalSaving,secondFailed))
     failures.push(`${mode}/${lang} final retry saving mismatch: ${JSON.stringify(finalSaving)}`);
    heldActRequest=undefined;
    await control('Fetch.continueRequest',{requestId:thirdReq});
   }else{
    await click(page,'#send-comments');
   }
   await until(page,`(()=>{
    const send=document.getElementById('send-comments'),state=document.getElementById('review-draft-state');
    return send?.checkVisibility()&&send.disabled&&!document.getElementById('workspace-pending-ask')?.checkVisibility()&&
     state?.dataset.saveState==='saved'&&state.textContent===${JSON.stringify(catalog['Submitted'])};
   })()`);
   const done=await page.evaluate<any>(`({question:document.querySelector('#workspace-ask-headline').textContent,primary:[...document.querySelectorAll('#workspace-review-act button.primary')].filter(n=>n.getClientRects().length>0&&!n.closest('dialog:not([open])')).map(n=>n.id)})`);
   // #1226 owner ruling: with no ask the live rig row stays, with the no-ask line and Send comments as its one answer.
   // #1242 owner ruling: the direction, parts and record screens hold the same row.
   assert.deepEqual(done.primary,['send-comments']);
   assert.equal(done.question,lang==='ko'?'작업물을 같이 보고 있어요. 의견은 코멘트로 남겨 주세요.':"We're looking at the work together. Leave your thoughts as comments.");
   assert.equal(await page.evaluate(`document.getElementById('workspace-act-row').hidden`),false);
   assert.deepEqual(await page.evaluate(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['review-draft-state']);
   await writeFile(join(out,`${mode}-${lang}-submitted.png`),await page.screenshot());
  }
  observations.push({mode,...state});
 }catch(error){await writeFile(join(out,`${mode}-${lang}-failure.json`),JSON.stringify({error:String(error),html:await page?.evaluate('document.body.innerText')},null,2));throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});}
}
await writeFile(join(out,'observations.json'),JSON.stringify(observations,null,2));console.log(JSON.stringify({observations:observations.length,output:out,failures}));assert.deepEqual(failures,[]);
