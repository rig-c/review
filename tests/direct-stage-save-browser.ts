/** Nova-only direct launcher regression using frozen Create checkpoint 1, without a producer run. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {digest} from '../src/interview-project.ts';
import {loadOpenPackage,type RecordFile} from '../src/open.ts';
import {verdictSource,loadPartsView} from '../src/parts-view.ts';
import {t} from '../web/i18n.ts';
import {inventory} from './helpers/four-stage-fixture.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {withDeadline,walkCheckpoint} from './helpers/walk-deadline.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';

assert.equal(process.platform,'linux','NOVA_LINUX_REQUIRED');
assert(process.env.REVIEW_443_OUTPUT,'REVIEW_443_OUTPUT_REQUIRED');
const output=resolve(process.env.REVIEW_443_OUTPUT);
await mkdir(output);
const mark=walkCheckpoint(join(output,'checkpoints.jsonl'));
const root=await mkdtemp(join(await realpath(tmpdir()),'review443-'));
const stateDir=join(root,'state');
const frame="document.querySelector('.review-stage-panel iframe:not([hidden]):not(.review-interview-frame)')";
type Fixture=Awaited<ReturnType<typeof joinedVerdictFixture>>;
const pages=new Set<InputCdpSession>();
const fixtures:Fixture[]=[];
const results:unknown[]=[];

async function json(path:string,url:URL) {
 return withDeadline(path,15000,async signal=>{
  const response=await fetch(new URL(path,url),{signal});
  assert.equal(response.status,200,path);
  return response.json();
 });
}
async function openDirect(fixture:Fixture,verdict=true):Promise<URL> {
 const project=fixture.project;
 const child=Bun.spawn([process.execPath,resolve('src/cli.ts'),'open',fixture.input,'--direct',
  '--project',project.root,'--project-draft',project.draftId,'--picks-dir',project.picksDir,
  ...(verdict?['--parts-verdict-dir',project.partsVerdictDir]:[])],{
  env:{...process.env,RIG_REVIEW_STATE_DIR:stateDir},stdout:'pipe',stderr:'pipe',
 });
 try{
  const [code,stdout]=await withDeadline('direct-open',15000,()=>Promise.all([
   child.exited,new Response(child.stdout).text(),new Response(child.stderr).text(),
  ]));
  assert.equal(code,0,'DIRECT_OPEN_EXIT');
  assert(/^http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+\n$/.test(stdout),'DIRECT_OPEN_URL');
  const url=new URL(stdout.trim());
  assert.equal(url.pathname,'/');
  assert(/^[a-f0-9]{64}$/.test(url.searchParams.get('handoff')??''),'DIRECT_HANDOFF');
  assert(/^#cap=[a-f0-9]{64}$/.test(url.hash),'DIRECT_FRAGMENT');
  return url;
 }finally{if(child.exitCode===null)child.kill();}
}
async function browser(name:string) {
 const page=await launchCdpSession(join(root,name),{sendDeadlineMs:15000});
 pages.add(page);await page.setViewport(1440,1050);return page;
}
async function close(page:InputCdpSession) {await page.close();pages.delete(page);}
async function ready(page:InputCdpSession) {
 await withDeadline('parts-ready',15000,async signal=>{
  while(!await page.evaluate<boolean>(`${frame}?.contentDocument?.body?.dataset.ready==='true'`)){
   signal.throwIfAborted();await Bun.sleep(30);
  }
 });
}
async function navigate(page:InputCdpSession,url:URL,language:'en'|'ko') {
 const link=new URL(url);link.searchParams.set('lang',language);
 await page.goto(link.href);await ready(page);
 assert.equal(await page.evaluate('document.documentElement.dataset.inspectionStage'),'1');
 const route=await page.evaluate<{parentKey:string;childKey:string;path:string;capQuery:boolean;fragment:boolean;language:string}>(`(()=>{
  const f=${frame},u=new URL(f.src);
  return {parentKey:new URL(location.href).searchParams.get('handoff'),childKey:u.searchParams.get('handoff'),
   path:u.pathname,capQuery:u.searchParams.has('cap'),fragment:!!u.hash,language:f.contentDocument.documentElement.lang};
 })()`);
 assert.equal(route.childKey,route.parentKey,'DIRECT_CHILD_HANDOFF');
 assert.equal(route.path,'/stage-parts.html');assert.equal(route.capQuery,false);assert.equal(route.fragment,false);
 assert.equal(route.language,language);
}
async function trustedSave(page:InputCdpSession) {
 const point=await page.evaluate<{x:number;y:number}>(`(()=>{
  const f=${frame},d=f?.contentDocument,button=d?.getElementById('pv-save');
  if(!button||button.disabled||button.closest('[hidden],[inert]'))throw Error('DIRECT_SAVE_DISABLED');
  button.scrollIntoView({block:'nearest'});
  const r=button.getBoundingClientRect(),b=f.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  if(!r.width||!r.height||!button.checkVisibility()||!button.contains(d.elementFromPoint(x,y))||
   !f.contains(document.elementFromPoint(b.left+f.clientLeft+x,b.top+f.clientTop+y)))throw Error('DIRECT_SAVE_OBSCURED');
  return {x:b.left+f.clientLeft+x,y:b.top+f.clientTop+y};
 })()`);
 await page.mouse('mouseMoved',point.x,point.y);
 await page.mouse('mousePressed',point.x,point.y);
 await page.mouse('mouseReleased',point.x,point.y);
 await withDeadline('trusted-save',15000,async signal=>{
  while(!await page.evaluate<boolean>(`${frame}.contentDocument.getElementById('pv-save-status').dataset.result==='saved'`)){
   signal.throwIfAborted();
   assert.notEqual(await page.evaluate(`${frame}.contentDocument.getElementById('pv-save-status').dataset.result`),'refused');
   await Bun.sleep(30);
  }
 });
}
async function rejectedPost(page:InputCdpSession,payload:unknown,capability?:string) {
 // The fresh-context caller supplies no capability. Only the no-directory control uses its own fragment.
 return page.evaluate<{status:number;error:string}>(`(async()=>{
  const response=await fetch('/api/stage-parts/verdict',{method:'POST',
   headers:{'Content-Type':'application/json',...${JSON.stringify(capability?{'X-Review-Capability':capability}:{})}},
   body:JSON.stringify(${JSON.stringify(payload)})});
  return {status:response.status,error:(await response.json()).error};
 })()`);
}
async function stopWorkers() {
 for(const name of await readdir(join(stateDir,'open')).catch(()=>[])){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
  const record=JSON.parse(await readFile(join(stateDir,'open',name),'utf8')) as RecordFile;
  const url=record.origin+'/api/open-status',headers={authorization:'Bearer '+record.nonce};
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(1000)}).catch(()=>null);
  if(!response)continue;
  const identity=await response.json();
  assert.equal(identity.nonce,record.nonce,'OWNED_WORKER_NONCE');
  assert.equal(identity.key,record.key,'OWNED_WORKER_KEY');
  process.kill(record.pid,'SIGTERM');
  await withDeadline('owned-worker-stop',5000,async signal=>{
   while(true){
    signal.throwIfAborted();
    const live=await fetch(url,{headers,signal:AbortSignal.timeout(200)}).catch(()=>null);
    if(!live)return;
    assert.equal((await live.json()).nonce,record.nonce,'WORKER_REPLACED_DURING_CLEANUP');
    await Bun.sleep(30);
   }
  });
 }
}

try{
 for(const language of ['en','ko'] as const){
  mark(language+'.fixture');
  const fixture=await joinedVerdictFixture(join(root,'project-'+language));fixtures.push(fixture);
  const original=await inventory(fixture.project.root);
  const url=await openDirect(fixture);
  const parts=await json('/api/stage-parts',url),review=await json('/api/review',url);
  const session=await json('/api/session',url);
  assert.equal(url.searchParams.get('input'),review.sourceHash);
  assert.equal(parts.inspectionSourceHash,review.sourceHash);
  const standalone=await loadPartsView(fixture.draft.parts,{rig:fixture.draft.rig,meshReport:fixture.draft.meshReport});
  const source=verdictSource(standalone);
  assert.equal(parts.sourceHash,source.sha256);
  assert.equal(parts.joinedVerdictBinding,digest(JSON.stringify({projectHash:fixture.joined.opened.hash,
   version:fixture.joined.designation.version,sourceHash:review.sourceHash,parts:source})));
  assert.deepEqual(parts.draft.mappings,[{part:'torso',skin:'default',slot:'torso',attachment:'torso',vertices:30,triangles:40}]);
  const payload={binding:parts.joinedVerdictBinding,status:'approved',parts:Object.fromEntries(parts.items.map(
   (item:{name:string;mesh?:unknown})=>[item.name,{outcome:'clean',note:'',...(item.mesh?{mesh:{outcome:'clean',note:''}}:{})}]))};
  const page=await browser('owner-'+language);
  mark(language+'.direct-open');await navigate(page,url,language);
  assert.equal(await page.evaluate(`${frame}.contentDocument.getElementById('pv-save').disabled`),false,'DIRECT_SAVE_DISABLED');
  assert.equal(await page.evaluate(`${frame}.contentDocument.getElementById('pv-save').textContent`),t('Save sign-off',undefined,language));
  await page.evaluate(`sessionStorage.setItem('review443-isolation','owner');localStorage.setItem('review443-isolation','owner')`);
  assert.deepEqual(await readdir(fixture.output),[]);

  mark(language+'.fresh-context');
  // A separate Chromium process and a new profile guarantee separate contexts and both storage areas.
  const fresh=await browser('fresh-'+language),copied=new URL(url);copied.hash='';
  try{
   await navigate(fresh,copied,language);
   const isolated=await fresh.evaluate(`({opener:window.opener===null,
    session:sessionStorage.getItem('review443-isolation'),local:localStorage.getItem('review443-isolation'),
    capabilitySlots:Object.keys(sessionStorage).filter(key=>key.startsWith('rig-review-capability/1:')).length})`);
   assert.deepEqual(isolated,{opener:true,session:null,local:null,capabilitySlots:0});
   assert.equal(await fresh.evaluate(`${frame}.contentDocument.getElementById('pv-save').disabled`),true);
   assert.equal(await fresh.evaluate(`${frame}.contentDocument.getElementById('pv-save').title`),
    t('Read-only view: reopen with rig-review open to edit.',undefined,language));
   const denied=await rejectedPost(fresh,payload);
   assert.deepEqual(denied,{status:403,error:'REVIEW_CAPABILITY_REQUIRED: reopen with rig-review open to edit'});
   assert.deepEqual(await readdir(fixture.output),[]);
   await writeFile(join(output,language+'-fresh-denied.json'),JSON.stringify({isolated,denied},null,2)+'\n');
   await writeFile(join(output,language+'-fresh.png'),await fresh.screenshot());
  }finally{await close(fresh);}

  const partNote=language==='en'?'  Check the torso seam.\nKeep these words.  ':'  몸통 이음새 확인.\n이 문구를 유지해 주세요.  ';
  const meshNote=language==='en'?'  Torso mesh reviewed.  ':'  몸통 메시를 확인했어요.  ';
  await page.evaluate(`(()=>{
   const d=${frame}.contentDocument;
   for(const name of [...d.querySelectorAll('[data-pv-item]')].map(item=>item.dataset.pvItem)){
    d.querySelector('[data-pv-item="'+CSS.escape(name)+'"]').click();
    d.querySelector('[data-pv-outcome][value=clean]').click();
    const mesh=d.querySelector('#pv-mesh-panel select');
    if(mesh){mesh.value='clean';mesh.dispatchEvent(new Event('change'));}
   }
   d.querySelector('[data-pv-item=torso]').click();
   for(const [selector,value] of [['#pv-note',${JSON.stringify(partNote)}],['#pv-mesh-panel textarea',${JSON.stringify(meshNote)}]]){
    const field=d.querySelector(selector);field.value=value;field.dispatchEvent(new Event('input'));
   }
   d.getElementById('pv-overall').value='approved';
   d.addEventListener('click',event=>{if(event.target.id==='pv-save')d.body.dataset.trustedSave=String(event.isTrusted);},true);
   const original=d.defaultView.fetch.bind(d.defaultView);d.defaultView.review443Posts=[];
   d.defaultView.fetch=async(...args)=>{
    const response=await original(...args);
    if(new URL(String(args[0]),d.location.href).pathname==='/api/stage-parts/verdict'&&args[1]?.method==='POST')
     d.defaultView.review443Posts.push({status:response.status,body:await response.clone().json()});
    return response;
   };
  })()`);
  await page.evaluate(`document.querySelector('[data-review-stage="3"]').click();document.querySelector('[data-review-stage="1"]').click()`);
  await ready(page);
  assert.equal(await page.evaluate(`${frame}.contentDocument.getElementById('pv-note').value`),partNote);
  assert.deepEqual(await readdir(fixture.output),[]);
  mark(language+'.trusted-save');await trustedSave(page);
  assert.equal(await page.evaluate(`${frame}.contentDocument.body.dataset.trustedSave`),'true');
  const posts=await page.evaluate<{status:number;body:{verdict:unknown}}[]>(`${frame}.contentWindow.review443Posts`);
  assert.equal(posts.length,1);assert.equal(posts[0]!.status,200);
  const filename='parts-review-'+parts.joinedVerdictBinding+'.json';
  assert.deepEqual(await readdir(fixture.output),[filename]);
  const bytes=await readFile(join(fixture.output,filename)),verdict=JSON.parse(bytes.toString());
  assert.deepEqual(posts[0]!.body.verdict,verdict);
  assert.equal(verdict.schema,'rig-review-parts-verdict/2');assert.equal(verdict.status,'approved');
  // Verdict file paths are relative to the designated output directory, distinct from the inspected input.
  assert.deepEqual(verdict.source,verdictSource({...standalone,verdictPath:join(fixture.output,filename)}));
  assert.equal(verdict.parts.torso.note,partNote);assert.equal(verdict.parts.torso.mesh.note,meshNote);
  const exported=await withDeadline('verdict-export',15000,async signal=>{
   const response=await fetch(new URL('/api/stage-parts/export/json',url),{signal});
   assert.equal(response.status,200);return response.text();
  });
  assert.equal(exported,bytes.toString());
  await writeFile(join(output,language+'-verdict.json'),bytes);
  await writeFile(join(output,language+'-saved.png'),await page.screenshot());
  mark(language+'.reopen');
  const reopened=await openDirect(fixture);
  assert.equal(reopened.searchParams.get('input'),url.searchParams.get('input'));
  assert.equal(reopened.searchParams.get('handoff'),url.searchParams.get('handoff'));
  await close(page);
  const restored=await browser('reopened-'+language);
  try{
   await navigate(restored,reopened,language);
   await restored.evaluate(`${frame}.contentDocument.querySelector('[data-pv-item=torso]').click()`);
   assert.equal(await restored.evaluate(`${frame}.contentDocument.getElementById('pv-note').value`),partNote);
   assert.equal(await restored.evaluate(`${frame}.contentDocument.querySelector('#pv-mesh-panel textarea').value`),meshNote);
   await writeFile(join(output,language+'-reopened.png'),await restored.screenshot());
   assert.deepEqual(await json('/api/review',reopened),review);
   assert.deepEqual(await json('/api/session',reopened),session);
   mark(language+'.no-verdict-directory');
   const readonly=await openDirect(fixture,false);
   await navigate(restored,readonly,language);
   assert.equal(await restored.evaluate(`${frame}.contentDocument.querySelector('.pv-verdict').hidden`),true);
   const denied=await rejectedPost(restored,payload,readonly.hash.slice(5));
   assert.deepEqual(denied,{status:409,error:'PARTS_VERDICT_READ_ONLY'});
   assert.deepEqual(await readdir(fixture.output),[filename]);
   assert.deepEqual(await readFile(join(fixture.output,filename)),bytes);
   await writeFile(join(output,language+'-no-directory.json'),JSON.stringify(denied,null,2)+'\n');
  }finally{await close(restored);}
  const after=await inventory(fixture.project.root);
  assert.deepEqual(Object.keys(after).filter(path=>!(path in original)),[fixture.project.partsVerdictDir+'/'+filename]);
  for(const [path,hash] of Object.entries(original))assert.equal(after[path],hash,path);
  const current=await loadOpenPackage({input:fixture.input,project:fixture.project});
  assert.equal(current.contentHash,review.sourceHash);
  await fixture.joined.assertCurrent();await fixture.assertFixture();
  results.push({language,sourceHash:review.sourceHash,binding:parts.joinedVerdictBinding,inspectedPartsSource:source,verdictSource:verdict.source,
   verdictSha256:digest(bytes),originalFileCount:Object.keys(original).length,newFiles:[fixture.project.partsVerdictDir+'/'+filename],trustedSave:true});
 }
 mark('walk.complete');
 await writeFile(join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
}catch(error){
 await writeFile(join(output,'failure.json'),JSON.stringify({error:error instanceof Error?error.message:String(error)},null,2)+'\n');
 let index=0;
 for(const page of pages){
  const screenshot=await page.screenshot().catch(()=>null);
  if(screenshot)await writeFile(join(output,`failure-${++index}.png`),screenshot);
 }
 throw error;
}finally{
 try{
  for(const page of pages)await page.close();
  await stopWorkers();
 }finally{
  // Capture disposable input inventories before removal. Nova also reaps descendants after the command.
  for(const fixture of fixtures)await fixture.assertFixture();
  await writeFile(join(output,'final-inventories.json'),JSON.stringify(await Promise.all(fixtures.map(async fixture=>({
   files:await inventory(fixture.project.root),
  }))),null,2)+'\n');
  await rm(root,{recursive:true,force:true});
 }
}
