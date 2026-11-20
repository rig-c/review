import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import {
  assertEqualRecordContexts, buildRecordSource, createJobHostPorts, parseCommentsAct, parseJobRequestV3,
  parseRecordAct, parseRecordPublishedContext, parseRecordSource, serializeRecordSourceDigestPayload,
} from '../src/job-api.ts';
import {
  JOB_API_V3_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, JOB_RECORD_SOURCE_SCHEMA,
  type JobRecordReopenSubject, type PlanContext,
} from '../src/job-contract.ts';
import { JobSession } from '../src/job-session.ts';
import { createSyntheticPlanRecordWorkspace, createSyntheticRecordReader } from './helpers/job-record-fixture.ts';

const stageOnly = { kind: 'reopen', stage: 'plan-approved' } as const;
const reason = '  설계 근거를 다시 확인해 주세요.  ';
const declared: JobRecordReopenSubject = { ...stageOnly, reason };
const legacy = { kind: 'reopen', stage: 'design-interview' } as const;
const selection = { kind: 'plan' } as const;
const record = { path: 'project.json', sha256: 'a'.repeat(64) } as const;
const context: PlanContext = {
  label: 'Synthetic reopen plan',
  parts: { name: '@rig-c/parts', version: '2.25.1', integrity: 'sha512-synthetic' },
  inputs: [],
  files: [record],
  plan: { steps: [] },
  subjects: [stageOnly],
};
const sourceFrom = (subjects: PlanContext['subjects']) =>
  buildRecordSource({ record, selection, context: { ...context, subjects } });
const digestPayload = (subjects: PlanContext['subjects']) => JSON.stringify({
  schema: JOB_RECORD_SOURCE_SCHEMA, record, selection, inputs: [], optionSet: null, optionSetFile: null,
  plan: { steps: [] }, subjects, files: [record],
});
const ask = {
  schema: JOB_API_V3_SCHEMA, jobId: 'job', requestId: 'request', verb: 'ask',
  expectedGeneration: 1, idempotencyKey: 'ask', publicationId: 'publication',
} as const;

test('#989 an absent reopen reason preserves the exact legacy subject, request and source digest', () => {
  const source = sourceFrom([stageOnly]);
  const payload = digestPayload([stageOnly]);
  expect(serializeRecordSourceDigestPayload(source)).toBe(payload);
  expect(source.sourceHash).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(JSON.stringify(parseRecordSource(source))).toBe(JSON.stringify(source));
  const parsed = parseJobRequestV3({ ...ask, subject: stageOnly });
  expect(parsed).toEqual({ ...ask, subject: stageOnly });
  expect(parsed.verb === 'ask' && Object.hasOwn(parsed.subject, 'reason')).toBe(false);
});

test('#989 reopen reason round-trips verbatim and binds to the sealed record context and source hash', () => {
  const parsed = parseRecordPublishedContext({ ...context, subjects: [
    { reason, stage: stageOnly.stage, kind: stageOnly.kind },
  ] }, selection);
  expect(parsed.subjects).toEqual([declared]);
  const source = sourceFrom([declared]);
  const payload = digestPayload([declared]);
  expect(serializeRecordSourceDigestPayload(source)).toBe(payload);
  expect(source.sourceHash).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(source.sourceHash).not.toBe(sourceFrom([stageOnly]).sourceHash);
  expect(parseRecordSource(JSON.parse(JSON.stringify(source)))).toEqual(source);
  expect(() => parseRecordSource({ ...source, subjects: [stageOnly] })).toThrow('JOB_SOURCE_MISMATCH');
  expect(() => assertEqualRecordContexts(parsed, context)).toThrow('JOB_SOURCE_MISMATCH');
  expect(() => sourceFrom([declared, { ...stageOnly, reason: 'different' }])).toThrow('JOB_SOURCE_MISMATCH');
});

test('#989 malformed reopen reasons use the existing request and source refusals', () => {
  const atLimit = { ...stageOnly, reason: '가'.repeat(1024) };
  expect(parseJobRequestV3({ ...ask, subject: atLimit })).toMatchObject({ subject: atLimit });
  expect(sourceFrom([atLimit]).subjects).toEqual([atLimit]);
  for (const invalid of ['가'.repeat(1025), 42, null, undefined, '', 'bad\nline']) {
    const subject = { ...stageOnly, reason: invalid };
    expect(() => parseJobRequestV3({ ...ask, subject })).toThrow('JOB_REQUEST_INVALID');
    expect(() => parseJobRequestV3({ ...ask, verb: 'ask-batch', subjects: [legacy, subject] }))
      .toThrow('subjects[1]: JOB_REQUEST_INVALID');
    expect(() => parseRecordPublishedContext({ ...context, subjects: [subject] }, selection))
      .toThrow('JOB_SOURCE_MISMATCH');
  }
  expect(() => parseJobRequestV3({ ...ask, subject: { kind: 'signoff', stage: stageOnly.stage, reason } }))
    .toThrow('JOB_REQUEST_INVALID');
});

test('#989 single and batched asks bind the reason to the published stage and preserve legacy omissions', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-989-reopen-'));
  const root = join(scratch, 'project');
  await mkdir(root);
  const workspace = createSyntheticPlanRecordWorkspace(root, { subjects: [declared, legacy] });
  let readerSubjects = workspace.context.subjects;
  const { reader } = createSyntheticRecordReader({ onPlan: () => ({ ...workspace.context, subjects: readerSubjects }) });
  const session = new JobSession({ root, stateDir: join(scratch, 'state'), fingerprint: 'review-989',
    reviewer: { id: 'owner', role: 'owner' }, publicationMode: 'record-and-package', readRecordPublished: reader });
  try {
    const origin = 'http://127.0.0.1:19989', ports = createJobHostPorts(session, origin);
    const token = session.hostCredentials().agent;
    let sequence = 0;
    const call = async (body: object) => (await ports.handleJobApi(new Request(`${origin}/jobs/${session.jobId}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: `request-${++sequence}`,
        expectedGeneration: session.status().generation, idempotencyKey: `key-${sequence}`, ...body }),
    }))).json();
    const published = await call({ verb: 'publish', result: workspace.result,
      freeze: { kind: 'producer-held', holdId: 'hold', record: workspace.record } });
    expect(published).toMatchObject({ ok: true, value: { source: { subjects: [declared, legacy] } } });
    const { publicationId, source } = published.value;
    const expectedGeneration = session.status().generation;
    const single = { verb: 'ask', publicationId, expectedGeneration, idempotencyKey: 'replay', subject: declared };
    const first = await call(single);
    expect(first).toMatchObject({ ok: true, value: { subject: declared, source } });
    expect((await call(single)).value).toEqual(first.value);
    expect(await call({ ...single, subject: stageOnly }))
      .toMatchObject({ ok: false, error: { code: 'JOB_IDEMPOTENCY_CONFLICT' } });
    const batch = await call({ verb: 'ask-batch', publicationId, subjects: [stageOnly, legacy] });
    expect(batch).toMatchObject({ ok: true });
    expect(batch.value.asks.map((entry: { subject: unknown }) => entry.subject)).toEqual([stageOnly, legacy]);
    expect(batch.value.asks[0].source).toEqual(source);

    const before = session.status();
    expect(await call({ verb: 'ask', publicationId, subject: { ...stageOnly, reason: reason.trim() } }))
      .toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID' } });
    expect(await call({ verb: 'ask-batch', publicationId, subjects: [declared, { ...legacy, reason }] }))
      .toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID', message: 'subjects[1]: JOB_ASK_INVALID' } });
    readerSubjects = [stageOnly, legacy];
    expect(await call({ verb: 'ask', publicationId, subject: declared }))
      .toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_MISMATCH' } });
    expect(session.status()).toEqual(before);
  } finally {
    session.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('#989 reopen act decoders keep reason on the bound source and retain their existing value shapes', () => {
  const envelope = {
    actId: 'act', jobId: 'job', askId: 'ask', publicationId: 'publication', kind: 'reopen',
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'owner', role: 'owner' } },
    at: '2026-11-20T00:00:00.000Z',
  } as const;
  for (const subject of [stageOnly, declared]) {
    const source = sourceFrom([subject]);
    const v4 = { ...envelope, schema: JOB_RECORD_ACT_SCHEMA, source, value: { stage: subject.stage, words: '  그대로\n' } };
    const v6 = { ...envelope, schema: JOB_COMMENTS_ACT_SCHEMA, source, value: { stage: subject.stage, comments: [] } };
    expect(parseRecordAct(v4)).toEqual(v4);
    expect(parseCommentsAct(v6)).toEqual(v6);
    expect(() => parseRecordAct({ ...v4, value: { ...v4.value, reason } })).toThrow('JOB_ACT_INVALID');
    expect(() => parseCommentsAct({ ...v6, value: { ...v6.value, reason } })).toThrow('JOB_ACT_INVALID');
  }
});
