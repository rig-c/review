/** #840 ordinary Nova only. Synthetic inputs reuse the shipped job/record/CDP fixtures.
 * Covers eight screens × EN/KO × two sizes; no producer conformance claim. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/act-row-840':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];
const modes=['rig','direction','parts','signoff','checkpoint','interview','embedded-rig','standalone'] as const;
type Mode=typeof modes[number];
async function wait(page:InputCdpSession,expression:string){
 const end=Date.now()+20_000;
 while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(30);}
 throw new Error('ACT_ROW_WAIT '+expression);
}
const sampler=`(()=>{
 const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden],dialog:not([open])')&&getComputedStyle(n).visibility!=='hidden';
 const samples=[];window.__actRowSamples=samples;
 const sample=()=>{const bar=document.getElementById('workspace-review-act');if(!bar||samples.length>=2000)return;
  const save=document.getElementById('save'),row=document.getElementById('workspace-act-row');
  samples.push({row:visible(row),bar:visible(bar),ready:document.body.dataset.ready==='true',legacySave:visible(save)&&/^(Submit review|리뷰 제출)$/.test(save.textContent.trim()),status:visible(document.getElementById('review-status')),label:visible(document.querySelector('label[for="review-status"]'))});
 };
 new MutationObserver(sample).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});
 const frame=()=>{sample();requestAnimationFrame(frame);};requestAnimationFrame(frame);
})()`;
const geometry=`(()=>{
 const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden],dialog:not([open])')&&getComputedStyle(n).visibility!=='hidden';
 const rect=n=>n?.getBoundingClientRect().toJSON()??null;
 const row=document.getElementById('workspace-act-row'),bar=document.getElementById('workspace-review-act'),header=document.querySelector('.topbar'),heading=document.querySelector('.inspector-heading');
 const answers=[...bar.querySelectorAll('#save,#request-changes,#workspace-pending-ask')].filter(visible);
 return {language:document.documentElement.lang,bars:document.querySelectorAll('#workspace-review-act').length,rows:document.querySelectorAll('#workspace-act-row').length,
  rowVisible:visible(row),headerVisible:visible(header),direct:row?.previousElementSibling===header&&header?.parentElement===row?.parentElement,home:bar.parentElement?.id,
  row:rect(row),bar:rect(bar),header:rect(header),heading:rect(heading),panel:rect(document.getElementById('workspace-inspector')),
  headingChildren:[...heading.children].map(n=>n.classList.contains('workspace-bottom-tabs')?'tabs':n.id),
  states:['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return visible(n)&&!!n.textContent.trim();}),
  answers:answers.map(n=>({id:n.id,rect:rect(n)})),primary:answers.filter(n=>n.classList.contains('primary')).map(n=>n.id),
  headline:{rect:rect(document.getElementById('workspace-ask-headline')),whiteSpace:getComputedStyle(document.getElementById('workspace-ask-headline')).whiteSpace,overflow:getComputedStyle(document.getElementById('workspace-ask-headline')).textOverflow},
  commentButtons:document.querySelectorAll('#stage-comment').length,
  gateHidden:document.querySelector('[data-animation-gate]')?.hidden,title:document.getElementById('rig-label')?.textContent};
})()`;
async function capture(page:InputCdpSession,out:string,name:string){
 await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 const state=await page.evaluate<any>(geometry);
 await writeFile(join(out,name+'.json'),JSON.stringify(state,null,2)+'\n');
 await writeFile(join(out,name+'.png'),await page.screenshot());return state;
}
function assertPending(state:any,mode:Mode,width:number){
 assert.equal(state.bars,1);assert.equal(state.rows,1);assert.equal(state.rowVisible,true);assert.equal(state.direct,true);assert.equal(state.home,'workspace-act-row');
 assert.equal(state.headerVisible,mode!=='embedded-rig');
 assert.ok(Math.abs(state.row.top-(mode==='embedded-rig'?0:state.header.bottom))<=1,'row directly beneath topbar, or at embedded top');
 assert.equal(state.row.width,width);assert.deepEqual(state.states,['review-draft-state']);
 assert.deepEqual(state.headingChildren,['tabs','workspace-bottom-collapse']);
 assert.equal(state.primary.length,1);assert.equal(state.commentButtons,1);
 assert.notEqual(state.headline.whiteSpace,'nowrap');assert.notEqual(state.headline.overflow,'ellipsis');
 const right=Math.max(...state.answers.map((answer:any)=>answer.rect.right));
 assert.ok(Math.abs(state.bar.right-right)<=1,'answers end flush with the row content edge');
 assert.ok(state.answers.every((answer:any)=>answer.rect.left>=state.bar.left&&answer.rect.right<=state.bar.right+1),'all answers stay inside row');
 if(mode==='direction'){assert.equal(state.gateHidden,true);assert.equal(state.title,state.language==='en'?'Take · 1 s':'테이크 · 1초');}
}
for(const language of ['en','ko'] as const)for(const [width,height]of [[1440,900],[1100,800]] as const)for(const mode of modes){
 const out=join(output,mode,language,`${width}x${height}`);await mkdir(out,{recursive:true});
 const profile=await mkdtemp(join(tmpdir(),'review840-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 try{
  let url:string;
  if(mode==='standalone'){
   const fixture=await jobFixture(),capability='b'.repeat(64);
   const server=await startServer(await loadReview(join(fixture.root,'out')),{port:0,capability,stateDir:fixture.state});
   close=async()=>{server.stop(true);await fixture.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(mode==='signoff'||mode==='checkpoint'||mode==='interview'){
   const fixture=await recordScreenFixture(mode==='interview'?'interview-picks':mode,false);
   close=()=>fixture.close();url=fixture.ownerUrl;
  }else{
   const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});close=()=>fixture.close();
   const stage=mode==='embedded-rig'?'rig':mode,publication=await fixture.publish(stage);
   await fixture.ask(publication,stage==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:stage==='direction'?'direction-review':'rig-review'});
   url=fixture.host.ownerUrl;
  }
  const target=new URL(url);target.searchParams.set('lang',language);if(mode==='embedded-rig')target.searchParams.set('stageEmbed','1');url=target.href;
  let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined,held=0;
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:async(event,send)=>{
   if(event.sessionId)control=send;
   if(event.method!=='Fetch.requestPaused')return;
   const request=event.params as {requestId:string};
   const state=await send('Runtime.evaluate',{expression:`!!document.querySelector('#workspace-review-act')&&document.body.dataset.ready!=='true'`,returnByValue:true}) as any;
   if(state.result?.value&&held===0){held++;await Bun.sleep(800);await writeFile(join(out,'slowed-load.png'),await page!.screenshot());}
   await send('Fetch.continueResponse',{requestId:request.requestId});
  }});
  await page.setViewport(width,height);assert.ok(control);
  await control('Page.addScriptToEvaluateOnNewDocument',{source:sampler});
  await control('Fetch.enable',{patterns:[{urlPattern:'*assets/*',requestStage:'Response'},{urlPattern:'*review-painting*',requestStage:'Response'},{urlPattern:'*api/stage-parts/image/*',requestStage:'Response'}]});
  await page.goto(url,language);
  await wait(page,mode==='standalone'?`!!document.querySelector('#rig-root canvas')&&!document.body.inert`:`document.body.dataset.ready==='true'&&!document.body.inert&&!!document.querySelector('#workspace-ask-headline')?.textContent`);
  // Interview auto-opens its existing dialog; inspect the row after the normal close action.
  await page.evaluate(`document.querySelector('dialog[open] .workspace-drawer-close')?.click()`);
  const initial=await capture(page,out,'pending');assert.equal(initial.language,language);
  const loading=await page.evaluate<any[]>(`window.__actRowSamples`);
  await writeFile(join(out,'loading.json'),JSON.stringify({held,samples:loading},null,2)+'\n');
  if(mode==='standalone'){
   assert.equal(initial.rows,0);assert.equal(initial.rowVisible,false);
   assert.equal(await page.evaluate(`!!document.querySelector('.inspector-heading>#workspace-review-act')`),true,'standalone keeps existing home');
   assert.equal(await page.evaluate(`document.getElementById('save').hidden`),false);observations.push({mode,language,width,height,initial});continue;
  }
  assertPending(initial,mode,width);
  assert.ok(loading.length>0);assert.deepEqual(loading.filter(sample=>sample.legacySave||sample.status||sample.label),[],'no legacy act flash, including slowed load');
  if(['rig','direction','parts','embedded-rig'].includes(mode))assert.ok(held>0,'asset response held while live workspace was loading');
  assert.ok(!loading.some(sample=>sample.bar&&!sample.row),'a live act is only visible inside its row');
  // Test-only DOM mutation: announce and hash the exact node before changing it;
  // restore in finally and verify its hash before any subsequent measurement.
  const headlineBefore=await page.evaluate<{text:string;html:string}>(`(()=>{const n=document.getElementById('workspace-ask-headline');return {text:n.textContent,html:n.outerHTML};})()`);
  const beforeHash=createHash('sha256').update(headlineBefore.html).digest('hex');
  const mutation={mode,language,width,height,selector:'#workspace-ask-headline',scope:'test-only DOM',beforeHash};
  console.log('ACT_ROW_DOM_MUTATION_BEGIN '+JSON.stringify(mutation));
  await writeFile(join(out,'headline-mutation-begin.json'),JSON.stringify(mutation,null,2)+'\n');
  try{
   await page.evaluate(`document.getElementById('workspace-ask-headline').textContent=${JSON.stringify((headlineBefore.text+' ').repeat(16))}`);
   const wrapped=await capture(page,out,'long-question');assertPending(wrapped,mode,width);assert.ok(wrapped.headline.rect.height>initial.headline.rect.height);
   assert.equal(await page.evaluate(`document.getElementById('workspace-ask-headline').scrollWidth<=document.getElementById('workspace-ask-headline').clientWidth+1`),true);
  }finally{
   await page.evaluate(`document.getElementById('workspace-ask-headline').textContent=${JSON.stringify(headlineBefore.text)}`);
   const restoredHtml=await page.evaluate<string>(`document.getElementById('workspace-ask-headline').outerHTML`);
   const restoredHash=createHash('sha256').update(restoredHtml).digest('hex');
   const restored={...mutation,restoredHash,restored:restoredHash===beforeHash};
   console.log('ACT_ROW_DOM_MUTATION_RESTORED '+JSON.stringify(restored));
   await writeFile(join(out,'headline-mutation-restored.json'),JSON.stringify(restored,null,2)+'\n');
   assert.equal(restoredHash,beforeHash,'long-question DOM restored byte-for-byte before further measurements');
  }
  await click(page,'#workspace-bottom-collapse');
  await wait(page,`document.querySelector('.inspector-body').hidden`);
  const collapsed=await capture(page,out,'collapsed');assertPending(collapsed,mode,width);
  assert.ok(Math.abs(collapsed.panel.height-collapsed.heading.height)<=2,'collapsed panel is only its heading');
  assert.ok(collapsed.panel.height<initial.panel.height,'collapse actually shrinks the panel');
  await click(page,'#workspace-bottom-collapse');await wait(page,`!document.querySelector('.inspector-body').hidden`);
  if(['rig','direction','parts','embedded-rig'].includes(mode)){
   assert.equal(await page.evaluate(`document.getElementById('request-changes').disabled`),true,'changes needs a comment');
   if(mode==='rig'){
    await click(page,'#zoom-in');await wait(page,`Object.keys(localStorage).some(key=>key.startsWith('rig-review-draft/1:'))`);
    const key=await page.evaluate<string>(`Object.keys(localStorage).find(key=>key.startsWith('rig-review-draft/1:'))`);
    for(const action of ['download','discard']){
     // Leave first so departure persistence cannot overwrite the planted corrupt bytes.
     await page.goto(new URL('/favicon.ico',url).href);
     await page.evaluate(`localStorage.setItem(${JSON.stringify(key)},'{corrupt saved draft')`);await page.goto(url,language);
     await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.querySelector('#review-draft-recovery button')`);
     const blocked:{submit:boolean;changes:boolean;noticeInRow:boolean;noticeVisible:boolean;kind:string}=await page.evaluate<any>(`({submit:document.getElementById('save').disabled,changes:document.getElementById('request-changes').disabled,noticeInRow:!!document.querySelector('#workspace-act-row #review-draft-recovery'),noticeVisible:!!document.getElementById('review-draft-recovery').getClientRects().length,kind:document.getElementById('review-draft-state').dataset.saveState})`);
     assert.deepEqual(blocked,{submit:true,changes:true,noticeInRow:true,noticeVisible:true,kind:'failed'});
     const recovery=await capture(page,out,'restore-'+action+'-blocked');assertPending(recovery,mode,width);
     await click(page,'#review-draft-recovery button:'+(action==='download'?'first-child':'last-child'));
     await wait(page,`!document.getElementById('save').disabled&&!document.querySelector('#review-draft-recovery button')`);
     await capture(page,out,'restore-'+action+'-unlocked');
    }
   }
   await click(page,'#save');
   await wait(page,`document.getElementById('workspace-act-row').hidden&&!document.getElementById('dirty').hidden`);
   const submitted=await capture(page,out,'submitted');assert.equal(submitted.rowVisible,false);
   if(mode!=='embedded-rig')assert.deepEqual(submitted.states,['dirty']);
   const catalog=language==='en'?enCatalog:koCatalog;
   assert.equal(await page.evaluate(`document.getElementById('dirty').textContent`),catalog['job.review.approved']);
  }else{
   assert.deepEqual(initial.answers.map((answer:any)=>answer.id),['workspace-pending-ask']);
   await click(page,'#workspace-pending-ask');await wait(page,`!!document.querySelector('#job-record-asks[open]')`);
   assert.equal(await page.evaluate(`document.getElementById('workspace-pending-ask').closest('#workspace-act-row')!==null`),true);
   if(mode==='interview')await page.evaluate(`(()=>{const seen=new Set();for(const radio of document.querySelectorAll('#job-record-asks input[type=radio]'))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`);
   await capture(page,out,'answer-dialog');
   await click(page,mode==='checkpoint'?'#job-record-asks button[data-job-text="Pass"]':'#job-record-asks button[type=submit]');
   await wait(page,`!document.querySelector('#job-record-asks[open]')&&document.getElementById('review-draft-state').textContent.includes(${JSON.stringify(language==='ko'?'저장':'saved')})`);
   const saved=await capture(page,out,'answer-saved');assert.equal(saved.states.length,1);
  }
  if(mode==='rig'){
   // Fail the first hosted metadata clone before any answer renderer. Restore the
   // native immediately; this is a synthetic read refusal, not a product hook.
   await control('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const native=window.structuredClone;
    new MutationObserver(()=>{
     if(!window.__earlyActReadRefused||window.__earlyActRowRefusal)return;
     const row=document.getElementById('workspace-act-row'),message=document.getElementById('review-message');
     if(!row||row.hidden||!message?.classList.contains('error'))return;
     const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden]');
     window.__earlyActRowRefusal={rowVisible:visible(row),text:message.textContent,messageVisible:visible(message),
      controls:[...row.querySelectorAll('#save,#request-changes,#workspace-pending-ask,#review-status,label[for="review-status"]')].filter(visible).map(n=>n.id||n.tagName),
      rowRect:row.getBoundingClientRect().toJSON(),messageRect:message.getBoundingClientRect().toJSON()};
    }).observe(document,{childList:true,subtree:true,attributes:true});
    window.structuredClone=function(value,...args){
     if(document.getElementById('workspace-act-row')?.hidden&&value?.manifest&&value?.sourceHash){window.structuredClone=native;window.__earlyActReadRefused=true;throw Error('JOB_VISUAL_UNAVAILABLE');}
     return native.call(this,value,...args);
    };
   })()`});
   await page.goto(url,language);
   // The normal host rolls the failed candidate back. Observe the real message()
   // reveal at its mutation boundary, before that rollback; do not suppress it.
   await wait(page,`!!window.__earlyActRowRefusal`);
   const refusal=await page.evaluate<any>(`window.__earlyActRowRefusal`);
   assert.equal(refusal.rowVisible,true);assert.equal(refusal.messageVisible,true);assert.deepEqual(refusal.controls,[]);
   assert.ok(refusal.text.includes('JOB_VISUAL_UNAVAILABLE'));
   await writeFile(join(out,'early-refusal-before-rollback.json'),JSON.stringify(refusal,null,2)+'\n');
   await writeFile(join(out,'early-refusal-after-rollback.png'),await page.screenshot());
  }
  observations.push({mode,language,width,height,initial,collapsed,held});
 }catch(error){if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error)},null,2)+'\n');throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');}
}
console.log('ACT_ROW_840_OK cases='+observations.length+' EN=16 KO=16');
