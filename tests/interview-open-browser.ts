/** #725 synthetic browser proof; ordinary Nova only, 1600x1000 EN/KO.
 * Uses the shipped managed target and main/dialog/interview components. No submission or source write. */
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
 for(const language of ['en','ko'] as const){
  const catalog=language==='en'?enCatalog:koCatalog,url=new URL(host.record.origin+list.targets[0]!.entry);
  url.searchParams.set('lang',language);url.hash='cap='+targetCapability(host.record.ownerCapability,host.record.incarnation,prepared.key);
  await page.goto(url.href);
  await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#job-record-asks[open] .interview-grid')`);
  await wait(`document.querySelector('#job-record-asks canvas')?.width===32`);
  const state:any=await page.evaluate<any>(`(()=>{const dialog=document.querySelector('#job-record-asks'),r=dialog.getBoundingClientRect();return {language:document.documentElement.lang,width:innerWidth,height:innerHeight,topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,dialogs:document.querySelectorAll('dialog[open]').length,formCount:dialog.querySelectorAll('form.interview-answer').length,noteInputs:dialog.querySelectorAll('textarea[name=note]').length,columns:[...dialog.querySelector('form.interview-answer').children].filter(node=>['NAV','ASIDE','FIELDSET'].includes(node.tagName)).map(node=>node.tagName),imageControls:[...dialog.querySelectorAll('.interview-view .view-zoom button')].map(node=>node.textContent),focusContained:dialog.contains(document.activeElement),modelCanvas:document.querySelectorAll('#rig-root canvas').length,modelReason:document.getElementById('rig-empty').textContent,interviewButton:document.getElementById('workspace-pending-ask').textContent,controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>node.id),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};})()`);
  assert.equal(state.language,language);assert.equal(state.width,1600);assert.equal(state.height,1000);
  assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.dialogs,1);assert.equal(state.formCount,1);assert.equal(state.focusContained,true);assert.equal(state.modelCanvas,0);
  assert.equal(state.noteInputs,0);assert.deepEqual(state.columns,['NAV','ASIDE','FIELDSET']);
  assert.equal(await page.evaluate(`document.querySelector('#job-record-asks pre.interview-note')?.textContent`),retainedNote);
  assert.equal(state.interviewButton,catalog['interview.title']);
  assert.equal(state.modelReason,catalog['MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.']);
  assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
  assert.ok(state.rect.x>=0&&state.rect.y>=0&&state.rect.x+state.rect.width<=1600&&state.rect.y+state.rect.height<=1000);
  await writeFile(join(out,language+'-interview.png'),await page.screenshot());
  await click(page,'#job-record-asks .workspace-drawer-close');
  assert.equal(await page.evaluate(`!document.querySelector('dialog[open]')&&document.activeElement.id==='workspace-pending-ask'`),true);
  assert.equal(await page.evaluate(`document.querySelectorAll('.topbar').length===1&&document.querySelectorAll('#rig-viewport').length===1`),true);
  const closed:{visibleInterviewTriggers:string[];saveDisabled:boolean;focused:string}=await page.evaluate<{visibleInterviewTriggers:string[];saveDisabled:boolean;focused:string}>(`(()=>{const label=${JSON.stringify(catalog['interview.title'])};return {visibleInterviewTriggers:[...document.querySelectorAll('button')].filter(button=>button.textContent.trim()===label&&button.getClientRects().length>0&&getComputedStyle(button).visibility!=='hidden').map(button=>button.id),saveDisabled:document.getElementById('save').disabled,focused:document.activeElement.id};})()`);
  assert.deepEqual(closed.visibleInterviewTriggers,['workspace-pending-ask']);assert.equal(closed.saveDisabled,true);assert.equal(closed.focused,'workspace-pending-ask');
  state.closedWorkspace=closed;
  await writeFile(join(out,language+'-workspace.png'),await page.screenshot());
  await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#job-record-asks[open] .interview-grid')`);
  cases.push(state);await page.goto('about:blank');
 }
 const after={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 assert.deepEqual(after,before);assert.deepEqual(exceptions,[]);assert.deepEqual(mutations,[]);assert.ok(requests.some(path=>path.endsWith('/api/interview')));
 await writeFile(join(out,'result.json'),JSON.stringify({fixture:'synthetic interview-stage project; demo/build versions; no draft or review package',cases,sourceFilesBefore:before,sourceFilesAfter:after,sourceWrites:0,networkRequests:requests.length,exceptions,mutations},null,2)+'\n');
 console.log('725_BROWSER_PASS '+JSON.stringify({cases:cases.length,languages:['en','ko'],viewport:'1600x1000',sourceWrites:0,exceptions:exceptions.length}));
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,cases},null,2)+'\n');if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await host.stop();await f.close();await rm(profile,{recursive:true,force:true});}
