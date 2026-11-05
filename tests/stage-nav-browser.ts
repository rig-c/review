import {PROBE_MP4_BASE64} from './compare-mode-browser.ts';
/** Synthetic public fixtures only; run on Nova. Exercises retained controllers and source immutability. */
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadReview} from '../src/manifest.ts';
import {openReview} from '../src/open.ts';
import {readdir} from 'node:fs/promises';
import {startServer} from '../src/server.ts';
import {loadPartsView} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {writePartsPackage} from './helpers/parts-package.ts';
import {launchCdpSession,type CdpSession} from './parts-explorer-browser.ts';
const root=await mkdtemp(join(tmpdir(),'stage-nav-')),shots='stage-nav-evidence';await mkdir(shots,{recursive:true});
const capability='d'.repeat(64),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const results:unknown[]=[];let page:CdpSession|null=null;const servers:{stop:(force?:boolean)=>unknown}[]=[];
function assert(ok:unknown,why:string){if(!ok)throw new Error(why);}
async function wait(expression:string){for(let n=0;n<200;n++){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('Timed out: '+expression);}
const click=(n:number)=>`document.querySelector('[data-review-stage="${n}"]').click()`;
try{
 page=await launchCdpSession(join(root,'profile'));await page.setViewport(1440,1000);
 await writePartsPackage(root);const parts=await loadPartsView(root),partsServer=await startPartsServer(parts,{port:0,capability,graceMs:60000});servers.push(partsServer);
 await cp('examples/demo',join(root,'compiled'),{recursive:true});
 const manifestPath=join(root,'compiled','review.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.authoring.push({label:'Planted unsafe authoring HTML',path:'hostile.html'});await writeFile(join(root,'compiled','hostile.html'),'<script>parent.__assetApproved=true;fetch("/api/session",{method:"PUT",body:"{}"})</script>');await writeFile(manifestPath,JSON.stringify(manifest));
 const p=await loadReview(manifestPath),before=hash(await readFile(join(p.root,p.manifest.model!))),server=await startServer(p,{port:0,capability,stateDir:join(root,'state'),viewOnly:true,graceMs:60000});servers.push(server);
 for(const lang of ['en','ko']){
  await page.goto(`http://127.0.0.1:${partsServer.port}/?lang=${lang}#cap=${capability}`);await wait('document.body.dataset.ready==="true"');
  assert(await page.evaluate<boolean>(`getComputedStyle(document.getElementById('pv-atlas-switch')).display==='none'`),'parts-only has no atlas-only buttons');
  const stages=await page.evaluate<string[]>('[...document.querySelectorAll("[data-review-stage]")].map(b=>b.textContent)');assert(stages.length===4,'four parts stages');
  await page.evaluate(`document.querySelectorAll('[data-pv-item]')[1].click();document.getElementById('pv-note').value='verbatim pending note';document.getElementById('pv-note').dispatchEvent(new Event('input'));`);
  const selected=await page.evaluate<string>('document.querySelector("[data-pv-item][aria-current=true]").dataset.pvItem');
  for(const n of [2,3,4]){await page.evaluate(click(n));assert(await page.evaluate<boolean>('!document.querySelector(".review-stage-panel").hidden'),'unavailable stage visible');}
  await page.evaluate(click(1));assert(await page.evaluate<boolean>(`document.getElementById('pv-note').value==='verbatim pending note'&&document.querySelector('[data-pv-item][aria-current=true]').dataset.pvItem===${JSON.stringify(selected)}`),'parts selection/note retained');
  await writeFile(join(shots,`parts-${lang}.png`),await page.screenshot());
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}#cap=${capability}`);await wait('!!document.querySelector("[data-review-stage]")&&document.getElementById("package-title").textContent!=="Review package"');
  await wait('!document.getElementById("play").disabled');await page.evaluate(`if(document.getElementById('play').textContent!=='▶')document.getElementById('play').click()`);
  const sandboxed=await page.evaluate<boolean>(`(async()=>{window.__assetApproved=true;if(window.__assetApproved!==true)return false;window.__assetApproved=false;const f=document.createElement('iframe');f.src='assets/hostile.html';document.body.append(f);await new Promise(r=>{f.onload=r;setTimeout(r,1000)});await new Promise(r=>setTimeout(r,100));let opaque=false;try{void f.contentWindow.document.body}catch{opaque=true}f.remove();return !window.__assetApproved&&opaque})()`);assert(sandboxed,'authoring HTML cannot access parent or approve');
  const compiledStages=await page.evaluate<string[]>('[...document.querySelectorAll("[data-review-stage]")].map(b=>b.textContent)');assert(JSON.stringify(stages)===JSON.stringify(compiledStages),'same stages');
  await page.evaluate(`document.querySelector('[data-mode=playback]').click();document.getElementById('feedback-summary').value='pending reviewer text';document.getElementById('feedback-summary').dispatchEvent(new Event('input',{bubbles:true}));`);
  await wait('!!document.querySelector("[data-part-list] button[data-slot]")');await page.evaluate(`const part=document.querySelector('[data-part-list] button[data-slot]');if(part.getAttribute('aria-pressed')!=='true')part.click()`);
  const state=await page.evaluate<string>(`JSON.stringify({mode:document.querySelector('[data-mode][aria-pressed=true]')?.dataset.mode,time:document.getElementById('scrub')?.value,summary:document.getElementById('feedback-summary').value})`);
  assert(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.mode-switch')).display!=='none'`),'legacy modes are inside stage3');
  await page.evaluate(click(1));assert(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.mode-switch')).display==='none'`),'only four primary stages outside stage3');await wait('document.querySelector(".review-stage-panel iframe")?.contentDocument?.body?.dataset.ready==="true"');
  assert(await page.evaluate<boolean>('document.querySelector(".review-stage-panel iframe").contentDocument.querySelector("#pv-save").disabled'),'read-only embedded');assert(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.review-stage-panel iframe').contentDocument.querySelector('.pv-verdict')).display==='none'`),'embedded sign-off hidden');
  const frame=await page.evaluate<string>(`(()=>{const f=document.querySelector('.review-stage-panel iframe');f.contentDocument.querySelectorAll('[data-pv-item]')[1]?.click();return f.contentDocument.querySelector('[data-pv-item][aria-current=true]')?.dataset.pvItem})()`);
  const opposite=lang==='en'?'ko':'en';
  await page.evaluate(`(()=>{const s=document.getElementById('settings-language');s.value=${JSON.stringify(opposite)};s.dispatchEvent(new Event('change'))})()`);await wait(`document.querySelector('.review-stage-panel iframe').contentDocument.documentElement.lang===${JSON.stringify(opposite)}`);
  await page.evaluate(`(()=>{const s=document.getElementById('settings-language');s.value=${JSON.stringify(lang)};s.dispatchEvent(new Event('change'))})()`);await wait(`document.querySelector('.review-stage-panel iframe').contentDocument.documentElement.lang===${JSON.stringify(lang)}`);
  for(const n of [2,4,3,1]){await page.evaluate(click(n));assert(await page.evaluate<boolean>(`(getComputedStyle(document.querySelector('.mode-switch')).display!=='none')===${n===3}`),'legacy mode hierarchy at stage '+n);}
  assert(await page.evaluate<boolean>(`document.querySelector('.review-stage-panel iframe').contentDocument.querySelector('[data-pv-item][aria-current=true]')?.dataset.pvItem===${JSON.stringify(frame)}`),'atlas selection retained');
  await writeFile(join(shots,`compiled-atlas-${lang}.png`),await page.screenshot());
  await page.evaluate(click(3));assert(await page.evaluate<string>(`JSON.stringify({mode:document.querySelector('[data-mode][aria-pressed=true]')?.dataset.mode,time:document.getElementById('scrub')?.value,summary:document.getElementById('feedback-summary').value})`)===state,'compiled mode/time/draft retained; before='+state+' after='+await page.evaluate<string>(`JSON.stringify({mode:document.querySelector('[data-mode][aria-pressed=true]')?.dataset.mode,time:document.getElementById('scrub')?.value,summary:document.getElementById('feedback-summary').value})`));
  // This viewOnly fixture exercises inspected model + slot/time/reviewer draft, not a fabricated producer Apply.
  await page.evaluate(click(1));
  const reviewEntry=await page.evaluate<{before:string;after:string;stageAtOpen:string;open:boolean;summary:string}>(`(()=>{const d=document.getElementById('review-dialog'),native=d.showModal.bind(d);d.showModal=function(){window.__reviewStageAtOpen=document.documentElement.dataset.inspectionStage;return native()};const snapshot=()=>JSON.stringify({stage:window.rigReviewEditor.stage(),ops:window.rigReviewEditor.animation.ops(),slot:document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot,summary:document.getElementById('feedback-summary').value});const before=snapshot();document.getElementById('write-review').click();return {before,after:snapshot(),stageAtOpen:window.__reviewStageAtOpen,open:d.open,summary:document.getElementById('feedback-summary').value}})()`);
  assert(reviewEntry.open&&reviewEntry.stageAtOpen==='3'&&reviewEntry.before===reviewEntry.after&&reviewEntry.summary==='pending reviewer text','common review entry reveals actual stage3 BEFORE showModal and preserves inspected state/draft');
  await writeFile(join(shots,`review-context-${lang}.png`),await page.screenshot());
  await page.evaluate(`document.getElementById('review-dialog-close').click()`);assert(await page.evaluate<boolean>(`document.documentElement.dataset.inspectionStage==='3'&&document.querySelector('.review-stage-panel').hidden`),'closing review keeps actual review context visible');
  const alias=await page.evaluate<boolean>(`(()=>{window.__reviewStageAtOpen=null;const before=JSON.stringify(window.rigReviewEditor.stage()),button=document.querySelector('[data-proposal=timing]');if(!button||button.disabled)return false;button.click();const ok=document.getElementById('review-dialog').open&&window.__reviewStageAtOpen==='3'&&before===JSON.stringify(window.rigReviewEditor.stage());document.getElementById('review-dialog-close').click();return ok})()`);assert(alias,'existing timing proposal -> showInspector(feedback) uses common guarded review entry');
  await writeFile(join(shots,`compiled-rig-${lang}.png`),await page.screenshot());results.push({lang,stages,partsSelection:selected,atlasSelection:frame,retained:true});
 }
 const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),frontPort=probe.port!;probe.stop(true);
 const managed=await openReview({input:manifestPath,viewOnly:true},{stateDir:join(root,'managed'),frontPort});
 for(const lang of ['en','ko']){
  const url=new URL(managed.url);url.searchParams.set('lang',lang);await page.goto(url.href);await wait('!!document.querySelector("[data-review-stage]")');await page.evaluate(click(1));await wait('document.querySelector(".review-stage-panel iframe")?.contentDocument?.body?.dataset.ready==="true"');
  assert(await page.evaluate<boolean>(`document.querySelector('.review-stage-panel iframe').src.includes('/instances/')&&document.querySelector('.review-stage-panel iframe').contentDocument.documentElement.lang===${JSON.stringify(lang)}`),'managed trusted query actually reaches atlas');
  await writeFile(join(shots,`managed-atlas-${lang}.png`),await page.screenshot());results.push({managed:true,lang,atlasReady:true});
 }
 await cp(join(root,'compiled'),join(root,'compiled-b'),{recursive:true});const manifestB=join(root,'compiled-b','review.json'),b=JSON.parse(await readFile(manifestB,'utf8'));b.id='atlas-side-b';b.title='Generated B';await writeFile(manifestB,JSON.stringify(b));const reference=join(root,'reference.mp4');await writeFile(reference,Buffer.from(PROBE_MP4_BASE64,'base64'));
 const compareProbe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),comparePort=compareProbe.port!;compareProbe.stop(true);
 const compared=await openReview({input:manifestPath,compare:manifestB,reference,animation:'idle'},{stateDir:join(root,'managed-compare'),frontPort:comparePort});
 for(const lang of ['en','ko']){
  const url=new URL(compared.url);url.searchParams.set('lang',lang);await page.goto(url.href);await wait('!!document.querySelector("[data-review-stage]")&&!!window.rigReviewEditor');
  await wait('!document.getElementById("play").disabled&&!!document.querySelector("#b-root canvas,#b-root img")');await page.evaluate(`if(document.getElementById('play').textContent!=='▶')document.getElementById('play').click()`);
  const timeBefore=await page.evaluate<string>(`document.getElementById('scrub').value`);await page.evaluate(click(1));
  assert(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.mode-switch')).display==='none'&&getComputedStyle(document.getElementById('mode-build-picker')).display!=='none'`),'compare stage1 keeps source picker, hides legacy modes');
  await wait('document.querySelector(".review-stage-panel iframe:not([hidden])")?.contentDocument?.body?.dataset.ready==="true"');
  await page.evaluate(`document.querySelector('[data-build-side=b]').click()`);await wait('document.querySelector(".review-stage-panel iframe:not([hidden])")?.contentDocument?.getElementById("pv-title")?.textContent==="Generated B"');
  const binding=await page.evaluate<boolean>(`(async()=>{const comparison=await (await fetch(new URL('api/compare',location.href))).json(),atlas=await (await fetch(new URL('api/compare/b/stage-parts',location.href))).json();return atlas.inspectionSourceHash===comparison.b.sourceHash})()`);assert(binding,'managed B atlas uses exact B source binding');
  await page.evaluate(`document.querySelector('.review-stage-panel iframe:not([hidden])').contentWindow.__retainedAtlas='b';document.querySelector('[data-build-side=a]').click();document.querySelector('[data-build-side=b]').click()`);
  assert(await page.evaluate<boolean>(`document.querySelector('.review-stage-panel iframe:not([hidden])').contentWindow.__retainedAtlas==='b'`),'compare cached source frame retained');const timeAfter=await page.evaluate<string>(`document.getElementById('scrub').value`);assert(timeAfter===timeBefore,'compare time retained before='+timeBefore+' after='+timeAfter);
  await writeFile(join(shots,`managed-compare-atlas-${lang}.png`),await page.screenshot());await page.evaluate(click(3));assert(await page.evaluate<boolean>(`getComputedStyle(document.querySelector('.mode-switch')).display!=='none'&&document.querySelector('[data-mode=compare]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-build-side=b]').getAttribute('aria-pressed')==='true'`),'compare canonical mode and picked side restored');results.push({managedCompare:true,lang,binding:true,retained:true});
 }
 for(const file of parts.files)assert(hash(await readFile(file.abs))===file.sha256,'parts input bytes immutable');
 const afterHash=hash(await readFile(join(p.root,p.manifest.model!)));
 assert(afterHash===before,'model immutable');
 await writeFile(join(shots,'report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await page?.close();for(const server of servers)server.stop(true);
 for(const state of ['managed','managed-compare']){const directory=join(root,state,'open');for(const name of await readdir(directory).catch(()=>[])){if(!/^(?:[a-f0-9]{64}|front-\d+)\.json$/.test(name))continue;const row=JSON.parse(await readFile(join(directory,name),'utf8'));const path=name.startsWith('front-')?'/api/front-status':'/api/open-status';try{const response=await fetch(row.origin+path,{headers:{authorization:'Bearer '+row.nonce},signal:AbortSignal.timeout(500)});if((await response.json()).nonce===row.nonce)process.kill(row.pid,'SIGTERM');}catch{}}}
 await rm(root,{recursive:true,force:true});}

