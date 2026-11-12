/** #797 ordinary Nova EN/KO: the retained scene, take clock, shared camera and pinned composite. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {installSceneFixture} from './helpers/scene-inspection-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
const at=Bun.argv.indexOf('--out'),out=resolve(at<0?'artifacts/scene-take-797':Bun.argv[at+1]!);
await mkdir(out,{recursive:true});const profile=await mkdtemp(join(tmpdir(),'scene-take-797-'));
let page:InputCdpSession|undefined;const errors:unknown[]=[],observations:unknown[]=[];
async function wait(expression:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate(expression))return;await Bun.sleep(25);}throw new Error('SCENE_WAIT '+expression);}
async function click(selector:string){await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
try{
 page=await launchCdpSession(profile,{sendDeadlineMs:10000,onEvent(event,send){if(event.method==='Page.javascriptDialogOpening'&&event.params?.type==='beforeunload')return send('Page.handleJavaScriptDialog',{accept:true}).then(()=>{});if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1280,900);
 for(const language of ['en','ko'] as const){
  const f=await realJobWindowFixture();try{
   await installSceneFixture(join(f.input.root,'out'));
   f.input.setContext({...f.input.getContext(),selector:{kind:'post',version:2,rigVersion:1},subjects:[{kind:'review-verdict',stage:'direction-review'}]});
   const publication=await f.publish();
   const response=await f.call({...f.input.base(),verb:'ask',expectedGeneration:f.host.session.status().generation,idempotencyKey:'scene-ask',publicationId:publication.publicationId,subject:{kind:'review-verdict',stage:'direction-review'}});
   assert.equal((await response.json()).ok,true);
   const url=new URL(f.host.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#rig-root canvas')&&!document.querySelector('#save').disabled`);
   const summary:string=await page.evaluate<string>(`document.querySelector('#direction-panel > summary').textContent`);
   assert.equal(summary,language==='en'?'Direction v2 · 8 s · loop · moving camera':'연출 v2 · 8초 · 반복 · 카메라 이동');
   await click('#direction-panel > summary');
   assert.equal(await page.evaluate(`document.querySelector('#direction-authored-body').textContent.includes('"keys"')`),false);
   const planes:string=await page.evaluate<string>(`document.querySelector('#direction-panel').textContent`);assert.ok(planes.includes(language==='en'?'background → rig → foreground':'배경 → 인물 → 전경'));
   await click('#direction-panel > summary');
   assert.equal(await page.evaluate(`document.querySelectorAll('#rig-root canvas').length`),1);
   assert.equal(await page.evaluate(`Number(document.querySelector('#scrub').max)`),8);
   // Read actual committed composite pixels, not renderer/model existence.
   const pixels=()=>page!.evaluate<any>(`(()=>{const c=document.querySelector('#rig-root canvas'),ctx=c.getContext('2d'),at=(x,y)=>[...ctx.getImageData(Math.floor(c.width*x),Math.floor(c.height*y),1,1).data];return {width:c.width,height:c.height,front:at(.5,.02),back:at(.05,.8),rig:at(.9,.8),worldWidth:c.style.width,worldLeft:c.style.left,root:document.querySelector('#rig-root').style.cssText};})()`);
   console.log(language+' pixels');
   const before=await pixels();assert.deepEqual(before.front,[230,0,20,255]);assert.deepEqual(before.back,[24,160,20,255]);assert.deepEqual(before.rig,[32,220,48,255]);
   console.log(language+' playback');
   await click('#play');await wait(`Number(document.querySelector('#scrub').value)>.1`);await click('#play');
   await page.evaluate(`(()=>{const s=document.querySelector('#scrub');s.value='4';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(`Number(document.querySelector('#scrub').value)`),4);
   console.log(language+' camera');
   const moved=await pixels();assert.notEqual(moved.worldWidth,before.worldWidth,'camera box changes the drawn world box');
   await page.evaluate(`(()=>{const s=document.querySelector('#scrub');s.value='7.95';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await click('#play');await wait(`Number(document.querySelector('#scrub').value)<1`);await click('#play');
   console.log(language+' wrapped');
   for(const selector of ['#zoom-in','#zoom-out','#fit','#native-one']){await click(selector);assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),1);}
   console.log(language+' controls');
   await click('#fit');await page.evaluate(`(()=>{const s=document.querySelector('#scrub');s.value='4';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('#stage-comment');
   const point=await page.evaluate<any>(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
   await page.mouse('mousePressed',point.x,point.y);await page.mouse('mouseReleased',point.x,point.y);
   await wait(`!!document.querySelector('.stage-comment-composer input')`);
   await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value='Composite point';f.requestSubmit();})()`);
   await wait(`document.querySelectorAll('.stage-comment-item').length===1`);
   const key='rig-review-record-comments/1:'+publication.publicationId+':'+publication.source.sourceHash;
   const comment:any=await page.evaluate<any>(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).comments[0]`);
   assert.ok(comment.context.comment.crop.png);assert.equal(comment.context.comment.sourceHash,publication.source.sourceHash);
   assert.equal(comment.context.comment.time,4);
   await page.evaluate(`(()=>{const s=document.querySelector('#scrub');s.value='0';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await click('.stage-comment-summary');await wait(`Number(document.querySelector('#scrub').value)===4&&!!document.querySelector('.stage-comment-composer')`);
   await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
   await writeFile(join(out,language+'-composite.png'),await page.screenshot());
   console.log(language+' pinned-composite-pass');
   observations.push({language,summary,planes,before,moved,comment,publicationSource:publication.source});
  }finally{await f.close();}
 }
 assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({observations,errors},null,2));
 console.log('SCENE_TAKE_EN_KO_PASS');
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),errors,observations,body:await page?.evaluate(`document.body.innerText`)}));if(page)await writeFile(join(out,'failure.png'),await page.screenshot());throw error;}finally{await page?.close();await rm(profile,{recursive:true,force:true});}
