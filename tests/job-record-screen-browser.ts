/** #750 ordinary Nova only. Real shipped UI paths and retained record reader/writer doubles.
 * Interview-only shared screen proof; approval modals are covered by job-record-modal-browser.ts.
 * EN/KO, interview picks, picture/empty, 1600x1000; no installed-producer conformance claim. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readdirSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {prepareJobRecordAct} from '../src/job-act.ts';
import type {JobRetainedRecordSource} from '../src/job-source.ts';
import {parseRecordAct} from '../src/job-api.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const interviewOnly=Bun.argv.includes('--interview-only');
const freshParts=Bun.argv.includes('--fresh-parts');
const baseline=await Bun.file(new URL('./fixtures/interview-722-empty-note.json',import.meta.url)).json();
const output=resolve(arg('--out')??'artifacts/record-screen-750');await mkdir(output,{recursive:true});
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const profile=await mkdtemp(join(tmpdir(),'review-750-browser-'));
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
let holdImages=false;const pausedImages:string[]=[];
const exceptions:unknown[]=[],mutations:{method:string;path:string}[]=[],cases:unknown[]=[];
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('750_BROWSER_TIMEOUT '+label);}

try{
 // Keep the existing CDP launcher, limiting this tiny fixture browser to one renderer process.
 const launcherSource=await readFile(new URL('./parts-explorer-browser.ts',import.meta.url),'utf8');
 const finder=launcherSource.slice(launcherSource.indexOf('function findBrowserBinary()'),launcherSource.indexOf('export async function launchCdpSession('));
 const chrome:string=new Function('join','homedir','existsSync','readdirSync',new Bun.Transpiler({loader:'ts'}).transformSync(finder)+';return findBrowserBinary();')(join,homedir,existsSync,readdirSync);
 const wrapper=join(output,chrome.includes('headless')?'chrome-limited-headless':'chrome-limited');await writeFile(wrapper,'#!/usr/bin/env bash\nexec '+"'"+chrome.replaceAll("'","'\\''")+"'"+' --single-process --no-zygote --renderer-process-limit=1 --num-raster-threads=1 --disable-breakpad --disable-crash-reporter --js-flags=--max-old-space-size=1024 "$@"\n',{mode:0o755});
 process.env.CHROME_BIN=wrapper;
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;if(event.method==='Fetch.requestPaused'){const id=event.params!.requestId as string;if(holdImages)pausedImages.push(id);else void send('Fetch.continueRequest',{requestId:id});}if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Fetch.enable',{patterns:[{urlPattern:'*/api/interview/image/*'}]});
 await command!('Network.enable');await command!('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__record750legacySeen=false;new MutationObserver(()=>{if(document.body?.classList.contains('job-window')||document.querySelector('[data-job-forms]'))globalThis.__record750legacySeen=true;}).observe(document,{subtree:true,childList:true,attributes:true});`});
 for(const [width,height] of (interviewOnly?[[1600,1000],[1440,900]]:[[1600,1000]])){
 await page.setViewport(width!,height!);
 for(const kind of ['interview-picks'] as RecordScreenKind[])for(const picture of (freshParts?[false]:[false,true,'parts']) as readonly (boolean|'parts')[]){
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
     await click(page,selector+' button[type="submit"]');
     const path=join(out,mode+'.json');await wait(`document.querySelector(${JSON.stringify(selector+' > [role="status"]')})?.textContent===${JSON.stringify((language==='en'?enCatalog:koCatalog)['job.saved'])}`,kind+'/'+mode+'/saved');
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
 assert.equal(exceptions.length,0,'no browser exceptions');
 assert.ok(mutations.every(request=>/\/ui\/(?:displayed|acts)$/.test(request.path)),'no backdrop mutation requests');
 const result={cases:cases.length,persistedActs:cases.length,persistedByteComparisons:0,askKinds:1,languages:['en','ko'],backdrops:freshParts?['bound-parts']:['empty','picture','parts'],viewports:interviewOnly?[[1600,1000],[1440,900]]:[[1600,1000]],exceptions,mutations,browserWorkers:'single-process/no-zygote; one renderer; raster threads=1; JS heap 1024MiB'};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('750_BROWSER_PASS '+JSON.stringify(result));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,completedCases:cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
