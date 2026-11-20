/** #750/#986 ordinary Nova browser checks for the shared Question panel and main viewport.
 * The live-job fixture uses retained record reader/writer doubles and public synthetic assets.
 * --serve starts a loopback fixture for interactive review without launching Chromium. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE,SYNTHETIC_RIG_RGB} from './helpers/job-record-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {planMockProxy,PLAN_1004_TEXT} from './helpers/plan-1004-mock.ts';
import {interviewPicksRecord} from '../web/interview-panel.ts';
import {parseOpenInputs} from '../src/cli.ts';
import {prepareOpenTarget} from '../src/open.ts';
import {startOpenWorkspace} from '../src/open-workspace.ts';
import {readProject} from '../src/interview-project.ts';
import {targetCapability} from '../src/open-workspace-state.ts';
import {WORKSPACE_SCHEMA,type WorkspaceList} from '../src/open-workspace-contract.ts';
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
const postQuestionPictures=Bun.argv.includes('--post-question-pictures');
const boundRigPictureOnly=Bun.argv.includes('--bound-rig-picture');
const workspace986=Bun.argv.includes('--workspace-986');
const questionRoot='#workspace-interview-answer';
const questionTab='[data-block-target=question][aria-selected=true]';
const sharedControls=['zoom-in','zoom-out','fit','native-one','view-menu'];
const controlSelector=sharedControls.map(id=>'#'+id).join(',');
const dialogViewer='canvas,video,.viewport,.interview-view,.interview-viewport,.view-zoom,.zoom-controls,'+controlSelector;
const paintingSelector='#reference-content img';
const otherText='  Custom topology · 직접 입력\n';
type Rect={x:number;y:number;width:number;height:number;left:number;top:number;right:number;bottom:number};
const baseline=await Bun.file(new URL('./fixtures/interview-722-empty-note.json',import.meta.url)).json();
async function assertLastAskPickKeepsScrollAndFocus(mode:string){
 const scrollBefore=await page!.evaluate<number>(`(()=>{
  const form=document.querySelector('form[data-job-ask="ask-interview-picks"]');
  const panel=form.closest('#workspace-interview-answer');
  const firstOption=form.querySelector('fieldset.interview-ask:last-of-type label.interview-option');
  const pr=panel.getBoundingClientRect(),or=firstOption.getBoundingClientRect();
  panel.scrollTop=Math.max(0,Math.min(panel.scrollHeight-panel.clientHeight,panel.scrollTop+(or.top-pr.top)-4));
  return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(panel.scrollTop))));
 })()`);
 assert.ok(scrollBefore>0,`#875 ${mode} panel scrolls before changing pick`);
 await click(page!,'form[data-job-ask="ask-interview-picks"] label.interview-option:has(input[value="cloth_sim_other"])');
 await page!.evaluate<void>(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 const afterOther=await page!.evaluate<{scrollTop:number;active:boolean}>(`(()=>{
  const form=document.querySelector('form[data-job-ask="ask-interview-picks"]');
  const panel=form.closest('#workspace-interview-answer');
  const other=form.querySelector('input[type=radio][name="choice.cloth_sim"][value="cloth_sim_other"]');
  return {scrollTop:panel.scrollTop,active:document.activeElement===other};
 })()`);
 assert.equal(afterOther.scrollTop,scrollBefore,`#875 ${mode} scrollTop unchanged after picking other in last ask`);
 assert.equal(afterOther.active,true,`#875 ${mode} document.activeElement unchanged after picking other in last ask`);
 await click(page!,'form[data-job-ask="ask-interview-picks"] label.interview-option:has(input[value="cloth_baked"])');
 await page!.evaluate<void>(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 const afterBaked=await page!.evaluate<{scrollHeight:number;clientHeight:number;scrollTop:number;active:boolean}>(`(()=>{
  const form=document.querySelector('form[data-job-ask="ask-interview-picks"]');
  const panel=form.closest('#workspace-interview-answer');
  const baked=form.querySelector('input[type=radio][name="choice.cloth_sim"][value="cloth_baked"]');
  return {scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight,scrollTop:panel.scrollTop,active:document.activeElement===baked};
 })()`);
 assert.equal(afterBaked.scrollTop,scrollBefore,`#875 ${mode} scrollTop unchanged after changing pick in last ask`);
 assert.equal(afterBaked.active,true,`#875 ${mode} document.activeElement unchanged after changing pick in last ask`);
}
async function longInterviewScrollChecks(picturedBackdrop:boolean){
 for(const language of ['en','ko'] as const){
  for(const questionImages of picturedBackdrop?[true]:[true,false]){
   const fixture=await recordScreenFixture('interview-picks',picturedBackdrop,undefined,undefined,false,questionImages,undefined,true);
   try{
    const before=await jobInputHashes(fixture.root),url=fixtureUrl(fixture.ownerUrl,language);
    await page!.setViewport(1440,900);
    await page!.goto('about:blank');await page!.goto(url);
    await waitForQuestion(`form[data-job-ask="${fixture.ask.askId}"]`);
    if(questionImages)await readPainting(2);
    await assertLastAskPickKeepsScrollAndFocus(questionImages?'pictured question':'pictureless question');
    assert.deepEqual(await jobInputHashes(fixture.root),before);
   }finally{await page!.goto('about:blank');await fixture.close();}
  }
 }
}
const output=resolve(arg('--out')??'artifacts/record-screen-750');await mkdir(output,{recursive:true});
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
// Pin the 60d7f17 record writer and its local dependencies without the package verdict writer.
const writerSource=await readFile(new URL('../src/job-act.ts',import.meta.url),'utf8');
const recordWriterRanges=[
 ['function words(', "/** The writer's output must decode"],
 ['function choice<', 'function requirePlan('],
 ['export function bindJobRecordAsk(', 'export function bindJobAsk(subject: JobSubject, retained: JobRetainedSource): JobSourceBinding;'],
 ['function actObject<', '/** Only the authenticated UI host invokes this adapter.'],
] as const;
const recordWriterSource=recordWriterRanges.map(([startAnchor,endAnchor])=>{
 const start=writerSource.indexOf(startAnchor);
 const end=writerSource.indexOf(endAnchor);
 assert.ok(start>=0,`RECORD_WRITER_PIN_START_ANCHOR_MISSING: ${startAnchor}`);
 assert.ok(end>=0,`RECORD_WRITER_PIN_END_ANCHOR_MISSING: ${endAnchor}`);
 assert.ok(end>start,`RECORD_WRITER_PIN_EMPTY_SECTION: ${startAnchor}`);
 return writerSource.slice(start,end);
}).join('');
const recordWriterDefinitions=['words','choice','bindJobRecordAsk','actObject','actIdField','prepareJobRecordAct'];
for(const name of recordWriterDefinitions){
 assert.match(recordWriterSource,new RegExp(`^(?:export )?function ${name}(?:<|[(])`,'m'),
  `RECORD_WRITER_PIN_DEFINITION_MISSING: ${name}`);
}
assert.equal(sha(recordWriterSource),baseline.recordWriterSourceSha256,'RECORD_WRITER_PIN_SHA256_MISMATCH');
function fixtureUrl(ownerUrl:string,language:string){
 const url=new URL(ownerUrl);
 url.searchParams.set('lang',language);
 return url.href;
}

async function joinedFixture(plan?:{answered:number}){
 const fixture=await interviewOpenFixture(plan?4:1);
 let host:Awaited<ReturnType<typeof startOpenWorkspace>>|undefined,proxy:ReturnType<typeof planMockProxy>|undefined;
 try{
  // Extend the public fixture with a visibly different second painting for a real menu switch.
  if(!plan){const optionPath=join(fixture.root,'evidence/options.json');
  type ImageRef={path:string;sha256:string};
  const options=JSON.parse(await readFile(optionPath,'utf8')) as {context:{files:ImageRef[]}};
  const project=fixture.project as {inputs:ImageRef[];interview:{framing:{pending_options:ImageRef}[]}};
  const alternate='<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><path fill="#e89220" d="M0 0h480v240H0z"/><circle cx="240" cy="120" r="80" fill="#254c88"/></svg>';
  const ref={path:'alternate.svg',sha256:sha(alternate)};
  await writeFile(join(fixture.root,ref.path),alternate);
  options.context.files.push(ref);
  project.inputs.push(ref);
  const bytes=JSON.stringify(options);
  await writeFile(optionPath,bytes);
  project.interview.framing[0]!.pending_options.sha256=sha(bytes);
  await writeFile(join(fixture.root,'project.json'),JSON.stringify(project));}
  const inputs=parseOpenInputs([fixture.root,'--project',fixture.root,'--picks-dir','picks']);
  const prepared=await prepareOpenTarget(inputs,{stateDir:fixture.stateDir});
  host=await startOpenWorkspace({stateDir:fixture.stateDir,fingerprint:prepared.fingerprint,port:0});
  const {record}=host;
  const registered=await fetch(record.origin+'/workspace/api/register',{method:'POST',
   headers:{Authorization:'Bearer '+record.registrationCapability,'Content-Type':'application/json'},
   body:JSON.stringify({schema:WORKSPACE_SCHEMA,incarnation:record.incarnation,
    targets:[{key:prepared.key,contentHash:prepared.package.contentHash,cwd:prepared.cwd,viewOnly:false,inputs:prepared.package.inputs}]})});
  assert.equal(registered.status,200);
  const list=await (await fetch(record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':record.ownerCapability}})).json() as WorkspaceList;
  assert.equal(list.targets.length,1);
  const url=new URL(list.targets[0]!.entry,record.origin);
  url.hash='cap='+targetCapability(record.ownerCapability,record.incarnation,prepared.key);
  const running=host;
  if(plan){
   // #1004 plan: "answered" questions are saved through the real picks route, as a reviewer's per-question answer.
   const base=record.origin+'/instances/'+prepared.key,capability=targetCapability(record.ownerCapability,record.incarnation,prepared.key);
   for(const question of readProject(fixture.root).questions.slice(0,plan.answered)){
    const picks=question.set.asks.map(item=>({ask:item.id,option_id:item.options.find(option=>option.recommended)!.id}));
    const saved=await fetch(base+'/api/interview/picks',{method:'POST',headers:{Origin:record.origin,'Content-Type':'application/json','X-Review-Capability':capability},
     body:JSON.stringify(interviewPicksRecord(question.ref,picks,undefined,'2026-11-20T00:00:00.000Z'))});
    assert.equal(saved.status,200,await saved.text());
   }
   proxy=planMockProxy(record.origin,{en:enCatalog['Submit review']!,ko:koCatalog['Submit review']!});
   const mocked=proxy;
   return {root:fixture.root,ownerUrl:mocked.rewrite(url.href),async close(){try{mocked.stop();await running.stop();}finally{await fixture.close();}}};
  }
  return {root:fixture.root,ownerUrl:url.href,async close(){try{await running.stop();}finally{await fixture.close();}}};
 }catch(error){
  try{proxy?.stop();await host?.stop();}finally{await fixture.close();}
  throw error;
 }
}

if(Bun.argv.includes('--serve')){
 const language=arg('--lang')??'en';
 assert.ok(language==='en'||language==='ko','--lang must be en or ko');
 const kind=arg('--fixture')??'live';
 assert.ok(kind==='live'||kind==='joined'||kind==='joined-plan-1004'||kind==='pictureless','--fixture must be live, joined, joined-plan-1004 or pictureless');
 const answered=Number(arg('--answered')??'0');
 assert.ok(kind!=='joined-plan-1004'||[0,2,4].includes(answered),'--answered must be 0, 2 or 4');
 const fixture=kind==='joined-plan-1004'?await joinedFixture({answered}):kind==='joined'?await joinedFixture():await recordScreenFixture('interview-picks',false,output,undefined,false,kind==='live');
 try{
  console.log(fixtureUrl(fixture.ownerUrl,language));
  await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 }finally{await fixture.close();}
 process.exit(0);
}

const profile=await mkdtemp(join(tmpdir(),'review-750-browser-'));
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
let holdImages=false;const pausedImages:string[]=[];
const consoleErrors:unknown[]=[];
const exceptions:unknown[]=[],mutations:{method:string;path:string}[]=[],cases:unknown[]=[];
let persistedActs=0;
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('750_BROWSER_TIMEOUT '+label);}

async function waitForQuestion(form:string,answered=false){
 const selector=questionRoot+' '+form+(answered?'[data-interview-answered=true] fieldset:disabled':' fieldset:not(:disabled)');
 await wait(`document.body.dataset.ready==='true'&&!!document.querySelector(${JSON.stringify(selector)})&&document.querySelector(${JSON.stringify(questionTab)})?.getClientRects().length>0`,
  '986 Question selected with '+(answered?'saved':'editable')+' form');
}
async function assertNoDialogViewer(){
 const contents=await page!.evaluate<{id:string;open:boolean;modal:boolean;viewers:number}[]>(`[...document.querySelectorAll('dialog')].map(dialog=>({
  id:dialog.id,open:dialog.open,modal:dialog.matches(':modal'),viewers:dialog.querySelectorAll(${JSON.stringify(dialogViewer)}).length
 }))`);
 assert.ok(contents.every(dialog=>dialog.viewers===0),JSON.stringify(contents));
 return contents;
}
type Painting={src:string;width:number;height:number;visible:boolean;rect:Rect;scale:number;mode:string|null};
const paintingState=()=>page!.evaluate<Painting>(`(()=>{
 const image=document.querySelector('${paintingSelector}'),content=document.querySelector('#reference-content');
 return {src:image.currentSrc,width:image.naturalWidth,height:image.naturalHeight,
  visible:!!image.getClientRects().length&&getComputedStyle(image).visibility==='visible'&&!document.querySelector('#reference-pane').hidden,
  rect:image.getBoundingClientRect().toJSON(),scale:new DOMMatrix(getComputedStyle(content).transform).a,
  mode:document.querySelector('#view-menu [data-view][aria-pressed=true]')?.dataset.view??null};
})()`);
async function readPainting(width:number,index=0){
 await wait(`document.querySelector('${paintingSelector}')?.naturalWidth===${width}&&
  !!document.querySelector('#view-menu [data-view="interview-image-${index}"][aria-pressed=true]')&&
  document.querySelector('${paintingSelector}').getBoundingClientRect().width>0`,'986 shared image '+index);
 const state=await paintingState();
 assert.ok(state.visible&&state.rect.height>0&&state.scale>0,JSON.stringify(state));
 return state;
}
async function selectInterviewImage(index:number){
 await click(page!,'#view-menu summary');
 await click(page!,`#view-menu [data-view="interview-image-${index}"]`);
}
async function sharedCameraChecks(){
 assert.deepEqual(await page!.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(controlSelector)})].map(control=>control.id)`),sharedControls);
 await click(page!,'#fit');
 const initialFit=await paintingState();
 await click(page!,'#native-one');
 const native=await paintingState();assert.ok(Math.abs(native.scale-1)<0.001,JSON.stringify(native));
 await click(page!,'#zoom-in');
 const enlarged=await paintingState();assert.ok(enlarged.rect.width>native.rect.width,JSON.stringify(enlarged));
 await click(page!,'#zoom-out');
 const reduced=await paintingState();assert.ok(Math.abs(reduced.scale-native.scale)<0.001,JSON.stringify(reduced));
 await click(page!,'#fit');
 const fit=await paintingState();assert.ok(Math.abs(fit.scale-initialFit.scale)<0.001,JSON.stringify({initialFit,fit}));
 return {native,enlarged,reduced,fit};
}
async function clickFormControl(selector:string){
 await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
 await click(page!,selector);
}
async function answerInterview(form:string,note?:string){
 for(const value of ['topology_other','density_auto'])await clickFormControl(form+` label.interview-option:has(input[value="${value}"])`);
 await clickFormControl(form+' textarea[name="other.topology"]');
 await command!('Input.insertText',{text:otherText});
 if(note!==undefined){
  await clickFormControl(form+' textarea[name="note"]');
  await command!('Input.insertText',{text:note});
 }
}
type RememberedPainting={state:Painting;personSelectSame:boolean;nodeSame:boolean};
async function rememberPainting(){
 await page!.evaluate<void>(`(()=>{globalThis.__986Painting=document.querySelector('${paintingSelector}');globalThis.__986PersonSelect=document.querySelector('#person-select');})()`);
 return paintingState();
}
async function assertPaintingPersists(previous:Painting){
 const state=await paintingState();
 const identity=await page!.evaluate<Omit<RememberedPainting,'state'>>(`({
  nodeSame:document.querySelector('${paintingSelector}')===globalThis.__986Painting,
  personSelectSame:document.querySelector('#person-select')===globalThis.__986PersonSelect
 })`);
 assert.deepEqual(identity,{nodeSame:true,personSelectSame:true});
 assert.ok(state.visible&&state.rect.width>0&&state.rect.height>0);
 assert.equal(state.src,previous.src);
 assert.equal(state.mode,previous.mode);
 return {...identity,state};
}
type StripState={tabs:{id:string;text:string;disabled:boolean}[];selected:string|null;selectedVisible:boolean;questionFirst:boolean;reportOverflow:boolean;actRowVisible:boolean;ordinaryPanelVisible:boolean};
const stripState=()=>page!.evaluate<StripState>(`(()=>{const row=document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])'),visible=n=>!!n&&!n.hidden&&n.getClientRects().length>0&&getComputedStyle(n).display!=='none';const buttons=[...row.querySelectorAll(':scope>button[role=tab]')],selected=row.querySelector('[aria-selected=true]');return {tabs:buttons.filter(visible).map(n=>({id:n.dataset.blockTarget,text:n.textContent,disabled:n.disabled})),selected:selected?.dataset.blockTarget??null,selectedVisible:visible(selected),questionFirst:buttons[0]?.dataset.blockTarget==='question',reportOverflow:!!row.querySelector('[data-block-target=report-panel][data-tab-overflow]'),actRowVisible:visible(document.querySelector('#workspace-act-row')),ordinaryPanelVisible:visible(document.querySelector('#selected-part'))};})()`);
async function selectBlock(target:string){
 if(target==='feedback'){
  await click(page!,'#stage-comment');
  await wait("!!document.querySelector('#inspector-feedback:not([hidden])')&&document.querySelector('#workspace-interview-answer').hidden",'986 Comments active');
  return;
 }
 const selector=`.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target="${target}"]`;
 if(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('data-tab-overflow')`)){
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
   const originalTabs=await tabs();
   fixture.fake.pending(fixture.ask,fixture.display.publication.generation+1);
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
   await waitForQuestion(selector);
   const eventPainting=await readPainting(2);
   await rememberPainting();
   assert.equal(await page!.evaluate<number>('devicePixelRatio'),2);assert.equal(await page!.evaluate<number>('innerWidth'),1440);
   assert.equal(await page!.evaluate<string>(`document.querySelector('${questionTab}').textContent`),(language==='en'?enCatalog:koCatalog)['Question']);
   const eventArrivalStrip=await stripState();assert.equal(eventArrivalStrip.tabs[0]!.id,'question');assert.deepEqual(eventArrivalStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs and enabled states retained');
   if(ordinary)comparePartsStrip(eventArrivalStrip,ordinary.state,true);
   assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
   await writeFile(join(out,'event-arrival.png'),await page!.screenshot());
   await selectBlock(awayTarget);
   const eventAwayStrip=await stripState();assert.equal(eventAwayStrip.selected,awayTarget);assert.equal(eventAwayStrip.actRowVisible,true);
   if(ordinary){comparePartsStrip(eventAwayStrip,ordinary.state,true);assert.equal(eventAwayStrip.ordinaryPanelVisible,true);}
   await assertPaintingPersists(eventPainting);
   // The same genuine pending stream must select Question on initial navigation, not only event arrival.
   await page!.goto('about:blank');await page!.goto(url.href);
   await waitForQuestion(selector);
   const pendingPainting=await readPainting(2);
   await rememberPainting();
   const pendingStrip=await stripState();assert.equal(pendingStrip.tabs[0]!.id,'question');assert.deepEqual(pendingStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs retained on pending load');assert.equal(pendingStrip.selectedVisible,true);assert.equal(pendingStrip.questionFirst,true);
   if(ordinary)comparePartsStrip(pendingStrip,ordinary.state,true);
   assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),false,'pending interview save remains visible');
   await writeFile(join(out,'load.png'),await page!.screenshot());
   let narrowStrip:StripState|undefined;
   if(picture===true&&narrowQuestionResize){
    await command!('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:2,mobile:false});
    await wait(`(()=>{const row=document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])');return row.querySelector('[data-block-target=question][aria-selected=true]')?.getBoundingClientRect().width>0&&!!row.querySelector('[data-block-target=report-panel][data-tab-overflow]');})()`,'839 900px selected Question visible and Report overflows');
    narrowStrip=await stripState();assert.equal(narrowStrip.selectedVisible,true);assert.equal(narrowStrip.reportOverflow,true);assert.equal(narrowStrip.questionFirst,true);await writeFile(join(out,'narrow-900.png'),await page!.screenshot());
    await command!('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});await wait(`innerWidth===1440&&document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])').clientWidth>1000`,'839 full strip restored');
   }
   await selectBlock(awayTarget);
   const awayStrip=await stripState();assert.equal(awayStrip.selected,awayTarget);assert.equal(awayStrip.actRowVisible,true);
   if(ordinary){comparePartsStrip(awayStrip,ordinary.state,true);assert.equal(awayStrip.ordinaryPanelVisible,true);}
   const awayPainting=await assertPaintingPersists(pendingPainting);
   await writeFile(join(out,'away.png'),await page!.screenshot());
   await click(page!,'#workspace-pending-ask');await waitForQuestion(selector);
   await assertPaintingPersists(pendingPainting);
   assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
   // Clicking the visible main painting cannot open a pointed comment composer.
   await wait(`!document.querySelector('#rig-viewport.stage-comment-mode,#reference-viewport.stage-comment-mode')`,'839 question image refuses pin mode');
   await click(page!,'#stage-comment');
   await wait(`!document.querySelector('#rig-viewport.stage-comment-mode,#reference-viewport.stage-comment-mode')`,'839 comment action keeps pin mode unavailable');
   await click(page!,'#reference-viewport');
   assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('.stage-comment-composer')`),false,'no pointed comment composer on the question image');
   await click(page!,'#workspace-pending-ask');await waitForQuestion(selector);
   await writeFile(join(out,'back.png'),await page!.screenshot());
   await answerInterview(selector);
   await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).scrollIntoView({block:'center'})`);
   await click(page!,selector+' button[type=submit]');
   await wait(`document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'&&document.querySelector('#dirty').textContent.includes(${JSON.stringify(language==='ko'?'저장':'saved')})&&document.querySelector('#workspace-act-row').hidden`,'839 answer saved');
   assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector+' fieldset')}).disabled`),true);
   assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),true,'answered interview submit is absent from readback');
   assert.equal(await page!.evaluate<string>(`document.getElementById('message').textContent`),await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'interview-only saved footer agrees with rendered saved header');
   assert.deepEqual(await page!.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(selector+' input:checked')})].map(n=>n.value)`),['topology_other','density_auto']);
   assert.equal(await page!.evaluate<boolean>(`['workspace-pending-ask','save','request-changes'].every(id=>document.getElementById(id).hidden)`),true,'completed answer controls hidden');
   assert.equal(await page!.evaluate<boolean>(`document.querySelector('#workspace-act-row').hidden`),true);
   assert.deepEqual(await page!.evaluate<string[]>(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['dirty'],'single visible saved state');
   const answeredStrip=await stripState();assert.equal(answeredStrip.tabs[0]!.id,'question');assert.deepEqual(answeredStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs retained after save');if(ordinary)comparePartsStrip(answeredStrip,ordinary.state,true);
   const savedFooter:string=await page!.evaluate<string>(`document.getElementById('message').textContent`);
   assert.equal(savedFooter,await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'footer agrees with actual rendered saved header');
   const readbackCopy=await page!.evaluate<string>(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')}).textContent`);assert.equal(readbackCopy,(language==='en'?enCatalog:koCatalog)['job.saved']);
   await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')}).scrollIntoView({block:'center'})`);await writeFile(join(out,'readback-status.png'),await page!.screenshot());
   const savedPainting=await assertPaintingPersists(pendingPainting);
   await selectBlock(awayTarget);if(ordinary){const savedAway=await stripState();comparePartsStrip(savedAway,ordinary.state,true);assert.equal(savedAway.ordinaryPanelVisible,true);}
   await assertPaintingPersists(pendingPainting);
   await selectBlock('question');
   await waitForQuestion(selector,true);
   await assertPaintingPersists(pendingPainting);
   await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector+' input:checked')}).scrollIntoView({block:'center'})`);
   await writeFile(join(out,'answered.png'),await page!.screenshot());
   const bytes=await readFile(join(out,'one-screen.json'),'utf8'),act=parseRecordAct(JSON.parse(bytes));assert.equal(act.kind,'interview-picks');
   if(act.kind!=='interview-picks')throw Error('wrong act');
   assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
   const expected=prepareJobRecordAct({jobId:fixture.session.jobId,submission:{...fixture.submissions.at(-1)!,value:JSON.parse(baseline.expectedValueBytes)},ask:fixture.ask,retained:fixture.session.retainedSourceV3(fixture.ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z'});
   assert.equal(bytes,JSON.stringify(expected));
   // The fixture server replays the committed act just as the real retained job stream does on reload.
   const pending=fixture.fake.events.find(event=>event.type==='pending'&&event.ask.askId===fixture.ask.askId);
   if(!pending||pending.type!=='pending')throw Error('missing pending fixture event');fixture.fake.events.push({type:'act',jobId:fixture.session.jobId,generation:fixture.display.publication.generation+2,cursor:String(fixture.fake.events.length+1),act});
   await page!.goto('about:blank');await page!.goto(url.href);await wait(`document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'&&document.querySelector('#reference-content img')?.naturalWidth===2`,'839 reload readback');
   await waitForQuestion(selector,true);await readPainting(2);
   assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector+' fieldset')}).disabled`),true);
   assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).hidden`),true,'answered interview submit is absent from readback');
   assert.equal(await page!.evaluate<string>(`document.getElementById('message').textContent`),await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'interview-only saved footer agrees with rendered saved header');
   assert.deepEqual(await page!.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(selector+' input:checked')})].map(n=>n.value)`),['topology_other','density_auto']);
   assert.equal(await page!.evaluate<string>(`document.querySelector(${JSON.stringify(selector+' textarea[name="other.topology"]')}).value`),'  Custom topology · 직접 입력\n');
   assert.equal(await page!.evaluate<boolean>(`document.querySelector('#workspace-act-row').hidden&&['workspace-pending-ask','save','request-changes'].every(id=>document.getElementById(id).hidden)`),true,'reloaded completed row and controls hidden');
   assert.deepEqual(await page!.evaluate<string[]>(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['dirty'],'reloaded single visible saved state');
   assert.ok(await page!.evaluate<boolean>(`document.querySelector('#dirty').textContent.includes(${JSON.stringify(language==='ko'?'저장':'saved')})`));
   await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector+' input:checked')}).scrollIntoView({block:'center'})`);
   await writeFile(join(out,'reload.png'),await page!.screenshot());
   const reloadStrip=await stripState();assert.equal(reloadStrip.tabs[0]!.id,'question');assert.deepEqual(reloadStrip.tabs.filter(tab=>tab.id!=='question'),originalTabs,'displayed tabs retained on readback reload');if(ordinary)comparePartsStrip(reloadStrip,ordinary.state,true);
   const observation={eventPainting,pendingPainting,awayPainting,savedPainting,transientPinRefused:true,pendingOnLoad:true,picture,language,width:1440,height:900,dpr:2,originalTabs,ordinary,beforeAskStrip,eventArrivalStrip,eventAwayStrip,pendingStrip,awayStrip,answeredStrip,reloadStrip,narrowStrip,readbackCopy,savedFooter,sourceHash:fixture.display.publication.source.sourceHash,fullActByteEqual:true,bytes:bytes.length};cases.push(observation);persistedActs++;await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2));
   console.log('839_QUESTION_PASS '+JSON.stringify(observation));
   assert.deepEqual(await jobInputHashes(fixture.root),before);
  }finally{await fixture.close();}
 }
 await picturelessPartsQuestionChecks();
 await longInterviewScrollChecks(true);
}

/** A question without images leaves the published parts backdrop and its tabs available. */
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
   await waitForQuestion(selector);
   const pictureless=await page!.evaluate<{partVisible:boolean;imageModes:number;codeText:string;sourceAboveSubmit:boolean}>(`(()=>{
    const canvas=document.querySelector('#parts-canvas'),form=document.querySelector(${JSON.stringify(selector)});
    const context=form.querySelector('.interview-image-context'),submit=form.querySelector('button[type=submit]');
    return {partVisible:canvas.getBoundingClientRect().width>0,imageModes:document.querySelectorAll('#view-menu [data-view^="interview-image-"]').length,
     codeText:context.querySelector('code').textContent,sourceAboveSubmit:!!(context.compareDocumentPosition(submit)&Node.DOCUMENT_POSITION_FOLLOWING)};
   })()`);
   assert.equal(pictureless.partVisible,true);assert.equal(pictureless.imageModes,0);
   assert.ok(pictureless.codeText.includes('.json · ')&&pictureless.sourceAboveSubmit,'bound-source line precedes submit');
   assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
   const pendingStrip=await stripState();comparePartsStrip(pendingStrip,ordinary.state,true);assert.equal(pendingStrip.actRowVisible,true);await writeFile(join(out,'pending.png'),await page!.screenshot());
   await selectBlock('selected-part');const awayStrip=await stripState();comparePartsStrip(awayStrip,ordinary.state,true);assert.equal(awayStrip.ordinaryPanelVisible,true);await writeFile(join(out,'away.png'),await page!.screenshot());
   await click(page!,'#workspace-pending-ask');await waitForQuestion(selector);
   await answerInterview(selector);
   await clickFormControl(selector+' button[type=submit]');
   await waitForQuestion(selector,true);
   const answeredStrip=await stripState();comparePartsStrip(answeredStrip,ordinary.state,true);assert.equal(answeredStrip.selected,'question');
   assert.equal(await page!.evaluate<boolean>(`document.querySelector('#workspace-act-row').hidden`),true);
   const savedFooter:string=await page!.evaluate<string>(`document.getElementById('message').textContent`);
   assert.equal(savedFooter,await page!.evaluate<string>(`document.getElementById('dirty').textContent`),'footer agrees with actual rendered saved header');
   const readbackCopy=await page!.evaluate<string>(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')}).textContent`);assert.equal(readbackCopy,(language==='en'?enCatalog:koCatalog)['job.saved']);await writeFile(join(out,'answered.png'),await page!.screenshot());
   const bytes=await readFile(join(out,'one-screen.json'),'utf8'),act=parseRecordAct(JSON.parse(bytes));assert.equal(act.kind,'interview-picks');if(act.kind!=='interview-picks')throw Error('wrong act');assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
   const expected=prepareJobRecordAct({jobId:fixture.session.jobId,submission:{...fixture.submissions.at(-1)!,value:JSON.parse(baseline.expectedValueBytes)},ask:fixture.ask,retained:fixture.session.retainedSourceV3(fixture.ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z'});assert.equal(bytes,JSON.stringify(expected));
   fixture.fake.events.push({type:'act',jobId:fixture.session.jobId,generation:fixture.display.publication.generation+2,cursor:String(fixture.fake.events.length+1),act});
   await page!.goto('about:blank');await page!.goto(url.href);await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#workspace-act-row').hidden`,'839 no-image saved reload');
   await waitForQuestion(selector,true);
   assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
   const reloadStrip=await stripState();comparePartsStrip(reloadStrip,ordinary.state,true);assert.equal(reloadStrip.selected,'question');await writeFile(join(out,'reload.png'),await page!.screenshot());
   const observation={picture:'parts',questionImages:false,language,sourceHash:fixture.display.publication.source.sourceHash,ordinary,pendingStrip,awayStrip,answeredStrip,reloadStrip,readbackCopy,savedFooter,fullActByteEqual:true,bytes:bytes.length};cases.push(observation);persistedActs++;await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2));console.log('839_NO_IMAGE_PARTS_PASS '+JSON.stringify(observation));
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

type RouteSnapshot={caught:{chain:{name:string;message:string;stack:string}[];at:number;ready?:string;dialogOpen:boolean}[];
 ready?:string;dialogOpen:boolean;dialogConnected:boolean;questionSelected:boolean;partsWidth?:number;formReady:boolean;message?:string;bodyText:string};
type RouteObservation={variant:string;language:string;sourceHash:string;fixture:string;events?:unknown;initial?:RouteSnapshot;afterAnswer?:RouteSnapshot;
 saved?:RouteSnapshot;final?:RouteSnapshot|null;verdict?:string;originalFailure?:RouteSnapshot['caught'];downstream?:string;sourceImmutable?:boolean;error?:{message:string;stack?:string|null}};
type Edges=Pick<Rect,'left'|'right'|'top'|'bottom'>;
type StripRect=Edges&Pick<Rect,'width'|'height'>;
type StripGeometry={selected:StripRect;activeRow:StripRect;strip:StripRect;viewport:StripRect;deltas:Record<'row'|'strip'|'viewport',Edges>;
 insideRow:boolean;insideStrip:boolean;insideViewport:boolean;selectedId:string;questionFirst:boolean;reportOverflow:boolean;documentWidth:number;deviceScaleFactor:number};
type GeometryObservation={picture:string;language:string;sourceHash:string;width:number;height:number;dpr:number;navigation:string;
 originalState?:RouteSnapshot;geometry?:StripGeometry;sourceImmutable?:boolean;verdict?:string;error?:RouteObservation['error'];final?:RouteSnapshot|null};

/** Preserve the frozen #839 native-form comparator and measure the current Question route. */
async function followupQuestionChecks(){
 const mainRoot=process.env.RIG_REVIEW_839_MAIN_ROOT;assert.ok(mainRoot,'immutable main input supplied through nova-run --script');
 const variants=[{id:'main-38bb5f7',legacy:true,resource:await followupResources(mainRoot,'main-38bb5f7')},
  {id:'current',legacy:false,resource:await followupResources(resolve('.'),'current')}];
 const pairs:RouteObservation[]=[],numeric:GeometryObservation[]=[];
 const snapshot=()=>page!.evaluate<RouteSnapshot>(`({caught:globalThis.__839OriginalErrors??[],ready:document.body.dataset.ready,
  dialogOpen:!!document.querySelector('#job-record-asks[open]'),dialogConnected:!!document.querySelector('#job-record-asks')?.isConnected,
  questionSelected:!!document.querySelector('${questionTab}'),partsWidth:document.querySelector('#parts-canvas')?.width,
  formReady:!!document.querySelector('form.interview-answer fieldset:not(:disabled)'),message:document.querySelector('#review-message')?.textContent,
  bodyText:document.body.innerText.slice(0,12000)})`);
 for(const variant of variants)for(const language of ['en','ko'] as const){
  const out=join(output,'no-image-pair',variant.id,language);await mkdir(out,{recursive:true});
  const fixture=await recordScreenFixture('interview-picks','parts',out,undefined,false,false,variant.resource),entry:RouteObservation={variant:variant.id,language,sourceHash:fixture.display.publication.source.sourceHash,fixture:'Same retained parts backdrop and images-empty record path, including original event history'};
  try{
   const before=await jobInputHashes(fixture.root),metadata=await (await fetch(fixture.origin+fixture.display.routes.apiBase+'interview')).json() as {questions:{images:unknown[]}[]};assert.equal(metadata.questions[0]!.images.length,0);
   entry.events=fixture.fake.events;await page!.setViewport(1440,900);await command!('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`(globalThis.__839OriginalErrors?.length??0)>0||(document.body.dataset.ready==='true'&&!!document.querySelector('form.interview-answer fieldset:not(:disabled)'))`,'839 paired no-image original result');
   entry.initial=await snapshot();
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
   if(!entry.initial.caught.length){
    if(variant.legacy){
     if(!entry.initial.dialogOpen)await click(page!,'#workspace-pending-ask');
     await wait(`(globalThis.__839OriginalErrors?.length??0)>0||!!document.querySelector('#job-record-asks[open] form.interview-answer fieldset:not(:disabled)')`,'839 frozen native Answer action');
    }else{
     await waitForQuestion(selector);
     assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
    }
    entry.afterAnswer=await snapshot();
   }
   const state=entry.afterAnswer??entry.initial;
   const reachable=variant.legacy?state.dialogOpen:state.questionSelected&&!state.dialogOpen;
   entry.verdict=state.caught.length?'RED_ORIGINAL_REFUSAL':reachable?'ANSWER_FORM_OPEN':'RED_ANSWER_FORM_ABSENT';
   entry.originalFailure=state.caught;entry.downstream=state.caught.length?'SKIP_NO_IMAGE_ACTS_ORIGINAL_REFUSAL':'answer form reachable';
   if(entry.verdict==='ANSWER_FORM_OPEN'){
    await answerInterview(selector);
    await clickFormControl(selector+' button[type=submit]');
    await wait(`(globalThis.__839OriginalErrors?.length??0)>0||document.querySelector(${JSON.stringify(selector)})?.dataset.interviewAnswered==='true'`,'839 paired save');
    entry.saved=await snapshot();
    if(entry.saved.caught.length){entry.verdict='RED_ORIGINAL_REFUSAL';entry.originalFailure=entry.saved.caught;}
    else{
     const act=parseRecordAct(JSON.parse(await readFile(join(out,'one-screen.json'),'utf8')));
     assert.equal(act.kind,'interview-picks');assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
     entry.verdict=variant.legacy?'NATIVE_ANSWER_SAVED':'QUESTION_ANSWER_SAVED';
    }
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before);entry.sourceImmutable=true;
  }catch(error){entry.verdict='RED_TEST_OR_ROUTE';entry.error={message:String(error),stack:error instanceof Error?error.stack:null};entry.final=await snapshot().catch(()=>null);}
  finally{await writeFile(join(out,'screen.png'),await page!.screenshot()).catch(()=>{});await writeFile(join(out,'observation.json'),JSON.stringify(entry,null,2));pairs.push(entry);console.log('839_NO_IMAGE_PAIR '+JSON.stringify({variant:entry.variant,language,verdict:entry.verdict,originalFailure:entry.originalFailure,error:entry.error}));await page!.goto('about:blank');await fixture.close();}
 }
 await writeFile(join(output,'no-image-pair.json'),JSON.stringify(pairs,null,2));
 for(const picture of [true,'parts'] as const)for(const language of ['en','ko'] as const){
  const out=join(output,'fresh-900',picture==='parts'?'parts':'rig',language);await mkdir(out,{recursive:true});
  const fixture=await recordScreenFixture('interview-picks',picture,out,undefined,false,true,variants[1]!.resource),entry:GeometryObservation={picture:picture==='parts'?'parts':'rig',language,sourceHash:fixture.display.publication.source.sourceHash,width:900,height:900,dpr:2,navigation:'fresh about:blank then genuine pending owner URL at preconfigured width900; no post-navigation resize'};
  try{
   // Keep only the actual active ask for this independent geometry measurement.
   const historical=fixture.fake.events.findIndex(event=>event.type==='pending'&&event.ask.askId==='historical-incompatible');
   if(historical>=0)fixture.fake.events.splice(historical,1);
   const before=await jobInputHashes(fixture.root);await page!.setViewport(900,900);await command!('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:2,mobile:false});
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`(globalThis.__839OriginalErrors?.length??0)>0||(document.body.dataset.ready==='true'&&!!document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target=question][aria-selected=true]')&&document.querySelector('#reference-content img')?.naturalWidth===2)`,'839 fresh900 pending ready');
   entry.originalState=await snapshot();
   if(entry.originalState.caught.length)entry.verdict='RED_ORIGINAL_REFUSAL';
   else{
    await page!.evaluate<void>(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    entry.geometry=await page!.evaluate<StripGeometry>(`(()=>{const row=document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden])'),strip=document.querySelector('.workspace-bottom-tabs'),tab=row.querySelector('[data-block-target=question][aria-selected=true]'),rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};},selected=rect(tab),activeRow=rect(row),stripRect=rect(strip),viewport={left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight},deltas=b=>({left:selected.left-b.left,right:b.right-selected.right,top:selected.top-b.top,bottom:b.bottom-selected.bottom}),inside=b=>{const d=deltas(b);return selected.width>0&&selected.height>0&&Object.values(d).every(v=>v>=-0.5);};return {selected,activeRow,strip:stripRect,viewport,deltas:{row:deltas(activeRow),strip:deltas(stripRect),viewport:deltas(viewport)},insideRow:inside(activeRow),insideStrip:inside(stripRect),insideViewport:inside(viewport),selectedId:tab.dataset.blockTarget,questionFirst:[...row.querySelectorAll(':scope>button[role=tab]')][0]?.dataset.blockTarget==='question',reportOverflow:!!row.querySelector('[data-block-target=report-panel][data-tab-overflow]'),documentWidth:document.documentElement.scrollWidth,deviceScaleFactor:devicePixelRatio};})()`);
    const g=entry.geometry;await readPainting(2);assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));entry.verdict=g.viewport.width===900&&g.insideRow&&g.insideStrip&&g.insideViewport&&g.questionFirst&&(picture==='parts'||g.reportOverflow)?'FRESH_900_CONTAINED':'RED_FRESH_900_CLIPPED';
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before);entry.sourceImmutable=true;
  }catch(error){entry.verdict='RED_TEST_OR_ROUTE';entry.error={message:String(error),stack:error instanceof Error?error.stack:null};entry.final=await snapshot().catch(()=>null);}
  finally{await writeFile(join(out,'screen.png'),await page!.screenshot()).catch(()=>{});await writeFile(join(out,'geometry.json'),JSON.stringify(entry,null,2));numeric.push(entry);console.log('839_FRESH_900 '+JSON.stringify(entry));await page!.goto('about:blank');await fixture.close();}
 }
 await writeFile(join(output,'fresh-900.json'),JSON.stringify(numeric,null,2));
 const result={pairs:pairs.map(e=>({variant:e.variant,language:e.language,verdict:e.verdict})),numeric:numeric.map(e=>({picture:e.picture,language:e.language,verdict:e.verdict})),originalRefusals:pairs.filter(e=>e.verdict==='RED_ORIGINAL_REFUSAL').length,uncaughtExceptions:exceptions,passed:pairs.every(e=>e.verdict===(e.variant==='main-38bb5f7'?'NATIVE_ANSWER_SAVED':'QUESTION_ANSWER_SAVED'))&&numeric.every(e=>e.verdict==='FRESH_900_CONTAINED')&&exceptions.length===0};
 await writeFile(join(output,'followup-result.json'),JSON.stringify(result,null,2));console.log('839_FOLLOWUP_RESULT '+JSON.stringify(result));if(!result.passed)process.exitCode=1;
}

async function postQuestionPictureChecks(){
 await page!.setViewport(1440,900);
 const observations:{variant:string;language:string;sha256?:string}[]=[];
 for(const variant of ['scene','unsealed-scene','rig','legacy'] as const){
  const fixture=await recordScreenFixture('interview-picks',false,undefined,undefined,false,true,undefined,false,false,variant);
  try{
   for(const language of ['en','ko'] as const){
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
    await page!.goto('about:blank');await page!.goto(url.href);
    await waitForQuestion('form.interview-answer');
    assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
    const observation:{variant:string;language:string;sha256?:string}={variant,language};
    if(variant==='scene'){
     await wait(`(()=>{
      const image=document.querySelector('#reference-content img'),rect=image?.getBoundingClientRect();
      return image?.naturalWidth===2&&rect.width>0&&rect.height>0&&getComputedStyle(image).visibility==='visible';
     })()`,'929 painted scene plate');
     const image=await page!.evaluate<{src:string;visible:boolean;background:number[]}>(`(()=>{
      const image=document.querySelector('#reference-content img'),canvas=document.createElement('canvas');
      canvas.width=canvas.height=2;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const rect=image.getBoundingClientRect();
      return {src:image.currentSrc,visible:rect.width>0&&rect.height>0&&getComputedStyle(image).visibility==='visible',
        background:[...ctx.getImageData(0,0,1,1).data]};
     })()`);
     assert.ok(image.visible);
     assert.deepEqual(image.background,[17,91,203,255]);
     assert.equal(await page!.evaluate<string>(`document.querySelector('#message').textContent`),'');
     assert.ok(new URL(image.src).pathname.startsWith(fixture.display.routes.apiBase+'interview/image/'));
     const response=await fetch(image.src);
     assert.equal(response.status,200);
     observation.sha256=sha(new Uint8Array(await response.arrayBuffer()));
     assert.equal(observation.sha256,sha(await readFile(join(fixture.root,'evidence/plate.png'))));
     const painting=await rememberPainting();
     await selectBlock('feedback');
     await assertPaintingPersists(painting);
     await click(page!,'#workspace-pending-ask');
     await waitForQuestion('form.interview-answer');
     await assertPaintingPersists(painting);
    }else{
     const key=variant==='legacy'?'This request has no picture.':variant==='rig'?
      'This question refers to a rig version that this publication does not include.':
      'This question refers to a scene that this publication does not include.';
     const text=await page!.evaluate<string>(`document.querySelector('#rig-empty').textContent`);
     assert.equal(text,(language==='en'?enCatalog:koCatalog)[key]);
    }
    await writeFile(join(output,variant+'-'+language+'.png'),await page!.screenshot());
    observations.push(observation);
   }
  }catch(error){
   const state=await page!.evaluate<{url:string;ready?:string;text:string}>(`({url:location.pathname,ready:document.body?.dataset.ready,text:document.body?.innerText.slice(0,3000)})`);
   await writeFile(join(output,variant+'-failure.json'),JSON.stringify({...state,consoleErrors},null,2)+'\n');
   await writeFile(join(output,variant+'-failure.png'),await page!.screenshot());
   throw error;
  }finally{await page!.goto('about:blank');await fixture.close();}
 }
 assert.equal(exceptions.length,0);
 await writeFile(join(output,'post-question-pictures.json'),JSON.stringify(observations,null,2)+'\n');
 console.log('929_BROWSER_PASS '+JSON.stringify(observations));
}

async function boundRigPictureChecks(){
 const viewport = {width:1440,height:900};
 await page!.setViewport(viewport.width,viewport.height);
 const observations: Record<string,unknown>[] = [];
 const samePublicationParity: Record<string,unknown>[] = [];
 const expectedValue = {
  questionId:'post_timing',
  selections:[
   {itemId:'topology',optionId:'topology_other',otherText:'  Custom topology · 직접 입력\n'},
   {itemId:'detail_level',optionId:'density_auto',otherText:null},
  ],
  note:'  Keep the idle · 원문 유지\n',
 };
 const values: string[] = [];
 for (const variant of ['bound-rig','rig-signoff-hash'] as const) for (const language of ['en','ko'] as const) {
  const out = join(output,'bound-rig-picture',variant,language);
  await mkdir(out,{recursive:true});
  const fixture = await recordScreenFixture('interview-picks',false,out,undefined,false,true,undefined,false,false,variant);
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  const selector = `form[data-job-ask="${fixture.ask.askId}"]`;
  try {
   const publication = fixture.display.publication;
   assert.equal(publication.previousPublicationId,null);
   const retained = fixture.session.retainedSourceV3(publication.publicationId);
   const before = await jobInputHashes(fixture.root), retainedBefore = await jobInputHashes(retained.snapshotRoot);
   const url = new URL(fixture.ownerUrl);
   url.searchParams.set('lang',language);
   const capturedActs: Buffer[] = [];
   const pageIds: string[] = [];
   for (const suppressed of variant === 'bound-rig' ? [false,true] : [false]) {
    const pictured = variant === 'bound-rig' && !suppressed;
    const visit = pictured ? 'with-rig' : 'without-rig';
    const attempt = capturedActs.length;
    const priorAcknowledgments = fixture.fake.acknowledgments.length;
    await page!.goto('about:blank');
    if (suppressed) fixture.suppressRigPicture();
    await page!.goto(url.href);
    await waitForQuestion(selector+'[data-interview-answered=false]');
    assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
    await withDeadline('929 '+variant+' '+language+' '+visit+' receipt',20_000,async signal=>{
     while(fixture.fake.acknowledgments.length===priorAcknowledgments){
      signal.throwIfAborted();
      await Bun.sleep(25);
     }
    });
    assert.equal(await page!.evaluate<string>('document.documentElement.lang'),language);
    const ack = fixture.fake.acknowledgments.at(-1)?.body as {sourceHash?:string;pageId?:string;publicationId?:string} | undefined;
    assert.equal(ack?.sourceHash,publication.source.sourceHash);
    assert.equal(ack?.publicationId,publication.publicationId);
    assert.ok(ack?.pageId && !pageIds.includes(ack.pageId),'each visit has a new displayed receipt');
    pageIds.push(ack.pageId);
    assert.equal(fixture.submissions.length,attempt,'opening did not answer the ask');

    let paintedPixels = 0;
    let missingPicture: string | null = null;
    if (pictured) {
     const actualRig = catalog['@rig-c/play · Actual rig'];
     await wait(`document.querySelector('#player-state')?.textContent===${JSON.stringify(actualRig)}&&
      document.querySelector('#animation-select')?.value==='idle'&&
      document.querySelector('#rig-empty')?.hidden===true&&
      !!document.querySelector('#workspace-interview-answer ${selector}')&&
      !!document.querySelector('.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target=question][aria-selected=true]')`,
     '929 bound rig, idle and Question');
     const stage = await page!.evaluate<{left:number;top:number;right:number;bottom:number}>(`document.getElementById('rig-viewport').getBoundingClientRect().toJSON()`);
     const screen = await page!.screenshot();
     await writeFile(join(out,'question-'+visit+'.png'),screen);
     const png = PNG.sync.read(Buffer.from(screen)), scale = png.width / viewport.width;
     for (let y=Math.max(0,Math.ceil(stage.top*scale)); y<Math.min(png.height,Math.floor(stage.bottom*scale)); y++) {
      for (let x=Math.max(0,Math.ceil(stage.left*scale)); x<Math.min(png.width,Math.floor(stage.right*scale)); x++) {
       const pixel = (y*png.width+x)*4;
       if (SYNTHETIC_RIG_RGB.every((value,channel) => Math.abs(png.data[pixel+channel]!-value)<=3)) paintedPixels++;
      }
     }
     assert.ok(paintedPixels>=16,'the visible rig viewport contains the sealed mesh page color');
    } else {
     missingPicture = await page!.evaluate<string>(`document.querySelector('#rig-empty').textContent`);
     assert.equal(missingPicture,catalog['This question refers to a rig version that this publication does not include.']);
     await writeFile(join(out,'question-'+visit+'.png'),await page!.screenshot());
     await selectBlock('feedback');
     await click(page!,'#workspace-pending-ask');
     await waitForQuestion(selector);
    }
    const assetRequests = await page!.evaluate<string[]>(`performance.getEntriesByType('resource')
     .map(entry=>new URL(entry.name).pathname).filter(path=>path.includes('/assets/'))`);
    const base = fixture.display.routes.assetsBase;
    assert.deepEqual([...new Set(assetRequests)].sort(),pictured ? [base+SYNTHETIC_RIG_MODEL,base+SYNTHETIC_RIG_PAGE].sort() : []);
    assert.equal(await page!.evaluate<boolean>(`(()=>{
     const form=document.querySelector(${JSON.stringify(selector)});
     return !form.querySelector('input:checked')&&[...form.querySelectorAll('textarea')].every(field=>field.value==='');
    })()`),true,'each fresh page starts with an empty answer');
    await answerInterview(selector,expectedValue.note);
    await page!.evaluate<void>(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).scrollIntoView({block:'center'})`);
    const controls = await page!.evaluate<{
     inspection:{id:string;text:string;enabled:boolean}[];
     answer:{id:string;text:string;enabled:boolean};
     verdictEnabled:boolean;
     editEnabled:boolean;
     edits:{id:string;text:string;enabled:boolean}[];
    }>(`(()=>{
     const enabled=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible'&&
      !node.matches(':disabled,[aria-disabled="true"]')&&!node.closest('[inert]');
     const control=(node,id=node.id)=>({id,text:node.textContent.trim()||node.getAttribute('aria-label')||'',enabled:enabled(node)});
     const inspection=[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>
      control(node.id==='view-menu'?node.querySelector('summary'):node,node.id));
     const edits=[...document.querySelectorAll('#mesh-edit,#mesh-apply,#chest-edit,#bust-apply,[data-animation-apply]')]
      .map(node=>control(node,node.id||'data-animation-apply'));
     return {
      inspection,answer:control(document.querySelector(${JSON.stringify(selector+' button[type=submit]')})),
      verdictEnabled:[...document.querySelectorAll('#save,#request-changes,#review-status')].some(enabled),
      editEnabled:edits.some(control=>control.enabled),edits,
     };
    })()`);
    assert.deepEqual(controls.inspection.map(control=>control.id),['zoom-in','zoom-out','fit','native-one','view-menu']);
    assert.ok(controls.inspection.every(control=>control.text.length>0));
    assert.equal(controls.answer.text,catalog['interview.save']);
    assert.equal(controls.answer.enabled,true);
    assert.equal(controls.verdictEnabled,false);
    assert.equal(controls.editEnabled,false,JSON.stringify(controls.edits));
    await click(page!,selector+' button[type=submit]');
    await waitForQuestion(selector,true);
    assert.equal(fixture.submissions.length,attempt+1);
    assert.equal(fixture.files.length,attempt+1);
    const submission = fixture.submissions[attempt]!;
    if (submission.kind !== 'interview-picks') throw new Error('Expected an interview-picks submission');
    assert.equal(submission.pageId,ack.pageId);
    assert.equal(submission.publicationId,publication.publicationId);
    assert.equal(submission.askId,fixture.ask.askId);
    assert.equal(submission.displayedNonce,`nonce-${publication.publicationId}-${ack.pageId}`);
    const actPath = fixture.files[attempt]!;
    assert.equal(actPath,fixture.files[0],'the fixture writer uses the same act path on both visits');
    const bytes = await readFile(actPath), act = parseRecordAct(JSON.parse(bytes.toString('utf8')));
    // Keep the first raw bytes before the second visit overwrites the fixture writer's file.
    capturedActs.push(bytes);
    await writeFile(join(out,'act-'+visit+'.json'),bytes);
    assert.equal(act.kind,'interview-picks');
    assert.deepEqual(act.source,publication.source);
    assert.deepEqual(act.value,expectedValue);
    values.push(JSON.stringify(act.value));
    const expected = prepareJobRecordAct({
     jobId:fixture.session.jobId,submission:{...submission,value:expectedValue},ask:fixture.ask,
     retained:retained as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},
     actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z',
    });
    assert.deepEqual(bytes,Buffer.from(JSON.stringify(expected)));
    assert.deepEqual(await jobInputHashes(fixture.root),before);
    assert.deepEqual(await jobInputHashes(retained.snapshotRoot),retainedBefore);
    observations.push({variant,language,visit,suppressed,paintedPixels,missingPicture,assetRequests,controls,sourceHash:publication.source.sourceHash,
     actBytes:bytes.length,actSha256:sha(bytes),actValueSha256:sha(JSON.stringify(act.value)),fullActMatchesSourceOracle:true});
   }
   if (variant === 'bound-rig') {
    assert.equal(capturedActs.length,2);
    assert.notEqual(fixture.submissions[0]!.submissionId,fixture.submissions[1]!.submissionId);
    assert.deepEqual(capturedActs[0],capturedActs[1],language+' full act bytes on the same sealed publication');
    samePublicationParity.push({language,publicationId:publication.publicationId,sourceHash:publication.source.sourceHash,
     actSha256:sha(capturedActs[0]!),actBytes:capturedActs[0]!.length,distinctPages:pageIds.length,fullActBytesEqual:true});
   }
  } finally {
   await page!.goto('about:blank');
   await fixture.close();
  }
 }
 assert.equal(new Set(values).size,1,'pictured and signoff-mismatch acts carry identical answer bytes in EN and KO');
 assert.deepEqual(exceptions,[]);
 const result = {observations,samePublicationParity};
 await writeFile(join(output,'bound-rig-picture.json'),JSON.stringify(result,null,2)+'\n');
 console.log('929_BOUND_RIG_BROWSER_PASS '+JSON.stringify(result));
}

type RadioIdentity={name:string;value:string};
type FormTarget={text:string;control:boolean;visible:boolean;hit:boolean;rect:Rect};
type SurveyLayout={list:Rect;fields:Rect;progress:string;questions:number;optionCount:number;otherInputs:number;noteInputs:number;
 submitButtons:number;allVisible:boolean;allHit:boolean;controlsReached:number;targets:FormTarget[];
 scrollAncestors:{id:string;scrollHeight:number;clientHeight:number}[];documentScrollHeight:number;documentClientHeight:number};
async function surveyLayout(selector:string){
 return page!.evaluate<SurveyLayout>(`(()=>{
  const panel=document.querySelector('${questionRoot}'),form=panel.querySelector(${JSON.stringify(selector)});
  const fields=form.querySelector('.interview-answer-fields'),list=form.querySelector('.interview-questions');
  const visible=node=>{
   const r=node.getBoundingClientRect();
   if(r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return false;
   for(let parent=node.parentElement;parent;parent=parent.parentElement){
    const style=getComputedStyle(parent),box=parent.getBoundingClientRect();
    if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<box.top-1||r.bottom>box.bottom+1))return false;
    if(parent===panel)break;
   }
   return true;
  };
  const targets=[...fields.querySelectorAll('.interview-option,.interview-recommended,.interview-option span,.interview-delegate,textarea:not([hidden]),legend,button[type=submit]')].map(node=>{
   node.scrollIntoView({block:'nearest'});
   const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
   return {text:node.textContent||node.value,control:node.matches('label.interview-option,textarea:not([hidden]),button[type=submit]'),visible:visible(node),hit:!!hit&&node.contains(hit),rect:r.toJSON()};
  });
  panel.scrollTop=0;
  const scrollAncestors=[];
  for(let parent=fields;parent;parent=parent.parentElement){
   if(/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY))scrollAncestors.push({id:parent.id,scrollHeight:parent.scrollHeight,clientHeight:parent.clientHeight});
   if(parent===panel)break;
  }
  return {list:list.getBoundingClientRect().toJSON(),fields:fields.getBoundingClientRect().toJSON(),progress:list.querySelector('p').textContent,
   questions:list.querySelectorAll('.interview-question').length,optionCount:fields.querySelectorAll('.interview-option').length,
   otherInputs:fields.querySelectorAll('textarea[name^="other."]:not([hidden])').length,noteInputs:form.querySelectorAll('textarea[name=note]').length,
   submitButtons:fields.querySelectorAll('button[type=submit]:not([hidden])').length,
   allVisible:targets.every(item=>item.visible),allHit:targets.every(item=>item.hit),controlsReached:targets.filter(item=>item.control&&item.visible&&item.hit).length,
   targets,scrollAncestors,documentScrollHeight:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight),documentClientHeight:document.documentElement.clientHeight};
 })()`);
}

async function resizeQuestionPanel(){
 const selector='.workspace-inspectorHeight[role=separator]';
 const range=()=>page!.evaluate<{value:number;min:number;max:number}>(`(()=>{
  const handle=document.querySelector('${selector}');
  return {value:Number(handle.getAttribute('aria-valuenow')),min:Number(handle.getAttribute('aria-valuemin')),max:Number(handle.getAttribute('aria-valuemax'))};
 })()`);
 await click(page!,selector);
 const before=await range();
 assert.ok(before.max>before.min,'shared bottom separator offers a resize range');
 const key=before.value<before.max?'ArrowUp':'ArrowDown',keyCode=key==='ArrowUp'?38:40;
 await command!('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:keyCode,modifiers:8});
 await command!('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:keyCode,modifiers:8});
 const after=await range();
 assert.ok(key==='ArrowUp'?after.value>before.value:after.value<before.value,JSON.stringify({before,after}));
 return {before,after};
}

async function liveQuestionDraftChecks(){
 const sizes=interviewOnly?[[1600,1000],[1440,900]] as const:[[1600,1000]] as const;
 for(const [width,height] of sizes){
  await page!.setViewport(width,height);
  const fixture=await recordScreenFixture('interview-picks',false,undefined,undefined,freshParts);
  const before=await jobInputHashes(fixture.root);
  const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
  try{
   for(const language of ['en','ko'] as const){
    const catalog=language==='en'?enCatalog:koCatalog,out=join(output,`${width}x${height}`,'interview-picks','empty',language);
    await mkdir(out,{recursive:true});fixture.output(out);
    const url=fixtureUrl(fixture.ownerUrl,language);
    await page!.goto('about:blank');holdImages=!freshParts;
    if(holdImages)await command!('Page.navigate',{url});
    else await page!.goto(url);
    await waitForQuestion(selector);
    const dialogs=await assertNoDialogViewer();assert.ok(dialogs.every(dialog=>!dialog.open));
    const screen=await page!.evaluate<{language:string;width:number;height:number;legacySeen:boolean;legacyForms:number;topbars:number;viewports:number;noPicture:string;emptyListText:string;saveState:string;controls:string[]}>(`({
     language:document.documentElement.lang,width:innerWidth,height:innerHeight,legacySeen:globalThis.__record750legacySeen,
     legacyForms:document.querySelectorAll('[data-job-forms]').length,topbars:document.querySelectorAll('.topbar').length,
     viewports:document.querySelectorAll('#rig-viewport').length,noPicture:document.getElementById('rig-empty').textContent,
     emptyListText:document.querySelector('[data-part-list]')?.textContent??'',saveState:document.getElementById('dirty').textContent,
     controls:[...document.querySelectorAll(${JSON.stringify(controlSelector)})].map(node=>node.id)
    })`);
    assert.equal(screen.language,language);assert.equal(screen.width,width);assert.equal(screen.height,height);
    assert.equal(screen.legacySeen,false);assert.equal(screen.legacyForms,0);assert.equal(screen.topbars,1);assert.equal(screen.viewports,1);
    assert.deepEqual(screen.controls,sharedControls);
    const observation:Record<string,unknown>={language,width,height,screen,dialogs,sourceHash:fixture.display.publication.source.sourceHash,
     readerPhases:fixture.reader.calls.map(call=>call.phase),fixture:'synthetic trusted-host record reader and deterministic act writer'};
    if(freshParts){
     await wait(`document.getElementById('renderer-state')?.textContent===${JSON.stringify(catalog['Parts raster drawn · Canvas2D'])}`,'bound parts raster drawn');
     assert.notEqual(screen.noPicture,catalog['This request has no picture.']);assert.equal(fixture.display.publication.previousPublicationId,null);
     await wait(`document.querySelectorAll('[data-part-list] button').length>0`,'fresh parts list');
    }else{
     assert.equal(screen.emptyListText,'');assert.equal(screen.saveState,catalog['Not submitted']);
     // Hold the image request while the editable Question form is already available.
     await withDeadline('986 held painting request',5_000,async signal=>{
      while(!pausedImages.length){signal.throwIfAborted();await Bun.sleep(25);}
     });
     await waitForQuestion(selector);
     const stageRect=()=>page!.evaluate<Rect>(`document.querySelector('#stage-layout').getBoundingClientRect().toJSON()`);
     const loading=await stageRect();
     assert.ok(loading.width>0&&loading.height>0,'the shared stage has space while the painting request is held');
     assert.equal(await page!.evaluate<number>(`document.querySelector('${paintingSelector}')?.naturalWidth??0`),0);
     await writeFile(join(out,'option-loading.png'),await page!.screenshot());
     holdImages=false;
     for(const requestId of pausedImages.splice(0))await command!('Fetch.continueRequest',{requestId});
     const loadedPainting=await readPainting(2);
     const loaded=await stageRect();
     assert.deepEqual(loaded,loading,'painting load preserves the shared stage geometry');
     observation.imageLoading={loading,loaded,loadedPainting};
     const imageCount=fixture.session.retainedSourceV3(fixture.ask.publicationId).questions.find(question=>question.set.id===fixture.ask.source.optionSet?.id)!.images.length;
     assert.ok(imageCount>0);
     assert.equal(await page!.evaluate<number>(`document.querySelectorAll('#view-menu [data-view^=interview-image-]').length`),imageCount);
     for(let index=0;index<imageCount;index++){
      await selectInterviewImage(index);
      const painting=await readPainting(2,index);
      assert.ok(new URL(painting.src).pathname.startsWith(fixture.display.routes.apiBase+'interview/image/'));
      const pixel=await page!.evaluate<number[]>(`(()=>{
       const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
       context.drawImage(document.querySelector('${paintingSelector}'),0,0);
       return [...context.getImageData(0,0,1,1).data];
      })()`);
      assert.deepEqual(pixel,[40,160,220,255]);
      await writeFile(join(out,'option-image-'+index+'.png'),await page!.screenshot());
     }
     observation.optionImagesShown=imageCount;
     const painting=await rememberPainting();
     await selectBlock('feedback');
     await assertPaintingPersists(painting);
     await click(page!,'#workspace-pending-ask');await waitForQuestion(selector);
     await assertPaintingPersists(painting);
     await writeFile(join(out,'backdrop.png'),await page!.screenshot());
    }
    await answerInterview(selector);
    const identities=await page!.evaluate<RadioIdentity[]>(`Array.from(document.querySelectorAll(${JSON.stringify(selector+' input[type=radio]')}),input=>({name:input.name,value:input.value}))`);
    await page!.goto('about:blank');await page!.goto(url);await waitForQuestion(selector);
    const reopened=await page!.evaluate<{identities:RadioIdentity[];checked:string[];other:string;note:string|null;otherVisible:boolean;selects:number;recommended:number;delegates:number}>(`(()=>{
     const form=document.querySelector(${JSON.stringify(selector)});
     return {identities:[...form.querySelectorAll('input[type=radio]')].map(input=>({name:input.name,value:input.value})),
      checked:[...form.querySelectorAll('input:checked')].map(input=>input.value),other:form.querySelector('textarea[name="other.topology"]').value,
      note:form.querySelector('textarea[name=note]')?.value??null,otherVisible:!form.querySelector('textarea[name="other.topology"]').hidden,
      selects:form.querySelectorAll('select').length,recommended:form.querySelectorAll('.interview-recommended').length,delegates:form.querySelectorAll('.interview-delegate').length};
    })()`);
    assert.deepEqual(reopened,{identities,checked:['topology_other','density_auto'],other:otherText,note:'',otherVisible:true,selects:0,recommended:2,delegates:2});
    observation.reopened=reopened;assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
    if(!freshParts){
     await readPainting(2);
     const layout=await surveyLayout(selector);
     assert.equal(layout.questions,1,'both asks belong to the same question set');
     assert.equal(layout.progress,catalog['interview.answered'].replace('{0}','0').replace('{1}','1'));
     assert.equal(layout.optionCount,8);assert.equal(layout.otherInputs,1);assert.equal(layout.noteInputs,1);assert.equal(layout.submitButtons,1);
     assert.ok(layout.fields.left>=layout.list.right-1,'the Question panel places the list and fields side by side');
     assert.equal(layout.controlsReached,11,JSON.stringify(layout.targets.filter(item=>item.control)));
     assert.equal(layout.allHit,true,JSON.stringify(layout.targets));assert.equal(layout.allVisible,true,JSON.stringify(layout.targets));
     assert.ok(layout.documentScrollHeight<=layout.documentClientHeight+1);
     assert.deepEqual(layout.scrollAncestors.filter(node=>node.scrollHeight>node.clientHeight+1).map(node=>node.id),['workspace-interview-answer']);
     observation.layout=layout;
     observation.resized=await resizeQuestionPanel();
     await writeFile(join(out,'radio-cards.png'),await page!.screenshot());
    }
    const painting=freshParts?null:await rememberPainting();
    observation['one-screenControls']=await page!.evaluate<RadioIdentity[]>(`[...document.querySelectorAll(${JSON.stringify(selector+' input:checked,'+selector+' textarea')})].map(input=>({name:input.name,value:input.value}))`);
    const submit=selector+' button[type=submit]',status=selector+' > [role=status]';
    await page!.evaluate<void>(`document.querySelector(${JSON.stringify(submit)}).scrollIntoView({block:'center'})`);
    await writeFile(join(out,'one-screen-answered.png'),await page!.screenshot());
    assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(submit)}).hidden`),false);
    await click(page!,submit);
    await waitForQuestion(selector,true);
    await wait(`document.querySelector(${JSON.stringify(status)})?.textContent===${JSON.stringify(catalog['job.saved'])}`,'986 live answer saved');
    if(painting)observation.savedPainting=await assertPaintingPersists(painting);
    assert.equal(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(submit)}).hidden`),true);
    const footer=await page!.evaluate<string>(`document.getElementById('message').textContent`);
    assert.equal(footer,await page!.evaluate<string>(`document.getElementById('dirty').textContent`));
    observation.savedFooter=footer;
    assert.equal(await page!.evaluate<string>(`document.querySelector(${JSON.stringify(selector+' .interview-questions>p')}).textContent`),
     catalog['interview.answered'].replace('{0}','1').replace('{1}','1'),'progress counts the saved question');
    const path=join(out,'one-screen.json');assert.ok(existsSync(path));
    const bytes=await readFile(path,'utf8'),act=parseRecordAct(JSON.parse(bytes));
    assert.equal(act.at,'2026-11-08T12:00:00.000Z');
    if(act.kind!=='interview-picks')throw new Error('Expected interview-picks');
    assert.equal(act.value.note,'');assert.equal(JSON.stringify(act.value),baseline.expectedValueBytes);
    const expected=prepareJobRecordAct({jobId:fixture.session.jobId,submission:{...fixture.submissions.at(-1)!,value:JSON.parse(baseline.expectedValueBytes)},
     ask:fixture.ask,retained:fixture.session.retainedSourceV3(fixture.ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},
     actId:'act-interview-picks',at:'2026-11-08T12:00:00.000Z'});
    assert.equal(bytes,JSON.stringify(expected),'full empty-note act bytes equal 60d7f17 serializer/writer control');
    observation.emptyNoteByteControl={sourceCommit:baseline.sourceCommit,valueBytes:baseline.expectedValueBytes,fullActByteEqual:true};
    assert.deepEqual(act.value.selections,[{itemId:'topology',optionId:'topology_other',otherText},{itemId:'detail_level',optionId:'density_auto',otherText:null}]);
    observation.persistedAct={bytes:Buffer.byteLength(bytes),oneScreenSha256:sha(bytes),oneScreenFile:path};
    await writeFile(join(out,'one-screen-submitted.png'),await page!.screenshot());
    await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');cases.push(observation);persistedActs++;
    console.log('750_BROWSER_CASE_PASS '+language+' '+width+'x'+height+' bytes='+Buffer.byteLength(bytes));
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before,'inspected source files remain immutable');
  }finally{holdImages=false;for(const requestId of pausedImages.splice(0))await command!('Fetch.continueRequest',{requestId});await page!.goto('about:blank');await fixture.close();}
 }
 await longInterviewScrollChecks(false);
}

async function twoImageDrawerChecks(){
 const sizes=[{width:1440,height:900},{width:900,height:410}] as const;
 const form='form.interview-answer',drawer='#workspace-drawer-inspectorHeight';
 for(const language of ['en','ko'] as const)for(const {width,height} of sizes){
  const fixture=await joinedFixture(),out=join(output,'joined',language,`${width}x${height}`);
  await mkdir(out,{recursive:true});
  try{
   const question=readProject(fixture.root).questions[0]!;
   assert.deepEqual(question.images.map(image=>image.name),['source.svg','alternate.svg']);
   const before=await jobInputHashes(fixture.root),url=fixtureUrl(fixture.ownerUrl,language);
   await page!.setViewport(width,height);await page!.goto('about:blank');await page!.goto(url);
   await waitForQuestion(form);
   const first=await readPainting(32);
   const screen=await page!.evaluate<{lang:string;width:number;height:number;modelCanvas:number;commentHidden:boolean;controls:string[]}>(`({
    lang:document.documentElement.lang,width:innerWidth,height:innerHeight,modelCanvas:document.querySelectorAll('#rig-root canvas').length,
    commentHidden:document.getElementById('stage-comment').hidden,
    controls:[...document.querySelectorAll(${JSON.stringify(controlSelector)})].map(node=>node.id)
   })`);
   assert.deepEqual(screen,{lang:language,width,height,modelCanvas:0,commentHidden:true,controls:sharedControls});
   const narrow=width===900,dialogs=await assertNoDialogViewer();
   assert.deepEqual(dialogs.filter(dialog=>dialog.open).map(dialog=>({id:dialog.id,modal:dialog.modal})),
    narrow?[{id:'workspace-drawer-inspectorHeight',modal:false}]:[]);
   if(narrow){
    assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('${drawer}[open]:not(:modal) ${questionRoot} ${form}')`),true);
   }
   await writeFile(join(out,'question.png'),await page!.screenshot());
   // Click the main toolbar while the narrow drawer still holds the form.
   await selectInterviewImage(1);
   const alternate=await readPainting(480,1);
   assert.notEqual(alternate.src,first.src);
   assert.ok(new URL(alternate.src).pathname.endsWith('/api/interview/image/'+question.ref.sha256+'/1'));
   if(narrow)assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('${drawer}[open]:not(:modal)')`),true);
   const camera=narrow?null:await sharedCameraChecks();
   await writeFile(join(out,'alternate.png'),await page!.screenshot());
   assert.deepEqual(await jobInputHashes(fixture.root),before);
   const observation={language,width,height,screen,dialogs,first,alternate,camera};
   await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');
   cases.push(observation);
  }finally{await page!.goto('about:blank');await fixture.close();}
 }
}

type Plan1004State={rows:{label:string;answered:boolean;current:boolean}[];chip:{text:string;visible:boolean;onScreen:boolean;rect?:unknown};rule:string;submit:{text:string;disabled:boolean;visible:boolean};inList:boolean;inQuestionTab:boolean};
/** #1004 step 0 plan fixture: K = 4 joined questions, the mock single submit and the partial-answer rule. */
async function plan1004Checks(){
 for(const language of ['en','ko'] as const)for(const answered of [2,4] as const){
  const fixture=await joinedFixture({answered}),out=join(output,'plan-1004',language,answered+'-of-4');
  await mkdir(out,{recursive:true});
  try{
   const questions=readProject(fixture.root).questions;assert.equal(questions.length,4);
   await page!.setViewport(1440,900);await page!.goto('about:blank');await page!.goto(fixtureUrl(fixture.ownerUrl,language));
   await waitForQuestion('form.interview-answer');
   await wait(`document.querySelectorAll('${questionRoot} nav.interview-questions button.interview-question').length===4&&document.querySelector('[data-plan-1004]')?.getAttribute('data-plan-answered')==='${answered}'`,'1004 list and mock');
   const state=()=>page!.evaluate<Plan1004State>(`(()=>{const visible=n=>!!n&&n.getClientRects().length>0&&getComputedStyle(n).visibility==='visible';
    const nav=document.querySelector('${questionRoot} nav.interview-questions'),mock=document.querySelector('[data-plan-1004]'),chip=mock.querySelector('[data-plan-1004-chip]'),submit=mock.querySelector('[data-plan-1004-submit]');
    return {rows:[...nav.querySelectorAll('button.interview-question')].map(b=>({label:b.textContent,answered:b.hasAttribute('data-answered'),current:b.getAttribute('aria-current')==='true'})),
     chip:{text:chip.textContent,visible:visible(chip),onScreen:(r=>r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth)(chip.getBoundingClientRect())},rule:mock.querySelector('[data-plan-1004-rule]').textContent,
     submit:{text:submit.textContent,disabled:submit.disabled,visible:visible(submit)},inList:nav.firstElementChild===mock,
     inQuestionTab:!!document.querySelector('${questionRoot}')?.contains(mock)&&!!document.querySelector(${JSON.stringify(questionTab)})};})()`);
   const shown=await state();await writeFile(join(out,'plan.png'),await page!.screenshot());
   assert.deepEqual(shown.rows.map(row=>row.answered),[0,1,2,3].map(index=>index<answered));
   assert.deepEqual({chip:shown.chip,rule:shown.rule,disabled:shown.submit.disabled,submitVisible:shown.submit.visible,inList:shown.inList,inQuestionTab:shown.inQuestionTab},
    {chip:{text:PLAN_1004_TEXT[language].chip,visible:true,onScreen:true},rule:PLAN_1004_TEXT[language].rule,disabled:false,submitVisible:true,inList:true,inQuestionTab:true});
   assert.equal(shown.submit.text,(language==='ko'?koCatalog:enCatalog)['Submit review']+` (${answered}/4)`);
   const selected=shown.rows.findIndex(row=>row.current);assert.equal(selected,answered===2?2:0);
   const painting=await readPainting(32);
   assert.ok(new URL(painting.src).pathname.endsWith('/api/interview/image/'+questions[selected]!.ref.sha256+'/0'),painting.src);
   // Select another question in the existing list: the shared main view follows the selection.
   const other=answered===2?0:3;
   // The list column scrolls; the mock above it can push a row below the panel's default height.
   await clickFormControl(`${questionRoot} nav.interview-questions li:nth-child(${other+1}) button`);
   await wait(`document.querySelector('${questionRoot} nav.interview-questions li:nth-child(${other+1}) button')?.getAttribute('aria-current')==='true'&&!!document.querySelector('[data-plan-1004]')`,'1004 select');
   const switched=await readPainting(32);
   assert.ok(new URL(switched.src).pathname.endsWith('/api/interview/image/'+questions[other]!.ref.sha256+'/0'),switched.src);
   const after=await state();assert.equal(after.chip.visible,true);assert.equal(after.chip.onScreen,true);assert.equal(after.submit.text,shown.submit.text);
   await writeFile(join(out,'selected-'+(other+1)+'.png'),await page!.screenshot());
   const observation={language,answered,shown,selected:selected+1,painting:painting.src,switchedTo:other+1,switchedPainting:switched.src,after};
   await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');
   console.log('1004_PLAN_CASE '+JSON.stringify({language,answered,selected:selected+1,switchedTo:other+1,submit:shown.submit.text,chip:shown.chip.text}));
   cases.push(observation);
  }finally{await page!.goto('about:blank');await fixture.close();}
 }
}

/** The waiting layout can dock the inspector before the first publication binds its Question tab. */
async function firstQuestionInDrawer(){
 holdImages=false;
 for(const language of ['en','ko'] as const){
  const out=join(output,'first-question-drawer',language);
  await mkdir(out,{recursive:true});
  const fixture=await recordScreenFixture('interview-picks',false,out,undefined,false,true,undefined,false,true,'bound-rig');
  const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
  const body='#workspace-drawer-inspectorHeight > .inspector-body',panel=body+' > #workspace-interview-answer';
  const errorsBefore=consoleErrors.length;
  try{
   await page!.setViewport(1000,320);
   await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`!!document.querySelector('${body}')&&document.querySelector('#workspace-ask-headline')?.checkVisibility()`,'941 waiting inspector docked');
   const before:{inRoot:boolean;drawerBodies:number;height:number}=await page!.evaluate(`({
    inRoot:!!document.querySelector('#app .inspector-body'),drawerBodies:document.querySelectorAll('${body}').length,height:innerHeight
   })`);
   assert.deepEqual(before,{inRoot:false,drawerBodies:1,height:320});
   await writeFile(join(out,'before-delivery.json'),JSON.stringify(before));
   fixture.deliver();
   const options=panel+' form[data-job-ask] label.interview-option';
   await withDeadline('941 first publication or refusal',20_000,async signal=>{
    while(!signal.aborted){
     if(consoleErrors.length>errorsBefore||await page!.evaluate<boolean>(`!!document.querySelector('${options}')`))return;
     await Bun.sleep(30);
    }
    throw signal.reason;
   });
   const after:{language:string;options:string[];drawerOpen:boolean}=await page!.evaluate(`({
    language:document.documentElement.lang,
    options:[...document.querySelectorAll('${options}')].filter(node=>node.checkVisibility()).map(node=>node.textContent.trim()),
    drawerOpen:document.querySelector('#workspace-drawer-inspectorHeight').open
   })`);
   const errors=consoleErrors.slice(errorsBefore);
   await writeFile(join(out,'after-delivery.json'),JSON.stringify({after,errors},null,2));
   await writeFile(join(out,'first-load.png'),await page!.screenshot());
   console.log('941_FIRST_QUESTION '+JSON.stringify({language,before,after,errors}));
   assert.equal(errors.length,0,JSON.stringify(errors));
   assert.equal(after.language,language);assert.equal(after.drawerOpen,true);
   assert.ok(after.options.length>0,'first publication shows visible option labels in the inspector drawer');
  }finally{await fixture.close();}
 }
}

try{
 // Reuse the shared launcher's browser discovery and process policy without a suite-local wrapper.
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;if(event.method==='Fetch.requestPaused'){const id=event.params!.requestId as string;if(holdImages)pausedImages.push(id);else void send('Fetch.continueRequest',{requestId:id});}if(event.method==='Runtime.consoleAPICalled'&&event.params?.type==='error')consoleErrors.push(event.params);if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Fetch.enable',{patterns:[{urlPattern:'*/api/interview/image/*'}]});
 await command!('Runtime.enable');await command!('Network.enable');await command!('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__record750legacySeen=false;new MutationObserver(()=>{if(document.body?.classList.contains('job-window')||document.querySelector('[data-job-forms]'))globalThis.__record750legacySeen=true;}).observe(document,{subtree:true,childList:true,attributes:true});`});
 if(Bun.argv.includes('--plan-1004')){await plan1004Checks();assert.equal(exceptions.length,0,JSON.stringify(exceptions));assert.equal(consoleErrors.length,0,JSON.stringify(consoleErrors));console.log('1004_PLAN_PASS '+JSON.stringify({cases:cases.length,exceptions:exceptions.length,consoleErrors:consoleErrors.length}));}
 else if(Bun.argv.includes('--first-question-drawer'))await firstQuestionInDrawer();
 else if(boundRigPictureOnly)await boundRigPictureChecks();
 else if(postQuestionPictures)await postQuestionPictureChecks();
 else if(followup839){holdImages=false;await followupQuestionChecks();}else{
 await firstQuestionInDrawer();
 if(!completedPicture||workspace986)await liveQuestionDraftChecks();
 if(workspace986)await twoImageDrawerChecks();
 if(completedPicture||workspace986)await questionTabChecks();
 if(!interviewOnly&&!freshParts&&!completedPicture){
  await postQuestionPictureChecks();
  await boundRigPictureChecks();
 }
 assert.equal(exceptions.length,0,'no browser exceptions');
 assert.ok(mutations.every(request=>/\/ui\/(?:displayed|acts)$/.test(request.path)),'no backdrop mutation requests');
 const result={cases:cases.length,persistedActs,persistedByteComparisons:persistedActs,languages:['en','ko'],workspace986,exceptions,mutations,browserWorkers:'shared launchCdpSession defaults'};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('750_BROWSER_PASS '+JSON.stringify(result));
 }
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,completedCases:cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
