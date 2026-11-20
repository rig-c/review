/** #987 owner readbacks against the shipped page stream and the committed Create archive. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
  JOB_API_V3_SCHEMA, JOB_RECORD_READER_ID, startJobHost,
  type JobAgentRequestV3, type JobApiResponseV3, type JobPendingAskV3, type JobProgressLineV3,
} from '@rig-c/review/job-host';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {prepareBrowserRecordArchiveFixture} from './job-record-browser.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

type Language = 'en' | 'ko';
type Verb = JobAgentRequestV3['verb'];
type RequestBody = {[V in Verb]: Omit<Extract<JobAgentRequestV3, {verb: V}>, 'schema' | 'jobId' | 'requestId'>}[Verb];
type HeadlineReadback = {
  headline: string; translate: string | null; barVisible: boolean; actionVisible: boolean;
  whiteSpace: string | null; headlineElements: number;
  painting: {width: number; height: number; sameNode: boolean} | null;
  title: string; ready: boolean; editable: boolean; answered: boolean;
};

const zeroProgressHeadline = 'Nothing is waiting for your answer.';
// This literal already has a Korean catalog rendering. Agent text must keep its original bytes.
const agentText = '  Check the parts.  ';
const interview = {questionId: 'bones', setId: 'chain-bones'};
const subject = {kind: 'interview-picks', ...interview} as const;
const argument = (key: string) => {
  const index = Bun.argv.indexOf(key);
  return index < 0 ? undefined : Bun.argv[index + 1];
};

async function startFixture(scratch: string) {
  const root = join(scratch, 'record-project');
  const {projectSha, readRecordPublished} = await prepareBrowserRecordArchiveFixture(root);
  const host = await startJobHost({root, stateDir: join(scratch, 'state'), fingerprint: 'a'.repeat(64),
    reviewer: {id: 'declared-record-owner', role: 'owner'}, publicationMode: 'record-and-package',
    readRecordPublished, recordReaderId: JOB_RECORD_READER_ID});
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
  async function publish(target: 'option-set' | 'plan') {
    const result = await agent({verb: 'publish', expectedGeneration: (await next()).generation, idempotencyKey: 'publish-' + target,
      result: target === 'option-set' ? {kind: target, ...interview} : {kind: target},
      freeze: {kind: 'producer-held', holdId: 'public-archive-' + target, record: {path: 'project.json', sha256: projectSha}}});
    assert.ok(result.verb === 'publish' && result.ok);
    return result;
  }
  async function askInterview(): Promise<JobPendingAskV3> {
    const publication = await publish('option-set');
    const result = await agent({verb: 'ask', publicationId: publication.value.publicationId, subject,
      expectedGeneration: publication.generation, idempotencyKey: 'ask-interview'});
    assert.ok(result.verb === 'ask' && result.ok);
    return result.value;
  }
  async function progress(seq: number, phase: 'ingest' | 'build' | 'measure') {
    const result = await agent({verb: 'progress', seq, phase, ...(phase === 'build' ? {text: agentText, step: {i: 2, n: 3}} : {})});
    assert.ok(result.verb === 'progress' && result.ok && result.value.status === 'accepted');
    assert.equal(result.value.seq, seq);
    return result.value;
  }
  async function readAnswer(askId: string) {
    const result = await next();
    assert.ok(result.verb === 'next' && result.ok);
    return result.value.events.find(event => event.type === 'act' && event.act.askId === askId);
  }
  return {host, root, publish, agent, askInterview, progress, readAnswer};
}

const readScreen = (page: InputCdpSession, askId = '') => page.evaluate<HeadlineReadback>(`(() => {
  const headline = document.querySelector('#workspace-ask-headline');
  const form = document.querySelector(${JSON.stringify(`form[data-job-ask="${askId}"]`)});
  const painting = [...document.querySelectorAll('#stage-layout img')].find(node => node.naturalWidth && node.checkVisibility());
  const visible = selector => !!document.querySelector(selector)?.checkVisibility();
  return {headline: headline?.textContent ?? '', translate: headline?.getAttribute('translate') ?? null,
    whiteSpace: headline ? getComputedStyle(headline).whiteSpace : null, headlineElements: headline?.childElementCount ?? 0,
    barVisible: visible('#workspace-act-row') && visible('#workspace-ask-headline'),
    actionVisible: ['#workspace-pending-ask', '#save', '#request-changes'].some(visible),
    painting: painting ? {width: painting.naturalWidth, height: painting.naturalHeight, sameNode: painting === globalThis.__review987Painting} : null,
    title: document.querySelector('#package-title')?.textContent ?? '', ready: document.body.dataset.ready === 'true',
    editable: !!form?.querySelector('fieldset:not(:disabled)'),
    answered: form?.dataset.interviewAnswered === 'true' && !!form?.querySelector('fieldset:disabled')};
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
    const clickForm = async (selector: string) => {
      await page!.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block: 'center'})`);
      await click(page!, selector);
    };
    await page.setViewport(1600, 1000);
    await page.goto(owner.href);
    const firstLoad = await capture('first-load', state => state.barVisible && !state.painting && state.headline === catalog['job.waiting']);
    assert.notEqual(firstLoad.whiteSpace, 'pre-wrap');
    await fixture.progress(1, 'ingest');
    await capture('first-load-progress', state => state.barVisible && !state.painting &&
      state.headline.startsWith(catalog['job.progress.phase.ingest'] + ' · '));

    askId = (await fixture.askInterview()).askId;
    const frozen = await jobInputHashes(fixture.root);
    const form = `form[data-job-ask="${askId}"]`;
    const pending = await capture('pending', state => state.barVisible && state.ready && state.editable &&
      state.headline === catalog['Answer these questions.'] && !!state.painting);
    const names = await page.evaluate<string[]>(`[...new Set([...document.querySelectorAll(${JSON.stringify(form + ' input[type="radio"]')})].map(node => node.name))]`);
    assert.ok(names.length > 0);
    for (const name of names) await clickForm(`${form} label.interview-option:has(input[name="${name}"][value="keep"])`);
    await clickForm(form + ' button[type="submit"]');
    const act = await observe('typed interview act', () => fixture.readAnswer(askId), event => !!event);
    assert.ok(act?.type === 'act' && act.act.kind === 'interview-picks');
    assert.equal(act.act.value.questionId, interview.questionId);
    assert.equal(act.act.value.selections.length, names.length);

    const answered = (state: HeadlineReadback) => state.answered && !state.editable && !state.actionVisible &&
      !!state.painting && state.painting.width === pending.painting?.width && state.painting.height === pending.painting?.height;
    await capture('old-agent', state => answered(state) && !state.barVisible &&
      state.headline === catalog[zeroProgressHeadline] && state.translate === null);
    await page.evaluate(`globalThis.__review987Painting = [...document.querySelectorAll('#stage-layout img')]
      .find(node => node.naturalWidth && node.checkVisibility()); void 0`);
    const receipt = await fixture.progress(2, 'build');
    const step = catalog['job.progress.step'].replace('{0}', '2').replace('{1}', '3');
    const phaseAndStep = catalog['job.progress.phase.build'] + ' · ' + step;
    const prefix = phaseAndStep + ' · ' + agentText + ' · ';
    const working = (state: HeadlineReadback) => answered(state) && !!state.painting?.sameNode &&
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
    await capture('quiet', state => answered(state) && !!state.painting?.sameNode && state.barVisible && state.headline === quiet);
    assert.deepEqual(await jobInputHashes(fixture.root), frozen);

    const publication = await fixture.publish('plan');
    await capture('next-publication', state => state.ready && state.title === publication.value.label &&
      state.headline === catalog[zeroProgressHeadline] && state.translate === null && state.whiteSpace === firstLoad.whiteSpace);
    const checkpoint = await fixture.agent({verb: 'ask', publicationId: publication.value.publicationId,
      expectedGeneration: publication.generation, idempotencyKey: 'ask-checkpoint', subject: {kind: 'checkpoint', checkpointId: 'seethrough'}});
    assert.ok(checkpoint.verb === 'ask' && checkpoint.ok);
    askId = checkpoint.value.askId;
    const checkpointCaption = (state: HeadlineReadback) => state.barVisible && state.actionVisible && state.editable &&
      state.headline === catalog['Review this checkpoint.'] && state.translate === null;
    await capture('checkpoint', checkpointCaption);
    const pendingUpdate = await fixture.progress(3, 'measure');
    const witness = async (name: string, earlierRequests?: ReadonlySet<string>) => {
      const observed = await observe(name, async () => seenProgress.find(({requestId, line}) =>
        !earlierRequests?.has(requestId) && line.progress?.seq === pendingUpdate.seq &&
        line.progress.at === pendingUpdate.at && line.progress.phase === 'measure' &&
        line.progress.generation === checkpoint.generation), value => !!value);
      assert.ok(observed);
      progressReadbacks[name] = observed.line;
      await page!.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (!earlierRequests) {
        const state = await read();
        assert.ok(checkpointCaption(state), JSON.stringify(state));
      }
      await capture(name, checkpointCaption);
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
    const ask = await fixture.askInterview();
    const owner = new URL(fixture.host.ownerUrl);
    owner.searchParams.set('lang', language);
    console.log(owner.href);
    console.log('Open the owner URL, select Keep for every question, then submit the answer. The bar shows building and goes quiet after 60 seconds. Ctrl-C stops the fixture.');
    while (!stop.signal.aborted) {
      if (await fixture.readAnswer(ask.askId)) {
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
