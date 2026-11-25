/** #828 and #831 ordinary Nova browser coverage using synthetic fixtures. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile,readFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {commentFixture} from './helpers/parts-comments-package.ts';
import {parseCommentsAct,parseContextCommentsAct,projectComments} from '../src/job-host.ts';
import {JOB_COMMENT_CONTEXT_ACT_SCHEMA,JOB_COMMENTS_ACT_SCHEMA,type JobCommentsAct,type JobContextCommentsAct,type JobDisplayReceipt,type JobPendingAsk,type JobPublication,type JobResult} from '../src/job-contract.ts';
import {parseStageComment} from '../src/stage-comment.ts';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {jobSourceDraftId} from '../web/job-session.ts';
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
const towerCheck=readFilter('--tower-check',['parts-message','closed-draft'] as const);
const sourceOnly=Bun.argv.includes('--source-only');
if(sourceOnly&&(subjectFilter||towerCheck))throw new Error('--source-only cannot be combined with --subject or --tower-check');
if(towerCheck==='parts-message'&&subjectFilter==='rig')throw new Error('--tower-check parts-message requires the Parts subject');
const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/comment-entry-828':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];
type Language = 'en' | 'ko';
type Verdict = 'approved' | 'changes-requested';
type Wait = (expression:string)=>Promise<void>;
type PageCommand = (method:string,params?:Record<string,unknown>)=>Promise<unknown>;
type MainFrame = {id:string;loaderId:string};
type ReloadPage = {sessionId:string;send:PageCommand;frame:MainFrame;loads:number;beforeUnload:number;lost?:string};
type Capture = (name:string)=>Promise<void>;
type Reload = (expected?:string,reportName?:string)=>Promise<void>;
type LivePublication = {kind:'rig'|'parts';fixture:Awaited<ReturnType<typeof scriptedJobWindowFixture>>;
  publication:JobPublication;verdict:Verdict};
type LiveVerdict = LivePublication & {ask:JobPendingAsk;otherAsk:JobPendingAsk};
type CommentEntryState = {videoDeclared:boolean;language:string;top:boolean;panel:boolean;bottomComments:number;pin:boolean;
  general:boolean;generalCount:number;listRect:{y:number;height:number};checkpointHidden:boolean;stripHidden:boolean;
  stripBlocked:boolean;noSourceFilesHidden:boolean;name:string};
type DecisionControls = {approve:{label:string;disabled:boolean};changes:{label:string;disabled:boolean;title:string;aria:string|null}};
type DecisionNotice = {text:string;visible:boolean;inViewport:boolean;unclipped:boolean;footerText:string;
  bounds:{left:number;top:number;right:number;bottom:number;width:number;height:number}|null;
  clientSize:[number,number]|null;scrollSize:[number,number]|null};
type GeneralDraftRow = {id:string;summary:string};
type SourceOnlyExport = {status:number;body:{plan:{binding:{packages:{reviewedSource:{rig:unknown}}[]}};rendering:unknown}};

const generalButton = '[data-comment-general]';
const composer = '.stage-comment-composer';
const summary = '#stage-comment-list .stage-comment-summary';
const ready = `document.body.dataset.ready==='true'&&!document.body.inert`;
const generalEntryVisible = `!!document.querySelector('${generalButton}')?.checkVisibility()`;

async function openLiveVerdict(page:InputCdpSession,wait:Wait,live:LivePublication,lang:Language):Promise<LiveVerdict> {
  const {kind,fixture,publication}=live;
  await wait(`${ready}&&document.querySelector('#save')?.hidden===true`);
  // #1226 owner ruling: "Add general comment" is available with no ask on a live rig; parts still waits for its verdict ask.
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),kind==='rig','a published source alone offers general comments on a rig only');
  await page.evaluate(`window.__commentEntryBeforeAsk=true`);

  // #1227: checkpoint until #1229 retires record asks
  const otherAsk=await fixture.ask(publication,{kind:'checkpoint',checkpointId:'step-one'});
  const catalog=lang==='ko'?koCatalog:enCatalog;
  const otherPrompt=catalog['Review this checkpoint.'];
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

async function readDecisionNotice(page:InputCdpSession) {
  return page.evaluate<DecisionNotice>(`(()=>{
    const notice=document.querySelector('#workspace-act-row #review-message');
    const rect=notice?.getBoundingClientRect();
    return {text:notice?.innerText.trim()??'',visible:!!notice?.checkVisibility({visibilityProperty:true,opacityProperty:true}),
      inViewport:!!rect&&rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,
      unclipped:!!notice&&notice.scrollWidth<=notice.clientWidth+1&&notice.scrollHeight<=notice.clientHeight+1,
      bounds:rect?.toJSON()??null,clientSize:notice?[notice.clientWidth,notice.clientHeight]:null,
      scrollSize:notice?[notice.scrollWidth,notice.scrollHeight]:null,
      footerText:document.querySelector('#message')?.innerText.trim()??''};
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

async function readFinalVerdict(live:LiveVerdict,expectContext=false):Promise<JobCommentsAct|JobContextCommentsAct> {
  const {fixture,ask,publication,kind,verdict}=live;
  const end=Date.now()+20_000;
  while(Date.now()<end){
    const events=(await fixture.next()).events.flatMap(event=>event.type==='act'&&event.act.askId===ask.askId?[event.act]:[]);
    assert.ok(events.length<=1,'one explicit verdict produces at most one act');
    if(events.length){
      const eventAct=events[0]!;
      assert.equal(eventAct.schema,expectContext?JOB_COMMENT_CONTEXT_ACT_SCHEMA:JOB_COMMENTS_ACT_SCHEMA,
        `${kind} ${verdict}: unexpected verdict schema`);
      const act=expectContext?parseContextCommentsAct(eventAct):parseCommentsAct(eventAct);
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

async function exerciseLiveVerdict(page:InputCdpSession,wait:Wait,reload:Reload,capture:Capture,live:LiveVerdict,lang:Language,out:string) {
  const {kind,verdict,fixture,ask,otherAsk}=live,ko=lang==='ko';
  const general=[ko?'수정한 일반 의견':'Edited general comment',ko?'두 번째 일반 의견':'Second general comment'];
  const generalLabel=ko?'일반 코멘트':'General comment';
  const pinRequired=ko?'수정 요청에는 파츠에 고정한 코멘트가 하나 이상 필요해요.':'Request changes needs at least one comment pinned to a part.';
  const initial=await readDecisions(page);
  assert.equal(initial.approve.label,ko?'승인':'Approve');
  assert.equal(initial.changes.label,ko?'수정 요청':'Request changes');
  assert.equal(initial.changes.disabled,true);
  assert.equal(initial.changes.title,kind==='rig'
    ? (ko?'바꿀 곳에 코멘트나 편집을 남겨 주세요.':'Add a comment or an edit where changes are needed.')
    : (ko?'고칠 곳에 코멘트를 달아 주세요':'Add a comment where changes are needed.'));
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
  const noticePath=join(out,'parts-request-changes-notice.json');
  const notices:Partial<Record<'beforeReload'|'afterReload'|'afterPin',DecisionNotice>>={};
  const checkPinNotice=async(phase:'beforeReload'|'afterReload')=>{
    const notice=notices[phase]=await readDecisionNotice(page);
    await writeFile(noticePath,JSON.stringify(notices,null,2)+'\n');
    assert.equal(notice.text,pinRequired,'the pin requirement is displayed beside the decision controls '+phase);
    assert.ok(notice.visible&&notice.inViewport&&notice.unclipped,JSON.stringify(notice));
  };
  if(kind==='parts')await checkPinNotice('beforeReload');
  await capture('general-before-reload');

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
    await checkPinNotice('afterReload');
    await capture('parts-pin-required');
    await page.evaluate(`document.querySelector('#request-changes').click()`);
    assert.equal((await fixture.next()).events.some(event=>event.type==='act'&&event.act.askId===ask.askId),false,'Parts Request changes without a pin creates no act');
    assert.ok(fixture.host.session.status().pending.some(pending=>pending.askId===ask.askId));
  }else assert.equal(restored.changes.disabled,false);

  const pinned=verdict==='changes-requested';
  const pinText=kind==='parts'?(ko?'수정한 파츠 핀':'Edited Parts pin'):(ko?'리그에 고정한 의견':'Pinned rig comment');
  if(pinned&&kind==='parts'){
    const original=ko?'처음 파츠 핀':'Original Parts pin';
    await addPartsPin(page,wait,original);
    const afterPinNotice=notices.afterPin=await readDecisionNotice(page);
    await writeFile(noticePath,JSON.stringify(notices,null,2)+'\n');
    assert.ok(!afterPinNotice.text.includes(pinRequired),'the pin requirement clears when the first pin is saved');
    const pinRow=await page.evaluate<string|undefined>(`[...document.querySelectorAll('${summary}')]
      .find(node=>node.textContent.endsWith(${JSON.stringify(original)}))?.closest('[data-comment-id]')?.dataset.commentId`);
    assert.ok(pinRow,'the saved pin has its own comment row');
    await clickComment(page,`[data-comment-id=${JSON.stringify(pinRow)}] .stage-comment-summary`);
    await saveComment(page,wait,pinText);
    const controls=await readDecisions(page);
    assert.equal(controls.approve.disabled,true);
    assert.equal(controls.changes.disabled,false);
  }else if(pinned){
    await wait(`!!document.querySelector('#rig-root canvas')&&document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`);
    await click(page,'#rig-viewport');
    await wait(`!!document.querySelector('${composer} input')`);
    assert.equal(await page.evaluate<boolean>(`document.activeElement===document.querySelector('${composer} input')`),true,
      '1062_COMPOSER_FOCUS: a rig-view pin composer focuses its text field when it opens');
    await saveComment(page,wait,pinText);
  }
  if(pinned)await wait(`document.querySelectorAll('#rig-viewport .stage-comment-pin').length===1`);
  await capture('comments');
  await click(page,verdict==='approved'?'#save':'#request-changes');
  const act=await readFinalVerdict(live,pinned&&kind==='rig');
  await wait(`document.querySelector('#save')?.hidden===true`);
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false,'general verdict entry disappears when only the non-verdict ask remains');
  assert.ok(fixture.host.session.status().pending.some(pending=>pending.askId===otherAsk.askId));
  const comments=act.value.comments;
  assert.deepEqual(comments.slice(pinned?1:0),general.map(text=>({text})));
  if(pinned){
    const anchor=comments[0]?.anchor;
    assert.equal(comments[0]?.text,pinText);
    if(kind==='parts'){
      assert.ok(anchor&&'schema' in anchor&&anchor.schema==='rig-review-parts-comment/2');
      assert.equal(anchor.sourceHash,act.source.sourceHash);
    }else{
      assert.ok(anchor&&'target' in anchor&&anchor.context);
      const mark=parseStageComment((anchor.context as {comment?:unknown}).comment);
      assert.equal(mark.viewport,'rig');
      assert.equal(mark.sourceHash,act.source.sourceHash);
      assert.ok('model' in act.source&&act.source.model);
      assert.equal(mark.modelHash,act.source.model.sha256);
      assert.equal(act.schema,JOB_COMMENT_CONTEXT_ACT_SCHEMA);
      const context=act.value.comments[0]?.context;
      assert.deepEqual(context?.subject,{ask:ask.subject,sourceHash:act.source.sourceHash,selector:act.source.selector});
      assert.equal(context?.mode,mark.mode);
      assert.deepEqual(context?.region,mark.world);
    }
  }
  const signedComments=comments.map(({text,anchor})=>({text,...anchor===undefined?{}:{anchor}}));
  const projected=projectComments(signedComments);
  const generalProjection='[general]\n'+general.join('\n\n[general]\n');
  assert.equal(projected,pinned?projectComments(signedComments.slice(0,1))+'\n\n'+generalProjection:generalProjection);
  const readback={initial,restored,notices,rows:expectedRows,act,projected};
  await writeFile(join(out,'verdict.json'),JSON.stringify(readback,null,2)+'\n');
  return readback;
}

/** Finalize via a separate client's real display receipt and UI act port. Only the observed page owns the draft. */
async function finalizeElsewhere(live:LiveVerdict) {
  const {fixture,publication,ask,kind}=live;
  const displayed=await fixture.ui('displayed',{pageId:randomUUID(),publicationId:publication.publicationId,sourceHash:publication.source.sourceHash});
  const ack=await displayed.json() as JobResult<JobDisplayReceipt>;
  assert.ok(displayed.ok&&ack.ok,JSON.stringify(ack));
  const payload=kind==='parts'?
    {kind:'parts-verdict',value:{verdict:'approved',words:'',issues:[]}}:
    {kind:'review-verdict',value:{stage:'rig-review',verdict:'approved',words:''},capture:rigStillCapture(publication,ask,ack.value).capture};
  const response=await fixture.ui('acts',{...ack.value,askId:ask.askId,submissionId:randomUUID(),
    expectedGeneration:fixture.host.session.status().generation,...payload});
  const committed=await response.json() as JobResult<unknown>;
  assert.ok(response.ok&&committed.ok,JSON.stringify(committed));
  const act=await readFinalVerdict(live);
  assert.deepEqual(parseCommentsAct(committed.value),act);
  assert.deepEqual(act.value.comments,[],'the other client did not submit this page’s draft');
  return {pageId:ack.value.pageId,act};
}

async function exerciseClosedDraft(page:InputCdpSession,wait:Wait,reload:Reload,capture:Capture,live:LiveVerdict,lang:Language,out:string) {
  const {fixture,publication,ask,otherAsk}=live;
  const scope=`rig-review-verdict-comments/1:${fixture.host.session.jobId}:${jobSourceDraftId(publication.source)}:${publication.source.sourceHash}`;
  const readDraft=()=>page.evaluate<GeneralDraftRow[]|null>(`JSON.parse(localStorage.getItem(${JSON.stringify(scope)}))?.comments??null`);
  const rowIds=()=>page.evaluate<string[]>(`[...document.querySelectorAll('#stage-comment-list [data-comment-id]')].map(row=>row.dataset.commentId)`);
  const text=lang==='ko'?['남겨 둘 초안','지울 초안']:['Draft to keep','Draft to delete'];
  for(const comment of text){
    await clickComment(page,generalButton);
    await saveComment(page,wait,comment);
  }
  const draft=await readDraft();
  assert.ok(draft,'the browser saved a publication-scoped draft before the verdict');
  assert.deepEqual(draft.map(row=>row.summary),text);
  const [keep,remove]=draft;
  assert.ok(keep&&remove&&keep.id!==remove.id);
  assert.deepEqual(await rowIds(),[keep.id,remove.id]);
  const rowSelector=`[data-comment-id=${JSON.stringify(remove.id)}] .stage-comment-summary`;
  const catalog=lang==='ko'?koCatalog:enCatalog;
  const closed=`document.querySelector('#save')?.hidden===true&&document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog['Review this checkpoint.'])}`;

  const elsewhere=await finalizeElsewhere(live);
  await wait(closed);
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false,'finalization in another client removes Add in the open page');
  await reload(closed,'reload-finalized');
  await click(page,'#stage-comment');
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false,'closed verdict still offers no Add after reload');
  assert.deepEqual(await rowIds(),[keep.id,remove.id],'closed verdict does not hide locally saved draft rows');
  assert.deepEqual(await readDraft(),draft);

  await clickComment(page,rowSelector);
  const editor=await page.evaluate<{readOnly:boolean;value:string;canDelete:boolean}|null>(`(()=>{
    const form=document.querySelector('${composer}'),field=form?.querySelector('input'),remove=form?.querySelector('.stage-comment-delete');
    return field?{readOnly:field.readOnly,value:field.value,canDelete:!!remove&&!remove.disabled&&remove.checkVisibility()}:null;
  })()`);
  await writeFile(join(out,'closed-draft.json'),JSON.stringify({elsewhere,draft,editor},null,2)+'\n');
  assert.deepEqual(editor,{readOnly:true,value:remove.summary,canDelete:true},'a closed verdict draft can be inspected and deleted');
  await capture('closed-draft-readonly');
  await page.evaluate(`(()=>{const form=document.querySelector('${composer}');form.querySelector('input').value='attempted edit';form.requestSubmit();})()`);
  assert.deepEqual(await readDraft(),draft,'the read-only composer cannot overwrite a saved draft');
  assert.deepEqual(await rowIds(),[keep.id,remove.id]);

  // Reopen the original row before using Delete so the forced submit above cannot supply its value.
  await clickComment(page,rowSelector);
  await clickComment(page,`${composer} .stage-comment-delete`);
  assert.deepEqual(await rowIds(),[keep.id]);
  assert.deepEqual(await readDraft(),[keep],'Delete persists the other draft row only');
  await reload(closed,'reload-deleted');
  await click(page,'#stage-comment');
  assert.equal(await page.evaluate<boolean>(generalEntryVisible),false);
  const afterReload=await readDraft();
  assert.deepEqual(afterReload,[keep]);
  assert.deepEqual(await rowIds(),[keep.id],'the deleted draft row stays gone after reload');
  assert.deepEqual(await readFinalVerdict(live),elsewhere.act,'local cleanup never changes the committed verdict');
  assert.ok(fixture.host.session.status().pending.some(pending=>pending.askId===otherAsk.askId&&pending.askId!==ask.askId));
  const readback={elsewhere,draft,editor,afterReload};
  await writeFile(join(out,'closed-draft.json'),JSON.stringify(readback,null,2)+'\n');
  return readback;
}

async function run(kind:string,lang:Language,picture=true,verdict:Verdict='approved',closedDraft=false){
 const profile=await mkdtemp(join(tmpdir(),'review828-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 let livePublication:LivePublication|undefined,cdp:ReloadPage|undefined;
 let phase='open';
 const out=join(output,kind+(picture?'':'-empty')+(closedDraft?'-finalized-elsewhere':verdict==='approved'?'':'-changes'),lang);await mkdir(out,{recursive:true});
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
   if(event.method==='Page.frameNavigated'&&event.sessionId){
    const frame=event.params?.frame as (MainFrame&{parentId?:string})|undefined;
    if(frame?.id&&frame.loaderId&&!frame.parentId&&(!cdp||cdp.sessionId===event.sessionId)){
     if(cdp)cdp.frame={id:frame.id,loaderId:frame.loaderId};
     else cdp={sessionId:event.sessionId,send,frame:{id:frame.id,loaderId:frame.loaderId},loads:0,beforeUnload:0};
    }
   }
   if(!cdp)return;
   if(event.method==='Target.detachedFromTarget'&&event.params?.sessionId===cdp.sessionId)cdp.lost=event.method;
   if(event.sessionId!==cdp.sessionId)return;
   if(event.method==='Page.loadEventFired')cdp.loads++;
   if(event.method==='Inspector.targetCrashed'||event.method==='Inspector.detached')cdp.lost=event.method;
   if(event.method==='Page.javascriptDialogOpening'&&event.params?.type==='beforeunload'){
    cdp.beforeUnload++;
    await send('Page.handleJavaScriptDialog',{accept:true});
   }
  }});await page.setViewport(1440,900);await page.goto(target.href,lang);
  const wait:Wait=async expression=>{const end=Date.now()+20_000;while(Date.now()<end){assert.equal(cdp?.lost,undefined,'CDP page session remains attached');if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('COMMENT_ENTRY_WAIT '+expression);};
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
  assert.equal(state.language,lang);assert.equal(state.top,true);assert.equal(state.panel,true);assert.equal(state.bottomComments,0);
  if(kind==='interview-picks'){
   await wait(`document.querySelector('#reference-pane')?.checkVisibility()&&document.querySelector('#reference-content img')?.naturalWidth>0&&
    !!document.querySelector('#view-menu [data-view^="interview-image-"][aria-pressed="true"]')`);
  }
  // #986 keeps the question painting visible in Comments. #1068: over a retained backdrop the sealed question image
  // takes pins like any other picture, so pin mode follows the backdrop for every kind.
  assert.equal(state.pin,!!picture,kind+' stage pin mode');assert.equal(state.name,lang==='ko'?'코멘트':'Comments');assert.ok(state.listRect.y>=0&&state.listRect.y+state.listRect.height<=900,'whole comment list visible before composition');
  const generalExpected=kind!=='standalone'&&kind!=='standalone-parts';
  assert.equal(state.general,generalExpected,kind+' general comment entry visibility');
  assert.equal(state.generalCount,Number(generalExpected),kind+' general comment entry count');
  if(live){
   const reload:Reload=async(expected=`!!document.querySelector('${generalButton}')`,reportName='reload')=>{
    assert.ok(page&&cdp,'initial top-level CDP session and loader');
    const active=cdp,before={frame:active.frame,loads:active.loads,beforeUnload:active.beforeUnload};
    phase='reload';
    await page.evaluate(`window.__commentEntryBeforeReload=true`);
    await active.send('Page.reload',{ignoreCache:false});
    const deadline=Date.now()+20_000;
    while(active.loads===before.loads||active.frame.loaderId===before.frame.loaderId){
     assert.equal(active.lost,undefined,'reload keeps the CDP page session attached');
     assert.ok(Date.now()<deadline,'COMMENT_ENTRY_RELOAD_LOAD_EVENT_OR_LOADER');
     await Bun.sleep(25);
    }
    assert.equal(active.frame.id,before.frame.id,'reload stays in the original top-level frame');
    await wait(`!Object.hasOwn(window,'__commentEntryBeforeReload')&&document.readyState==='complete'&&${ready}&&(${expected})`);
    phase='activate-reloaded-page';
    await active.send('Page.bringToFront');
    const document=await page.evaluate<{visibility:string;focused:boolean;origin:string;path:string;lang:string}>(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({visibility:document.visibilityState,focused:document.hasFocus(),origin:location.origin,path:location.pathname,lang:document.documentElement.lang}))))`);
    assert.equal(document.visibility,'visible');
    assert.equal(document.origin,target.origin);
    assert.equal(document.path,target.pathname);
    assert.equal(document.lang,lang);
    await writeFile(join(out,reportName+'.json'),JSON.stringify({sessionId:active.sessionId,before,
      after:{frame:active.frame,loads:active.loads,beforeUnload:active.beforeUnload},document},null,2)+'\n');
    phase='verify-restored-comments';
   };
   const capture:Capture=async name=>{
    phase='capture-'+name;
    await writeFile(join(out,name+'.png'),await page!.screenshot());
    phase=name==='comments'?'submit-verdict':'before-reload';
   };
   const readback=closedDraft?await exerciseClosedDraft(page,wait,reload,capture,live,lang,out):
    await exerciseLiveVerdict(page,wait,reload,capture,live,lang,out);
   observations.push({kind,lang,picture,verdict,closedDraft,...state,readback});return;
  }
  if(state.general){await page.evaluate(`document.querySelector('[data-comment-general]').click()`);await wait(`!!document.querySelector('#stage-comment-list .stage-comment-composer input')`);}
  await writeFile(join(out,'comments.png'),await page.screenshot());
  observations.push({kind,lang,picture,...state});
 }catch(error){
  const failure={phase,error:error instanceof Error?error.message:String(error),cdp};
  await writeFile(join(out,'failure.json'),JSON.stringify(failure,null,2)+'\n').catch(()=>{});
  if(page&&!phase.startsWith('capture-')&&!cdp?.lost&&!failure.error.includes('Not attached to an active page')){
   await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});
  }
  throw error;
 }
 finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');}
}
for(const lang of languageFilter?[languageFilter]:['en','ko'] as const){
  if(sourceOnly){await run('source-only',lang);continue;}
  if(towerCheck==='parts-message'){await run('parts',lang,true,'changes-requested');continue;}
  for(const kind of subjectFilter?[subjectFilter]:['rig','parts'] as const){
    if(!towerCheck)for(const verdict of ['approved','changes-requested'] as const)await run(kind,lang,true,verdict);
    await run(kind,lang,true,'approved',true);
  }
  if(subjectFilter||towerCheck)continue;
  for(const kind of ['standalone','standalone-parts'])await run(kind,lang);
  if(Bun.argv.includes('--live-verdicts'))continue;
  for(const kind of ['direction','signoff','checkpoint','interview-picks'])await run(kind,lang);
  await run('signoff',lang,false);
  await run('source-only',lang);
}
console.log('COMMENT_ENTRY_828_OK cases='+observations.length+' sourceOnly='+sourceOnly);
