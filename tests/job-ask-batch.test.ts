import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts, jobAskBatchLimit, parseJobRequestV3, parseRecordSource, requestDigest } from '../src/job-api.ts';
import { JOB_API_V3_SCHEMA, JOB_CAPABILITIES_V3, type NextValueV3, type PendingAskV3 } from '../src/job-contract.ts';
import type { JobStore } from '../src/job-store.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { createSyntheticOptionSetsRecordWorkspace, createSyntheticRecordReader } from './helpers/job-record-fixture.ts';

// Review #963 / #1229 / #1230: fresh record asks and ask-batch requests refuse JOB_ASK_INVALID across all retired record subjects,
// while request parsing bounds, head checks and pre-refusal stored ask-batch replay receipts remain intact.

async function batchFixture(prefix: string) {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  const root = join(scratch, 'input');
  await mkdir(root);
  const workspace = createSyntheticOptionSetsRecordWorkspace(root, { count: 3 });
  const reader = createSyntheticRecordReader({ onOption: () => workspace.context });
  const session = new JobSession({ root, stateDir: join(scratch, 'state'), fingerprint: 'a'.repeat(64),
    reviewer: { id: 'synthetic-owner', role: 'owner' }, publicationMode: 'record-and-package', readRecordPublished: reader.reader });
  const origin = 'http://127.0.0.1:19963', ports = createJobHostPorts(session, origin), credentials = session.hostCredentials();
  let sequence = 0;
  const call = async (body: object) => (await ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credentials.agent },
    body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'request-' + (++sequence), ...body }),
  }))).json();
  const published = await call({ verb: 'publish', expectedGeneration: 0, idempotencyKey: 'publish',
    result: workspace.result, freeze: { kind: 'producer-held', holdId: 'synthetic', record: workspace.record } });
  expect(published.ok).toBe(true);
  const publicationId: string = published.value.publicationId;
  const store = (session as unknown as { store: JobStore<{ events: unknown[] }> }).store;
  const snapshot = () => { const row = store.get(session.jobId); return { revision: row.revision, data: JSON.stringify(row.data) }; };
  const batch = (subjects: readonly object[], idempotencyKey = 'batch') => call({ verb: 'ask-batch',
    expectedGeneration: session.status().generation, idempotencyKey, publicationId, subjects });
  function seedHistoricalBatch(subjects: readonly { kind: 'interview-picks'; questionId: string; setId: string }[], idempotencyKey: string, expectedGeneration: number) {
    const internal = session as unknown as {
      store: JobStore<any>;
      event(data: unknown, value: unknown): void;
      notify(): void;
    };
    let asks: PendingAskV3[] = [];
    internal.store.update(session.jobId, null, current => {
      const data = current.data;
      const source = parseRecordSource(data.publications[publicationId].retained.source);
      asks = subjects.map(subject => {
        data.generation++;
        const ask: PendingAskV3 = { askId: crypto.randomUUID(), publicationId, status: 'pending', subject, source };
        data.asks[ask.askId] = ask;
        internal.event(data, { type: 'pending', ask });
        return ask;
      });
      const parsed = parseJobRequestV3({
        schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'seed-' + idempotencyKey,
        verb: 'ask-batch', expectedGeneration, idempotencyKey, publicationId, subjects,
      }) as unknown as Record<string, unknown>;
      const { requestId: _requestId, ...semantic } = parsed;
      data.replays['agent:' + idempotencyKey] = { digest: requestDigest(semantic), value: { asks } };
      return { data };
    });
    internal.notify();
    return { asks };
  }
  return { scratch, root, workspace, reader, session, store, call, batch, seedHistoricalBatch, snapshot, publicationId,
    dispose: async () => { session.dispose(); await rm(scratch, { recursive: true, force: true }); } };
}

test('#963 / #1229 / #1230 fresh single record asks and ask-batch requests refuse JOB_ASK_INVALID without calling the reader or mutating generation', async () => {
  const fixture = await batchFixture('review-ask-batch-refusal-');
  try {
    const subjects = fixture.workspace.context.subjects;
    expect(subjects.length).toBe(3);
    const before = fixture.snapshot(), calls = fixture.reader.calls.length, generation = fixture.session.status().generation;

    for (const [index, subject] of subjects.entries()) {
      const asked = await fixture.call({ verb: 'ask', expectedGeneration: generation,
        idempotencyKey: 'single-' + index, publicationId: fixture.publicationId, subject });
      expect(asked).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID' } });
    }
    const response = await fixture.batch(subjects);
    expect(response).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID', message: 'subjects[0]: JOB_ASK_INVALID' } });
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.session.status().generation).toBe(generation);
    expect(fixture.session.status().pending).toEqual([]);
    expect(fixture.snapshot()).toEqual(before);
  } finally {
    await fixture.dispose();
  }
});

test('#963 malformed, duplicate, out-of-bounds and retired subjects refuse the whole batch under their index and leave the store unchanged', async () => {
  const fixture = await batchFixture('review-ask-batch-atomic-');
  try {
    const subjects = fixture.workspace.context.subjects;
    const before = fixture.snapshot(), calls = fixture.reader.calls.length;

    for (const [key, retired] of [
      ['picks', subjects[0]!],
      ['checkpoint', { kind: 'checkpoint', checkpointId: 'step_layout' }],
      ['signoff', { kind: 'signoff', stage: 'plan-approved' }],
      ['reopen', { kind: 'reopen', stage: 'plan-approved' }],
    ] as const) {
      const refused = await fixture.batch([retired], 'retired-' + key);
      expect(refused).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID', message: 'subjects[0]: JOB_ASK_INVALID' } });
    }

    const malformed = await fixture.batch([subjects[0]!, { kind: 'no-such-subject' }], 'malformed');
    expect(malformed.ok).toBe(false);
    expect(malformed.error.message.startsWith('subjects[1]: ')).toBe(true);
    expect(fixture.snapshot()).toEqual(before);

    const duplicate = await fixture.batch([subjects[0]!, subjects[1]!, subjects[0]!], 'duplicate');
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'subjects[2]: duplicate of subjects[0]' } });
    for (const count of [0, jobAskBatchLimit + 1]) {
      const sized = await fixture.batch(Array.from({ length: count }, (_, index) => ({ kind: 'checkpoint', checkpointId: 'step_' + index })), 'size-' + count);
      expect(sized).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'JOB_REQUEST_INVALID' } });
    }
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.reader.calls.length).toBe(calls);
  } finally { await fixture.dispose(); }
});

test('#963 non-head publications refuse ask-batch with JOB_ACT_SOURCE_STALE before subject binding', async () => {
  const fixture = await batchFixture('review-ask-batch-stale-');
  try {
    const subjects = fixture.workspace.context.subjects;
    const republished = await fixture.call({ verb: 'publish', expectedGeneration: fixture.session.status().generation, idempotencyKey: 'republish',
      result: fixture.workspace.result, freeze: { kind: 'producer-held', holdId: 'synthetic-2', record: fixture.workspace.record } });
    expect(republished.ok).toBe(true);
    const before = fixture.snapshot(), calls = fixture.reader.calls.length;
    const stale = await fixture.call({ verb: 'ask-batch', expectedGeneration: fixture.session.status().generation,
      idempotencyKey: 'stale-head', publicationId: fixture.publicationId, subjects });
    expect(stale).toMatchObject({ ok: false, error: { code: 'JOB_ACT_SOURCE_STALE' } });
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.snapshot()).toEqual(before);
  } finally { await fixture.dispose(); }
});

test('#963 a replayed historical batch returns the same asks without reading the publisher again', async () => {
  const fixture = await batchFixture('review-ask-batch-replay-');
  try {
    const subjects = fixture.workspace.context.subjects.slice(0, 3);
    const generation = fixture.session.status().generation;
    const seeded = fixture.seedHistoricalBatch(subjects, 'replay', generation);
    const calls = fixture.reader.calls.length, after = fixture.snapshot();
    const replayed = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'replay',
      publicationId: fixture.publicationId, subjects });
    expect(replayed.value).toEqual(seeded);
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.snapshot()).toEqual(after);

    const conflict = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'replay',
      publicationId: fixture.publicationId, subjects: subjects.slice(0, 2) });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'JOB_IDEMPOTENCY_CONFLICT' } });

    // Each ask inside the stored batch receipt is a durable copy: evidence its publication does not carry refuses.
    const store = fixture.store as unknown as JobStore<{ replays: Record<string, { value: { asks: { source: object }[] } }> }>;
    store.update(fixture.session.jobId, null, current => {
      const data = structuredClone(current.data);
      Object.assign(data.replays['agent:replay'].value.asks[1].source, { checkpointEvidence: [] });
      return { data };
    });
    const tampered = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'replay',
      publicationId: fixture.publicationId, subjects });
    expect(tampered).toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_MISMATCH' } });
  } finally { await fixture.dispose(); }
});

test('#963 next reports askBatch among the V3 capabilities and ask-batch parses only under job-api@3', async () => {
  const fixture = await batchFixture('review-ask-batch-next-');
  try {
    const next = await fixture.call({ verb: 'next', after: null, waitMs: 0 });
    expect(next.value.capabilities).toEqual(JOB_CAPABILITIES_V3);
    expect(next.value.capabilities.askBatch).toBe(true);
    expect(next.value.capabilities.progress).toBe(true);
  } finally { await fixture.dispose(); }
  // Request schema parsing still recognizes historical record subject shapes before bindJobRecordAsk refuses fresh asks.
  const request = { schema: JOB_API_V3_SCHEMA, jobId: 'job-1', requestId: 'request-1', verb: 'ask-batch',
    expectedGeneration: 0, idempotencyKey: 'key', publicationId: 'publication-1', subjects: [{ kind: 'checkpoint', checkpointId: 'step_layout' }] };
  expect(parseJobRequestV3(request)).toEqual(request as never);
  expect(() => parseJobRequestV3({ ...request, subject: request.subjects[0] })).toThrow('JOB_REQUEST_INVALID');
  expect(() => parseJobRequestV3({ ...request, subjects: request.subjects[0] })).toThrow('JOB_REQUEST_INVALID');
});

test('#963 a package-retained head refuses ask-batch with JOB_REQUEST_INVALID and creates nothing', async () => {
  const f = await jobFixture();
  const stateDir = await mkdtemp(join(realpathSync(tmpdir()), 'review-ask-batch-package-'));
  const session = new JobSession({ root: f.root, stateDir, fingerprint: 'b'.repeat(64), reviewer: { id: 'owner', role: 'owner' },
    publicationMode: 'record-and-package', readPublished: async () => f.getContext() });
  try {
    const original = await f.publishRequest() as unknown as { result: object };
    const publication = await session.execute({ ...original, schema: JOB_API_V3_SCHEMA, jobId: session.jobId, expectedGeneration: 0,
      result: { ...original.result, kind: 'package' } } as never, new AbortController().signal) as { publicationId: string };
    const next = await session.execute({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'next', verb: 'next',
      after: null, waitMs: 0 }, new AbortController().signal) as NextValueV3;
    expect((next.capabilities as { askBatch?: boolean } | undefined)?.askBatch).toBe(true);
    const generation = session.status().generation;
    const refused = session.execute({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'batch', verb: 'ask-batch',
      expectedGeneration: generation, idempotencyKey: 'batch', publicationId: publication.publicationId,
      subjects: [{ kind: 'review-verdict', stage: 'rig-review' }] }, new AbortController().signal);
    await expect(refused).rejects.toMatchObject({ code: 'JOB_REQUEST_INVALID' });
    expect(session.status().generation).toBe(generation);
    expect(session.status().pending).toEqual([]);
  } finally {
    session.dispose();
    await f.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('#1022 a replayed historical batch whose asks were superseded refuses by index and names the head', async () => {
  const fixture = await batchFixture('review-ask-batch-superseded-');
  try {
    const subjects = fixture.workspace.context.subjects.slice(0, 2);
    const generation = fixture.session.status().generation;
    const seeded = fixture.seedHistoricalBatch(subjects, 'superseded', generation);
    const republished = await fixture.call({ verb: 'publish', expectedGeneration: fixture.session.status().generation, idempotencyKey: 'publish-again',
      result: fixture.workspace.result, freeze: { kind: 'producer-held', holdId: 'synthetic', record: fixture.workspace.record } });
    expect(republished.ok).toBe(true);
    const before = fixture.snapshot();
    const replayed = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'superseded',
      publicationId: fixture.publicationId, subjects });
    expect(replayed).toMatchObject({ ok: false, error: { code: 'JOB_ASK_SUPERSEDED',
      message: `subjects[0]: ask ${seeded.asks[0]!.askId} is superseded; head ${republished.value.publicationId}` } });
    expect(fixture.snapshot()).toEqual(before);
  } finally { await fixture.dispose(); }
});
