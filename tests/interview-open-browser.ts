/** #725 synthetic browser proof; ordinary Nova only, 1600x1000 EN/KO.
 * Uses the shipped managed target and main/bottom/interview components. Saves the same picks bytes under a fixed UI clock; no producer source write. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
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
import {readProject} from '../src/interview-project.ts';
import {savePicks} from '../src/interview-picks.ts';
import {interviewPicksRecord} from '../web/interview-panel.ts';

const index=Bun.argv.indexOf('--out'),out=resolve(index<0?'artifacts/interview-open-725':Bun.argv[index+1]!);
await mkdir(out,{recursive:true});
const f=await interviewOpenFixture(),profile=await mkdtemp(join(tmpdir(),'review-725-browser-'));
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
try{
 const before={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 const registration=await fetch(host.record.origin+'/workspace/api/register',{method:'POST',headers:{Authorization:'Bearer '+host.record.registrationCapability,'Content-Type':'application/json'},body:JSON.stringify({schema:WORKSPACE_SCHEMA,incarnation:host.record.incarnation,targets:[{key:prepared.key,contentHash:prepared.package.contentHash,cwd:prepared.cwd,viewOnly:false,inputs:prepared.package.inputs}]})});
 assert.equal(registration.status,200);
 const list=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json() as WorkspaceList;
 assert.equal(list.targets.length,1);
 page=await launchCdpSession(profile,{onEvent:(event,send)=>{command=send;if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request)requests.push(new URL(request.url).pathname);if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Network.enable');
 await page.setViewport(1600,1000);
 await command!('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:2,mobile:false});
 for(const language of ['en','ko'] as const){
  const catalog=language==='en'?enCatalog:koCatalog,url=new URL(host.record.origin+list.targets[0]!.entry);
  url.searchParams.set('lang',language);url.hash='cap='+targetCapability(host.record.ownerCapability,host.record.incarnation,prepared.key);
  await page.goto(url.href);
  await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#workspace-interview-answer form')`);
  await wait(`document.querySelector('#reference-content img')?.naturalWidth===32`);
  const state:any=await page.evaluate(`(()=>{const panel=document.querySelector('#workspace-interview-answer'),picture=document.querySelector('#reference-viewport'),r=panel.getBoundingClientRect(),p=picture.getBoundingClientRect();return {language:document.documentElement.lang,dpr:devicePixelRatio,topbars:document.querySelectorAll('.topbar').length,dialogs:document.querySelectorAll('dialog[open]').length,noteInputs:panel.querySelectorAll('textarea[name=note]').length,controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>node.id),extraViewports:panel.querySelectorAll('.interview-viewport').length,above:p.bottom<=r.top,pictureVisible:p.width>0&&p.height>0&&!document.querySelector('#reference-pane').hidden,height:r.height};})()`);
  assert.equal(state.language,language);assert.equal(state.dpr,2);assert.equal(state.topbars,1);assert.equal(state.dialogs,0);
  assert.equal(state.noteInputs,0);assert.equal(state.extraViewports,0);assert.equal(state.above,true);assert.equal(state.pictureVisible,true);
  assert.equal(await page.evaluate(`document.querySelector('#stage-comment').hidden`),true,'standalone interview hides the unbound comment entry');
  assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
  assert.equal(await page.evaluate(`document.querySelector('#workspace-interview-answer pre.interview-note')?.textContent`),retainedNote);
  const zoom=await page.evaluate(`document.querySelector('#zoom-value').textContent`);await click(page,'#zoom-in');
  assert.notEqual(await page.evaluate(`document.querySelector('#zoom-value').textContent`),zoom);
  assert.equal(await page.evaluate(`!!document.querySelector('#workspace-interview-answer input[type=radio]')`),true);
  await writeFile(join(out,language+'-interview.png'),await page.screenshot());
  const resize='.workspace-inspectorHeight';
  await page.evaluate(`document.querySelector(${JSON.stringify(resize)}).focus()`);
  await command!('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  await command!('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  await wait(`document.querySelector('#workspace-interview-answer').getBoundingClientRect().height!==${state.height}`);
  state.resizedHeight=await page.evaluate(`document.querySelector('#workspace-interview-answer').getBoundingClientRect().height`);
  await writeFile(join(out,language+'-resized.png'),await page.screenshot());
  const beforePicks=await readFile(join(f.root,'picks',question.ref.sha256+'.json'));
  await page.evaluate(`Date.prototype.toISOString=function(){return '2026-11-11T00:00:00.000Z';};document.querySelector('#workspace-interview-answer button[type=submit]').scrollIntoView({block:'center'});`);
  await click(page,'#workspace-interview-answer button[type=submit]');
  await wait(`document.querySelector('#workspace-interview-answer form>p[role=status]')?.textContent===${JSON.stringify(catalog['interview.saved'])}`);
  const afterPicks=await readFile(join(f.root,'picks',question.ref.sha256+'.json'));assert.deepEqual(afterPicks,beforePicks);
  state.savedPicksBytes=afterPicks.length;state.savedPicksByteEqual=true;
  state.cleanup=await page.evaluate(`(()=>{const zoom=document.querySelector('#zoom-in'),bound=typeof zoom.onclick==='function',enabled=!zoom.disabled;window.dispatchEvent(new Event('pagehide'));return {bound,enabled,released:zoom.onclick===null,disabled:zoom.disabled,modes:[...document.querySelectorAll('#view-menu [data-view]')].map(node=>node.dataset.view),bottom:!!document.querySelector('#workspace-interview-answer')};})()`);
  assert.equal(state.cleanup.bound,true);assert.equal(state.cleanup.enabled,true);assert.equal(state.cleanup.released,true);assert.equal(state.cleanup.disabled,false);assert.equal(state.cleanup.bottom,false);
  assert.deepEqual(state.cleanup.modes,['compare','reference','rig','difference']);
  cases.push(state);await page.goto('about:blank');
 }
 const after={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 assert.deepEqual(after,before);assert.deepEqual(exceptions,[]);assert.equal(mutations.length,2);assert.ok(mutations.every((item:any)=>item.method==='POST'&&item.path.endsWith('/api/interview/picks')));assert.ok(requests.some(path=>path.endsWith('/api/interview')));
 await writeFile(join(out,'result.json'),JSON.stringify({fixture:'synthetic interview-stage project; demo/build versions; no draft or review package',cases,sourceFilesBefore:before,sourceFilesAfter:after,sourceWrites:0,networkRequests:requests.length,exceptions,mutations},null,2)+'\n');
 console.log('725_BROWSER_PASS '+JSON.stringify({cases:cases.length,languages:['en','ko'],viewport:'1600x1000 DPR 2',sourceWrites:0,exceptions:exceptions.length}));
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,cases},null,2)+'\n');if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await host.stop();await f.close();await rm(profile,{recursive:true,force:true});}
