/** #987 owner readbacks against the shipped page stream, the #929 sealed scene option-set picture (#1230 comment mode) and a pending rig review-verdict ask (#1229). */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {cp, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  JOB_API_V3_SCHEMA, JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_RECORD_READER_ID, startJobHost,
  type JobAgentRequestV3, type JobApiResponseV3, type JobProgressLineV3,
} from '@rig-c/review/job-host';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {createSyntheticOptionRecordWorkspace, createSyntheticRecordReader} from './helpers/job-record-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

type Language = 'en' | 'ko';
type Verb = JobAgentRequestV3['verb'];
type RequestBody = {[V in Verb]: Omit<Extract<JobAgentRequestV3, {verb: V}>, 'schema' | 'jobId' | 'requestId'>}[Verb];
type HeadlineReadback = {
  headline: string; translate: string | null; barVisible: boolean; actionVisible: boolean; sendCommentsVisible: boolean;
  whiteSpace: string | null; headlineElements: number;
  painting: {path: string; width: number; height: number; sameNode: boolean} | null;
  title: string; ready: boolean; sameWorkspace: boolean; editable: boolean;
};

const noAskHeadline = "We're looking at the work together. Leave your thoughts as comments.";
// This literal already has a Korean catalog rendering. Agent text must keep its original bytes.
const agentText = '  Check the parts.  ';
const interview = {questionId: 'post_timing', setId: 'post-picture'};
const argument = (key: string) => {
  const index = Bun.argv.indexOf(key);
  return index < 0 ? undefined : Bun.argv[index + 1];
};

async function startFixture(scratch: string) {
  const root = join(scratch, 'record-project');
  await mkdir(root, {recursive: true});
  const workspace = createSyntheticOptionRecordWorkspace(root, {...interview, postPicture: 'scene'});
  const optionContext = {...workspace.context, subjects: [] as const};
  const packageSelector = {kind: 'rig' as const, version: 1};
  const {reader: readRecordPublished} = createSyntheticRecordReader({
    onOption: () => optionContext,
  });
  const host = await startJobHost({root, stateDir: join(scratch, 'state'), fingerprint: 'a'.repeat(64),
    reviewer: {id: 'declared-record-owner', role: 'owner'}, publicationMode: 'record-and-package',
    readRecordPublished, recordReaderId: JOB_RECORD_READER_ID,
    readPublished: async () => ({selector: packageSelector, plan: null, parts: null, subjects: [], partIds: [], files: []}),
    readerId: 'synthetic-progress-package-reader'});
  const {jobId} = host.session, token = host.session.hostCredentials().agent;
  async function agent(input: RequestBody): Promise<JobApiResponseV3> {
    const response = await fetch(`${host.origin}/jobs/${jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
      body: JSON.stringify({schema: JOB_API_V3_SCHEMA, jobId, requestId: randomUUID(), ...input}),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as JobApiResponseV3;
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.verb, input.verb);
    return result;
  }
  const next = () => agent({verb: 'next', after: null, waitMs: 0});
  async function publishInterview(round: number) {
    const result = await agent({verb: 'publish', expectedGeneration: (await next()).generation, idempotencyKey: 'publish-' + round,
      result: workspace.result, freeze: {kind: 'producer-held', holdId: 'pictured-round-' + round, record: workspace.record}});
    assert.ok(result.verb === 'publish' && result.ok);
    return result;
  }
  async function publishRig() {
    await cp(new URL('./fixtures/viewport-387/package', import.meta.url), join(root, 'out'), {recursive: true});
    const result = await agent({verb: 'publish', expectedGeneration: (await next()).generation, idempotencyKey: 'publish-rig',
      result: {kind: 'package', path: 'out', selector: packageSelector},
      freeze: {kind: 'producer-held', holdId: 'rig-round', record: workspace.record}});
    assert.ok(result.verb === 'publish' && result.ok);
    return result;
  }
  async function askRigVerdict(publication: Awaited<ReturnType<typeof publishRig>>) {
    const {publicationId} = publication.value;
    const result = await agent({verb: 'ask', publicationId, subject: {kind: 'review-verdict', stage: 'rig-review'},
      expectedGeneration: publication.generation, idempotencyKey: 'ask-' + publicationId});
    assert.ok(result.verb === 'ask' && result.ok);
    return result;
  }
  async function progress(seq: number, phase: 'ingest' | 'build' | 'measure') {
    const result = await agent({verb: 'progress', seq, phase, ...(phase === 'build' ? {text: agentText, step: {i: 2, n: 3}} : {})});
    assert.ok(result.verb === 'progress' && result.ok && result.value.status === 'accepted');
    assert.equal(result.value.seq, seq);
    return result.value;
  }
  async function readCommentAct(publicationId: string) {
    const result = await next();
    assert.ok(result.verb === 'next' && result.ok);
    return result.value.events.find(event => event.type === 'act' && event.act.publicationId === publicationId && event.act.kind === 'comments');
  }
  return {host, root, publishInterview, publishRig, askRigVerdict, progress, readCommentAct};
}

const readScreen = (page: InputCdpSession, askId = '') => page.evaluate<HeadlineReadback>(`(() => {
  const headline = document.querySelector('#workspace-ask-headline');
  const form = document.querySelector(${JSON.stringify(`form[data-job-ask="${askId}"]`)});
  const image = document.querySelector('#reference-content img');
  const painting = image?.naturalWidth && image.checkVisibility() ? image : null;
  const visible = selector => !!document.querySelector(selector)?.checkVisibility();
  return {headline: headline?.textContent ?? '', translate: headline?.getAttribute('translate') ?? null,
    whiteSpace: headline ? getComputedStyle(headline).whiteSpace : null, headlineElements: headline?.childElementCount ?? 0,
    barVisible: visible('#workspace-act-row') && visible('#workspace-ask-headline'),
    actionVisible: ['#workspace-pending-ask', '#save', '#request-changes'].some(visible),
    sendCommentsVisible: visible('#send-comments'),
    painting: painting ? {path: new URL(painting.currentSrc).pathname, width: painting.naturalWidth, height: painting.naturalHeight,
      sameNode: painting === globalThis.__review987Painting} : null,
    title: document.querySelector('#package-title')?.textContent ?? '', ready: document.body.dataset.ready === 'true',
    sameWorkspace: document.getElementById('app') === globalThis.__review987App,
    editable: !!form?.querySelector('fieldset:not(:disabled)')};
})()`);

async function observe<T>(label: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  return withDeadline(label, 20_000, async signal => {
    let value: T;
    do {
      value = await read();
      if (matches(value)) return value;
      await Bun.sleep(30);
    } while (!signal.aborted);
    throw new Error(label + ' ' + JSON.stringify(value));
  });
}

async function runBrowser(language: Language, output: string, scratch: string) {
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  const fixture = await startFixture(scratch);
  const owner = new URL(fixture.host.ownerUrl);
  owner.searchParams.set('lang', language);
  const eventPath = new URL('events', owner).pathname;
  const readbacks: Record<string, HeadlineReadback> = {};
  const progressReadbacks: Record<string, JobProgressLineV3> = {};
  const seenProgress: {requestId: string; line: JobProgressLineV3}[] = [];
  const streams = new Map<string, {feed(data: string): void; buffered: string[] | null}>();
  let page: InputCdpSession | undefined;
  let command: ((method: string) => Promise<unknown>) | undefined;
  let askId = '';
  try {
    page = await launchCdpSession(join(scratch, 'chrome'), {async onEvent({method, params, sessionId}, send) {
      if (sessionId) command = send;
      const requestId = params?.requestId;
      if (typeof requestId !== 'string') return;
      if (method === 'Network.responseReceived') {
        const response = params?.response as {url: string};
        if (new URL(response.url).pathname !== eventPath) return;
        const decoder = new TextDecoder();
        let partial = '';
        const buffered: string[] = [];
        const stream: NonNullable<ReturnType<typeof streams.get>> = {
          buffered,
          feed(data) {
            const rows = (partial + decoder.decode(Buffer.from(data, 'base64'), {stream: true})).split('\n');
            partial = rows.pop()!;
            for (const row of rows) {
              const line = JSON.parse(row) as {type: string};
              if (line.type === 'progress') seenProgress.push({requestId, line: line as JobProgressLineV3});
            }
          },
        };
        streams.set(requestId, stream);
        const {bufferedData} = await send('Network.streamResourceContent', {requestId}) as {bufferedData: string};
        stream.feed(bufferedData);
        for (const data of buffered) stream.feed(data);
        stream.buffered = null;
      } else if (method === 'Network.dataReceived' && typeof params?.data === 'string') {
        const stream = streams.get(requestId);
        if (stream?.buffered) stream.buffered.push(params.data);
        else stream?.feed(params.data);
      }
    }});
    assert.ok(command);
    await command('Network.enable');
    const read = () => readScreen(page!, askId);
    const capture = async (name: string, predicate: (value: HeadlineReadback) => boolean) => {
      const result = await observe(name, read, predicate);
      readbacks[name] = result;
      await writeFile(join(output, name + '.png'), await page!.screenshot());
      return result;
    };
    await page.setViewport(1600, 1000);
    await page.goto(owner.href);
    const firstLoad = await capture('first-load', state => state.barVisible && !state.painting && state.headline === catalog['job.waiting']);
    assert.notEqual(firstLoad.whiteSpace, 'pre-wrap');
    await fixture.progress(1, 'ingest');
    await capture('first-load-progress', state => state.barVisible && !state.painting &&
      state.headline.startsWith(catalog['job.progress.phase.ingest'] + ' · '));

    const firstPublication = await fixture.publishInterview(1);
    const frozen = await jobInputHashes(fixture.root);
    const optionPainted = (state: HeadlineReadback, publicationId: string) => state.barVisible && state.ready && !state.actionVisible &&
      state.sendCommentsVisible && state.painting?.width === 2 && state.painting.height === 2 &&
      state.painting.path.includes('/publications/' + publicationId + '/') && state.painting.path.includes('/api/interview/image/');
    const initialOption = await capture('option-open', state => optionPainted(state, firstPublication.value.publicationId) &&
      state.headline === catalog[noAskHeadline] && state.translate === null);
    await click(page, '[data-comment-general]');
    await observe('general composer', () => page!.evaluate<boolean>(`!!document.querySelector('.stage-comment-composer input')`), Boolean);
    await page.evaluate(`(() => {
      const form = document.querySelector('.stage-comment-composer');
      form.querySelector('input').value = 'Progress check comment';
      form.requestSubmit();
    })()`);
    await observe('general saved', () => page!.evaluate<boolean>(`!document.querySelector('.stage-comment-composer') && !document.getElementById('send-comments').disabled`), Boolean);
    await click(page, '#send-comments');
    const act = await observe('comment-only act', () => fixture.readCommentAct(firstPublication.value.publicationId), event => !!event);
    assert.ok(act?.type === 'act' && act.act.schema === JOB_COMMENT_ONLY_ACT_SCHEMA && act.act.kind === 'comments');
    assert.deepEqual(act.act.value.comments.map(row => row.text), ['Progress check comment']);

    const steady = (state: HeadlineReadback) => !state.actionVisible && state.sendCommentsVisible &&
      !!state.painting && state.painting.path === initialOption.painting?.path &&
      state.painting.width === initialOption.painting?.width && state.painting.height === initialOption.painting?.height;
    await capture('old-agent', state => steady(state) && state.barVisible &&
      state.headline === catalog[noAskHeadline] && state.translate === null);
    await page.evaluate(`globalThis.__review987Painting = document.querySelector('#reference-content img');
      globalThis.__review987App = document.getElementById('app'); void 0`);
    const receipt = await fixture.progress(2, 'build');
    const step = catalog['job.progress.step'].replace('{0}', '2').replace('{1}', '3');
    const phaseAndStep = catalog['job.progress.phase.build'] + ' · ' + step;
    const prefix = phaseAndStep + ' · ' + agentText + ' · ';
    const working = (state: HeadlineReadback) => steady(state) && !!state.painting?.sameNode &&
      state.barVisible && state.translate === 'no' && state.headline.startsWith(prefix) &&
      state.whiteSpace === 'pre-wrap' && state.headlineElements === 0;
    await capture('working', working);
    const secondsPattern = new RegExp('^' + catalog['job.progress.seconds'].replace('{0}', '[1-9][0-9]*') + '$');
    await capture('working-ticked', state => working(state) && secondsPattern.test(state.headline.slice(prefix.length)));
    await page.evaluate(`{
      const elapsed = Date.now() - ${Date.parse(receipt.at)};
      const clock = Date.now.bind(Date);
      Date.now = () => clock() + (60_000 - elapsed);
    }`);
    const quiet = catalog['job.progress.quiet'].replace('{0}', '1').replace('{1}', phaseAndStep);
    await capture('quiet', state => steady(state) && !!state.painting?.sameNode && state.barVisible && state.headline === quiet);
    assert.deepEqual(await jobInputHashes(fixture.root), frozen);

    const publication = await fixture.publishInterview(2);
    assert.notEqual(publication.value.publicationId, firstPublication.value.publicationId);
    await capture('next-publication', state => state.ready && !state.sameWorkspace && state.title === publication.value.label &&
      state.headline === catalog[noAskHeadline] && state.sendCommentsVisible && state.translate === null && state.whiteSpace === firstLoad.whiteSpace);

    const rigPublication = await fixture.publishRig();
    const secondAsk = await fixture.askRigVerdict(rigPublication);
    askId = secondAsk.value.askId;
    const pendingCaption = (state: HeadlineReadback) => state.barVisible && state.ready && state.actionVisible &&
      state.headline === catalog['Check the rig and motion.'] && state.translate === null;
    await capture('second-pending', pendingCaption);
    const pendingUpdate = await fixture.progress(3, 'measure');
    const witness = async (name: string, earlierRequests?: ReadonlySet<string>) => {
      const observed = await observe(name, async () => seenProgress.find(({requestId, line}) =>
        !earlierRequests?.has(requestId) && line.progress?.seq === pendingUpdate.seq &&
        line.progress.at === pendingUpdate.at && line.progress.phase === 'measure' &&
        line.progress.generation === secondAsk.generation), value => !!value);
      assert.ok(observed);
      progressReadbacks[name] = observed.line;
      await page!.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (!earlierRequests) {
        const state = await read();
        assert.ok(pendingCaption(state), JSON.stringify(state));
      }
      await capture(name, pendingCaption);
    };
    await witness('pending-beats-live-progress');
    const earlierRequests = new Set(streams.keys());
    await page.goto('about:blank');
    await page.goto(owner.href);
    await witness('pending-beats-replayed-progress', earlierRequests);
    await writeFile(join(output, 'observations.json'), JSON.stringify({status: 'PASS', language, actId: act.act.actId, readbacks, progressReadbacks}, null, 2) + '\n');
  } catch (error) {
    await writeFile(join(output, 'observations.json'), JSON.stringify({status: 'RED', language, readbacks, progressReadbacks, error: String(error)}, null, 2) + '\n');
    if (page) await page.screenshot().then(bytes => writeFile(join(output, 'failure.png'), bytes)).catch(() => {});
    throw error;
  } finally {
    try {await page?.close();} finally {fixture.host.stop();}
  }
}

async function serveOwner(language: Language, scratch: string) {
  const fixture = await startFixture(scratch);
  const stop = new AbortController();
  const stopOwner = () => stop.abort();
  process.once('SIGINT', stopOwner);
  process.once('SIGTERM', stopOwner);
  try {
    const pub = await fixture.publishInterview(1);
    const owner = new URL(fixture.host.ownerUrl);
    owner.searchParams.set('lang', language);
    console.log(owner.href);
    console.log('Open the owner URL, add a general comment and click Send comments. The bar shows building and goes quiet after 60 seconds. Ctrl-C stops the fixture.');
    while (!stop.signal.aborted) {
      if (await fixture.readCommentAct(pub.value.publicationId)) {
        await fixture.progress(1, 'build');
        break;
      }
      await Bun.sleep(250);
    }
    if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), {once: true}));
  } finally {
    process.off('SIGINT', stopOwner);
    process.off('SIGTERM', stopOwner);
    fixture.host.stop();
  }
}

if (import.meta.main) {
  const language = argument('--lang');
  assert.ok(language === undefined || language === 'en' || language === 'ko');
  const output = resolve(argument('--out') ?? 'artifacts/job-progress-987');
  const manual = Bun.argv.includes('--serve');
  const languages: readonly Language[] = language ? [language] : manual ? ['en'] : ['en', 'ko'];
  const failures: unknown[] = [];
  for (const lang of languages) {
    const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-987-'));
    try {
      if (manual) await serveOwner(lang, scratch);
      else {
        const out = join(output, lang);
        await mkdir(out, {recursive: true});
        await runBrowser(lang, out, scratch);
      }
    } catch (error) {
      if (manual) throw error;
      console.error(lang, error);
      failures.push(error);
    } finally {await rm(scratch, {recursive: true, force: true});}
  }
  if (failures.length) throw new AggregateError(failures, 'Job progress browser checks failed');
}
