import { realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts, jobAskBatchLimit, parseJobRequestV3 } from '../src/job-api.ts';
import { JOB_API_V3_SCHEMA, JOB_CAPABILITIES_V3, type NextValueV3, type PendingAskV3 } from '../src/job-contract.ts';
import type { JobStore } from '../src/job-store.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { createSyntheticPlanRecordWorkspace, createSyntheticRecordReader } from './helpers/job-record-fixture.ts';

// Review #963: one `ask-batch` runs the record freshness check once for every listed subject.
// Review-side synthetic reader only; no installed Create consumer conformance claim.

async function batchFixture(prefix: string) {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  const root = join(scratch, 'input');
  await mkdir(root);
  // #1227: checkpoint until #1229 retires record asks
  const steps = [
    { id: 'step_layout', hash: '1'.repeat(64) },
    { id: 'step_weights', hash: '2'.repeat(64) },
    { id: 'step_motion', hash: '3'.repeat(64) },
  ];
  const workspace = createSyntheticPlanRecordWorkspace(root, { steps, subjects: steps.map(step => ({
    kind: 'checkpoint' as const, checkpointId: step.id })) });
  const reader = createSyntheticRecordReader({ onPlan: () => workspace.context });
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
  return { scratch, root, workspace, reader, session, store, call, batch, snapshot, publicationId,
    dispose: async () => { session.dispose(); await rm(scratch, { recursive: true, force: true }); } };
}

test('#963 one ask-batch creates N index-aligned asks, N pending events and generation +N with two reader calls', async () => {
  const batched = await batchFixture('review-ask-batch-');
  const single = await batchFixture('review-ask-single-');
  try {
    const subjects = batched.workspace.context.subjects;
    expect(subjects.length).toBe(3);

    const singleBefore = single.reader.calls.length, singleGeneration = single.session.status().generation;
    for (const [index, subject] of subjects.entries()) {
      const asked = await single.call({ verb: 'ask', expectedGeneration: single.session.status().generation,
        idempotencyKey: 'single-' + index, publicationId: single.publicationId, subject });
      expect(asked.ok).toBe(true);
    }
    const singleCalls = single.reader.calls.length - singleBefore;
    expect(singleCalls).toBe(2 * subjects.length);
    expect(single.session.status().generation).toBe(singleGeneration + subjects.length);

    const before = batched.reader.calls.length, generation = batched.session.status().generation;
    const eventsBefore = batched.store.get(batched.session.jobId).data.events.length;
    const response = await batched.batch(subjects);
    expect(response).toMatchObject({ schema: JOB_API_V3_SCHEMA, verb: 'ask-batch', ok: true });
    const batchCalls = batched.reader.calls.length - before;
    expect(batchCalls).toBe(2);
    expect(batched.reader.calls.slice(before).map(call => call.phase)).toEqual(['inventory', 'retained']);

    const asks = response.value.asks as PendingAskV3[];
    expect(asks.map(ask => ask.subject)).toEqual([...subjects]);
    expect(new Set(asks.map(ask => ask.askId)).size).toBe(subjects.length);
    expect(asks.every(ask => ask.publicationId === batched.publicationId && ask.status === 'pending')).toBe(true);
    expect(batched.session.status().generation).toBe(generation + subjects.length);
    expect(response.generation).toBe(generation + subjects.length);
    expect(batched.session.status().pending.map(ask => ask.askId)).toEqual(asks.map(ask => ask.askId));

    const events = batched.store.get(batched.session.jobId).data.events.slice(eventsBefore) as
      { type: string; generation: number; ask: PendingAskV3 }[];
    expect(events.map(event => event.type)).toEqual(subjects.map(() => 'pending'));
    expect(events.map(event => event.ask)).toEqual(asks);
    expect(events.map(event => event.generation)).toEqual(subjects.map((_, index) => generation + 1 + index));

    // The same subjects asked singly and in one batch bind the same sources.
    expect(asks.map(ask => ask.source)).toEqual(single.session.status().pending.map(ask => ask.source));
    console.log(`#963 reader calls: ${subjects.length} single asks = ${singleCalls}, one batch of ${subjects.length} = ${batchCalls}`);
  } finally {
    await batched.dispose();
    await single.dispose();
  }
});

test('#963 an invalid subject refuses the whole batch under its index and leaves the store unchanged', async () => {
  const fixture = await batchFixture('review-ask-batch-atomic-');
  try {
    const subjects = fixture.workspace.context.subjects;
    const before = fixture.snapshot(), calls = fixture.reader.calls.length;

    const undeclared = await fixture.batch([subjects[0]!, subjects[1]!, { kind: 'checkpoint', checkpointId: 'undeclared_step' }, subjects[2]!]);
    expect(undeclared).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID' } });
    expect(undeclared.error.message).toBe('subjects[2]: JOB_ASK_INVALID');
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.reader.calls.length).toBe(calls);

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

test('#963 a stale work root or a tampered retained snapshot refuses the batch and creates nothing', async () => {
  const fixture = await batchFixture('review-ask-batch-stale-');
  try {
    const subjects = fixture.workspace.context.subjects;
    const before = fixture.snapshot();
    const update = fixture.store.update.bind(fixture.store);
    const patchUpdate = (change: () => void) => {
      fixture.store.update = ((...args: Parameters<typeof update>) => {
        fixture.store.update = update;
        // The change lands after the freshness check and before the transaction's re-check.
        change();
        return update(...args);
      }) as typeof update;
    };

    // Source changes between the freshness check and the commit.
    const spec = join(fixture.root, 'inputs/spec.json');
    const original = await Bun.file(spec).text();
    patchUpdate(() => { writeFileSync(spec, original + ' '); });
    const stale = await fixture.batch(subjects, 'stale');
    expect(fixture.store.update).toBe(update);
    expect(stale).toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_MISMATCH' } });
    expect(stale.error.message.startsWith('subjects[')).toBe(false);
    expect(fixture.snapshot()).toEqual(before);
    await writeFile(spec, original);

    // Retained snapshot tampered between the freshness check and the commit.
    const retained = fixture.session.retainedSourceV3(fixture.publicationId);
    const sealed = join(retained.snapshotRoot, 'inputs/spec.json');
    const sealedBytes = await Bun.file(sealed).text();
    patchUpdate(() => { writeFileSync(sealed, sealedBytes + ' '); });
    const tamperedInCommit = await fixture.batch(subjects, 'tampered-commit');
    expect(fixture.store.update).toBe(update);
    expect(tamperedInCommit).toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_UNRETAINABLE' } });
    expect(fixture.snapshot()).toEqual(before);

    // Retained snapshot already tampered before the batch.
    const calls = fixture.reader.calls.length;
    const tampered = await fixture.batch(subjects, 'tampered');
    expect(tampered).toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_UNRETAINABLE' } });
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.snapshot()).toEqual(before);
    expect((await readdir(retained.snapshotRoot)).length).toBeGreaterThan(0);
  } finally { await fixture.dispose(); }
});

test('#963 a replayed batch returns the same asks without reading the publisher again', async () => {
  const fixture = await batchFixture('review-ask-batch-replay-');
  try {
    const subjects = fixture.workspace.context.subjects.slice(0, 3);
    const generation = fixture.session.status().generation;
    const first = await fixture.batch(subjects, 'replay');
    expect(first.ok).toBe(true);
    const calls = fixture.reader.calls.length, after = fixture.snapshot();
    const replayed = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'replay',
      publicationId: fixture.publicationId, subjects });
    expect(replayed.value).toEqual(first.value);
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
  // #1227: checkpoint until #1229 retires record asks
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

test('#1022 a replayed batch whose asks were superseded refuses by index and names the head', async () => {
  const fixture = await batchFixture('review-ask-batch-superseded-');
  try {
    const subjects = fixture.workspace.context.subjects.slice(0, 2);
    const generation = fixture.session.status().generation;
    const first = await fixture.batch(subjects, 'superseded');
    expect(first.ok).toBe(true);
    const republished = await fixture.call({ verb: 'publish', expectedGeneration: fixture.session.status().generation, idempotencyKey: 'publish-again',
      result: fixture.workspace.result, freeze: { kind: 'producer-held', holdId: 'synthetic', record: fixture.workspace.record } });
    expect(republished.ok).toBe(true);
    const before = fixture.snapshot();
    const replayed = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'superseded',
      publicationId: fixture.publicationId, subjects });
    expect(replayed).toMatchObject({ ok: false, error: { code: 'JOB_ASK_SUPERSEDED',
      message: `subjects[0]: ask ${first.value.asks[0].askId} is superseded; head ${republished.value.publicationId}` } });
    expect(fixture.snapshot()).toEqual(before);
  } finally { await fixture.dispose(); }
});
