/** Ordinary Nova browser verification for model-free record mode (job-api@3 / act@4 and act@6) and package normal-entry regression. Run with --lang en or --lang ko. */
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
  JOB_COMMENTS_ACT_SCHEMA,
  JOB_COMMENT_ONLY_ACT_SCHEMA,
  JOB_RECORD_READER_ID,
  parseRecordAct,
  parseCommentsAct,
  parseCommentOnlyAct,
  startJobHost,
  type JobApiResponseV3,
  type JobEventV3,
  type JobOptionContext,
  type JobPendingAskV3,
  type JobPlanContext,
  type JobPublicationV3,
  type JobRecordAct,
  type JobCommentsAct,
  type JobCommentOnlyAct,
  type JobRecordPartsIdentity,
  type JobRecordPublicationReader,
  type JobRecordReaderInput,
} from '@rig-c/review/job-host';
import { readProject } from '../src/interview-project.ts';
import { enCatalog } from '../web/catalog-en.ts';
import { koCatalog } from '../web/catalog-ko.ts';
import { seedHistoricalPicksAct } from './helpers/historical-picks-act.ts';
import { jobFixture, jobInputHashes } from './helpers/job-api-fixture.ts';
import { seedHistoricalCheckpointAct } from './helpers/historical-checkpoint-act.ts';
import { expectRecordActSubmitted } from './helpers/record-act-browser-status.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
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
    // #1230: the declared picks subject parses on publish, but a fresh picks ask refuses by name.
    const picksRes = await fetch(`${host!.origin}/jobs/${host!.session.jobId}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: host!.session.jobId,
        requestId: randomUUID(),
        verb: 'ask',
        expectedGeneration: pubOpt.generation,
        idempotencyKey: 'preflight-ask-option-set',
        publicationId: pubOpt.value.publicationId,
        subject: { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
      }),
    });
    assert.equal(picksRes.status, 400);
    const askOpt = (await picksRes.json()) as JobApiResponseV3;
    if (askOpt.ok) throw new Error('Preflight option-set picks ask unexpectedly succeeded');
    assert.equal(askOpt.error.code, 'JOB_REQUEST_INVALID');
    assert.equal(askOpt.error.message, 'Unknown job verb: ask');

    const pubPlan = await call({
      verb: 'publish',
      expectedGeneration: pubOpt.generation,
      idempotencyKey: 'preflight-publish-plan',
      result: { kind: 'plan' },
      freeze: { kind: 'producer-held', holdId: 'preflight-hold-plan', record: { path: 'project.json', sha256: projectSha } },
    });
    if (pubPlan.verb !== 'publish' || !pubPlan.ok) throw new Error('Preflight plan publish failed');
    // #1229: the declared checkpoint subject parses on publish, while a fresh checkpoint ask refuses JOB_REQUEST_INVALID.
    const cpRes = await fetch(`${host!.origin}/jobs/${host!.session.jobId}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: host!.session.jobId,
        requestId: randomUUID(),
        verb: 'ask',
        expectedGeneration: pubPlan.generation,
        idempotencyKey: 'preflight-ask-checkpoint',
        publicationId: pubPlan.value.publicationId,
        subject: { kind: 'checkpoint', checkpointId: 'seethrough' },
      }),
    });
    assert.equal(cpRes.status, 400);
    const askCp = (await cpRes.json()) as JobApiResponseV3;
    assert.equal(askCp.schema, JOB_API_V3_SCHEMA);
    assert.equal(askCp.ok, false);
    if (askCp.ok) throw new Error('Preflight checkpoint ask unexpectedly succeeded');
    assert.equal(askCp.error.code, 'JOB_REQUEST_INVALID');
    assert.equal(askCp.error.message, 'Unknown job verb: ask');
    const signoffRes = await fetch(`${host!.origin}/jobs/${host!.session.jobId}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: host!.session.jobId,
        requestId: randomUUID(),
        verb: 'ask',
        expectedGeneration: pubPlan.generation,
        idempotencyKey: 'preflight-ask-signoff',
        publicationId: pubPlan.value.publicationId,
        subject: { kind: 'signoff', stage: 'rigging-interview' },
      }),
    });
    assert.equal(signoffRes.status, 400);
    const askSignoff = (await signoffRes.json()) as JobApiResponseV3;
    assert.equal(askSignoff.schema, JOB_API_V3_SCHEMA);
    assert.equal(askSignoff.ok, false);
    if (askSignoff.ok) throw new Error('Preflight signoff ask unexpectedly succeeded');
    assert.equal(askSignoff.error.code, 'JOB_REQUEST_INVALID');
    assert.equal(askSignoff.error.message, 'Unknown job verb: ask');
    const reopenRes = await fetch(`${host!.origin}/jobs/${host!.session.jobId}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        schema: JOB_API_V3_SCHEMA,
        jobId: host!.session.jobId,
        requestId: randomUUID(),
        verb: 'ask',
        expectedGeneration: pubPlan.generation,
        idempotencyKey: 'preflight-ask-reopen',
        publicationId: pubPlan.value.publicationId,
        subject: { kind: 'reopen', stage: 'plan-approved' },
      }),
    });
    assert.equal(reopenRes.status, 400);
    const askReopen = (await reopenRes.json()) as JobApiResponseV3;
    assert.equal(askReopen.schema, JOB_API_V3_SCHEMA);
    assert.equal(askReopen.ok, false);
    if (askReopen.ok) throw new Error('Preflight reopen ask unexpectedly succeeded');
    assert.equal(askReopen.error.code, 'JOB_REQUEST_INVALID');
    assert.equal(askReopen.error.message, 'Unknown job verb: ask');
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
const requestedLanguage = argument('--lang') ?? 'en';
assert.ok(requestedLanguage === 'en' || requestedLanguage === 'ko');
const language = requestedLanguage;
const catalog = language === 'ko' ? koCatalog : enCatalog;
const output = argument('--out') ?? `evidence/job-record-${language}`;
await mkdir(output, { recursive: true });

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
        const notice=document.querySelector('#message');
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

  await page.setViewport(1600, 1000);
  assert.ok(control);
  await control('Network.enable', {});

  const ownerUrl = new URL(recordHost.ownerUrl);
  ownerUrl.searchParams.set('lang', language);
  await page.goto(ownerUrl.href);
  const documentSentinel = await page.evaluate<string>('globalThis.__jobRecordOwnerSentinel = crypto.randomUUID()');

  // 1. Publish model-free option-set via job-api@3; fresh interview-picks ask refuses (#1230) while the page opens in comment mode
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

  const askOptRes = await fetch(`${recordHost.origin}/jobs/${recordHost.session.jobId}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      schema: JOB_API_V3_SCHEMA,
      jobId: recordHost.session.jobId,
      requestId: randomUUID(),
      verb: 'ask',
      expectedGeneration: pubOpt.generation,
      idempotencyKey: 'browser-ask-option-set',
      publicationId: optionPublication.publicationId,
      subject: { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
    }),
  });
  assert.equal(askOptRes.status, 400, '#1230: fresh interview-picks ask returns HTTP 400');
  const askOpt = (await askOptRes.json()) as JobApiResponseV3;
  assert.equal(askOpt.ok, false);
  if (askOpt.ok) throw new Error('Expected interview-picks ask to be refused');
  assert.equal(askOpt.error.code, 'JOB_REQUEST_INVALID');
  assert.equal(askOpt.error.message, 'Unknown job verb: ask');

  await wait(
    `document.body.dataset.ready==='true' &&
     document.getElementById('package-title')?.textContent===${JSON.stringify(optionPublication.label)} &&
     !!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])') &&
     !document.getElementById('send-comments')?.hidden`,
    'option-set displayed in comment mode on normal owner URL',
  );

  const optionDom = await page.evaluate<{
    lang: string;
    headerTitle: string;
    selectedLang: string;
    sourceBinding: Record<string, unknown>;
    stageHidden: boolean;
    rigCanvasCount: number;
    formCount: number;
    headline: string | null;
  }>(`(async()=>{
    const sourceBinding = await (await fetch(${JSON.stringify(`/jobs/${recordHost.session.jobId}/publications/${optionPublication.publicationId}/instances/${optionPublication.instanceKey}/api/review`)})).json().then(body=>body.recordSource);
    const stage = document.getElementById('stage-layout');
    return {
      lang: document.documentElement.lang,
      headerTitle: document.querySelector('#package-title').textContent,
      selectedLang: document.querySelector('#settings-language').value,
      sourceBinding,
      stageHidden: !!stage && (stage.hidden || getComputedStyle(stage).display === 'none'),
      rigCanvasCount: document.querySelectorAll('#rig-root canvas').length,
      formCount: document.querySelectorAll('form[data-job-ask]').length,
      headline: document.getElementById('workspace-ask-headline')?.textContent ?? null,
    };
  })()`);

  assert.equal(optionDom.lang, language);
  assert.equal(optionDom.selectedLang, language);
  assert.equal(optionDom.headerTitle, optionPublication.label);
  assert.deepEqual(optionDom.sourceBinding, optionPublication.source);
  assert.equal(Object.hasOwn(optionDom.sourceBinding, 'package'), false);
  assert.equal(Object.hasOwn(optionDom.sourceBinding, 'model'), false);
  assert.equal(Object.hasOwn(optionDom.sourceBinding, 'selector'), false);
  assert.equal(optionDom.rigCanvasCount, 0);
  assert.equal(optionDom.formCount, 0, '#1230: option-set renders no ask form');
  assert.equal(optionDom.headline, catalog["We're looking at the work together. Leave your thoughts as comments."]);

  const optionInstanceBase = `/jobs/${recordHost.session.jobId}/publications/${optionPublication.publicationId}/instances/${optionPublication.instanceKey}`;
  const optionRoutes = await page.evaluate<{
    reviewStatus: number;
    reviewBody: Record<string, unknown>;
    interviewStatus: number;
    interviewBody: { questions?: Array<{ set?: { id?: string; question?: string }; images?: {name:string;url:string}[] }> };
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
  assert.ok(Array.isArray(optionRoutes.interviewBody.questions),'captured api/interview questions for option-set publication');
  const optionQuestion = optionRoutes.interviewBody.questions.find(q => q.set?.id === 'chain-bones' && q.set?.question === 'bones');
  assert.ok(optionQuestion,'captured the matching chain-bones question');
  assert.ok(Array.isArray(optionQuestion.images),'captured the matching question image inventory');
  const optionImages = optionQuestion.images;

  const visiblePainting = `(()=>{const image=document.querySelector('#reference-content img');return image?.complete&&image.naturalWidth>0&&image.getBoundingClientRect().width>0?image.currentSrc:'';})()`;
  const readOptionPicture = () => page!.evaluate<{painting:string;imageCount:number;imageModes:string[];emptyText:string;emptyVisible:boolean}>(`(()=>{
    const empty=document.getElementById('rig-empty'),rect=empty.getBoundingClientRect();
    return {painting:${visiblePainting},imageCount:document.querySelectorAll('#reference-content img').length,
      imageModes:[...document.querySelectorAll('#view-menu [data-view^="interview-image-"]')].map(button=>button.dataset.view),
      emptyText:empty.textContent,emptyVisible:rect.width>0&&rect.height>0&&getComputedStyle(empty).visibility==='visible'};
  })()`);
  const firstImage = optionImages[0];
  const expectedPainting = firstImage ? new URL(optionInstanceBase+firstImage.url,recordHost.origin).href : '';
  if (firstImage) await wait(`${visiblePainting}===${JSON.stringify(expectedPainting)}`,'first retained option-set image visible in main view');
  const optionPictureBeforeSave = await readOptionPicture();
  assert.deepEqual(optionPictureBeforeSave.imageModes,optionImages.map((_,index)=>`interview-image-${index}`));
  assert.equal(optionPictureBeforeSave.painting,expectedPainting);
  if (!firstImage) {
    assert.equal(optionPictureBeforeSave.imageCount,0);
    assert.equal(optionPictureBeforeSave.emptyText,catalog['This request has no picture.']);
    assert.equal(optionPictureBeforeSave.emptyVisible,true);
  }
  const commentShell = await page.evaluate<{dialogOpen:boolean;dialogViewers:number;notes:number}>(`({
    dialogOpen:!!document.querySelector('dialog[open]'),
    dialogViewers:document.querySelectorAll('dialog :is(.viewport,.interview-view,.interview-viewport,#reference-content,#rig-viewport,#view-menu)').length,
    notes:document.querySelectorAll('input[name="note"],textarea[name="note"],.interview-note').length,
  })`);
  assert.deepEqual(commentShell,{dialogOpen:false,dialogViewers:0,notes:0});

  // Owner ruling 2026-11-26: historical answers and notes stay readable to agents and the CLI; Review shows no interview answers.
  const sourceProject=JSON.parse(await readFile(join(recordRoot,'project.json'),'utf8'));
  const existingNote=sourceProject.interview.waypoints.find((row:{id:string})=>row.id==='bones')?.guide?.choice?.note??'';
  const projectRead=readProject(recordRoot);
  assert.equal((projectRead.questions.find(q=>q.set.question==='bones')?.answer?.choice as {note?:string}|undefined)?.note??'',existingNote);

  const optionCommentText = `Option-set comment · ${language}`;
  await click(page, '[data-comment-general]');
  await wait(`!!document.querySelector('.stage-comment-composer input')`, 'option-set general composer');
  await page.evaluate(`(() => {
    const f = document.querySelector('.stage-comment-composer');
    f.querySelector('input').value = ${JSON.stringify(optionCommentText)};
    f.requestSubmit();
  })()`);
  await wait(`!document.querySelector('.stage-comment-composer') && !document.getElementById('send-comments').disabled`, 'option-set comment saved');
  await click(page, '#send-comments');
  const optionCommentsStatus = await expectRecordActSubmitted(page, wait, language, 'option-set comments submitted');
  const optionPictureAfterSave = await readOptionPicture();
  assert.deepEqual(optionPictureAfterSave,optionPictureBeforeSave,'the shared main view keeps the retained picture or blank fallback after save');

  // Seed one pre-refusal historical interview-picks act@6 so consumer fetch-act exercises act@10, historical act@6 and act@4 together.
  const historicalDisplayed = recordHost.session.ackDisplayed({
    publicationId: optionPublication.publicationId,
    pageId: 'historical-picks-page',
    sourceHash: optionPublication.source.sourceHash,
  });
  seedHistoricalPicksAct(recordHost.session, {
    publicationId: optionPublication.publicationId,
    pageId: 'historical-picks-page',
    displayedNonce: historicalDisplayed.displayedNonce,
    expectedGeneration: recordHost.session.status().generation,
    submissionId: 'historical-picks-sub',
    questionId: 'bones',
    setId: 'chain-bones',
    optionSetSha256: optionPublication.source.optionSet!.sha256,
    value: {
      questionId: 'bones',
      selections: [
        { itemId: 'chains', optionId: 'keep', otherText: null },
        { itemId: 'placement', optionId: 'keep', otherText: null },
        { itemId: 'length', optionId: 'keep', otherText: null },
      ],
      note: existingNote,
      comments: [],
    },
  });

  await writeFile(join(output, `record-option-set-${language}.png`), await page.screenshot());
  await record('option-set-submitted', { optionDom, optionRoutes, optionCommentsStatus, commentShell, optionPictureBeforeSave, optionPictureAfterSave });

  // 2. Publish model-free plan via job-api@3 (still carrying signoff + reopen subjects) and ask checkpoint on the same standing owner window
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

  // #1229: fresh checkpoint asks refuse JOB_REQUEST_INVALID; the plan record renders in comment mode without a checkpoint form,
  // while historical checkpoint acts remain readable via consumer fetch-act and parseRecordAct.
  const askCpRes = await fetch(`${recordHost.origin}/jobs/${recordHost.session.jobId}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      schema: JOB_API_V3_SCHEMA,
      jobId: recordHost.session.jobId,
      requestId: randomUUID(),
      verb: 'ask',
      expectedGeneration: pubPlan.generation,
      idempotencyKey: 'browser-ask-checkpoint',
      publicationId: planPublication.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'seethrough' },
    }),
  });
  const askCp = (await askCpRes.json()) as JobApiResponseV3;

  const askSignoffRes = await fetch(`${recordHost.origin}/jobs/${recordHost.session.jobId}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      schema: JOB_API_V3_SCHEMA,
      jobId: recordHost.session.jobId,
      requestId: randomUUID(),
      verb: 'ask',
      expectedGeneration: pubPlan.generation,
      idempotencyKey: 'browser-ask-signoff',
      publicationId: planPublication.publicationId,
      subject: { kind: 'signoff', stage: 'rigging-interview' },
    }),
  });
  const askSignoff = (await askSignoffRes.json()) as JobApiResponseV3;

  const askReopenRes = await fetch(`${recordHost.origin}/jobs/${recordHost.session.jobId}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      schema: JOB_API_V3_SCHEMA,
      jobId: recordHost.session.jobId,
      requestId: randomUUID(),
      verb: 'ask',
      expectedGeneration: pubPlan.generation,
      idempotencyKey: 'browser-ask-reopen',
      publicationId: planPublication.publicationId,
      subject: { kind: 'reopen', stage: 'plan-approved' },
    }),
  });
  const askReopen = (await askReopenRes.json()) as JobApiResponseV3;

  await wait(
    `document.body.dataset.ready === 'true' &&
     document.getElementById('package-title')?.textContent===${JSON.stringify(planPublication.label)} &&
     !!document.getElementById('send-comments') && !document.getElementById('send-comments').hidden`,
    'plan displayed in comment mode on normal owner URL',
  );

  // #715 / #796 / #989 / #1227 / #1228 / #1229: shared title; declared checkpoint, reopen and signoff subjects render no form or button; new asks refuse.
  const planDom = await page.evaluate<{
    sentinel: string;
    lang: string;
    headerTitle: string;
    sourceBinding: Record<string, unknown>;
    stageHidden: boolean;
    rigCanvasCount: number;
    formCount: number;
    retiredRecordDomCount: number;
    reopenButtonCount: number;
    signoffButtonCount: number;
  }>(`(async()=>{
    const sourceBinding = await (await fetch(${JSON.stringify(`/jobs/${recordHost.session.jobId}/publications/${planPublication.publicationId}/instances/${planPublication.instanceKey}/api/review`)})).json().then(body=>body.recordSource);
    const stage = document.getElementById('stage-layout');
    const reopenButtons = [...document.querySelectorAll('button')].filter(
      b => b.dataset.jobText === 'job.reopen' || b.textContent === 'Reopen stage' || b.textContent === '단계 다시 열기',
    );
    const signoffButtons = [...document.querySelectorAll('button')].filter(
      b => b.dataset.jobText === 'job.signoff' || b.textContent === 'Save stage approval' || b.textContent === '단계 승인 저장',
    );
    return {
      sentinel: globalThis.__jobRecordOwnerSentinel,
      lang: document.documentElement.lang,
      headerTitle: document.querySelector('#package-title').textContent,
      sourceBinding,
      stageHidden: !!stage && (stage.hidden || getComputedStyle(stage).display === 'none'),
      rigCanvasCount: document.querySelectorAll('#rig-root canvas').length,
      formCount: document.querySelectorAll('form[data-job-ask]').length,
      retiredRecordDomCount: document.querySelectorAll('[id="job-record-asks"], [id="workspace-pending-record-ask"]').length,
      reopenButtonCount: reopenButtons.length,
      signoffButtonCount: signoffButtons.length,
    };
  })()`);

  assert.equal(planDom.sentinel, documentSentinel, 'standing owner window swapped without document reload');
  assert.equal(navigationUrls.length, 1);
  assert.equal(planDom.lang, language);
  assert.equal(planDom.headerTitle, planPublication.label);
  assert.deepEqual(planDom.sourceBinding, planPublication.source);
  assert.equal(
    planPublication.source.subjects.some(s => s.kind === 'checkpoint' && s.checkpointId === 'seethrough'),
    true,
    'plan publication still carries checkpoint subject',
  );
  assert.equal(
    planPublication.source.subjects.some(s => s.kind === 'reopen' && s.stage === 'plan-approved'),
    true,
    'plan publication still carries reopen subject',
  );
  assert.equal(
    planPublication.source.subjects.some(s => s.kind === 'signoff' && s.stage === 'rigging-interview'),
    true,
    'plan publication still carries signoff subject',
  );
  assert.equal(Object.hasOwn(planDom.sourceBinding, 'package'), false);
  assert.equal(Object.hasOwn(planDom.sourceBinding, 'model'), false);
  assert.equal(Object.hasOwn(planDom.sourceBinding, 'selector'), false);
  assert.equal(planPublication.source.record.sha256,projectSha);
  assert.equal(planDom.rigCanvasCount, 0);
  assert.equal(planDom.formCount, 0, '#1229: plan publication carrying checkpoint, reopen and signoff subjects renders no record form');
  assert.equal(planDom.retiredRecordDomCount, 0, '#1229: retired #job-record-asks and #workspace-pending-record-ask are absent');
  assert.equal(planDom.reopenButtonCount, 0, 'Bar 1: plan publication carrying reopen subjects renders no reopen button');
  assert.equal(planDom.signoffButtonCount, 0, '#1228: plan publication carrying signoff subjects renders no signoff button');
  assert.equal(askCpRes.status, 400, '#1229: new checkpoint ask returns HTTP 400');
  assert.equal(askCp.ok, false);
  if (askCp.ok) throw new Error('Expected checkpoint ask to be refused');
  assert.equal(askCp.error.code, 'JOB_REQUEST_INVALID');
  assert.equal(askCp.error.message, 'Unknown job verb: ask');
  assert.equal(askSignoffRes.status, 400, '#1227: new signoff ask returns HTTP 400');
  assert.equal(askSignoff.ok, false);
  if (askSignoff.ok) throw new Error('Expected signoff ask to be refused');
  assert.equal(askSignoff.error.code, 'JOB_REQUEST_INVALID');
  assert.equal(askSignoff.error.message, 'Unknown job verb: ask');
  assert.equal(askReopenRes.status, 400, 'Bar 2: new reopen ask returns HTTP 400');
  assert.equal(askReopen.ok, false);
  if (askReopen.ok) throw new Error('Expected reopen ask to be refused');
  assert.equal(askReopen.error.code, 'JOB_REQUEST_INVALID');
  assert.equal(askReopen.error.message, 'Unknown job verb: ask');
  await runRecordBrowserPreflightSetupCheck();
  const expectedCpStep = planSteps.find(step => step.id === 'seethrough');
  assert.ok(expectedCpStep, 'declared seethrough step exists in planSteps');

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

  const checkpointWords = '';
  assert.equal(await page.evaluate(`document.querySelectorAll('textarea[name="note"],input[name="note"]').length`), 0);
  await writeFile(join(output, `record-plan-${language}.png`), await page.screenshot());

  // Seed a historical record checkpoint act (act@4) so authenticated consumer fetch-act and parseRecordAct remain verified end-to-end.
  seedHistoricalCheckpointAct(recordHost.session, {
    publicationId: planPublication.publicationId,
    pageId: 'historical-record-page',
    displayedNonce: 'historical-record-nonce',
    expectedGeneration: recordHost.session.status().generation,
    submissionId: 'historical-record-cp',
    checkpointId: 'seethrough',
    value: { checkpointId: 'seethrough', outcome: 'pass', words: checkpointWords },
  });

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
  assert.equal(actEvents.length, 3);

  const fetchedActs: Record<string, JobRecordAct | JobCommentsAct | JobCommentOnlyAct> = {};
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
    const kind = event.act.kind;
    const parse = kind === 'comments' ? parseCommentOnlyAct : kind === 'interview-picks' ? parseCommentsAct : parseRecordAct;
    const expectedSchema = kind === 'comments' ? JOB_COMMENT_ONLY_ACT_SCHEMA : kind === 'interview-picks' ? JOB_COMMENTS_ACT_SCHEMA : JOB_RECORD_ACT_SCHEMA;
    const rawBytes = await rawFetchRes.text();
    const rawParsed = parse(JSON.parse(rawBytes));
    const envelopeParsed = parse(jsonFetched.value);
    assert.deepEqual(rawParsed, envelopeParsed);
    assert.equal(envelopeParsed.schema, expectedSchema);
    assert.equal(rawBytes, JSON.stringify(jsonFetched.value));
    assert.deepEqual(envelopeParsed.authority, {
      actor: 'human',
      channel: 'review-ui',
      reviewer: { id: 'declared-record-owner', role: 'owner' },
    });
    fetchedActs[envelopeParsed.kind] = envelopeParsed;
  }

  assert.equal((fetchedActs.comments?.source as JobRecordAct['source'] | undefined)?.subject, 'option-set');
  assert.deepEqual(fetchedActs.comments?.value, {
    comments: [{ text: optionCommentText }],
  });

  assert.equal((fetchedActs['interview-picks']?.source as JobRecordAct['source'] | undefined)?.subject, 'option-set');
  assert.deepEqual(fetchedActs['interview-picks']?.value, {
    questionId: 'bones',
    selections: [
      { itemId: 'chains', optionId: 'keep', otherText: null },
      { itemId: 'placement', optionId: 'keep', otherText: null },
      { itemId: 'length', optionId: 'keep', otherText: null },
    ],
    note: existingNote,
    comments: [],
  });

  assert.equal((fetchedActs.checkpoint?.source as JobRecordAct['source'] | undefined)?.subject, 'plan');
  assert.deepEqual(fetchedActs.checkpoint?.value, {
    checkpointId: 'seethrough',
    planStepId: 'seethrough',
    outcome: 'pass',
    words: checkpointWords,
  });

  assert.equal(fetchedActs.signoff, undefined);
  assert.equal(fetchedActs.reopen, undefined);

  assert.deepEqual(await jobInputHashes(recordRoot), beforeRecordHashes, 'supplied record project files remain immutable');
  await record('record-acts-verified', {
    planDom,
    planRoutes,
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
    `document.getElementById('package-title')?.textContent===${JSON.stringify(pkgPubBody.value.label)}&&!!document.querySelector('#rig-root canvas')`,
    'package normal entry rendered with canvas',
  );

  const pkgDom = await page.evaluate<{
    headerTitle: string;
    visibleModelHash: string|null;
    hasPackageField: boolean;
    hasModelField: boolean;
    canvasCount: number;
  }>(`(async()=>{
    const source=await (await fetch(${JSON.stringify(`/jobs/${pkgHost.session.jobId}/publications/${pkgPubBody.value.publicationId}/instances/${pkgPubBody.value.instanceKey}/api/review`)})).json();
    const visible=JSON.parse(document.getElementById('provenance-full').textContent);
    return {
      headerTitle: document.querySelector('#package-title').textContent,
      hasPackageField:source.manifest?.id===${JSON.stringify(pkgPubBody.value.source.package.id)},
      hasModelField:source.reviewedSource?.rig?.sha256===${JSON.stringify(pkgPubBody.value.source.model.sha256)},
      visibleModelHash:visible.reviewedSource?.rig?.sha256??null,
      canvasCount: document.querySelectorAll('#rig-root canvas').length,
    };
  })()`);
  assert.equal(pkgDom.headerTitle, pkgPubBody.value.label);
  assert.equal(pkgDom.hasPackageField, true);
  assert.equal(pkgDom.hasModelField, true);
  assert.equal(pkgDom.visibleModelHash,pkgPubBody.value.source.model.sha256);
  assert.ok(pkgDom.canvasCount >= 1);

  // #796 / 368ffec shared-screen refusal: no model/reference/pending dialog names JOB_MODEL_MISSING (web/job-rig-screen.ts:54).
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
    `document.querySelector('#workspace-act-row #review-message')?.title.includes('JOB_MODEL_MISSING') ||
      document.querySelector('#workspace-act-row #review-message')?.textContent?.includes('JOB_MODEL_MISSING')`,
    'model-less package publication names JOB_MODEL_MISSING',
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
