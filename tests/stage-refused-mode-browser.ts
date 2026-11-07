/** Ordinary Nova browser verification for #441: refused Stage 3 mode-switch guard and supported rig restoration. */
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openReview} from '../src/open.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';

const root=await mkdtemp(join(await realpath(tmpdir()),'rv441-'));
const artifacts=process.env.RV441_ARTIFACTS??join('artifacts','stage-refused-mode');
await mkdir(artifacts,{recursive:true});

const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const frontPort=probe.port!;
probe.stop(true);
const stateDir=join(root,'state');
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

const report:unknown[]=[];

try{
 await page.setViewport(1440,1000);
 const demoDir=join(root,'demo');
 await cp('examples/demo',demoDir,{recursive:true});
 const demoManifestPath=join(demoDir,'review.json');
 const demoManifest=JSON.parse(await readFile(demoManifestPath,'utf8'));
 const demoModelPath=join(demoDir,demoManifest.model);
 const demoModelHashBefore=sha256(await readFile(demoModelPath));

 for(const lang of ['en','ko'] as const){
  const catalog=lang==='en'?enCatalog:koCatalog;
  const expectedRefusal=catalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.']!;
  const fixture=await joinedVerdictFixture(join(root,'pre-rig-'+lang));
  const openedPreRig=await openReview({input:fixture.input,project:fixture.project},launchOptions);
  const preRigUrl=new URL(openedPreRig.url);
  preRigUrl.searchParams.set('lang',lang);
  await page.goto(preRigUrl.href);
  await until(`${frame}?.contentDocument?.body?.dataset?.ready==='true'`);
  assert.equal(await page.evaluate(`document.documentElement.dataset.inspectionStage`),'1');

  // Switch to Stage 3 on the pre-rig draft (no recorded rig review package).
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click()`);
  await until(`document.documentElement.dataset.inspectionStage==='3'&&Boolean(document.querySelector('.review-stage-panel > [role=status]')?.textContent)`);
  const refused=await page.evaluate<Stage3Readout>(readStage3State);
  assert.equal(refused.stage,'3');
  assert.equal(refused.stageRefused,'true');
  assert.equal(refused.statusText,expectedRefusal);
  assert.equal(refused.statusVisible,true);
  assert.equal(refused.modeSwitchHidden,true);
  assert.equal(refused.modeSwitchDisplay,'none');
  assert.equal(refused.modeSwitchRects,0);
  assert.deepEqual(refused.usableModes,[]);
  for(const ctrl of refused.controls){
   assert.equal(ctrl.disabled,true);
   assert.equal(ctrl.title,expectedRefusal);
   if(ctrl.pressed!==null)assert.equal(ctrl.pressed,'false');
   assert.equal(ctrl.rects,0);
  }

  // Planted DOM control verifies that unguarded Stage 3 mode buttons would be caught by the browser oracle.
  const plantedDetected=await page.evaluate<string[]>(`(()=>{
   const ms=document.querySelector('.mode-switch'),setup=document.querySelector('[data-mode="rig"]');
   delete document.documentElement.dataset.stageRefused;
   ms.hidden=false;setup.disabled=false;
   const detected=[...document.querySelectorAll('[data-mode]')].filter(b=>!b.disabled&&b.getClientRects().length>0).map(b=>b.getAttribute('data-mode'));
   document.querySelector('[data-review-stage="3"]').click();
   return detected;
  })()`);
  assert.deepEqual(plantedDetected,['rig']);
  refused.plantedDetected=plantedDetected;
  await writeFile(join(artifacts,`${lang}-pre-rig-stage3-refused.png`),await page.screenshot());
  await fixture.assertFixture();

  // Verify supported real model path in the same language keeps Stage 3 and Setup/Animate usable.
  const openedDemo=await openReview({input:demoManifestPath,viewOnly:true},launchOptions);
  const demoUrl=new URL(openedDemo.url);
  demoUrl.searchParams.set('lang',lang);
  await page.goto(demoUrl.href);
  await until(`Boolean(document.querySelector('[data-review-stage="3"]'))&&!document.getElementById('play').disabled`);
  await page.evaluate(`if(document.getElementById('play').textContent!=='▶')document.getElementById('play').click()`);
  const supportedBefore=await page.evaluate<Stage3Readout>(readStage3State);
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
  await writeFile(join(artifacts,`${lang}-supported-stage3.png`),await page.screenshot());

  report.push({lang,refused,supportedBefore});
 }

 assert.equal(sha256(await readFile(demoModelPath)),demoModelHashBefore);
 await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{
 await page.close();
 await Bun.sleep(2200);
 await rm(root,{recursive:true,force:true});
}
