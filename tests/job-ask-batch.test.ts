import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts, parseJobRequest, parseRecordSource, requestDigest } from '../src/job-api.ts';
import { JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_CAPABILITIES_V3, jobRawActMediaType, type PendingAskV3 } from '../src/job-contract.ts';
import type { JobStore } from '../src/job-store.ts';
import { seedHistoricalPicksAct } from './helpers/historical-picks-act.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { createSyntheticOptionSetsRecordWorkspace, createSyntheticRecordReader } from './helpers/job-record-fixture.ts';

const removedVerbError = (verb: 'ask' | 'ask-batch') => ({
  code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ' + verb,
});

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
  const request = (body: object, token = credentials.agent, accept = 'application/json') =>
    ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: accept },
      body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'request-' + (++sequence), ...body }),
    }));
  const call = async (body: object) => (await request(body)).json();
  const next = (after: string | null = null) => call({verb: 'next', after, waitMs: 0});
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
      const semantic = {schema: JOB_API_V3_SCHEMA, jobId: session.jobId, verb: 'ask-batch',
        expectedGeneration, idempotencyKey, publicationId, subjects};
      data.replays['agent:' + idempotencyKey] = {digest: requestDigest(semantic), value: {asks}};
      return { data };
    });
    internal.notify();
    return { asks };
  }
  return { scratch, root, workspace, reader, session, store, call, request, next, batch, seedHistoricalBatch, snapshot, publicationId,
    dispose: async () => { session.dispose(); await rm(scratch, { recursive: true, force: true }); } };
}

test('#963 / #1229 / #1230 removed single record asks and ask-batch requests refuse by name without calling the reader or mutating generation', async () => {
  const fixture = await batchFixture('review-ask-batch-refusal-');
  try {
    const subjects = fixture.workspace.context.subjects;
    expect(subjects.length).toBe(3);
    const before = fixture.snapshot(), calls = fixture.reader.calls.length, generation = fixture.session.status().generation;

    for (const [index, subject] of subjects.entries()) {
      const asked = await fixture.call({ verb: 'ask', expectedGeneration: generation,
        idempotencyKey: 'single-' + index, publicationId: fixture.publicationId, subject });
      expect(asked).toMatchObject({ ok: false, error: removedVerbError('ask') });
    }
    const response = await fixture.batch(subjects);
    expect(response).toMatchObject({ ok: false, error: removedVerbError('ask-batch') });
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.session.status().generation).toBe(generation);
    expect(fixture.session.status().pending).toEqual([]);
    expect(fixture.snapshot()).toEqual(before);
  } finally {
    await fixture.dispose();
  }
});

test('#963 the removed batch verb refuses before checking subject shape, duplicates or bounds and leave the store unchanged', async () => {
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
      expect(refused).toMatchObject({ ok: false, error: removedVerbError('ask-batch') });
    }

    const malformed = await fixture.batch([subjects[0]!, { kind: 'no-such-subject' }], 'malformed');
    expect(malformed).toMatchObject({ok: false, error: removedVerbError('ask-batch')});
    expect(fixture.snapshot()).toEqual(before);

    const duplicate = await fixture.batch([subjects[0]!, subjects[1]!, subjects[0]!], 'duplicate');
    expect(duplicate).toMatchObject({ ok: false, error: removedVerbError('ask-batch') });
    for (const count of [0, 33]) {
      const sized = await fixture.batch(Array.from({ length: count }, (_, index) => ({ kind: 'checkpoint', checkpointId: 'step_' + index })), 'size-' + count);
      expect(sized).toMatchObject({ ok: false, error: removedVerbError('ask-batch') });
    }
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.reader.calls.length).toBe(calls);
  } finally { await fixture.dispose(); }
});

test('#963 a stale publication has the same removed-verb refusal', async () => {
  const fixture = await batchFixture('review-ask-batch-stale-');
  try {
    const subjects = fixture.workspace.context.subjects;
    const republished = await fixture.call({ verb: 'publish', expectedGeneration: fixture.session.status().generation, idempotencyKey: 'republish',
      result: fixture.workspace.result, freeze: { kind: 'producer-held', holdId: 'synthetic-2', record: fixture.workspace.record } });
    expect(republished.ok).toBe(true);
    const before = fixture.snapshot(), calls = fixture.reader.calls.length;
    const stale = await fixture.call({ verb: 'ask-batch', expectedGeneration: fixture.session.status().generation,
      idempotencyKey: 'stale-head', publicationId: fixture.publicationId, subjects });
    expect(stale).toMatchObject({ ok: false, error: removedVerbError('ask-batch') });
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.snapshot()).toEqual(before);
  } finally { await fixture.dispose(); }
});

test('#963 historical batch events are readable without the publisher and corrupted receipts still refuse reads', async () => {
  const fixture = await batchFixture('review-ask-batch-replay-');
  try {
    const subjects = fixture.workspace.context.subjects.slice(0, 3);
    const generation = fixture.session.status().generation;
    const seeded = fixture.seedHistoricalBatch(subjects, 'replay', generation);
    const calls = fixture.reader.calls.length, after = fixture.snapshot();
    const replayed = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'replay',
      publicationId: fixture.publicationId, subjects });
    expect(replayed).toMatchObject({ok: false, error: removedVerbError('ask-batch')});
    const history = await fixture.next();
    expect(history.ok).toBe(true);
    expect(history.value.events.filter((event: {type: string}) => event.type === 'pending')
      .map((event: {ask: unknown}) => event.ask)).toEqual(seeded.asks);
    expect(fixture.reader.calls.length).toBe(calls);
    expect(fixture.snapshot()).toEqual(after);

    const conflict = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation, idempotencyKey: 'replay',
      publicationId: fixture.publicationId, subjects: subjects.slice(0, 2) });
    expect(conflict).toMatchObject({ ok: false, error: removedVerbError('ask-batch') });

    // Each ask inside the stored batch receipt is a durable copy: evidence its publication does not carry refuses.
    const store = fixture.store as unknown as JobStore<{ replays: Record<string, { value: { asks: { source: object }[] } }> }>;
    store.update(fixture.session.jobId, null, current => {
      const data = structuredClone(current.data);
      Object.assign(data.replays['agent:replay'].value.asks[1].source, { checkpointEvidence: [] });
      return { data };
    });
    expect(await fixture.next()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  } finally { await fixture.dispose(); }
});

test('#1225 next omits askBatch and both wire schemas refuse the removed verbs', async () => {
  const fixture = await batchFixture('review-ask-batch-next-');
  const packageFixture = await jobFixture();
  try {
    const next = await fixture.next();
    expect(next.value.capabilities).toEqual(JOB_CAPABILITIES_V3);
    expect(next.value.capabilities).not.toHaveProperty('askBatch');
    expect(next.value.capabilities.progress).toBe(true);
    const pkg = await packageFixture.publish();
    const before = packageFixture.session.status();
    for (const verb of ['ask', 'ask-batch'] as const) {
      const subject = {kind: 'checkpoint', checkpointId: 'step-one'};
      const request = {...packageFixture.base(), verb, expectedGeneration: before.generation,
        idempotencyKey: 'removed-verb', publicationId: pkg.publicationId,
        ...(verb === 'ask' ? {subject} : {subjects: [subject]})};
      for (const schema of [JOB_API_SCHEMA, JOB_API_V3_SCHEMA]) {
        expect(() => parseJobRequest({...request, schema}, schema)).toThrow(expect.objectContaining(removedVerbError(verb)));
      }
      for (const response of [
        await packageFixture.call(request),
        await fixture.request({verb}),
        await fixture.request({verb, schema: JOB_API_SCHEMA}),
      ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ok: false, error: removedVerbError(verb)});
      }
    }
    expect(packageFixture.session.status()).toEqual(before);
  } finally {
    await packageFixture.close();
    await fixture.dispose();
  }
});

test('#1225 recorded multi-set acts return identical bytes through next, fetch-act and UI retry after republish', async () => {
  const fixture = await batchFixture('review-ask-batch-act-history-');
  const {session, publicationId, reader, workspace} = fixture;
  try {
    const source = session.status().publication!.source;
    const page = session.ackDisplayed({publicationId, pageId: 'historical-batch-page', sourceHash: source.sourceHash});
    const start = await fixture.next();
    const recorded = session.retainedSourceV3(publicationId).questions.map(question => {
      const {set} = question;
      const value = {questionId: set.question, note: '  exact 한글\n', selections: set.asks.map(item => ({
        itemId: item.id, optionId: item.options.find(option => option.recommended)!.id, otherText: null,
      }))};
      const submission = {...page, expectedGeneration: session.status().generation, submissionId: 'historical-' + set.id,
        kind: 'interview-picks', value};
      const act = seedHistoricalPicksAct(session, {...submission, questionId: set.question,
        setId: set.id, optionSetSha256: question.ref.sha256});
      return {act, submission: {...submission, askId: act.askId}, bytes: JSON.stringify(act)};
    });
    expect(recorded).toHaveLength(3);
    const head = await fixture.call({verb: 'publish', expectedGeneration: session.status().generation,
      idempotencyKey: 'new-head', result: workspace.result, freeze: {kind: 'producer-held', holdId: 'synthetic-2', record: workspace.record}});
    expect(head.ok).toBe(true);
    const before = fixture.snapshot(), calls = reader.calls.length;
    const history = await fixture.next(start.value.cursor);
    expect(history.ok).toBe(true);
    expect(history.value.events.filter((event: {type: string}) => event.type === 'act')
      .map((event: {act: unknown}) => JSON.stringify(event.act))).toEqual(recorded.map(row => row.bytes));
    for (const {act, submission, bytes} of recorded) {
      const response = await fixture.request({verb: 'fetch-act', actId: act.actId}, session.writerGrant().fetchCapability, jobRawActMediaType);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(bytes);
      expect(JSON.stringify(await session.commitUIAct(submission))).toBe(bytes);
      await expect(session.commitUIAct({...submission, value: {...submission.value, note: 'changed'}}))
        .rejects.toMatchObject({code: 'JOB_IDEMPOTENCY_CONFLICT'});
    }
    expect(fixture.snapshot()).toEqual(before);
    expect(reader.calls.length).toBe(calls);
  } finally { await fixture.dispose(); }
});

test('#1022 a superseded historical batch keeps its events while retries of the removed verb refuse', async () => {
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
    expect(replayed).toMatchObject({ok: false, error: removedVerbError('ask-batch')});
    const history = await fixture.next();
    expect(history.value.events.filter((event: {type: string}) => event.type === 'pending')
      .map((event: {ask: unknown}) => event.ask)).toEqual(seeded.asks);
    expect(fixture.session.status().pending).toEqual([]);
    expect(fixture.snapshot()).toEqual(before);
  } finally { await fixture.dispose(); }
});
