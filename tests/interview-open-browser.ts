/** #725 / #986 synthetic managed-target browser proof, EN/KO on ordinary Nova. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseOpenInputs} from '../src/cli.ts';
import {prepareOpenTarget} from '../src/open.ts';
import {startOpenWorkspace} from '../src/open-workspace.ts';
import {targetCapability} from '../src/open-workspace-state.ts';
import {WORKSPACE_SCHEMA,type WorkspaceList} from '../src/open-workspace-contract.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {digest, readProject} from '../src/interview-project.ts';
import {savePicks} from '../src/interview-picks.ts';
import {interviewPicksRecord} from '../web/interview-panel.ts';

const index=Bun.argv.indexOf('--out'),out=resolve(index<0?'artifacts/interview-open-725':Bun.argv[index+1]!);
await mkdir(out,{recursive:true});
const f=await interviewOpenFixture(),profile=await mkdtemp(join(tmpdir(),'review-725-browser-'));
const alternate='<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24" fill="#ab5830"/></svg>';
const alternateRef={path:'alternate.svg',sha256:digest(alternate)};
const originalQuestion=readProject(f.root).questions[0]!;
const optionPath=join(f.root,originalQuestion.ref.path);
const options=await Bun.file(optionPath).json() as {context:{files:{path:string;sha256:string}[]}};
options.context.files.push(alternateRef);
const optionBytes=JSON.stringify(options);
await writeFile(join(f.root,alternateRef.path),alternate);
await writeFile(optionPath,optionBytes);
const project=f.project as {inputs:{path:string;sha256:string}[];interview:{framing:{pending_options:{sha256:string}}[]}};
project.inputs.push(alternateRef);
project.interview.framing[0]!.pending_options.sha256=digest(optionBytes);
await writeFile(join(f.root,'project.json'),JSON.stringify(project));
const retainedNote='  Retained note\r\n원문 👁 e\u0301\n  ';
const question=readProject(f.root).questions[0]!;
savePicks(join(f.root,'picks'),question,interviewPicksRecord(question.ref,question.set.asks.map(ask=>({ask:ask.id,option_id:ask.options.find(option=>option.kind==='value')!.id})),retainedNote,'2026-11-11T00:00:00.000Z'));
const inputs=parseOpenInputs([f.root,'--project',f.root,'--picks-dir','picks']);
const prepared=await prepareOpenTarget(inputs,{stateDir:f.stateDir});
const host=await startOpenWorkspace({stateDir:f.stateDir,fingerprint:prepared.fingerprint,port:0});
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const requests:string[]=[];
const exceptions:unknown[]=[],mutations:unknown[]=[],cases:unknown[]=[];
async function wait(expression:string){const deadline=Date.now()+20_000;while(Date.now()<deadline){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('725_BROWSER_TIMEOUT '+expression);}
const sharedControls='#zoom-in,#zoom-out,#fit,#native-one,#view-menu';
const questionPanel='#workspace-interview-answer';
// #1041: the question lives in the right communication panel (docked, or a non-modal drawer when narrow).
const selectedTab='#workspace-communication #workspace-interview-answer:not([hidden]) .review-dialog-header h2';
const commDrawer='#workspace-drawer-communicationWidth';
const dialogViewer='dialog :is(.viewport,.interview-view,.interview-viewport,#reference-content,#rig-viewport,'+sharedControls+')';
const visibleImage=`(()=>{const image=document.querySelector('#reference-content img'),box=image?.getBoundingClientRect();return image?.complete&&box.width>0&&box.height>0&&getComputedStyle(image).visibility==='visible'?image.naturalWidth:0;})()`;
const imageWidth=`document.querySelector('#reference-content img').getBoundingClientRect().width`;
type AskTrigger={count:number;text:string;visible:boolean;hidden:boolean;disabled:boolean;display:string;visibility:string;width:number;height:number};
type JoinedScreen={
 language:string;width:number;height:number;topbars:number;viewports:number;openDialogs:string[];modals:number;dialogViewers:number;
 forms:number;noteInputs:number;columns:string[];modelCanvas:number;modelReason:string;questionLabel:string;
 pendingAsk:AskTrigger|null;pendingRecordAsk:AskTrigger|null;
 saveDisabled:boolean;commentHidden:boolean;controls:string[];imageModes:string[];
 drawerOpen:boolean;formInDrawer:boolean;inspectorHidden:boolean;
 rect:{left:number;top:number;right:number;bottom:number};
 questionsHeight:number;questionsContentHeight:number;fieldsHeight:number;
};
let currentCase:{language:'en'|'ko';width:number;height:number;state?:JoinedScreen}|undefined;

async function switchImage(index:number,width:number):Promise<void>{
 await click(page!,'#view-menu summary');
 const mode=`#view-menu [data-view="interview-image-${index}"]`;
 await click(page!,mode);
 await wait(`${visibleImage}===${width}&&document.querySelector(${JSON.stringify(mode)})?.getAttribute('aria-pressed')==='true'`);
}
try{
 const before={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 const registration=await fetch(host.record.origin+'/workspace/api/register',{method:'POST',headers:{Authorization:'Bearer '+host.record.registrationCapability,'Content-Type':'application/json'},body:JSON.stringify({schema:WORKSPACE_SCHEMA,incarnation:host.record.incarnation,targets:[{key:prepared.key,contentHash:prepared.package.contentHash,cwd:prepared.cwd,viewOnly:false,inputs:prepared.package.inputs}]})});
 assert.equal(registration.status,200);
 const list=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json() as WorkspaceList;
 assert.equal(list.targets.length,1);
 page=await launchCdpSession(profile,{onEvent:(event,send)=>{command=send;if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request)requests.push(new URL(request.url).pathname);if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Network.enable');
 for(const [width,height] of [[1600,1000],[1600,360],[700,720]] as const)for(const language of ['en','ko'] as const){
  currentCase={language,width,height};
  await page.setViewport(width,height);
  const catalog=language==='en'?enCatalog:koCatalog,url=new URL(host.record.origin+list.targets[0]!.entry);
  url.searchParams.set('lang',language);url.hash='cap='+targetCapability(host.record.ownerCapability,host.record.incarnation,prepared.key);
  await page.goto(url.href);
  await wait(`document.body.dataset.ready==='true'&&!!document.querySelector(${JSON.stringify(selectedTab)})&&!!document.querySelector('${questionPanel}:not([hidden]) form.interview-answer')`);
  await wait(`${visibleImage}===32`);
  if(width===700)await wait(`!!document.querySelector('${commDrawer}[open] ${questionPanel}')`);
  const state:JoinedScreen=await page.evaluate(`(()=>{
   const panel=document.querySelector('${questionPanel}'),form=panel.querySelector('form.interview-answer');
   const nav=form.querySelector('.interview-questions'),fields=form.querySelector('.interview-answer-fields');
   const navStyle=getComputedStyle(nav),navChildren=[...nav.children];
   const questionsContentHeight=navChildren.length?(navChildren.at(-1).getBoundingClientRect().bottom-navChildren[0].getBoundingClientRect().top)+parseFloat(navStyle.paddingTop)+parseFloat(navStyle.paddingBottom)+parseFloat(navStyle.borderTopWidth)+parseFloat(navStyle.borderBottomWidth):0;
   const drawer=document.querySelector('${commDrawer}'),box=(drawer?.open?drawer:panel).getBoundingClientRect();
   const askTrigger=id=>{
    const matches=document.querySelectorAll('#'+id),button=matches[0];
    if(!button)return null;
    const style=getComputedStyle(button),rect=button.getBoundingClientRect();
    return {count:matches.length,text:button.textContent.trim(),hidden:button.hidden,disabled:button.disabled,
     visible:rect.width>0&&rect.height>0&&style.visibility==='visible',display:style.display,visibility:style.visibility,
     width:rect.width,height:rect.height};
   };
   return {language:document.documentElement.lang,width:innerWidth,height:innerHeight,
    topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,
    openDialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.id),
    modals:document.querySelectorAll('dialog:modal').length,dialogViewers:document.querySelectorAll(${JSON.stringify(dialogViewer)}).length,
    forms:panel.querySelectorAll('form.interview-answer').length,noteInputs:form.querySelectorAll('textarea[name=note]').length,
    columns:[...form.children].filter(node=>['NAV','ASIDE','FIELDSET'].includes(node.tagName)).map(node=>node.tagName),
    modelCanvas:document.querySelectorAll('#rig-root canvas').length,modelReason:document.getElementById('rig-empty').textContent,
    questionLabel:document.querySelector(${JSON.stringify(selectedTab)}).textContent.trim(),
    pendingAsk:askTrigger('workspace-pending-ask'),pendingRecordAsk:askTrigger('workspace-pending-record-ask'),
    saveDisabled:document.getElementById('save').disabled,commentHidden:document.getElementById('stage-comment').hidden,
    controls:[...document.querySelectorAll('${sharedControls}')].map(node=>node.id),
    imageModes:[...document.querySelectorAll('#view-menu [data-view]')].map(node=>node.dataset.view),
    drawerOpen:!!drawer?.open,formInDrawer:!!drawer?.contains(form),inspectorHidden:document.getElementById('workspace-inspector').hidden,
    rect:{left:box.left,top:box.top,right:box.right,bottom:box.bottom},
    questionsHeight:nav.getBoundingClientRect().height,questionsContentHeight,fieldsHeight:fields.getBoundingClientRect().height};
  })()`);
  currentCase.state=state;
  assert.equal(state.language,language);assert.equal(state.width,width);assert.equal(state.height,height);
  assert.ok(Math.abs(state.questionsHeight-state.questionsContentHeight)<=2,`#1038 F12 (${language}, ${height}): question card height (${state.questionsHeight}) must fit its content (${state.questionsContentHeight}), not stretch to fieldset (${state.fieldsHeight})`);
  assert.equal(state.commentHidden,true,'standalone interview hides the unbound comment entry');
  assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.modals,0);assert.equal(state.dialogViewers,0);
  assert.equal(state.forms,1);assert.equal(state.modelCanvas,0);assert.equal(state.noteInputs,0);
  assert.deepEqual(state.columns,['NAV','FIELDSET']);
  assert.equal(await page.evaluate<string|null>(`document.querySelector('${questionPanel} pre.interview-note')?.textContent??null`),retainedNote);
  assert.equal(state.questionLabel,catalog['Question']);
  assert.ok(state.pendingAsk?.count===1&&state.pendingAsk.visible&&!state.pendingAsk.disabled&&!state.pendingAsk.hidden,
   'expected a single visible and enabled #workspace-pending-ask '+JSON.stringify(currentCase));
  assert.ok(!state.pendingRecordAsk?.visible,'unexpected visible #workspace-pending-record-ask '+JSON.stringify(currentCase));
  assert.equal(state.saveDisabled,true);
  assert.equal(state.modelReason,catalog['MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.']);
  assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
  assert.deepEqual(state.imageModes,['interview-image-0','interview-image-1']);
  assert.deepEqual(state.openDialogs,width===700?['workspace-drawer-communicationWidth']:[]);
  assert.equal(state.drawerOpen,width===700);assert.equal(state.formInDrawer,width===700);
  assert.equal(state.inspectorHidden,true,'a standalone interview has no view-controller block, so the bottom panel collapses to nothing');
  assert.ok(state.rect.left>=0&&state.rect.top>=0&&state.rect.right<=width&&state.rect.bottom<=height);
  const prefix=language+(height===360?'-short':width===700?'-narrow':'');
  await writeFile(join(out,prefix+'-interview.png'),await page.screenshot());
  const firstImage:string=await page.evaluate(`document.querySelector('#reference-content img').currentSrc`);
  await switchImage(1,48);
  const secondImage:string=await page.evaluate(`document.querySelector('#reference-content img').currentSrc`);
  assert.ok(new URL(firstImage).pathname.endsWith('/api/interview/image/'+question.ref.sha256+'/0'));
  assert.ok(new URL(secondImage).pathname.endsWith('/api/interview/image/'+question.ref.sha256+'/1'));
  if(width===700)assert.equal(await page.evaluate<boolean>(`!!document.querySelector('${commDrawer}[open]:not(:modal)')`),true,'the question drawer is non-modal');
  if(height===1000){
   await click(page,'#native-one');await wait(`Math.abs(${imageWidth}-48)<1`);
   const native=await page.evaluate<number>(imageWidth);
   await click(page,'#zoom-in');await wait(`${imageWidth}>${native}+1`);
   await click(page,'#zoom-out');await wait(`Math.abs(${imageWidth}-${native})<1`);
   await click(page,'#fit');await wait(`${imageWidth}>${native}+1`);
  }
  await writeFile(join(out,prefix+'-workspace.png'),await page.screenshot());
  await switchImage(0,32);
  if(width===700){
   await click(page,commDrawer+' .workspace-drawer-close');
   await wait(`!document.querySelector('${commDrawer}[open]')`);
  }
  await click(page,'#workspace-pending-ask');
  await wait(`!!document.querySelector(${JSON.stringify(selectedTab)})&&${visibleImage}===32&&!document.querySelector('dialog:modal')`);
  type LongList={formBottom:number;navBottom:number;navHeight:number;scrollHeight:number;clientHeight:number;scrollTop:number;lastVisible:boolean};
  let longList:LongList|undefined;
  if(height===1000){
   const measured:LongList=await page.evaluate(`(()=>{
    const form=document.querySelector('${questionPanel} form.interview-answer');
    const nav=form.querySelector('nav.interview-questions'),ol=nav.querySelector('ol'),first=ol.querySelector('li');
    // Measure the bounded grid track (.interview-answer.interview-grid grid-template-rows:minmax(0,1fr) auto; overflow:hidden).
    form.style.gridTemplateRows='minmax(0,1fr) auto';form.style.height='220px';form.style.overflow='hidden';
    for(let i=2;i<=20;i++){const li=first.cloneNode(true);li.querySelector('button').textContent='question_'+i+' · synthetic-set-'+i;ol.append(li);}
    const formRect=form.getBoundingClientRect(),navRect=nav.getBoundingClientRect();
    const scrollHeight=nav.scrollHeight,clientHeight=nav.clientHeight;
    const last=ol.lastElementChild;
    last.scrollIntoView({block:'nearest'});
    const afterNavRect=nav.getBoundingClientRect(),lastRect=last.getBoundingClientRect();
    const scrollTop=nav.scrollTop;
    return {formBottom:formRect.bottom,navBottom:navRect.bottom,navHeight:navRect.height,
     scrollHeight,clientHeight,scrollTop,lastVisible:lastRect.top>=afterNavRect.top-1&&lastRect.bottom<=afterNavRect.bottom+1&&afterNavRect.bottom<=formRect.bottom+1};
   })()`);
   longList=measured;
   await writeFile(join(out,language+'-long-interview.png'),await page.screenshot());
   assert.ok(measured.navBottom<=measured.formBottom+1,`#1038 F12 long set (${language}): nav bottom (${measured.navBottom}) exceeds grid bottom (${measured.formBottom})`);
   assert.ok(measured.scrollHeight>measured.clientHeight,`#1038 F12 long set (${language}): expected scrollHeight (${measured.scrollHeight}) > clientHeight (${measured.clientHeight})`);
   assert.ok(measured.scrollTop>0&&measured.lastVisible,`#1038 F12 long set (${language}): expected last item scrolled into view, got ${JSON.stringify(measured)}`);
  }
  cases.push({...state,firstImage:new URL(firstImage).pathname,secondImage:new URL(secondImage).pathname,...(longList?{longList}:{})});
  await page.goto('about:blank');
  currentCase=undefined;
 }
 const after={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 assert.deepEqual(after,before);assert.deepEqual(exceptions,[]);assert.deepEqual(mutations,[]);assert.ok(requests.some(path=>path.endsWith('/api/interview')));
 await writeFile(join(out,'result.json'),JSON.stringify({fixture:'synthetic interview-stage project; demo/build versions; no draft or review package',cases,sourceFilesBefore:before,sourceFilesAfter:after,sourceWrites:0,networkRequests:requests.length,exceptions,mutations},null,2)+'\n');
 console.log('725_BROWSER_PASS '+JSON.stringify({cases:cases.length,languages:['en','ko'],viewports:['1600x1000','1600x360','700x720'],sourceWrites:0,exceptions:exceptions.length}));
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),currentCase,exceptions,mutations,cases},null,2)+'\n');if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await host.stop();await f.close();await rm(profile,{recursive:true,force:true});}
