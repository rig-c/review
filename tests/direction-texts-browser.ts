/** #829: existing job fixture and shared workspace, ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/direction-texts':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'review-direction-texts-'));
let page:InputCdpSession|undefined;
const observations:unknown[]=[];
async function wait(expression:string){const end=Date.now()+20000;while(Date.now()<end){if(await page!.evaluate(expression))return;await Bun.sleep(25);}throw new Error('DIRECTION_TEXTS_WAIT '+expression);}
try{
 page=await launchCdpSession(profile);await page.setViewport(1440,900);
 for(const language of ['en','ko'] as const)for(const stage of ['direction','rig'] as const){
  const fixture=await scriptedJobWindowFixture();
  let editable:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
   const publication=await fixture.publish(stage);
   await fixture.ask(publication,{kind:'review-verdict',stage:stage==='direction'?'direction-review':'rig-review'});
   if(stage==='rig')editable=await startServer(await loadReview(fixture.packageRoot),{port:0,stateDir:join(fixture.input.root,'editable-state'),exitOnClose:false});
   const url=new URL(editable?`http://127.0.0.1:${editable.port}/`:fixture.host.ownerUrl);url.searchParams.set('lang',language);
   await page.goto(url.href,language);
   await wait(`!!document.querySelector('#rig-root canvas')${stage==='direction'?"&&document.body.dataset.ready==='true'":''}`);
   await page.evaluate(`document.querySelector('[data-inspector="playback"]').click()`);
   await wait(`!!document.querySelector('[data-animation-gate]')&&!!document.querySelector('#rig-label').textContent`);
   const state:{language:string;title:string;gateHidden:boolean;gateVisible:boolean;gateText:string}=await page.evaluate(`(()=>{const gate=document.querySelector('[data-animation-gate]');return {language:document.documentElement.lang,title:document.querySelector('#rig-label').textContent,gateHidden:gate.hidden,gateVisible:!!gate.getClientRects().length&&!gate.closest('[hidden]'),gateText:gate.textContent};})()`);
   assert.equal(state.language,language);
   assert.equal(state.gateHidden,stage==='direction');
   if(stage==='direction'){
    assert.equal(state.title,language==='en'?'Take · 1 s':'테이크 · 1초');
    assert.equal(state.gateVisible,false);
   }else{
    assert.equal(state.gateVisible,true);
    assert.ok(!state.gateText.includes('JOB_REVIEW_READ_ONLY'));
    assert.match(state.title,language==='en'?/Generated rig/:/생성된 리그/);
   }
   observations.push({stage,...state});
   await writeFile(join(output,language+'-'+stage+'.png'),await page.screenshot());
  }finally{await page.goto('about:blank');editable?.stop();await fixture.close();}
 }
 await writeFile(join(output,'observations.json'),JSON.stringify({status:'PASS',observations},null,2));
}catch(error){await writeFile(join(output,'observations.json'),JSON.stringify({status:'RED',observations,error:String(error)},null,2));throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
