import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadReview,previousBuildFiles,type ReviewManifest} from '../src/manifest.ts';
import {JOB_API_SCHEMA,JOB_PREVIOUS_BUILD_SCHEMA,type JobPreviousBuild,type JobResponseValues,type JobResult} from '../src/job-contract.ts';
import type {ControlView} from '../src/control.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {instrumentRigMount} from './helpers/mount-probe.ts';
import {installSceneFixture,sceneHash} from './helpers/scene-inspection-fixture.ts';
import {directionPhysicsModel} from './helpers/direction-playback.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';

type Language='en'|'ko';
type Reading={
 current:string|null;previous:string|null;currentTime:number;previousTime:number|null;transport:number;
 playing:boolean;generation:number|null;camera:ControlView;layout:string;syncChecked:boolean;syncDisabled:boolean;
 labels:(string|null)[];missing:string|null;comments:{viewport:string;modelHash:string|null;reference:ControlView['cameras']['reference']}[];
};
type MenuEntry={id:string;label:string;disabled:boolean};
type JobKind='rig'|'direction';
type JobNetwork={
 origin:string;scriptUrl:string;
 requests:{path:string;method:string}[];
};
const cases={
 en:{option:'Previous version',previous:'Previous · ',current:'Current · ',missing:'This clip is missing from the previous version. Showing the setup pose.'},
 ko:{option:'이전 버전',previous:'이전 · ',current:'현재 · ',missing:'이전 버전에 이 클립이 없어 셋업 포즈를 보여줘요.'},
} as const;
const previousLabel='  Setup · 먼저  ',currentLabel='Current  A+ / 개선';
const arg=Bun.argv.indexOf('--out');
const out=resolve(arg<0?'artifacts/previous-build-1214':Bun.argv[arg+1]!);
const webRootArg=Bun.argv.indexOf('--web-root');
const webRoot=webRootArg<0?process.cwd():resolve(Bun.argv[webRootArg+1]!);
const scratch=await mkdtemp(join(tmpdir(),'review-1214-browser-'));
await mkdir(out,{recursive:true});
const servers:(()=>void)[]=[],errors:unknown[]=[],observations:unknown[]=[];
const probe=`
Object.assign(window,{__previous1214:{
 ready:()=>rigInput.state==='loaded'&&!!comments,
 read:()=>{
  const prior=typeof previousBuildView==='undefined'?null:previousBuildView?.pane()?.player();
  const markRows=session.feedback.flatMap(row=>{const mark=row.context?.comment;return mark?[{viewport:mark.viewport,modelHash:mark.modelHash,reference:mark.bookmark.view.cameras.reference}]:[];});
  const missing=el('reference-pane').querySelector('.previous-build-missing');
  return {current:player.current,previous:prior?.current??null,currentTime:player.time,previousTime:prior?.time??null,transport:time,playing,
   generation:prior?.generation??null,camera:viewport.numericView(),layout:el('view-menu').querySelector('[aria-pressed="true"][data-view]')?.dataset.view,
   syncChecked:input('camera-sync').checked,syncDisabled:input('camera-sync').disabled,
   labels:['previous-build-label','current-build-label'].map(id=>document.getElementById(id)?.textContent??null),
   missing:missing&&!missing.hidden?missing.textContent:null,comments:markRows};
 }
}});
`;
const built=await Bun.build({entrypoints:[join(webRoot,'web/main.ts')],target:'browser',format:'esm',plugins:[{
 name:'previous-build-1214-observation',setup(build){
  build.onLoad({filter:/\/web\/main\.ts$/},async({path})=>({loader:'ts',contents:instrumentRigMount(await readFile(path,'utf8'),probe)}));
 },
}]});
assert.ok(built.success,JSON.stringify(built.logs));

type LanternModel={
 animations:({name:string;duration:number}&Record<string,unknown>)[];
 editorOrder:{animations:string[]};
};
async function fixture(kind:'absent'|'rig'|'direction'):Promise<string> {
 const root=join(scratch,kind);
 await cp(resolve(import.meta.dir,'../examples/demo'),root,{recursive:true});
 const manifest=await Bun.file(join(root,'review.json')).json() as ReviewManifest;
 if(kind==='absent')return root;
 const direction=kind==='direction';
 const model=direction?await directionPhysicsModel():await Bun.file(join(root,manifest.model!)).json() as LanternModel;
 const first=model.animations[0]!;
 const prior=structuredClone(model);
 prior.animations[0]!.name='sealed-previous-clip';
 prior.editorOrder.animations=['sealed-previous-clip'];
 const previousPath='prior version/previous.model.json',pageName=direction?'mesh.png':'lantern.png';
 const pageBytes=await readFile(direction?resolve(import.meta.dir,'fixtures/strip-probe/build/mesh.png'):join(root,pageName));
 const priorBytes=JSON.stringify(prior),atlasBytes=pageName+'\n';
 const previousBuild:JobPreviousBuild={schema:JOB_PREVIOUS_BUILD_SCHEMA,label:previousLabel,currentLabel,
  model:{path:previousPath,sha256:sceneHash(priorBytes)},atlas:{path:'prior version/previous.atlas',sha256:sceneHash(atlasBytes)},
  pages:[{path:'prior version/'+pageName,sha256:sceneHash(pageBytes)}],
  clipMap:{[first.name]:'sealed-previous-clip',unavailable:'undeclared-prior-clip'}};
 await mkdir(join(root,'prior version'));
 await Promise.all([
  writeFile(join(root,previousPath),priorBytes),writeFile(join(root,previousBuild.atlas.path),atlasBytes),
  writeFile(join(root,previousBuild.pages[0]!.path),pageBytes),writeFile(join(root,pageName),pageBytes),
 ]);
 if(!direction){
  model.animations.push({...structuredClone(first),name:'unmapped'},{...structuredClone(first),name:'unavailable'});
  model.editorOrder.animations.push('unmapped','unavailable');
 }
 await writeFile(join(root,manifest.model!),JSON.stringify(model));
 await writeFile(join(root,'review.json'),JSON.stringify({...manifest,previousBuild,
  animations:direction?[{id:first.name,label:'Current take'}]:manifest.animations,
  checkpoints:direction?[]:manifest.checkpoints}));
 if(direction)await installSceneFixture(root,{sourceStart:.25});
 return root;
}

async function serve(root:string) {
 const requests:string[]=[],mutations:string[]=[];
 const context=await createReviewRequestContext(await loadReview(root),{
  port:0,bundle:built.outputs[0]!,exitOnClose:false,stateDir:join(scratch,'state-'+servers.length),
 });
 const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:context.live.websocket,async fetch(req,srv){
  const {pathname}=new URL(req.url);
  if(pathname.startsWith('/assets/prior%20version/'))requests.push(pathname);
  if(req.method!=='GET'&&req.method!=='HEAD')mutations.push(req.method+' '+pathname);
  return (await context.handle(req,srv.port,srv))!;
 }});
 servers.push(()=>{context.stop();server.stop(true);});
 return {url:`http://127.0.0.1:${server.port}/`,requests,mutations};
}

async function wait(page:InputCdpSession,condition:string){
 await withDeadline('previous-build-1214 '+condition,10000,async signal=>{
  while(!signal.aborted){if(await page.evaluate<boolean>(condition))return;await Bun.sleep(25);}
  throw signal.reason;
 });
}
const read=(page:InputCdpSession)=>page.evaluate<Reading>('window.__previous1214.read()');
const menu=(page:InputCdpSession)=>page.evaluate<MenuEntry[]>(`[...document.querySelectorAll('#view-menu [data-view]')].map(n=>({id:n.dataset.view,label:n.textContent,disabled:n.disabled}))`);
const shot=async(page:InputCdpSession,name:string)=>writeFile(join(out,name+'.png'),await page.screenshot());
async function selectView(page:InputCdpSession,id:string){
 if(!await page.evaluate<boolean>("document.getElementById('view-menu').open"))await click(page,'#view-menu summary');
 await click(page,`#view-menu [data-view="${id}"]`);
}
async function control(page:InputCdpSession,id:string,value:string,event:'input'|'change'){
 await page.evaluate<void>(`(()=>{const node=document.getElementById(${JSON.stringify(id)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
}
function assertSharedCamera(value:Reading){
 const {rig,reference}=value.camera.cameras;
 assert.ok(rig&&reference);
 assert.equal(rig.space,'world');assert.equal(reference.space,'world');
 assert.deepEqual(rig.center,reference.center);assert.equal(rig.zoom,reference.zoom);
 assert.ok(Math.abs(rig.viewport.width/rig.visible.width-reference.viewport.width/reference.visible.width)<1e-9);
 assert.equal(value.camera.cameraSync,true);assert.equal(value.syncChecked,true);assert.equal(value.syncDisabled,true);
}
function assertSharedTime(value:Reading){
 assert.equal(value.previous,'sealed-previous-clip');assert.notEqual(value.previousTime,null);
 assert.ok(Math.abs(value.currentTime-value.previousTime!)<1e-9,JSON.stringify(value));
}

async function jobFixture(kind:JobKind,root:string) {
 const fixture=await realJobWindowFixture({scratchParent:scratch});
 try{
  const directory=join(fixture.input.root,'out');
  await cp(root,directory,{recursive:true,force:true});
  const manifestPath=join(directory,'review.json');
  const {previousBuild,...manifest}=await Bun.file(manifestPath).json() as ReviewManifest;
  assert.ok(previousBuild);
  // The live job takes this declaration from its trusted reader's sealed closure.
  await writeFile(manifestPath,JSON.stringify(manifest));
  const stage=kind==='rig'?'rig-review':'direction-review';
  const subject={kind:'review-verdict',stage} as const;
  const context=fixture.input.getContext();
  fixture.input.setContext({...context,
   selector:kind==='rig'?{kind:'rig',version:2}:{kind:'post',version:2,rigVersion:1},
   subjects:[subject],previousBuild,files:previousBuildFiles(previousBuild).map(file=>({...file,path:'out/'+file.path})),
  });
  const publication=await fixture.publish();
  const asked=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,
   requestId:randomUUID(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,
   idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject});
  const response=await asked.json() as JobResult<JobResponseValues['ask']>;
  assert.ok(asked.ok&&response.ok,JSON.stringify(response));
  const {routes}=fixture.host.session.displayPublication(publication.publicationId);
  const owner=new URL(fixture.host.ownerUrl);
  owner.searchParams.set('lang','en');
  return {fixture,owner,routes,previousBuild};
 }catch(error){
  await fixture.close();
  throw error;
 }
}

async function liveJobControls(roots:Record<JobKind,string>):Promise<void> {
 const body=Buffer.from(await built.outputs[0]!.arrayBuffer()).toString('base64');
 let command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 let network:JobNetwork|undefined;
 const browser=await launchCdpSession(join(scratch,'profile-live-jobs'),{
  sendDeadlineMs:15000,
  onEvent(event,send){
   if(event.sessionId)command=send;
   if(event.method==='Runtime.exceptionThrown')errors.push(event.params);
   if(event.method==='Network.requestWillBeSent'&&network){
    const request=event.params?.request as {url:string;method:string}|undefined;
    if(request){
     const url=new URL(request.url);
     if(url.origin===network.origin)network.requests.push({path:url.pathname,method:request.method});
    }
   }
   // Attach only the same read-only probe as standalone, after the real host
   // has served its JS route. Metadata and every asset go through unchanged.
   if(event.method==='Fetch.requestPaused'){
    const request=event.params?.request as {url:string}|undefined;
    assert.equal(request?.url,network?.scriptUrl);
    assert.equal(event.params?.responseStatusCode,200);
    return send('Fetch.fulfillRequest',{requestId:event.params?.requestId,responseCode:200,
     responseHeaders:[{name:'Content-Type',value:'text/javascript; charset=utf-8'}],body}).then(()=>{});
   }
  },
 });
 try{
  assert.ok(command,'CDP page session');
  await command('Network.enable');
  await browser.setViewport(1440,900);
  for(const kind of ['rig','direction'] as const){
   const {fixture,owner,routes,previousBuild}=await jobFixture(kind,roots[kind]);
   const trace:JobNetwork={origin:owner.origin,scriptUrl:fixture.locator+'/main.js',requests:[]};
   try{
    network=trace;
    await command('Fetch.enable',{patterns:[{urlPattern:trace.scriptUrl,requestStage:'Response'}]});
    await browser.goto(owner.href,'en');
    await wait(browser,`document.body.dataset.ready==='true'&&window.__previous1214?.ready()&&
     !!document.querySelector('#save:not(:disabled)')`);
    assert.equal(await browser.evaluate<string>('location.pathname'),owner.pathname);
    assert.ok(trace.requests.some(request=>request.method==='GET'&&request.path===routes.apiBase+'review'));
    assert.deepEqual((await menu(browser)).filter(entry=>entry.id==='previous-version'),
     [{id:'previous-version',label:cases.en.option,disabled:false}]);
    const previousRequests=()=>trace.requests.filter(request=>request.path.includes('/prior%20version/'));
    assert.deepEqual(previousRequests(),[]);

    await click(browser,'[data-mode="playback"]');
    await selectView(browser,'previous-version');
    await wait(browser,'!!document.getElementById("previous-build-root")');
    const expected=[previousBuild.model,...previousBuild.pages].map(({path})=>({
     method:'GET',path:routes.assetsBase+path.split('/').map(encodeURIComponent).join('/'),
    }));
    assert.deepEqual(previousRequests().map(request=>request.path).sort(),expected.map(request=>request.path).sort());
    assert.ok(previousRequests().every(request=>request.method==='GET'));
    const at=kind==='rig'?.35:3;
    await control(browser,'scrub',String(at),'input');
    const held=await read(browser);
    assert.equal(held.transport,at);
    assert.equal(held.current,kind==='rig'?'idle':'inspect');
    assert.equal(held.layout,'previous-version');
    assert.deepEqual(held.labels,[cases.en.previous+previousLabel,cases.en.current+currentLabel]);
    assertSharedCamera(held);assertSharedTime(held);
    const sourceTime=kind==='rig'?at:0.8037109375; // Fixture's smoothstep from .25 to 2 at 3 of 8 take seconds.
    assert.ok(Math.abs(held.currentTime-sourceTime)<1e-9);
    await click(browser,'#play');
    await wait(browser,`window.__previous1214.read().transport>${at+.08}`);
    const playing=await read(browser);
    assert.equal(playing.playing,true);assertSharedTime(playing);
    await click(browser,'#play');
    await selectView(browser,'previous-version');
    await selectView(browser,'previous-version');
    await wait(browser,'!!document.getElementById("previous-build-root")');
    assert.equal(previousRequests().length,expected.length);
    observations.push({job:kind,reviewPath:routes.apiBase+'review',assetRequests:previousRequests(),held,playing});
    await shot(browser,'job-'+kind);
   }catch(error){
    const state=await browser.evaluate<{ready:string|null;message:string|null;reading:Reading|null}>(`({
     ready:document.body.dataset.ready??null,message:document.getElementById('message')?.textContent??null,
     reading:window.__previous1214?.ready()?window.__previous1214.read():null
    })`).catch(()=>null);
    observations.push({job:kind,requests:trace.requests,state,error:String(error)});
    await shot(browser,'job-'+kind+'-failure').catch(()=>{});
    throw error;
   }finally{
    try{await browser.goto('about:blank');}finally{await fixture.close();}
   }
  }
 }finally{await browser.close();}
}

let page:InputCdpSession|undefined;
try{
 const roots=await Promise.all([fixture('absent'),fixture('rig'),fixture('direction')]);
 for(const language of ['en','ko'] as const){
  const copy=cases[language];
  const absent=await serve(roots[0]!);
  page=await launchCdpSession(join(scratch,'profile-'+language),{onEvent(event){
   if(event.method==='Runtime.exceptionThrown')errors.push(event.params);
  }});
  await page.setViewport(1440,900);
  await page.goto(absent.url+'?lang='+language,language);
  await wait(page,'window.__previous1214?.ready()');
  await click(page,'[data-mode="playback"]');
  const baseline=await menu(page);
  assert.deepEqual(baseline.map(item=>item.id),['compare','reference','rig','difference']);
  assert.deepEqual(absent.requests,[]);

  const rig=await serve(roots[1]!);
  await page.goto(rig.url+'?lang='+language,language);
  await wait(page,'window.__previous1214?.ready()');
  await click(page,'[data-mode="playback"]');
  const declared=await menu(page);
  assert.deepEqual(declared,[baseline[0],{id:'previous-version',label:copy.option,disabled:false},...baseline.slice(1)]);
  assert.deepEqual(rig.requests,[]);

  await selectView(page,'rig');await click(page,'#camera-sync');await click(page,'#zoom-in');
  await control(page,'scrub','.35','input');
  const before=await read(page);
  assert.equal(before.layout,'rig');assert.equal(before.syncChecked,false);
  assert.ok(before.camera.cameras.rig!.zoom>1);
  await selectView(page,'previous-version');
  await wait(page,'!!document.getElementById("previous-build-root")');
  const paired=await read(page);
  assert.deepEqual(rig.requests.sort(),['/assets/prior%20version/lantern.png','/assets/prior%20version/previous.model.json']);
  assert.equal(paired.layout,'previous-version');assert.equal(paired.transport,before.transport);
  assert.deepEqual(paired.labels,[copy.previous+previousLabel,copy.current+currentLabel]);
  assertSharedCamera(paired);assertSharedTime(paired);
  await shot(page,'previous-'+language);
  await click(page,'#view-menu summary');await shot(page,'menu-'+language);await click(page,'#view-menu summary');
  const left=await page.evaluate<{x:number;y:number}>(`(()=>{const r=document.getElementById('reference-viewport').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await page.mouse('mouseWheel',left.x,left.y,-120);
  const zoomed=await read(page);assertSharedCamera(zoomed);assert.ok(zoomed.camera.cameras.rig!.zoom>paired.camera.cameras.rig!.zoom);
  await page.mouse('mousePressed',left.x,left.y);await page.mouse('mouseMoved',left.x+30,left.y+15);await page.mouse('mouseReleased',left.x+30,left.y+15);
  const panned=await read(page);assertSharedCamera(panned);assert.notDeepEqual(panned.camera.cameras.rig!.center,zoomed.camera.cameras.rig!.center);
  await click(page,'#native-one');
  const native=await read(page);assertSharedCamera(native);
  const nativeCamera=native.camera.cameras.rig!;
  assert.ok(Math.abs(nativeCamera.visible.width-nativeCamera.viewport.width)<1e-9);
  await click(page,'#fit');const fitted=await read(page);assertSharedCamera(fitted);assert.equal(fitted.camera.cameras.rig?.zoom,1);

  await click(page,'#play');await wait(page,'window.__previous1214.read().transport>.45');
  const moving=await read(page);assert.ok(moving.playing);assertSharedTime(moving);
  await click(page,'#play');
  for(const clip of ['unmapped','unavailable']){
   await control(page,'animation-select',clip,'change');await control(page,'scrub','.55','input');
   const missing=await read(page);
   assert.equal(missing.current,clip);assert.equal(missing.previous,null);assert.equal(missing.previousTime,0);
   assert.equal(missing.missing,copy.missing);
  }
  await click(page,'#play');await wait(page,'window.__previous1214.read().transport>.65');
  const missingDuringPlayback=await read(page);
  assert.equal(missingDuringPlayback.previousTime,0);assert.equal(missingDuringPlayback.missing,copy.missing);
  assert.equal(missingDuringPlayback.playing,true);
  await shot(page,'missing-'+language);
  await click(page,'#play');
  await control(page,'animation-select','idle','change');await control(page,'scrub','.4','input');
  assertSharedTime(await read(page));
  await click(page,'#stage-comment');
  await click(page,'#reference-viewport');
  assert.equal(await page.evaluate<number>(`document.querySelectorAll('#reference-viewport :is(.stage-comment-composer,.stage-comment-pin,button,input,[contenteditable]),#reference-pane [data-mesh-mode]').length`),0);
  assert.deepEqual((await read(page)).comments,[]);assert.deepEqual(rig.mutations,[]);
  await click(page,'#rig-viewport');
  await wait(page,`!!document.querySelector('#rig-viewport .stage-comment-composer input')`);
  await page.evaluate<void>(`(()=>{const form=document.querySelector('#rig-viewport .stage-comment-composer'),field=form.querySelector('input');field.value='A point on the current rig';form.requestSubmit();})()`);
  await wait(page,'window.__previous1214.read().comments.length===1');
  const feedback=await read(page);
  assert.deepEqual(feedback.comments,[{viewport:'rig',modelHash:sceneHash(await readFile(join(roots[1]!,'skeleton.model.json'))),reference:null}]);
  assert.equal(await page.evaluate<number>(`document.querySelectorAll('#reference-viewport .stage-comment-pin').length`),0);
  await selectView(page,'previous-version');
  const restored=await read(page);
  assert.equal(restored.layout,before.layout);assert.equal(restored.syncChecked,false);assert.equal(restored.syncDisabled,false);
  assert.deepEqual(restored.camera.cameras.rig?.center,before.camera.cameras.rig?.center);
  assert.equal(restored.camera.cameras.rig?.zoom,before.camera.cameras.rig?.zoom);
  assert.equal(restored.transport,feedback.transport);
  assert.deepEqual(restored.comments,feedback.comments);
  await selectView(page,'previous-version');await wait(page,'!!document.getElementById("previous-build-root")');
  assert.equal(rig.requests.length,2,'returning to the mode reuses its loaded assets');
  observations.push({language,before,paired,moving,restored,assetRequests:rig.requests});
  await page.close();page=undefined;
 }

 const direction=await serve(roots[2]!);
 page=await launchCdpSession(join(scratch,'profile-direction'));
 await page.setViewport(1440,900);await page.goto(direction.url+'?lang=en','en');
 await wait(page,'window.__previous1214?.ready()');
 await click(page,'[data-mode="playback"]');await selectView(page,'previous-version');
 await wait(page,'!!document.getElementById("previous-build-root")');
 await control(page,'scrub','3','input');
 const mapped=await read(page);assertSharedTime(mapped);assertSharedCamera(mapped);
 assert.equal(mapped.current,'inspect');assert.equal(mapped.transport,3);assert.notEqual(mapped.currentTime,mapped.transport);
 observations.push({direction:mapped,assetRequests:direction.requests});
 await page.close();page=undefined;
 await liveJobControls({rig:roots[1]!,direction:roots[2]!});
 assert.deepEqual(errors,[]);
 await writeFile(join(out,'result.json'),JSON.stringify({observations,errors},null,2)+'\n');
 console.log('PASS Review #1214 EN/KO standalone controls and live-job rig/direction: scoped lazy assets and shared source time');
}catch(error){
 await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),observations,errors,reading:await page?.evaluate<Reading|null>('window.__previous1214?.ready()?window.__previous1214.read():null').catch(()=>null)},null,2));
 if(page)await shot(page,'failure');
 throw error;
}finally{
 await page?.close();for(const stop of servers)stop();
 await rm(scratch,{recursive:true,force:true});
}
