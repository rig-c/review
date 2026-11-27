/** #725 / #1230 synthetic managed-target browser proof, EN/KO. */
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
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {digest, readProject} from '../src/interview-project.ts';
import {readPicks, savePicks} from '../src/interview-picks.ts';
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
const plantedPicks=interviewPicksRecord(question.ref,question.set.asks.map(ask=>({ask:ask.id,option_id:ask.options.find(option=>option.kind==='value')!.id})),retainedNote,'2026-11-11T00:00:00.000Z');
savePicks(join(f.root,'picks'),question,plantedPicks);
const inputs=parseOpenInputs([f.root,'--project',f.root,'--picks-dir','picks']);
const prepared=await prepareOpenTarget(inputs,{stateDir:f.stateDir});
const host=await startOpenWorkspace({stateDir:f.stateDir,fingerprint:prepared.fingerprint,port:0});
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const requests:string[]=[];
const exceptions:unknown[]=[],mutations:unknown[]=[],cases:unknown[]=[];
async function wait(expression:string){const deadline=Date.now()+20_000;while(Date.now()<deadline){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('725_BROWSER_TIMEOUT '+expression);}
const sharedControls='#zoom-in,#zoom-out,#fit,#native-one,#view-menu';
const dialogViewer='dialog :is(.viewport,.interview-view,.interview-viewport,#reference-content,#rig-viewport,'+sharedControls+')';
const refusalSource='INTERVIEW_PICKS_DISABLED: the interview answer form has been removed; discuss options through live job comments.';
type RefusalScreen={
 language:string;width:number;height:number;topbars:number;viewports:number;modals:number;dialogViewers:number;
 forms:number;questionPanels:number;retiredRecordDomCount:number;modelCanvas:number;rigEmpty:string;footerMessage:string;
 refusalVisible:boolean;refusalError:boolean;refusalTitle:string;refusalText:string;
 actRowVisible:boolean;saveAbsent:boolean;reviewStatusAbsent:boolean;commentHidden:boolean;
 controls:string[];inspectorHidden:boolean;
};
let currentCase:{language:'en'|'ko';width:number;height:number;state?:RefusalScreen}|undefined;

try{
 // Historical picks reader proof (#1230): CLI/file reader and workspace route still read historical rig-review/interview-picks@1 verbatim.
 const cliPicks=readPicks(join(f.root,'picks'),question);
 assert.deepEqual(cliPicks,plantedPicks);
 assert.equal(cliPicks?.note,retainedNote);

 const before={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 const registration=await fetch(host.record.origin+'/workspace/api/register',{method:'POST',headers:{Authorization:'Bearer '+host.record.registrationCapability,'Content-Type':'application/json'},body:JSON.stringify({schema:WORKSPACE_SCHEMA,incarnation:host.record.incarnation,targets:[{key:prepared.key,contentHash:prepared.package.contentHash,cwd:prepared.cwd,viewOnly:false,inputs:prepared.package.inputs}]})});
 assert.equal(registration.status,200);
 const list=await (await fetch(host.record.origin+'/workspace/api/targets',{headers:{'X-Review-Capability':host.record.ownerCapability}})).json() as WorkspaceList;
 assert.equal(list.targets.length,1);

 const cap=targetCapability(host.record.ownerCapability,host.record.incarnation,prepared.key);
 const apiInterview=await (await fetch(host.record.origin+'/instances/'+prepared.key+'/api/interview',{headers:{'X-Review-Capability':cap}})).json() as {questions:{saved:typeof plantedPicks}[]};
 assert.deepEqual(apiInterview.questions[0]?.saved,plantedPicks);
 assert.equal(apiInterview.questions[0]?.saved.note,retainedNote);
 cases.push({kind:'historical-picks-reader',cliNote:cliPicks?.note,routeNote:apiInterview.questions[0]?.saved.note});

 page=await launchCdpSession(profile,{onEvent:(event,send)=>{command=send;if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request)requests.push(new URL(request.url).pathname);if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Network.enable');
 for(const [width,height] of [[1600,1000],[1600,360],[520,720]] as const)for(const language of ['en','ko'] as const){
  currentCase={language,width,height};
  await page.setViewport(width,height);
  const catalog=language==='en'?enCatalog:koCatalog,url=new URL(host.record.origin+list.targets[0]!.entry);
  url.searchParams.set('lang',language);url.hash='cap='+cap;
  await page.goto(url.href);
  await wait(`document.body.dataset.ready==='true'&&!document.body.inert&&document.getElementById('review-message')?.getAttribute('title')==='INTERVIEW_PICKS_DISABLED'`);
  const state:RefusalScreen=await page.evaluate(`(()=>{
   const visible=n=>!!n&&!!n.getClientRects().length&&!n.closest('[hidden],dialog:not([open])')&&getComputedStyle(n).visibility!=='hidden';
   const msg=document.getElementById('review-message'),row=document.getElementById('workspace-act-row');
   return {language:document.documentElement.lang,width:innerWidth,height:innerHeight,
    topbars:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,
    modals:document.querySelectorAll('dialog:modal').length,dialogViewers:document.querySelectorAll(${JSON.stringify(dialogViewer)}).length,
    forms:document.querySelectorAll('form.interview-answer').length,
    questionPanels:document.querySelectorAll('#workspace-interview-answer').length,
    retiredRecordDomCount:document.querySelectorAll('[id="workspace-pending-record-ask"],[id="job-record-asks"]').length,
    modelCanvas:document.querySelectorAll('#rig-root canvas').length,
    rigEmpty:document.getElementById('rig-empty').textContent.trim(),
    footerMessage:document.getElementById('message').textContent.trim(),
    refusalVisible:visible(msg),refusalError:msg.classList.contains('error'),
    refusalTitle:msg.getAttribute('title')??'',refusalText:msg.textContent.trim(),
    actRowVisible:visible(row),saveAbsent:document.getElementById('save')===null,reviewStatusAbsent:document.getElementById('review-status')===null,
    commentHidden:document.getElementById('stage-comment').hidden,
    controls:[...document.querySelectorAll('${sharedControls}')].map(node=>node.id),
    inspectorHidden:document.getElementById('workspace-inspector').hidden};
  })()`);
  currentCase.state=state;
  const expectedRefusal=catalog[refusalSource];
  assert.equal(state.language,language);assert.equal(state.width,width);assert.equal(state.height,height);
  assert.equal(state.topbars,1);assert.equal(state.viewports,1);assert.equal(state.modals,0);assert.equal(state.dialogViewers,0);
  assert.equal(state.forms,0,'#1230 removes the answer form');
  assert.equal(state.questionPanels,0,'#1230 removes the question panel');
  assert.equal(state.retiredRecordDomCount,0,'#1229 removes retired record-ask DOM');
  assert.equal(state.modelCanvas,0);
  assert.equal(state.refusalVisible,true,'named refusal is visible in the act row');
  assert.equal(state.refusalError,true);
  assert.equal(state.refusalTitle,'INTERVIEW_PICKS_DISABLED');
  assert.equal(state.refusalText,expectedRefusal);
  assert.equal(state.rigEmpty,expectedRefusal);
  assert.equal(state.footerMessage,expectedRefusal);
  assert.equal(state.actRowVisible,true);
  assert.equal(state.saveAbsent,true);
  assert.equal(state.reviewStatusAbsent,true);
  assert.equal(state.commentHidden,true,'standalone interview refusal hides unbound comment entry');
  assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
  assert.equal(state.inspectorHidden,true,'standalone interview has no view-controller block, so the bottom panel collapses to nothing');
  const prefix=language+(height===360?'-short':width===520?'-narrow':'');
  await writeFile(join(out,prefix+'-interview-refusal.png'),await page.screenshot());
  cases.push(state);
  await page.goto('about:blank');
  currentCase=undefined;
 }
 const after={files:await jobInputHashes(f.root),entries:(await readdir(f.root,{recursive:true})).sort()};
 assert.deepEqual(after,before);assert.deepEqual(exceptions,[]);assert.deepEqual(mutations,[]);assert.ok(requests.some(path=>path.endsWith('/api/review')));
 await writeFile(join(out,'result.json'),JSON.stringify({fixture:'synthetic interview-stage project; historical picks reader + INTERVIEW_PICKS_DISABLED refusal',cases,sourceFilesBefore:before,sourceFilesAfter:after,sourceWrites:0,networkRequests:requests.length,exceptions,mutations},null,2)+'\n');
 console.log('725_BROWSER_PASS '+JSON.stringify({cases:cases.length,languages:['en','ko'],viewports:['1600x1000','1600x360','520x720'],sourceWrites:0,exceptions:exceptions.length}));
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),currentCase,exceptions,mutations,cases},null,2)+'\n');if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await host.stop();await f.close();await rm(profile,{recursive:true,force:true});}
