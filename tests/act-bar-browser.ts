/** Synthetic #809/#825 screen coverage. Ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {joinProject} from '../src/joined-project.ts';
import {startServer} from '../src/server.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
const out=Bun.argv[Bun.argv.indexOf('--out')+1]??'artifacts/act-bar';await mkdir(out,{recursive:true});
const observations:unknown[]=[];
async function until(page:InputCdpSession,expression:string){const end=Date.now()+20000;while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(100);}throw Error('ACT_BAR_WAIT: '+expression);}
for(const lang of ['en','ko'] as const)for(const mode of ['rig','direction','parts','signoff-model','signoff-record','checkpoint-pass','checkpoint-fail','interview','joined-interview'] as const){
 const profile=await mkdtemp(join(tmpdir(),'review809-browser-'));let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 try{
  let url:string,draftKey:string|undefined;
  if(mode==='joined-interview'){
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
   const f=await recordScreenFixture(mode==='interview'?'interview-picks':mode==='signoff-record'?'signoff':'checkpoint',false);close=()=>f.close();url=f.ownerUrl;
  }
  const localized=new URL(url);localized.searchParams.set('lang',lang);url=localized.href;
  page=await launchCdpSession(profile,{browserArgs:['--force-device-scale-factor=2']});await page.setViewport(1440,900);await page.goto(url,lang);
  await until(page,`document.body.dataset.ready==='true'&&!document.body.inert&&(${mode==='joined-interview'}||!!document.querySelector('#workspace-ask-headline')?.textContent)`);
  if(mode==='interview'||mode==='joined-interview')await page.evaluate(`document.querySelector('#job-record-asks')?.close()`);
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
   const recovery=await page.evaluate<any>(`({blocked:document.querySelector('#save').disabled&&document.querySelector('#request-changes').disabled,text:document.querySelector('#review-draft-state').textContent})`);
   assert.equal(recovery.blocked,true);assert.ok(recovery.text.includes(lang==='ko'?'초안을 불러오지':'Saved draft could not be restored'));
   await writeFile(join(out,`restore-failure-${lang}.png`),await page.screenshot());
   await page.evaluate(`document.querySelector('#draft-recovery button:last-child').click()`);
   await until(page,`!document.querySelector('#save').disabled`);
  }
  if(!['rig','direction','parts'].includes(mode)){
   const inline=await page.evaluate<boolean>(`!!document.querySelector('#workspace-interview-answer')`);
   if(!inline){await until(page,`!document.querySelector('#workspace-pending-ask').disabled`);await click(page,'#workspace-pending-ask');await until(page,`!!document.querySelector('#job-record-asks[open]')`);}
   const answerRoot=inline?'#workspace-interview-answer':'#job-record-asks';
   assert.equal(await page.evaluate(`!!document.querySelector('[data-job-checkpoint-evidence]')`),false);
   if(mode==='interview'||mode==='joined-interview')await page.evaluate(`(()=>{const seen=new Set();for(const radio of document.querySelectorAll(${JSON.stringify(answerRoot+' input[type=radio]')}))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`);
   const selector=mode==='checkpoint-fail'?'#job-record-asks button[data-job-text="job.fail"]':mode==='checkpoint-pass'?'#job-record-asks button[data-job-text="Pass"]':answerRoot+' button[type=submit]';
   await writeFile(join(out,`${mode}-${lang}-answer.png`),await page.screenshot());
   await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
   await click(page,selector);
   await until(page,`!document.querySelector('#job-record-asks[open]')&&document.querySelector('#review-draft-state')?.textContent.toLowerCase().includes(${JSON.stringify(lang==='ko'?'저장':'saved')})`);
   await writeFile(join(out,`${mode}-${lang}-saved.png`),await page.screenshot());
   if(mode==='joined-interview'){
    if(!inline){assert.equal(await page.evaluate(`document.querySelector('#workspace-pending-ask').disabled`),false,'saved first answer leaves the opener enabled');
    await click(page,'#workspace-pending-ask');await until(page,`!!document.querySelector('#job-record-asks[open]')`);}
    await page.evaluate(`document.querySelector('.interview-questions li:nth-child(2) button').scrollIntoView({block:'center'})`);
    await click(page,'.interview-questions li:nth-child(2) button');
    await page.evaluate(`(()=>{const seen=new Set();for(const radio of document.querySelectorAll(${JSON.stringify(answerRoot+' input[type=radio]')}))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`);
    await page.evaluate(`document.querySelector(${JSON.stringify(answerRoot+' button[type=submit]')}).scrollIntoView({block:'center'})`);
    await click(page,answerRoot+' button[type=submit]');
    await until(page,`!document.querySelector('#job-record-asks[open]')&&(${inline}||!document.querySelector('#workspace-pending-ask').disabled)`);
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
await writeFile(join(out,'observations.json'),JSON.stringify(observations,null,2));console.log(JSON.stringify({screens:observations.length,output:out}));
