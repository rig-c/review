/** Actual installed-producer Stage-1 loop; explicit runner, never part of the unit suite. */
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writeStage1LivePackage} from './helpers/stage1-live-package.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {loadReview} from '../src/manifest.ts';
import {freshSession} from '../src/session.ts';
import {rebuildDir} from '../src/rebuild.ts';
import {startServer} from '../src/server.ts';
const bench=process.env.RV367_BENCH!;if(!bench)throw Error('Installed producer bench required');
const root=await mkdtemp(join(tmpdir(),'r.')),pkg=join(root,'pkg'),artifacts=join(process.cwd(),'artifacts/stage1-browser');
await mkdir(artifacts,{recursive:true});
async function hashes(dir:string){const out:Record<string,string>={};const walk=async(at:string)=>{for(const e of await readdir(at,{withFileTypes:true})){const f=join(at,e.name);if(e.isDirectory())await walk(f);else out[relative(dir,f)]=createHash('sha256').update(await readFile(f)).digest('hex');}};await walk(dir);return out;}
async function producer(args:string[]){const child=Bun.spawn([process.execPath,join(bench,'node_modules/@rig-c/parts/cli.ts'),...args],{cwd:bench,stdout:'pipe',stderr:'pipe'});const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);console.log(out+err);if(exit!==0)throw Error('PRODUCER_FIXTURE_REFUSED '+exit);}
let page:InputCdpSession|undefined,server:Awaited<ReturnType<typeof startServer>>|undefined;
const receipts:any[]=[];
const versions={parts:JSON.parse(await readFile(join(bench,'node_modules/@rig-c/parts/package.json'),'utf8')).version,core:JSON.parse(await readFile(join(bench,'node_modules/@rig-c/core/package.json'),'utf8')).version};let partsCompiler=versions.core;try{partsCompiler=JSON.parse(await readFile(join(bench,'node_modules/@rig-c/parts/node_modules/@rig-c/core/package.json'),'utf8')).version;}catch{}
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
 const original=await hashes(pkg),p=await loadReview(pkg);server=await startServer(p,{port:0,stateDir:join(root,'state'),cwd:bench,capability:'a'.repeat(64),graceMs:600000,unopenedTimeoutMs:600000,exitOnClose:false});
 const base=`http://127.0.0.1:${server.port}`;
 page=await launchCdpSession(join(tmpdir(),'c'));await page.setViewport(1440,1000);
 for(const lang of process.env.RV367_FOCUS?['en']:['en','ko']){
  await page.goto(base+'/?lang='+lang+'#cap='+'a'.repeat(64));
  await page.evaluate(`(async()=>{for(let i=0;i<400;i++){if(window.rigReviewEditor&&document.getElementById('handoff-line')?.textContent&&!/Reading/.test(document.getElementById('handoff-line').textContent))return;await new Promise(r=>setTimeout(r,25));}throw Error('PAGE_NOT_READY')})()`);
  const before=await page.evaluate(`(async()=>{document.querySelector('[data-review-stage="1"]').click();for(let i=0;i<400;i++){const d=document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument;if(d?.body.dataset.ready==='true'){d.querySelector('[data-pv-item=torso]').click();d.getElementById('zoom-in').click();await new Promise(r=>setTimeout(r,50));return {snapshot:d.defaultView.rigReviewStageParts.snapshot(),text:d.querySelector('#pv-corrections')?.textContent,buttons:[...d.querySelectorAll('#pv-corrections button')].map(b=>b.textContent)}};await new Promise(r=>setTimeout(r,25));}throw Error('PARTS_NOT_READY '+document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument?.body.textContent)})()`);
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click();document.querySelector('[data-review-stage="1"]').click()`);
  const retained=await page.evaluate<any>(`document.querySelector('.review-stage-panel iframe:not([hidden])').contentWindow.rigReviewStageParts.snapshot()`);
  if(retained.part!=='torso'||JSON.stringify(retained.rig)!==JSON.stringify((before as any).snapshot.rig))throw Error('NON_FIRST_PART_OR_CAMERA_LOST_ON_NAV');
  receipts.push({lang,before,retained});await writeFile(join(artifacts,lang+'-parts.png'),await page.screenshot());
  // Enter via the actual Chest-regions button, designate with its own fields and click its Apply button twice.
  await page.evaluate(`document.querySelector('.review-stage-panel iframe:not([hidden])').contentDocument.querySelector('#pv-corrections button').click()`);
  await page.evaluate(`(async()=>{for(let i=0;i<200;i++){if(document.documentElement.dataset.inspectionStage==='3'&&document.getElementById('chest-edit').getAttribute('aria-pressed')==='true')return;await new Promise(r=>setTimeout(r,25));}throw Error('CHEST_NOT_OPEN')})()`);
  await writeFile(join(artifacts,lang+'-chest.png'),await page.screenshot());
  receipts.push({lang,controls:await page.evaluate(`({buttons:[...document.querySelectorAll('#chest-editor-bar button')].map(b=>({id:b.id,text:b.textContent})),fields:[...document.querySelectorAll('#chest-regions input')].map(n=>({id:n.id,value:n.value}))})`)});
  if(process.env.RV367_FOCUS==='selection-exit'){
   const applied=await page.evaluate<any>(`(async()=>{document.querySelector('[data-part-list] button[data-slot="badge"]').click();if(document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot!=='badge')throw Error('NATIVE_SELECTION_FAILED');document.getElementById('bust-r-x').value=String(Number(document.getElementById('bust-r-x').value)+1);document.getElementById('bust-r-x').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('bust-apply').click();for(let i=0;i<1200;i++){const value=document.getElementById('rebuild-applied').value;if(value&&!document.getElementById('bust-apply').disabled)return JSON.parse(value);const status=document.getElementById('chest-editor-status');if(status?.classList.contains('error'))throw Error(status.textContent);await new Promise(r=>setTimeout(r,25));}throw Error('NATIVE_CHEST_FLOW_LOCKED')})()`);
   if(applied.part!=='torso'||applied.check?.pass!==true)throw Error('NATIVE_CHEST_TARGET_CHANGED');
   if(await page.evaluate(`!!document.getElementById('stage-draft-label')`))throw Error('SCOPED_LABEL_NOT_CLEARED');
   receipts.push({lang,focus:'explicit native badge selection exits old Stage1 scope; native Chest target resolves torso',applied});
   await writeFile(join(artifacts,'selection-exit.png'),await page.screenshot());continue;
  }
  for(let repeat=0;repeat<2;repeat++){
   const applied=await page.evaluate<any>(`(async()=>{const field=document.getElementById('bust-r-x');field.value=String(Number(field.value)+${lang==='en'?1:2});field.dispatchEvent(new Event('input',{bubbles:true}));const previous=document.getElementById('rebuild-applied').value;document.getElementById('bust-apply').click();for(let i=0;i<1200;i++){const value=document.getElementById('rebuild-applied').value;if(value&&value!==previous&&!document.getElementById('bust-apply').disabled)return JSON.parse(value);const status=document.getElementById('chest-editor-status');if(status?.classList.contains('error'))throw Error(status.textContent);await new Promise(r=>setTimeout(r,25));}throw Error('APPLY_TIMEOUT '+document.getElementById('chest-editor-status').textContent)})()`);
   const selectedAfter=await page.evaluate<any>(`document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot`);if(selectedAfter!=='torso')throw Error('SELECTED_PART_LOST_AFTER_APPLY');
   if(applied.check?.pass!==true||!applied.stageInputHash||!applied.mesh)throw Error('UNCHECKED_APPLIED_RECORD '+JSON.stringify(applied));
   await page.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
   const watched=await page.evaluate<any>(`(async()=>{for(let i=0;i<400;i++){const d=document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument;if(d?.body.dataset.ready==='true'){const res=await fetch('/api/stage-parts',{headers:{'X-Review-Stage-Build':'${applied.buildId}'}});return {snapshot:d.defaultView.rigReviewStageParts.snapshot(),text:d.querySelector('#pv-corrections').textContent,data:await res.json()};}await new Promise(r=>setTimeout(r,25));}throw Error('SCRATCH_NOT_READY '+document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument?.body.textContent)})()`);
   if(watched.snapshot.part!=='torso'||JSON.stringify(watched.snapshot.rig)!==JSON.stringify((before as any).snapshot.rig))throw Error('NON_FIRST_PART_OR_CAMERA_LOST_ON_REBUILD');
   const mapping=watched.data.draft.mappings.find((m:any)=>m.part==='torso');
   if(mapping.vertices!==applied.mesh.after.vertices||mapping.triangles!==applied.mesh.after.triangles)throw Error('GEOMETRY_COUNTS_DIFFER');
   receipts.push({lang,repeat,applied,watched});await writeFile(join(artifacts,lang+'-scratch-'+repeat+'.png'),await page.screenshot());
   await page.evaluate(`document.querySelector('.review-stage-panel iframe:not([hidden])').contentDocument.querySelector('#pv-corrections button').click()`);
   await page.evaluate(`new Promise(r=>setTimeout(r,200))`);
  }
  // Parameter editor: enter from the selected part, change a producer field, run its existing Apply.
  await page.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
  await page.evaluate(`(async()=>{for(let i=0;i<400;i++){const d=document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument;if(d?.body.dataset.ready==='true'){d.querySelectorAll('#pv-corrections button')[1].click();return;}await new Promise(r=>setTimeout(r,25));}throw Error('MESH_ROUTE_TIMEOUT')})()`);
  const meshJob=await page.evaluate<any>(`(async()=>{await new Promise(r=>setTimeout(r,200));const m=window.rigReviewEditor.mesh;if(m.part()!=='torso')throw Error('WRONG_PARAMETER_PART');m.set(['contour','spacing'],${lang==='en'?18:20});return await m.apply()})()`);
  if(meshJob.status!=='built'||meshJob.check?.pass!==true)throw Error('MESH_PARAMETER_APPLY_REFUSED '+JSON.stringify(meshJob));
  if(await page.evaluate(`document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot`)!=='torso')throw Error('MESH_SELECTION_LOST');
  receipts.push({lang,instrument:'mesh',applied:await page.evaluate(`JSON.parse(document.getElementById('rebuild-applied').value)`)});
  await writeFile(join(artifacts,lang+'-mesh.png'),await page.screenshot());
  // Reset before the typed delta: it must use the inspected producer input, not silently delta an unrelated scratch revision.
  await page.evaluate(`window.rigReviewEditor.reset()`);
  await page.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
  await page.evaluate(`(async()=>{for(let i=0;i<400;i++){const d=document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument;if(d?.body.dataset.ready==='true'){d.querySelectorAll('#pv-corrections button')[2].click();return;}await new Promise(r=>setTimeout(r,25));}throw Error('DELTA_ROUTE_TIMEOUT')})()`);
  const selected=await page.evaluate<any>(`(async()=>{for(let i=0;i<200;i++){const edit=window.rigReviewEditor.meshEdit();if(edit)return edit;await new Promise(r=>setTimeout(r,25));}throw Error('DELTA_EDITOR_NOT_OPEN')})()`);
  const vertex=selected.drawn[selected.hull+1];if(!vertex)throw Error('NO_INTERIOR_VERTEX');
  await page.mouse('mouseMoved',vertex.x,vertex.y);await page.mouse('mousePressed',vertex.x,vertex.y);await page.mouse('mouseMoved',vertex.x+2,vertex.y+1);await page.mouse('mouseReleased',vertex.x+2,vertex.y+1);
  const delta=await page.evaluate<any>(`(async()=>{if(!window.rigReviewEditor.meshEdit().ops.length)throw Error('NO_DELTA_OPS');document.getElementById('mesh-apply').click();for(let i=0;i<1200;i++){const value=document.getElementById('rebuild-applied').value;if(value){const a=JSON.parse(value);if(a.schema==='rig-review-applied/3'&&!document.getElementById('mesh-apply').disabled)return a;}await new Promise(r=>setTimeout(r,25));}throw Error('DELTA_APPLY_TIMEOUT '+document.getElementById('mesh-editor-status').textContent)})()`);
  if(await page.evaluate(`document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot`)!=='torso')throw Error('DELTA_SELECTION_LOST');
  if(delta.check?.pass!==true)throw Error('DELTA_UNCHECKED');receipts.push({lang,instrument:'delta',applied:delta});
  await writeFile(join(artifacts,lang+'-delta.png'),await page.screenshot());
  // The exact made evidence saves; changed scratch input or a forged check does not.
  const session=freshSession(p);session.feedback=[{id:'mesh-note',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.feedbackCatalog.rig},category:'quality',summary:'Generated structure check',context:{applied:delta}} as any];
  const submit=()=>fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json','X-Review-Capability':'a'.repeat(64)},body:JSON.stringify(session)});
  let response=await submit();if(!response.ok)throw Error('CHECKED_SUBMIT_REFUSED '+await response.text());
  const path=join(rebuildDir(join(root,'state'),p.sourceHash,delta.buildId),'mesh-edit.json'),beforeInput=await readFile(path);
  await writeFile(path,Buffer.concat([beforeInput,Buffer.from(' ')]));response=await submit();const stale=await response.text();if(response.ok||!stale.includes('STAGE_DRAFT_CHANGED'))throw Error('CHANGED_SCRATCH_SUBMITTED '+stale);await writeFile(path,beforeInput);
  if(!beforeInput.equals(await readFile(path)))throw Error('SCRATCH_RESTORE_FAILED');
  receipts.push({lang,submit:'checked saved; changed scratch refused; input restored',inputSha256:createHash('sha256').update(beforeInput).digest('hex')});
  await page.evaluate(`window.rigReviewEditor.reset()`);
  await page.evaluate(`document.getElementById('bust-reset').click()`);
  await page.evaluate(`(async()=>{for(let i=0;i<200;i++){if(document.getElementById('bust-reset').disabled)return;await new Promise(r=>setTimeout(r,25));}throw Error('RESET_TIMEOUT')})()`);

 }
 if(JSON.stringify(original)!==JSON.stringify(await hashes(pkg)))throw Error('ORIGINALS_CHANGED');
 await writeFile(join(artifacts,'receipt.json'),JSON.stringify({versions:{...versions,partsCompiler},receipts,originals:original,immutable:true},null,2));
 console.log('STAGE1_BROWSER_RECEIPT '+JSON.stringify(receipts.filter(r=>r.applied).map(r=>({lang:r.lang,repeat:r.repeat,buildId:r.applied.buildId,mesh:r.applied.mesh,check:r.applied.check?.pass}))));
}finally{if(server){for(let i=0;i<300;i++){const state:any=await (await fetch(`http://127.0.0.1:${server.port}/api/rebuild`)).json();if(state.baseline?.status!=='running'&&state.inspectedCheck?.status!=='running')break;await Bun.sleep(100);}}await page?.close();await Bun.sleep(200);server?.stop(true);await rm(root,{recursive:true,force:true});}
