import {tmpdir} from 'node:os';
/** #796 ordinary Nova: direction take, comments and verdict on one screen, followed by #795's record signoff modal. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startJobHost} from '../src/job-front.ts';
import {JOB_API_V3_SCHEMA,JOB_RECORD_READER_ID} from '../src/job-contract.ts';
import {createSyntheticPlanRecordWorkspace,createSyntheticRecordReader} from './helpers/job-record-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {projectComments,feedbackItemComments} from '../src/stage-comment.ts';
import type {Feedback} from '../src/session.ts';
const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/direction-screen-796':Bun.argv[at+1]!);await mkdir(output,{recursive:true});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const profile=await mkdtemp(join(tmpdir(),'review796-direction-'));
const observations:any[]=[],errors:unknown[]=[];let page:InputCdpSession|undefined;
let reloading=false;
let command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
async function wait(expression:string){const end=Date.now()+20000;while(Date.now()<end){try{if(await page!.evaluate(expression))return;}catch(error){if(!reloading||!String(error).includes('Inspected target navigated or closed'))throw error;}await Bun.sleep(25);}throw new Error('DIRECTION_SCREEN_WAIT '+expression);}
async function click(selector:string){await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function composer(text:string){await wait(`!!document.querySelector('.stage-comment-composer input')`);await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`);}
function scrubAt(target:number|'max'):string{return `(()=>{const s=document.querySelector('#scrub'),step=Number(s.step),target=${target==='max'?'Number(s.max)':target};return Math.abs(Number(s.value)-target)<=step/2+Number.EPSILON;})()`;}
try{
 page=await launchCdpSession(profile,{sendDeadlineMs:10000,onEvent(event,send){command=send;if(event.method==='Page.javascriptDialogOpening'&&event.params?.type==='beforeunload'&&reloading){observations.push({kind:'reload-confirmation',type:event.params.type});return send('Page.handleJavaScriptDialog',{accept:true}).then(()=>{});}if(event.method==='Runtime.exceptionThrown'||event.method==='Page.javascriptDialogOpening')errors.push(event.params);}});await page.setViewport(1440,900);
 assert.ok(command);await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
 for(const language of ['en','ko'] as const){
  const builder=await scriptedJobWindowFixture();await builder.publish('direction','direction-'+language);
  let recordContext:ReturnType<typeof createSyntheticPlanRecordWorkspace>['context']|undefined;
  const reader=createSyntheticRecordReader({onPlan:()=>recordContext!});
  const host=await startJobHost({...builder.hostOptions,stateDir:join(output,'state-'+language),publicationMode:'record-and-package',readRecordPublished:reader.reader,recordReaderId:JOB_RECORD_READER_ID});
  let generation=0;
  async function api(verb:string,value:object={}){const response=await fetch(host.origin+'/jobs/'+host.session.jobId+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+host.session.hostCredentials().agent},body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:host.session.jobId,requestId:randomUUID(),verb,...verb==='next'?{}:{expectedGeneration:generation,idempotencyKey:randomUUID()},...value})});const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));generation=result.generation;return result.value;}
  const askSubject=(publication:any,subject:any)=>api('ask',{publicationId:publication.publicationId,subject});
  try{
   const publication=await api('publish',{result:{kind:'package',path:'out',selector:builder.input.getContext().selector},freeze:{kind:'producer-held',holdId:'direction-held',record:{path:'project.json',sha256:hash(await readFile(join(builder.input.root,'project.json')))}}});
   const frozen=await jobInputHashes(builder.input.root);
   const ask=await askSubject(publication,{kind:'review-verdict',stage:'direction-review'});
   const url=new URL(host.ownerUrl);url.searchParams.set('lang',language);
   await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&!document.querySelector('#save').disabled&&!!document.querySelector('#rig-root canvas')`);
   assert.equal(await page.evaluate(`document.documentElement.lang`),language);
   const layout:any=await page.evaluate(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {shells:document.querySelectorAll('#app').length,panels:document.querySelectorAll('#direction-panel').length,directionVisible:visible(document.querySelector('#direction-panel')),actBars:document.querySelectorAll('.workspace-act-bar').length,verdictInBar:!!document.querySelector('.workspace-act-bar #review-status'),notes:[...document.querySelectorAll('textarea[name="note"],textarea[name="words"],form[data-job-ask] textarea')].filter(visible).length,legacyDumps:document.querySelectorAll('[data-job-direction]').length};})()`);
   assert.equal(layout.shells,1);assert.equal(layout.panels,1);assert.equal(layout.directionVisible,true);
   assert.equal(layout.actBars,1);assert.equal(layout.verdictInBar,true);assert.equal(layout.notes,0);assert.equal(layout.legacyDumps,0);
   const panelState=()=>page!.evaluate<any>(`(()=>{const p=document.querySelector('#direction-panel'),r=document.querySelector('#rig-overlay').getBoundingClientRect();return {open:p.open,summary:p.querySelector('summary').textContent,width:r.width,height:r.height,dpr:devicePixelRatio};})()`);
   const closed=await panelState();assert.equal(closed.open,false,'direction closed on initial load');
   assert.equal(closed.summary,language==='en'?'Direction v3 · 1 s · loop · fixed camera':'연출 v3 · 1초 · 반복 · 카메라 고정');
   assert.equal(closed.dpr,2);
   await click('#direction-panel > summary');
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   const expanded=await panelState();assert.equal(expanded.open,true);
   const detailsText:string=await page.evaluate(`document.querySelector('#direction-panel > div').textContent`);
   for(const code of ['DEPTH_UNAVAILABLE','SETS_UNAVAILABLE','CAMERA_PLAYBACK_UNAVAILABLE','CAMERA_APPLY_UNSUPPORTED'])assert.ok(detailsText.includes(code),code);
   assert.match(detailsText,/[a-f0-9]{64}/,'expanded hashes retained');
   assert.ok(closed.height>expanded.height,'closing direction returns height to the main view');
   await click('#direction-panel > summary');
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   assert.equal((await panelState()).height,closed.height);
   observations.push({kind:'direction-collapse',language,closed,expanded,detailsText});
   // #559 successor: exercise the actual shared-screen playback for a direction-bearing post source.
   await page.evaluate(`(()=>{const select=document.querySelector('#animation-select');select.value='inspect';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(scrubAt(0)),true);
   await click('#play');await wait(`Number(document.querySelector('#scrub').value)>0.05`);await click('#play');
   const paused:string=await page.evaluate<string>(`document.querySelector('#scrub').value`);await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),paused);
   await click('#play');
   // The shared range control normalizes to its step; exercise a step-aligned seek, not arbitrary precision.
   await page.evaluate(`(()=>{const scrub=document.querySelector('#scrub');scrub.value='0.123';scrub.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(scrubAt(0.123)),true);await Bun.sleep(100);
   assert.equal(await page.evaluate(scrubAt(0.123)),true);
   await page.evaluate(`(()=>{const select=document.querySelector('#animation-select');select.value='short';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(scrubAt(0)),true);await Bun.sleep(100);
   assert.equal(await page.evaluate(scrubAt(0)),true);
   await click('#play');await wait(scrubAt('max'));
   const ended:string=await page.evaluate<string>(`document.querySelector('#scrub').value`);await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),ended);
   await page.evaluate(`(()=>{const s=document.querySelector('#review-status');s.value='approved';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await click('[data-comment-general]');await composer('Direction comment · 연출');
   await wait(`document.querySelectorAll('.stage-comment-item').length===1`);
   await click('#stage-comment');
   const point:any=await page.evaluate(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
   await page.mouse('mousePressed',point.x,point.y);await page.mouse('mouseReleased',point.x,point.y);await composer('Direction spot · 연출 위치');
   await wait(`document.querySelectorAll('.stage-comment-item').length===2`);
   const key='rig-review-record-comments/1:'+publication.publicationId+':'+publication.source.sourceHash;
   const draft:any=await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
   assert.deepEqual(draft.comments.map((row:any)=>row.summary),['Direction comment · 연출','Direction spot · 연출 위치']);
   assert.equal('target' in draft.comments[0],false);assert.ok(draft.comments[1].context.comment.crop.png);
   const projected=projectComments(draft.comments.map((row:any)=>'target' in row?feedbackItemComments([row as Feedback])[0]!:{text:row.summary}));
   assert.equal(draft.status,'approved','legacy comment draft records the earlier verdict');
   await page.evaluate(`(()=>{const s=document.querySelector('#review-status');s.value='changes-requested';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await click('#direction-panel > summary');assert.equal((await panelState()).open,true);
   // Do not let the readiness check match the old document during same-URL navigation.
   await page.evaluate(`document.body.dataset.ready='reloading'`);reloading=true;
   await command!('Page.reload',{ignoreCache:true});
   await wait(`document.body.dataset.ready==='true'&&!document.querySelector('#save').disabled&&document.querySelectorAll('.stage-comment-item').length===2`);
   reloading=false;assert.equal((await panelState()).open,false,'direction closed again after reload');
   assert.equal(await page.evaluate(`document.querySelector('#review-status').value`),'changes-requested','inspection draft is authoritative after reload');
   await click('#stage-comment');await wait(`!document.querySelector('#inspector-feedback').hidden`);
   const corrections:any=await page.evaluate(`(()=>{document.querySelector('#correction-controls').open=true;const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {fileVisible:visible(document.querySelector('#correction-words')),addVisible:visible(document.querySelector('#add-proposal')),hiddenByGate:!!document.querySelector('#correction-words').closest('[hidden]')&&!!document.querySelector('#add-proposal').closest('[hidden]')};})()`);
   assert.deepEqual(corrections,{fileVisible:false,addVisible:false,hiddenByGate:true});
   assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).comments.map(row=>row.summary)`),draft.comments.map((row:any)=>row.summary));
   const screenshot=language+'-direction.png';await writeFile(join(output,screenshot),await page.screenshot());
   await click('#save');
   let act:any;const deadline=Date.now()+20000;
   while(Date.now()<deadline){const next=await api('next',{after:null,waitMs:0});act=next.events.flatMap((e:any)=>e.type==='act'&&e.act.askId===ask.askId?[e.act]:[])[0];if(act)break;await Bun.sleep(25);}
   assert.ok(act,'direction UI committed act');assert.equal(act.schema,'rig-review/act@6');assert.equal(act.authority.channel,'review-ui');
   assert.equal(act.value.stage,'direction-review');assert.equal(act.value.verdict,'changes-requested');
   assert.equal(act.value.comments.length,1);assert.equal(act.value.comments[0].text,projected);
   assert.equal('still' in act,false);assert.deepEqual(act.source.direction,publication.source.direction);
   const playback=await page.evaluate(`(()=>{const s=document.querySelector('#scrub');return {value:s.value,max:s.max,step:s.step};})()`);
   observations.push({kind:'direction',language,layout,playback,projected,restoredRows:2,act,screenshot,pinTransport:'text projection only; positions/crops/bookmarks follow-up #776'});
   assert.deepEqual(await jobInputHashes(builder.input.root),frozen);

   const views:string[]=await page.evaluate(`[...document.querySelectorAll('#view-menu button[data-view]:not(:disabled)')].map(n=>n.dataset.view)`);
   const submittedViews:any[]=[];
   for(const mode of ['rig','playback'])for(const view of views){
    const nextAsk=await askSubject(publication,{kind:'review-verdict',stage:'direction-review'});
    await wait(`!document.querySelector('#save').disabled`);
    await click(`[data-mode="${mode}"]`);await page.evaluate(`document.querySelector('#view-menu').open=true`);await click(`#view-menu [data-view="${view}"]`);
    const counts:any=await page.evaluate(`Object.fromEntries(['#app','#rig-viewport','#view-menu','#zoom-in','#zoom-out','#fit','#native-one','[data-part-list]'].map(s=>[s,document.querySelectorAll(s).length]))`);
    for(const count of Object.values(counts))assert.equal(count,1);
    await click('#save');let value:any;const until=Date.now()+20000;while(Date.now()<until){const next=await api('next',{after:null,waitMs:0});value=next.events.find((e:any)=>e.type==='act'&&e.act.askId===nextAsk.askId)?.act;if(value)break;await Bun.sleep(25);}
    assert.ok(value,'verdict from '+mode+'/'+view);assert.equal(value.value.stage,'direction-review');submittedViews.push({mode,view,actId:value.actId,counts});
   }
   observations.push({kind:'verdict-every-view',language,submittedViews});
   const workspace=createSyntheticPlanRecordWorkspace(builder.input.root,{subjects:[{kind:'signoff',stage:'direction-review'}]});
   recordContext=workspace.context;
   const signoffPublication=await api('publish',{result:workspace.result,freeze:{kind:'producer-held',holdId:'signoff-held',record:workspace.record}});
   const signoff=await askSubject(signoffPublication,{kind:'signoff',stage:'direction-review'});
   await wait(`!!document.querySelector('form[data-job-ask="${signoff.askId}"] fieldset:not(:disabled)')`);
   await click('#workspace-pending-ask');await wait(`document.querySelector('#job-record-asks[open] form[data-job-ask="${signoff.askId}"] fieldset:not(:disabled)')`);
   await writeFile(join(output,language+'-signoff.png'),await page!.screenshot());
   await click(`form[data-job-ask="${signoff.askId}"] button[type=submit]`);
   let signed:any;const end=Date.now()+20000;while(Date.now()<end){const next=await api('next',{after:null,waitMs:0});signed=next.events.find((e:any)=>e.type==='act'&&e.act.askId===signoff.askId)?.act;if(signed)break;await Bun.sleep(25);}
   assert.ok(signed,'record direction signoff committed after verdict');assert.equal(signed.schema,'rig-review/act@4');assert.equal(signed.value.stage,'direction-review');assert.equal(signed.kind,'signoff');
   observations.push({kind:'record-signoff-after-verdict',language,act:signed,verdictActId:act.actId});

  }catch(error){await writeFile(join(output,'original-error.json'),JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:undefined,observations,errors},null,2));await writeFile(join(output,'inner-failure-state.json'),await page.evaluate<string>(`JSON.stringify({text:document.body.innerText,ready:document.body.dataset.ready,forms:[...document.querySelectorAll('form[data-job-ask]')].map(f=>({id:f.dataset.jobAsk,disabled:f.querySelector('fieldset')?.disabled})),dialogs:[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open}))})`));await writeFile(join(output,'inner-failure.png'),await page.screenshot()).catch(()=>{});throw error;}finally{await page.goto('about:blank');host.stop();await builder.close();}
 }
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'observations.json'),JSON.stringify({status:'PASS',cases:observations,errors},null,2));
}catch(error){await writeFile(join(output,'observations.json'),JSON.stringify({status:'RED',cases:observations,errors,error:String(error)},null,2));if(page){await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});await writeFile(join(output,'failure-state.json'),await page.evaluate<string>(`JSON.stringify({text:document.body.innerText,ready:document.body.dataset.ready})`)).catch(()=>{});}await writeFile(join(output,'observations.json'),JSON.stringify({status:'RED',cases:observations,errors,error:String(error)},null,2));throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
