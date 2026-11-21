/** #750/#986 ordinary Nova browser checks for the shared Question panel and main viewport.
 * The live-job fixture uses retained record reader/writer doubles and public synthetic assets.
 * --serve starts a loopback fixture for interactive review without launching Chromium. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {optionSetsJobFixture,recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE,SYNTHETIC_RIG_RGB} from './helpers/job-record-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
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
import {partsDifferenceJobFixture,partsDifferenceOwnerUrl} from './helpers/parts-difference-job-fixture.ts';
import {JOB_COMMENTS_ACT_SCHEMA} from '../src/job-contract.ts';
import {jobWindowResources} from '../src/job-front.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const interviewOnly=Bun.argv.includes('--interview-only');
const completedPicture=Bun.argv.includes('--completed-picture')||Bun.argv.includes('--question-tab');
const freshParts=Bun.argv.includes('--fresh-parts');
const narrowQuestionResize=Bun.argv.includes('--question-narrow-resize');
const postQuestionPictures=Bun.argv.includes('--post-question-pictures');
const boundRigPictureOnly=Bun.argv.includes('--bound-rig-picture');
const workspace986=Bun.argv.includes('--workspace-986');
const questionRoot='#workspace-interview-answer';
// #1041: the Question is a section of the right communication panel; this selector is its heading.
const questionTab='#workspace-communication #workspace-interview-answer:not([hidden]) .review-dialog-header h2';
const sharedControls=['zoom-in','zoom-out','fit','native-one','view-menu'];
const controlSelector=sharedControls.map(id=>'#'+id).join(',');
const dialogViewer='canvas,video,.viewport,.interview-view,.interview-viewport,.view-zoom,.zoom-controls,'+controlSelector;
const paintingSelector='#reference-content img';
const otherText='  Custom topology · 직접 입력\n';
type Rect={x:number;y:number;width:number;height:number;left:number;top:number;right:number;bottom:number};
const baseline=await Bun.file(new URL('./fixtures/interview-722-empty-note.json',import.meta.url)).json();
// #1041: the question scrolls inside the right communication column; measure its nearest scrolling ancestor.
const scrollerSource=`const scroller=form=>{for(let n=form.parentElement;n;n=n.parentElement){if(n.scrollHeight>n.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(n).overflowY))return n;}return form.closest('#workspace-interview-answer');};`;
async function assertLastAskPickKeepsScrollAndFocus(mode:string){
 const scrollBefore=await page!.evaluate<number>(`(()=>{${scrollerSource}
  const form=document.querySelector('form[data-job-ask="ask-interview-picks"]');
  const panel=scroller(form);
  const firstOption=form.querySelector('fieldset.interview-ask:last-of-type label.interview-option');
  const pr=panel.getBoundingClientRect(),or=firstOption.getBoundingClientRect();
  panel.scrollTop=Math.max(0,Math.min(panel.scrollHeight-panel.clientHeight,panel.scrollTop+(or.top-pr.top)-4));
  return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(panel.scrollTop))));
 })()`);
 assert.ok(scrollBefore>0,`#875 ${mode} panel scrolls before changing pick`);
 await click(page!,'form[data-job-ask="ask-interview-picks"] label.interview-option:has(input[value="cloth_sim_other"])');
 await page!.evaluate<void>(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 const afterOther=await page!.evaluate<{scrollTop:number;active:boolean}>(`(()=>{${scrollerSource}
  const form=document.querySelector('form[data-job-ask="ask-interview-picks"]');
  const panel=scroller(form);
  const other=form.querySelector('input[type=radio][name="choice.cloth_sim"][value="cloth_sim_other"]');
  return {scrollTop:panel.scrollTop,active:document.activeElement===other};
 })()`);
 assert.equal(afterOther.scrollTop,scrollBefore,`#875 ${mode} scrollTop unchanged after picking other in last ask`);
 assert.equal(afterOther.active,true,`#875 ${mode} document.activeElement unchanged after picking other in last ask`);
 await click(page!,'form[data-job-ask="ask-interview-picks"] label.interview-option:has(input[value="cloth_baked"])');
 await page!.evaluate<void>(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 const afterBaked=await page!.evaluate<{scrollHeight:number;clientHeight:number;scrollTop:number;active:boolean}>(`(()=>{${scrollerSource}
  const form=document.querySelector('form[data-job-ask="ask-interview-picks"]');
  const panel=scroller(form);
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

async function joinedFixture(){
 const fixture=await interviewOpenFixture();
 let host:Awaited<ReturnType<typeof startOpenWorkspace>>|undefined;
 try{
  // Extend the public fixture with a visibly different second painting for a real menu switch.
  {const optionPath=join(fixture.root,'evidence/options.json');
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
  return {root:fixture.root,ownerUrl:url.href,async close(){try{await running.stop();}finally{await fixture.close();}}};
 }catch(error){
  try{await host?.stop();}finally{await fixture.close();}
  throw error;
 }
}

if(Bun.argv.includes('--serve')){
 const language=arg('--lang')??'en';
 assert.ok(language==='en'||language==='ko','--lang must be en or ko');
 const kind=arg('--fixture')??'live';
 assert.ok(kind==='live'||kind==='joined'||kind==='joined-plan-1004'||kind==='pictureless','--fixture must be live, joined, joined-plan-1004 or pictureless');
 const answered=Number(arg('--answered')??'0'),painting=arg('--painting');
 assert.ok(painting===undefined||kind==='joined-plan-1004'&&isAbsolute(painting),'--painting takes an absolute PNG path with --fixture joined-plan-1004');
 assert.ok(kind!=='joined-plan-1004'||[0,2,4].includes(answered),'--answered must be 0, 2 or 4');
 // #1004: the real job page, K = 4 sets on one publication, `answered` drafts seeded (recommended picks).
 const fixture=kind==='joined-plan-1004'?await optionSetsJobFixture({count:4,answered,...painting!==undefined?{painting:await readFile(painting)}:{}}):kind==='joined'?await joinedFixture():await recordScreenFixture('interview-picks',false,output,undefined,false,kind==='live');
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
async function selectBlock(target:string){
 if(target==='feedback'){
  await click(page!,'#stage-comment');
  // #1041: Comments and the Question are sections of one communication panel; Comment · C reveals Comments beside the Question.
  await wait("!!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')",'986 Comments active');
  return;
 }
 const selector=`.workspace-bottom-tabs>.block-row:not([hidden]) [data-block-target="${target}"]`;
 if(await page!.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('data-tab-overflow')`)){
  await click(page!,'.workspace-bottom-tabs>.block-row:not([hidden]) .workspace-tabs-more');await click(page!,`.workspace-tabs-menu:not([hidden]) [data-block-more-target="${target}"]`);
 }else await click(page!,selector);
}

/* #1041 retired the flag-only #839 questionTabChecks and followupQuestionChecks: the Question is no longer a bottom
 * strip tab. The handover maps each retired assertion to its right-panel home. */
async function assertNoPictureQuestionTab(reason:string,catalog:Record<string,string>,selector='form.interview-answer'){
 const state=await page!.evaluate<{
  tabOpen:boolean;
  tabLabel:string;
  formInTab:boolean;
  tabHasReason:boolean;
  controls:{id:string;kind:string;ownLabel:string;accessibleName:string;ariaDescription:string|null;title:string|null}[];
 }>(`(()=>{
  // #1041: the Question is a section of the right communication panel; its heading stands for the old tab.
  const tab=document.querySelector(${JSON.stringify(questionTab)});
  const tabRect=tab?.getBoundingClientRect();
  const panel=document.querySelector('#workspace-interview-answer:not([hidden])');
  const form=panel?.querySelector(${JSON.stringify(selector)});
  const formRect=form?.getBoundingClientRect();
  const declaredLabels={
   'idle-blink-marker':${JSON.stringify(catalog['Blink time'])},
   'play':${JSON.stringify(catalog['Play'])},
   'report-previous':${JSON.stringify(catalog['Previous event page'])},
   'report-next':${JSON.stringify(catalog['Next event page'])},
  };
  const nodes=[...document.querySelectorAll('.inspector [role="tab"]:disabled,.inspector input[type="checkbox"]:disabled:not([aria-hidden="true"]),.workspace-secondary-toolbar input[type="checkbox"]:disabled,.inspector button:not([role="tab"]):disabled,.workspace-secondary-toolbar button:disabled')];
  const controls=nodes.map(control=>{
   const labelledBy=control.getAttribute('aria-labelledby');
   const byText=labelledBy?labelledBy.split(/\\s+/).map(id=>document.getElementById(id)?.textContent?.trim()??'').filter(Boolean).join(' '):'';
   const wrapping=control.closest('label'),explicit=control.id?document.querySelector('label[for="'+control.id+'"]'):null;
   const ownLabel=(declaredLabels[control.id]||byText||(control.tagName==='BUTTON'?(control.childElementCount?control.childNodes[0]?.textContent:control.textContent):(wrapping?(wrapping.querySelector('span')?.textContent??[...wrapping.childNodes].find(n=>n.nodeType===3&&n.nodeValue?.trim())?.nodeValue):explicit?.textContent))||'').trim();
   const accessibleName=(byText||control.getAttribute('aria-label')||control.textContent||control.getAttribute('title')||'').trim();
   const kind=control.getAttribute('role')==='tab'?'tab':control.tagName==='INPUT'?'checkbox':'button';
   return {id:control.id||control.tagName.toLowerCase(),kind,ownLabel,accessibleName,ariaDescription:control.getAttribute('aria-description'),title:control.getAttribute('title')};
  });
  return {
   tabOpen:!!tab&&!!tabRect&&tabRect.width>0&&tabRect.height>0,
   tabLabel:tab?.textContent?.trim()??'',
   formInTab:!!form&&!!formRect&&formRect.width>0&&formRect.height>0,
   tabHasReason:!!panel&&panel.textContent.includes(${JSON.stringify(reason)}),
   controls,
  };
 })()`);
 assert.equal(state.tabOpen,true,'#955 Question tab is visible and selected on no-picture question page');
 assert.equal(state.tabLabel,catalog['Question'],'#955 Question tab label');
 assert.equal(state.formInTab,true,'#955 Question tab holds the question form');
 assert.equal(state.tabHasReason,true,'#955 Question tab states the missing-picture absence sentence');
 assert.ok(state.controls.some(c=>c.kind==='tab')&&state.controls.some(c=>c.kind==='checkbox')&&state.controls.some(c=>c.kind==='button'),'#955 unavailable tabs, checkboxes, and buttons are present');
 for(const control of state.controls){
  assert.ok(control.ownLabel.length>0,`#955 ${control.kind}#${control.id} has its own visible label`);
  assert.equal(control.accessibleName,control.ownLabel,`#955 ${control.kind}#${control.id} accessible name is its own label`);
  assert.notEqual(control.accessibleName,reason,`#955 ${control.kind}#${control.id} accessible name is not the missing-picture reason`);
  assert.equal(control.ariaDescription,reason,`#955 ${control.kind}#${control.id} aria-description is the missing-picture reason`);
  assert.notEqual(control.title,reason,`#955 ${control.kind}#${control.id} title is not the missing-picture reason`);
 }
 const ax=await command!('Accessibility.getFullAXTree') as {nodes?:{ignored?:boolean;role?:{value?:string};name?:{value?:string};description?:{value?:string};properties?:{name:string;value?:{value?:unknown}}[]}[]};
 const axNodes=ax.nodes??[];
 assert.equal(axNodes.some(node=>['tab','checkbox','button'].includes(node.role?.value??'')&&node.name?.value===reason),false,'#955 no tab, checkbox, or button in AXTree uses the missing-picture reason as its accessible name');
 const axDisabled=axNodes.filter(node=>!node.ignored&&['tab','checkbox','button'].includes(node.role?.value??'')&&node.properties?.some(p=>p.name==='disabled'&&p.value?.value===true)&&node.description?.value===reason);
 assert.ok(axDisabled.length>=3,'#955 AXTree reports visible disabled controls with aria-description');
 for(const node of axDisabled){
  assert.ok((node.name?.value?.trim().length??0)>0,'#955 AXTree node has non-empty accessible name');
  assert.notEqual(node.name?.value,reason,'#955 AXTree accessible name is own label, not the missing-picture reason');
  assert.equal(node.description?.value,reason,'#955 AXTree description is the missing-picture reason');
 }
}

/** The footer caption names the camera mode the Camera sync checkbox shows, before and after a toggle. */
async function assertCameraCaptionFollowsSync(catalog:Record<string,string>) {
 const read = () => page!.evaluate<{checked:boolean;caption:string}>(`({
  checked:document.getElementById('camera-sync').checked,caption:document.getElementById('coordinates').textContent})`);
 const expected = (checked:boolean) => catalog[checked
  ? 'Cameras synchronized · drag to pan · scroll to zoom' : 'Independent cameras · drag to pan · scroll to zoom'];
 const initial = await read();
 assert.equal(initial.caption,expected(initial.checked),'#993 camera caption follows the camera-sync checkbox');
 await click(page!,'#camera-sync');
 await wait(`document.getElementById('camera-sync').checked===${!initial.checked}`,'#993 camera-sync toggled');
 const toggled = await read();
 assert.equal(toggled.caption,expected(toggled.checked),'#993 camera caption follows the camera-sync checkbox after a toggle');
 await click(page!,'#camera-sync');
 await wait(`document.getElementById('camera-sync').checked===${initial.checked}`,'#993 camera-sync restored');
 assert.equal((await read()).caption,expected(initial.checked),'#993 camera caption follows the camera-sync checkbox after restore');
}
async function assertOriginalPainting(base: string, expectedHash: string) {
 await wait(`(()=>{const image=document.querySelector('#reference-content img');
  return !!image?.naturalWidth && image.checkVisibility() && image.getBoundingClientRect().width>0;
 })()`,'955 original painting in the main view');
 const image = await page!.evaluate<{src:string;rgba:number[]}>(`(()=>{
  const image=document.querySelector('#reference-content img'),canvas=document.createElement('canvas');
  canvas.width=canvas.height=2;
  const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  return {src:image.currentSrc,rgba:[...ctx.getImageData(0,0,1,1).data]};
 })()`);
 assert.deepEqual(image.rgba,[40,160,220,255]);
 assert.ok(new URL(image.src).pathname.startsWith(base+'interview/image/'));
 const response = await fetch(image.src);
 assert.equal(response.status,200);
 assert.equal(sha(new Uint8Array(await response.arrayBuffer())),expectedHash);
 return expectedHash;
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
     const catalog=language==='en'?enCatalog:koCatalog;
     const text=await page!.evaluate<string>(`document.querySelector('#rig-empty').textContent`);
     assert.equal(text,catalog[key]);
     if(variant!=='legacy') observation.sha256=await assertOriginalPainting(
      fixture.display.routes.apiBase,sha(await readFile(join(fixture.root,'inputs/reference.png'))));
     await assertNoPictureQuestionTab(catalog[key],catalog);
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
    let paintingSha256: string | undefined;
    if (pictured) {
     const actualRig = catalog['@rig-c/play · Actual rig'];
     await wait(`document.querySelector('#player-state')?.textContent===${JSON.stringify(actualRig)}&&
      document.querySelector('#animation-select')?.value==='idle'&&
      document.querySelector('#rig-empty')?.hidden===true&&
      !!document.querySelector('#workspace-interview-answer ${selector}')&&
      !!document.querySelector('${questionTab}')`,
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
     await assertNoPictureQuestionTab(missingPicture,catalog,selector);
     if (variant==='rig-signoff-hash') {
      paintingSha256=await assertOriginalPainting(
       fixture.display.routes.apiBase,sha(await readFile(join(fixture.root,'inputs/reference.png'))));
      await assertCameraCaptionFollowsSync(catalog);
     }
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
    observations.push({variant,language,visit,suppressed,paintedPixels,paintingSha256,missingPicture,assetRequests,controls,sourceHash:publication.source.sourceHash,
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

// #1041: the Question is in the right communication panel; its own separator resizes it.
async function resizeQuestionPanel(){
 const selector='.workspace-communicationWidth[role=separator]';
 const range=()=>page!.evaluate<{value:number;min:number;max:number}>(`(()=>{
  const handle=document.querySelector('${selector}');
  return {value:Number(handle.getAttribute('aria-valuenow')),min:Number(handle.getAttribute('aria-valuemin')),max:Number(handle.getAttribute('aria-valuemax'))};
 })()`);
 await click(page!,selector);
 const before=await range();
 assert.ok(before.max>before.min,'communication separator offers a resize range');
 const key=before.value<before.max?'End':'Home',keyCode=key==='End'?35:36;
 await command!('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:keyCode});
 await command!('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:keyCode});
 const after=await range();
 assert.ok(key==='End'?after.value>before.value:after.value<before.value,JSON.stringify({before,after}));
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
     // #1041: the communication panel is narrow, so its container query stacks the question list above the fields.
     assert.ok(layout.fields.top>=layout.list.bottom-1,'the Question panel stacks the list above the fields');
     assert.equal(layout.controlsReached,11,JSON.stringify(layout.targets.filter(item=>item.control)));
     assert.equal(layout.allHit,true,JSON.stringify(layout.targets));assert.equal(layout.allVisible,true,JSON.stringify(layout.targets));
     assert.ok(layout.documentScrollHeight<=layout.documentClientHeight+1);
     // #1041: the tall communication column may need no scrolling; if anything scrolls it is the question or its column.
     assert.ok(layout.scrollAncestors.filter(node=>node.scrollHeight>node.clientHeight+1).every(node=>['workspace-interview-answer','workspace-communication'].includes(node.id)));
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
    // Carried from the retired #839 questionTabChecks: the completed answer leaves no act controls and one saved state,
    // and the question painting cannot take a pointed comment.
    assert.equal(await page!.evaluate<boolean>(`['workspace-pending-ask','save','request-changes'].every(id=>document.getElementById(id).hidden)&&document.querySelector('#workspace-act-row').hidden`),true,'completed answer controls hidden');
    assert.deepEqual(await page!.evaluate<string[]>(`['dirty','review-draft-state','draft-state'].filter(id=>{const n=document.getElementById(id);return n.getClientRects().length>0&&!!n.textContent.trim();})`),['dirty'],'single visible saved state');
    if(painting){
     await click(page!,'#stage-comment');
     await wait(`!document.querySelector('#rig-viewport.stage-comment-mode,#reference-viewport.stage-comment-mode')`,'question image keeps pin mode unavailable');
     await click(page!,'#reference-viewport');
     assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('.stage-comment-composer')`),false,'no pointed comment composer on the question image');
    }
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

async function draftSurvivalChecks(){
 holdImages=false;
 const out=join(output,'draft-survival');await mkdir(out,{recursive:true});
 const lookRoot=resolve('evidence/look');
 for(const lang of ['en','ko'] as const){
  await mkdir(join(out,'look',lang),{recursive:true});
  await mkdir(join(lookRoot,lang),{recursive:true});
 }
 const saveLook=async(lang:'en'|'ko',name:string)=>{
  const png=await page!.screenshot();
  await writeFile(join(out,'look',lang,name),png);
  await writeFile(join(lookRoot,lang,name),png);
 };
 const fixture=await recordScreenFixture('checkpoint',false,out);
 try{
  const url=new URL(fixture.ownerUrl);url.searchParams.set('lang','en');
  await page!.setViewport(1440,900);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`!!document.querySelector('#stage-comment-list')&&!!document.querySelector('form[data-job-ask="ask-checkpoint"] fieldset:not(:disabled)')`,'992 initial load');
  const addGeneral=async(text:string,frameId?:string)=>{
   const root=frameId?`document.getElementById(${JSON.stringify(frameId)}).contentDocument`:'document';
   await page!.evaluate<void>(`${root}.querySelector('[data-comment-general]').click()`);
   await wait(`!!${root}.querySelector('.stage-comment-composer input')`,'992 composer open');
   await page!.evaluate<void>(`(()=>{const f=${root}.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);
   await wait(`!${root}.querySelector('.stage-comment-composer')`,'992 composer saved');
  };
  const readRows=(frameId?:string)=>page!.evaluate<string[]>(`(()=>{const root=${frameId?`document.getElementById(${JSON.stringify(frameId)}).contentDocument`:'document'};return [...root.querySelectorAll('#stage-comment-list .stage-comment-summary')].map(n=>n.textContent);})()`);
  // Bar 1: Reload
  await addGeneral('c1 · reload survival');
  assert.equal((await readRows()).length,1);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1&&!!document.querySelector('form[data-job-ask="ask-checkpoint"] fieldset:not(:disabled)')`,'992 bar 1 reload');
  assert.equal((await readRows())[0]?.endsWith('c1 · reload survival'),true);
  // Bar 2: Republish, same job, draft and source hash
  const pub2=await fixture.session.execute({schema:'rig-review/job-api@3',jobId:fixture.session.jobId,requestId:'992-republish-same',verb:'publish',expectedGeneration:fixture.session.status().generation,idempotencyKey:'992-republish-same',result:fixture.workspace.result,freeze:{kind:'producer-held',holdId:'992-hold-2',record:fixture.workspace.record}},new AbortController().signal) as {publicationId:string;generation:number;source:typeof fixture.display.publication.source};
  const display2=fixture.session.displayPublication(pub2.publicationId);
  const ask2={...fixture.ask,askId:'ask-checkpoint-2',publicationId:pub2.publicationId,source:pub2.source};
  fixture.fake.publish(display2);fixture.fake.pending(ask2,pub2.generation);
  await wait(`!!document.querySelector('form[data-job-ask="ask-checkpoint-2"] fieldset:not(:disabled)')`,'992 bar 2 republish');
  assert.equal((await readRows())[0]?.endsWith('c1 · reload survival'),true);
  // Bar 4: Two tabs (tab A has c1, tab B adds c2, both survive in both tabs and after reload; removal in A does not come back from B)
  await page!.evaluate<void>(`(()=>{
   const [key,raw]=Object.entries(localStorage).find(([k])=>k.startsWith('rig-review-record-comments/1:'));
   const saved=JSON.parse(raw);
   const next=JSON.stringify({...saved,comments:[...saved.comments,{id:'c2-id',summary:'c2 · from tab B'}]});
   localStorage.setItem(key,next);
   window.dispatchEvent(new StorageEvent('storage',{key,newValue:next}));
   // Deliver a late/stale storage event carrying only [c1] after [c1,c2] is in localStorage; both must survive.
   window.dispatchEvent(new StorageEvent('storage',{key,newValue:raw}));
  })()`);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===2`,'992 bar 4 storage event pickup');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c1 · reload survival','c2 · from tab B']);
  // Remove c1 in tab A; it must not come back on subsequent write or reload
  await page!.evaluate<void>(`document.querySelector('#stage-comment-list .stage-comment-summary').click()`);
  await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'992 bar 4 delete button');
  await page!.evaluate<void>(`document.querySelector('.stage-comment-composer .stage-comment-delete').click()`);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1`,'992 bar 4 delete synced');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c2 · from tab B']);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1&&!!document.querySelector('form[data-job-ask="ask-checkpoint-2"] fieldset:not(:disabled)')`,'992 bar 4 reload after delete');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c2 · from tab B']);
  // Bar 3: Republish with a changed source hash
  const updatedEvidence=await readFile(join(fixture.root,'plan/context-evidence.json'),'utf8')+'\n';
  await writeFile(join(fixture.root,'plan/context-evidence.json'),updatedEvidence);
  const updatedEvidenceHash=sha(updatedEvidence);
  const planContext=fixture.workspace.context as unknown as {files:{path:string;sha256:string}[]};
  planContext.files=planContext.files.map(f=>f.path==='plan/context-evidence.json'?{...f,sha256:updatedEvidenceHash}:f);
  const pub3=await fixture.session.execute({schema:'rig-review/job-api@3',jobId:fixture.session.jobId,requestId:'992-republish-changed',verb:'publish',expectedGeneration:fixture.session.status().generation,idempotencyKey:'992-republish-changed',result:fixture.workspace.result,freeze:{kind:'producer-held',holdId:'992-hold-3',record:fixture.workspace.record}},new AbortController().signal) as {publicationId:string;generation:number;source:typeof fixture.display.publication.source};
  assert.notEqual(pub3.source.sourceHash,pub2.source.sourceHash);
  const display3=fixture.session.displayPublication(pub3.publicationId);
  const ask3={...fixture.ask,askId:'ask-checkpoint-3',publicationId:pub3.publicationId,source:pub3.source};
  fixture.fake.publish(display3);fixture.fake.pending(ask3,pub3.generation);
  await wait(`!!document.querySelector('form[data-job-ask="ask-checkpoint-3"] fieldset:not(:disabled)')`,'992 bar 3 changed source');
  await page!.evaluate<void>(`document.querySelector('#job-record-asks')?.close()`);
  await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const carryKey='The source changed, so {0} unsent comment(s) could not be carried over. Please add them again.';
  const expectedCarryEn=enCatalog[carryKey]!.replace('{0}','1');
  const expectedCarryKo=koCatalog[carryKey]!.replace('{0}','1');
  const bar3State=await page!.evaluate<{currentCount:number;oldRetained:boolean;draftState:string;dirty:string}>(`({
   currentCount:document.querySelectorAll('#stage-comment-list .stage-comment-item').length,
   oldRetained:Object.entries(localStorage).some(([k,v])=>k.startsWith('rig-review-record-comments/1:')&&v.includes('c2 · from tab B')),
   draftState:document.getElementById('review-draft-state')?.textContent??'',
   dirty:document.getElementById('dirty')?.textContent??'',
  })`);
  assert.equal(bar3State.currentCount,0);
  assert.equal(bar3State.oldRetained,true);
  assert.equal(bar3State.draftState,expectedCarryEn);
  assert.equal(bar3State.dirty,expectedCarryEn);
  await saveLook('en','changed-source.png');
  const koUrl=new URL(fixture.ownerUrl);koUrl.searchParams.set('lang','ko');
  await page!.goto('about:blank');await page!.goto(koUrl.href);
  await wait(`!!document.querySelector('form[data-job-ask="ask-checkpoint-3"] fieldset:not(:disabled)')`,'992 bar 3 changed source ko');
  await page!.evaluate<void>(`document.querySelector('#job-record-asks')?.close()`);
  await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const bar3Ko=await page!.evaluate<{draftState:string;dirty:string}>(`({
   draftState:document.getElementById('review-draft-state')?.textContent??'',
   dirty:document.getElementById('dirty')?.textContent??'',
  })`);
  assert.equal(bar3Ko.draftState,expectedCarryKo);
  assert.equal(bar3Ko.dirty,expectedCarryKo);
  await saveLook('ko','changed-source.png');
  // Bar 5: Existing per-publication drafts still restore (fallback)
  await page!.evaluate<void>(`(()=>{
   localStorage.clear();
   localStorage.setItem(${JSON.stringify(`rig-review-record-comments/1:${pub3.publicationId}:${pub3.source.sourceHash}`)},JSON.stringify({
    status:'pending',publicationId:${JSON.stringify(pub3.publicationId)},sourceHash:${JSON.stringify(pub3.source.sourceHash)},
    comments:[{id:'legacy-c1',summary:'c3 · legacy fallback'}],
   }));
  })()`);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1&&!!document.querySelector('form[data-job-ask="ask-checkpoint-3"] fieldset:not(:disabled)')`,'992 bar 5 fallback');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c3 · legacy fallback']);
  // Deleting all comments restored from a legacy key and reloading must stay at 0 rows (never resurrect from legacy key).
  await page!.evaluate<void>(`document.querySelector('#stage-comment-list .stage-comment-summary').click()`);
  await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'992 bar 5 legacy delete button');
  await page!.evaluate<void>(`document.querySelector('.stage-comment-composer .stage-comment-delete').click()`);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===0`,'992 bar 5 legacy deleted');
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`!!document.querySelector('form[data-job-ask="ask-checkpoint-3"] fieldset:not(:disabled)')`,'992 bar 5 reload after legacy delete');
  assert.deepEqual(await readRows(),[]);

  // #999 Bar: box-pin comment on parts-verdict draft page saves (even when box crosses part boundary into margin),
  // displays catalog refusal sentence on status line when refused, survives reload, and is included in submitted act in EN and KO.
  const parts999:Record<string,unknown>={};
  for(const lang of ['en','ko'] as const){
   const pf=await partsDifferenceJobFixture({scratchParent:out});
   try{
    const ask=await pf.ask(pf.publication,{kind:'parts-verdict',draftId:'synthetic-parts'});
    const pUrl=partsDifferenceOwnerUrl(pf,lang);
    await page!.setViewport(1440,900);
    await page!.goto('about:blank');await page!.goto(pUrl);
    await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'`,'999 parts ready '+lang);
    const drawEdgeBox=async(text:string)=>{
     if(await page!.evaluate<boolean>(`!document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`))await click(page!,'#stage-comment');
     await wait(`document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`,'999 comment mode '+lang);
     // Draw a box from (1.5, 1.5) to (10.5, 9.5) crossing body's top-left boundary (x=4, y=4) into empty margin (fails on da67304 with PARTS_COMMENT_OUT_OF_BOUNDS)
     const [from,to]=await page!.evaluate<[{x:number;y:number},{x:number;y:number}]>(`(()=>{
      const canvas=document.getElementById('parts-canvas'),rect=canvas.getBoundingClientRect();
      return [[1.5,1.5],[10.5,9.5]].map(([x,y])=>({x:rect.left+x*rect.width/canvas.width,y:rect.top+y*rect.height/canvas.height}));
     })()`);
     await page!.mouse('mouseMoved',from.x,from.y);
     await page!.mouse('mousePressed',from.x,from.y);
     await page!.mouse('mouseMoved',to.x,to.y);
     await page!.mouse('mouseReleased',to.x,to.y);
     await wait(`!!document.querySelector('.stage-comment-composer input')`,'999 composer open '+lang);
     await page!.evaluate<void>(`(()=>{
      const f=document.querySelector('.stage-comment-composer');
      const input=f.querySelector('input');
      input.value=${JSON.stringify(text)};
      input.dispatchEvent(new Event('input',{bubbles:true}));
     })()`);
    };
    const words=lang==='ko'?'검 손잡이가 손 뒤로 가야 함':'Sword grip must go behind the hand';
    await drawEdgeBox(words);
    // Refusal sentence check: deselect the part chip and attempt save -> status line shows catalog sentence
    await click(page!,'.stage-comment-parts [data-comment-part="body"]');
    await page!.evaluate<void>(`document.querySelector('.stage-comment-composer').requestSubmit()`);
    const expectedRefusal=(lang==='ko'?koCatalog:enCatalog)['Select at least one part.']!;
    await wait(`document.getElementById('message')?.textContent===${JSON.stringify(expectedRefusal)}&&document.getElementById('review-message')?.textContent===${JSON.stringify(expectedRefusal)}`,'999 refusal status line '+lang);
    // Re-select the part chip (which replaces chip children) and press Enter / submit to save the box-pin comment
    await click(page!,'.stage-comment-parts [data-comment-part="body"]');
    assert.equal(await page!.evaluate<boolean>(`document.activeElement===document.querySelector('.stage-comment-composer input')`),true,'chip click restores focus to composer input');
    await page!.evaluate<void>(`document.querySelector('.stage-comment-composer').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
    await wait(`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-pin').length===1`,'999 box-pin saved '+lang);
    // Reload survival on parts-verdict page
    await page!.goto('about:blank');await page!.goto(pUrl);
    await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.stage-comment-pin').length===1`,'999 box-pin survives reload '+lang);
    assert.equal(await page!.evaluate<boolean>(`[...document.querySelectorAll('#stage-comment-list .stage-comment-summary')].some(n=>n.textContent.includes(${JSON.stringify(words)}))`),true);
    if(await page!.evaluate<boolean>(`document.querySelector('#stage-comment')?.getAttribute('aria-pressed')!=='true'`))await click(page!,'#stage-comment');
    await wait(`document.querySelector('#stage-comment-list .stage-comment-summary')?.checkVisibility()===true`,'999 comments panel visible '+lang);
    await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await saveLook(lang,'box-pin-edge.png');
    // Delete the saved comment so committed comments are 0, then reopen the composer with text to prove Request changes is enabled by the open composer and auto-commits on click.
    await page!.evaluate<void>(`document.querySelector('#stage-comment-list .stage-comment-summary').click()`);
    await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'999 delete button '+lang);
    await page!.evaluate<void>(`document.querySelector('.stage-comment-composer .stage-comment-delete').click()`);
    await wait(`document.querySelectorAll('.stage-comment-pin').length===0&&document.querySelector('#request-changes')?.disabled===true`,'999 cleared before open-composer submit '+lang);
    await drawEdgeBox(words);
    await wait(`document.querySelector('#request-changes')?.checkVisibility()&&!document.querySelector('#request-changes').disabled`,'999 request changes enabled with open composer '+lang);
    await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await saveLook(lang,'request-changes-open-composer.png');
    // Click Request changes (#request-changes) directly while the composer is open and verify the comment commits and the act is sent
    await click(page!,'#request-changes');
    let submittedAct:any=null;
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){
     const ev=(await pf.next()).events.find(e=>e.type==='act'&&e.act.askId===ask.askId);
     if(ev?.type==='act'){submittedAct=ev.act;break;}
     await Bun.sleep(50);
    }
    assert.ok(submittedAct,'999 finalized parts-verdict act '+lang);
    await wait(`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-pin').length===1&&document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1`,'999 open composer committed and act sent '+lang);
    await wait(`document.querySelector('#stage-comment-list .stage-comment-summary')?.checkVisibility()===true`,'999 committed comment visible '+lang);
    await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await saveLook(lang,'request-changes-open-composer-after.png');
    assert.equal(submittedAct.schema,JOB_COMMENTS_ACT_SCHEMA);
    assert.equal(submittedAct.kind,'parts-verdict');
    assert.equal(submittedAct.value.verdict,'changes-requested');
    assert.equal(submittedAct.value.comments.length,1);
    assert.equal(submittedAct.value.comments[0].text,words);
    assert.deepEqual(submittedAct.value.comments[0].anchor.parts.map((p:any)=>p.name),['body']);
    assert.deepEqual(submittedAct.value.comments[0].anchor.rigRegion,{x:4,y:4,width:7,height:6});
    parts999[lang]={actId:submittedAct.actId,verdict:submittedAct.value.verdict,text:submittedAct.value.comments[0].text,rigRegion:submittedAct.value.comments[0].anchor.rigRegion,refusal:expectedRefusal};
   }finally{await pf.close();}
  }
  await writeFile(join(out,'draft-survival.json'),JSON.stringify({bar3State,bar3Ko,parts999},null,2)+'\n');
  console.log('992_DRAFT_SURVIVAL_PASS '+JSON.stringify({bar3State,bar3Ko,parts999}));
 }finally{await fixture.close();}
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
   // #1041: the first question opens in the right communication panel (docked or its non-modal drawer), not the bottom drawer.
   const options='#workspace-communication #workspace-interview-answer form[data-job-ask] label.interview-option';
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
    drawerOpen:!!document.querySelector('#workspace-communication')?.checkVisibility()
   })`);
   const errors=consoleErrors.slice(errorsBefore);
   await writeFile(join(out,'after-delivery.json'),JSON.stringify({after,errors},null,2));
   await writeFile(join(out,'first-load.png'),await page!.screenshot());
   console.log('941_FIRST_QUESTION '+JSON.stringify({language,before,after,errors}));
   assert.equal(errors.length,0,JSON.stringify(errors));
   assert.equal(after.language,language);assert.equal(after.drawerOpen,true);
   assert.ok(after.options.length>0,'first publication shows visible option labels in the communication panel');
  }finally{await fixture.close();}
 }
}

if(Bun.argv.includes('--serve')){
 const fixtureArg=arg('--fixture');
 const serveScratch=await mkdtemp(join(tmpdir(),'review-750-serve-'));
 const closers:(()=>Promise<void>)[]=[];
 try{
  if(!fixtureArg||fixtureArg==='draft-survival-changed-source'){
   const baseResources=jobWindowResources();
   let seedScript='';
   const resources:ReturnType<typeof jobWindowResources>=async name=>{
    const res=await baseResources(name);
    if(name==='main.js'&&seedScript)return seedScript+'\n'+await new Response(res).text();
    return res;
   };
   const fixture=await recordScreenFixture('checkpoint',false,serveScratch,'plan-approved',false,true,resources);
   closers.push(()=>fixture.close());
   const priorPub=fixture.display.publication;
   const seedKey=`rig-review-record-comments/1:${fixture.session.jobId}:plan:${priorPub.source.sourceHash}`;
   const seedVal=JSON.stringify({status:'pending',publicationId:priorPub.publicationId,sourceHash:priorPub.source.sourceHash,comments:[{id:'seed-c1',summary:'c1 · unsent comment before source hash change'}]});
   seedScript=`try{if(!localStorage.getItem(${JSON.stringify(seedKey)}))localStorage.setItem(${JSON.stringify(seedKey)},${JSON.stringify(seedVal)});}catch{}`;
   const updatedEvidence=await readFile(join(fixture.root,'plan/context-evidence.json'),'utf8')+'\n';
   await writeFile(join(fixture.root,'plan/context-evidence.json'),updatedEvidence);
   const updatedEvidenceHash=sha(updatedEvidence);
   const planContext=fixture.workspace.context as unknown as {files:{path:string;sha256:string}[]};
   planContext.files=planContext.files.map(f=>f.path==='plan/context-evidence.json'?{...f,sha256:updatedEvidenceHash}:f);
   const pub2=await fixture.session.execute({schema:'rig-review/job-api@3',jobId:fixture.session.jobId,requestId:'serve-republish-changed',verb:'publish',expectedGeneration:fixture.session.status().generation,idempotencyKey:'serve-republish-changed',result:fixture.workspace.result,freeze:{kind:'producer-held',holdId:'serve-hold-2',record:fixture.workspace.record}},new AbortController().signal) as {publicationId:string;generation:number;source:typeof fixture.display.publication.source};
   const display2=fixture.session.displayPublication(pub2.publicationId);
   const ask2={...fixture.ask,askId:'ask-checkpoint-2',publicationId:pub2.publicationId,source:pub2.source};
   fixture.fake.publish(display2);fixture.fake.pending(ask2,pub2.generation);
   for(const lang of ['ko','en'] as const){
    const u=new URL(fixture.ownerUrl);u.searchParams.set('lang',lang);
    console.log(JSON.stringify({fixture:'draft-survival-changed-source',lang,url:u.href,pid:process.pid,priorSourceHash:priorPub.source.sourceHash,currentSourceHash:pub2.source.sourceHash,clicks:['1. Open URL ( optionally click Close / 닫기 on the checkpoint drawer to view the full Comments panel and footer #review-draft-state / #dirty ).']}));
   }
  }
  if(!fixtureArg||fixtureArg==='parts-box-pin'){
   const pf=await partsDifferenceJobFixture({scratchParent:serveScratch});
   closers.push(()=>pf.close());
   await pf.ask(pf.publication,{kind:'parts-verdict',draftId:'synthetic-parts'});
   for(const lang of ['ko','en'] as const){
    console.log(JSON.stringify({fixture:'parts-box-pin',lang,url:partsDifferenceOwnerUrl(pf,lang),pid:process.pid,sourceHash:pf.publication.source.sourceHash,clicks:['1. Click + Comment (#stage-comment) and drag a box across the part edge.', '2. Type comment text in the open composer (Request changes / 수정 요청 enables immediately).', '3. Press Enter to save the clamped box pin, or click Request changes (#request-changes) directly while the composer is open.']}));
   }
  }
  await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }finally{
  for(const close of closers)await close();
  await rm(serveScratch,{recursive:true,force:true});
  await rm(profile,{recursive:true,force:true});
 }
 process.exit(0);
}

try{
 // Reuse the shared launcher's browser discovery and process policy without a suite-local wrapper.
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;if(event.method==='Fetch.requestPaused'){const id=event.params!.requestId as string;if(holdImages)pausedImages.push(id);else void send('Fetch.continueRequest',{requestId:id});}if(event.method==='Runtime.consoleAPICalled'&&event.params?.type==='error')consoleErrors.push(event.params);if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Fetch.enable',{patterns:[{urlPattern:'*/api/interview/image/*'}]});
 await command!('Runtime.enable');await command!('Network.enable');await command!('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__record750legacySeen=false;new MutationObserver(()=>{if(document.body?.classList.contains('job-window')||document.querySelector('[data-job-forms]'))globalThis.__record750legacySeen=true;}).observe(document,{subtree:true,childList:true,attributes:true});`});
 if(Bun.argv.includes('--draft-survival'))await draftSurvivalChecks();
 else if(Bun.argv.includes('--first-question-drawer'))await firstQuestionInDrawer();
 else if(boundRigPictureOnly)await boundRigPictureChecks();
 else if(postQuestionPictures)await postQuestionPictureChecks();
 else{
 await firstQuestionInDrawer();
 if(!completedPicture||workspace986)await liveQuestionDraftChecks();
 if(workspace986)await twoImageDrawerChecks();
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
