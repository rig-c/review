/** Ordinary Nova browser verification for #441: refused Stage 3 mode-switch guard and supported rig restoration. */
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {alive,openReview,readRecord,running,smallJson,type RecordFile} from '../src/open.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';

const root=await mkdtemp(join(await realpath(tmpdir()),'rv441-'));
const artifacts=process.env.RV441_ARTIFACTS??join('artifacts','stage-refused-mode');
await mkdir(artifacts,{recursive:true});

const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const frontPort=probe.port!;
probe.stop(true);
const stateDir=join(root,'state');
const controlDir=join(stateDir,'open');
const launchOptions={stateDir,frontPort,frontIdleMs:1200,graceMs:400,idleMs:15000};
const page=await launchCdpSession(join(root,'browser'));
const frame="document.querySelector('.review-stage-panel iframe:not([hidden]):not(.review-interview-frame)')";
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

async function until(expression:string){
 for(let i=0;i<300;i++){
  if(await page.evaluate<boolean>(expression))return;
  await Bun.sleep(30);
 }
 throw new Error('BROWSER_WAIT '+expression+' '+await page.evaluate("document.querySelector('.review-stage-panel')?.textContent"));
}

interface Stage3Readout {
 lang:string;
 stage:string|null;
 stageRefused:string|null;
 statusText:string;
 statusVisible:boolean;
 modeSwitchHidden:boolean;
 modeSwitchDisplay:string;
 modeSwitchRects:number;
 controls:{mode:string|null;inspector:string|null;disabled:boolean;title:string|null;pressed:string|null;rects:number}[];
 usableModes:string[];
 plantedDetected?:string[];
}

interface WorkerExitEvidence {
 key:string;
 nonce:string;
 pid:number;
 recordRemoved:boolean;
 processExited:boolean;
 statusClosed:boolean;
}

const readStage3State=`(()=>{
 const status=document.querySelector('.review-stage-panel > [role=status]');
 const statusBox=status?.getBoundingClientRect();
 const modeSwitch=document.querySelector('.mode-switch');
 const controls=[...document.querySelectorAll('[data-mode],[data-inspector]')].map(btn=>({
  mode:btn.getAttribute('data-mode'),
  inspector:btn.getAttribute('data-inspector'),
  disabled:Boolean(btn.disabled),
  title:btn.getAttribute('title'),
  pressed:btn.getAttribute('aria-pressed'),
  rects:btn.getClientRects().length,
 }));
 const usableModes=controls.filter(c=>!c.disabled&&c.rects>0).map(c=>c.mode??c.inspector??'unknown');
 return {
  lang:document.documentElement.lang,
  stage:document.documentElement.dataset.inspectionStage??null,
  stageRefused:document.documentElement.dataset.stageRefused??null,
  statusText:status?.textContent??'',
  statusVisible:Boolean(status&&statusBox&&statusBox.width>0&&statusBox.height>0&&getComputedStyle(status).visibility!=='hidden'),
  modeSwitchHidden:Boolean(modeSwitch?.hidden),
  modeSwitchDisplay:modeSwitch?getComputedStyle(modeSwitch).display:'missing',
  modeSwitchRects:modeSwitch?modeSwitch.getClientRects().length:0,
  controls,
  usableModes,
 };
})()`;

function assertRefusedStage3(readout:Stage3Readout,lang:'en'|'ko',expectedRefusal:string){
 try{
  assert.equal(readout.lang,lang);
  assert.equal(readout.stage,'3');
  assert.equal(readout.stageRefused,'true');
  assert.equal(readout.statusText,expectedRefusal);
  assert.equal(readout.statusVisible,true);
  assert.equal(readout.modeSwitchHidden,true);
  assert.equal(readout.modeSwitchDisplay,'none');
  assert.equal(readout.modeSwitchRects,0);
  assert.deepEqual(readout.usableModes,[]);
  assert(readout.controls.length>0);
  for(const ctrl of readout.controls){
   assert.equal(ctrl.disabled,true);
   assert.equal(ctrl.title,expectedRefusal);
   if(ctrl.pressed!==null)assert.equal(ctrl.pressed,'false');
   assert.equal(ctrl.rects,0);
  }
 }catch(error){
  throw new Error(`STAGE3_REFUSED_GUARD: ${error instanceof Error?error.message:String(error)}`,{cause:error});
 }
}

const ownedWorkers:RecordFile[]=[];
let ownedFrontPid:number|null=null;
let browserClosed=false;

async function claimOwnedWorker(opened:Awaited<ReturnType<typeof openReview>>):Promise<RecordFile>{
 assert.equal(opened.reused,false);
 const key=new URL(opened.url).searchParams.get('handoff');
 assert(key&&/^[a-f0-9]{64}$/.test(key),'openReview URL must carry handoff key');
 const record=await readRecord(join(controlDir,`${key}.json`),key);
 assert(record,'test-owned worker record must exist in stateDir');
 assert.equal(record.nonce,opened.nonce);
 assert.equal(running(record.pid),true);
 const front=await smallJson(join(controlDir,`front-${frontPort}.json`)) as {pid?:number;port?:number};
 assert(typeof front.pid==='number'&&front.pid>0&&front.port===frontPort,'test-owned front record must exist in stateDir');
 ownedFrontPid=front.pid;
 ownedWorkers.push(record);
 return record;
}

async function closeBrowserAndVerifyWorkerExit():Promise<WorkerExitEvidence[]>{
 if(!browserClosed){
  browserClosed=true;
  await page.close();
 }
 const evidence:WorkerExitEvidence[]=[];
 for(const worker of ownedWorkers){
  const recordFile=join(controlDir,`${worker.key}.json`);
  await withDeadline(`WORKER_EXIT:${worker.key.slice(0,12)}`,5000,async()=>{
   while((await readRecord(recordFile,worker.key))!==null||running(worker.pid)){
    await Bun.sleep(25);
   }
  });
  const recordRemoved=(await readRecord(recordFile,worker.key))===null;
  const processExited=!running(worker.pid);
  const statusClosed=!(await alive(worker));
  assert.equal(recordRemoved,true);
  assert.equal(processExited,true);
  assert.equal(statusClosed,true);
  evidence.push({key:worker.key,nonce:worker.nonce,pid:worker.pid,recordRemoved,processExited,statusClosed});
 }
 if(ownedFrontPid!==null){
  const frontPid=ownedFrontPid;
  await withDeadline('FRONT_EXIT',5000,async()=>{
   while(running(frontPid)){
    await Bun.sleep(25);
   }
  });
  assert.equal(running(frontPid),false);
 }
 return evidence;
}

const report:{lang:'en'|'ko';refused:Stage3Readout;supportedBefore:Stage3Readout;workers?:{preRig:WorkerExitEvidence;demo:WorkerExitEvidence}}[]=[];

try{
 await page.setViewport(1440,1000);
 const sourceDemoManifest=JSON.parse(await readFile('examples/demo/review.json','utf8'));
 const demoModelHashBefore=sha256(await readFile(join('examples/demo',sourceDemoManifest.model)));
 const demoModelPaths:string[]=[];
 const demoKeys=new Set<string>();

 for(const lang of ['en','ko'] as const){
  const catalog=lang==='en'?enCatalog:koCatalog;
  const expectedRefusal=catalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.']!;
  const fixture=await joinedVerdictFixture(join(root,'pre-rig-'+lang));
  const openedPreRig=await openReview({input:fixture.input,project:fixture.project},launchOptions);
  await claimOwnedWorker(openedPreRig);
  const preRigUrl=new URL(openedPreRig.url);
  preRigUrl.searchParams.set('lang',lang);
  await page.goto(preRigUrl.href,lang);
  await until(`${frame}?.contentDocument?.body?.dataset?.ready==='true'`);
  assert.equal(await page.evaluate(`document.documentElement.lang`),lang);
  assert.equal(await page.evaluate(`${frame}?.contentDocument?.documentElement?.lang`),lang);
  assert.equal(await page.evaluate(`document.documentElement.dataset.inspectionStage`),'1');

  // Switch to Stage 3 on the pre-rig draft (no recorded rig review package).
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click()`);
  await until(`document.documentElement.dataset.inspectionStage==='3'&&Boolean(document.querySelector('.review-stage-panel > [role=status]')?.textContent)`);
  const refusedBeforePlant=await page.evaluate<Stage3Readout>(readStage3State);
  assertRefusedStage3(refusedBeforePlant,lang,expectedRefusal);

  // Planted DOM control verifies that unguarded Stage 3 mode buttons are caught by the same readStage3State oracle and named guard.
  await page.evaluate(`(()=>{
   const ms=document.querySelector('.mode-switch'),setup=document.querySelector('[data-mode="rig"]');
   delete document.documentElement.dataset.stageRefused;
   ms.hidden=false;setup.disabled=false;
  })()`);
  const planted=await page.evaluate<Stage3Readout>(readStage3State);
  assert.throws(()=>assertRefusedStage3(planted,lang,expectedRefusal),/^Error: STAGE3_REFUSED_GUARD:/);
  assert.equal(planted.stageRefused,null);
  assert.equal(planted.modeSwitchHidden,false);
  assert.notEqual(planted.modeSwitchDisplay,'none');
  assert(planted.modeSwitchRects>0,'planted unguarded mode-switch must have client rects');
  assert.deepEqual(planted.usableModes,['rig']);

  // Restore via Stage 3 re-click, then assert the same DOM readout after restore before capturing the screenshot.
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click()`);
  await until(`document.documentElement.dataset.stageRefused==='true'&&document.querySelector('.mode-switch')?.hidden===true`);
  const refused=await page.evaluate<Stage3Readout>(readStage3State);
  assertRefusedStage3(refused,lang,expectedRefusal);
  assert.deepEqual(refused,refusedBeforePlant);
  refused.plantedDetected=planted.usableModes;
  await writeFile(join(artifacts,`${lang}-pre-rig-stage3-refused.png`),await page.screenshot());
  await fixture.assertFixture();

  // Verify supported real model path in the same language with a distinct ordinary demo key per locale.
  const demoDir=join(root,'demo-'+lang);
  await cp('examples/demo',demoDir,{recursive:true});
  const demoManifestPath=join(demoDir,'review.json');
  const demoManifest=JSON.parse(await readFile(demoManifestPath,'utf8'));
  const demoModelPath=join(demoDir,demoManifest.model);
  assert.equal(sha256(await readFile(demoModelPath)),demoModelHashBefore);
  demoModelPaths.push(demoModelPath);

  const openedDemo=await openReview({input:demoManifestPath,viewOnly:true},launchOptions);
  const demoRecord=await claimOwnedWorker(openedDemo);
  assert(!demoKeys.has(demoRecord.key),'supported demo open key must be distinct per locale');
  demoKeys.add(demoRecord.key);

  const demoUrl=new URL(openedDemo.url);
  demoUrl.searchParams.set('lang',lang);
  await page.goto(demoUrl.href,lang);
  await until(`Boolean(document.querySelector('[data-review-stage="3"]'))&&!document.getElementById('play').disabled`);
  assert.equal(await page.evaluate(`document.documentElement.lang`),lang);
  await page.evaluate(`if(document.getElementById('play').textContent!=='▶')document.getElementById('play').click()`);
  const supportedBefore=await page.evaluate<Stage3Readout>(readStage3State);
  assert.equal(supportedBefore.lang,lang);
  assert.equal(supportedBefore.stage,'3');
  assert.equal(supportedBefore.stageRefused,null);
  assert.equal(supportedBefore.modeSwitchHidden,false);
  assert.notEqual(supportedBefore.modeSwitchDisplay,'none');
  assert(supportedBefore.modeSwitchRects>0,'supported Stage 3 mode-switch must be visible');
  assert.deepEqual(supportedBefore.usableModes,['rig','playback']);

  await page.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
  assert.equal(await page.evaluate(`document.querySelector('[data-mode="playback"]').getAttribute('aria-pressed')`),'true');
  await page.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.mode-switch')).display`),'none');
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click()`);
  assert.notEqual(await page.evaluate(`getComputedStyle(document.querySelector('.mode-switch')).display`),'none');
  assert.equal(await page.evaluate(`document.querySelector('[data-mode="playback"]').getAttribute('aria-pressed')`),'true');
  assert.equal(await page.evaluate(`document.documentElement.lang`),lang);
  await writeFile(join(artifacts,`${lang}-supported-stage3.png`),await page.screenshot());

  report.push({lang,refused,supportedBefore});
 }

 assert.equal(demoKeys.size,2);
 for(const demoModelPath of demoModelPaths){
  assert.equal(sha256(await readFile(demoModelPath)),demoModelHashBefore);
 }
 const workerExits=await closeBrowserAndVerifyWorkerExit();
 assert.equal(workerExits.length,4);
 for(let i=0;i<report.length;i++){
  report[i]!.workers={preRig:workerExits[i*2]!,demo:workerExits[i*2+1]!};
 }
 await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{
 if(!browserClosed)await closeBrowserAndVerifyWorkerExit().catch(()=>{});
 await rm(root,{recursive:true,force:true});
}
