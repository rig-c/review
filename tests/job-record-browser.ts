/** Ordinary Nova browser verification for model-free record mode (job-api@3 / act@4) and package normal-entry regression. Run with --lang en or --lang ko. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOB_ACT_SCHEMA,
  JOB_API_SCHEMA,
  JOB_API_V3_SCHEMA,
  JOB_RECORD_ACT_SCHEMA,
  JOB_RECORD_READER_ID,
  parseRecordAct,
  startJobHost,
  type JobApiResponseV3,
  type JobEventV3,
  type JobOptionContext,
  type JobPendingAskV3,
  type JobPlanContext,
  type JobPublicationV3,
  type JobRecordAct,
  type JobRecordPartsIdentity,
  type JobRecordPublicationReader,
  type JobRecordReaderInput,
} from '@rig-c/review/job-host';
import { enCatalog } from '../web/catalog-en.ts';
import { koCatalog } from '../web/catalog-ko.ts';
import { jobFixture, jobInputHashes } from './helpers/job-api-fixture.ts';
import { launchCdpSession, type InputCdpSession } from './parts-explorer-browser.ts';

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface BrowserRecordArchiveFixture {
  readonly projectSha: string;
  readonly closureFiles: { path: string; sha256: string }[];
  readonly planSteps: { id: string; hash: string }[];
  readonly readerPhases: { phase: string; kind: string; root: string }[];
  readonly readRecordPublished: JobRecordPublicationReader;
}

export async function prepareBrowserRecordArchiveFixture(recordRoot: string): Promise<BrowserRecordArchiveFixture> {
  await mkdir(recordRoot, { recursive: true });
  const archivePath = new URL('./fixtures/create-pre-rig/2-rigging-answers.tar.gz', import.meta.url).pathname;
  const sidecarPath = new URL('./fixtures/create-pre-rig/2-rigging-answers.json', import.meta.url).pathname;
  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
    project_sha256: string;
    files: { path: string; sha256: string }[];
  };
  const tarProc = Bun.spawnSync(['tar', '-xzf', archivePath, '-C', recordRoot]);
  assert.equal(tarProc.exitCode, 0, tarProc.stderr.toString());

  const projectBytes = await readFile(join(recordRoot, 'project.json'));
  const projectSha = sha256(projectBytes);
  assert.equal(projectSha, sidecar.project_sha256);
  const projectDoc = JSON.parse(projectBytes.toString('utf8')) as {
    inputs: { path: string; sha256: string }[];
    plan: { steps: { id: string }[] };
  };

  const closureFiles = [
    ...sidecar.files.filter(
      f => !f.path.startsWith('derived/') && !f.path.startsWith('outputs/') && f.path !== 'project.json',
    ),
    { path: 'project.json', sha256: projectSha },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.equal(
    new Set(closureFiles.map(f => f.path)).size,
    closureFiles.length,
    'closureFiles inventory must be duplicate-free',
  );

  const planSteps = projectDoc.plan.steps.map((step, index) => ({
    id: step.id,
    hash: sha256(`synthetic-step-${index}-${step.id}`),
  }));

  // Explicit synthetic archive-backed reader double (distinct from official installed Create reader/consumer conformance).
  const syntheticPartsIdentity: JobRecordPartsIdentity = {
    name: '@rig-c/parts',
    version: '2.35.0',
    integrity: `sha256-${sha256('synthetic-archive-reader-double-parts')}`,
  };

  const readerPhases: { phase: string; kind: string; root: string }[] = [];
  const readRecordPublished: JobRecordPublicationReader = (async (input: JobRecordReaderInput) => {
    readerPhases.push({ phase: input.phase, kind: input.result.kind, root: input.root });
    if (input.result.kind === 'option-set') {
      const optionContext: JobOptionContext = {
        label: 'Synthetic archive rigging interview · bones',
        parts: input.phase === 'retained' ? (input.parts ?? syntheticPartsIdentity) : syntheticPartsIdentity,
        inputs: projectDoc.inputs.map(({ path, sha256: h }) => ({ path, sha256: h })),
        files: closureFiles,
        plan: null,
        subjects: [{ kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' }],
      };
      return optionContext;
    }
    const planContext: JobPlanContext = {
      label: 'Synthetic archive rigging interview · plan',
      parts: input.phase === 'retained' ? (input.parts ?? syntheticPartsIdentity) : syntheticPartsIdentity,
      inputs: projectDoc.inputs.map(({ path, sha256: h }) => ({ path, sha256: h })),
      files: closureFiles,
      plan: { steps: planSteps },
      subjects: [
        { kind: 'checkpoint', checkpointId: 'seethrough' },
        { kind: 'signoff', stage: 'rigging-interview' },
        { kind: 'reopen', stage: 'plan-approved' },
      ],
    };
    return planContext;
  }) as JobRecordPublicationReader;

  return {
    projectSha,
    closureFiles,
    planSteps,
    readerPhases,
    readRecordPublished,
  };
}

export async function runRecordBrowserPreflightSetupCheck(): Promise<void> {
  const preflightScratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-job-record-preflight-'));
  const preflightRoot = join(preflightScratch, 'record-project');
  const preflightState = join(preflightScratch, 'record-state');
  const { projectSha, readRecordPublished } = await prepareBrowserRecordArchiveFixture(preflightRoot);
  let host: Awaited<ReturnType<typeof startJobHost>> | undefined;
  try {
    host = await startJobHost({
      root: preflightRoot,
      stateDir: preflightState,
      fingerprint: 'b'.repeat(64),
      reviewer: { id: 'declared-record-owner', role: 'owner' },
      publicationMode: 'record-and-package',
      readRecordPublished,
      recordReaderId: JOB_RECORD_READER_ID,
    });
    const token = host.session.hostCredentials().agent;
    const call = async (body: Record<string, unknown>): Promise<JobApiResponseV3> => {
      const res = await fetch(`${host!.origin}/jobs/${host!.session.jobId}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          schema: JOB_API_V3_SCHEMA,
          jobId: host!.session.jobId,
          requestId: randomUUID(),
          ...body,
        }),
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as JobApiResponseV3;
      assert.equal(json.schema, JOB_API_V3_SCHEMA);
      assert.equal(json.ok, true);
      return json;
    };
    const pubOpt = await call({
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'preflight-publish-option-set',
      result: { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' },
      freeze: { kind: 'producer-held', holdId: 'preflight-hold-opt', record: { path: 'project.json', sha256: projectSha } },
    });
    if (pubOpt.verb !== 'publish' || !pubOpt.ok) throw new Error('Preflight option-set publish failed');
    const askOpt = await call({
      verb: 'ask',
      expectedGeneration: pubOpt.generation,
      idempotencyKey: 'preflight-ask-option-set',
      publicationId: pubOpt.value.publicationId,
      subject: { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
    });
    if (askOpt.verb !== 'ask' || !askOpt.ok) throw new Error('Preflight option-set ask failed');

    const pubPlan = await call({
      verb: 'publish',
      expectedGeneration: askOpt.generation,
      idempotencyKey: 'preflight-publish-plan',
      result: { kind: 'plan' },
      freeze: { kind: 'producer-held', holdId: 'preflight-hold-plan', record: { path: 'project.json', sha256: projectSha } },
    });
    if (pubPlan.verb !== 'publish' || !pubPlan.ok) throw new Error('Preflight plan publish failed');
    const askCp = await call({
      verb: 'ask',
      expectedGeneration: pubPlan.generation,
      idempotencyKey: 'preflight-ask-checkpoint',
      publicationId: pubPlan.value.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'seethrough' },
    });
    if (askCp.verb !== 'ask' || !askCp.ok) throw new Error('Preflight checkpoint ask failed');
    const askSignoff = await call({
      verb: 'ask',
      expectedGeneration: askCp.generation,
      idempotencyKey: 'preflight-ask-signoff',
      publicationId: pubPlan.value.publicationId,
      subject: { kind: 'signoff', stage: 'rigging-interview' },
    });
    if (askSignoff.verb !== 'ask' || !askSignoff.ok) throw new Error('Preflight signoff ask failed');
    const askReopen = await call({
      verb: 'ask',
      expectedGeneration: askSignoff.generation,
      idempotencyKey: 'preflight-ask-reopen',
      publicationId: pubPlan.value.publicationId,
      subject: { kind: 'reopen', stage: 'plan-approved' },
    });
    if (askReopen.verb !== 'ask' || !askReopen.ok) throw new Error('Preflight reopen ask failed');
  } finally {
    try {
      host?.stop();
    } finally {
      await rm(preflightScratch, { recursive: true, force: true });
    }
  }
}

async function runJobRecordBrowser(): Promise<void> {
const argument = (key: string) => {
  const index = Bun.argv.indexOf(key);
  return index < 0 ? undefined : Bun.argv[index + 1];
};
const language = argument('--lang') ?? 'en';
assert.ok(language === 'en' || language === 'ko');
const catalog = language === 'ko' ? koCatalog : enCatalog;
const output = argument('--out') ?? `evidence/job-record-${language}`;
await mkdir(output, { recursive: true });

// Cheap non-browser publish/ask setup check through the exact same reader fixture before launching Chromium.
await runRecordBrowserPreflightSetupCheck();

const scratch = await mkdtemp(join(realpathSync(tmpdir()), `review-job-record-browser-${language}-`));
const profile = join(scratch, 'chrome');
const recordRoot = join(scratch, 'record-project');
const recordState = join(scratch, 'record-state');
const { projectSha, closureFiles, planSteps, readerPhases, readRecordPublished } =
  await prepareBrowserRecordArchiveFixture(recordRoot);

const redact = (value: string) =>
  value
    .replace(/#cap=[a-f0-9]{64}/gi, '#cap=<redacted>')
    .replace(/"(?:displayedNonce|capability|fetchCapability|agentCapability)"\s*:\s*"[^"]+"/g, m =>
      m.replace(/: "[^"]+"$/, ': "<redacted>"'),
    );

const observations: Record<string, unknown> = {};
async function record(name: string, value: unknown) {
  observations[name] = value;
  await writeFile(join(output, 'observations.json'), redact(JSON.stringify(observations, null, 2)));
  console.log(`job-record ${language} ${name}`);
}

let recordHost: Awaited<ReturnType<typeof startJobHost>> | undefined;
let pkgHost: Awaited<ReturnType<typeof startJobHost>> | undefined;
let pkgFixture: Awaited<ReturnType<typeof jobFixture>> | undefined;
let page: InputCdpSession | undefined;
let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
const reviewApiPayloads: { url: string; status: number; body: Record<string, unknown> }[] = [];
const interviewApiPayloads: { url: string; status: number; body: Record<string, unknown> }[] = [];
const resourceRequests = new Map<string, string>();
const browserExceptions: unknown[] = [];
const browserEvents: unknown[] = [];
const navigationUrls: string[] = [];

async function captureFailure(error: unknown) {
  const captureErrors: string[] = [];
  const failure = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    browserEvents,
    browserExceptions,
    navigationUrls,
    reviewApiPayloads,
    interviewApiPayloads,
    captureErrors,
  };
  if (page) {
    try {
      const { html, ...state } = await page.evaluate<{
        html: string;
        url: string;
        title: string;
        readyState: string;
        notice: unknown;
        alerts: string[];
        bodyText: string;
      }>(`(()=>{
        const notice=document.querySelector('.job-notice');
        return {
          html:document.documentElement.outerHTML,
          url:location.href,
          title:document.title,
          readyState:document.readyState,
          notice:notice?{text:notice.textContent,failed:notice.dataset.failed}:null,
          alerts:[...document.querySelectorAll('[role=alert]')].map(node=>node.textContent),
          bodyText:document.body.innerText
        };
      })()`);
      await writeFile(join(output, 'failure-dom.html'), redact(html));
      await writeFile(join(output, 'failure-state.json'), redact(JSON.stringify(state, null, 2)));
    } catch (captureError) {
      captureErrors.push('DOM ' + String(captureError));
    }
    try {
      await writeFile(join(output, 'failure.png'), await page.screenshot());
    } catch (captureError) {
      captureErrors.push('Screenshot ' + String(captureError));
    }
  }
  await writeFile(join(output, 'observations.json'), redact(JSON.stringify(observations, null, 2)));
  await writeFile(join(output, 'failure.json'), redact(JSON.stringify(failure, null, 2)));
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`JOB_RECORD_BROWSER_WAIT_FAILED ${what}`);
}

async function wait(expression: string, what: string): Promise<void> {
  await until(() => page!.evaluate<boolean>(expression), what);
}

async function edit(selector: string, value: string): Promise<void> {
  await page!.evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing '+${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
}

async function submitForm(askId: string): Promise<{ statusText: string; statusKey: string | null }> {
  const selector = `form[data-job-ask=${JSON.stringify(askId)}]`;
  await wait(
    `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).querySelector('fieldset').disabled`,
    `enabled form ${askId}`,
  );
  await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('button[type="submit"]').click()`);
  await wait(
    `document.querySelector(${JSON.stringify(selector)}).querySelector('fieldset').disabled && document.querySelector(${JSON.stringify(selector)}).querySelector('[role="status"]').textContent.length > 0`,
    `submitted form ${askId}`,
  );
  return page!.evaluate<{ statusText: string; statusKey: string | null }>(
    `(()=>{const st=document.querySelector(${JSON.stringify(selector)}).querySelector('[role="status"]');return {statusText:st.textContent,statusKey:st.dataset.jobText??null};})()`,
  );
}

try {
  const beforeRecordHashes = await jobInputHashes(recordRoot);
  let consumerGrant: { jobId: string; origin: string; fetchCapability: string } | undefined;
  recordHost = await startJobHost({
    root: recordRoot,
    stateDir: recordState,
    fingerprint: 'a'.repeat(64),
    reviewer: { id: 'declared-record-owner', role: 'owner' },
    publicationMode: 'record-and-package',
    readRecordPublished,
    recordReaderId: JOB_RECORD_READER_ID,
    bindingId: 'synthetic-record-writer/1',
    installWriterBinding: binding => {
      consumerGrant = binding;
    },
  });
  assert.ok(consumerGrant && /^[a-f0-9]{64}$/.test(consumerGrant.fetchCapability));

  const agentToken = recordHost.session.hostCredentials().agent;
  async function callRecordApi(body: Record<string, unknown>, token = agentToken): Promise<JobApiResponseV3> {
    const response = await fetch(`${recordHost!.origin}/jobs/${recordHost!.session.jobId}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: recordHost!.session.jobId,
        requestId: randomUUID(),
        ...body,
      }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as JobApiResponseV3;
    assert.equal(json.schema, JOB_API_V3_SCHEMA);
    assert.equal(json.ok, true);
    return json;
  }

  page = await launchCdpSession(profile, {
    async onEvent(event, send) {
      if (event.sessionId) control = send;
      if (event.method === 'Runtime.exceptionThrown') {
        browserExceptions.push(event.params);
      }
      if (event.method === 'Runtime.exceptionThrown' || event.method === 'Network.loadingFailed') {
        browserEvents.push(event);
      }
      if (event.method === 'Network.responseReceived') {
        const response = event.params!.response as { url: string; status: number; mimeType: string };
        const requestId = event.params!.requestId as string;
        if (response.url.endsWith('/api/review') || response.url.endsWith('/api/interview')) {
          resourceRequests.set(requestId, response.url);
        }
      }
      if (event.method === 'Network.loadingFinished') {
        const requestId = event.params!.requestId as string;
        const url = resourceRequests.get(requestId);
        if (url && control) {
          try {
            const raw = (await control('Network.getResponseBody', { requestId })) as {
              body: string;
              base64Encoded: boolean;
            };
            const text = raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString('utf8') : raw.body;
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (url.endsWith('/api/review')) reviewApiPayloads.push({ url, status: 200, body: parsed });
            else if (url.endsWith('/api/interview')) interviewApiPayloads.push({ url, status: 200, body: parsed });
          } catch {
            // Ignore body read races on closed connections.
          }
        }
      }
      if (event.method === 'Page.frameNavigated') {
        const frame = event.params?.frame as { parentId?: string; url?: string } | undefined;
        if (frame && !frame.parentId && frame.url?.startsWith('http://127.0.0.1:')) {
          navigationUrls.push(redact(frame.url));
        }
      }
    },
  });

  await page.setViewport(1440, 960);
  assert.ok(control);
  await control('Network.enable', {});

  const ownerUrl = new URL(recordHost.ownerUrl);
  ownerUrl.searchParams.set('lang', language);
  await page.goto(ownerUrl.href);
  const documentSentinel = await page.evaluate<string>('globalThis.__jobRecordOwnerSentinel = crypto.randomUUID()');

  // 1. Publish model-free option-set via job-api@3 and ask interview-picks
  const pubOpt = await callRecordApi({
    verb: 'publish',
    expectedGeneration: 0,
    idempotencyKey: 'browser-publish-option-set',
    result: { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' },
    freeze: {
      kind: 'producer-held',
      holdId: 'hold-browser-option-set',
      record: { path: 'project.json', sha256: projectSha },
    },
  });
  assert.ok(pubOpt.verb === 'publish' && pubOpt.ok);
  const optionPublication = pubOpt.value as JobPublicationV3;
  assert.equal(optionPublication.source.subject, 'option-set');

  const askOpt = await callRecordApi({
    verb: 'ask',
    expectedGeneration: pubOpt.generation,
    idempotencyKey: 'browser-ask-option-set',
    publicationId: optionPublication.publicationId,
    subject: { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
  });
  assert.ok(askOpt.verb === 'ask' && askOpt.ok);
  const picksAsk = askOpt.value as JobPendingAskV3;

  await wait(
    `document.querySelector('.job-notice')?.dataset.failed === 'false' &&
     document.querySelector('.job-notice')?.textContent?.includes(${JSON.stringify(optionPublication.label)}) &&
     !!document.querySelector('[data-job-record="option-set"]') &&
     !!document.querySelector('form[data-job-ask=${JSON.stringify(picksAsk.askId)}]')`,
    'option-set displayed on normal owner URL',
  );

  const optionDom = await page.evaluate<{
    lang: string;
    headerTitle: string;
    selectedLang: string;
    sourceBinding: Record<string, unknown>;
    recordSummary: string[];
    stageHidden: boolean;
    rigCanvasCount: number;
    questionHeading: string | null;
    selectNames: string[];
  }>(`(()=>{
    const sourceBinding = JSON.parse(document.querySelector('.job-sidebar details pre').textContent);
    const summary = [...document.querySelectorAll('[data-job-record="option-set"] p')].map(n => n.textContent);
    const stage = document.getElementById('stage-layout');
    const form = document.querySelector('form[data-job-ask=${JSON.stringify(picksAsk.askId)}]');
    return {
      lang: document.documentElement.lang,
      headerTitle: document.querySelector('.job-header h1').textContent,
      selectedLang: document.querySelector('.job-header select').value,
      sourceBinding,
      recordSummary: summary,
      stageHidden: !!stage && (stage.hidden || getComputedStyle(stage).display === 'none'),
      rigCanvasCount: document.querySelectorAll('#rig-root canvas').length,
      questionHeading: form?.querySelector('h3')?.textContent ?? null,
      selectNames: [...(form?.querySelectorAll('select[name^="choice."]') ?? [])].map(s => s.name),
    };
  })()`);

  assert.equal(optionDom.lang, language);
  assert.equal(optionDom.selectedLang, language);
  assert.equal(optionDom.headerTitle, optionPublication.label);
  assert.deepEqual(optionDom.sourceBinding, optionPublication.source);
  assert.equal(Object.hasOwn(optionDom.sourceBinding, 'package'), false);
  assert.equal(Object.hasOwn(optionDom.sourceBinding, 'model'), false);
  assert.equal(Object.hasOwn(optionDom.sourceBinding, 'selector'), false);
  assert.equal(optionDom.stageHidden, true);
  assert.equal(optionDom.rigCanvasCount, 0);
  assert.equal(optionDom.questionHeading, 'bones');
  assert.deepEqual(optionDom.selectNames, ['choice.chains', 'choice.placement', 'choice.length']);
  assert.equal(optionDom.recordSummary.length, 2);
  assert.ok(optionDom.recordSummary[0]?.includes(`project.json · ${projectSha}`));
  assert.ok(optionDom.recordSummary[1]?.includes('bones · chain-bones · evidence/interview/bones.json'));

  const optionInstanceBase = `/jobs/${recordHost.session.jobId}/publications/${optionPublication.publicationId}/instances/${optionPublication.instanceKey}`;
  const optionRoutes = await page.evaluate<{
    reviewStatus: number;
    reviewBody: Record<string, unknown>;
    interviewStatus: number;
    interviewBody: { questions?: Array<{ set?: { id?: string; question?: string } }> };
  }>(`(async () => {
    const [reviewRes, interviewRes] = await Promise.all([
      fetch(${JSON.stringify(`${optionInstanceBase}/api/review`)}),
      fetch(${JSON.stringify(`${optionInstanceBase}/api/interview`)}),
    ]);
    return {
      reviewStatus: reviewRes.status,
      reviewBody: await reviewRes.json(),
      interviewStatus: interviewRes.status,
      interviewBody: await interviewRes.json(),
    };
  })()`);
  assert.equal(optionRoutes.reviewStatus, 200, 'fetched api/review payload for option-set publication');
  assert.equal(Object.hasOwn(optionRoutes.reviewBody, 'manifest'), false);
  assert.equal(Object.hasOwn(optionRoutes.reviewBody, 'reviewedSource'), false);
  assert.deepEqual(optionRoutes.reviewBody.recordSource, optionPublication.source);
  assert.equal(optionRoutes.interviewStatus, 200, 'fetched api/interview payload for option-set publication');
  assert.ok(
    Array.isArray(optionRoutes.interviewBody.questions) &&
      optionRoutes.interviewBody.questions.some(q => q.set?.id === 'chain-bones' && q.set?.question === 'bones'),
    'captured api/interview questions for option-set publication',
  );

  for (const name of optionDom.selectNames) {
    await edit(`form[data-job-ask="${picksAsk.askId}"] select[name="${name}"]`, 'keep');
  }
  await edit(`form[data-job-ask="${picksAsk.askId}"] textarea[name="note"]`, `Option picks note (${language})`);
  const picksSubmitStatus = await submitForm(picksAsk.askId);
  assert.equal(picksSubmitStatus.statusKey, 'job.saved');
  assert.equal(picksSubmitStatus.statusText, catalog['job.saved']);
  await writeFile(join(output, `record-option-set-${language}.png`), await page.screenshot());
  await record('option-set-submitted', { optionDom, optionRoutes, picksSubmitStatus });

  // 2. Publish model-free plan via job-api@3 and ask checkpoint + signoff on the same standing owner window
  const pubPlan = await callRecordApi({
    verb: 'publish',
    expectedGeneration: recordHost.session.status().generation,
    idempotencyKey: 'browser-publish-plan',
    result: { kind: 'plan' },
    freeze: {
      kind: 'producer-held',
      holdId: 'hold-browser-plan',
      record: { path: 'project.json', sha256: projectSha },
    },
  });
  assert.ok(pubPlan.verb === 'publish' && pubPlan.ok);
  const planPublication = pubPlan.value as JobPublicationV3;
  assert.equal(planPublication.source.subject, 'plan');

  const askCp = await callRecordApi({
    verb: 'ask',
    expectedGeneration: pubPlan.generation,
    idempotencyKey: 'browser-ask-checkpoint',
    publicationId: planPublication.publicationId,
    subject: { kind: 'checkpoint', checkpointId: 'seethrough' },
  });
  assert.ok(askCp.verb === 'ask' && askCp.ok);
  const cpAsk = askCp.value as JobPendingAskV3;

  const askSignoff = await callRecordApi({
    verb: 'ask',
    expectedGeneration: askCp.generation,
    idempotencyKey: 'browser-ask-signoff',
    publicationId: planPublication.publicationId,
    subject: { kind: 'signoff', stage: 'rigging-interview' },
  });
  assert.ok(askSignoff.verb === 'ask' && askSignoff.ok);
  const signoffAsk = askSignoff.value as JobPendingAskV3;

  const askReopen = await callRecordApi({
    verb: 'ask',
    expectedGeneration: askSignoff.generation,
    idempotencyKey: 'browser-ask-reopen',
    publicationId: planPublication.publicationId,
    subject: { kind: 'reopen', stage: 'plan-approved' },
  });
  assert.ok(askReopen.verb === 'ask' && askReopen.ok);
  const reopenAsk = askReopen.value as JobPendingAskV3;

  await wait(
    `document.querySelector('.job-notice')?.dataset.failed === 'false' &&
     document.querySelector('.job-notice')?.textContent?.includes(${JSON.stringify(planPublication.label)}) &&
     !!document.querySelector('[data-job-record="plan"]') &&
     !!document.querySelector('form[data-job-ask=${JSON.stringify(cpAsk.askId)}]') &&
     !!document.querySelector('form[data-job-ask=${JSON.stringify(signoffAsk.askId)}]') &&
     !!document.querySelector('form[data-job-ask=${JSON.stringify(reopenAsk.askId)}]')`,
    'plan displayed with checkpoint, signoff and reopen forms on normal owner URL',
  );

  // Verify panel switching to '2' (Interview) keeps record forms visible
  await edit('#job-panel', '2');
  const planDom = await page.evaluate<{
    sentinel: string;
    lang: string;
    headerTitle: string;
    sourceBinding: Record<string, unknown>;
    recordLine: string | null;
    renderedSteps: string[];
    stageHidden: boolean;
    rigCanvasCount: number;
    cpFormHidden: boolean;
    signoffFormHidden: boolean;
    reopenFormHidden: boolean;
    cpStepText: string | null;
    signoffStageText: string | null;
    reopenStageText: string | null;
    reopenSubmitKey: string | null;
    reopenSubmitText: string | null;
  }>(`(()=>{
    const sourceBinding = JSON.parse(document.querySelector('.job-sidebar details pre').textContent);
    const stage = document.getElementById('stage-layout');
    const cpForm = document.querySelector('form[data-job-ask=${JSON.stringify(cpAsk.askId)}]');
    const signoffForm = document.querySelector('form[data-job-ask=${JSON.stringify(signoffAsk.askId)}]');
    const reopenForm = document.querySelector('form[data-job-ask=${JSON.stringify(reopenAsk.askId)}]');
    const reopenBtn = reopenForm?.querySelector('button[type="submit"]');
    return {
      sentinel: globalThis.__jobRecordOwnerSentinel,
      lang: document.documentElement.lang,
      headerTitle: document.querySelector('.job-header h1').textContent,
      sourceBinding,
      recordLine: document.querySelector('[data-job-record="plan"] > p')?.textContent ?? null,
      renderedSteps: [...document.querySelectorAll('[data-job-record="plan"] ol li')].map(li => li.textContent),
      stageHidden: !!stage && (stage.hidden || getComputedStyle(stage).display === 'none'),
      rigCanvasCount: document.querySelectorAll('#rig-root canvas').length,
      cpFormHidden: !cpForm || cpForm.hidden,
      signoffFormHidden: !signoffForm || signoffForm.hidden,
      reopenFormHidden: !reopenForm || reopenForm.hidden,
      cpStepText: cpForm?.querySelectorAll('p.job-source')[1]?.textContent ?? null,
      signoffStageText: [...(signoffForm?.querySelectorAll('fieldset > p') ?? [])].at(-1)?.textContent ?? null,
      reopenStageText: [...(reopenForm?.querySelectorAll('fieldset > p') ?? [])].at(-1)?.textContent ?? null,
      reopenSubmitKey: reopenBtn?.dataset.jobText ?? null,
      reopenSubmitText: reopenBtn?.textContent ?? null,
    };
  })()`);

  assert.equal(planDom.sentinel, documentSentinel, 'standing owner window swapped without document reload');
  assert.equal(navigationUrls.length, 1);
  assert.equal(planDom.lang, language);
  assert.equal(planDom.headerTitle, planPublication.label);
  assert.deepEqual(planDom.sourceBinding, planPublication.source);
  assert.equal(Object.hasOwn(planDom.sourceBinding, 'package'), false);
  assert.equal(Object.hasOwn(planDom.sourceBinding, 'model'), false);
  assert.equal(Object.hasOwn(planDom.sourceBinding, 'selector'), false);
  assert.equal(planDom.recordLine, `project.json · ${projectSha}`);
  assert.deepEqual(
    planDom.renderedSteps,
    planSteps.map(step => `${step.id} · ${step.hash}`),
  );
  assert.equal(planDom.stageHidden, true);
  assert.equal(planDom.rigCanvasCount, 0);
  assert.equal(planDom.cpFormHidden, false);
  assert.equal(planDom.signoffFormHidden, false);
  assert.equal(planDom.reopenFormHidden, false);
  const expectedCpStep = planSteps.find(step => step.id === 'seethrough');
  assert.ok(expectedCpStep, 'declared seethrough step exists in planSteps');
  assert.equal(planDom.cpStepText, `${expectedCpStep.id} · ${expectedCpStep.hash}`);
  assert.equal(planDom.signoffStageText, 'rigging-interview');
  assert.equal(planDom.reopenStageText, 'plan-approved');
  assert.equal(planDom.reopenSubmitKey, 'job.reopen');
  assert.equal(planDom.reopenSubmitText, catalog['job.reopen']);

  const planInstanceBase = `/jobs/${recordHost.session.jobId}/publications/${planPublication.publicationId}/instances/${planPublication.instanceKey}`;
  const planRoutes = await page.evaluate<{
    reviewStatus: number;
    reviewBody: Record<string, unknown>;
  }>(`(async () => {
    const reviewRes = await fetch(${JSON.stringify(`${planInstanceBase}/api/review`)});
    return {
      reviewStatus: reviewRes.status,
      reviewBody: await reviewRes.json(),
    };
  })()`);
  assert.equal(planRoutes.reviewStatus, 200, 'fetched api/review payload for plan publication');
  assert.equal(Object.hasOwn(planRoutes.reviewBody, 'manifest'), false);
  assert.equal(Object.hasOwn(planRoutes.reviewBody, 'reviewedSource'), false);
  assert.deepEqual(planRoutes.reviewBody.recordSource, planPublication.source);

  // Submit checkpoint, signoff and reopen through actual DOM forms
  await edit(`form[data-job-ask="${cpAsk.askId}"] select[name="outcome"]`, 'pass');
  await edit(`form[data-job-ask="${cpAsk.askId}"] textarea[name="note"]`, `Checkpoint approved in ${language}`);
  const cpSubmitStatus = await submitForm(cpAsk.askId);
  assert.equal(cpSubmitStatus.statusKey, 'job.saved');
  assert.equal(cpSubmitStatus.statusText, catalog['job.saved']);

  await edit(`form[data-job-ask="${signoffAsk.askId}"] textarea[name="note"]`, `Signoff approved in ${language}`);
  const signoffSubmitStatus = await submitForm(signoffAsk.askId);
  assert.equal(signoffSubmitStatus.statusKey, 'job.saved');
  assert.equal(signoffSubmitStatus.statusText, catalog['job.saved']);

  const reopenVerbatimWords = `  Reopen plan-approved in ${language}\n`;
  await edit(`form[data-job-ask="${reopenAsk.askId}"] textarea[name="note"]`, reopenVerbatimWords);
  const reopenSubmitStatus = await submitForm(reopenAsk.askId);
  assert.equal(reopenSubmitStatus.statusKey, 'job.saved');
  assert.equal(reopenSubmitStatus.statusText, catalog['job.saved']);

  await writeFile(join(output, `record-plan-${language}.png`), await page.screenshot());

  // Scroll the reopen form/button into view within the forms container, wait painted rAF, assert visible bounds, and capture record-reopen-<lang>.png
  const reopenVisibleBounds = await page.evaluate<{
    viewportWidth: number;
    viewportHeight: number;
    formsHostScrollTop: number;
    formsHostRect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
    formRect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
    buttonRect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
    statusRect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
  }>(`(async () => {
    const formsHost = document.querySelector('[data-job-forms]');
    const form = document.querySelector('form[data-job-ask=${JSON.stringify(reopenAsk.askId)}]');
    const button = form?.querySelector('button[type="submit"]');
    const status = form?.querySelector('[role="status"]');
    if (!formsHost || !form || !button || !status) {
      throw new Error('Missing reopen form elements for visible bounds check');
    }
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      formsHostScrollTop: formsHost.scrollTop,
      formsHostRect: rectOf(formsHost),
      formRect: rectOf(form),
      buttonRect: rectOf(button),
      statusRect: rectOf(status),
    };
  })()`);
  assert.ok(reopenVisibleBounds.buttonRect.width > 0 && reopenVisibleBounds.buttonRect.height > 0);
  assert.ok(
    reopenVisibleBounds.buttonRect.top >= reopenVisibleBounds.formsHostRect.top &&
      reopenVisibleBounds.buttonRect.bottom <= reopenVisibleBounds.formsHostRect.bottom &&
      reopenVisibleBounds.buttonRect.top >= 0 &&
      reopenVisibleBounds.buttonRect.bottom <= reopenVisibleBounds.viewportHeight &&
      reopenVisibleBounds.buttonRect.left >= 0 &&
      reopenVisibleBounds.buttonRect.right <= reopenVisibleBounds.viewportWidth,
    `reopen submit button must be visible inside forms container and viewport: ${JSON.stringify(reopenVisibleBounds)}`,
  );
  assert.ok(
    reopenVisibleBounds.formRect.bottom > reopenVisibleBounds.formsHostRect.top &&
      reopenVisibleBounds.formRect.top < reopenVisibleBounds.formsHostRect.bottom,
    `reopen form must intersect visible forms container: ${JSON.stringify(reopenVisibleBounds)}`,
  );
  await writeFile(join(output, `record-reopen-${language}.png`), await page.screenshot());

  // 3. Authenticated consumer fetch-act and exported parseRecordAct verification
  const nextRes = await callRecordApi({
    verb: 'next',
    after: null,
    waitMs: 0,
  });
  if (nextRes.verb !== 'next' || !nextRes.ok) {
    throw new Error('Expected next response to succeed');
  }
  const actEvents = nextRes.value.events.filter(
    (e): e is Extract<JobEventV3, { type: 'act' }> => e.type === 'act',
  );
  assert.equal(actEvents.length, 4);

  const fetchedActs: Record<string, JobRecordAct> = {};
  for (const event of actEvents) {
    const jsonFetchRes: Response = await fetch(`${recordHost.origin}/jobs/${recordHost.session.jobId}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${consumerGrant.fetchCapability}`,
      },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: recordHost.session.jobId,
        requestId: randomUUID(),
        verb: 'fetch-act',
        actId: event.act.actId,
      }),
    });
    assert.equal(jsonFetchRes.status, 200);
    const jsonFetched = (await jsonFetchRes.json()) as JobApiResponseV3;
    if (jsonFetched.verb !== 'fetch-act' || !jsonFetched.ok) {
      throw new Error('Expected fetch-act response to succeed');
    }

    const rawFetchRes: Response = await fetch(`${recordHost.origin}/jobs/${recordHost.session.jobId}/api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.rig-review.act+json',
        Authorization: `Bearer ${consumerGrant.fetchCapability}`,
      },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: recordHost.session.jobId,
        requestId: randomUUID(),
        verb: 'fetch-act',
        actId: event.act.actId,
      }),
    });
    assert.equal(rawFetchRes.status, 200);
    const rawParsed = parseRecordAct(JSON.parse(await rawFetchRes.text()));
    const envelopeParsed = parseRecordAct(jsonFetched.value);
    assert.deepEqual(rawParsed, envelopeParsed);
    assert.equal(envelopeParsed.schema, JOB_RECORD_ACT_SCHEMA);
    assert.deepEqual(envelopeParsed.authority, {
      actor: 'human',
      channel: 'review-ui',
      reviewer: { id: 'declared-record-owner', role: 'owner' },
    });
    fetchedActs[envelopeParsed.kind] = envelopeParsed;
  }

  assert.equal(fetchedActs['interview-picks']?.source.subject, 'option-set');
  assert.deepEqual(fetchedActs['interview-picks']?.value, {
    questionId: 'bones',
    selections: [
      { itemId: 'chains', optionId: 'keep', otherText: null },
      { itemId: 'placement', optionId: 'keep', otherText: null },
      { itemId: 'length', optionId: 'keep', otherText: null },
    ],
    note: `Option picks note (${language})`,
  });

  assert.equal(fetchedActs.checkpoint?.source.subject, 'plan');
  assert.deepEqual(fetchedActs.checkpoint?.value, {
    checkpointId: 'seethrough',
    planStepId: 'seethrough',
    outcome: 'pass',
    words: `Checkpoint approved in ${language}`,
  });

  assert.equal(fetchedActs.signoff?.source.subject, 'plan');
  assert.deepEqual(fetchedActs.signoff?.value, {
    stage: 'rigging-interview',
    decision: 'approved',
    words: `Signoff approved in ${language}`,
  });

  assert.equal(fetchedActs.reopen?.source.subject, 'plan');
  assert.deepEqual(fetchedActs.reopen?.value, {
    stage: 'plan-approved',
    words: reopenVerbatimWords,
  });

  assert.deepEqual(await jobInputHashes(recordRoot), beforeRecordHashes, 'supplied record project files remain immutable');
  await record('record-acts-verified', {
    planDom,
    planRoutes,
    cpSubmitStatus,
    signoffSubmitStatus,
    reopenSubmitStatus,
    reopenVisibleBounds,
    acts: fetchedActs,
    readerPhasesCount: readerPhases.length,
  });

  // 4. Package normal-entry regression on default package-only startJobHost
  pkgFixture = await jobFixture();
  await mkdir(join(pkgFixture.root, 'out-empty'), { recursive: true });
  await writeFile(
    join(pkgFixture.root, 'out-empty/review.json'),
    JSON.stringify({
      schema: 'rig-review/1',
      id: 'empty-pkg',
      title: 'Model-less package control',
      revision: '1',
      references: [],
    }),
  );
  pkgHost = await startJobHost({
    root: pkgFixture.root,
    stateDir: join(scratch, 'pkg-state'),
    fingerprint: 'b'.repeat(64),
    reviewer: { id: 'declared-pkg-owner', role: 'owner' },
    readPublished: async () => pkgFixture!.getContext(),
    readerId: 'synthetic-pkg-reader/1',
  });

  const pkgAgent = pkgHost.session.hostCredentials().agent;
  const recordSha = sha256(await readFile(join(pkgFixture.root, 'record.json')));
  const pkgPubRes = await fetch(`${pkgHost.origin}/jobs/${pkgHost.session.jobId}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pkgAgent}` },
    body: JSON.stringify({
      schema: JOB_API_SCHEMA,
      jobId: pkgHost.session.jobId,
      requestId: randomUUID(),
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'pkg-publish-1',
      result: { path: 'out', selector: { kind: 'rig', version: 1 } },
      freeze: { kind: 'producer-held', holdId: 'pkg-hold-1', record: { path: 'record.json', sha256: recordSha } },
    }),
  });
  assert.equal(pkgPubRes.status, 200);
  const pkgPubBody = await pkgPubRes.json();
  assert.equal(pkgPubBody.schema, JOB_API_SCHEMA);
  assert.equal(pkgPubBody.ok, true);

  const pkgOwnerUrl = new URL(pkgHost.ownerUrl);
  pkgOwnerUrl.searchParams.set('lang', language);
  await page.goto(pkgOwnerUrl.href);
  await wait(
    `document.querySelector('.job-notice')?.dataset.failed === 'false' &&
     document.querySelector('.job-header h1')?.textContent === ${JSON.stringify(pkgPubBody.value.source.package.id)} &&
     document.querySelector('.job-notice')?.textContent?.includes(${JSON.stringify(pkgPubBody.value.label)}) &&
     document.querySelector('.job-sidebar .job-source')?.textContent?.includes(${JSON.stringify(pkgPubBody.value.source.sourceHash)}) &&
     !!document.querySelector('#rig-root canvas') &&
     !document.querySelector('[data-job-record]')`,
    'package normal entry rendered with canvas',
  );

  const pkgDom = await page.evaluate<{
    headerTitle: string;
    hasPackageField: boolean;
    hasModelField: boolean;
    canvasCount: number;
  }>(`(()=>{
    const source = JSON.parse(document.querySelector('.job-sidebar details pre').textContent);
    return {
      headerTitle: document.querySelector('.job-header h1').textContent,
      hasPackageField: !!source.package?.id,
      hasModelField: !!source.model?.sha256,
      canvasCount: document.querySelectorAll('#rig-root canvas').length,
    };
  })()`);
  assert.equal(pkgDom.headerTitle, pkgPubBody.value.source.package.id);
  assert.equal(pkgDom.hasPackageField, true);
  assert.equal(pkgDom.hasModelField, true);
  assert.ok(pkgDom.canvasCount >= 1);

  // Publishing a model-less/reference-less package still triggers MODEL_UNAVAILABLE in the browser
  const emptyPkgRes = await fetch(`${pkgHost.origin}/jobs/${pkgHost.session.jobId}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pkgAgent}` },
    body: JSON.stringify({
      schema: JOB_API_SCHEMA,
      jobId: pkgHost.session.jobId,
      requestId: randomUUID(),
      verb: 'publish',
      expectedGeneration: 1,
      idempotencyKey: 'pkg-publish-empty',
      result: { path: 'out-empty', selector: { kind: 'rig', version: 1 } },
      freeze: { kind: 'producer-held', holdId: 'pkg-hold-empty', record: { path: 'record.json', sha256: recordSha } },
    }),
  });
  assert.equal(emptyPkgRes.status, 200);
  await wait(
    `document.querySelector('.job-notice')?.dataset.failed === 'true' &&
     document.querySelector('.job-notice')?.textContent?.includes('MODEL_UNAVAILABLE')`,
    'model-less package publication refuses MODEL_UNAVAILABLE',
  );

  assert.equal(browserExceptions.length, 0, `unexpected browser exceptions: ${JSON.stringify(browserExceptions)}`);
  await record('package-regression-verified', { pkgDom, actSchema: JOB_ACT_SCHEMA });
} catch (error) {
  try {
    await captureFailure(error);
  } catch (captureError) {
    console.error('JOB_RECORD_BROWSER_DIAGNOSTIC_FAILED', redact(String(captureError)));
  }
  throw error;
} finally {
  try {
    await writeFile(join(output, 'browser-events.json'), redact(JSON.stringify(browserEvents, null, 2)));
    if (page) await page.close();
  } finally {
    try {
      recordHost?.stop();
    } finally {
      try {
        pkgHost?.stop();
      } finally {
        try {
          await pkgFixture?.close();
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
}
}

if (import.meta.main) {
  await runJobRecordBrowser();
}
