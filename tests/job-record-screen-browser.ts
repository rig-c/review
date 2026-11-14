/** #750 ordinary Nova only. Real shipped UI paths and retained record reader/writer doubles.
 * Interview-only shared screen proof; approval modals are covered by job-record-modal-browser.ts.
 * EN/KO, interview picks, picture/empty, 1600x1000; no installed-producer conformance claim. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {buildWeb} from '../src/build.ts';
import {prepareJobRecordAct} from '../src/job-act.ts';
import type {JobRetainedRecordSource} from '../src/job-source.ts';
import {parseRecordAct} from '../src/job-api.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const interviewOnly=Bun.argv.includes('--interview-only');
const completedPicture=Bun.argv.includes('--completed-picture')||Bun.argv.includes('--question-tab');
const freshParts=Bun.argv.includes('--fresh-parts');
const narrowQuestionResize=Bun.argv.includes('--question-narrow-resize');
const followup839=Bun.argv.includes('--followup-839');
const baseline=await Bun.file(new URL('./fixtures/interview-722-empty-note.json',import.meta.url)).json();
const output=resolve(arg('--out')??'artifacts/record-screen-750');await mkdir(output,{recursive:true});
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const profile=await mkdtemp(join(tmpdir(),'review-750-browser-'));
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
let holdImages=false;const pausedImages:string[]=[];
const exceptions:unknown[]=[],mutations:{method:string;path:string}[]=[],cases:unknown[]=[];
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('750_BROWSER_TIMEOUT '+label);}

type StripState={tabs:{id:string;text:string;disabled:boolean}[];selected:string|null;selectedVisible:boolean;questionFirst:boolean;reportOverflow:boolean;actRowVisible:boolean;ordinaryPanelVisible:boolean};
const stripState=()=>page!.evaluate<StripState>(`(()=>{const row=document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])'),visible=n=>!!n&&!n.hidden&&n.getClientRects().length>0&&getComputedStyle(n).display!=='none';const buttons=[...row.querySelectorAll(':scope>button[role=tab]')],selected=row.querySelector('[aria-selected=true]');return {tabs:buttons.filter(visible).map(n=>({id:n.dataset.blockTarget,text:n.textContent,disabled:n.disabled})),selected:selected?.dataset.blockTarget??null,selectedVisible:visible(selected),questionFirst:buttons[0]?.dataset.blockTarget==='question',reportOverflow:!!row.querySelector('[data-block-target=report-panel][data-tab-overflow]'),actRowVisible:visible(document.querySelector('#workspace-act-row')),ordinaryPanelVisible:visible(document.querySelector('#selected-part'))};})()`);
async function selectBlock(target:string){
 const selector=`.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target="${target}"]`;
 if(await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('data-tab-overflow')`)){
  await click(page!,'.workspace-bottom-tabs>.block-row:not([hidden]) .workspace-tabs-more');await click(page!,`.workspace-tabs-menu:not([hidden]) [data-block-more-target="${target}"]`);
 }else await click(page!,selector);
}
const ordinaryParts=new Map<string,{state:StripState;sourceHash:string}>();
async function ordinaryPartsStrip(language:string,out:string){
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});
 try{
  const publication=await fixture.publish('parts');await fixture.ask(publication,{kind:'parts-verdict',draftId:'synthetic-parts'});
  const before=await jobInputHashes(fixture.input.root),url=new URL(fixture.locator+'/#cap='+fixture.credentials.ui);url.searchParams.set('lang',language);
  await page!.goto('about:blank');await page!.goto(url.href);await wait(`document.body.dataset.ready==='true'&&document.querySelector('[data-part-list] button')&&!document.body.inert`,'839 genuine ordinary parts verdict');
  const state=await stripState();assert.equal(state.tabs.length,9);assert.equal(state.tabs[0]!.id,'selected-part');assert.equal(state.tabs[0]!.disabled,false);assert.ok(state.tabs.slice(1).every(tab=>tab.disabled));
  const result={state,sourceHash:publication.source.sourceHash};await writeFile(join(out,'ordinary-parts.json'),JSON.stringify(result,null,2));await writeFile(join(out,'ordinary-parts.png'),await page!.screenshot());
  assert.deepEqual(await jobInputHashes(fixture.input.root),before);ordinaryParts.set(language,result);return result;
 }finally{await page!.goto('about:blank');await fixture.close();}
}
function comparePartsStrip(state:StripState,ordinary:StripState,question:boolean){
 assert.deepEqual(state.tabs.filter(tab=>tab.id!=='question'),ordinary.tabs,'displayed ordinary parts tabs and disabled states match genuine parts-verdict job');
 assert.equal(state.tabs.some(tab=>tab.id==='question'),question);
 if(question){assert.equal(state.questionFirst,true);assert.equal(state.tabs[0]!.id,'question');assert.equal(state.tabs.find(tab=>tab.id==='question')!.disabled,false);}
}

/** #839 uses the same retained fixture and #834 viewport instrument; no replacement screen. */
async function questionTabChecks(){
 for(const picture of [true,'parts'] as const)for(const language of ['en','ko'] as const){
  const fixture=await recordScreenFixture('interview-picks',picture),out=join(output,picture==='parts'?'parts':'rig',language);
  await mkdir(out,{recursive:true});fixture.output(out);const before=await jobInputHashes(fixture.root);
  try{
   // Measure the pre-existing controls, then publish the genuine pending ask through the fixture stream.
   for(let i=fixture.fake.events.length-1;i>=0;i--)if(fixture.fake.events[i]!.type==='pending')fixture.fake.events.splice(i,1);
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
   await page!.setViewport(1440,900);await command!('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
   const ordinary=picture==='parts'?await ordinaryPartsStrip(language,out):null;
   await page!.goto('about:blank');await page!.goto(url.href);await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#rig-root canvas')`,'839 baseline');
   const tabs=async()=>(await stripState()).tabs;
   const beforeAskStrip=await stripState();if(ordinary)comparePartsStrip(beforeAskStrip,ordinary.state,false);else assert.equal(beforeAskStrip.tabs.length,10,'ten ordinary Animate tabs remain displayed');
   const awayTarget=picture==='parts'?'selected-part':'animation-dock';
   // A non-default camera makes restoration stronger than a view-label check.
   if(picture==='parts')await click(page!,'#native-one');await click(page!,'#zoom-in');
   const viewExpression=`(()=>{const raw=document.querySelector('#view-coordinates').textContent;const numeric=raw?JSON.parse(raw):{cameraSync:document.querySelector('#camera-sync').checked,activeCamera:null,cameras:Object.fromEntries(['rig','reference'].map(key=>{const root=document.querySelector(key==='rig'?'#rig-root':'#reference-content'),pane=document.querySelector('#'+key+'-viewport'),scale=new DOMMatrix(getComputedStyle(root).transform);return [key,{space:'image',center:{x:(pane.clientWidth/2-parseFloat(root.style.left||'0'))/scale.a,y:(pane.clientHeight/2-parseFloat(root.style.top||'0'))/scale.d},zoom:scale.a}];}))};return {mode:document.querySelector('#view-menu [aria-pressed=true]')?.dataset.view,rigHidden:document.querySelector('#rig-pane').hidden,referenceHidden:document.querySelector('#reference-pane').hidden,reference:document.querySelector('#reference-select').value,referenceHTML:document.querySelector('#reference-content').innerHTML,cameraSync:numeric.cameraSync,activeCamera:numeric.activeCamera,cameras:Object.fromEntries(Object.entries(numeric.cameras).map(([key,camera])=>[key,camera?{space:camera.space,center:camera.center,zoom:camera.zoom}:null]))};})()`;
   await page!.evaluate(`window.__questionOriginalReferenceNodes=[...document.querySelector('#reference-content').childNodes];window.__questionOriginalPersonSelect=document.querySelector('#person-select')`);
   const originalView=await page!.evaluate(viewExpression),originalTabs=await tabs();
   fixture.fake.pending(fixture.ask,fixture.display.publication.generation+1);
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`,root='#workspace-interview-answer';
   await wait(`!!document.querySelector(${JSON.stringify(root+' '+selector+' fieldset:not(:disabled)')})&&!!document.querySelector('[data-block-target=question][aria-selected=true]')`,'839 load Question selected');
   await wait(`document.querySelector('#reference-content img')?.naturalWidth===2`,'839 question picture');
   assert.equal(await page!.evaluate('devicePixelRatio'),2);assert.equal(await page!.evaluate('innerWidth'),1440);
   assert.equal(await page!.evaluate(`document.querySelector('[data-block-target=question][aria-selected=true]').textContent`),(language==='en'?enCatalog:koCatalog)['Question']);
   const eventArrivalStrip=await stripState();assert.equal(eventArrivalStrip.tabs[0]!.id,'question');assert.deepEqual(eventArrivalStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs and enabled states retained');
   if(ordinary)comparePartsStrip(eventArrivalStrip,ordinary.state,true);
   assert.equal(await page!.evaluate(`!!document.querySelector('dialog[open]')`),false);
   await writeFile(join(out,'event-arrival.png'),await page!.screenshot());
   await selectBlock(awayTarget);await wait(`!document.querySelector('#workspace-interview-answer[data-question-image-active]')`,'839 event-arrival away');
   const eventAwayStrip=await stripState();assert.equal(eventAwayStrip.actRowVisible,true);if(ordinary){comparePartsStrip(eventAwayStrip,ordinary.state,true);assert.equal(eventAwayStrip.ordinaryPanelVisible,true);}
   assert.deepEqual(await page!.evaluate(viewExpression),originalView,'pre-ask view/reference/camera restored');
   assert.equal(await page!.evaluate(`(()=>{const nodes=[...document.querySelector('#reference-content').childNodes];return nodes.length===window.__questionOriginalReferenceNodes.length&&nodes.every((node,i)=>node===window.__questionOriginalReferenceNodes[i])&&document.querySelector('#person-select')===window.__questionOriginalPersonSelect;})()`),true);
   // The same genuine pending stream must select Question on initial navigation, not only event arrival.
   await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`!!document.querySelector(${JSON.stringify(root+' '+selector+' fieldset:not(:disabled)')})&&!!document.querySelector('[data-block-target=question][aria-selected=true]')&&document.querySelector('#reference-content img')?.naturalWidth===2`,'839 pending on page load');
   const pendingStrip=await stripState();assert.equal(pendingStrip.tabs[0]!.id,'question');assert.deepEqual(pendingStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs retained on pending load');assert.equal(pendingStrip.selectedVisible,true);assert.equal(pendingStrip.questionFirst,true);
   if(ordinary)comparePartsStrip(pendingStrip,ordinary.state,true);
   assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),false,'pending interview save remains visible');
   await writeFile(join(out,'load.png'),await page!.screenshot());
   let narrowStrip:StripState|undefined;
   if(picture===true&&narrowQuestionResize){
    await command!('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:2,mobile:false});
    await wait(`(()=>{const row=document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])');return row.querySelector('[data-block-target=question][aria-selected=true]')?.getBoundingClientRect().width>0&&!!row.querySelector('[data-block-target=report-panel][data-tab-overflow]');})()`,'839 900px selected Question visible and Report overflows');
    narrowStrip=await stripState();assert.equal(narrowStrip.selectedVisible,true);assert.equal(narrowStrip.reportOverflow,true);assert.equal(narrowStrip.questionFirst,true);await writeFile(join(out,'narrow-900.png'),await page!.screenshot());
    await command!('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});await wait(`innerWidth===1440&&document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])').clientWidth>1000`,'839 full strip restored');
   }
   // Establish the previous review view on this document before checking identity/camera restoration.
   await selectBlock(awayTarget);await wait(`!document.querySelector('#workspace-interview-answer[data-question-image-active]')`,'839 pending load away');
   if(picture==='parts')await click(page!,'#native-one');await click(page!,'#zoom-in');
   await page!.evaluate(`window.__questionOriginalReferenceNodes=[...document.querySelector('#reference-content').childNodes];window.__questionOriginalPersonSelect=document.querySelector('#person-select')`);
   const pendingPreviousView=await page!.evaluate(viewExpression);
   await click(page!,'#workspace-pending-ask');await wait(`document.querySelector('#reference-content img')?.naturalWidth===2&&!!document.querySelector('#workspace-interview-answer[data-question-image-active]')`,'839 pending load return');
   // Comments exists for both backdrop kinds, including parts whose source has no model blocks.
   await selectBlock(awayTarget);await wait(`!document.querySelector('#workspace-interview-answer[data-question-image-active]')`,'839 restore previous view');
   const awayStrip=await stripState();assert.equal(awayStrip.actRowVisible,true);if(ordinary){comparePartsStrip(awayStrip,ordinary.state,true);assert.equal(awayStrip.ordinaryPanelVisible,true);}
   assert.deepEqual(await page!.evaluate(viewExpression),pendingPreviousView,'actual view/reference/camera restored');
   assert.equal(await page!.evaluate(`(()=>{const nodes=[...document.querySelector('#reference-content').childNodes];return nodes.length===window.__questionOriginalReferenceNodes.length&&nodes.every((node,i)=>node===window.__questionOriginalReferenceNodes[i])&&document.querySelector('#person-select')===window.__questionOriginalPersonSelect;})()`),true,'prior reference node identity restored');
   await writeFile(join(out,'away.png'),await page!.screenshot());
   await click(page!,'#stage-comment');
   await click(page!,'#workspace-pending-ask');await wait(`!!document.querySelector('#workspace-interview-answer[data-question-image-active]')&&document.querySelector('#reference-content img')?.naturalWidth===2`,'839 return image');
   // Return after the shipped Comment action enabled capture on the review backdrop.
   await wait(`!document.querySelector('#rig-viewport.stage-comment-mode,#reference-viewport.stage-comment-mode')`,'839 transient image refuses pin mode');
   const pinBox:any=await page!.evaluate(`document.querySelector('#reference-viewport').getBoundingClientRect().toJSON()`);
   await page!.mouse('mousePressed',pinBox.x+pinBox.width/2,pinBox.y+pinBox.height/2);await page!.mouse('mouseReleased',pinBox.x+pinBox.width/2,pinBox.y+pinBox.height/2);
   assert.equal(await page!.evaluate(`!!document.querySelector('.stage-comment-composer')`),false,'no pointed comment composer on transient question image');
   await writeFile(join(out,'back.png'),await page!.screenshot());
   await page!.evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});for(const value of ['topology_other','density_auto'])form.querySelector('input[value="'+value+'"]').click();const other=form.querySelector('textarea[name="other.topology"]');other.value=${JSON.stringify('  Custom topology · 직접 입력\n')};other.dispatchEvent(new Event('input',{bubbles:true}));form.querySelector('button[type=submit]').scrollIntoView({block:'center'});})()`);
   await click(page!,selector+' button[type=submit]');
   await wait(`document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'&&document.querySelector('#dirty').textContent.includes(${JSON.stringify(language==='ko'?'저장':'saved')})&&document.querySelector('#workspace-act-row').hidden`,'839 answer saved');
   assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' fieldset')}).disabled`),true);
   assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),true,'answered interview submit is absent from readback');
   assert.equal(await page!.evaluate(`document.getElementById('message').textContent`),await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'interview-only saved footer agrees with rendered saved header');
   assert.deepEqual(await page!.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector+' input:checked')})].map(n=>n.value)`),['topology_other','density_auto']);
   assert.equal(await page!.evaluate(`['workspace-pending-ask','save','request-changes'].every(id=>document.getElementById(id).hidden)`),true,'completed answer controls hidden');
   assert.equal(await page!.evaluate(`document.querySelector('#workspace-act-row').hidden`),true);
   assert.deepEqual(await page!.evaluate(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['dirty'],'single visible saved state');
   const answeredStrip=await stripState();assert.equal(answeredStrip.tabs[0]!.id,'question');assert.deepEqual(answeredStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs retained after save');if(ordinary)comparePartsStrip(answeredStrip,ordinary.state,true);
   const savedFooter:string=await page!.evaluate<string>(`document.getElementById('message').textContent`);
   assert.equal(savedFooter,await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'footer agrees with actual rendered saved header');
   const readbackCopy=await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')}).textContent`);assert.equal(readbackCopy,(language==='en'?enCatalog:koCatalog)['job.saved']);
   await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')}).scrollIntoView({block:'center'})`);await writeFile(join(out,'readback-status.png'),await page!.screenshot());
   await selectBlock(awayTarget);if(ordinary){const savedAway=await stripState();comparePartsStrip(savedAway,ordinary.state,true);assert.equal(savedAway.ordinaryPanelVisible,true);}
   await selectBlock('question');
   await wait(`document.querySelector('#workspace-interview-answer[data-question-image-active]')&&document.querySelector('#reference-content img')?.naturalWidth===2`,'839 saved readback through Question tab');
   await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' input:checked')}).scrollIntoView({block:'center'})`);
   await writeFile(join(out,'answered.png'),await page!.screenshot());
   const bytes=await readFile(join(out,'one-screen.json'),'utf8'),act=parseRecordAct(JSON.parse(bytes));assert.equal(act.kind,'interview-picks');
   if(act.kind!=='interview-picks')throw Error('wrong act');
   assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
   const expected=prepareJobRecordAct({jobId:fixture.session.jobId,submission:{...fixture.submissions.at(-1)!,value:JSON.parse(baseline.expectedValueBytes)},ask:fixture.ask,retained:fixture.session.retainedSourceV3(fixture.ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z'});
   assert.equal(bytes,JSON.stringify(expected));assert.equal(sha(await readFile(new URL('../src/job-act.ts',import.meta.url))),baseline.writerSourceSha256);
   // The fixture server replays the committed act just as the real retained job stream does on reload.
   const pending=fixture.fake.events.find(event=>event.type==='pending'&&event.ask.askId===fixture.ask.askId);
   if(!pending||pending.type!=='pending')throw Error('missing pending fixture event');fixture.fake.events.push({type:'act',jobId:fixture.session.jobId,generation:fixture.display.publication.generation+2,cursor:String(fixture.fake.events.length+1),act});
   await page!.goto('about:blank');await page!.goto(url.href);await wait(`document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'&&document.querySelector('#reference-content img')?.naturalWidth===2`,'839 reload readback');
   assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' fieldset')}).disabled`),true);
   assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),true,'answered interview submit is absent from readback');
   assert.equal(await page!.evaluate(`document.getElementById('message').textContent`),await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'interview-only saved footer agrees with rendered saved header');
   assert.deepEqual(await page!.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector+' input:checked')})].map(n=>n.value)`),['topology_other','density_auto']);
   assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' textarea[name="other.topology"]')}).value`),'  Custom topology · 직접 입력\n');
   assert.equal(await page!.evaluate(`document.querySelector('#workspace-act-row').hidden&&['workspace-pending-ask','save','request-changes'].every(id=>document.getElementById(id).hidden)`),true,'reloaded completed row and controls hidden');
   assert.deepEqual(await page!.evaluate(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['dirty'],'reloaded single visible saved state');
   assert.ok(await page!.evaluate(`document.querySelector('#dirty').textContent.includes(${JSON.stringify(language==='ko'?'저장':'saved')})`));
   await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' input:checked')}).scrollIntoView({block:'center'})`);
   await writeFile(join(out,'reload.png'),await page!.screenshot());
   const reloadStrip=await stripState();assert.equal(reloadStrip.tabs[0]!.id,'question');assert.deepEqual(reloadStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs retained on readback reload');if(ordinary)comparePartsStrip(reloadStrip,ordinary.state,true);
   const observation={originalView,pendingPreviousView,transientPinRefused:true,pendingOnLoad:true,picture,language,width:1440,height:900,dpr:2,originalTabs,ordinary,beforeAskStrip,eventArrivalStrip,eventAwayStrip,pendingStrip,awayStrip,answeredStrip,reloadStrip,narrowStrip,readbackCopy,savedFooter,sourceHash:fixture.display.publication.source.sourceHash,fullActByteEqual:true,bytes:bytes.length};cases.push(observation);await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2));
   console.log('839_QUESTION_PASS '+JSON.stringify(observation));
   assert.deepEqual(await jobInputHashes(fixture.root),before);
  }finally{await fixture.close();}
 }
 await picturelessPartsQuestionChecks();
}

/** No option image changes the existing dialog, never the actual parts backdrop's capabilities. */
async function picturelessPartsQuestionChecks(){
 for(const language of ['en','ko'] as const){
  const fixture=await recordScreenFixture('interview-picks','parts',undefined,undefined,false,false),out=join(output,'parts-no-question-image',language),ordinary=ordinaryParts.get(language);
  assert.ok(ordinary);await mkdir(out,{recursive:true});fixture.output(out);const before=await jobInputHashes(fixture.root);
  try{
   const metadata=await (await fetch(fixture.origin+fixture.display.routes.apiBase+'interview')).json() as {questions:{images:unknown[]}[]};assert.equal(metadata.questions[0]!.images.length,0);assert.ok(fixture.backdrop);
   await page!.setViewport(1440,900);await command!('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page!.goto('about:blank');await page!.goto(url.href);
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
   await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'839 no-image question ready over real parts');
   if(!await page!.evaluate(`!!document.querySelector('#job-record-asks[open]')`))await click(page!,'#workspace-pending-ask');
   await wait(`!!document.querySelector(${JSON.stringify('#job-record-asks[open] '+selector+' fieldset:not(:disabled)')})`,'839 normal Answer opens no-image native dialog');
   const dialogLayout=await page!.evaluate<any>(`(()=>{const dialog=document.querySelector('#job-record-asks[open]'),form=dialog?.querySelector(${JSON.stringify(selector)}),list=form?.querySelector('.interview-questions'),art=form?.querySelector('.interview-art'),fields=form?.querySelector('.interview-answer-fields'),context=fields?.querySelector('.interview-image-context'),code=context?.querySelector('code'),submit=fields?.querySelector('button[type=submit]'),status=form?.querySelector(':scope>[role=status]');if(!dialog||!form||!list||!art||!fields||!context||!code||!submit||!status)return null;const d=dialog.getBoundingClientRect(),l=list.getBoundingClientRect(),f=fields.getBoundingClientRect(),c=context.getBoundingClientRect(),s=submit.getBoundingClientRect(),st=status.getBoundingClientRect();return {width:d.width,height:d.height,left:d.left,right:d.right,artHidden:art.hidden,artRects:art.getClientRects().length,hasInterviewView:!!dialog.querySelector('.interview-view'),listBottom:l.bottom,fieldsTop:f.top,fieldsBottom:f.bottom,contextTop:c.top,contextBottom:c.bottom,submitTop:s.top,submitBottom:s.bottom,statusTop:st.top,codeText:code.textContent??'',contextVisible:context.getClientRects().length>0};})()`);
   assert.ok(dialogLayout&&dialogLayout.width>0&&dialogLayout.width<=760&&Math.abs((dialogLayout.left+dialogLayout.right)/2-720)<=2,'pictureless dialog uses centered 760 px single-frame width');
   assert.ok(dialogLayout.artHidden&&dialogLayout.artRects===0&&!dialogLayout.hasInterviewView&&dialogLayout.fieldsTop>=dialogLayout.listBottom-1&&dialogLayout.statusTop>=dialogLayout.fieldsBottom-1,'pictureless dialog stacks in one frame without an aside column or overlapping status row');
   assert.ok(dialogLayout.contextVisible&&dialogLayout.codeText.includes('.json · ')&&dialogLayout.submitTop>=dialogLayout.contextBottom-1,'bound-source line sits inside the single frame above submit');
   assert.equal(await page!.evaluate(`!!document.querySelector('#workspace-interview-answer[data-question-image-active]')`),false);await writeFile(join(out,'pending-native.png'),await page!.screenshot());
   await click(page!,'#job-record-asks .workspace-drawer-close');const pendingStrip=await stripState();comparePartsStrip(pendingStrip,ordinary.state,false);assert.equal(pendingStrip.actRowVisible,true);await writeFile(join(out,'pending.png'),await page!.screenshot());
   await selectBlock('selected-part');const awayStrip=await stripState();comparePartsStrip(awayStrip,ordinary.state,false);assert.equal(awayStrip.ordinaryPanelVisible,true);await writeFile(join(out,'away.png'),await page!.screenshot());
   await click(page!,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open]')`,'839 no-image native opener');
   await page!.evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});for(const value of ['topology_other','density_auto'])form.querySelector('input[value="'+value+'"]').click();const other=form.querySelector('textarea[name="other.topology"]');other.value=${JSON.stringify('  Custom topology · 직접 입력\n')};other.dispatchEvent(new Event('input',{bubbles:true}));form.querySelector('button[type=submit]').scrollIntoView({block:'center'});})()`);
   await click(page!,selector+' button[type=submit]');await wait(`!document.querySelector('#job-record-asks[open]')&&document.querySelector('#workspace-act-row').hidden&&document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'`,'839 no-image saved');
   const answeredStrip=await stripState();comparePartsStrip(answeredStrip,ordinary.state,false);assert.equal(answeredStrip.ordinaryPanelVisible,true);assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' fieldset')}).disabled`),true);
   const savedFooter:string=await page!.evaluate<string>(`document.getElementById('message').textContent`);
   assert.equal(savedFooter,await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'footer agrees with actual rendered saved header');
   const readbackCopy=await page!.evaluate(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')}).textContent`);assert.equal(readbackCopy,(language==='en'?enCatalog:koCatalog)['job.saved']);await writeFile(join(out,'answered.png'),await page!.screenshot());
   const bytes=await readFile(join(out,'one-screen.json'),'utf8'),act=parseRecordAct(JSON.parse(bytes));assert.equal(act.kind,'interview-picks');if(act.kind!=='interview-picks')throw Error('wrong act');assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
   const expected=prepareJobRecordAct({jobId:fixture.session.jobId,submission:{...fixture.submissions.at(-1)!,value:JSON.parse(baseline.expectedValueBytes)},ask:fixture.ask,retained:fixture.session.retainedSourceV3(fixture.ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z'});assert.equal(bytes,JSON.stringify(expected));assert.equal(sha(await readFile(new URL('../src/job-act.ts',import.meta.url))),baseline.writerSourceSha256);
   fixture.fake.events.push({type:'act',jobId:fixture.session.jobId,generation:fixture.display.publication.generation+2,cursor:String(fixture.fake.events.length+1),act});
   await page!.goto('about:blank');await page!.goto(url.href);await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#workspace-act-row').hidden`,'839 no-image saved reload');
   if(await page!.evaluate(`!!document.querySelector('#job-record-asks[open]')`))await click(page!,'#job-record-asks .workspace-drawer-close');
   const reloadStrip=await stripState();comparePartsStrip(reloadStrip,ordinary.state,false);assert.equal(reloadStrip.ordinaryPanelVisible,true);await writeFile(join(out,'reload.png'),await page!.screenshot());
   const observation={picture:'parts',questionImages:false,language,sourceHash:fixture.display.publication.source.sourceHash,ordinary,pendingStrip,awayStrip,answeredStrip,reloadStrip,readbackCopy,savedFooter,fullActByteEqual:true,bytes:bytes.length};cases.push(observation);await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2));console.log('839_NO_IMAGE_PARTS_PASS '+JSON.stringify(observation));
   assert.deepEqual(await jobInputHashes(fixture.root),before);
  }finally{await fixture.close();}
 }
}

/** Observer changes only the served test bundle, preserving the original error and fallback call. */
async function followupResources(root:string,identity:string){
 const original=await (await buildWeb('single',root)).text();
 const pattern=/refused:\s*\(?([\w$]+)\)?\s*=>\s*([\w$]+)\(\1,\s*["']JOB_STREAM_FAILED["']\)/g;
 assert.equal([...original.matchAll(pattern)].length,1,'one pre-fallback observation site');
 const instrumented=original.replace(pattern,(_match,errorName:string,reportName:string)=>`refused: (${errorName})=>{const chain=[];let item=${errorName};for(let i=0;item!=null&&i<5;i++,item=item.cause)chain.push({name:String(item.name??typeof item),message:String(item.message??item),stack:String(item.stack??'')});(globalThis.__839OriginalErrors??=[]).push({chain,at:performance.now(),ready:document.body.dataset.ready,dialogOpen:!!document.querySelector('#job-record-asks[open]')});${reportName}(${errorName},"JOB_STREAM_FAILED");}`);
 const sources:Record<string,string>={};for(const path of ['web/main.ts','web/job-session.ts','web/job-rig-screen.ts','web/interview-panel.ts','web/inspector-blocks.ts','src/job-front.ts','src/build.ts'])sources[path]=sha(await readFile(join(root,path)));
 await writeFile(join(output,identity+'-bundle.json'),JSON.stringify({identity,root,sources,originalBundleSha256:sha(original),observedBundleSha256:sha(instrumented),observer:'Before existing stream refused callback fallback; original Error/cause/stack and report call preserved; no source file mutation'},null,2));
 return async(name:'index.html'|'main.js'|'styles.css'):Promise<BodyInit>=>name==='main.js'?instrumented:await readFile(join(root,'web',name),'utf8');
}

/** Paired native-form route diagnosis and fresh-load geometry are independent results. */
async function followupQuestionChecks(){
 const mainRoot=process.env.RIG_REVIEW_839_MAIN_ROOT;assert.ok(mainRoot,'immutable main input supplied through nova-run --script');
 const variants=[{id:'main-38bb5f7',resource:await followupResources(mainRoot,'main-38bb5f7')},{id:'current-5011a1a',resource:await followupResources(resolve('.'),'current-5011a1a')}];
 const pairs:Record<string,any>[]=[],numeric:Record<string,any>[]=[];
 const snapshot=()=>page!.evaluate<any>(`({caught:globalThis.__839OriginalErrors??[],ready:document.body.dataset.ready,dialogOpen:!!document.querySelector('#job-record-asks[open]'),dialogConnected:!!document.querySelector('#job-record-asks')?.isConnected,partsWidth:document.querySelector('#parts-canvas')?.width,formReady:!!document.querySelector('form.interview-answer fieldset:not(:disabled)'),message:document.querySelector('#review-message')?.textContent,bodyText:document.body.innerText.slice(0,12000)})`);
 for(const variant of variants)for(const language of ['en','ko'] as const){
  const out=join(output,'no-image-pair',variant.id,language);await mkdir(out,{recursive:true});
  const fixture=await recordScreenFixture('interview-picks','parts',out,undefined,false,false,variant.resource),entry:Record<string,any>={variant:variant.id,language,sourceHash:fixture.display.publication.source.sourceHash,fixture:'Same retained parts backdrop and images-empty record path, including original event history'};
  try{
   const before=await jobInputHashes(fixture.root),metadata=await (await fetch(fixture.origin+fixture.display.routes.apiBase+'interview')).json() as {questions:{images:unknown[]}[]};assert.equal(metadata.questions[0]!.images.length,0);
   entry.events=fixture.fake.events;await page!.setViewport(1440,900);await command!('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`(globalThis.__839OriginalErrors?.length??0)>0||(document.body.dataset.ready==='true'&&!!document.querySelector('form.interview-answer fieldset:not(:disabled)'))`,'839 paired no-image original result');
   entry.initial=await snapshot();
   if(!entry.initial.caught.length){
    if(!entry.initial.dialogOpen)await click(page!,'#workspace-pending-ask');
    await wait(`(globalThis.__839OriginalErrors?.length??0)>0||!!document.querySelector('#job-record-asks[open] form.interview-answer fieldset:not(:disabled)')`,'839 paired native Answer action');
    entry.afterAnswer=await snapshot();
   }
   const state=entry.afterAnswer??entry.initial;entry.verdict=state.caught.length?'RED_ORIGINAL_REFUSAL':state.dialogOpen?'NATIVE_FORM_OPEN':'RED_NATIVE_FORM_ABSENT';
   entry.originalFailure=state.caught;entry.downstream=state.caught.length?'SKIP_NO_IMAGE_ACTS_ORIGINAL_REFUSAL':'native form reachable; answer/save follows';
   if(entry.verdict==='NATIVE_FORM_OPEN'){
    const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
    await page!.evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});for(const value of ['topology_other','density_auto'])form.querySelector('input[value="'+value+'"]').click();const other=form.querySelector('textarea[name="other.topology"]');other.value=${JSON.stringify('  Custom topology · 직접 입력\n')};other.dispatchEvent(new Event('input',{bubbles:true}));form.querySelector('button[type=submit]').scrollIntoView({block:'center'});})()`);await click(page!,selector+' button[type=submit]');
    await wait(`(globalThis.__839OriginalErrors?.length??0)>0||document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'`,'839 paired native save');entry.saved=await snapshot();
    if(entry.saved.caught.length){entry.verdict='RED_ORIGINAL_REFUSAL';entry.originalFailure=entry.saved.caught;}else{const act=parseRecordAct(JSON.parse(await readFile(join(out,'one-screen.json'),'utf8')));assert.equal(act.kind,'interview-picks');if(act.kind==='interview-picks')assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);entry.verdict='NATIVE_ANSWER_SAVED';}
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before);entry.sourceImmutable=true;
  }catch(error){entry.verdict='RED_TEST_OR_ROUTE';entry.error={message:String(error),stack:error instanceof Error?error.stack:null};entry.final=await snapshot().catch(()=>null);}
  finally{await writeFile(join(out,'screen.png'),await page!.screenshot()).catch(()=>{});await writeFile(join(out,'observation.json'),JSON.stringify(entry,null,2));pairs.push(entry);console.log('839_NO_IMAGE_PAIR '+JSON.stringify({variant:entry.variant,language,verdict:entry.verdict,originalFailure:entry.originalFailure,error:entry.error}));await page!.goto('about:blank');await fixture.close();}
 }
 await writeFile(join(output,'no-image-pair.json'),JSON.stringify(pairs,null,2));
 for(const picture of [true,'parts'] as const)for(const language of ['en','ko'] as const){
  const out=join(output,'fresh-900',picture==='parts'?'parts':'rig',language);await mkdir(out,{recursive:true});
  const fixture=await recordScreenFixture('interview-picks',picture,out,undefined,false,true,variants[1]!.resource),entry:Record<string,any>={picture:picture==='parts'?'parts':'rig',language,sourceHash:fixture.display.publication.source.sourceHash,width:900,height:900,dpr:2,navigation:'fresh about:blank then genuine pending owner URL at preconfigured width900; no post-navigation resize'};
  try{
   // Keep only the actual active ask for this independent geometry measurement.
   for(let i=fixture.fake.events.length-1;i>=0;i--)if(fixture.fake.events[i]!.type==='pending'&&(fixture.fake.events[i] as any).ask.askId==='historical-incompatible')fixture.fake.events.splice(i,1);
   const before=await jobInputHashes(fixture.root);await page!.setViewport(900,900);await command!('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:2,mobile:false});
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`(globalThis.__839OriginalErrors?.length??0)>0||(document.body.dataset.ready==='true'&&!!document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target=question][aria-selected=true]')&&document.querySelector('#reference-content img')?.naturalWidth===2)`,'839 fresh900 pending ready');
   entry.originalState=await snapshot();
   if(entry.originalState.caught.length)entry.verdict='RED_ORIGINAL_REFUSAL';
   else{
    await page!.evaluate(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    entry.geometry=await page!.evaluate<any>(`(()=>{const row=document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])'),strip=document.querySelector('.workspace-bottom-tabs'),tab=row.querySelector('[data-block-target=question][aria-selected=true]'),rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};},selected=rect(tab),activeRow=rect(row),stripRect=rect(strip),viewport={left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight},deltas=b=>({left:selected.left-b.left,right:b.right-selected.right,top:selected.top-b.top,bottom:b.bottom-selected.bottom}),inside=b=>{const d=deltas(b);return selected.width>0&&selected.height>0&&Object.values(d).every(v=>v>=-0.5);};return {selected,activeRow,strip:stripRect,viewport,deltas:{row:deltas(activeRow),strip:deltas(stripRect),viewport:deltas(viewport)},insideRow:inside(activeRow),insideStrip:inside(stripRect),insideViewport:inside(viewport),selectedId:tab.dataset.blockTarget,questionFirst:[...row.querySelectorAll(':scope>button[role=tab]')][0]?.dataset.blockTarget==='question',reportOverflow:!!row.querySelector('[data-block-target=report-panel][data-tab-overflow]'),documentWidth:document.documentElement.scrollWidth,deviceScaleFactor:devicePixelRatio};})()`);
    const g=entry.geometry;entry.verdict=g.viewport.width===900&&g.insideRow&&g.insideStrip&&g.insideViewport&&g.questionFirst&&(picture==='parts'||g.reportOverflow)?'FRESH_900_CONTAINED':'RED_FRESH_900_CLIPPED';
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before);entry.sourceImmutable=true;
  }catch(error){entry.verdict='RED_TEST_OR_ROUTE';entry.error={message:String(error),stack:error instanceof Error?error.stack:null};entry.final=await snapshot().catch(()=>null);}
  finally{await writeFile(join(out,'screen.png'),await page!.screenshot()).catch(()=>{});await writeFile(join(out,'geometry.json'),JSON.stringify(entry,null,2));numeric.push(entry);console.log('839_FRESH_900 '+JSON.stringify(entry));await page!.goto('about:blank');await fixture.close();}
 }
 await writeFile(join(output,'fresh-900.json'),JSON.stringify(numeric,null,2));
 const result={pairs:pairs.map(e=>({variant:e.variant,language:e.language,verdict:e.verdict})),numeric:numeric.map(e=>({picture:e.picture,language:e.language,verdict:e.verdict})),originalRefusals:pairs.filter(e=>e.verdict==='RED_ORIGINAL_REFUSAL').length,uncaughtExceptions:exceptions,passed:pairs.every(e=>e.verdict==='NATIVE_ANSWER_SAVED')&&numeric.every(e=>e.verdict==='FRESH_900_CONTAINED')&&exceptions.length===0};
 await writeFile(join(output,'followup-result.json'),JSON.stringify(result,null,2));console.log('839_FOLLOWUP_RESULT '+JSON.stringify(result));if(!result.passed)process.exitCode=1;
}

try{
 // Reuse the shared launcher's browser discovery and process policy without a suite-local wrapper.
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;if(event.method==='Fetch.requestPaused'){const id=event.params!.requestId as string;if(holdImages)pausedImages.push(id);else void send('Fetch.continueRequest',{requestId:id});}if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Fetch.enable',{patterns:[{urlPattern:'*/api/interview/image/*'}]});
 await command!('Network.enable');await command!('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__record750legacySeen=false;new MutationObserver(()=>{if(document.body?.classList.contains('job-window')||document.querySelector('[data-job-forms]'))globalThis.__record750legacySeen=true;}).observe(document,{subtree:true,childList:true,attributes:true});`});
 if(followup839){holdImages=false;await followupQuestionChecks();}else{
 if(completedPicture){holdImages=false;await questionTabChecks();}
 if(!completedPicture){
 for(const [width,height] of (interviewOnly?[[1600,1000],[1440,900]]:[[1600,1000]])){
 await page.setViewport(width!,height!);
 for(const kind of ['interview-picks'] as RecordScreenKind[])for(const picture of [false] as readonly (boolean|'parts')[]){
  const fixture=await recordScreenFixture(kind,picture,undefined,undefined,freshParts);const before=await jobInputHashes(fixture.root);
  try{
   for(const language of ['en','ko'] as const){
    const out=join(output,width+'x'+height,kind,picture==='parts'?'parts':picture?'picture':'empty',language);await mkdir(out,{recursive:true});fixture.output(out);
    const observation:Record<string,unknown>={kind,picture,language,width,height,sourceHash:fixture.display.publication.source.sourceHash,readerPhases:fixture.reader.calls.map(call=>call.phase),fixture:'synthetic trusted-host record reader and deterministic act writer'};
    for(const mode of ['one-screen']){
     fixture.mode(mode);const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);holdImages=true;await command!('Page.navigate',{url:url.href});
     const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
     await wait(`!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,kind+'/'+mode+'/receipt');
     if(mode==='one-screen'){
      if(!await page.evaluate(`!!document.querySelector('#job-record-asks[open]')`))await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('dialog[open] '+${JSON.stringify(selector)})`,kind+'/dialog');
      if(picture||freshParts)await wait(`!!document.querySelector('#rig-root canvas')`,kind+'/picture');
      const state:any=await page.evaluate<any>(`(()=>{const dialog=document.querySelector('dialog[open]'),form=document.querySelector(${JSON.stringify(selector)}),box=dialog.getBoundingClientRect();return {language:document.documentElement.lang,width:innerWidth,height:innerHeight,legacySeen:globalThis.__record750legacySeen,legacyForms:document.querySelectorAll('[data-job-forms]').length,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,formInsideNativeDialog:!!form.closest('dialog[open]'),focusContained:dialog.contains(document.activeElement),dialogRect:{x:box.x,y:box.y,width:box.width,height:box.height},noPicture:document.getElementById('rig-empty').textContent,backgroundStatus:document.getElementById('message')?.textContent??'',emptyListText:document.querySelector('[data-part-list]')?.textContent??'',saveState:document.getElementById('dirty').textContent,controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>node.id)};})()`);
      assert.equal(state.language,language);assert.equal(state.width,width);assert.equal(state.height,height);assert.equal(state.legacySeen,false);assert.equal(state.legacyForms,0);assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.formInsideNativeDialog,true);assert.equal(state.focusContained,true);
      assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
      if(!picture&&!freshParts){assert.equal(state.noPicture,(language==='en'?enCatalog:koCatalog)['This request has no picture.']);assert.equal(state.backgroundStatus,state.noPicture);assert.equal(state.emptyListText,'');assert.equal(state.saveState,(language==='en'?enCatalog:koCatalog)['Not submitted']);}
      assert.ok(state.dialogRect.x>=0&&state.dialogRect.y>=0&&state.dialogRect.x+state.dialogRect.width<=width!&&state.dialogRect.y+state.dialogRect.height<=height!);
      if(freshParts){await wait(`document.getElementById('renderer-state')?.textContent===${JSON.stringify((language==='en'?enCatalog:koCatalog)['Parts raster drawn · Canvas2D'])}`,'bound parts raster drawn');assert.notEqual(state.noPicture,(language==='en'?enCatalog:koCatalog)['This request has no picture.']);assert.equal(fixture.display.publication.previousPublicationId,null);await wait(`document.querySelectorAll('[data-part-list] button').length>0`,'fresh parts list');}
      if(!freshParts){
      // Hold the option request to prove loading is no longer a screen-readiness gate.
      const loading:any=await page.evaluate(`(()=>{const viewport=document.querySelector(${JSON.stringify(selector+' .interview-viewport')}),canvas=viewport.querySelector('canvas');return {rect:viewport.getBoundingClientRect().toJSON(),width:canvas.width,height:canvas.height,pixel:[...canvas.getContext('2d').getImageData(0,0,1,1).data]};})()`);
      assert.deepEqual(loading.pixel,[0,0,0,0]);assert.equal(loading.width,300);assert.equal(loading.height,150);
      assert.ok(pausedImages.length>0,'option request held while the drawer is usable');
      await writeFile(join(out,'option-loading.png'),await page.screenshot());
      holdImages=false;for(const requestId of pausedImages.splice(0))await command!('Fetch.continueRequest',{requestId});
      await wait(`document.querySelector(${JSON.stringify(selector+' .interview-viewport canvas')})?.width===2`,'option loaded');
      const loadedRect:any=await page.evaluate(`document.querySelector(${JSON.stringify(selector+' .interview-viewport')}).getBoundingClientRect().toJSON()`);
      assert.deepEqual(loadedRect,loading.rect,'option load does not move or resize its viewport');
      observation.imageLoading={...loading,loadedRect};
      }
      observation.screen=state;
      await click(page,'dialog[open] .workspace-drawer-close');assert.equal(await page.evaluate(`document.activeElement.id==='workspace-pending-ask'&&document.getElementById('workspace-pending-ask').getAttribute('aria-expanded')==='false'`),true,'shared drawer returns focus to the existing act button');await writeFile(join(out,'backdrop.png'),await page.screenshot());
      await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('dialog[open]')`,'reopen-modal');
     }
     if(kind==='interview-picks'){
      if(!freshParts){
      // #813 visit every bound option image through the existing interview view switch.
      const imageCount = fixture.session.retainedSourceV3(fixture.ask.publicationId).questions
       .find(question => question.set.id === fixture.ask.source.optionSet?.id)!.images.length;
      assert.ok(imageCount > 0);
      assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector+' .interview-view [data-view]')}).length`), imageCount);
      for (let index = 0; index < imageCount; index++) {
       await page.evaluate(`document.querySelector(${JSON.stringify(selector+' .interview-view')}+' [data-view="'+${index}+'"]').click()`);
       await wait(`(()=>{const canvas=document.querySelector(${JSON.stringify(selector+' .interview-viewport canvas')});return canvas?.width===2&&canvas.height===2&&canvas.getContext('2d').getImageData(0,0,1,1).data[3]===255;})()`, '813 option image '+index);
       await writeFile(join(out,'option-image-'+index+'.png'),await page.screenshot());
      }
      observation.optionImagesShown=imageCount;
      }
      const draft=JSON.stringify({other:'  Custom topology · 직접 입력\n'});
      await page.evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)}),draft=${draft};for(const value of ['topology_other','density_auto'])form.querySelector('input[type=radio][value="'+value+'"]').click();const other=form.querySelector('textarea[name="other.topology"]');other.value=draft.other;other.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      const identities:unknown=await page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector+' input[type=radio]')}),input=>({name:input.name,value:input.value}))`);
      await page.goto(url.href);await wait(`!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,'interview draft reopen');
      const reopened:any=await page.evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});return {identities:[...form.querySelectorAll('input[type=radio]')].map(input=>({name:input.name,value:input.value})),checked:[...form.querySelectorAll('input:checked')].map(input=>input.value),other:form.querySelector('textarea[name="other.topology"]').value,note:form.querySelector('textarea[name="note"]')?.value??null,otherVisible:!form.querySelector('textarea[name="other.topology"]').hidden,selects:form.querySelectorAll('select').length,recommended:form.querySelectorAll('.interview-recommended').length,delegates:form.querySelectorAll('.interview-delegate').length,viewports:form.querySelectorAll('.interview-viewport').length,bottom:!!form.querySelector('.interview-bottom-resize[role=separator]')};})()`);
      assert.deepEqual(reopened.identities,identities);assert.deepEqual(reopened.checked,['topology_other','density_auto']);assert.equal(reopened.other,'  Custom topology · 직접 입력\n');assert.equal(reopened.note,null);assert.equal(reopened.otherVisible,true);assert.equal(reopened.selects,0);assert.equal(reopened.recommended,2);assert.equal(reopened.delegates,2);if(!freshParts){assert.equal(reopened.viewports,1);assert.equal(reopened.bottom,true);}else{assert.equal(reopened.viewports,0);assert.deepEqual(reopened.checked,['topology_other','density_auto']);}observation.reopened=reopened;
      if(!freshParts){
      const layout:any=await page.evaluate<any>(`(()=>{
       const form=document.querySelector(${JSON.stringify(selector)}),dialog=form.closest('dialog'),survey=form.querySelector('.interview-answer-fields'),art=form.querySelector('.interview-art'),list=form.querySelector('.interview-questions');
       const visible=node=>{const r=node.getBoundingClientRect();if(r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return false;for(let parent=node.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent),box=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<box.top-1||r.bottom>box.bottom+1))return false;if(parent===dialog)break;}return true;};
       const targets=[...survey.querySelectorAll('.interview-option,.interview-recommended,.interview-option span,.interview-delegate,textarea:not([hidden]),legend,button[type=submit]')];
       const ancestors=[];for(let parent=survey;parent;parent=parent.parentElement){ancestors.push({tag:parent.tagName,scrollHeight:parent.scrollHeight,clientHeight:parent.clientHeight});if(parent===dialog)break;}
       return {list:list.getBoundingClientRect().toJSON(),art:art.getBoundingClientRect().toJSON(),survey:survey.getBoundingClientRect().toJSON(),progress:list.querySelector('p').textContent,questions:list.querySelectorAll('.interview-question').length,optionCount:survey.querySelectorAll('.interview-option').length,allVisible:targets.every(visible),targets:targets.map(node=>({text:node.textContent||node.value,visible:visible(node),rect:node.getBoundingClientRect().toJSON()})),ancestors,noteInputs:form.querySelectorAll('textarea[name=note]').length};
      })()`);
      assert.equal(layout.questions,1,'question list represents the source question/set, with both asks kept in one survey');assert.equal(layout.progress,(language==='en'?enCatalog:koCatalog)['interview.answered'].replace('{0}','0').replace('{1}','1'));assert.equal(layout.optionCount,8);assert.equal(layout.noteInputs,0);assert.ok(layout.art.x>=layout.list.right-1&&layout.survey.x>=layout.art.right-1,'approved list | image | survey columns');assert.equal(layout.allVisible,true,JSON.stringify(layout));assert.ok(layout.ancestors.every((node:any)=>node.scrollHeight<=node.clientHeight+1),'no survey ancestor scrolling: '+JSON.stringify(layout.ancestors));observation.layout=layout;
      const separatorSelector=selector+' .interview-bottom-resize';
      const resize:any=await page.evaluate<any>(`(()=>{const separator=document.querySelector(${JSON.stringify(separatorSelector)}),before=Number(separator.getAttribute('aria-valuenow'));separator.focus();separator.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true}));return {before,after:Number(separator.getAttribute('aria-valuenow'))};})()`);assert.ok(resize.after>resize.before);observation.resized=resize;
      await click(page,selector+' .zoom-controls>button:nth-child(1)');await click(page,selector+' .zoom-controls>button:nth-child(4)');await click(page,selector+' .zoom-controls>button:nth-child(3)');
      await writeFile(join(out,'radio-cards.png'),await page.screenshot());
      }
      // Auto was restored by its original ID above. Submit that existing option, never a fabricated Delegate act.
     }
     const values=kind==='interview-picks'?await page.evaluate<any>(`[...document.querySelectorAll(${JSON.stringify(selector+' input:checked,'+selector+' textarea')})].map(input=>({name:input.name,value:input.value}))`):await page.evaluate<any>(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});const note=form.querySelector('textarea[name="note"]');note.value='  Same reviewer words · 원문\\n';for(const select of form.querySelectorAll('select')){select.value=select.name==='outcome'?'pass':select.name==='choice.topology'?'topology_other':select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));}const other=form.querySelector('textarea[name="other.topology"]');if(other)other.value='  Custom topology · 직접 입력\\n';form.dispatchEvent(new Event('input',{bubbles:true}));return [...form.querySelectorAll('input[name],textarea[name],select[name]')].map(node=>({name:node.name,value:node.value}));})()`);
     observation[mode+'Controls']=values;
     await page.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type="submit"]')}).scrollIntoView({block:'center'});`);
     await writeFile(join(out,mode+'-answered.png'),await page.screenshot());
     assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),false,'pending interview submit remains visible');
     await click(page,selector+' button[type="submit"]');
     const path=join(out,mode+'.json');await wait(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')})?.textContent===${JSON.stringify((language==='en'?enCatalog:koCatalog)['job.saved'])}`,kind+'/'+mode+'/saved');
     if(kind==='interview-picks'){assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),true,'saved interview submit hidden');const footer:string=await page.evaluate<string>(`document.getElementById('message').textContent`);assert.equal(footer,await page.evaluate<string>(`document.getElementById('dirty').textContent`),'interview-only footer equals actual rendered saved header');observation.savedFooter=footer;}
     if(kind==='interview-picks')assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(selector+' .interview-questions>p')}).textContent`),(language==='en'?enCatalog:koCatalog)['interview.answered'].replace('{0}','1').replace('{1}','1'),'progress counts the saved question, not individual asks or an unsent draft');
     assert.ok(existsSync(path),'writer actually persisted '+mode);const act=parseRecordAct(JSON.parse(await readFile(path,'utf8')));
     assert.equal(act.at,'2026-11-08T12:00:00.000Z');
     if(act.kind==='interview-picks'){assert.equal(act.value.note,'');assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
      const expectedAct=prepareJobRecordAct({jobId:fixture.session.jobId,submission:{...fixture.submissions.at(-1)!,value:JSON.parse(baseline.expectedValueBytes)},ask:fixture.ask,retained:fixture.session.retainedSourceV3(fixture.ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z'});assert.equal(sha(await readFile(new URL('../src/job-act.ts',import.meta.url))),baseline.writerSourceSha256);assert.equal(await readFile(path,'utf8'),JSON.stringify(expectedAct),'full empty-note act bytes equal 60d7f17 serializer/writer control');observation.emptyNoteByteControl={sourceCommit:baseline.sourceCommit,valueBytes:baseline.expectedValueBytes,fullActByteEqual:true};assert.deepEqual(act.value.selections,[{itemId:'topology',optionId:'topology_other',otherText:'  Custom topology · 직접 입력\n'},{itemId:'detail_level',optionId:'density_auto',otherText:null}]);}
     else{assert.equal(act.value.words,'  Same reviewer words · 원문\n');if(act.kind==='checkpoint')assert.equal(act.value.outcome,'pass');if(act.kind==='signoff')assert.equal(act.value.decision,'approved');}
     await writeFile(join(out,mode+'-submitted.png'),await page.screenshot());
     await page.goto('about:blank');
    }
    const one=await readFile(join(out,'one-screen.json'));observation.persistedAct={bytes:one.length,oneScreenSha256:sha(one),oneScreenFile:join(out,'one-screen.json')};
    await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');cases.push(observation);
    console.log('750_BROWSER_CASE_PASS '+kind+' '+(picture==='parts'?'parts':picture?'picture':'empty')+' '+language+' bytes='+(observation.persistedAct as {bytes:number}).bytes);
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before,'inspected source files remain immutable');
  }finally{await fixture.close();}
 }
 }
 }
 assert.equal(exceptions.length,0,'no browser exceptions');
 assert.ok(mutations.every(request=>/\/ui\/(?:displayed|acts)$/.test(request.path)),'no backdrop mutation requests');
 const result={cases:cases.length,persistedActs:cases.length,persistedByteComparisons:completedPicture?6:0,askKinds:1,languages:['en','ko'],backdrops:completedPicture?['rig','parts','parts-no-question-image']:freshParts?['bound-parts']:['empty'],viewports:completedPicture?(narrowQuestionResize?[[1440,900],[900,900]]:[[1440,900]]):interviewOnly?[[1600,1000],[1440,900]]:[[1600,1000]],...(completedPicture?{dpr:2}:{}),exceptions,mutations,browserWorkers:'shared launchCdpSession defaults'};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('750_BROWSER_PASS '+JSON.stringify(result));
 }
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,completedCases:cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
