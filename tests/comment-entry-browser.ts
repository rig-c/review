/** #828 ordinary Nova: reuse shipped live-job fixtures, CDP and one workspace. Synthetic inputs only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/comment-entry-828':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];
async function run(kind:string,lang:'en'|'ko',picture=true){
 const profile=await mkdtemp(join(tmpdir(),'review828-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 const out=join(output,kind+(picture?'':'-empty'),lang);await mkdir(out,{recursive:true});
 try{
  let url:string;
  if(['rig','parts','direction'].includes(kind)){
   const fixture=await scriptedJobWindowFixture();close=()=>fixture.close();
   const publication=await fixture.publish(kind as 'rig'|'parts'|'direction');
   await fixture.ask(publication,kind==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:kind==='direction'?'direction-review':'rig-review'});
   url=fixture.host.ownerUrl;
  }else{
   const fixture=await recordScreenFixture(kind as RecordScreenKind,picture);close=()=>fixture.close();url=fixture.ownerUrl;
  }
  const target=new URL(url);target.searchParams.set('lang',lang);
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000});await page.setViewport(1440,900);await page.goto(target.href,lang);
  const wait=async(expression:string)=>{const end=Date.now()+20_000;while(Date.now()<end){if(await page!.evaluate(expression))return;await Bun.sleep(30);}throw new Error('COMMENT_ENTRY_WAIT '+expression);};
  await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#stage-comment-list')`);
  await page.evaluate(`document.querySelector('dialog[open] .workspace-drawer-close')?.click()`);
  await page.evaluate(`(()=>{const tab=[...document.querySelectorAll('.workspace-bottom-tabs .block-row:not([hidden]) button')].find(n=>!n.hidden&&!n.disabled);tab?.click();})()`);
  await page.evaluate(`document.querySelector('#stage-comment').click()`);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));`);
  await wait(`!document.querySelector('#inspector-feedback').hidden&&getComputedStyle(document.querySelector('#inspector-feedback')).display!=='none'`);
  const state:any=await page.evaluate(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {language:document.documentElement.lang,top:visible(document.querySelector('#stage-comment')),panel:visible(document.querySelector('#inspector-feedback')),bottomComments:document.querySelectorAll('.workspace-bottom-tabs [data-block-target="feedback"],.workspace-bottom-tabs #workspace-tab-feedback').length,pin:document.querySelector('#rig-viewport').classList.contains('stage-comment-mode'),general:visible(document.querySelector('[data-comment-general]')),listRect:document.querySelector('#stage-comment-list').getBoundingClientRect().toJSON(),name:document.querySelector('#stage-comment-list strong').textContent};})()`);
  assert.equal(state.language,lang);assert.equal(state.top,true);assert.equal(state.panel,true);assert.equal(state.bottomComments,0);assert.equal(state.pin,picture);assert.equal(state.general,!['rig','parts'].includes(kind));assert.equal(state.name,lang==='ko'?'코멘트':'Comments');assert.ok(state.listRect.y>=0&&state.listRect.y+state.listRect.height<=900,'whole comment list visible before composition');
  if(state.general){await page.evaluate(`document.querySelector('[data-comment-general]').click()`);await wait(`!!document.querySelector('#stage-comment-list .stage-comment-composer input')`);}
  await writeFile(join(out,'comments.png'),await page.screenshot());
  observations.push({kind,lang,picture,...state});
 }catch(error){if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');}
}
for(const lang of ['en','ko'] as const){for(const kind of ['rig','parts','direction','signoff','checkpoint','interview-picks'])await run(kind,lang);await run('signoff',lang,false);}
console.log('COMMENT_ENTRY_828_OK cases='+observations.length+' EN=7 KO=7');
