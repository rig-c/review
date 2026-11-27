import {tmpdir} from 'node:os';
/** #796 ordinary Nova: direction take, comment-only submission on one screen, followed by #1228's sign-off-free plan publication check. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startJobHost} from '../src/job-front.ts';
import {JOB_API_V3_SCHEMA,JOB_RECORD_READER_ID,type JobContextComment} from '../src/job-contract.ts';
import {createSyntheticPlanRecordWorkspace,createSyntheticRecordReader} from './helpers/job-record-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {feedbackContextComments,parseStageComment,timeOnlyBasis,unprojectMark} from '../src/stage-comment.ts';
import {parseCommentOnlyAct} from '../src/job-host.ts';
import {validateCommentCrop} from '../src/comment-crops.ts';
import type {Feedback} from '../src/session.ts';
import {jobSourceDraftId} from '../web/job-session.ts';
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
  try{
   const publication=await api('publish',{result:{kind:'package',path:'out',selector:builder.input.getContext().selector},freeze:{kind:'producer-held',holdId:'direction-held',record:{path:'project.json',sha256:hash(await readFile(join(builder.input.root,'project.json')))}}});
   const frozen=await jobInputHashes(builder.input.root);
   const url=new URL(host.ownerUrl);url.searchParams.set('lang',language);
   await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&document.querySelector('#send-comments')?.checkVisibility()&&!!document.querySelector('#rig-root canvas')`);
   assert.equal(await page.evaluate(`document.documentElement.lang`),language);
   const layout:any=await page.evaluate(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {shells:document.querySelectorAll('#app').length,panels:document.querySelectorAll('#direction-panel').length,directionVisible:visible(document.querySelector('#direction-panel')),actBars:document.querySelectorAll('.workspace-act-bar').length,verdictVisible:[...document.querySelectorAll('.workspace-act-bar #save,.workspace-act-bar #request-changes,.workspace-act-bar #review-status')].some(visible),sendPrimary:visible(document.querySelector('.workspace-act-bar #send-comments.primary')),notes:[...document.querySelectorAll('textarea[name="note"],textarea[name="words"],form[data-job-ask] textarea')].filter(visible).length,legacyDumps:document.querySelectorAll('[data-job-direction]').length};})()`);
   assert.equal(layout.shells,1);assert.equal(layout.panels,1);assert.equal(layout.directionVisible,true);
   assert.equal(layout.actBars,1);assert.equal(layout.verdictVisible,false);assert.equal(layout.sendPrimary,true);assert.equal(layout.notes,0);assert.equal(layout.legacyDumps,0);
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
   assert.equal(await page.evaluate(`document.querySelector('#idle-repeat').checked`),true);
   await click('#idle-repeat');
   assert.equal(await page.evaluate(`document.querySelector('#idle-repeat').checked`),false);
   await click('#play');await wait(scrubAt('max'));
   const ended:string=await page.evaluate<string>(`document.querySelector('#scrub').value`);await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),ended);
   await click('#idle-repeat');
   assert.equal(await page.evaluate(`document.querySelector('#idle-repeat').checked`),true);
   assert.equal(await page.evaluate(scrubAt('max')),true,'enabling Repeat leaves short paused');
   const wrap:{before:number;after:number;max:number}|null=await page.evaluate(`(async()=>{
    const scrub=document.querySelector('#scrub'),play=document.querySelector('#play'),max=Number(scrub.max);
    play.click();
    let before=0;
    const deadline=performance.now()+5000;
    while(performance.now()<deadline){
     await new Promise(requestAnimationFrame);
     const after=Number(scrub.value);
     if(before-after>max/2){play.click();return {before,after,max};}
     before=after;
    }
    return null;
   })()`);
   assert.ok(wrap,'short wraps with Repeat enabled');
   observations.push({kind:'short-repeat',language,ended,wrap});
   console.log('DIRECTION_SHORT_REPEAT',JSON.stringify({language,ended,wrap}));
   await click('#stage-comment');
   await click('[data-comment-general]');await composer('Direction comment · 연출');
   await wait(`document.querySelectorAll('.stage-comment-item').length===1`);
   if(!await page.evaluate(`document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`))await click('#stage-comment');
   const point:any=await page.evaluate(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
   await page.mouse('mousePressed',point.x,point.y);await page.mouse('mouseReleased',point.x,point.y);await composer('Direction spot · 연출 위치');
   await wait(`document.querySelectorAll('.stage-comment-item').length===2`);
   const key='rig-review-record-comments/1:'+host.session.jobId+':'+jobSourceDraftId(publication.source)+':'+publication.source.sourceHash;
   const draft:any=await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
   assert.deepEqual(draft.comments.map((row:any)=>row.summary),['Direction comment · 연출','Direction spot · 연출 위치']);
   assert.equal('target' in draft.comments[0],false);assert.ok(draft.comments[1].context.comment.crop.png);
   const expected:JobContextComment[]=[...feedbackContextComments(draft.comments.filter((row:Feedback|{summary:string})=>'target' in row)),{text:draft.comments[0].summary}];
   await click('#direction-panel > summary');assert.equal((await panelState()).open,true);
   // Do not let the readiness check match the old document during same-URL navigation.
   await page.evaluate(`document.body.dataset.ready='reloading'`);reloading=true;
   await command!('Page.reload',{ignoreCache:true});
   await wait(`document.body.dataset.ready==='true'&&!document.querySelector('#send-comments').disabled&&document.querySelectorAll('.stage-comment-item').length===2`);
   reloading=false;assert.equal((await panelState()).open,false,'direction closed again after reload');
   await click('#stage-comment');await wait(`!document.querySelector('#inspector-feedback').hidden`);
   const corrections:{handoffHidden:boolean;actions:number}=await page.evaluate(`(() => {
    const handoff=document.querySelector('#correction-controls');
    return {handoffHidden:handoff.hidden,actions:document.querySelectorAll('.comment-correction-actions button').length};
   })()`);
   assert.deepEqual(corrections,{handoffHidden:true,actions:0});
   assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).comments.map(row=>row.summary)`),draft.comments.map((row:any)=>row.summary));
   const screenshot=language+'-direction.png';await writeFile(join(output,screenshot),await page.screenshot());
   await click('#send-comments');
   let rawAct:unknown;const deadline=Date.now()+20000;
   while(Date.now()<deadline){const next=await api('next',{after:null,waitMs:0});rawAct=next.events.find((e:any)=>e.type==='act'&&e.act.kind==='comments'&&e.act.publicationId===publication.publicationId)?.act;if(rawAct)break;await Bun.sleep(25);}
   assert.ok(rawAct,'direction UI committed act');
   const act=parseCommentOnlyAct(rawAct);
   assert.equal(act.schema,'rig-review/act@10');assert.equal(act.kind,'comments');assert.equal(act.authority.channel,'review-ui');
   assert.equal('askId' in act,false);
   assert.deepEqual(act.value.comments,expected,'comment act retains the complete pin and the general row');
   const pin=act.value.comments[0]?.anchor;assert.ok(pin&&'frameStart' in pin);
   assert.equal(pin.frameStart,null);assert.equal(pin.frameEnd,null);
   const context=pin.context as {comment:unknown;time:number;frame:null;interval:null};
   const mark=parseStageComment(context.comment);
   assert.equal(mark.time,context.time);assert.equal(mark.frame,null);assert.deepEqual(mark.timeBasis,timeOnlyBasis);
   assert.equal(context.frame,null);assert.equal(context.interval,null);
   const {x,y,width,height}=mark.screen;
   assert.equal(width,0);assert.equal(height,0);
   assert.deepEqual(mark.world,{...unprojectMark({x,y},mark.camera),width:0,height:0});
   assert.equal(hash(validateCommentCrop(mark)),mark.crop.sha256);
   assert.equal('still' in act,false);assert.deepEqual(act.source.direction,publication.source.direction);
   const playback=await page.evaluate(`(()=>{const s=document.querySelector('#scrub');return {value:s.value,max:s.max,step:s.step};})()`);
   observations.push({kind:'direction',language,layout,playback,restoredRows:2,act,screenshot});
   assert.deepEqual(await jobInputHashes(builder.input.root),frozen);

   const views:string[]=await page.evaluate(`[...document.querySelectorAll('#view-menu button[data-view]:not(:disabled)')].map(n=>n.dataset.view)`);
   const submittedViews:any[]=[];
   for(const mode of ['rig','playback'])for(const view of views){
    await click(`[data-mode="${mode}"]`);await page.evaluate(`document.querySelector('#view-menu').open=true`);await click(`#view-menu [data-view="${view}"]`);
    const counts:any=await page.evaluate(`Object.fromEntries(['#app','#rig-viewport','#view-menu','#zoom-in','#zoom-out','#fit','#native-one','[data-part-list]'].map(s=>[s,document.querySelectorAll(s).length]))`);
    for(const count of Object.values(counts))assert.equal(count,1);
    const text=mode+'/'+view;
    if(!await page.evaluate(`document.querySelector('[data-comment-general]')?.checkVisibility()`))await click('#stage-comment');
    await click('[data-comment-general]');await composer(text);
    await wait(`!document.querySelector('#send-comments').disabled`);
    await click('#send-comments');
    let value:unknown;const until=Date.now()+20000;
    while(Date.now()<until){
     const next=await api('next',{after:null,waitMs:0});
     value=next.events.find((e:any)=>e.type==='act'&&e.act.kind==='comments'&&e.act.value.comments.some((row:{text:string})=>row.text===text))?.act;
     if(value)break;
     await Bun.sleep(25);
    }
    const commentAct=parseCommentOnlyAct(value);
    assert.deepEqual(commentAct.source.direction,publication.source.direction);
    assert.deepEqual(commentAct.value.comments,[{text}]);
    submittedViews.push({mode,view,actId:commentAct.actId,counts});
   }
   observations.push({kind:'comment-every-view',language,submittedViews});
   const workspace=createSyntheticPlanRecordWorkspace(builder.input.root,{subjects:[{kind:'signoff',stage:'direction-review'}]});
   recordContext=workspace.context;
   await page.evaluate(`document.body.dataset.ready='switching-signoff'`);
   const signoffPublication=await api('publish',{result:workspace.result,freeze:{kind:'producer-held',holdId:'signoff-held',record:workspace.record}});
   const signoffAskRes=await fetch(host.origin+'/jobs/'+host.session.jobId+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+host.session.hostCredentials().agent},body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:host.session.jobId,requestId:randomUUID(),verb:'ask',expectedGeneration:generation,idempotencyKey:randomUUID(),publicationId:signoffPublication.publicationId,subject:{kind:'signoff',stage:'direction-review'}})});
   assert.equal(signoffAskRes.status,409);
   const signoffAskBody=await signoffAskRes.json();
   assert.equal(signoffAskBody.ok,false);
   assert.equal(signoffAskBody.error.code,'JOB_ASK_INVALID');
   observations.push({kind:'record-signoff-refused-after-comments',language,code:signoffAskBody.error.code,commentActId:act.actId});
   await wait(`document.body.dataset.ready==='true'`);
   type NoSignoffFormReadback={forms:number;recordPanels:number;errorText:string;openerVisible:boolean};
   const noSignoffForm:NoSignoffFormReadback=await page.evaluate<NoSignoffFormReadback>(`(()=>({
    forms:document.querySelectorAll('form[data-job-ask]').length,
    recordPanels:document.querySelectorAll('[id="job-record-asks"]').length,
    errorText:document.querySelector('#review-message.error')?.textContent?.trim()??'',
    openerVisible:!!document.querySelector('#workspace-pending-ask:not([hidden])'),
   }))()`);
   assert.deepEqual(noSignoffForm,{forms:0,recordPanels:0,errorText:'',openerVisible:false});
   observations.push({kind:'record-signoff-subject-no-form',language,publicationId:signoffPublication.publicationId,noSignoffForm,commentActId:act.actId});

  }catch(error){await writeFile(join(output,'original-error.json'),JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:undefined,observations,errors},null,2));await writeFile(join(output,'inner-failure-state.json'),await page.evaluate<string>(`JSON.stringify({text:document.body.innerText,ready:document.body.dataset.ready,forms:[...document.querySelectorAll('form[data-job-ask]')].map(f=>({id:f.dataset.jobAsk,disabled:f.querySelector('fieldset')?.disabled})),dialogs:[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open}))})`));await writeFile(join(output,'inner-failure.png'),await page.screenshot()).catch(()=>{});throw error;}finally{await page.goto('about:blank');host.stop();await builder.close();}
 }
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'observations.json'),JSON.stringify({status:'PASS',cases:observations,errors},null,2));
}catch(error){await writeFile(join(output,'observations.json'),JSON.stringify({status:'RED',cases:observations,errors,error:String(error)},null,2));if(page){await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});await writeFile(join(output,'failure-state.json'),await page.evaluate<string>(`JSON.stringify({text:document.body.innerText,ready:document.body.dataset.ready})`)).catch(()=>{});}await writeFile(join(output,'observations.json'),JSON.stringify({status:'RED',cases:observations,errors,error:String(error)},null,2));throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
