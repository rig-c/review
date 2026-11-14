/** #735 ordinary-Nova-only UI proof. Reuses the live-job fixture, CDP and visibility harness.
 * No producer/compiler acceptance claim; no local browser invocation. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {JOB_API_SCHEMA} from '../src/job-contract.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {fullyVisible,visibilityGeometry} from './helpers/walk-visibility.ts';
import {withDeadline} from './helpers/walk-deadline.ts';

interface ScreenState {language:string;mode:string;tabs:string[];rows:number;actVisible:boolean;commentsVisible:boolean;commentsPanel:boolean;actInHeading:boolean;ask:string;summaryInputs:number;commentLists:number;commentListInPanel:boolean;modeLabels:string[]}

const cameraExpression="JSON.parse(document.getElementById('view-coordinates').textContent).cameras.rig";
async function run(lang:'en'|'ko',output:string){
 const out=join(output,lang);await mkdir(out,{recursive:true});
 const fixture=await realJobWindowFixture(),profile=await mkdtemp(join(tmpdir(),'review-735-browser-'));
 const observations:Record<string,unknown>={language:lang,viewport:{width:1600,height:1000},fixture:'synthetic retained rig, real live-job screen'};
 let page:InputCdpSession|undefined;
 const record=async(name:string,value:unknown)=>{observations[name]=value;await writeFile(join(out,'observations.json'),JSON.stringify(observations,null,2)+'\n');console.log('REVIEW_735 '+lang+' '+name);};
 try{
  const publication=await fixture.publish();
  const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:fixture.host.session.jobId,requestId:randomUUID(),verb:'ask',expectedGeneration:fixture.host.session.status().generation,idempotencyKey:'735-rig-'+lang,publicationId:publication.publicationId,subject:{kind:'review-verdict',stage:'rig-review'}});
  assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  const before=await jobInputHashes(fixture.input.root);
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000});await page.setViewport(1600,1000);
  const owner=new URL(fixture.host.ownerUrl);owner.searchParams.set('lang',lang);await page.goto(owner.href,lang);
  const wait=async(expression:string,name:string)=>withDeadline('735.'+lang+'.'+name,20_000,async signal=>{while(!signal.aborted){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw signal.reason;});
  await wait("!!document.querySelector('#rig-root canvas')&&!!document.querySelector('#stage-comment-list')&&!!document.querySelector('#save:not(:disabled)')&&!!document.querySelector('#view-coordinates')?.textContent",'ready');
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const initial=await page.evaluate<ControlNumericCamera>(cameraExpression);assert.equal(initial.zoom,1,'opens at fit-relative zoom 1');
  await click(page,'#fit');await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const fitted=await page.evaluate<ControlNumericCamera>(cameraExpression);
  assert.ok(Math.abs(initial.center.x-fitted.center.x)<1e-7&&Math.abs(initial.center.y-fitted.center.y)<1e-7,'initial center already equals explicit Fit');
  assert.deepEqual(initial.visible,fitted.visible,'initial visible world already equals explicit Fit');
  await record('initial-fit',{initial,afterExplicitFit:fitted});await writeFile(join(out,'initial-fit.png'),await page.screenshot());
  const catalog=lang==='ko'?koCatalog:enCatalog;
  for(const mode of ['rig','playback'] as const){
   await click(page,'[data-mode="'+mode+'"]');
   await wait('document.querySelector(\'[data-mode="'+mode+'"]\').getAttribute("aria-pressed")==="true"','header-'+mode);
   for(const comments of [false,true]){
    if(comments)await click(page,'#stage-comment');
    const state:ScreenState=await page.evaluate<ScreenState>(`(()=>{
     const visible=${fullyVisible.toString()},geometry=${visibilityGeometry.toString()};
     const row=[...document.querySelectorAll('.workspace-bottom-tabs .block-row')].find(node=>!node.hidden&&node.getBoundingClientRect().width>0);
     const act=document.querySelector('#workspace-review-act'),comment=document.querySelector('#workspace-tab-feedback'),panel=document.querySelector('#inspector-feedback');
     return {language:document.documentElement.lang,mode:document.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode,
      tabs:[...row.querySelectorAll('button')].map(node=>node.textContent),rows:[...document.querySelectorAll('.workspace-bottom-tabs .block-row')].filter(node=>!node.hidden).length,
      actVisible:visible(act),commentsVisible:!!comment&&visible(comment),commentsPanel:!panel.hidden&&getComputedStyle(panel).display!=='none',actInHeading:!!act.closest('.inspector-heading'),ask:document.querySelector('#workspace-ask-headline').textContent,
      summaryInputs:document.querySelectorAll('input#feedback-summary,textarea#checkpoint-note').length,commentLists:document.querySelectorAll('#stage-comment-list').length,commentListInPanel:!!document.querySelector('#comments-list-host #stage-comment-list'),
      modeLabels:[...document.querySelectorAll('.workspace-bottom-tabs button')].map(node=>node.textContent),actGeometry:geometry(act),commentsGeometry:comment?geometry(comment):null};
    })()`);
    await record(mode+(comments?'-comments':'-blocks'),state);
    assert.equal(state.language,lang);assert.equal(state.mode,mode);assert.equal(state.rows,1);assert.equal(state.actVisible,true,'whole act visible');assert.equal(state.actInHeading,true);
    assert.equal(state.commentsVisible,false,'no bottom Comments tab');assert.equal(state.commentsPanel,comments);assert.ok(!state.tabs.includes(catalog['Comments (0)']));
    assert.equal(state.tabs[0],catalog[mode==='rig'?'Part':'Transport']);assert.equal(state.summaryInputs,0);assert.equal(state.commentLists,1);assert.equal(state.commentListInPanel,true);
    assert.equal(state.ask,catalog['Check the rig and motion.']);
    for(const label of state.modeLabels)assert.ok(!['Setup','Animate','Write review','셋업','애니메이트','리뷰 작성'].includes(label),'no bottom mode labels');
    await writeFile(join(out,mode+(comments?'-comments':'-blocks')+'.png'),await page.screenshot());
   }
  }
  assert.deepEqual(await jobInputHashes(fixture.input.root),before,'source assets immutable through mode/comment navigation');
  await record('passed',{sourceHash:publication.source.sourceHash,assertions:'Fit, header mode, existing blocks, Comments and act in both modes, fixed ask sentence, one comment list, EN/KO'});
 }catch(error){if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});await record('failed',{error:String(error)});throw error;}
 finally{await page?.close();await fixture.close();await rm(profile,{recursive:true,force:true});}
}
if(import.meta.main){const index=Bun.argv.indexOf('--out'),output=resolve(index<0?'artifacts/review-735':Bun.argv[index+1]!);for(const lang of ['en','ko'] as const)await run(lang,output);console.log('REVIEW_735_BROWSER_OK EN=1 KO=1 viewport=1600x1000');}
