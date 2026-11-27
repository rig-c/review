import { expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobHostPorts, jobHash } from '../src/job-api.ts';
import { createJobFront } from '../src/job-front.ts';
import { JOB_API_SCHEMA, JOB_API_V3_SCHEMA, type EventV3 } from '../src/job-contract.ts';
import { startJobHost, type JobHostOptions, type JobProgressLineV3, type JobProgressV3 } from '../src/job-host.ts';
import { JobSession } from '../src/job-session.ts';
import { JobStore } from '../src/job-store.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { seedHistoricalPicksAsks } from './helpers/historical-picks-act.ts';
import { seedHistoricalVerdictAsk } from './helpers/historical-verdict-ask.ts';
import { createSyntheticOptionSetsRecordWorkspace, createSyntheticRecordReader } from './helpers/job-record-fixture.ts';

async function progressFixture() {
  const f = await jobFixture();
  const packageRecord = { path: 'record.json', sha256: jobHash(await readFile(join(f.root, 'record.json'))) } as const;
  const packageResult = { kind: 'package' as const, path: 'out', selector: { kind: 'rig' as const, version: 1 } };
  let optionContext: ReturnType<typeof createSyntheticOptionSetsRecordWorkspace>['context'] | undefined;
  const reader = createSyntheticRecordReader({ onOption: () => optionContext! });
  const stateDir = join(f.scratch, 'v3-progress');
  const options: JobHostOptions = {
    root: f.root, stateDir, fingerprint: '9'.repeat(64), reviewer: { id: 'declared-owner', role: 'owner' },
    readPublished: async () => f.getContext(), readerId: 'synthetic-progress-pkg-reader/1',
    partsEnumerator: f.partsEnumerator, partsEnumeratorId: 'synthetic-progress-parts/1',
    readRecordPublished: reader.reader, recordReaderId: 'synthetic-progress-reader/1',
  };
  return {
    f, packageRecord, packageResult, options,
    // The record publication carries two option sets for the historical pending events.
    writeOptionRecord() {
      const workspace = createSyntheticOptionSetsRecordWorkspace(f.root, { count: 2 });
      optionContext = workspace.context;
      return workspace;
    },
  };
}

function agentClient(session: JobSession, origin: string, ports = createJobHostPorts(session, origin)) {
  const jobId = session.jobId;
  const base = { schema: JOB_API_V3_SCHEMA, jobId, requestId: 'progress-request' } as const;
  const path = `${origin}/jobs/${jobId}`;
  const { agent } = session.hostCredentials();
  const post = (body: string, token = agent) => ports.handleJobApi(new Request(path + '/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body,
  }));
  const call = async (body: object) => (await post(JSON.stringify({ ...base, ...body }))).json();
  return {
    base, path, ports, post, call,
    progress: (seq: number, fields: object = {}) => call({ verb: 'progress', seq, phase: 'build', ...fields }),
    next: (after: string | null = null) => call({ verb: 'next', after, waitMs: 0 }),
  };
}

function pageLines(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  return {
    async read(): Promise<EventV3 | JobProgressLineV3> {
      while (!buffered.includes('\n')) {
        const next = await reader.read();
        if (next.done) throw new Error('Owner stream ended before the next NDJSON line');
        buffered += next.value;
      }
      const newline = buffered.indexOf('\n');
      const line = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      return line;
    },
    async stop() { await reader.cancel().catch(() => {}); },
  };
}

function expectProgress(line: EventV3 | JobProgressLineV3, jobId: string, progress: JobProgressV3 | null) {
  expect(line).toEqual({ type: 'progress', jobId, progress, now: expect.any(String) });
  if (line.type !== 'progress') throw new Error('Expected page progress');
  expect(new Date(line.now).toISOString()).toBe(line.now);
  return line;
}

test('#987 V3 progress closes the request shape and enforces the 1024-byte HTTP bound', async () => {
  const { f, options } = await progressFixture();
  const session = new JobSession(options);
  const api = agentClient(session, f.origin);
  try {
    const fields = { verb: 'progress', seq: 1, phase: 'measure' };
    for (const invalid of [
      { schema: JOB_API_SCHEMA }, { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: '1' }, { seq: Number.MAX_SAFE_INTEGER + 1 },
      { seq: undefined }, { phase: 'running' }, { phase: undefined }, { text: 'x'.repeat(121) }, { text: null },
      { text: 'first\nsecond' }, { text: 'first\rsecond' }, { text: 'first\u0085second' }, { text: 'first\u2028second' },
      { text: 'first\u2029second' }, { step: null }, { step: { i: 0, n: 1 } }, { step: { i: 2, n: 1 } },
      { step: { i: 1, n: 1001 } }, { step: { i: 1, n: 1.5 } }, { step: { i: 1 } },
      { step: { i: 1, n: 1, extra: 1 } }, { at: 'client-clock' }, { generation: 0 },
      { expectedGeneration: 0 }, { idempotencyKey: 'unexpected' }, { extra: true },
    ]) {
      const response = await api.post(JSON.stringify({ ...api.base, ...fields, ...invalid }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID' } });
    }
    const text = '한'.repeat(120);
    const json = JSON.stringify({ ...api.base, ...fields, text, step: { i: 1000, n: 1000 } });
    const atLimit = json + ' '.repeat(1024 - Buffer.byteLength(json));
    const tooBig = await api.post(atLimit + ' ');
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID' } });
    for (const wrong of [session.hostCredentials().ui, session.writerGrant().fetchCapability]) {
      const response = await api.post(json, wrong);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'JOB_CAPABILITY_REQUIRED' } });
    }
    const response = await api.post(atLimit);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...api.base, verb: 'progress', ok: true, generation: 0,
      value: { status: 'accepted', seq: 1, at: expect.any(String) } });
    expect(await (await f.call({ ...f.base(), ...fields, schema: JOB_API_V3_SCHEMA })).json())
      .toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID' } });
    expect(f.ports.subscribeJobPage).toBeUndefined();
  } finally { session.dispose(); await f.close(); }
});

test('#987 committed publish and close clear progress while removed verbs and historical next reads preserve it', async () => {
  const { f, packageRecord, packageResult, options, writeOptionRecord } = await progressFixture();
  const session = new JobSession(options);
  const api = agentClient(session, f.origin);
  const store = new JobStore<{ progress?: JobProgressV3; events: EventV3[]; replays: object }>(options.stateDir, { readonly: true });
  const snapshot = () => store.get(session.jobId);
  const front = createJobFront({ origin: f.origin, ports: api.ports, resource: async () => '' });
  const pageSnapshot = async (after: string | null = null) => {
    const stream = pageLines((await front.fetch(new Request(api.path + '/events' + (after ? '?after=' + after : ''))))!);
    try { return await stream.read(); } finally { await stream.stop(); }
  };
  try {
    const idle = await api.next(), initial = snapshot();
    expect(idle.value).toMatchObject({ capabilities: { progress: true }, events: [], cursor: null, status: 'timeout' });
    const accepted = await api.progress(2, { text: 'reading', step: { i: 1, n: 3 } });
    const at = accepted.value.at;
    expect(new Date(at).toISOString()).toBe(at);
    expect(await api.next()).toEqual(idle);
    expect(snapshot().data.events).toEqual(initial.data.events);
    expect(snapshot().data.replays).toEqual(initial.data.replays);
    const latest = snapshot();
    for (const seq of [1, 2]) {
      expect((await api.progress(seq, { text: 'different' })).value).toEqual({ status: 'ignored', seq: 2, at });
      expect(snapshot()).toEqual(latest);
    }
    expectProgress(await pageSnapshot(), session.jobId,
      { seq: 2, phase: 'build', text: 'reading', step: { i: 1, n: 3 }, at, generation: 0 });

    const publish = { verb: 'publish', expectedGeneration: 0, idempotencyKey: 'progress-publish', result: packageResult,
      freeze: { kind: 'producer-held', holdId: 'progress-test', record: packageRecord } };
    const published = await api.call(publish);
    expect(published.ok).toBe(true);
    expect(snapshot().data.progress).toBeUndefined();
    expectProgress(await pageSnapshot(), session.jobId, null);
    expect((await api.progress(2)).value).toEqual({ status: 'ignored', seq: 2, at });
    expect(snapshot().data.progress).toBeUndefined();

    const newer = await api.progress(3);
    expect((await api.call(publish)).value).toEqual(published.value);
    expect(snapshot().data.progress?.seq).toBe(3);
    const publicationId = published.value.publicationId;
    const ask = { verb: 'ask', expectedGeneration: 1, idempotencyKey: 'progress-ask', publicationId,
      subject: { kind: 'review-verdict', stage: 'rig-review' } as const };
    expect((await api.call({...publish, idempotencyKey: 'stale-progress-publish'})).error.code).toBe('JOB_GENERATION_STALE');
    expect(snapshot().data.progress?.at).toBe(newer.value.at);
    const beforeRefusal = snapshot();
    expect(await api.call({...ask, idempotencyKey: 'fresh-progress-ask'}))
      .toMatchObject({ok: false, generation: 1, error: {code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'}});
    expect(snapshot()).toEqual(beforeRefusal);
    const historical = seedHistoricalVerdictAsk(session, publicationId, ask.subject, ask.idempotencyKey);
    expect(snapshot().data.progress).toBeUndefined();

    await api.progress(4);
    expect((await api.next()).value.events).toContainEqual(expect.objectContaining({type: 'pending', ask: historical}));
    expect(snapshot().data.progress?.seq).toBe(4);
    // #1235: the sample act is the comment-only act@10; it answers no ask.
    const page = session.ackDisplayed({ publicationId, pageId: 'progress-page', sourceHash: published.value.source.sourceHash });
    const act = await session.commitUIAct({ ...page, expectedGeneration: 2,
      submissionId: 'progress-act', kind: 'comments', value: { comments: [{ text: 'progress comment' }] } });
    expect(act.kind).toBe('comments');
    expect(snapshot().data.progress?.seq).toBe(4);

    // Publishing the record clears progress. Refusing ask-batch and reading historical events preserve progress.
    const workspace = writeOptionRecord();
    const recordPublished = await api.call({ verb: 'publish', expectedGeneration: 3, idempotencyKey: 'progress-record-publish',
      result: workspace.result, freeze: { kind: 'producer-held', holdId: 'progress-record', record: workspace.record } });
    expect(recordPublished.ok).toBe(true);
    expect(snapshot().data.progress).toBeUndefined();
    await api.progress(5);
    const batch = { verb: 'ask-batch', expectedGeneration: 4, idempotencyKey: 'progress-batch',
      publicationId: recordPublished.value.publicationId, subjects: workspace.context.subjects };
    const refusedBatch = await api.call(batch);
    expect(refusedBatch).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask-batch' } });
    expect(snapshot().data.progress?.seq).toBe(5);
    const historicalPicks = seedHistoricalPicksAsks(session, recordPublished.value.publicationId, workspace.context.subjects);
    await api.progress(6);
    const beforeRead = snapshot();
    const events = (await api.next()).value.events as EventV3[];
    for (const ask of historicalPicks) expect(events).toContainEqual(expect.objectContaining({type: 'pending', ask}));
    expect(snapshot()).toEqual(beforeRead);
    expect(snapshot().data.progress?.seq).toBe(6);

    const beforeClose = await api.next();
    const close = { verb: 'close', expectedGeneration: beforeClose.generation, idempotencyKey: 'progress-close', reason: 'test complete' };
    expect((await api.call(close)).ok).toBe(true);
    expect(await api.progress(7)).toMatchObject({ ok: false, error: { code: 'JOB_CLOSED' } });
    expect(await api.progress(6)).toMatchObject({ ok: false, error: { code: 'JOB_CLOSED' } });
    expectProgress(await pageSnapshot(beforeClose.value.cursor), session.jobId, null);
    const next = await api.next(beforeClose.value.cursor);
    expect(next.value.events.map((event: EventV3) => event.type)).toEqual(['closed']);
    expect(await api.next(next.value.cursor)).toMatchObject({ value: { events: [], status: 'closed' } });
  } finally { front.stop(); store.close(); session.dispose(); await f.close(); }
});

test('#987 a progress commit racing the publication transaction preserves semantic CAS', async () => {
  const { f, packageRecord, packageResult, options } = await progressFixture();
  const session = new JobSession(options);
  const attached = JobSession.openReadOnly(options, session.jobId);
  const api = agentClient(session, f.origin);
  const { store } = session as unknown as { store: JobStore<unknown> };
  const update = store.update.bind(store);
  let progress: Promise<unknown> | undefined;
  const commit = spyOn(store, 'update').mockImplementation((...args) => {
    progress = attached.execute({ ...api.base, verb: 'progress', seq: 1, phase: 'publish' }, new AbortController().signal);
    return update(...args);
  });
  try {
    const published = await api.call({ verb: 'publish', expectedGeneration: 0, idempotencyKey: 'concurrent-publish',
      result: packageResult, freeze: { kind: 'producer-held', holdId: 'progress-test', record: packageRecord } });
    expect(await progress).toMatchObject({ status: 'accepted', seq: 1 });
    expect(published).toMatchObject({ ok: true, generation: 1 });
    expect(store.get(session.jobId).data).not.toHaveProperty('progress');
    expect((await api.next()).value.events.map((event: EventV3) => event.type)).toEqual(['published']);
  } finally { commit.mockRestore(); attached.dispose(); session.dispose(); await f.close(); }
});

test('#987 an attached publisher persists into the owner stream, including a coalesced trailing update', async () => {
  const { f, packageRecord, packageResult, options } = await progressFixture();
  const owner = await startJobHost(options);
  const jobId = owner.session.jobId;
  const api = agentClient(owner.session, owner.origin, owner.ports);
  const streams: ReturnType<typeof pageLines>[] = [];
  const abort = new AbortController();
  let attached: Awaited<ReturnType<typeof startJobHost>> | undefined;
  let restarted: Awaited<ReturnType<typeof startJobHost>> | undefined;
  async function connect(path: string) {
    const response = await fetch(path + '/events', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
    const stream = pageLines(response);
    streams.push(stream);
    return stream;
  }
  try {
    const [first, second] = await Promise.all([connect(api.path), connect(api.path)]);
    expectProgress(await first.read(), jobId, null);
    expectProgress(await second.read(), jobId, null);
    expect(owner.attachment).not.toBeNull();
    attached = await startJobHost({ ...options, reuseOnly: { expected: owner.attachment! } });
    expect(attached.session).not.toBe(owner.session);
    const publisher = agentClient(attached.session, attached.origin, attached.ports);

    const head = await publisher.progress(1, { phase: 'ingest' });
    expect(head.ok).toBe(true);
    const visible = await Promise.all([first.read(), second.read()]);
    const leading = visible.map(line => expectProgress(line, jobId,
      { seq: 1, phase: 'ingest', at: head.value.at, generation: 0 }));
    expect((await publisher.progress(2)).value.status).toBe('accepted');
    const final = await publisher.progress(3, { phase: 'measure', step: { i: 3, n: 3 } });
    expect(final.value.status).toBe('accepted');
    const last = { seq: 3, phase: 'measure', step: { i: 3, n: 3 }, at: final.value.at, generation: 0 } as const;
    const reconnect = await connect(api.path);
    expectProgress(await reconnect.read(), jobId, last);
    const trailing = (await Promise.all([first.read(), second.read()])).map(line => expectProgress(line, jobId, last));
    const earliest = (lines: JobProgressLineV3[]) => Math.min(...lines.map(line => Date.parse(line.now)));
    expect(earliest(trailing) - earliest(leading)).toBeGreaterThanOrEqual(990);
    expect((await api.next()).value.events).toEqual([]);

    await Promise.all(streams.splice(0).map(stream => stream.stop()));
    attached.stop();
    owner.stop();
    restarted = await startJobHost(options);
    expect(restarted.session.jobId).toBe(jobId);
    const resumed = agentClient(restarted.session, restarted.origin, restarted.ports);
    const current = await connect(resumed.path);
    expectProgress(await current.read(), jobId, last);
    expect((await resumed.progress(3)).value).toEqual({ status: 'ignored', seq: 3, at: final.value.at });

    const iterator = resumed.ports.subscribeJob({ jobId, after: null, signal: abort.signal })[Symbol.asyncIterator]();
    const event = iterator.next();
    try {
      const published = await resumed.call({ verb: 'publish', expectedGeneration: 0, idempotencyKey: 'new-painting',
        result: packageResult, freeze: { kind: 'producer-held', holdId: 'synthetic-progress', record: packageRecord } });
      expect(published.ok).toBe(true);
      expectProgress(await current.read(), jobId, null);
      const actual = await current.read();
      expect(actual).toMatchObject({ type: 'published', publication: { publicationId: published.value.publicationId } });
      expect((await event).value).toEqual(actual);
      expect((await resumed.next()).value.events).toEqual([actual]);
    } finally { abort.abort(); await event.catch(() => {}); await iterator.return?.(); }
  } finally {
    abort.abort();
    await Promise.all(streams.map(stream => stream.stop()));
    restarted?.stop(); attached?.stop(); owner.stop(); await f.close();
  }
}, 10_000);
