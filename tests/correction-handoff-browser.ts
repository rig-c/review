import projectPackage from '../package.json';
/** Actual installed-producer Stage-1 loop; explicit runner, never part of the unit suite. */
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm,cp} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writeStage1LivePackage} from './helpers/stage1-live-package.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {loadReview} from '../src/manifest.ts';
import {sessionFile} from '../src/session.ts';
import {patchText} from '../src/config-patch.ts';
import {rebuildDir} from '../src/rebuild.ts';
import {startServer} from '../src/server.ts';
import { WalkDeadlineError, withDeadline } from './helpers/walk-deadline.ts';

const CDP_SEND_DEADLINE_MS = 10_000;
const READINESS_DEADLINE_MS = 10_000;
const DESCRIBED_DEADLINE_MS = 5_000;
// One ordinary-pool run, n=2 (EN 7.390 s, KO 7.405 s).
// Allow 4× the larger hold, rounded up to 30 s.
const MESH_SETTLE_DEADLINE_MS = 30_000;
const PARTS_DOCUMENT = "document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument";

type CorrectionPage = Pick<InputCdpSession, 'evaluate'>;

async function pollCorrection<T>(signal: AbortSignal, read: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const result = await read();
    signal.throwIfAborted();
    if (result !== undefined) return result;
    await Bun.sleep(25);
  }
}

async function waitForReadiness(page: CorrectionPage, name: string, timeout: number, expression: string) {
  let detail: string | null | undefined;
  try {
    await withDeadline(name, timeout, signal => pollCorrection(signal, async () => {
      const status = await page.evaluate<{ready: boolean; detail?: string | null}>(expression);
      detail = status.detail;
      return status.ready ? true : undefined;
    }));
  } catch (error) {
    if (error instanceof WalkDeadlineError && detail !== undefined) error.message += ' ' + detail;
    throw error;
  }
}

type MeshResult = {status: string; check?: {pass?: boolean}};
type MeshState =
  | {state: 'pending'}
  | {state: 'fulfilled'; job: MeshResult}
  | {state: 'rejected'; error: string};

export function settleCorrectionMesh(page: CorrectionPage, timeout = MESH_SETTLE_DEADLINE_MS): Promise<MeshResult> {
  return withDeadline('CORRECTION_HANDOFF_MESH_SETTLE', timeout, async signal => {
    await Bun.sleep(200);
    signal.throwIfAborted();
    // A lost response is ambiguous. This dispatch is never retried.
    await page.evaluate(`(() => {
      const m = window.rigReviewEditor.mesh;
      if (m.part() !== 'torso') throw Error('WRONG_PARAMETER_PART');
      m.set(['contour','spacing'],18);
      window.correctionHandoffMesh = {state: 'pending'};
      Promise.resolve(m.apply()).then(
        job => { window.correctionHandoffMesh = {state: 'fulfilled', job}; },
        error => { window.correctionHandoffMesh = {state: 'rejected', error: String(error?.stack || error)}; }
      );
    })()`);
    return pollCorrection(signal, async () => {
      const status = await page.evaluate<MeshState>('window.correctionHandoffMesh');
      if (status.state === 'rejected') throw Error('Browser evaluate error: ' + status.error);
      return status.state === 'fulfilled' ? status.job : undefined;
    });
  });
}

if (import.meta.main) {
const bench=process.env.RV367_BENCH!;if(!bench)throw Error('Installed producer bench required');
const root=await mkdtemp(join(tmpdir(),'r.')),pkg=join(root,'pkg'),artifacts=join(process.cwd(),'artifacts/correction-handoff');
await mkdir(artifacts,{recursive:true});
async function hashes(dir:string){const out:Record<string,string>={};const walk=async(at:string)=>{for(const e of await readdir(at,{withFileTypes:true})){const f=join(at,e.name);if(e.isDirectory())await walk(f);else out[relative(dir,f)]=createHash('sha256').update(await readFile(f)).digest('hex');}};await walk(dir);return out;}
async function producer(args:string[]){const child=Bun.spawn([process.execPath,join(bench,'node_modules/@rig-c/parts/cli.ts'),...args],{cwd:bench,stdout:'pipe',stderr:'pipe'});const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);console.log(out+err);if(exit!==0)throw Error('PRODUCER_FIXTURE_REFUSED '+exit);}
let page:InputCdpSession|undefined,server:Awaited<ReturnType<typeof startServer>>|undefined;
const receipts:any[]=[];
const versions={parts:JSON.parse(await readFile(join(bench,'node_modules/@rig-c/parts/package.json'),'utf8')).version,core:JSON.parse(await readFile(join(bench,'node_modules/@rig-c/core/package.json'),'utf8')).version};let partsCompiler=versions.core;try{partsCompiler=JSON.parse(await readFile(join(bench,'node_modules/@rig-c/parts/node_modules/@rig-c/core/package.json'),'utf8')).version;}catch{}
const toolPaths=['@rig-c/parts/package.json','@rig-c/parts/cli.ts','@rig-c/core/package.json',
 '@rig-c/parts/node_modules/@rig-c/core/package.json','@rig-c/parts/node_modules/@rig-c/core/cli.ts'];
const installed:Record<string,string>={};
for(const path of toolPaths){
 try{installed[path]=createHash('sha256').update(await readFile(join(bench,'node_modules',path))).digest('hex');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
await writeFile(join(artifacts,'installed-tool-hashes.json'),JSON.stringify(installed,null,2));
const partsManifest=JSON.parse(await readFile(join(bench,'node_modules/@rig-c/parts/package.json'),'utf8'));
if(versions.parts!==projectPackage.devDependencies['@rig-c/parts']||partsCompiler!==partsManifest.dependencies['@rig-c/core'])throw Error('CONFIG_LOADER_PIN_STALE: frozen-lockfile producer/compiler');
console.log('FROZEN_PRODUCERS '+JSON.stringify({...versions,partsCompiler}));
try{
 await writeStage1LivePackage(pkg);
 // A distinct generated region precedes the mesh: the loop must retain the NON-FIRST selected part.
 const config=JSON.parse(await readFile(join(pkg,'config.json'),'utf8'));config.assemble.plan.unshift(['badge','full','author:badge']);config.regions.badge='chest';await writeFile(join(pkg,'config.json'),JSON.stringify(config,null,1)+'\n');
 const parts=JSON.parse(await readFile(join(pkg,'out/parts.json'),'utf8'));parts.parts.unshift({name:'badge',from:'full:author:badge',x:8,y:8,w:24,h:24,opaque_px:576,projected_core_px:576,source_px_taken:576,refused_drift_px:0,merged_px:0,seam_override_px:0});await writeFile(join(pkg,'out/parts.json'),JSON.stringify(parts));
 const badge=new PNG({width:24,height:24});for(let i=0;i<576;i++){badge.data[i*4]=240;badge.data[i*4+1]=120;badge.data[i*4+2]=30;badge.data[i*4+3]=255;}await writeFile(join(pkg,'out/parts/badge.png'),PNG.sync.write(badge));
 await producer(['rig','--config',join(pkg,'config.json'),'--parts',join(pkg,'out'),'--out',join(pkg,'out/rig')]);
 await producer(['check','--rig',join(pkg,'out/rig'),'--parts',join(pkg,'out'),'--out',join(pkg,'out/check'),'--page-edges','free','--pack-shape','polygon']);
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'generated-draft',title:'Generated draft · structure evidence',revision:'1',model:'out/check/build/skeleton.model.json',producer:{config:'config.json',parts:'out'},animations:[{id:'idle'}]}));
 await writeFile(join(artifacts,'inspected-check.json'),await readFile(join(pkg,'out/check/check.json')));
 await writeFile(join(artifacts,'inspected-rig.json'),await readFile(join(pkg,'out/rig/rig.json')));await writeFile(join(artifacts,'inspected-model.json'),await readFile(join(pkg,'out/check/build/skeleton.model.json')));
 const original=await hashes(pkg),p=await loadReview(pkg);let state=join(root,'state-en');server=await startServer(p,{port:0,stateDir:state,cwd:bench,capability:'a'.repeat(64),graceMs:600000,unopenedTimeoutMs:600000,exitOnClose:false});
 let base=`http://127.0.0.1:${server.port}`;
 let capturedPatch:string|undefined, capturedModel:string|undefined;
 page=await launchCdpSession(join(tmpdir(),'c'),{sendDeadlineMs:CDP_SEND_DEADLINE_MS});await page.setViewport(1440,1000);
 for(const lang of ['en','ko']){
  await page.goto(base+'/?lang='+lang+'#cap='+'a'.repeat(64));
  await waitForReadiness(page, 'PAGE_NOT_READY', READINESS_DEADLINE_MS, `(() => {
    const text = document.getElementById('handoff-line')?.textContent;
    return {ready: Boolean(window.rigReviewEditor && text && !/Reading/.test(text))};
  })()`);
  await page.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
  await waitForReadiness(page, 'PARTS_NOT_READY', READINESS_DEADLINE_MS, `(() => {
    const d = ${PARTS_DOCUMENT};
    return d?.body.dataset.ready === 'true' ? {ready: true} : {ready: false, detail: d?.body.textContent};
  })()`);
  await page.evaluate(`(() => {
    const d = ${PARTS_DOCUMENT};
    if (d?.body.dataset.ready !== 'true') throw Error('PARTS_NOT_READY ' + d?.body.textContent);
    d.querySelector('[data-pv-item=torso]').click();
    d.getElementById('zoom-in').click();
  })()`);
  await Bun.sleep(50);
  const before = await page.evaluate(`(() => {
    const d = ${PARTS_DOCUMENT};
    return {snapshot:d.defaultView.rigReviewStageParts.snapshot(),text:d.querySelector('#pv-corrections')?.textContent,buttons:[...d.querySelectorAll('#pv-corrections button')].map(b=>b.textContent)};
  })()`);
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click();document.querySelector('[data-review-stage="1"]').click()`);
  const retained=await page.evaluate<any>(`document.querySelector('.review-stage-panel iframe:not([hidden])').contentWindow.rigReviewStageParts.snapshot()`);
  if(retained.part!=='torso'||JSON.stringify(retained.rig)!==JSON.stringify((before as any).snapshot.rig))throw Error('NON_FIRST_PART_OR_CAMERA_LOST_ON_NAV');
  receipts.push({lang,before,retained});await writeFile(join(artifacts,lang+'-parts.png'),await page.screenshot());
  // Parameter editor: enter from the selected part, change a producer field, run its existing Apply.
  await page.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
  await waitForReadiness(page, 'MESH_ROUTE_TIMEOUT', READINESS_DEADLINE_MS,
    `({ready: ${PARTS_DOCUMENT}?.body.dataset.ready === 'true'})`);
  await page.evaluate(`(() => {
    const d = ${PARTS_DOCUMENT};
    if (d?.body.dataset.ready !== 'true') throw Error('MESH_ROUTE_TIMEOUT');
    d.querySelectorAll('#pv-corrections button')[1].click();
  })()`);
  const meshJob = await settleCorrectionMesh(page);
  if(meshJob.status!=='built'||meshJob.check?.pass!==true)throw Error('MESH_PARAMETER_APPLY_REFUSED '+JSON.stringify(meshJob));
  if(await page.evaluate(`document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot`)!=='torso')throw Error('MESH_SELECTION_LOST');
  receipts.push({lang,instrument:'mesh',applied:await page.evaluate(`JSON.parse(document.getElementById('rebuild-applied').value)`)});
  await writeFile(join(artifacts,lang+'-mesh.png'),await page.screenshot());

  const applied=receipts.at(-1).applied;
  if(applied.schema!=='rig-review-applied/2'||!applied.stageInputHash||applied.check?.gate!==true||
     applied.producer.version!==versions.parts||applied.compiler.version!==partsCompiler)throw Error('CORRECTION_SAMPLE_APPLY_IDENTITY');
  const bytes=patchText(applied.patch);
  if(createHash('sha256').update(bytes).digest('hex')!==applied.patchSha256)throw Error('CORRECTION_SAMPLE_PATCH_HASH');
  if(lang==='en'){
    capturedPatch=bytes;capturedModel=applied.modelHash;
    await writeFile(join(artifacts,'patch.json'),bytes);
    // The second state directory below has no retained result from this server.
  }else if(bytes!==capturedPatch||applied.modelHash!==capturedModel)throw Error('CORRECTION_SAMPLE_REBUILD_MISMATCH');
  const scratch=rebuildDir(state,p.sourceHash,applied.buildId);
  await cp(scratch,join(artifacts,lang+'-scratch'),{recursive:true});
  const translated=await page.evaluate<string>(`document.querySelector('#correction-controls summary').textContent`);
  if(translated!==(lang==='en'?'Correction handoff':'수정 인계'))throw Error('CORRECTION_SAMPLE_LOCALE '+lang+' '+translated);
  const exact='Keep the precise words.  \r\n';
  await page.evaluate(`(() => {
    document.getElementById('write-review').click();
    document.getElementById('correction-controls').open=true;
    for(const [id,value] of Object.entries({'feedback-start':'0','feedback-end':'0','feedback-target-kind':'rig','feedback-target-name':'generated-draft','feedback-category':'quality','correction-stage':'parts-review','correction-selector':'source','correction-path':'described'}))document.getElementById(id).value=value;
    const dt=new DataTransfer(); dt.items.add(new File([${JSON.stringify(exact)}],'request.txt',{type:'text/plain'}));document.getElementById('correction-words').files=dt.files;
    document.getElementById('add-proposal').click();
  })()`);
  await waitForReadiness(page, 'CORRECTION_DESCRIBED_ADD', DESCRIBED_DEADLINE_MS, `(() => {
    return document.querySelector('.proposal-item')
      ? {ready: true}
      : {ready: false, detail: document.getElementById('review-message').textContent};
  })()`);
  await page.evaluate(`(() => {document.getElementById('correction-path').value='made';document.getElementById('feedback-summary').value='Adjust the torso contour spacing';document.getElementById('add-proposal').click();if(document.querySelectorAll('.proposal-item').length!==2)throw Error('CORRECTION_MADE_ADD '+document.getElementById('review-message').textContent);document.getElementById('save').click()})()`);
  const file=sessionFile(p,state);
  let savedBytes:Buffer|undefined;
  for(let i=0;i<200;i++){
    try{const candidate=await readFile(file);if(JSON.parse(candidate.toString()).feedback.length===2){savedBytes=candidate;break;}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await Bun.sleep(50);
  }
  if(!savedBytes)throw Error('CORRECTION_SAMPLE_SUBMIT '+await page.evaluate(`document.getElementById('review-message').textContent`));
  const session=JSON.parse(savedBytes.toString());
  if(session.feedback[0].summary!==exact||JSON.stringify(session.feedback[1].context.applied)!==JSON.stringify(applied))throw Error('CORRECTION_SAMPLE_SESSION_MISMATCH');
  await writeFile(join(artifacts,lang+'-session.json'),savedBytes);
  for(const [index,item] of session.feedback.entries())for(const format of ['json','issue']){
    const code="import {main} from './src/cli.ts'; await main(process.argv.slice(1),{stateDir:process.env.SAMPLE_STATE});";
    const child=Bun.spawn([process.execPath,'-e',code,'--','feedback',pkg,'--correction',item.id,'--format',format],{env:{...process.env,SAMPLE_STATE:state},stdout:'pipe',stderr:'pipe'});
    const [out,err,exit]=await Promise.all([new Response(child.stdout).arrayBuffer(),new Response(child.stderr).text(),child.exited]);
    await writeFile(join(artifacts,`${lang}-${index}-${format}.log`),Buffer.from(out));
    if(exit!==0||err||(format==='json'&&!Buffer.from(out).equals(savedBytes)))throw Error('CORRECTION_SAMPLE_EXPORT '+exit+' '+err);
  }
  await writeFile(join(artifacts,lang+'-feedback.png'),await page.screenshot());
  if(lang==='en'){
    await page.close();server.stop(true);
    state=join(root,'state-independent');
    server=await startServer(p,{port:0,stateDir:state,cwd:bench,capability:'a'.repeat(64),graceMs:600000,unopenedTimeoutMs:600000,exitOnClose:false});
    base=`http://127.0.0.1:${server.port}`;
    // The new scratch request consumes the exact retained operation through the shipped API.
    const result=await fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Review-Capability':'a'.repeat(64)},body:JSON.stringify({patch:JSON.parse(capturedPatch!)})});
    if(!result.ok)throw Error('CORRECTION_SAMPLE_INDEPENDENT_REFUSED '+await result.text());
    let job=await result.json() as {id:string;status:string;reused:boolean;build?:{modelHash:string}};
    for(let i=0;i<1200&&job.status==='running';i++){await Bun.sleep(25);job=await (await fetch(base+'/api/rebuild/'+job.id)).json() as typeof job;}
    await writeFile(join(artifacts,'independent-job.json'),JSON.stringify(job,null,2));
    if(job.status!=='built'||job.reused||job.build?.modelHash!==capturedModel)throw Error('CORRECTION_SAMPLE_INDEPENDENT_MISMATCH');
    await cp(rebuildDir(state,p.sourceHash,job.id),join(artifacts,'independent-scratch'),{recursive:true});
    server.stop(true);
    state=join(root,'state-ko');
    server=await startServer(p,{port:0,stateDir:state,cwd:bench,capability:'a'.repeat(64),graceMs:600000,unopenedTimeoutMs:600000,exitOnClose:false});
    base=`http://127.0.0.1:${server.port}`;
    page=await launchCdpSession(join(tmpdir(),'c-ko'),{sendDeadlineMs:CDP_SEND_DEADLINE_MS});await page.setViewport(1440,1000);
  }
 }
 if(JSON.stringify(original)!==JSON.stringify(await hashes(pkg)))throw Error('CORRECTION_SAMPLE_ORIGINALS_CHANGED');
 await writeFile(join(artifacts,'receipt.json'),JSON.stringify({versions:{...versions,partsCompiler},receipts,original,immutable:true},null,2));
}finally{
 await page?.close();server?.stop(true);
 await cp(pkg,join(artifacts,'package'),{recursive:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
 for(const name of ['state-en','state-independent','state-ko'])await cp(join(root,name),join(artifacts,name),{recursive:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
 await rm(root,{recursive:true,force:true});
}
}
