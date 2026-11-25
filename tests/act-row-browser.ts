/** #840 ordinary Nova only. Synthetic inputs reuse the shipped job/record/CDP fixtures.
 * Covers seven screens × EN/KO × two sizes; no producer conformance claim. */
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
import {expectRecordActSubmitted} from './helpers/record-act-browser-status.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/act-row-840':Bun.argv[at+1]!);
// RED collection mode samples the same 32 initial loads, then fails once after
// writing every case. The default still exercises the full interaction matrix.
const flashOnly=Bun.argv.includes('--flash-only');
await mkdir(output,{recursive:true});
const observations:unknown[]=[];
const flashFailures:unknown[]=[],caseFailures:unknown[]=[];
const modes=['rig','direction','parts','checkpoint','interview','embedded-rig','standalone'] as const;
type Mode=typeof modes[number];
const diagnostic=`(()=>{
 const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden],dialog:not([open])');
 return {path:location.pathname,query:location.search,readyState:document.readyState,ready:document.body?.dataset.ready,inert:document.body?.inert,
  embeddedFixture:window.__embeddedActRowFixture??null,probe:window.__earlyActReadProbe??null,readRefused:window.__earlyActReadRefused??false,refusal:window.__earlyActRowRefusal??null,
  loadingSamples:(window.__actRowSamples??[]).slice(-10),
  firstOffendingFrames:window.__actRowFirstOffendingFrames??[],
  nodes:['workspace-act-row','workspace-review-act','review-message','message','dirty','save','request-changes','workspace-pending-ask'].map(id=>{
   const n=document.getElementById(id);return {id,present:!!n,hidden:n?.hidden,visible:visible(n),text:n?.textContent,classes:n?.className};})};
})()`;
async function wait(page:InputCdpSession,expression:string){
 const end=Date.now()+20_000;
 while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(30);}
 const state:unknown=await page.evaluate(diagnostic).catch(error=>({diagnosticError:String(error)}));
 throw new Error('ACT_ROW_WAIT '+expression+' '+JSON.stringify(state));
}
const sampler=`(()=>{
 const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden],dialog:not([open])')&&getComputedStyle(n).visibility==='visible';
 const samples=[],offenders=[];window.__actRowSamples=samples;window.__actRowFirstOffendingFrames=offenders;
 let previous='',frame=0,sequence=0;
 const sample=trigger=>{const bar=document.getElementById('workspace-review-act');if(!bar)return;
  const save=document.getElementById('save'),row=document.getElementById('workspace-act-row'),headline=document.getElementById('workspace-ask-headline');
  const controls=[...document.querySelectorAll('#send-comments,#save,#request-changes,#workspace-pending-ask')].filter(visible).map(n=>({id:n.id,text:n.textContent.trim(),disabled:n.disabled,rect:n.getBoundingClientRect().toJSON()}));
  const state={row:visible(row),bar:visible(bar),ready:document.body?.dataset.ready==='true',headlinePresent:!!headline,headlineVisible:visible(headline),headline:headline?.textContent.trim()??'',controls,
   legacySave:visible(save)&&/^(Submit review|리뷰 제출)$/.test(save.textContent.trim()),status:visible(document.getElementById('review-status')),label:visible(document.querySelector('label[for="review-status"]'))};
  const signature=JSON.stringify(state);if(signature===previous&&trigger!=='animation-frame')return;previous=signature;
  const reading={sequence:sequence++,frame,ms:performance.now(),trigger,...state,controlsBeforeQuestion:controls.length>0&&(!state.headlineVisible||!state.headline)};
  if(samples.length<2000)samples.push(reading);
  if(reading.controlsBeforeQuestion&&offenders.length<20)offenders.push(reading);
 };
 window.__sampleActRow=sample;
 // MutationObserver batches same-tick changes. Observe *after* the native DOM
 // write too: a row reveal followed immediately by a headline fill must survive
 // in the evidence, without delaying, suppressing or changing either operation.
 for(const [prototype,key]of [[HTMLElement.prototype,'hidden'],[Node.prototype,'textContent'],[Element.prototype,'innerHTML']]){
  const descriptor=Object.getOwnPropertyDescriptor(prototype,key);if(!descriptor?.set)throw Error('ACT_ROW_SAMPLER_SETTER '+key);
  Object.defineProperty(prototype,key,{...descriptor,set(value){descriptor.set.call(this,value);sample('setter:'+key);}});
 }
 for(const [prototype,keys]of [[Element.prototype,['setAttribute','removeAttribute','toggleAttribute','append','prepend','replaceChildren']],[Node.prototype,['appendChild','insertBefore','replaceChild']],[DOMTokenList.prototype,['add','remove','toggle','replace']]])for(const key of keys){
  const native=prototype[key];prototype[key]=function(...args){const result=native.apply(this,args);sample('mutation:'+key);return result;};
 }
 new MutationObserver(()=>sample('mutation-observer')).observe(document,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','class','style']});
 const tick=()=>{frame++;sample('animation-frame');requestAnimationFrame(tick);};requestAnimationFrame(tick);
})()`;
const geometry=`(()=>{
 const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden],dialog:not([open])')&&getComputedStyle(n).visibility!=='hidden';
 const rect=n=>n?.getBoundingClientRect().toJSON()??null;
 const row=document.getElementById('workspace-act-row'),bar=document.getElementById('workspace-review-act'),header=document.querySelector('.topbar'),heading=document.querySelector('.inspector-heading');
 const askAnswers=[...bar.querySelectorAll('#save,#request-changes,#workspace-pending-ask')].filter(visible);
 const answers=askAnswers.length?askAnswers:[...bar.querySelectorAll('#send-comments')].filter(visible);
 const style=n=>{if(!n)return null;const s=getComputedStyle(n);return {rect:rect(n),text:n.textContent.trim(),size:parseFloat(s.fontSize),weight:Number(s.fontWeight),color:s.color,whiteSpace:s.whiteSpace,overflow:s.textOverflow,overflowX:s.overflowX,overflowY:s.overflowY,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight};};
 const colorProbe=document.createElement('canvas').getContext('2d');const color=value=>{colorProbe.fillStyle=value;return colorProbe.fillStyle;};
 const rootStyle=getComputedStyle(document.documentElement);
 return {language:document.documentElement.lang,footerMessage:document.getElementById('message').textContent,bars:document.querySelectorAll('#workspace-review-act').length,rows:document.querySelectorAll('#workspace-act-row').length,
  rowVisible:visible(row),headerVisible:visible(header),direct:row?.previousElementSibling===header&&header?.parentElement===row?.parentElement,home:bar.parentElement?.id,
  row:rect(row),bar:rect(bar),header:rect(header),heading:rect(heading),panel:rect(document.getElementById('workspace-inspector')),
  headingChildren:[...heading.children].map(n=>n.classList.contains('workspace-bottom-tabs')?'tabs':n.id),
  states:['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return visible(n)&&!!n.textContent.trim();}),
  answers:answers.map(n=>({id:n.id,rect:rect(n)})),primary:answers.filter(n=>n.classList.contains('primary')).map(n=>n.id),
  headline:style(document.getElementById('workspace-ask-headline')),
  typography:{bodySize:parseFloat(rootStyle.fontSize),bodyWeight:Number(rootStyle.fontWeight),primaryColor:color(rootStyle.getPropertyValue('--fg-strong').trim()),headlineColor:color(getComputedStyle(document.getElementById('workspace-ask-headline')).color),
   labels:[...document.querySelectorAll('.label,.eyebrow,.inspector-body label')].filter(n=>visible(n)&&n.textContent.trim()).map(style)},
  band:row?{background:getComputedStyle(row).backgroundColor,clientWidth:row.clientWidth,scrollWidth:row.scrollWidth}:null,
  draftStates:['review-draft-state','draft-state'].map(id=>document.getElementById(id)).filter(n=>visible(n)&&n.textContent.trim()).map(style),
  footer:[...document.querySelectorAll('footer,footer .status-message,footer .status-readouts,footer .status-source,footer span,footer summary')].filter(n=>visible(n)&&!n.closest('.view-region-body')).map(n=>({id:n.id,rect:rect(n),title:n.title,text:n.textContent,divider:getComputedStyle(n).borderInlineStartWidth,ellipsis:getComputedStyle(n).textOverflow,whiteSpace:getComputedStyle(n).whiteSpace,overflowX:getComputedStyle(n).overflowX,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight})),
  readoutIds:[...document.querySelectorAll('.status-readouts>*')].filter(visible).map(n=>n.id).filter(Boolean),
  commentButtons:document.querySelectorAll('#stage-comment').length,
  gateHidden:document.querySelector('[data-animation-gate]')?.hidden,title:document.getElementById('rig-label')?.textContent};
})()`;
async function settleLayout(page:InputCdpSession){
 await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}
async function capture(page:InputCdpSession,out:string,name:string,expectedFooter?:string){
 await settleLayout(page);
 const state:any=await page.evaluate<any>(expectedFooter===undefined?geometry:`new Promise((resolve,reject)=>{
  const deadline=performance.now()+10000,expected=${JSON.stringify(expectedFooter)};
  function sample(){
   const state=${geometry};
   if(state.footerMessage===expected) resolve(state);
   else if(performance.now()>=deadline) reject(new Error('Footer expected '+expected+'; read '+state.footerMessage));
   else requestAnimationFrame(sample);
  }
  sample();
 })`);
 await writeFile(join(out,name+'.json'),JSON.stringify(state,null,2)+'\n');
 await writeFile(join(out,name+'.png'),await page.screenshot());return state;
}
function assertPending(state:any,mode:Mode,width:number,expectedFooter?:string){
 if(mode==='rig')assert.equal(state.footerMessage,expectedFooter,'pending Rig verdict preserves its publication label');
 if(mode==='parts'){
  const catalog=state.language==='ko'?koCatalog:enCatalog;
  assert.ok([expectedFooter,catalog['Parts ready. Source files remain unchanged.']].includes(state.footerMessage),'pending Parts verdict shows a valid status');
 }
 for(const part of state.footer){
  assert.ok(part.rect.left>=0&&part.rect.right<=width&&part.rect.top>=state.footer[0].rect.top&&part.rect.bottom<=state.footer[0].rect.bottom,'shown footer item inside viewport and footer: '+part.id);
  assert.ok(part.scrollHeight<=part.clientHeight+1,'shown footer item stays on one line: '+part.id);
  if(part.id!=='message')assert.ok(part.scrollWidth<=part.clientWidth+1,'shown footer text fits: '+part.id);
  else if(part.scrollWidth>part.clientWidth+1){
   assert.equal(part.ellipsis,'ellipsis');assert.equal(part.whiteSpace,'nowrap');assert.equal(part.overflowX,'hidden');
   assert.equal(part.title,part.text,'truncated status retains the full localized tooltip');
  }
 }
 if(mode==='parts'){
  const readouts=state.readoutIds.map((id:string)=>state.footer.find((part:any)=>part.id===id));
  assert.ok(readouts.length>=2,'Parts footer has multiple readouts');
  assert.ok(readouts.slice(1).every((part:any)=>parseFloat(part.divider)>0),'Parts footer separates successive readouts');
 }
 assert.equal(state.bars,1);assert.equal(state.rows,1);assert.equal(state.rowVisible,true);assert.equal(state.direct,true);assert.equal(state.home,'workspace-act-row');
 assert.equal(state.headerVisible,mode!=='embedded-rig');
 assert.ok(Math.abs(state.row.top-(mode==='embedded-rig'?0:state.header.bottom))<=1,'row directly beneath topbar, or at embedded top');
 assert.equal(state.row.width,width);assert.deepEqual(state.states,['review-draft-state']);
 assert.deepEqual(state.headingChildren,['tabs','workspace-bottom-collapse']);
 assert.equal(state.primary.length,1);assert.equal(state.commentButtons,1);
 assert.notEqual(state.headline.whiteSpace,'nowrap');assert.notEqual(state.headline.overflow,'ellipsis');
 assert.ok(state.headline.text,'pending question is nonempty');
 assert.ok(state.headline.size>Math.max(state.typography.bodySize,...state.typography.labels.map((label:any)=>label.size)),'headline is larger than body labels');
 assert.ok(state.headline.weight>Math.max(state.typography.bodyWeight,...state.typography.labels.map((label:any)=>label.weight)),'headline is heavier than body labels');
 assert.equal(state.typography.headlineColor,state.typography.primaryColor,'headline uses the primary text token --fg-strong');
 assert.notEqual(state.band.background,'transparent');assert.doesNotMatch(state.band.background,/[\/,]\s*0(?:\.0+)?\s*\)$/,'question band has a nontransparent background');
 assert.ok(state.band.scrollWidth<=state.band.clientWidth+1,'live question row has no horizontal overflow');
 for(const saved of state.draftStates){
  assert.notEqual(saved.overflow,'ellipsis','live row state is not ellipsized');assert.notEqual(saved.whiteSpace,'nowrap','live row state can wrap');
  assert.ok(saved.scrollWidth<=saved.clientWidth+1&&saved.scrollHeight<=saved.clientHeight+1,'live row state text is fully visible');
  assert.ok(saved.rect.left>=state.bar.left-1&&saved.rect.right<=state.bar.right+1&&saved.rect.top>=state.row.top-1&&saved.rect.bottom<=state.row.bottom+1,'live state stays inside the row');
 }
 const right=Math.max(...state.answers.map((answer:any)=>answer.rect.right));
 assert.ok(Math.abs(state.bar.right-right)<=1,'answers end flush with the row content edge');
 assert.ok(state.answers.every((answer:any)=>answer.rect.left>=state.bar.left&&answer.rect.right<=state.bar.right+1),'all answers stay inside row');
 if(mode==='direction'){assert.equal(state.gateHidden,true);assert.equal(state.title,state.language==='en'?'Take · 1 s':'테이크 · 1초');}
}
for(const language of ['en','ko'] as const)for(const [width,height]of [[1440,900],[1100,800],[1280,720]] as const)for(const variant of [...modes,'parts-ready'] as const){
 if(width===1280&&variant!=='parts'&&variant!=='parts-ready'||flashOnly&&(width===1280||variant==='parts-ready'))continue;
 const mode:Mode=variant==='parts-ready'?'parts':variant;
 const out=join(output,variant,language,`${width}x${height}`);await mkdir(out,{recursive:true});
 const observationIndex=observations.length;
 const profile=await mkdtemp(join(tmpdir(),'review840-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 try{
  let url:string,expectedPendingFooter:string|undefined;
  if(mode==='standalone'){
   const fixture=await jobFixture(),capability='b'.repeat(64);
   const server=await startServer(await loadReview(join(fixture.root,'out')),{port:0,capability,stateDir:fixture.state});
   close=async()=>{server.stop(true);await fixture.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(mode==='checkpoint'||mode==='interview'){
   const fixture=await recordScreenFixture(mode==='interview'?'option-set':mode,false);
   close=()=>fixture.close();url=fixture.ownerUrl;
  }else{
   const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});close=()=>fixture.close();
   const stage=mode==='embedded-rig'?'rig':mode;
   const readyTitle='Parts ready. Source files remain unchanged.';
   const publication=await fixture.publish(stage,stage,variant==='parts-ready'?{title:readyTitle}:undefined);
   // origin/main changed(): a fresh compatible publication has no previousLabel, so its label is the footer.
   if(mode==='rig'||mode==='parts')expectedPendingFooter=variant==='parts-ready'?(language==='ko'?koCatalog[readyTitle]:enCatalog[readyTitle]):publication.label;
   await fixture.ask(publication,stage==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:stage==='direction'?'direction-review':'rig-review'});
   url=fixture.host.ownerUrl;
  }
  const target=new URL(url);target.searchParams.set('lang',language);url=target.href;
  let control:((method:string,params?:Record<string,unknown>)=>Promise<any>)|undefined,held=0;
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:async(event,send)=>{
   if(event.sessionId)control=send;
   if(event.method!=='Fetch.requestPaused')return;
   const request=event.params as {requestId:string};
   const state:any=await send('Runtime.evaluate',{expression:`!!document.querySelector('#workspace-review-act')&&document.body.dataset.ready!=='true'`,returnByValue:true});
   if(state.result?.value&&held===0){
    held++;await Bun.sleep(800);
    const slowed:unknown=await page!.evaluate(`(()=>{window.__sampleActRow?.('held-asset-response');return {runtime:${diagnostic},firstOffendingFrames:window.__actRowFirstOffendingFrames??[]};})()`);
    await writeFile(join(out,'slowed-load.json'),JSON.stringify({holdMs:800,state:slowed},null,2)+'\n');
    await writeFile(join(out,'slowed-load.png'),await page!.screenshot());
   }
   await send('Fetch.continueResponse',{requestId:request.requestId});
  }});
  await page.setViewport(width,height);assert.ok(control);
  await control('Page.addScriptToEvaluateOnNewDocument',{source:sampler});
  if(mode==='embedded-rig'){
   // The public job front accepts only the owner HTML's exact lang query.
   // Publication entries expose sealed data/assets, not another HTML entry.
   // Exercise main's existing embedded presentation in the real live-job host:
   // load the allowed URL, then set only client URL state before app mounting.
   // This fixture proves rendering with stageEmbed, not a public embedded URL.
   await control('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    if(location.pathname!==${JSON.stringify(target.pathname)})return;
    const url=new URL(location.href),requestSearch=url.search;
    url.searchParams.set('stageEmbed','1');history.replaceState(history.state,'',url.href);
    window.__embeddedActRowFixture={requestSearch,renderSearch:url.search,publicEmbeddedRoute:false};
   })()`});
  }
  await control('Fetch.enable',{patterns:[{urlPattern:'*assets/*',requestStage:'Response'},{urlPattern:'*review-painting*',requestStage:'Response'},{urlPattern:'*api/stage-parts/image/*',requestStage:'Response'}]});
  await page.goto(url,language);
  await wait(page,mode==='standalone'?`!!document.querySelector('#rig-root canvas')&&!document.body.inert`:`document.body.dataset.ready==='true'&&!document.body.inert&&!!document.querySelector('#workspace-ask-headline')?.textContent`);
  const optionReady=`!!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')&&!document.querySelector('#workspace-interview-answer')&&document.querySelector('#reference-content img')?.naturalWidth>0&&!document.querySelector('#send-comments')?.hidden`;
  if(mode==='interview')await wait(page,optionReady);
  if(mode==='embedded-rig'){
   const embedding:{requestSearch:string;renderSearch:string;publicEmbeddedRoute:boolean}=await page.evaluate(`window.__embeddedActRowFixture`);
   assert.equal(embedding.requestSearch,'?lang='+language);
   assert.equal(new URLSearchParams(embedding.renderSearch).get('stageEmbed'),'1');
   assert.equal(embedding.publicEmbeddedRoute,false);
   await writeFile(join(out,'embedded-presentation-fixture.json'),JSON.stringify(embedding,null,2)+'\n');
  }
  const initial:any=await capture(page,out,'pending',(mode==='parts'||mode==='rig')&&!flashOnly?expectedPendingFooter:undefined);assert.equal(initial.language,language);
  const loading:any[]=await page.evaluate(`window.__actRowSamples`);
  const firstOffendingFrames:unknown[]=await page.evaluate(`window.__actRowFirstOffendingFrames`);
  const violations=loading.filter(sample=>sample.controlsBeforeQuestion||sample.legacySave||sample.status||sample.label||sample.bar&&!sample.row);
  const flash={mode,language,width,height,held,samples:loading.length,violations:violations.length,firstOffendingFrames};
  if(violations.length)flashFailures.push(flash);
  await writeFile(join(out,'loading.json'),JSON.stringify({held,samples:loading,firstOffendingFrames},null,2)+'\n');
  await writeFile(join(out,'flash.json'),JSON.stringify({...flash,violations},null,2)+'\n');
  console.log('ACT_ROW_FLASH_CASE '+JSON.stringify({...flash,firstOffendingFrames:firstOffendingFrames.slice(0,1)}));
  // Persist the actual first offending mutation/frame before any style assertion
  // can stop the default matrix. Flash-only never reaches those later assertions.
  observations.push({mode,language,width,height,initial,flash});
  assert.ok(loading.length>0,'sampler observed this screen');
  if(flashOnly){
   if(['rig','direction','parts','embedded-rig','standalone'].includes(mode))assert.ok(held>0,'asset response held while live workspace was loading');
   continue;
  }
  assert.deepEqual(violations,[],'zero visible live answer controls before a visible nonempty question; no legacy/out-of-row flash');
  assertPending(initial,mode,width,expectedPendingFooter);
  if(['rig','direction','parts','embedded-rig','standalone'].includes(mode))assert.ok(held>0,'asset response held while live workspace was loading');
  assert.ok(!loading.some(sample=>sample.bar&&!sample.row),'a live act is only visible inside its row');
  // Test-only DOM mutation: announce and hash the exact node before changing it;
  // restore in finally and verify its hash before any subsequent measurement.
  const headlineBefore:{text:string;html:string}=await page.evaluate(`(()=>{const n=document.getElementById('workspace-ask-headline');return {text:n.textContent,html:n.outerHTML};})()`);
  const beforeHash=createHash('sha256').update(headlineBefore.html).digest('hex');
  const mutation={mode,language,width,height,selector:'#workspace-ask-headline',scope:'test-only DOM',beforeHash};
  console.log('ACT_ROW_DOM_MUTATION_BEGIN '+JSON.stringify(mutation));
  await writeFile(join(out,'headline-mutation-begin.json'),JSON.stringify(mutation,null,2)+'\n');
  try{
   await page.evaluate(`document.getElementById('workspace-ask-headline').textContent=${JSON.stringify((headlineBefore.text+' ').repeat(16))}`);
   const wrapped:any=await capture(page,out,'long-question',mode==='rig'?expectedPendingFooter:undefined);assertPending(wrapped,mode,width,expectedPendingFooter);assert.ok(wrapped.headline.rect.height>initial.headline.rect.height);
   assert.equal(await page.evaluate(`document.getElementById('workspace-ask-headline').scrollWidth<=document.getElementById('workspace-ask-headline').clientWidth+1`),true);
  }finally{
   await page.evaluate(`document.getElementById('workspace-ask-headline').textContent=${JSON.stringify(headlineBefore.text)}`);
   // Restoring the question resizes the row. ResizeObserver schedules workspace
   // layout in the following frame; settle it before the CDP click caches a point.
   await settleLayout(page);
   const restoredHtml:string=await page.evaluate(`document.getElementById('workspace-ask-headline').outerHTML`);
   const restoredHash=createHash('sha256').update(restoredHtml).digest('hex');
   const restored={...mutation,restoredHash,restored:restoredHash===beforeHash};
   console.log('ACT_ROW_DOM_MUTATION_RESTORED '+JSON.stringify(restored));
   await writeFile(join(out,'headline-mutation-restored.json'),JSON.stringify(restored,null,2)+'\n');
   assert.equal(restoredHash,beforeHash,'long-question DOM restored byte-for-byte before further measurements');
  }
  // #1041: a bottom panel with no view-controller block collapses to nothing; there is nothing to collapse.
  let collapsed:any=null;
  if(await page.evaluate<boolean>(`document.getElementById('workspace-inspector').hidden`)){
   assert.match(await page.evaluate<string>(`document.querySelector('.layout main').style.gridTemplateRows`),/ 0px 0px$/,'the stage takes the bottom height');
  }else{
  await click(page,'#workspace-bottom-collapse');
  await wait(page,`document.querySelector('.inspector-body').hidden`);
  collapsed=await capture(page,out,'collapsed',mode==='rig'?expectedPendingFooter:undefined);assertPending(collapsed,mode,width,expectedPendingFooter);
  assert.ok(Math.abs(collapsed.panel.height-collapsed.heading.height)<=2,'collapsed panel is only its heading');
  assert.ok(collapsed.panel.height<initial.panel.height,'collapse actually shrinks the panel');
  await click(page,'#workspace-bottom-collapse');await wait(page,`!document.querySelector('.inspector-body').hidden`);
  }
  if(['rig','direction','parts','embedded-rig','standalone'].includes(mode)){
   assert.equal(await page.evaluate(`document.getElementById('request-changes').disabled`),true,'changes needs a comment');
   if(mode==='standalone'){
    const standaloneStyles:{msg:{maxWidth:string;whiteSpace:string;textOverflow:string};state:{maxWidth:string;whiteSpace:string;textOverflow:string}}=await page.evaluate(`(()=>{
     const msg=document.getElementById('review-message'),state=document.getElementById('review-draft-state');
     msg.textContent='Refusal: very long refusal message that must wrap cleanly inside #workspace-act-row without 36ch truncation or ellipsis on standalone package screens';
     msg.classList.add('error');
     const pick=el=>{const cs=getComputedStyle(el);return {maxWidth:cs.maxWidth,whiteSpace:cs.whiteSpace,textOverflow:cs.textOverflow};};
     const res={msg:pick(msg),state:pick(state)};
     msg.textContent='';msg.classList.remove('error');
     return res;
    })()`);
    assert.deepEqual(standaloneStyles.msg,{maxWidth:'none',whiteSpace:'normal',textOverflow:'clip'});
    assert.deepEqual(standaloneStyles.state,{maxWidth:'none',whiteSpace:'normal',textOverflow:'clip'});
    observations[observationIndex]={mode,language,width,height,initial,collapsed,held,flash};
    continue;
   }
   if(mode==='rig'){
    await click(page,'#zoom-in');await wait(page,`Object.keys(localStorage).some(key=>key.startsWith('rig-review-draft/1:'))`);
    const key:string=await page.evaluate(`Object.keys(localStorage).find(key=>key.startsWith('rig-review-draft/1:'))`);
    for(const action of ['download','discard']){
     // Leave first so departure persistence cannot overwrite the planted corrupt bytes.
     await page.goto(new URL('/favicon.ico',url).href);
     await page.evaluate(`localStorage.setItem(${JSON.stringify(key)},'{corrupt saved draft')`);await page.goto(url,language);
     await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&document.querySelector('#review-draft-recovery button')`);
     const blocked:{submit:boolean;changes:boolean;noticeInRow:boolean;noticeVisible:boolean;kind:string}=await page.evaluate<any>(`({submit:document.getElementById('save').disabled,changes:document.getElementById('request-changes').disabled,noticeInRow:!!document.querySelector('#workspace-act-row #review-draft-recovery'),noticeVisible:!!document.getElementById('review-draft-recovery').getClientRects().length,kind:document.getElementById('review-draft-state').dataset.saveState})`);
     assert.deepEqual(blocked,{submit:true,changes:true,noticeInRow:true,noticeVisible:true,kind:'failed'});
     const recovery:any=await capture(page,out,'restore-'+action+'-blocked',mode==='rig'?expectedPendingFooter:undefined);assertPending(recovery,mode,width,expectedPendingFooter);
     const bands:any=await page.evaluate(`(()=>{const r=id=>document.getElementById(id).getBoundingClientRect().toJSON();return {headline:r('workspace-ask-headline'),notice:r('review-draft-state'),recovery:r('review-draft-recovery')};})()`);
     assert.ok(bands.headline.top<bands.notice.top,'restore notice follows the first-line question');
     assert.ok(Math.abs((bands.headline.top+bands.headline.bottom)/2-(bands.recovery.top+bands.recovery.bottom)/2)<=1,'restore actions stay beside the first-line question');
     await click(page,'#review-draft-recovery button:'+(action==='download'?'first-child':'last-child'));
     await wait(page,`!document.getElementById('save').disabled&&!document.querySelector('#review-draft-recovery button')`);
     await capture(page,out,'restore-'+action+'-unlocked');
    }
   }
   await click(page,'#save');
   // #1226 owner ruling: a live rig with no ask keeps its row (no-ask line, Send comments); the approved outcome stays its state.
   // #1242 owner ruling: the direction and parts screens hold the same row.
   const liveRig=true,stateId='review-draft-state';
   await wait(page,`document.getElementById('workspace-act-row').hidden===${!liveRig}&&!document.getElementById('${stateId}').hidden&&document.getElementById('${stateId}').dataset.saveState==='saved'`);
   const submitted:any=await capture(page,out,'submitted');assert.equal(submitted.rowVisible,liveRig);
   if(mode!=='embedded-rig')assert.deepEqual(submitted.states,[stateId]);
   const catalog=language==='en'?enCatalog:koCatalog;
   assert.equal(await page.evaluate(`document.getElementById('${stateId}').textContent`),catalog['job.review.approved']);
   if(liveRig)assert.equal(await page.evaluate(`document.getElementById('workspace-ask-headline').textContent`),catalog["We're looking at the work together. Leave your thoughts as comments."]);
  }else if(mode==='interview'){
   const catalog=language==='en'?enCatalog:koCatalog;
   assert.deepEqual(initial.answers.map((answer:any)=>answer.id),['send-comments']);
   assert.deepEqual(initial.primary,['send-comments']);
   assert.equal(initial.headline.text,catalog["We're looking at the work together. Leave your thoughts as comments."]);
   await page.evaluate<void>(`document.querySelector('[data-comment-general]').scrollIntoView({block:'nearest'})`);
   await click(page,'[data-comment-general]');
   await wait(page,`!!document.querySelector('.stage-comment-composer input')`);
   await page.evaluate<void>(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value='Option set comment';form.requestSubmit();})()`);
   await wait(page,`!document.querySelector('.stage-comment-composer')&&!document.querySelector('#send-comments').disabled`);
   await capture(page,out,'answer-question');
   await click(page,'#send-comments');
   await expectRecordActSubmitted(page,expression=>wait(page!,expression),language,`${mode} submitted`);
   const saved:any=await capture(page,out,'answer-saved');
   const savedState:{pending:boolean;row:{kind:string;text:string};dirty:{kind:string;text:string}}=await page.evaluate(`(()=>{
    const state=id=>{const n=document.getElementById(id);return {kind:n.dataset.saveState,text:n.textContent};};
    return {pending:['save','request-changes','workspace-pending-ask'].some(id=>!document.getElementById(id).hidden),row:state('review-draft-state'),dirty:state('dirty')};
   })()`);
   await writeFile(join(out,'answer-saved-state.json'),JSON.stringify(savedState,null,2)+'\n');
   // #1242 owner ruling: the record screen keeps its row with Send comments, so the submitted state stays in the row.
   assert.equal(savedState.pending,false);
   assert.equal(saved.rowVisible,true);assert.deepEqual(saved.states,['review-draft-state']);
   assert.deepEqual(saved.answers.map((answer:any)=>answer.id),['send-comments']);assert.deepEqual(saved.primary,['send-comments']);
   assert.deepEqual(savedState.row,{kind:'saved',text:catalog['Submitted']});
   assert.deepEqual(savedState.dirty,savedState.row,'the hidden header copy mirrors the submitted state');
  }else{
   assert.deepEqual(initial.answers.map((answer:any)=>answer.id),['workspace-pending-ask']);
   await click(page,'#workspace-pending-ask');await wait(page,`!!document.querySelector('#workspace-communication:not([hidden]) #job-record-asks:not([hidden])')`);
   assert.equal(await page.evaluate(`document.getElementById('workspace-pending-ask').closest('#workspace-act-row')!==null`),true);
   await capture(page,out,'answer-dialog');
   const submit='#job-record-asks button[data-job-text="Pass"]';
   await click(page,submit);
   await expectRecordActSubmitted(page,expression=>wait(page!,expression),language,`${mode} submitted`);
   const saved:any=await capture(page,out,'answer-saved');
   const savedState:{pending:boolean;row:{kind:string;text:string};dirty:{kind:string;text:string}}=await page.evaluate(`(()=>{
    const state=id=>{const n=document.getElementById(id);return {kind:n.dataset.saveState,text:n.textContent};};
    return {pending:['save','request-changes','workspace-pending-ask'].some(id=>!document.getElementById(id).hidden),row:state('review-draft-state'),dirty:state('dirty')};
   })()`);
   await writeFile(join(out,'answer-saved-state.json'),JSON.stringify(savedState,null,2)+'\n');
   assert.equal(savedState.pending,false);assert.deepEqual(saved.primary,['send-comments']);
   assert.deepEqual(savedState.dirty,savedState.row,'the hidden header copy mirrors the submitted state');
  }
  if(mode==='rig'){
   // Fail the first hosted metadata clone while #904's waiting row is visible and
   // answers are absent. Restore the native immediately; this remains a synthetic read refusal.
   await control('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const native=window.structuredClone;
    const probe=window.__earlyActReadProbe={documentToken:Date.now()+':'+Math.random(),installed:true,calls:[],triggered:0,errors:[]};
    addEventListener('error',event=>{if(probe.errors.length<20)probe.errors.push({kind:'error',message:event.message});});
    addEventListener('unhandledrejection',event=>{if(probe.errors.length<20)probe.errors.push({kind:'unhandledrejection',message:String(event.reason)});});
    new MutationObserver(()=>{
     if(!window.__earlyActReadRefused||window.__earlyActRowRefusal)return;
     const row=document.getElementById('workspace-act-row'),message=document.getElementById('review-message');
     if(!row||row.hidden||!message?.classList.contains('error'))return;
     const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden]');
    const footer=document.getElementById('message');
    window.__earlyActRowRefusal={rowVisible:visible(row),text:message.textContent,messageVisible:visible(message),footerText:footer.textContent,footerTitle:footer.title,
      controls:[...row.querySelectorAll('#save,#request-changes,#workspace-pending-ask,#review-status,label[for="review-status"]')].filter(visible).map(n=>n.id||n.tagName),
      rowRect:row.getBoundingClientRect().toJSON(),messageRect:message.getBoundingClientRect().toJSON()};
    }).observe(document,{childList:true,subtree:true,attributes:true});
    window.structuredClone=function(value,...args){
     const row=document.getElementById('workspace-act-row');
     const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden]');
     const headline=document.getElementById('workspace-ask-headline');
     const call={rowPresent:!!row,rowHidden:row?.hidden??null,rowVisible:visible(row),
      answersAbsent:![...(row?.querySelectorAll('#save,#request-changes,#workspace-pending-ask')??[])].some(visible),
      waitingPrompt:visible(headline)&&headline.textContent.trim()===${JSON.stringify((language==='ko'?koCatalog:enCatalog)['job.waiting'])},
      hasManifest:!!value?.manifest,hasSourceHash:!!value?.sourceHash};
     if(probe.calls.length<100)probe.calls.push(call);
     if(call.rowVisible&&call.answersAbsent&&call.waitingPrompt&&call.hasManifest&&call.hasSourceHash){
      window.structuredClone=native;probe.triggered++;probe.trigger=call;window.__earlyActReadRefused=true;throw Error('JOB_VISUAL_UNAVAILABLE');
     }
     return native.call(this,value,...args);
    };
   })()`});
   // The capability is consumed from the URL. Reopening url from the submitted
   // screen can be only a hash navigation, which does not run new-document scripts.
   // Leave the document first, just as the corrupt-draft checks above do.
   await page.goto('about:blank');
   const blankToken:string|null=await page.evaluate(`window.__earlyActReadProbe?.documentToken??null`);
   await page.goto(url,language);
   // The normal host rolls the failed candidate back. Observe the real message()
   // reveal at its mutation boundary, before that rollback; do not suppress it.
   await wait(page,`!!window.__earlyActRowRefusal`);
   const probe:any=await page.evaluate(`window.__earlyActReadProbe`);
   assert.equal(typeof probe.documentToken,'string');assert.notEqual(probe.documentToken,blankToken,'early refusal runs in a fresh document');
   assert.equal(probe.installed,true);assert.equal(probe.triggered,1);
   assert.deepEqual(probe.trigger,{rowPresent:true,rowHidden:false,rowVisible:true,answersAbsent:true,waitingPrompt:true,hasManifest:true,hasSourceHash:true});
   await writeFile(join(out,'early-refusal-probe.json'),JSON.stringify(probe,null,2)+'\n');
   const refusal:any=await page.evaluate(`window.__earlyActRowRefusal`);
   assert.equal(refusal.rowVisible,true);assert.equal(refusal.messageVisible,true);assert.deepEqual(refusal.controls,[]);
   assert.ok(refusal.text.includes('JOB_VISUAL_UNAVAILABLE'));
   assert.ok(!refusal.footerText.includes('JOB_VISUAL_UNAVAILABLE')&&!refusal.footerTitle.includes('JOB_VISUAL_UNAVAILABLE'),'refusal stays out of the footer and its tooltip');
   await writeFile(join(out,'early-refusal-before-rollback.json'),JSON.stringify(refusal,null,2)+'\n');
   await writeFile(join(out,'early-refusal-after-rollback.png'),await page.screenshot());
  }
  observations[observationIndex]={mode,language,width,height,initial,collapsed,held,flash};
 }catch(error){
  const runtime:unknown=page?await page.evaluate(diagnostic).catch(reason=>({diagnosticError:String(reason)})):null;
  if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});
  const failed={mode,language,width,height,error:String(error),runtime};caseFailures.push(failed);
  await writeFile(join(out,'failure.json'),JSON.stringify(failed,null,2)+'\n');
  observations[observationIndex]={mode,language,width,height,failure:failed};
  if(!flashOnly)throw error;
 }
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');}
}
await writeFile(join(output,'flash-summary.json'),JSON.stringify({flashOnly,cases:observations.length,flashFailures,caseFailures},null,2)+'\n');
assert.deepEqual(caseFailures,[],'all matrix cases sampled successfully');
assert.deepEqual(flashFailures,[],'zero live answer controls before the question across every sampled screen');
console.log('ACT_ROW_840_OK cases='+observations.length+' EN='+observations.length/2+' KO='+observations.length/2);
