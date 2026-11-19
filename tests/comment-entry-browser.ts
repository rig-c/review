/** #828 and #831 ordinary Nova browser coverage using synthetic fixtures. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,readFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {commentFixture} from './helpers/parts-comments-package.ts';
import {parseCommentsAct,projectComments} from '../src/job-host.ts';
import type {JobCommentsAct,JobPendingAsk,JobPublication} from '../src/job-contract.ts';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {recordScreenFixture,type RecordScreenKind} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
function readFilter<T extends string>(flag:string,choices:readonly T[]):T|undefined {
 const index=Bun.argv.indexOf(flag);
 if(index<0)return undefined;
 const choice=choices.find(value=>value===Bun.argv[index+1]);
 if(!choice||index!==Bun.argv.lastIndexOf(flag))throw new Error(flag+' expects one of '+choices.join(', '));
 return choice;
}
const subjectFilter=readFilter('--subject',['rig','parts'] as const);
const languageFilter=readFilter('--lang',['en','ko'] as const);
const sourceOnly=Bun.argv.includes('--source-only');
if(sourceOnly&&subjectFilter)throw new Error('--source-only cannot be combined with --subject');
const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/comment-entry-828':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];
type Language = 'en' | 'ko';
type Verdict = 'approved' | 'changes-requested';
type Wait = (expression:string)=>Promise<void>;
type PageCommand = (method:string,params?:Record<string,unknown>)=>Promise<unknown>;
type LivePublication = {kind:'rig'|'parts';fixture:Awaited<ReturnType<typeof scriptedJobWindowFixture>>;
  publication:JobPublication;verdict:Verdict};
type LiveVerdict = LivePublication & {ask:JobPendingAsk;otherAsk:JobPendingAsk};
type CommentEntryState = {videoDeclared:boolean;language:string;top:boolean;panel:boolean;bottomComments:number;pin:boolean;
  general:boolean;generalCount:number;listRect:{y:number;height:number};checkpointHidden:boolean;stripHidden:boolean;
  stripBlocked:boolean;noSourceFilesHidden:boolean;name:string};
type DecisionControls = {approve:{label:string;disabled:boolean};changes:{label:string;disabled:boolean;title:string;aria:string|null}};
type SourceOnlyExport = {status:number;body:{plan:{binding:{packages:{reviewedSource:{rig:unknown}}[]}};rendering:unknown}};

const generalButton = '[data-comment-general]';
const composer = '.stage-comment-composer';
const summary = '#stage-comment-list .stage-comment-summary';
const ready = `document.body.dataset.ready==='true'&&!document.body.inert`;
const generalEntryVisible = `!!document.querySelector('${generalButton}')?.checkVisibility()`;

async function openLiveVerdict(page:InputCdpSession,wait:Wait,live:LivePublication,lang:Language):Promise<LiveVerdict> {
  const {kind,fixture,publication}=live;
  await wait(`${ready}&&document.querySelector('#save')?.hidden===true`);
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false,'a published source alone does not offer verdict comments');
  await page.evaluate(`window.__commentEntryBeforeAsk=true`);

  const checkpointOnly=kind==='rig'&&live.verdict==='changes-requested';
  const otherAsk=await fixture.ask(publication,checkpointOnly?{kind:'checkpoint',checkpointId:'step-one'}:{kind:'signoff',stage:'plan-approved'});
  const catalog=lang==='ko'?koCatalog:enCatalog;
  const otherPrompt=catalog[checkpointOnly?'Review this checkpoint.':'Approve this stage.'];
  await wait(`document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(otherPrompt)}`);
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false,'a live '+otherAsk.subject.kind+' alone does not offer verdict comments');

  const ask=await fixture.ask(publication,kind==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:'rig-review'});
  await wait(`document.querySelector('#save')?.checkVisibility()===true`);
  assert.equal(await page.evaluate<boolean>('window.__commentEntryBeforeAsk'),true,'the verdict arrives in the same document');
  return {...live,ask,otherAsk};
}

async function readDecisions(page:InputCdpSession) {
  return page.evaluate<DecisionControls>(`(()=>{
    const approve=document.querySelector('#save'),changes=document.querySelector('#request-changes');
    return {approve:{label:approve.textContent.trim(),disabled:approve.disabled},
      changes:{label:changes.textContent.trim(),disabled:changes.disabled,title:changes.title,aria:changes.getAttribute('aria-label')}};
  })()`);
}

async function saveComment(page:InputCdpSession,wait:Wait,text:string) {
  await wait(`!!document.querySelector('${composer} input')`);
  await page.evaluate(`(()=>{const form=document.querySelector('${composer}');
    form.querySelector('input').value=${JSON.stringify(text)};form.requestSubmit();})()`);
  await wait(`!document.querySelector('${composer}')`);
}

async function clickComment(page:InputCdpSession,selector:string) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
  await click(page,selector);
}

async function addPartsPin(page:InputCdpSession,wait:Wait,text:string) {
  await click(page,'[data-part-list] button');
  await click(page,'#part-solo');
  await wait(`document.querySelector('#stage-layout').getAttribute('aria-busy')==='false'`);
  await click(page,'#fit');
  if (!await page.evaluate<boolean>(`document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`)) {
    await click(page,'#stage-comment');
  }
  const point=await page.evaluate<{x:number;y:number}>(`(()=>{
    const canvas=document.querySelector('#parts-canvas').getBoundingClientRect();
    const pane=document.querySelector('#rig-viewport').getBoundingClientRect();
    return {x:Math.max(canvas.left,pane.left)+Math.min(canvas.width,pane.width)*.35,
      y:Math.max(canvas.top,pane.top)+Math.min(canvas.height,pane.height)*.35};
  })()`);
  await page.mouse('mouseMoved',point.x,point.y);
  await page.mouse('mousePressed',point.x,point.y);
  await page.mouse('mouseMoved',point.x+32,point.y+32);
  await page.mouse('mouseReleased',point.x+32,point.y+32);
  await saveComment(page,wait,text);
}

async function readFinalVerdict(live:LiveVerdict):Promise<JobCommentsAct> {
  const {fixture,ask,publication,kind,verdict}=live;
  const end=Date.now()+20_000;
  while(Date.now()<end){
    const events=(await fixture.next()).events.flatMap(event=>event.type==='act'&&event.act.askId===ask.askId?[event.act]:[]);
    assert.ok(events.length<=1,'one explicit verdict produces at most one act');
    if(events.length){
      const act=parseCommentsAct(events[0]);
      assert.equal(act.publicationId,publication.publicationId);
      assert.equal(act.source.sourceHash,publication.source.sourceHash);
      assert.equal(act.authority.channel,'review-ui');
      if(kind==='rig'){
        assert.ok(act.kind==='review-verdict'&&act.still);
        assert.equal(act.value.stage,'rig-review');
      }else assert.ok(act.kind==='parts-verdict');
      assert.equal(act.value.verdict,verdict);
      const stored=fixture.host.session.readActExport(act.actId,false).toString();
      assert.equal(JSON.stringify(act),stored);
      return act;
    }
    await Bun.sleep(50);
  }
  throw new Error('COMMENT_ENTRY_FINAL_VERDICT '+kind+' '+verdict);
}

async function exerciseLiveVerdict(page:InputCdpSession,wait:Wait,reload:()=>Promise<void>,live:LiveVerdict,lang:Language,out:string) {
  const {kind,verdict,fixture,ask,otherAsk}=live,ko=lang==='ko';
  const general=[ko?'수정한 일반 의견':'Edited general comment',ko?'두 번째 일반 의견':'Second general comment'];
  const generalLabel=ko?'일반 코멘트':'General comment';
  const pinRequired=ko?'수정 요청에는 파츠에 고정한 코멘트가 하나 이상 필요해요.':'Request changes needs at least one comment pinned to a part.';
  const initial=await readDecisions(page);
  assert.equal(initial.approve.label,ko?'승인':'Approve');
  assert.equal(initial.changes.label,ko?'수정 요청':'Request changes');
  assert.equal(initial.changes.disabled,true);
  assert.equal(initial.changes.title,ko?'고칠 곳에 코멘트를 달아 주세요':'Add a comment where changes are needed.');
  assert.equal(await page.evaluate<string>(`document.querySelector('${generalButton}').textContent`),ko?'일반 코멘트 추가':'Add general comment');

  const add=async(text:string)=>{await clickComment(page,generalButton);await saveComment(page,wait,text);};
  const rows=()=>page.evaluate<string[]>(`[...document.querySelectorAll('${summary}')].map(node=>node.textContent)`);
  await add(ko?'처음 쓴 의견':'Original general comment');
  await add(ko?'지울 의견':'Temporary general comment');
  const beforeEdit=await rows();
  assert.equal(beforeEdit.length,2);
  await clickComment(page,'#stage-comment-list .stage-comment-item:last-child .stage-comment-summary');
  await wait(`!!document.querySelector('${composer} .stage-comment-delete')`);
  await clickComment(page,`${composer} .stage-comment-delete`);
  assert.deepEqual(await rows(),beforeEdit.slice(0,1),'Delete updates the backing draft immediately');
  await clickComment(page,summary);
  await saveComment(page,wait,general[0]!);
  await add(general[1]!);
  const expectedRows=general.map((text,index)=>`${index+1} · ${generalLabel} · ${text}`);
  assert.deepEqual(await rows(),expectedRows);
  await writeFile(join(out,'general-before-reload.png'),await page.screenshot());

  await reload();
  await wait(`!!document.querySelector('#stage-comment:not(:disabled)')`);
  await click(page,'#stage-comment');
  assert.deepEqual(await rows(),expectedRows,'Edit and Delete survive a new document');
  assert.equal(await page.evaluate<number>(`document.querySelectorAll('.stage-comment-pin').length`),0,'general rows produce zero pins');
  const events=await fixture.next();
  assert.equal(events.events.some(event=>event.type==='act'&&event.act.askId===ask.askId),false,'draft or reload creates no act');
  const restored=await readDecisions(page);
  assert.equal(restored.approve.disabled,false);
  if(kind==='parts'){
    assert.equal(restored.changes.disabled,true);
    assert.equal(restored.changes.title,pinRequired,'the existing Request changes control explains the required pin');
    assert.equal(restored.changes.label,initial.changes.label);
    await page.evaluate(`document.querySelector('#request-changes').click()`);
    assert.equal((await fixture.next()).events.some(event=>event.type==='act'&&event.act.askId===ask.askId),false,'Parts Request changes without a pin creates no act');
    assert.ok(fixture.host.session.status().pending.some(pending=>pending.askId===ask.askId));
  }else assert.equal(restored.changes.disabled,false);

  const pinned=kind==='parts'&&verdict==='changes-requested';
  const pinText=ko?'수정한 파츠 핀':'Edited Parts pin';
  if(pinned){
    const original=ko?'처음 파츠 핀':'Original Parts pin';
    await addPartsPin(page,wait,original);
    const pinRow=await page.evaluate<string|undefined>(`[...document.querySelectorAll('${summary}')]
      .find(node=>node.textContent.endsWith(${JSON.stringify(original)}))?.closest('[data-comment-id]')?.dataset.commentId`);
    assert.ok(pinRow,'the saved pin has its own comment row');
    await clickComment(page,`[data-comment-id=${JSON.stringify(pinRow)}] .stage-comment-summary`);
    await saveComment(page,wait,pinText);
    const controls=await readDecisions(page);
    assert.equal(controls.approve.disabled,true);
    assert.equal(controls.changes.disabled,false);
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('.stage-comment-pin').length`),1);
  }
  await writeFile(join(out,'comments.png'),await page.screenshot());
  await click(page,verdict==='approved'?'#save':'#request-changes');
  const act=await readFinalVerdict(live);
  await wait(`document.querySelector('#save')?.hidden===true`);
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false,'general verdict entry disappears when only the non-verdict ask remains');
  assert.ok(fixture.host.session.status().pending.some(pending=>pending.askId===otherAsk.askId));
  const comments=act.value.comments;
  assert.deepEqual(comments.slice(pinned?1:0),general.map(text=>({text})));
  if(pinned){
    const anchor=comments[0]?.anchor;
    assert.ok(anchor&&'schema' in anchor&&anchor.schema==='rig-review-parts-comment/2');
    assert.equal(anchor.sourceHash,act.source.sourceHash);
    assert.equal(comments[0]?.text,pinText);
  }
  const projected=projectComments(comments);
  const generalProjection='[general]\n'+general.join('\n\n[general]\n');
  assert.equal(projected,pinned?projectComments(comments.slice(0,1))+'\n\n'+generalProjection:generalProjection);
  const readback={initial,restored,rows:expectedRows,act,projected};
  await writeFile(join(out,'verdict.json'),JSON.stringify(readback,null,2)+'\n');
  return readback;
}

async function run(kind:string,lang:Language,picture=true,verdict:Verdict='approved'){
 const profile=await mkdtemp(join(tmpdir(),'review828-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 let livePublication:LivePublication|undefined,sendPage:PageCommand|undefined;
 const out=join(output,kind+(picture?'':'-empty')+(verdict==='approved'?'':'-changes'),lang);await mkdir(out,{recursive:true});
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
  }else if(kind==='standalone-parts'){
   const capability='b'.repeat(64);
   const server=await startPartsServer(await commentFixture(join(profile,'standalone-parts')),{port:0,capability,exitOnClose:false});
   close=async()=>{await server.stop(true);};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(kind==='rig'||kind==='parts'||kind==='direction'){
   const fixture=await scriptedJobWindowFixture(kind==='parts'?{c5Parts:'mesh'}:{});close=()=>fixture.close();
   const publication=await fixture.publish(kind);
   hasVideo=JSON.parse(await readFile(join(fixture.packageRoot,'review.json'),'utf8')).references.some((reference:{type:string})=>reference.type==='video');
   if(kind==='direction')await fixture.ask(publication,{kind:'review-verdict',stage:'direction-review'});
   else livePublication={kind,fixture,publication,verdict};
   url=fixture.host.ownerUrl;
  }else{
   const fixture=await recordScreenFixture(kind as RecordScreenKind,picture);close=()=>fixture.close();url=fixture.ownerUrl;
  }
  const target=new URL(url);target.searchParams.set('lang',lang);
  page=await launchCdpSession(join(profile,'chrome'),{sendDeadlineMs:20_000,async onEvent(event,send){
   if(event.sessionId)sendPage=send;
   if(event.method==='Page.javascriptDialogOpening'&&event.params?.type==='beforeunload')await send('Page.handleJavaScriptDialog',{accept:true});
  }});await page.setViewport(1440,900);await page.goto(target.href,lang);
  const wait:Wait=async expression=>{const end=Date.now()+20_000;while(Date.now()<end){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('COMMENT_ENTRY_WAIT '+expression);};
  await wait(`(${kind==='source-only'||kind==='standalone'}?!document.body.inert:document.body.dataset.ready==='true')&&!!document.querySelector('#stage-comment-list')`);
  await page.evaluate(`document.querySelector('dialog[open] .workspace-drawer-close')?.click()`);
  await page.evaluate(`(()=>{const tab=[...document.querySelectorAll('.workspace-bottom-tabs .block-row:not([hidden]) button')].find(n=>!n.hidden&&!n.disabled);tab?.click();})()`);
  await page.evaluate(`document.querySelector('#stage-comment').click()`);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));`);
  await wait(`!document.querySelector('#inspector-feedback').hidden&&getComputedStyle(document.querySelector('#inspector-feedback')).display!=='none'`);
  const live=livePublication?await openLiveVerdict(page,wait,livePublication,lang):undefined;
  const state=await page.evaluate<CommentEntryState>(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {videoDeclared:${hasVideo},language:document.documentElement.lang,top:visible(document.querySelector('#stage-comment')),panel:visible(document.querySelector('#inspector-feedback')),bottomComments:document.querySelectorAll('.workspace-bottom-tabs [data-block-target="feedback"],.workspace-bottom-tabs #workspace-tab-feedback').length,pin:document.querySelector('#rig-viewport').classList.contains('stage-comment-mode'),general:visible(document.querySelector('${generalButton}')),generalCount:document.querySelectorAll('${generalButton}').length,listRect:document.querySelector('#stage-comment-list').getBoundingClientRect().toJSON(),checkpointHidden:!visible(document.querySelector('#checkpoint-detail')),stripHidden:!visible(document.querySelector('#strip-panel')),stripBlocked:document.querySelector('#strip-export').disabled,noSourceFilesHidden:!visible(document.querySelector('#source-files')),name:document.querySelector('#stage-comment-list strong').textContent};})()`);
  if(kind==='source-only'){
   assert.equal(state.panel,true);assert.equal(state.stripHidden,false,'source-only JSON strip remains available');assert.equal(state.stripBlocked,false);
   await page.evaluate(`(()=>{document.querySelector('#strip-panel').open=true;document.getElementById('feedback-start').value='0';document.getElementById('feedback-end').value='1';document.getElementById('strip-reference').value='source-video';document.getElementById('strip-format').value='json';const native=window.fetch;window.fetch=async(...args)=>{const response=await native(...args);if(String(args[0]).endsWith('/api/strip'))window.__sourceOnlyStrip={status:response.status,body:await response.clone().json()};return response;};document.getElementById('strip-export').scrollIntoView({block:'nearest'});})()`);
   await click(page,'#strip-export');
   await wait(`!!window.__sourceOnlyStrip`);const exported=await page.evaluate<SourceOnlyExport>(`window.__sourceOnlyStrip`);
   assert.equal(exported.status,200,'native Export action reaches the source-only JSON endpoint');assert.equal(exported.body.plan.binding.packages[0]?.reviewedSource.rig,null);assert.equal(exported.body.rendering,null);
   await writeFile(join(out,'source-only-export.json'),JSON.stringify({state,exported},null,2)+'\n');await writeFile(join(out,'source-only-export.png'),await page.screenshot());observations.push({kind,lang,picture,...state,exported});return;
  }
  assert.equal(state.checkpointHidden,true,'no supplied package checkpoint exposes no checkpoint controls');if(state.stripBlocked||!hasVideo)assert.equal(state.stripHidden,true,'strip without declared video or write capability is hidden');else assert.equal(state.stripHidden,false,'declared video keeps available strip controls visible');
  assert.equal(state.language,lang);assert.equal(state.top,true);assert.equal(state.panel,true);assert.equal(state.bottomComments,0);assert.equal(state.pin,picture);assert.equal(state.name,lang==='ko'?'코멘트':'Comments');assert.ok(state.listRect.y>=0&&state.listRect.y+state.listRect.height<=900,'whole comment list visible before composition');
  const generalExpected=kind!=='standalone'&&kind!=='standalone-parts';
  assert.equal(state.general,generalExpected,kind+' general comment entry visibility');
  assert.equal(state.generalCount,Number(generalExpected),kind+' general comment entry count');
  if(live){
   const reload=async()=>{
    assert.ok(page&&sendPage);
    await page.evaluate(`window.__commentEntryBeforeReload=true`);
    await sendPage('Page.reload');
    await wait(`!window.__commentEntryBeforeReload&&${ready}&&!!document.querySelector('${generalButton}')`);
   };
   const readback=await exerciseLiveVerdict(page,wait,reload,live,lang,out);
   observations.push({kind,lang,picture,verdict,...state,readback});return;
  }
  if(state.general){await page.evaluate(`document.querySelector('[data-comment-general]').click()`);await wait(`!!document.querySelector('#stage-comment-list .stage-comment-composer input')`);}
  await writeFile(join(out,'comments.png'),await page.screenshot());
  observations.push({kind,lang,picture,...state});
 }catch(error){if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');}
}
for(const lang of languageFilter?[languageFilter]:['en','ko'] as const){
  if(sourceOnly){await run('source-only',lang);continue;}
  if(subjectFilter){
    for(const verdict of ['approved','changes-requested'] as const)await run(subjectFilter,lang,true,verdict);
    continue;
  }
  for(const kind of ['rig','parts'])for(const verdict of ['approved','changes-requested'] as const)await run(kind,lang,true,verdict);
  for(const kind of ['standalone','standalone-parts'])await run(kind,lang);
  if(Bun.argv.includes('--live-verdicts'))continue;
  for(const kind of ['direction','signoff','checkpoint','interview-picks'])await run(kind,lang);
  await run('signoff',lang,false);
  await run('source-only',lang);
}
console.log('COMMENT_ENTRY_828_OK cases='+observations.length+' sourceOnly='+sourceOnly);
