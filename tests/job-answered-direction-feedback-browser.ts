import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JOB_API_SCHEMA,type JobDisplayReceipt,type JobPublication,type JobResponseValues,type JobResult} from '../src/job-contract.ts';
import {parseCommentOnlyAct,parseCommentsAct} from '../src/job-host.ts';
import {seedHistoricalVerdictAsk} from './helpers/historical-verdict-ask.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {clickPartsViewControl} from './helpers/parts-view-shots.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';

const subject={kind:'review-verdict',stage:'direction-review'} as const;
const comments='#workspace-communication #comments-list-host';
const earlierText='General comment';
const pinnedText='Keep this point · 이 위치 유지';

async function until<T>(read:()=>Promise<T|undefined>,label:string):Promise<T> {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    const value=await read();
    if(value!==undefined)return value;
    await Bun.sleep(25);
  }
  throw new Error(label);
}

async function exercise(page:InputCdpSession,language:'en'|'ko') {
  const fixture=await realJobWindowFixture();
  try {
    const root=join(fixture.input.root,'out');
    await cp(new URL('./fixtures/direction-inspection/',import.meta.url),root,{recursive:true});
    const manifestPath=join(root,'review.json');
    const manifest=await Bun.file(manifestPath).json() as {title:string;revision:string};
    const baseContext=fixture.input.getContext();
    const scope=fixture.host.session;
    const record={path:'record.json',sha256:new Bun.CryptoHasher('sha256').update(await readFile(join(fixture.input.root,'record.json'))).digest('hex')};
    const url=new URL(fixture.host.ownerUrl);
    url.searchParams.set('lang',language);

    async function request<Verb extends 'publish'|'next'>(verb:Verb,body:object):Promise<JobResponseValues[Verb]> {
      const response=await fixture.call({schema:JOB_API_SCHEMA,jobId:scope.jobId,requestId:randomUUID(),verb,
        ...(verb==='next'?{}:{expectedGeneration:scope.status().generation,idempotencyKey:randomUUID()}),...body});
      const reply=await response.json() as JobResult<JobResponseValues[Verb]>;
      assert.ok(reply.ok,JSON.stringify(reply));
      return reply.value;
    }

    async function publish(version:number,actId?:string) {
      const selector={kind:'post',version,rigVersion:1} as const;
      const context={...baseContext,selector,plan:null,subjects:[subject],
        ...(actId===undefined?{}:{answeredDirectionFeedback:[{jobId:scope.jobId,actId}]})};
      fixture.input.setContext(context);
      await writeFile(manifestPath,JSON.stringify({...manifest,revision:`post-v${version}`}));
      return request('publish',{result:{path:'out',selector},
        freeze:{kind:'producer-held',holdId:`post-${version}`,record}});
    }

    const click=(selector:string)=>page.evaluate<void>(`document.querySelector(${JSON.stringify(selector)}).click()`);
    async function openComments(version:number) {
      await until(async()=>await page.evaluate<boolean>(`document.body.dataset.ready==='true' &&
        document.querySelector('#revision')?.textContent==='post-v${version}' && document.querySelector('#send-comments')?.checkVisibility()`)
        ? true : undefined,`DIRECTION_POST_NOT_READY_${version}`);
      assert.deepEqual(await page.evaluate<boolean[]>(`['#save','#request-changes','#review-status'].map(s=>!!document.querySelector(s)?.checkVisibility())`),[false,false,false]);
      await click('#stage-comment');
      assert.equal(await page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(comments)})?.getBoundingClientRect().height`),true);
      assert.equal(await page.evaluate<string>(`document.documentElement.lang`),language);
    }

    async function saveComment(text:string) {
      await until(async()=>await page.evaluate<boolean>(`!!document.querySelector('.stage-comment-composer input')`)
        ? true : undefined,'DIRECTION_COMPOSER_NOT_OPEN');
      await page.evaluate<void>(`(()=>{
        const form=document.querySelector('.stage-comment-composer');
        form.querySelector('input').value=${JSON.stringify(text)};
        form.requestSubmit();
      })()`);
      await until(async()=>await page.evaluate<boolean>(`!document.querySelector('.stage-comment-composer')`)
        ? true : undefined,'DIRECTION_COMPOSER_NOT_SAVED');
    }

    async function sendComments(publication:JobPublication,text:string,withPin=false) {
      assert.equal(scope.status().pending.some(ask=>ask.status==='pending'),false);
      await click(`${comments} [data-comment-general]`);
      await saveComment(text);
      if(withPin){
        const point=await page.evaluate<{x:number;y:number}>(`(()=>{
          const box=document.querySelector('#rig-viewport').getBoundingClientRect();
          return {x:box.left+box.width/2,y:box.top+box.height/2};
        })()`);
        await page.mouse('mousePressed',point.x,point.y);
        await page.mouse('mouseReleased',point.x,point.y);
        await saveComment(pinnedText);
      }
      const count=withPin?2:1;
      const drafts=await readRows();
      assert.equal(drafts.draftCount,count);
      assert.equal(drafts.toolbar,language==='ko'?`코멘트 · C (${count})`:`Comment · C (${count})`);
      await until(async()=>await page.evaluate<boolean>(`!document.querySelector('#send-comments').disabled`)
        ? true : undefined,'DIRECTION_SEND_NOT_READY');
      await clickPartsViewControl(page,'#send-comments');
      const raw=await until(async()=>{
        const next=await request('next',{after:null,waitMs:0});
        return next.events.flatMap(event=>event.type==='act'&&event.act.kind==='comments'&&
          event.act.publicationId===publication.publicationId?[event.act]:[])[0];
      },'DIRECTION_COMMENTS_NOT_SUBMITTED');
      const act=parseCommentOnlyAct(raw);
      assert.equal('askId' in act,false);
      assert.deepEqual(act.value.comments.map(comment=>({text:comment.text,pinned:comment.anchor!==undefined})),
        withPin?[{text:pinnedText,pinned:true},{text,pinned:false}]:[{text,pinned:false}]);
      assert.equal(scope.status().pending.some(ask=>ask.status==='pending'),false);
      return act;
    }

    const readRows=()=>page.evaluate<{toolbar:string;draftCount:number;history:{lines:string[];controls:number}[]}>(`(()=>{
      const rows=[...document.querySelectorAll(${JSON.stringify(`${comments} .stage-comment-item`)})];
      return {
        toolbar:document.querySelector('#stage-comment').textContent,
        draftCount:rows.filter(row=>row.querySelector('button')).length,
        history:rows.filter(row=>!row.querySelector('button')).map(row=>({
          lines:[...row.children].map(child=>child.textContent),
          controls:row.querySelectorAll('a,button,input,textarea,select,[contenteditable],[tabindex]').length,
        })),
      };
    })()`);
    const empty={toolbar:language==='ko'?'코멘트 · C (0)':'Comment · C (0)',draftCount:0,history:[]};

    const first=await publish(2);
    await page.goto(url.href,language);
    await openComments(2);
    assert.deepEqual(await readRows(),empty,'DIRECTION_ANSWERED_ABSENT_INITIAL');
    const sent=await sendComments(first,earlierText,true);
    const [pin,general]=sent.value.comments;
    assert.ok(pin?.anchor&&'frameStart' in pin.anchor&&general);
    // The pre-retirement ask fixture binds to this publication. The original writer
    // stores the verdict from the pin emitted by the browser's comment-only flow.
    const ask=seedHistoricalVerdictAsk(scope,first.publicationId,subject);
    const displayed=await fixture.ui('displayed',{publicationId:first.publicationId,sourceHash:first.source.sourceHash,pageId:randomUUID()});
    const receipt=await displayed.json() as JobResult<JobDisplayReceipt>;
    assert.ok(displayed.ok&&receipt.ok,JSON.stringify(receipt));
    const historicalComments=[{text:general.text},{text:pin.text,anchor:pin.anchor}];
    const input={...receipt.value,askId:ask.askId,expectedGeneration:scope.status().generation,submissionId:randomUUID(),
      kind:'review-verdict',value:{stage:'direction-review',verdict:'changes-requested',comments:historicalComments}};
    const response=await fixture.ui('acts',input);
    const committed=await response.json() as JobResult<unknown>;
    assert.ok(response.ok&&committed.ok,JSON.stringify(committed));
    const verdict=parseCommentsAct(committed.value);
    assert.ok(verdict.kind==='review-verdict'&&verdict.value.stage==='direction-review');
    assert.equal(verdict.askId,ask.askId);
    assert.equal(verdict.value.verdict,'changes-requested');
    assert.deepEqual(verdict.value.comments,historicalComments);
    const stored=scope.readActExport(verdict.actId,false).toString();
    assert.equal(stored,JSON.stringify(committed.value));
    const retry=await fixture.ui('acts',input);
    const replayed=await retry.json() as JobResult<unknown>;
    assert.ok(retry.ok&&replayed.ok,JSON.stringify(replayed));
    assert.equal(JSON.stringify(replayed.value),stored);

    const second=await publish(3,verdict.actId);
    await openComments(3);
    const status=language==='ko'?'v3에서 답변됨':'Answered by v3';
    assert.deepEqual(await readRows(),{...empty,history:[
      {lines:[language==='ko'?'일반 코멘트 · v2':'General comment · v2',earlierText,status],controls:0},
      {lines:[language==='ko'?'스테이지 코멘트 · v2':'Stage comments · v2',pinnedText,status],controls:0},
    ]},'DIRECTION_ANSWERED_PRESENT');
    await sendComments(second,'Current draft only');

    await publish(4);
    await openComments(4);
    assert.deepEqual(await readRows(),empty,'DIRECTION_ANSWERED_ABSENT_AFTER_UPDATE');
    console.log(`DIRECTION_ANSWERED_PASS ${language}: 3 publication states, 2 comment-only sends, historical verdict readback and replay`);
  } finally {
    try { await page.goto('about:blank'); } finally { await fixture.close(); }
  }
}

const profile=await mkdtemp(join(tmpdir(),'review-answered-direction-'));
let page:InputCdpSession|undefined;
try {
  page=await launchCdpSession(profile);
  await page.setViewport(1440,900);
  for(const language of ['en','ko'] as const)await exercise(page,language);
} finally {
  await page?.close();
  await rm(profile,{recursive:true,force:true});
}
