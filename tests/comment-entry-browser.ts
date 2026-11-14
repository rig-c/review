/** #828 ordinary Nova: reuse shipped live-job fixtures, CDP and one workspace. Synthetic inputs only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,readFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/comment-entry-828':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];
async function run(kind:string,lang:'en'|'ko',picture=true){
 const profile=await mkdtemp(join(tmpdir(),'review828-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 const out=join(output,kind+(picture?'':'-empty'),lang);await mkdir(out,{recursive:true});
 try{
  let url:string,hasVideo=false;
  if(kind==='source-only'||kind==='standalone'){
   const fixture=await jobFixture(),path=join(fixture.root,'out'),manifest=JSON.parse(await readFile(join(path,'review.json'),'utf8'));
   if(kind==='source-only'){delete manifest.model;manifest.title='Synthetic source-only JSON export';manifest.checkpoints=[{id:'source-context',title:'Synthetic source context',animation:'inspect',reference:'raster'}];
   await copyFile(new URL('./fixtures/strip-probe/reference.mov',import.meta.url),join(path,'source.mov'));
   manifest.references.push({id:'source-video',label:'Synthetic source video',type:'video',path:'source.mov'});}
   hasVideo=manifest.references.some((reference:{type:string})=>reference.type==='video');await writeFile(join(path,'review.json'),JSON.stringify(manifest));
   const capability='b'.repeat(64),server=await startServer(await loadReview(path),{port:0,stateDir:fixture.state,capability});
   close=async()=>{server.stop(true);await fixture.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(['rig','parts','direction'].includes(kind)){
   const fixture=await scriptedJobWindowFixture();close=()=>fixture.close();
   const publication=await fixture.publish(kind as 'rig'|'parts'|'direction');
   hasVideo=JSON.parse(await readFile(join(fixture.packageRoot,'review.json'),'utf8')).references.some((reference:{type:string})=>reference.type==='video');
   await fixture.ask(publication,kind==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:kind==='direction'?'direction-review':'rig-review'});
   url=fixture.host.ownerUrl;
  }else{
   const fixture=await recordScreenFixture(kind as RecordScreenKind,picture);close=()=>fixture.close();url=fixture.ownerUrl;
  }
  const target=new URL(url);target.searchParams.set('lang',lang);
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000});await page.setViewport(1440,900);await page.goto(target.href,lang);
  const wait=async(expression:string)=>{const end=Date.now()+20_000;while(Date.now()<end){if(await page!.evaluate(expression))return;await Bun.sleep(30);}throw new Error('COMMENT_ENTRY_WAIT '+expression);};
  await wait(`(${kind==='source-only'||kind==='standalone'}?!document.body.inert:document.body.dataset.ready==='true')&&!!document.querySelector('#stage-comment-list')`);
  await page.evaluate(`document.querySelector('dialog[open] .workspace-drawer-close')?.click()`);
  await page.evaluate(`(()=>{const tab=[...document.querySelectorAll('.workspace-bottom-tabs .block-row:not([hidden]) button')].find(n=>!n.hidden&&!n.disabled);tab?.click();})()`);
  await page.evaluate(`document.querySelector('#stage-comment').click()`);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));`);
  await wait(`!document.querySelector('#inspector-feedback').hidden&&getComputedStyle(document.querySelector('#inspector-feedback')).display!=='none'`);
  const state:any=await page.evaluate(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {videoDeclared:${hasVideo},language:document.documentElement.lang,top:visible(document.querySelector('#stage-comment')),panel:visible(document.querySelector('#inspector-feedback')),bottomComments:document.querySelectorAll('.workspace-bottom-tabs [data-block-target="feedback"],.workspace-bottom-tabs #workspace-tab-feedback').length,pin:document.querySelector('#rig-viewport').classList.contains('stage-comment-mode'),general:visible(document.querySelector('[data-comment-general]')),listRect:document.querySelector('#stage-comment-list').getBoundingClientRect().toJSON(),checkpointHidden:!visible(document.querySelector('#checkpoint-detail')),stripHidden:!visible(document.querySelector('#strip-panel')),stripBlocked:document.querySelector('#strip-export').disabled,noSourceFilesHidden:!visible(document.querySelector('#source-files')),name:document.querySelector('#stage-comment-list strong').textContent};})()`);
  if(kind==='source-only'){
   assert.equal(state.panel,true);assert.equal(state.stripHidden,false,'source-only JSON strip remains available');assert.equal(state.stripBlocked,false);
   await page.evaluate(`(()=>{document.querySelector('#strip-panel').open=true;document.getElementById('feedback-start').value='0';document.getElementById('feedback-end').value='1';document.getElementById('strip-reference').value='source-video';document.getElementById('strip-format').value='json';const native=window.fetch;window.fetch=async(...args)=>{const response=await native(...args);if(String(args[0]).endsWith('/api/strip'))window.__sourceOnlyStrip={status:response.status,body:await response.clone().json()};return response;};document.getElementById('strip-export').scrollIntoView({block:'nearest'});})()`);
   await click(page,'#strip-export');
   await wait(`!!window.__sourceOnlyStrip`);const exported:any=await page.evaluate(`window.__sourceOnlyStrip`);
   assert.equal(exported.status,200,'native Export action reaches the source-only JSON endpoint');assert.equal(exported.body.plan.binding.packages[0].reviewedSource.rig,null);assert.equal(exported.body.rendering,null);
   await writeFile(join(out,'source-only-export.json'),JSON.stringify({state,exported},null,2)+'\n');await writeFile(join(out,'source-only-export.png'),await page.screenshot());observations.push({kind,lang,picture,...state,exported});return;
  }
  assert.equal(state.checkpointHidden,true,'no supplied package checkpoint exposes no checkpoint controls');if(state.stripBlocked||!hasVideo)assert.equal(state.stripHidden,true,'strip without declared video or write capability is hidden');else assert.equal(state.stripHidden,false,'declared video keeps available strip controls visible');
  assert.equal(state.language,lang);assert.equal(state.top,true);assert.equal(state.panel,true);assert.equal(state.bottomComments,0);assert.equal(state.pin,picture);assert.equal(state.general,!['rig','parts','standalone'].includes(kind));assert.equal(state.name,lang==='ko'?'코멘트':'Comments');assert.ok(state.listRect.y>=0&&state.listRect.y+state.listRect.height<=900,'whole comment list visible before composition');
  if(state.general){await page.evaluate(`document.querySelector('[data-comment-general]').click()`);await wait(`!!document.querySelector('#stage-comment-list .stage-comment-composer input')`);}
  await writeFile(join(out,'comments.png'),await page.screenshot());
  observations.push({kind,lang,picture,...state});
 }catch(error){if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');}
}
for(const lang of ['en','ko'] as const){if(Bun.argv.includes('--source-only')){await run('source-only',lang);continue;}for(const kind of ['rig','parts','direction','signoff','checkpoint','interview-picks','standalone'])await run(kind,lang);await run('signoff',lang,false);await run('source-only',lang);}
console.log('COMMENT_ENTRY_828_OK cases='+observations.length+' sourceOnly='+Bun.argv.includes('--source-only'));
