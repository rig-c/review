/** #900 direct Bun script; ordinary Nova only. Existing synthetic scripted inputs,
 * real owner stream and independent attached publisher's local ports, as in Create.
 * No waiting UI, producer or pilot claim. Prior pure-HTTP results remain separate receipts.
 * Run: bun tests/job-first-publication-browser.ts --out artifacts/job-first-publication-900
 */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import type {JobPublication} from '../src/job-contract.ts';

const arg = (key: string) => {const i = Bun.argv.indexOf(key); return i < 0 ? undefined : Bun.argv[i + 1];};
const output = resolve(arg('--out') ?? 'artifacts/job-first-publication-900');
const language = arg('--lang') ?? 'both';
const observeWaitExpiry = Bun.argv.includes('--observe-wait-expiry');
assert.ok(['both', 'en', 'ko'].includes(language));
const languages = language === 'both' ? ['en', 'ko'] as const : [language as 'en' | 'ko'];
await mkdir(output, {recursive: true});

type Stream = {requestId: string; requestedAt: number; responseAt?: number; firstDataAt?: number;
  status?: number; bytes: number; ended: boolean; buffer: string};
async function run(lang: 'en' | 'ko', timing: 'already-published' | 'first-publication') {
  const out = join(output, timing, lang);
  await mkdir(out, {recursive: true});
  const fixture = await scriptedJobWindowFixture({c5Parts: 'mesh', attachedPublisher: true});
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
  const observe = () => ({language: lang, timing, publisher: 'independent attachment local ports', phase, cases, requests, responses, streams,
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
      !!document.querySelector('#save:not(:disabled)') &&
      document.querySelector('#save')?.textContent===${JSON.stringify(catalog['Approve'])} &&
      document.querySelector('#request-changes')?.textContent===${JSON.stringify(catalog['Request changes'])}`));
    const state = await page!.evaluate<{language: string; title: string; sourceHash: string; parts: string[];
      counts: number[]; approve: string; changes: string; pending: string}>(`(()=>({
      language:document.documentElement.lang,title:document.querySelector('#package-title').textContent,
      sourceHash:JSON.parse(document.querySelector('#provenance-full').textContent).sourceHash,
      parts:[...document.querySelectorAll('[data-part-list] button[data-slot]')].map(n=>n.dataset.slot),
      counts:['#app','.topbar','.layout','#rig-viewport','#zoom-in','#zoom-out','#fit','#native-one','#view-menu','#save','#request-changes'].map(s=>document.querySelectorAll(s).length),
      approve:document.querySelector('#save').textContent,changes:document.querySelector('#request-changes').textContent,
      pending:document.querySelector('#review-status').value
    }))()`);
    cases.push({label, state});
    assert.equal(state.language, lang);
    assert.equal(state.title, 'out', 'existing parts title uses the fixture package basename');
    assert.equal(state.sourceHash, publication.source.sourceHash);
    assert.deepEqual(state.parts.sort(), ['body', 'front']);
    assert.ok(state.counts.every(count => count === 1), 'one existing shared screen and control set');
    assert.equal(state.approve, catalog['Approve']);
    assert.equal(state.changes, catalog['Request changes']);
    assert.equal(state.pending, 'pending', 'opening does not approve');
    await writeFile(join(out, label + '.png'), await page!.screenshot());
  }
  try {
    assert.equal(fixture.host.session.status().publication, null, 'fixture starts with ZERO publications');
    assert.equal((await fixture.next()).events.filter(event => event.type === 'published').length, 0);
    let publication: JobPublication | undefined;
    let frozen: Awaited<ReturnType<typeof jobInputHashes>> | undefined;
    if (timing === 'already-published') {
      publication = await fixture.publish('parts', 'first-publication-900');
      await fixture.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
      frozen = await jobInputHashes(fixture.input.root);
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
      cases.push({label: 'zero-publications-open', document: initialDocument, stream: {...initialStream}});
      await save('RUNNING');
      const publishStartedAt = performance.now();
      publication = await fixture.publish('parts', 'first-publication-900');
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
      await fixture.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    }
    assert.ok(publication && frozen);
    await screen('opened-screen', publication);
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
    return {language: lang, timing, status: 'PASS'};
  } catch (error) {
    await save('RED', error);
    if (page) {
      await writeFile(join(out, 'failure.png'), await page.screenshot()).catch(() => {});
      await writeFile(join(out, 'failure-state.json'), await page.evaluate<string>(`JSON.stringify({
        language:document.documentElement.lang,ready:document.body.dataset.ready,text:document.body.innerText,
        app:document.querySelector('#app')?.innerHTML,marker:window.__review900Document})`)).catch(() => {});
    }
    return {language: lang, timing, status: 'RED', error: String(error)};
  } finally {
    await page?.close();
    await fixture.close();
    await rm(profile, {recursive: true, force: true});
  }
}

const results = [];
// Preserve normal-open/reload observations even when the late-publication case is RED.
for (const timing of ['already-published', 'first-publication'] as const) {
  for (const lang of languages) results.push(await run(lang, timing));
}
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
assert.equal(results.filter(result => result.status === 'RED').length, 0, JSON.stringify(results));
