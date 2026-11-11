/** #750 ordinary Nova only. Real shipped UI paths and retained record reader/writer doubles.
 * Each comparison reads two independently written act files; no normalization or reconstruction.
 * EN/KO, four ask kinds, picture/empty, 1600x1000; no installed-producer conformance claim. */
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
import {parseRecordAct} from '../src/job-api.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const output=resolve(arg('--out')??'artifacts/record-screen-750');await mkdir(output,{recursive:true});
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const profile=await mkdtemp(join(tmpdir(),'review-750-browser-'));
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const exceptions:unknown[]=[],mutations:{method:string;path:string}[]=[],cases:unknown[]=[];
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('750_BROWSER_TIMEOUT '+label);}

try{
 // Keep the existing CDP launcher, limiting this tiny fixture browser to one renderer process.
 const launcherSource=await readFile(new URL('./parts-explorer-browser.ts',import.meta.url),'utf8');
 const finder=launcherSource.slice(launcherSource.indexOf('function findBrowserBinary()'),launcherSource.indexOf('export async function launchCdpSession('));
 const chrome:string=new Function('join','homedir','existsSync','readdirSync',new Bun.Transpiler({loader:'ts'}).transformSync(finder)+';return findBrowserBinary();')(join,homedir,existsSync,readdirSync);
 const wrapper=join(output,chrome.includes('headless')?'chrome-limited-headless':'chrome-limited');await writeFile(wrapper,'#!/usr/bin/env bash\nexec '+"'"+chrome.replaceAll("'","'\\''")+"'"+' --single-process --no-zygote --renderer-process-limit=1 --num-raster-threads=1 --disable-breakpad --disable-crash-reporter --js-flags=--max-old-space-size=1024 "$@"\n',{mode:0o755});
 process.env.CHROME_BIN=wrapper;
 page=await launchCdpSession(profile,{onEvent:(event,send)=>{command=send;if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Network.enable');await command!('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__record750legacySeen=false;new MutationObserver(()=>{if(document.body?.classList.contains('job-window')||document.querySelector('[data-job-forms]'))globalThis.__record750legacySeen=true;}).observe(document,{subtree:true,childList:true,attributes:true});`});
 await page.setViewport(1600,1000);
 for(const kind of ['checkpoint','signoff','reopen','interview-picks'] as RecordScreenKind[])for(const picture of [false,true]){
  const fixture=await recordScreenFixture(kind,picture);const before=await jobInputHashes(fixture.root);
  try{
   for(const language of ['en','ko'] as const){
    const out=join(output,kind,picture?'picture':'empty',language);await mkdir(out,{recursive:true});fixture.output(out);
    const observation:Record<string,unknown>={kind,picture,language,sourceHash:fixture.display.publication.source.sourceHash,readerPhases:fixture.reader.calls.map(call=>call.phase),fixture:'synthetic trusted-host record reader and deterministic act writer'};
    for(const mode of ['one-screen','job-window']){
     fixture.mode(mode);const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href);
     if(mode==='job-window')await page.evaluate(`(async()=>{const module=await import(new URL('job.js',location.href).href);await module.mountJobSession(document.body,true);return true;})()`);
     const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
     await wait(`!!document.querySelector(${JSON.stringify(selector+' fieldset:not(:disabled)')})`,kind+'/'+mode+'/receipt');
     if(mode==='one-screen'){
      await wait(`!!document.querySelector('dialog[open] '+${JSON.stringify(selector)})`,kind+'/dialog');
      if(picture)await wait(`!!document.querySelector('#rig-root canvas')`,kind+'/picture');
      const state:any=await page.evaluate<any>(`(()=>{const dialog=document.querySelector('dialog[open]'),form=document.querySelector(${JSON.stringify(selector)}),box=dialog.getBoundingClientRect();return {language:document.documentElement.lang,width:innerWidth,height:innerHeight,legacySeen:globalThis.__record750legacySeen,legacyForms:document.querySelectorAll('[data-job-forms]').length,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,formInsideNativeDialog:!!form.closest('dialog[open]'),focusContained:dialog.contains(document.activeElement),dialogRect:{x:box.x,y:box.y,width:box.width,height:box.height},noPicture:document.getElementById('rig-empty').textContent,backgroundStatus:document.getElementById('message')?.textContent??'',emptyListText:document.querySelector('[data-part-list]')?.textContent??'',saveState:document.getElementById('dirty').textContent,controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>node.id)};})()`);
      assert.equal(state.language,language);assert.equal(state.width,1600);assert.equal(state.height,1000);assert.equal(state.legacySeen,false);assert.equal(state.legacyForms,0);assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.formInsideNativeDialog,true);assert.equal(state.focusContained,true);
      assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
      if(!picture){assert.equal(state.noPicture,(language==='en'?enCatalog:koCatalog)['This request has no picture.']);assert.equal(state.backgroundStatus,state.noPicture);assert.equal(state.emptyListText,'');assert.equal(state.saveState,(language==='en'?enCatalog:koCatalog)['Not submitted']);}
      assert.ok(state.dialogRect.x>=0&&state.dialogRect.y>=0&&state.dialogRect.x+state.dialogRect.width<=1600&&state.dialogRect.y+state.dialogRect.height<=1000);
      observation.screen=state;
      await click(page,'dialog[open] .workspace-drawer-close');assert.equal(await page.evaluate(`document.activeElement.id==='save'&&document.getElementById('save').getAttribute('aria-expanded')==='false'`),true,'shared drawer returns focus to the existing act button');await writeFile(join(out,'backdrop.png'),await page.screenshot());
      await click(page,'#save');await wait(`!!document.querySelector('dialog[open]')`,'reopen-modal');
     }
     const values=await page.evaluate<any>(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});const note=form.querySelector('textarea[name="note"]');note.value='  Same reviewer words · 원문\\n';for(const select of form.querySelectorAll('select')){select.value=select.name==='outcome'?'pass':select.name==='choice.topology'?'topology_other':select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));}const other=form.querySelector('textarea[name="other.topology"]');if(other)other.value='  Custom topology · 직접 입력\\n';form.dispatchEvent(new Event('input',{bubbles:true}));return [...form.querySelectorAll('input[name],textarea[name],select[name]')].map(node=>({name:node.name,value:node.value}));})()`);
     observation[mode+'Controls']=values;
     await page.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type="submit"]')}).scrollIntoView({block:'center'});`);
     await writeFile(join(out,mode+'-answered.png'),await page.screenshot());
     await click(page,selector+' button[type="submit"]');
     const path=join(out,mode+'.json');await wait(`document.querySelector(${JSON.stringify(selector+' [role="status"]')})?.textContent===${JSON.stringify((language==='en'?enCatalog:koCatalog)['job.saved'])}`,kind+'/'+mode+'/saved');
     assert.ok(existsSync(path),'writer actually persisted '+mode);const act=parseRecordAct(JSON.parse(await readFile(path,'utf8')));
     assert.equal(act.at,'2026-11-08T12:00:00.000Z');
     if(act.kind==='interview-picks'){assert.equal(act.value.note,'  Same reviewer words · 원문\n');assert.deepEqual(act.value.selections,[{itemId:'topology',optionId:'topology_other',otherText:'  Custom topology · 직접 입력\n'},{itemId:'detail_level',optionId:'density_high',otherText:null}]);}
     else{assert.equal(act.value.words,'  Same reviewer words · 원문\n');if(act.kind==='checkpoint')assert.equal(act.value.outcome,'pass');if(act.kind==='signoff')assert.equal(act.value.decision,'approved');}
     await writeFile(join(out,mode+'-submitted.png'),await page.screenshot());
     await page.goto('about:blank');
    }
    assert.deepEqual(observation['one-screenControls'],observation['job-windowControls']);
    const one=await readFile(join(out,'one-screen.json')),legacy=await readFile(join(out,'job-window.json'));
    assert.deepEqual(one,legacy,'actual persisted act bytes for '+kind+'/'+language+'/'+picture);
    observation.persistedAct={byteEqual:true,bytes:one.length,oneScreenSha256:sha(one),jobWindowSha256:sha(legacy),oneScreenFile:join(out,'one-screen.json'),jobWindowFile:join(out,'job-window.json')};
    await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');cases.push(observation);
    console.log('750_BROWSER_CASE_PASS '+kind+' '+(picture?'picture':'empty')+' '+language+' bytes='+one.length);
   }
   assert.deepEqual(await jobInputHashes(fixture.root),before,'inspected source files remain immutable');
  }finally{await fixture.close();}
 }
 assert.equal(exceptions.length,0,'no browser exceptions');
 assert.ok(mutations.every(request=>/\/ui\/(?:displayed|acts)$/.test(request.path)),'no backdrop mutation requests');
 const result={cases:cases.length,persistedByteComparisons:cases.length,askKinds:4,languages:['en','ko'],backdrops:['empty','picture'],viewport:{width:1600,height:1000},exceptions,mutations,browserWorkers:'single-process/no-zygote; one renderer; raster threads=1; JS heap 1024MiB'};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('750_BROWSER_PASS '+JSON.stringify(result));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,completedCases:cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
