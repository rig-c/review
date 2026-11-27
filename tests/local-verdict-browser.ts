/** #1232: local packages and parts save through the same Send comments control as live jobs. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import type {ControlInspection,ControlReceipt} from '../src/control.ts';
import {parseOpenInputs} from '../src/cli.ts';
import {loadOpenPackage} from '../src/open.ts';
import {loadPartsView} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {startServer} from '../src/server.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {commentFixture} from './helpers/parts-comments-package.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';

type Language = 'en' | 'ko';
const outIndex=Bun.argv.indexOf('--out');
const output=resolve(outIndex<0?'artifacts/local-comments':Bun.argv[outIndex+1]!);
const scratch=await mkdtemp(join(tmpdir(),'review-1232-'));
const fixtureComment='Public fixture comment';
const control={token:'fixture-control',instanceKey:'b'.repeat(64)};

async function wait(page:InputCdpSession,expression:string) {
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){
  if(await page.evaluate<boolean>(expression))return;
  await Bun.sleep(50);
 }
 const message=await page.evaluate("document.getElementById('message')?.textContent");
 throw Error('LOCAL_COMMENTS_WAIT: '+expression+' / '+message);
}

async function openPage(name:string,url:string,language:Language,localPackage=false,departureDialogs?:string[]) {
 const page=await launchCdpSession(join(scratch,'chrome-'+name),{onEvent(event,send){
  if(departureDialogs&&event.method==='Page.javascriptDialogOpening'&&event.params?.type==='beforeunload'){
   departureDialogs.push(event.params.type);
   return send('Page.handleJavaScriptDialog',{accept:true}).then(()=>{});
  }
 }});
 try{
  await page.setViewport(1600,1000);
  const target=new URL(url);target.searchParams.set('lang',language);
  await page.goto(target.href,language);
  await wait(page,localPackage
   ? "!!document.getElementById('stage-comment-list')&&!!document.getElementById('rig-root')?.style.transform"
   : "document.body.dataset.ready==='true'");
  if(await page.evaluate<boolean>("!!document.querySelector('dialog.workspace-drawer[open]')"))
   await click(page,'dialog.workspace-drawer[open] .workspace-drawer-close');
  return page;
 }catch(error){await page.close();throw error;}
}

async function checkBar(page:InputCdpSession,language:Language,state:'empty'|'sent') {
 const catalog=language==='ko'?koCatalog:enCatalog;
 const reading=await page.evaluate(`(()=>{
  const send=document.getElementById('send-comments');
  return {
   viewport:[innerWidth,innerHeight,devicePixelRatio,document.documentElement.lang],
   send:[send.checkVisibility(),send.classList.contains('primary'),send.disabled,send.textContent.trim()],
   verdict:['save','request-changes','request-changes-reason'].some(id=>document.getElementById(id)?.checkVisibility()),
   state:document.getElementById('review-draft-state').textContent.trim()
  };
 })()`);
 assert.deepEqual(reading,{
  viewport:[1600,1000,1,language],
  send:[true,true,true,catalog['Send comments']],
  verdict:false,
  state:catalog[state==='empty'?'Not submitted':'Submitted'],
 });
}

async function addComment(page:InputCdpSession,pinned:boolean) {
 await wait(page,"!!document.querySelector('#stage-comment:not(:disabled)')");
 await click(page,'#stage-comment');
 if(pinned){
  const point=await page.evaluate<{x:number;y:number}>(`(()=>{
   const box=document.getElementById('rig-viewport').getBoundingClientRect();
   return {x:box.left+.54*box.width,y:box.top+.49*box.height};
  })()`);
  await page.mouse('mouseMoved',point.x,point.y);
  await page.mouse('mousePressed',point.x,point.y);
  await page.mouse('mouseReleased',point.x,point.y);
 }else{
  await wait(page,"!!document.querySelector('[data-comment-general]:not(:disabled)')");
  await click(page,'[data-comment-general]');
 }
 await wait(page,"!!document.querySelector('.stage-comment-composer input')");
 await page.evaluate(`(()=>{
  const form=document.querySelector('.stage-comment-composer');
  form.querySelector('input').value=${JSON.stringify(fixtureComment)};
  form.requestSubmit();
 })()`);
 await wait(page,"!document.querySelector('.stage-comment-composer')&&!document.getElementById('send-comments').disabled");
}

async function checkPackageReload(page:InputCdpSession,origin:string,capability:string,dirty:boolean) {
 const headers={Authorization:`Bearer ${control.token}`,Origin:origin,'Content-Type':'application/json','X-Review-Capability':capability};
 const snapshot=async()=>await (await fetch(origin+'/api/control',{headers})).json() as {
  sourceHash:string;pages:{pageId:string;revision:number;inspection:ControlInspection}[];
 };
 const prior=new Set((await snapshot()).pages.map(row=>row.pageId));
 await page.goto(`${origin}/?lang=en&reload=${dirty?'unsent':'sent'}#cap=${capability}`,'en');
 await wait(page,`document.getElementById('send-comments').disabled===${!dirty}&&!!document.getElementById('stage-comment-list')`);
 for(let attempt=0;attempt<100;attempt++){
  const {sourceHash,pages}=await snapshot();
  const current=pages.find(row=>!prior.has(row.pageId)&&row.inspection.ready);
  if(!current){await Bun.sleep(50);continue;}
  const unloadCancelled=await page.evaluate<boolean>("!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))");
  assert.deepEqual({dirty:current.inspection.dirty,unloadCancelled},{dirty,unloadCancelled:dirty},'restored comments set dirty and beforeunload only when unsent');
  if(dirty)return;
  await checkBar(page,'en','sent');
  const queued=await fetch(origin+'/api/control/commands',{method:'POST',headers,body:JSON.stringify({
   schema:'rig-review-control-command/1',requestId:'sent-comment-reload',instanceKey:control.instanceKey,
   sourceHash,pageId:current.pageId,expectedRevision:current.revision,command:{type:'playback',value:'pause'},
  })});
  const receipt=await queued.json() as ControlReceipt;
  assert.equal(queued.status,202,receipt.error??'control command queued');
  const {commandId}=receipt;
  for(let poll=0;poll<100;poll++){
   const receipt=await (await fetch(origin+'/api/control/receipts/'+commandId,{headers})).json() as ControlReceipt;
   if(receipt.status==='queued'||receipt.status==='dispatched'){await Bun.sleep(50);continue;}
   assert.equal(receipt.status,'applied',receipt.error??'control command applied');
   return;
  }
  throw Error('Reloaded package control command did not finish');
 }
 throw Error('Reloaded package did not register for control');
}

async function checkLocal(
 screen:'package'|'parts',language:Language,opened:Extract<Awaited<ReturnType<typeof loadOpenPackage>>,{mode:'single'}>,
) {
 const name=screen+'-'+language;
 const capability=randomBytes(32).toString('hex');
 const root=join(scratch,name);
 await mkdir(root);
 let filename:string|undefined;
 const server=screen==='parts'
  ? await (async()=>{
     await commentFixture(root);
     const pkg=await loadPartsView(root);
     filename=join(pkg.verdictPath,'..','review-comments.json');
     return startPartsServer(pkg,{port:0,capability,exitOnClose:false});
    })()
  : await startServer(opened.p,{port:0,joined:opened.joined,capability,stateDir:root,exitOnClose:false,control});
 let page:InputCdpSession|undefined;
 try{
  const origin='http://127.0.0.1:'+server.port;
  const departureDialogs:string[]=[];
  page=await openPage(name,origin+'/#cap='+capability,language,screen==='package',departureDialogs);
  await checkBar(page,language,'empty');
  await writeFile(join(output,name+'-empty.png'),await page.screenshot());

  await addComment(page,false);
  const retry=screen==='package'&&language==='en';
  if(retry)await page.evaluate(`(()=>{
   const request=window.fetch;
   window.__localSendIds=[];
   window.fetch=async (url,options)=>{
    const response=await request(url,options);
    if(String(url).endsWith('/api/local-comments')&&response.ok){
     window.__localSendIds.push(JSON.parse(options.body).sendId);
     if(window.__localSendIds.length===1)throw new TypeError('Fixture lost the successful response');
    }
    return response;
   };
  })()`);
  await click(page,'#send-comments');
  if(retry){
   await wait(page,"document.getElementById('review-draft-state').dataset.saveState==='failed'");
   await click(page,'#send-comments');
  }
  await wait(page,"document.getElementById('review-draft-state').dataset.saveState==='saved'");
  if(retry){
   const ids=await page.evaluate<string[]>('window.__localSendIds');
   assert.equal(ids.length,2);
   assert.equal(ids[0],ids[1],'the retry reuses the first successful send ID');
  }
  await checkBar(page,language,'sent');
  if(screen==='package'){
   const listing=(await readdir(root)).filter(file=>file.endsWith('.comments.json'));
   assert.equal(listing.length,1);
   filename=join(root,listing[0]!);
  }
  const bytes=await readFile(filename!);
  const saved=JSON.parse(bytes.toString());
  assert.equal(saved.schema,'rig-review/local-comments@1');
  assert.equal(saved.sends.length,1);
  assert.equal(saved.sends[0].source.kind,screen);
  assert.deepEqual(saved.sends[0].value.comments.map((row:{text:string})=>row.text),[fixtureComment]);
  if(language==='en')await writeFile(join(output,screen+'-sample.json'),bytes);
  await writeFile(join(output,name+'-sent.png'),await page.screenshot());
  if(screen==='package'&&language==='en'){
   await checkPackageReload(page,origin,capability,false);
   assert.deepEqual(departureDialogs,[],'the sent draft reloads without a departure dialog');
   const panelOpen=await page.evaluate<boolean>("document.getElementById('stage-comment').getAttribute('aria-pressed')==='true'");
   if(panelOpen)await click(page,'#stage-comment');
   await addComment(page,true);
   await click(page,'#send-comments');
   await wait(page,"document.getElementById('review-draft-state').dataset.saveState==='saved'");
   const withPin=await Bun.file(filename!).json();
   assert.deepEqual(withPin.sends[0],saved.sends[0],'the first send keeps its bytes');
   assert.equal(withPin.sends[1].value.comments.length,1);
   assert.ok(withPin.sends[1].value.comments[0].anchor,'package comment retains its pin');
   if(await page.evaluate<boolean>("document.getElementById('stage-comment').getAttribute('aria-pressed')==='true'"))await click(page,'#stage-comment');
   await addComment(page,false);
   await checkPackageReload(page,origin,capability,true);
   console.log('LOCAL_COMMENTS_RELOAD_PASS: sent rows clean and controllable, unsent rows dirty');
  }
  console.log('LOCAL_COMMENTS',name,JSON.stringify({sends:saved.sends.length,comments:1}));
 }finally{
  try{await page?.close();}finally{server.stop(true);}
 }
}

async function checkLive(language:Language) {
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh',scratchParent:scratch});
 let page:InputCdpSession|undefined;
 try{
  await fixture.publish('rig');
  page=await openPage('live-'+language,fixture.host.ownerUrl,language);
  await checkBar(page,language,'empty');
  await addComment(page,false);
  await click(page,'#send-comments');
  await wait(page,"document.getElementById('review-draft-state').dataset.saveState==='saved'");
  await checkBar(page,language,'sent');
  const {events}=await fixture.next();
  assert.ok(events.some(event=>event.type==='act'&&event.act.kind==='comments'&&event.act.value.comments.some(row=>row.text===fixtureComment)));
 }finally{
  try{await page?.close();}finally{await fixture.close();}
 }
}

try{
 await mkdir(output,{recursive:true});
 const root=join(scratch,'project');
 await mkdir(root);
 const archive=join(import.meta.dir,'fixtures/create-reopened-v2/project.tar.gz');
 const extract=Bun.spawnSync(['tar','-xzf',archive,'-C',root]);
 assert.equal(extract.exitCode,0,extract.stderr.toString());
 await mkdir(join(root,'reviewer-picks'));
 const opened=await loadOpenPackage(parseOpenInputs([join(root,'derived/review/v2/out'),
  '--project',root,'--project-version','2','--picks-dir','reviewer-picks']));
 assert.equal(opened.mode,'single');
 assert.ok(opened.joined&&opened.p.manifest.model);
 for(const language of ['en','ko'] as const){
  await checkLocal('package',language,opened);
  await checkLocal('parts',language,opened);
  await checkLive(language);
 }
 console.log('LOCAL_COMMENTS_PASS: 4 local screens, 5 local sends, 2 live sends');
}finally{await rm(scratch,{recursive:true,force:true});}
