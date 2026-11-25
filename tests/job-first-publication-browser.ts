/** #900 direct Bun script; ordinary Nova only. Existing synthetic scripted inputs,
 * real owner stream and independent attached publisher's local ports, as in Create.
 * Also covers #904: the empty shared frame fills in place, with bilingual top prompt text.
 * Synthetic fixture only; real Create/public wind rehearsal is a separate receipt.
 * Run: bun tests/job-first-publication-browser.ts --out artifacts/job-first-publication-900
 */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {expectRecordActSubmitted} from './helpers/record-act-browser-status.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_COMMENT_ONLY_ACT_SCHEMA, type JobPublication} from '../src/job-contract.ts';

const arg = (key: string) => {const i = Bun.argv.indexOf(key); return i < 0 ? undefined : Bun.argv[i + 1];};
const output = resolve(arg('--out') ?? 'artifacts/job-first-publication-904');
const language = arg('--lang') ?? 'both';
const observeWaitExpiry = Bun.argv.includes('--observe-wait-expiry');
assert.ok(['both', 'en', 'ko'].includes(language));
const languages = language === 'both' ? ['en', 'ko'] as const : [language as 'en' | 'ko'];
await mkdir(output, {recursive: true});

type Stream = {requestId: string; requestedAt: number; responseAt?: number; firstDataAt?: number;
  status?: number; bytes: number; ended: boolean; buffer: string};
async function run(lang: 'en' | 'ko', timing: 'already-published' | 'first-publication',stage:'parts'|'rig') {
  const catalog=lang==='en'?enCatalog:koCatalog;
  assert.equal(enCatalog['job.waiting'],'Waiting for a published result.');
  assert.equal(koCatalog['job.waiting'],'게시된 결과를 기다리고 있어요.');
  const out = join(output,stage,timing,lang);
  await mkdir(out, {recursive: true});
  const fixture = await scriptedJobWindowFixture({...(stage==='parts'?{c5Parts:'mesh' as const}:{}),attachedPublisher:true});
  const profile = await mkdtemp(join(tmpdir(), 'review-900-browser-'));
  let page: InputCdpSession | undefined;
  let command: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
  const requests: {at: number; requestId: string; method: string; path: string; query: string; type: unknown}[] = [];
  const responses: {at: number; requestId: string; path: string; query: string; status: number; mimeType: string}[] = [];
  const exceptions: unknown[] = [], streamEvents: unknown[] = [], diagnostics: unknown[] = [];
  const streams: Stream[] = [], documents: {id: string; loaderId: string; url: string}[] = [];
  const cases: unknown[] = [];
  let loadEvents = 0;
  let phase = 'setup';
  let latency: Record<string, unknown> | undefined;
  const observe = () => ({language: lang, timing,stage, publisher: 'independent attachment local ports', phase, cases, requests, responses, streams,
    streamEvents, exceptions, diagnostics, documents, loadEvents, latency, observeWaitExpiry});
  const save = async (status: string, error?: unknown) => writeFile(join(out, 'observations.json'),
    JSON.stringify({status, ...observe(), ...(error ? {error: String(error), stack: error instanceof Error ? error.stack : undefined} : {})}, null, 2) + '\n');
  async function wait(label: string, check: () => boolean | Promise<boolean>, deadlineAt = performance.now() + 20_000) {
    phase = label;
    await save('RUNNING');
    const remaining = deadlineAt - performance.now();
    assert.ok(remaining > 0, label + ' shared deadline exhausted');
    await withDeadline('900.' + timing + '.' + lang + '.' + label, remaining, async signal => {
      while (!signal.aborted) {
        if (await check()) {
          assert.ok(performance.now() <= deadlineAt, label + ' completed after its deadline');
          return;
        }
        await Bun.sleep(25);
      }
      throw signal.reason;
    });
  }
  function streamData(stream: Stream, data: string) {
    stream.buffer += Buffer.from(data, 'base64').toString('utf8');
    let end: number;
    while ((end = stream.buffer.indexOf('\n')) >= 0) {
      const line = stream.buffer.slice(0, end);
      stream.buffer = stream.buffer.slice(end + 1);
      if (line) {
        try {streamEvents.push({at: performance.now(), requestId: stream.requestId, event: JSON.parse(line)});}
        catch {diagnostics.push({kind: 'stream-line', line});}
      }
    }
  }
  const owner = new URL(fixture.host.ownerUrl);
  owner.searchParams.set('lang', lang);
  const eventPath = new URL(fixture.locator).pathname + '/events';
  const ready = `document.body.dataset.ready==='true' && !document.body.inert &&
    !!document.querySelector('#rig-viewport') && !!document.querySelector('[data-part-list] button')`;
  async function screen(label: string, publication: JobPublication) {
    const catalog = lang === 'en' ? enCatalog : koCatalog;
    // Attached ask completion precedes owner-stream delivery; await the actual verdict controls.
    await wait(label, () => page!.evaluate<boolean>(`(${ready}) &&
      document.querySelector('#provenance-full')?.textContent.includes(${JSON.stringify(publication.source.sourceHash)}) &&
      !!document.querySelector('#save:not(:disabled)') && document.querySelector('#save')?.checkVisibility() &&
      document.querySelector('#request-changes')?.checkVisibility() &&
      document.querySelector('#save')?.textContent===${JSON.stringify(catalog['Approve'])} &&
      document.querySelector('#request-changes')?.textContent===${JSON.stringify(catalog['Request changes'])} &&
      document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog[stage==='parts'?'Check the parts and meshes.':'Check the rig and motion.'])}`));
    const state = await page!.evaluate<{language: string; title: string; sourceHash: string; parts: string[];
      counts: number[]; approve: string; changes: string; pending: string; message: string; layoutState: string; partStatus: string}>(`(()=>({
      language:document.documentElement.lang,title:document.querySelector('#package-title').textContent,
      sourceHash:JSON.parse(document.querySelector('#provenance-full').textContent).sourceHash,
      parts:[...document.querySelectorAll('[data-part-list] button[data-slot]')].map(n=>n.dataset.slot),
      counts:['#app','.topbar','.layout','#rig-viewport','#zoom-in','#zoom-out','#fit','#native-one','#view-menu','#save','#request-changes'].map(s=>document.querySelectorAll(s).length),
      approve:document.querySelector('#save').textContent,changes:document.querySelector('#request-changes').textContent,
      pending:document.querySelector('#review-status').value,
      message:document.querySelector('#message').textContent,
      layoutState:document.querySelector('#layout-state').textContent,
      partStatus:document.querySelector('[data-part-status]').textContent
    }))()`);
    cases.push({label, state});
    assert.equal(state.language, lang);
    assert.equal(state.title,stage==='parts'?'out':'Synthetic first-publication-904','existing source title');
    assert.equal(state.sourceHash, publication.source.sourceHash);
    if(stage==='parts')assert.deepEqual(state.parts.sort(),['body','front']);else assert.ok(state.parts.includes('mesh'));
    assert.ok(state.counts.every(count => count === 1), 'one existing shared screen and control set');
    assert.equal(state.approve, catalog['Approve']);
    assert.equal(state.changes, catalog['Request changes']);
    assert.equal(state.pending, 'pending', 'opening does not approve');
    const readyMessage = catalog[stage === 'parts' ? 'Parts ready. Source files remain unchanged.' : 'Record review status and structured feedback while preserving sources. Motion is read only.'];
    assert.ok([publication.label, readyMessage].includes(state.message), 'status line shows the post-publication message');
    assert.equal(state.layoutState, catalog['Side by side']);
    assert.equal(state.partStatus, stage === 'parts' ? (lang === 'en' ? '2 parts' : '파츠 2개') : (lang === 'en' ? '1 declared slots · 1 results' : '선언된 슬롯 1개 · 결과 1개'));
    await writeFile(join(out, label + '.png'), await page!.screenshot());
  }
  try {
    assert.equal(fixture.host.session.status().publication, null, 'fixture starts with ZERO publications');
    assert.equal((await fixture.next()).events.filter(event => event.type === 'published').length, 0);
    let publication: JobPublication | undefined;
    let frozen: Awaited<ReturnType<typeof jobInputHashes>> | undefined;
    if (timing === 'already-published') {
      publication = await fixture.publish(stage, 'first-publication-904');
      await fixture.ask(publication,stage==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:'rig-review'});
      frozen = await jobInputHashes(fixture.input.root);
      assert.ok(fixture.host.session.status().publication,'positive control has an actual publication before navigation');
    }
    page = await launchCdpSession(profile, {sendDeadlineMs: 20_000, async onEvent(event, send) {
      command = send;
      const params = event.params as any;
      if (event.method === 'Runtime.exceptionThrown') exceptions.push(params);
      if (event.method === 'Page.javascriptDialogOpening') {
        diagnostics.push({kind: 'unexpected-dialog', type: params.type});
        await send('Page.handleJavaScriptDialog', {accept: false});
      }
      if (event.method === 'Page.loadEventFired') loadEvents++;
      if (event.method === 'Page.frameNavigated' && !params.frame.parentId) {
        const {id, loaderId, url} = params.frame;
        documents.push({id, loaderId, url: new URL(url).pathname});
      }
      if (event.method === 'Network.requestWillBeSent') {
        const url = new URL(params.request.url), at = performance.now(), path = url.pathname;
        requests.push({at, requestId: params.requestId, method: params.request.method, path, query: url.search, type: params.type});
        if (path === eventPath) streams.push({requestId: params.requestId, requestedAt: at, bytes: 0, ended: false, buffer: ''});
      }
      const stream = streams.find(item => item.requestId === params?.requestId);
      if (event.method === 'Network.responseReceived') {
        const response = params.response;
        const url = new URL(response.url), at = performance.now();
        responses.push({at, requestId: params.requestId, path: url.pathname, query: url.search,
          status: response.status, mimeType: response.mimeType});
        if (stream) {
          stream.responseAt = at;
          stream.status = response.status;
          // Passive CDP observation of the real NDJSON response, never a fetch/stream replacement.
          try {
            const result = await send('Network.streamResourceContent', {requestId: params.requestId}) as {bufferedData: string};
            streamData(stream, result.bufferedData);
          } catch (error) {diagnostics.push({kind: 'stream-content-unavailable', error: String(error)});}
        }
      }
      if (stream && event.method === 'Network.dataReceived') {
        stream.firstDataAt ??= performance.now();
        stream.bytes += params.dataLength;
        if (params.data) streamData(stream, params.data);
      }
      if (stream && ['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)) {
        stream.ended = true;
        diagnostics.push({at: performance.now(), kind: event.method, requestId: stream.requestId, errorText: params.errorText});
      }
    }});
    assert.ok(command, 'existing CDP event hook supplies the page sender');
    await command('Network.enable');
    await page.setViewport(1600, 1000);
    await page.goto(owner.href);
    // Bun may hold response headers until the first publication supplies a body chunk.
    await wait('stream-request-before-publication', () => streams.some(stream => !stream.ended));
    assert.equal(streams.length, 1, 'one initial open stream');
    const initialStream = streams[0]!;
    const initialDocument = documents.at(-1);
    assert.ok(initialDocument, 'initial top-level document observed');
    const initialLoads = loadEvents;
    // Document identity only; no product DOM, status text, app state or transport injection.
    await page.evaluate(`window.__review900Document=crypto.randomUUID()`);
    const marker = await page.evaluate<string>('window.__review900Document');
    if (timing === 'first-publication') {
      assert.equal(fixture.host.session.status().publication, null, 'still ZERO while page and stream are open');
      assert.equal(await page.evaluate(`!!document.querySelector('[data-part-list] button')`), false);
      await wait('waiting-frame',()=>page!.evaluate<boolean>(`document.documentElement.lang===${JSON.stringify(lang)} &&
        document.querySelector('#workspace-ask-headline')?.checkVisibility() &&
        document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog['job.waiting'])}`));
      const waiting=await page.evaluate(`(()=>{
        const selectors=['#app','.topbar','.layout','#stage-layout','.inspector','#rig-viewport','#workspace-ask-headline','#workspace-act-row'];
        window.__review904Frame=selectors.map(selector=>({selector,node:document.querySelector(selector)}));
        window.__review904GeometryNodes=window.__review904Frame.filter(({selector})=>['.topbar','.layout','#stage-layout','.inspector','#workspace-act-row'].includes(selector));
        window.__review904Rects=window.__review904GeometryNodes.map(({node})=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};});
        return {counts:selectors.map(selector=>document.querySelectorAll(selector).length),rects:window.__review904Rects,
          verdicts:['#save','#request-changes','#review-status','#workspace-pending-ask'].filter(selector=>document.querySelector(selector)?.checkVisibility()),
          prompt:document.querySelector('#workspace-ask-headline').textContent,
          message:document.querySelector('#message').textContent,
          layoutState:document.querySelector('#layout-state').textContent,
          partStatus:document.querySelector('[data-part-status]').textContent,
          loadingText:[...document.querySelectorAll('#app *')].filter(node=>node.checkVisibility()&&node.children.length===0&&/Loading|불러오는 중/.test(node.textContent??'')).map(node=>node.id||node.tagName)};
      })()` ) as {counts:number[];rects:{width:number;height:number}[];verdicts:string[];prompt:string;message:string;layoutState:string;partStatus:string;loadingText:string[]};
      assert.ok(waiting.counts.every(count=>count===1),'one existing shared frame while empty');
      assert.ok(waiting.rects.every(rect=>rect.width>0&&rect.height>0),'frame is laid out while empty');
      assert.deepEqual(waiting.verdicts,[],'no verdict or answer controls before publication');
      assert.equal(waiting.prompt,catalog['job.waiting']);
      assert.equal(waiting.message,'','status line is empty while waiting for the first publication');
      assert.equal(waiting.layoutState,'','layout readout is empty while waiting for the first publication');
      assert.equal(waiting.partStatus,'','parts status is empty while waiting for the first publication');
      assert.deepEqual(waiting.loadingText,[],'no visible loading text while waiting');
      await writeFile(join(out,'waiting.png'),await page.screenshot());
      cases.push({label: 'zero-publications-open', waiting, document: initialDocument, stream: {...initialStream}});
      await save('RUNNING');
      const publishStartedAt = performance.now();
      publication = await fixture.publish(stage, 'first-publication-904');
      const publicationReturnedAt = performance.now();
      const responseAt = fixture.publishResponseAt();
      assert.ok(responseAt !== null, 'fixture records the actual publish API response return');
      latency = {origin: 'DB commit occurs between publish call start and publication return; no exact commit timestamp',
        publishStartedAt, publicationReturnedAt, publishApiResponseReturnedAt: responseAt,
        publicationDurationMs: publicationReturnedAt - publishStartedAt, budgetMs: 5000, budgetOrigin: 'publishStartedAt'};
      frozen = await jobInputHashes(fixture.input.root);
      cases.push({label: 'actual-first-publish-returned', publication});
      await save('RUNNING');
      const mountDeadline = publishStartedAt + 5000;
      try {
        await wait('stream-response-after-publication', () => initialStream.status === 200 && !initialStream.ended, mountDeadline);
        // Both checks spend the same five seconds; no ask, reload, or reconnect repairs the page.
        await wait('first-publication-mount-without-ask', () => page!.evaluate<boolean>(ready), mountDeadline);
        latency.mountedAt = performance.now();
        latency.mountLatencyUpperBoundMs = Number(latency.mountedAt) - publishStartedAt;
        latency.mountLatencyLowerBoundMs = Number(latency.mountedAt) - publicationReturnedAt;
        assert.ok(Number(latency.mountLatencyUpperBoundMs) <= 5000, 'mount within five seconds of publish start');
        const filled=await page.evaluate(`(()=>({
          sameNodes:window.__review904Frame.every(({selector,node})=>document.querySelector(selector)===node),
          rects:window.__review904GeometryNodes.map(({node})=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};}),
          prompt:document.querySelector('#workspace-ask-headline').textContent,
          visible:document.querySelector('#workspace-ask-headline').checkVisibility(),
          message:document.querySelector('#message').textContent,
          layoutState:document.querySelector('#layout-state').textContent,
          partStatus:document.querySelector('[data-part-status]').textContent,
          sendComments:!!document.querySelector('#send-comments')?.checkVisibility()
        }))()` ) as {sameNodes:boolean;rects:unknown[];prompt:string;visible:boolean;message:string;layoutState:string;partStatus:string;sendComments:boolean};
        assert.equal(filled.sameNodes,true,'first publication fills the original shell, viewport and bottom panel nodes');
        assert.deepEqual(filled.rects,waiting.rects,'shared frame does not jump on first publication');
        // #1226 owner ruling: a published rig with no ask shows the no-ask line (Send comments); #1242: parts too.
        assert.equal(filled.prompt,catalog["We're looking at the work together. Leave your thoughts as comments."],'no fabricated ask between publication and the actual pending subject');
        assert.equal(filled.sendComments,true,'a published source with no ask offers Send comments');
        assert.ok([publication.label,catalog[stage==='parts'?'Parts ready. Source files remain unchanged.':'Record review status and structured feedback while preserving sources. Motion is read only.']].includes(filled.message));
        assert.equal(filled.layoutState,catalog['Side by side']);
        assert.equal(filled.partStatus,stage==='parts'?(lang==='en'?'2 parts':'파츠 2개'):(lang==='en'?'1 declared slots · 1 results':'선언된 슬롯 1개 · 결과 1개'));
        cases.push({label:'published-without-ask',filled});
        await writeFile(join(out,'published-without-ask.png'),await page.screenshot());
      } catch (error) {
        latency.failedAt = performance.now();
        latency.failureElapsedFromStartMs = Number(latency.failedAt) - publishStartedAt;
        latency.failureElapsedFromReturnMs = Number(latency.failedAt) - publicationReturnedAt;
        latency.originalFailure = String(error);
        await save('RED', error);
        if (observeWaitExpiry) {
          phase = 'diagnostic-original-stream-wait-expiry';
          const recovery: Record<string, unknown> = {limitMs: 40_000, limitOrigin: 'publishStartedAt', recovered: false, originalRequestId: initialStream.requestId};
          latency.recovery = recovery;
          try {
            while (performance.now() < publishStartedAt + 40_000) {
              const mounted = await page!.evaluate<boolean>(ready);
              if (mounted) {
                recovery.recovered = true;
                recovery.mountedAt = performance.now();
                recovery.mountLatencyUpperBoundMs = Number(recovery.mountedAt) - publishStartedAt;
                recovery.mountLatencyLowerBoundMs = Number(recovery.mountedAt) - publicationReturnedAt;
                break;
              }
              await Bun.sleep(25);
            }
            recovery.finishedAt = performance.now();
            recovery.streamCount = streams.length;
            recovery.originalStream = {...initialStream};
            recovery.sameDocument = await page!.evaluate('window.__review900Document') === marker;
            recovery.sameLoader = documents.at(-1)?.loaderId === initialDocument.loaderId;
            recovery.publicationRequests = requests.filter(request => request.path.startsWith(new URL(fixture.locator).pathname + '/publications/'));
          } catch (observationError) {recovery.observationError = String(observationError);}
          await save('RED', error);
        }
        throw error; // Eventual recovery never changes the original five-second RED.
      }
      assert.ok(initialStream.bytes > 0, 'actual data arrived on the already-open response');
      await fixture.ask(publication,stage==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:'rig-review'});
    }
    assert.ok(publication && frozen);
    if(timing==='first-publication'){
      await screen('just-published',publication);
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const pendingFrame=await page.evaluate<{sameNodes:boolean;rects:unknown[];originalRects:unknown[];prompt:string}>(`(()=>({
        sameNodes:window.__review904Frame.every(({selector,node})=>document.querySelector(selector)===node),
        rects:window.__review904GeometryNodes.map(({node})=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};}),
        originalRects:window.__review904Rects,prompt:document.querySelector('#workspace-ask-headline').textContent
      }))()`);
      cases.push({label:'actual-pending-frame-after-ask',pendingFrame});await save('RUNNING');
      assert.equal(pendingFrame.sameNodes,true,'actual pending prompt/verdict keeps the original shared nodes');
      assert.deepEqual(pendingFrame.rects,pendingFrame.originalRects,'actual pending prompt/verdict does not move or resize the original frame');
      await writeFile(join(out,'actual-pending-frame.png'),await page.screenshot());
    }
    await screen('opened-screen', publication);
    if(timing==='already-published')await unchangedPublishedHeight(page,out);
    assert.equal(await page.evaluate('window.__review900Document'), marker, 'publication mounted in the same document');
    assert.equal(documents.at(-1)?.loaderId, initialDocument.loaderId, 'no navigation to mount');
    assert.equal(loadEvents, initialLoads, 'no reload to mount');
    assert.equal(streams.length, 1, 'no stream reconnect to mount');
    assert.equal(initialStream.status, 200, 'original stream response succeeded');
    assert.equal(initialStream.ended, false, 'original stream remains open');
    const publicationPath = new URL(fixture.locator).pathname + '/publications/' + publication.publicationId;
    assert.ok(requests.some(request => request.method === 'GET' && request.path === publicationPath), 'real readPublication request');
    assert.ok(responses.some(response => response.path === publicationPath && response.status === 200), 'readPublication succeeded');
    const beforeReload = {loadEvents, loaderId: documents.at(-1)?.loaderId};
    await command('Page.reload', {ignoreCache: false});
    await wait('actual-reload-new-document', async () => loadEvents > beforeReload.loadEvents &&
      await page!.evaluate<boolean>(`!Object.hasOwn(window,'__review900Document') && (${ready})`));
    assert.notEqual(documents.at(-1)?.loaderId, beforeReload.loaderId, 'actual Reload replaces loader');
    await screen('reloaded-screen', publication);
    const next = await fixture.next();
    assert.equal(next.events.filter(event => event.type === 'published').length, 1, 'exactly one actual publication');
    assert.equal(next.events.filter(event => event.type === 'act').length, 0, 'open/mount/reload never submits');
    assert.equal(fixture.host.session.status().pending.length, 1, 'verdict stays pending');
    assert.deepEqual(await jobInputHashes(fixture.input.root), frozen, 'inspection leaves producer inputs unchanged');
    assert.deepEqual(exceptions, [], 'no runtime exceptions');
    await save('PASS');
    return {language: lang, timing,stage, status: 'PASS'};
  } catch (error) {
    await save('RED', error);
    if (page) {
      await writeFile(join(out, 'failure.png'), await page.screenshot()).catch(() => {});
      await writeFile(join(out, 'failure-state.json'), await page.evaluate<string>(`JSON.stringify({
        language:document.documentElement.lang,ready:document.body.dataset.ready,text:document.body.innerText,
        app:document.querySelector('#app')?.innerHTML,marker:window.__review900Document})`)).catch(() => {});
    }
    return {language: lang, timing,stage, status: 'RED', error: String(error)};
  } finally {
    await page?.close();
    await fixture.close();
    await rm(profile, {recursive: true, force: true});
  }
}



/** Positive existing-publication control: same page/prompt, one test-only CSS declaration removed then restored. */
async function unchangedPublishedHeight(page:InputCdpSession,out:string){
 await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 const sample=()=>page.evaluate<{row:{height:number};prompt:string;viewport:number[];answers:{id:string;text:string}[];barMinHeight:string;controlHeight:string}>(`(()=>{
  const row=document.querySelector('#workspace-act-row'),bar=document.querySelector('#workspace-review-act');
  const askAnswers=[...row.querySelectorAll('#save,#request-changes,#workspace-pending-ask')].filter(node=>node.checkVisibility());
  const answers=(askAnswers.length?askAnswers:[...row.querySelectorAll('#send-comments')].filter(node=>node.checkVisibility())).map(node=>({id:node.id,text:node.textContent}));
  return {row:row.getBoundingClientRect().toJSON(),prompt:document.querySelector('#workspace-ask-headline').textContent,
    viewport:[innerWidth,innerHeight],answers,
    barMinHeight:getComputedStyle(bar).minHeight,controlHeight:getComputedStyle(document.documentElement).getPropertyValue('--control-height').trim()};
 })()`);
 const finalBefore=await sample();assert.ok(finalBefore.row.height>0&&finalBefore.answers.length>0,'positive control has a visible pending publication and answer');let baseline:Awaited<ReturnType<typeof sample>>|undefined;
 try{
  console.log('ACT_ROW_BASELINE_OVERRIDE_BEGIN '+JSON.stringify({out,method:'same page; test-only min-height:initial override; no source mutation'}));
  await page.evaluate(`(()=>{const style=document.createElement('style');style.id='review904-baseline-height';style.textContent='.workspace-act-row .workspace-act-bar{min-height:initial!important}';document.head.append(style);})()`);
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);baseline=await sample();
  await writeFile(join(out,'already-published-before-minheight.png'),await page.screenshot());
 }finally{await page.evaluate(`document.getElementById('review904-baseline-height')?.remove()`);}
 await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);const final=await sample();
 await writeFile(join(out,'already-published-height-control.json'),JSON.stringify({method:'same-page controlled style override, baseline min-height:initial (old CSS default) then restored final declaration',finalBefore,baseline,final},null,2));
 assert.ok(baseline);assert.ok(['auto','0px'].includes(baseline.barMinHeight),'baseline uses the CSS initial minimum, not the new control-height minimum');assert.equal(final.barMinHeight,final.controlHeight);
 assert.equal(final.prompt,baseline.prompt);assert.deepEqual(final.viewport,baseline.viewport);assert.deepEqual(final.answers,baseline.answers);
 assert.equal(final.row.height,baseline.row.height,'STOP_AFTER_PUBLICATION_HEIGHT_CHANGED');assert.deepEqual(final,finalBefore,'final style restored without state drift');
 console.log('ACT_ROW_BASELINE_OVERRIDE_RESTORED '+JSON.stringify({out,before:baseline.row.height,after:final.row.height}));
 await writeFile(join(out,'already-published-after-minheight.png'),await page.screenshot());
}

/** Retained record routes with publication delivery held until the normal owner page is open.
 * #1229 / #1230: both plan (`checkpoint`) and `option-set` records arrive in comment mode with Send comments and zero ask forms. */
async function recordFill(lang:'en'|'ko',kind:'checkpoint'|'option-set',alreadyPublished=false){
 const out=join(output,'record',alreadyPublished?'already-published':'first-publication',kind,lang);await mkdir(out,{recursive:true});
 const fixture=await recordScreenFixture(kind,false,undefined,undefined,false,true,undefined,false,!alreadyPublished);
 const profile=await mkdtemp(join(tmpdir(),'review-904-record-'));let page:InputCdpSession|undefined;
 const catalog=lang==='en'?enCatalog:koCatalog,prompt=catalog["We're looking at the work together. Leave your thoughts as comments."];
 try{
  const frozen=await jobInputHashes(fixture.root),owner=new URL(fixture.ownerUrl);owner.searchParams.set('lang',lang);
  if(alreadyPublished)assert.ok(fixture.session.status().publication,'positive control has publication before navigation');
  page=await launchCdpSession(profile);await page.setViewport(1600,1000);await page.goto(owner.href);
  if(!alreadyPublished){
  await withDeadline('904.record.waiting',20000,async signal=>{while(!signal.aborted){
   if(await page!.evaluate(`document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog['job.waiting'])}`))return;
   await Bun.sleep(25);
  }throw signal.reason;});
  assert.equal(await page.evaluate(`['#save','#request-changes','#workspace-pending-ask'].some(selector=>document.querySelector(selector)?.checkVisibility())`),false);
  assert.deepEqual(await page.evaluate(`['#message','#layout-state','[data-part-status]'].map(s=>document.querySelector(s)?.textContent)`),['','','']);
  await page.evaluate(`window.__review904RecordFrame=['.topbar','.layout','#stage-layout','#rig-viewport','.inspector','#workspace-act-row'].map(selector=>({selector,node:document.querySelector(selector)}));window.__review904RecordFrameNodes=window.__review904RecordFrame;window.__review904RecordGeometryNodes=window.__review904RecordFrame.filter(({selector})=>selector!=='#rig-viewport');window.__review904RecordRects=window.__review904RecordGeometryNodes.map(({node})=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};})`);
  await writeFile(join(out,'waiting.png'),await page.screenshot());
  if(kind==='checkpoint')fixture.fake.publish(fixture.display);else fixture.deliver();
  }else assert.ok(fixture.session.status().publication,'positive control starts with an actual retained publication');
  const filledReady=`document.body.dataset.ready==='true'&&document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(prompt)}&&!document.querySelector('form[data-job-ask]')&&!document.querySelector('#workspace-interview-answer')&&!document.querySelector('[id="job-record-asks"]')&&!!document.querySelector('#send-comments')?.checkVisibility()&&!!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')`;
  await withDeadline('904.record.filled',20000,async signal=>{while(!signal.aborted){
   if(await page!.evaluate(filledReady))return;
   await Bun.sleep(25);
  }throw signal.reason;});
  if(kind==='option-set'){
   await withDeadline('904.record.question-image',5000,async signal=>{while(!signal.aborted){
    if(await page!.evaluate<boolean>(`document.querySelector('#reference-content img')?.naturalWidth===2&&!document.querySelector('#reference-pane').hidden`))return;
    await Bun.sleep(25);
   }throw signal.reason;});
  }
  assert.equal(await page.evaluate(`document.querySelector('#message')?.textContent`),
   catalog[kind==='option-set'?'Not submitted':'This request has no picture.']);
  assert.equal(await page.evaluate(`document.querySelector('[data-part-status]')?.textContent`),catalog['No compiled rig catalog available']);
  if(!alreadyPublished){
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const frame=await page.evaluate<{sameNodes:boolean;rects:unknown[];originalRects:unknown[]}>(`(()=>({
      sameNodes:window.__review904RecordFrame.every(({selector,node})=>node===document.querySelector(selector)),
      rects:window.__review904RecordGeometryNodes.map(({node})=>{const {x,y,width,height}=node.getBoundingClientRect();return {x,y,width,height};}),
      originalRects:window.__review904RecordRects
    }))()`);
    await writeFile(join(out,'actual-pending-frame.json'),JSON.stringify(frame,null,2));
    assert.equal(frame.sameNodes,true);
    // #1041/#1228: the record opens the right communication panel (Comments on option-set, Checkpoint on checkpoint) and
    // its controller-less bottom panel collapses, so only the stage and bottom move. Topbar, layout and act row keep the
    // original frame; the stage keeps its origin and does not lose height.
    type Rect={x:number;y:number;width:number;height:number};const now=frame.rects as Rect[],was=frame.originalRects as Rect[];
    assert.deepEqual([now[0],now[1],now[4]],[was[0],was[1],was[4]],'record actual pending prompt keeps the original shared chrome');
    assert.deepEqual([now[2]!.x,now[2]!.y],[was[2]!.x,was[2]!.y],'stage keeps its origin');
    assert.ok(now[2]!.height>=was[2]!.height,'the collapsed bottom panel gives the stage its height');
  }else await unchangedPublishedHeight(page,out);
  assert.equal(await page.evaluate(`['#save','#request-changes'].some(selector=>document.querySelector(selector)?.checkVisibility())`),false);
  await writeFile(join(out,'just-published.png'),await page.screenshot());
  assert.equal(fixture.submissions.length,0);assert.deepEqual(await jobInputHashes(fixture.root),frozen);
  await writeFile(join(out,'observations.json'),JSON.stringify({status:'PASS',lang,kind,prompt,delivery:'retained record publication through existing fixture stream',submissions:0},null,2));
  return {language:lang,kind,alreadyPublished,status:'PASS'};
 }catch(error){
  await writeFile(join(out,'observations.json'),JSON.stringify({status:'RED',lang,kind,error:String(error)},null,2));
  if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});
  return {language:lang,kind,alreadyPublished,status:'RED',error:String(error)};
 }finally{await page?.close();await fixture.close();await rm(profile,{recursive:true,force:true});}
}

/** #1225 owner verification: if a producer still sends a picks ask, the server refuses by name (JOB_ASK_INVALID), an
 * option-set record page keeps its picture and comments working without mounting a form, and a package page carrying a
 * legacy pending picks ask shows JOB_ASK_UNSUPPORTED while keeping the rig picture and comments working. */
async function legacyPicksAskRefusal(lang:'en'|'ko'){
 const out=join(output,'legacy-picks-ask',lang);await mkdir(out,{recursive:true});
 const recordFixture=await recordScreenFixture('interview-picks',false);
 const pkgFixture=await scriptedJobWindowFixture();
 const profile=await mkdtemp(join(tmpdir(),'review-1225-picks-'));
 let page:InputCdpSession|undefined;
 const exceptions:unknown[]=[],catalog=lang==='en'?enCatalog:koCatalog;
 try{
  const frozenRecord=await jobInputHashes(recordFixture.root);
  const askRes=await fetch(`${recordFixture.origin}/jobs/${recordFixture.session.jobId}/api`,{
   method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+recordFixture.agentToken},
   body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:recordFixture.session.jobId,requestId:'legacy-picks-ask',verb:'ask',
    expectedGeneration:recordFixture.session.status().generation,idempotencyKey:'legacy-picks-ask',
    publicationId:recordFixture.display.publication.publicationId,subject:{kind:'interview-picks',questionId:'rig_type',setId:'set_rig_type_01'}}),
  });
  const askBody=await askRes.json() as {ok:boolean;error?:{code:string}};
  assert.equal(askRes.status,409);
  assert.equal(askBody.ok,false);
  assert.equal(askBody.error?.code,'JOB_ASK_INVALID');

  const publication=await pkgFixture.publish('rig','1225-legacy-picks');
  const frozenPkg=await jobInputHashes(pkgFixture.input.root);
  const pkgAskRes=await pkgFixture.call({schema:JOB_API_SCHEMA,jobId:pkgFixture.host.session.jobId,requestId:'legacy-pkg-picks',verb:'ask',
   expectedGeneration:pkgFixture.host.session.status().generation,idempotencyKey:'legacy-pkg-picks',
   publicationId:publication.publicationId,subject:{kind:'interview-picks',questionId:'rig_type',setId:'set_rig_type_01'}});
  const pkgAskBody=await pkgAskRes.json() as {ok:boolean;error?:{code:string}};
  assert.equal(pkgAskRes.status,409);
  assert.equal(pkgAskBody.error?.code,'JOB_ASK_INVALID');
  // Seed a pre-refusal pending picks ask on the package publication so the browser exercises the unsupported-ask screen path too.
  const internal=pkgFixture.host.session as unknown as {store:{update(id:string,rev:null,op:(c:{data:any})=>{data:any}):void};event(d:unknown,v:unknown):void;notify():void};
  internal.store.update(pkgFixture.host.session.jobId,null,current=>{
   const data=current.data,retained=data.publications[publication.publicationId].retained;
   data.generation++;
   const ask={askId:'legacy-pkg-picks-ask',publicationId:publication.publicationId,status:'pending',
    subject:{kind:'interview-picks',questionId:'rig_type',setId:'set_rig_type_01'},
    source:{...structuredClone(retained.source),optionSet:{id:'set_rig_type_01',sha256:'8'.repeat(64)}}};
   data.asks[ask.askId]=ask;
   internal.event(data,{type:'pending',ask});
   return {data};
  });
  internal.notify();

  page=await launchCdpSession(profile,{onEvent(event){if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);}});
  await page.setViewport(1600,1000);
  const pkgUrl=new URL(pkgFixture.host.ownerUrl);pkgUrl.searchParams.set('lang',lang);
  await page.goto(pkgUrl.href,lang);
  await withDeadline('1225.picks.pkg-refusal',20000,async signal=>{while(!signal.aborted){
   if(await page!.evaluate<boolean>(`document.body.dataset.ready==='true'&&!document.body.inert&&
     document.getElementById('review-message')?.getAttribute('title')==='JOB_ASK_UNSUPPORTED'&&
     !!document.querySelector('#rig-root canvas')&&
     !document.querySelector('#workspace-interview-answer')&&!document.querySelector('form.interview-answer')`))return;
   await Bun.sleep(25);
  }throw signal.reason;});
  const refusalState=await page.evaluate<{title:string;text:string;error:boolean;sendVisible:boolean}>(`(()=>{
   const m=document.getElementById('review-message'),s=document.getElementById('send-comments');
   return {title:m.getAttribute('title')??'',text:m.textContent.trim(),error:m.classList.contains('error'),sendVisible:!!s?.checkVisibility()};
  })()`);
  assert.deepEqual(refusalState,{title:'JOB_ASK_UNSUPPORTED',text:catalog['job.refusal.JOB_ASK_UNSUPPORTED'],error:true,sendVisible:true});
  await writeFile(join(out,'legacy-pkg-picks-refusal.png'),await page.screenshot());

  // Also verify the option-set record page renders the picture and submits comments cleanly with zero forms.
  await page.goto('about:blank');
  const recordUrl=new URL(recordFixture.ownerUrl);recordUrl.searchParams.set('lang',lang);
  await page.goto(recordUrl.href,lang);
  await withDeadline('1225.picks.record-ready',20000,async signal=>{while(!signal.aborted){
   if(await page!.evaluate<boolean>(`document.body.dataset.ready==='true'&&!document.body.inert&&
     document.querySelector('#reference-content img')?.naturalWidth===2&&
     !!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')&&
     !document.querySelector('#workspace-interview-answer')&&!document.querySelector('form.interview-answer')`))return;
   await Bun.sleep(25);
  }throw signal.reason;});
  await page.evaluate<void>(`document.querySelector('[data-comment-general]').scrollIntoView({block:'nearest'})`);
  await click(page,'[data-comment-general]');
  await withDeadline('1225.picks.composer',5000,async signal=>{while(!signal.aborted){
   if(await page!.evaluate<boolean>(`!!document.querySelector('.stage-comment-composer input')`))return;
   await Bun.sleep(25);
  }throw signal.reason;});
  await page.evaluate<void>(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value='Legacy picks fallback comment';form.requestSubmit();})()`);
  await withDeadline('1225.picks.comment-saved',5000,async signal=>{while(!signal.aborted){
   if(await page!.evaluate<boolean>(`!document.querySelector('.stage-comment-composer')&&!document.getElementById('send-comments').disabled`))return;
   await Bun.sleep(25);
  }throw signal.reason;});
  await click(page,'#send-comments');
  await expectRecordActSubmitted(page,expression=>withDeadline('1225.picks.submitted',10000,async signal=>{while(!signal.aborted){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw signal.reason;}),lang,'1225 comments submitted');
  assert.equal(recordFixture.submissions.length,1);
  assert.equal(recordFixture.submissions[0]?.kind,'comments');
  const committedAct=JSON.parse(await Bun.file(recordFixture.files[0]!).text());
  assert.equal(committedAct.schema,JOB_COMMENT_ONLY_ACT_SCHEMA);
  assert.deepEqual(await jobInputHashes(recordFixture.root),frozenRecord);
  assert.deepEqual(await jobInputHashes(pkgFixture.input.root),frozenPkg);
  assert.deepEqual(exceptions,[]);
  await writeFile(join(out,'legacy-picks-commented.png'),await page.screenshot());
  await writeFile(join(out,'observations.json'),JSON.stringify({status:'PASS',lang,apiRefusal:askBody.error?.code,pkgApiRefusal:pkgAskBody.error?.code,screenRefusal:refusalState.title,actSchema:committedAct.schema},null,2));
  return {language:lang,timing:'legacy-picks-ask',status:'PASS'};
 }catch(error){
  await writeFile(join(out,'observations.json'),JSON.stringify({status:'RED',lang,error:String(error),exceptions},null,2));
  if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});
  return {language:lang,timing:'legacy-picks-ask',status:'RED',error:String(error)};
 }finally{await page?.close();await recordFixture.close();await pkgFixture.close();await rm(profile,{recursive:true,force:true});}
}


/** Refuse one real displayed-ack response, then retry through a later publication on the same stream. */
async function ackRetry(lang:'en'|'ko'){
 const out=join(output,'ack-retry',lang);await mkdir(out,{recursive:true});
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh',attachedPublisher:true});
 const profile=await mkdtemp(join(tmpdir(),'review-904-retry-')),catalog=lang==='en'?enCatalog:koCatalog;
 let page:InputCdpSession|undefined,send:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 let refused=false,ackRequests=0;const exceptions:unknown[]=[];
 const wait=async(label:string,condition:()=>Promise<boolean>)=>withDeadline('904.retry.'+label,20000,async signal=>{
  while(!signal.aborted){if(await condition())return;await Bun.sleep(25);}throw signal.reason;
 });
 try{
  page=await launchCdpSession(profile,{async onEvent(event,command){
   send=command;if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);
   if(event.method!=='Fetch.requestPaused')return;
   const request=event.params as {requestId:string;request:{url:string}};
   ackRequests++;
   if(!refused){refused=true;await command('Fetch.fulfillRequest',{requestId:request.requestId,responseCode:409,
    responseHeaders:[{name:'Content-Type',value:'application/json'}],
    body:Buffer.from(JSON.stringify({ok:false,error:{code:'JOB_DISPLAY_MISMATCH',message:'planted displayed ack failure'}})).toString('base64')});}
   else await command('Fetch.continueRequest',{requestId:request.requestId});
  }});
  assert.ok(send);await send('Fetch.enable',{patterns:[{urlPattern:'*/ui/displayed',requestStage:'Request'}]});
  await page.setViewport(1600,1000);const owner=new URL(fixture.host.ownerUrl);owner.searchParams.set('lang',lang);await page.goto(owner.href);
  await wait('initial waiting',()=>page!.evaluate(`document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog['job.waiting'])}`));
  assert.deepEqual(await page.evaluate(`['#message','#layout-state','[data-part-status]'].map(s=>document.querySelector(s)?.textContent)`),['','','']);
  await page.evaluate(`window.__review904RetryDocument=crypto.randomUUID()`);const documentId=await page.evaluate('window.__review904RetryDocument');
  await fixture.publish('parts','failed-ack-904');
  await wait('ack rollback rearmed',async()=>refused&&await page!.evaluate(`!document.body.dataset.ready&&document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog['job.waiting'])}`));
  assert.equal(await page.evaluate(`['#save','#request-changes'].some(selector=>document.querySelector(selector)?.checkVisibility())`),false);
  assert.deepEqual(await page.evaluate(`['#message','#layout-state','[data-part-status]'].map(s=>document.querySelector(s)?.textContent)`),['','','']);
  await writeFile(join(out,'waiting-after-failed-ack.png'),await page.screenshot());
  const publication=await fixture.publish('parts','retry-904');await fixture.ask(publication,{kind:'parts-verdict',draftId:'synthetic-parts'});
  const frozen=await jobInputHashes(fixture.input.root);
  await wait('retry ready',()=>page!.evaluate(`document.body.dataset.ready==='true'&&document.querySelector('#save:not(:disabled)')?.checkVisibility()&&document.querySelector('#workspace-ask-headline')?.textContent===${JSON.stringify(catalog['Check the parts and meshes.'])}`));
  assert.ok([publication.label,catalog['Parts ready. Source files remain unchanged.']].includes(await page.evaluate(`document.querySelector('#message')?.textContent`)));
  assert.equal(await page.evaluate(`document.querySelector('#layout-state')?.textContent`),catalog['Side by side']);
  assert.equal(await page.evaluate(`document.querySelector('[data-part-status]')?.textContent`),lang==='en'?'2 parts':'파츠 2개');
  assert.ok(ackRequests>=2);assert.equal(await page.evaluate('window.__review904RetryDocument'),documentId);
  assert.equal(await page.evaluate(`JSON.parse(document.querySelector('#provenance-full').textContent).sourceHash`),publication.source.sourceHash);
  assert.equal((await fixture.next()).events.some(event=>event.type==='act'),false);
  assert.deepEqual(await jobInputHashes(fixture.input.root),frozen);assert.deepEqual(exceptions,[]);
  await writeFile(join(out,'retry-filled.png'),await page.screenshot());
  await writeFile(join(out,'observations.json'),JSON.stringify({status:'PASS',lang,ackRequests,refused,retry:publication.publicationId},null,2));
  return {language:lang,timing:'ack-retry',status:'PASS'};
 }catch(error){
  await writeFile(join(out,'observations.json'),JSON.stringify({status:'RED',lang,ackRequests,refused,error:String(error),exceptions},null,2));
  if(page)await writeFile(join(out,'failure.png'),await page.screenshot()).catch(()=>{});
  return {language:lang,timing:'ack-retry',status:'RED',error:String(error)};
 }finally{await page?.close();await fixture.close();await rm(profile,{recursive:true,force:true});}
}

const results = [];
// Preserve normal-open/reload observations even when the late-publication case is RED.
for (const timing of ['already-published', 'first-publication'] as const) {
  for(const stage of ['parts','rig'] as const)for(const lang of languages)results.push(await run(lang,timing,stage));
}
for(const lang of languages)results.push(await ackRetry(lang));
for(const kind of ['checkpoint','option-set'] as const)for(const lang of languages)results.push(await recordFill(lang,kind));
for(const lang of languages)results.push(await recordFill(lang,'option-set',true));
for(const lang of languages)results.push(await legacyPicksAskRefusal(lang));
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
assert.equal(results.filter(result => result.status === 'RED').length, 0, JSON.stringify(results));
