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
  let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined;let held=0;
  page=await launchCdpSession(profile,{browserArgs:['--force-device-scale-factor=2'],onEvent:async(event,send)=>{
   if(event.sessionId)control=(method,params)=>(send as any)(method,params,event.sessionId);
   if(event.method==='Fetch.requestPaused'&&control){
    const cdp=control,request=event.params as {requestId:string};
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
  if(mode.startsWith('interview')||mode==='joined-interview')await page.evaluate(`document.querySelector('#job-record-asks')?.close()`);
  const boot=await page.evaluate<any>(`(()=>{const visible=n=>!!n&&!!n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden'&&!n.closest('dialog:not([open])');const bar=document.querySelector('#workspace-review-act');const nodes=['review-message','review-draft-state','draft-state'].map(id=>{const n=document.getElementById(id);return {id,text:n?.textContent.trim(),visible:visible(n),inBar:!!n&&bar.contains(n)};});const primary=nodes.find(n=>n.id==='review-draft-state')?.text;return {samples:window.__actFlashSamples,held:${held},nodes,saveStates:nodes.filter(n=>n.visible&&n.inBar&&n.text&&(n.text===primary||/^(Not submitted|제출되지 않음)$/.test(n.text))),standaloneSave:document.querySelector('#save').textContent};})()`);
  observations.push({mode,lang,boot});
  await writeFile(join(out,'loading-observations.json'),JSON.stringify(observations,null,2));
  await writeFile(join(out,`${mode}-${lang}-loaded.png`),await page.screenshot());
  if(mode==='standalone'){
   if(!boot.samples.some((row:any)=>row.legacySave))failures.push(mode+'/'+lang+' standalone Submit review not observed');
   continue;
  }
  const legacy=boot.samples.filter((row:any)=>row.legacySave||row.status||row.label);
  if(mode!=='joined-interview'&&legacy.length)failures.push(mode+'/'+lang+' legacy controls in '+legacy.length+' frames');
  if(boot.saveStates.length!==1)failures.push(mode+'/'+lang+' save-state count '+boot.saveStates.length);
  if(flashOnly)continue;
  const state=await page.evaluate<any>(`(()=>{const visible=n=>n.getClientRects().length>0&&!n.closest('dialog:not([open])');const headline=document.querySelector('#workspace-ask-headline');return {language:document.documentElement.lang,primary:[...document.querySelectorAll('button.primary')].filter(visible).map(n=>n.id),question:headline.textContent,whiteSpace:getComputedStyle(headline).whiteSpace,overflow:getComputedStyle(headline).textOverflow,changesDisabled:document.querySelector('#request-changes').disabled,saveHidden:document.querySelector('#save').hidden};})()`);
  assert.equal(state.language,lang);assert.equal(state.primary.length,1,mode+' one emphasised answer');assert.notEqual(state.whiteSpace,'nowrap');assert.notEqual(state.overflow,'ellipsis');
  if(['rig','direction','parts'].includes(mode))assert.equal(state.changesDisabled,true);
  await writeFile(join(out,`${mode}-${lang}-pending.png`),await page.screenshot());
  if(mode==='rig'){
   await click(page,'#zoom-in');await until(page,`Object.keys(localStorage).some(key=>key.startsWith('rig-review-draft/1:'))`);
   draftKey=await page.evaluate<string>(`Object.keys(localStorage).find(key=>key.startsWith('rig-review-draft/1:'))`);
   // Leave the app before planting so its departure flush cannot overwrite the planted bytes.
   await page.goto(new URL('/favicon.ico',url).href);
   await page.evaluate(`localStorage.setItem(${JSON.stringify(draftKey)},'{corrupt saved draft')`);await page.goto(url,lang);
   await until(page,`document.body.dataset.ready==='true'&&!document.body.inert`);
   const recovery=await page.evaluate<any>(`({blocked:document.querySelector('#save').disabled&&document.querySelector('#request-changes').disabled,text:document.querySelector('#review-draft-state').textContent,recoveryVisible:!!document.querySelector('#draft-recovery').getClientRects().length&&document.querySelector('#draft-recovery').children.length>0})`);
   assert.equal(recovery.blocked,true);assert.equal(recovery.recoveryVisible,true);assert.ok(recovery.text.includes(lang==='ko'?'초안을 불러오지':'Saved draft could not be restored'));
   await writeFile(join(out,`restore-failure-${lang}.png`),await page.screenshot());
   await page.evaluate(`document.querySelector('#draft-recovery button:last-child').click()`);
   await until(page,`!document.querySelector('#save').disabled`);
  }
  if(!['rig','direction','parts'].includes(mode)){
   await click(page,'#workspace-pending-ask');await until(page,`!!document.querySelector('#job-record-asks[open]')`);
   assert.equal(await page.evaluate(`!!document.querySelector('[data-job-checkpoint-evidence]')`),false);
   if(mode.startsWith('interview')||mode==='joined-interview')await page.evaluate(`(()=>{const seen=new Set();for(const radio of document.querySelectorAll('#job-record-asks input[type=radio]'))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`);
   const selector=mode==='checkpoint-fail'?'#job-record-asks button[data-job-text="job.fail"]':mode==='checkpoint-pass'?'#job-record-asks button[data-job-text="Pass"]':'#job-record-asks button[type=submit]';
   await writeFile(join(out,`${mode}-${lang}-answer.png`),await page.screenshot());
   await click(page,selector);
   await until(page,`!document.querySelector('#job-record-asks[open]')&&document.querySelector('#review-draft-state')?.textContent.toLowerCase().includes(${JSON.stringify(lang==='ko'?'저장':'saved')})`);
   await writeFile(join(out,`${mode}-${lang}-saved.png`),await page.screenshot());
   if(mode==='joined-interview'){
    assert.equal(await page.evaluate(`document.querySelector('#workspace-pending-ask').disabled`),false,'saved first answer leaves the opener enabled');
    await click(page,'#workspace-pending-ask');await until(page,`!!document.querySelector('#job-record-asks[open]')`);
    await click(page,'.interview-questions li:nth-child(2) button');
    await page.evaluate(`(()=>{const seen=new Set();for(const radio of document.querySelectorAll('#job-record-asks input[type=radio]'))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`);
    await click(page,'#job-record-asks button[type=submit]');
    await until(page,`!document.querySelector('#job-record-asks[open]')&&!document.querySelector('#workspace-pending-ask').disabled`);
    const saved=await page.evaluate<number>(`fetch('/api/interview').then(r=>r.json()).then(data=>data.questions.filter(question=>question.saved).length)`);
    assert.equal(saved,2,'both joined interview questions reached the real picks route');
    await writeFile(join(out,`${mode}-${lang}-second-saved.png`),await page.screenshot());
   }
  }
  if(['rig','direction','parts'].includes(mode)){
   await click(page,'#save');
   await until(page,`document.querySelector('#save').hidden&&document.querySelector('#workspace-pending-ask').hidden`);
   const done=await page.evaluate<any>(`({question:document.querySelector('#workspace-ask-headline').textContent,primary:[...document.querySelectorAll('button.primary')].filter(n=>n.getClientRects().length>0&&!n.closest('dialog:not([open])')).length})`);
   assert.equal(done.primary,0);
   await writeFile(join(out,`${mode}-${lang}-submitted.png`),await page.screenshot());
  }
  observations.push({mode,...state});
 }catch(error){await writeFile(join(out,`${mode}-${lang}-failure.json`),JSON.stringify({error:String(error),html:await page?.evaluate('document.body.innerText')},null,2));throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});}
}
await writeFile(join(out,'observations.json'),JSON.stringify(observations,null,2));console.log(JSON.stringify({observations:observations.length,output:out,failures}));assert.deepEqual(failures,[]);
