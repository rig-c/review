import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/job-store.ts';
import { Database } from 'bun:sqlite';
import { jobFixture, jobInputHashes } from './helpers/job-api-fixture.ts';
import { rigStillCapture } from './helpers/job-rig-still.ts';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts } from '../src/job-api.ts';
import { JOB_API_V3_SCHEMA } from '../src/job-contract.ts';
import { createSyntheticOptionRecordWorkspace, createSyntheticRecordReader } from './helpers/job-record-fixture.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const stores: JobStore<unknown>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(options?: Parameters<typeof jobFixture>[0]) {
  const result = await jobFixture(options);
  fixtures.push(result);
  return result;
}

test('job store atomically commits state and replay receipt, rolls back a thrown callback and rejects stale CAS', async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'review-job-store-'));
  directories.push(directory);
  const store = new JobStore<{ events: string[]; receipt: string | null }>(directory);
  stores.push(store);
  const initial = store.open('root', () => ({ events: [], receipt: null }));
  expect(() => store.update(initial.jobId, 0, current => {
    current.data.events.push('uncommitted');
    throw new Error('planted rollback');
  })).toThrow('planted rollback');
  expect(store.get(initial.jobId).data).toEqual({ events: [], receipt: null });
  const committed = store.update(initial.jobId, 0, () => ({ data: { events: ['saved'], receipt: 'same-transaction' } }));
  expect(committed.revision).toBe(1);
  expect(() => store.update(initial.jobId, 0, current => ({ data: current.data }))).toThrow('JOB_GENERATION_STALE');
  const reopened = new JobStore<{ events: string[]; receipt: string | null }>(directory);
  stores.push(reopened);
  expect(reopened.open('root', () => { throw new Error('must reuse'); })).toEqual(committed);
  reopened.update(initial.jobId, 1, current => ({ data: current.data, active: false }));
  expect(store.open('root', () => ({ events: [], receipt: null })).jobId).not.toBe(initial.jobId);
});

test('publish replay is stable, source stays immutable and no source/state path or capability reaches public responses', async () => {
  const f = await fixture(), before = await jobInputHashes(f.root);
  const request = await f.publishRequest('publish-once');
  const first = await (await f.call(request)).json();
  expect(first.ok).toBe(true);
  const replay = await (await f.call({ ...request, requestId: 'retry-request' })).json();
  expect(replay.value).toEqual(first.value);
  expect(replay.generation).toBe(first.generation);
  const conflict = await (await f.call({ ...request, result: { ...('result' in request ? request.result : {}), path: 'different' } })).json();
  expect(conflict.error.code).toBe('JOB_IDEMPOTENCY_CONFLICT');
  expect(await jobInputHashes(f.root)).toEqual(before);
  const exposed = JSON.stringify([first, replay]);
  for (const privateValue of [f.state, f.root, f.credentials.agent, f.credentials.ui, f.session.writerGrant().fetchCapability]) {
    expect(exposed).not.toContain(privateValue);
  }
  const retained = f.session.retainedSource(first.value.publicationId);
  expect(await readFile(join(retained.snapshotRoot, 'out/review.json'))).toEqual(await readFile(join(f.root, 'out/review.json')));
});

test('a real record move after snapshot refuses by name and keeps the previous publication and generation', async () => {
  let plant = false;
  const f = await fixture({ afterSnapshot: async root => {
    if (plant) await writeFile(join(root, 'record.json'), '{"syntheticPublication":"moved-midwrite"}\n');
  } });
  const previous = await f.publish(), generation = f.session.status().generation;
  plant = true;
  const response = await (await f.call(await f.publishRequest('midwrite'))).json();
  expect(response.ok).toBe(false);
  expect(response.error.code).toBe('JOB_RECORD_MOVED');
  expect(f.session.status().publication).toEqual(previous);
  expect(f.session.status().generation).toBe(generation);
  expect((await f.ports.readPublication(f.session.jobId, previous.publicationId)).ok).toBe(true);
});

test('new publication preserves old retained bytes and makes old displayed submissions stale', async () => {
  const f = await fixture(), first = await f.publish();
  // #1235: the captured sample is the comment-only act@10.
  const page = await f.display(first);
  const captured = { ...page, expectedGeneration: f.session.status().generation,
    submissionId: 'old-draft', kind: 'comments', value: { comments: [{ text: 'old draft' }] } };
  const path = join(f.root, 'out/review.json'), original = await readFile(path, 'utf8');
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), revision: '2' }));
  const second = await f.publish();
  expect(second.source.sourceHash).not.toBe(first.source.sourceHash);
  expect(await readFile(join(f.session.retainedSource(first.publicationId).snapshotRoot, 'out/review.json'), 'utf8')).toBe(original);
  const stale = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(captured));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe('JOB_ACT_SOURCE_STALE');
  expect(f.session.status().pending).toHaveLength(0);
});

test('next is bounded, cursor-validated, replayable and abortable without consuming events', async () => {
  const f = await fixture();
  await f.publish();
  const first = await (await f.call({ ...f.base(), verb: 'next', after: null, waitMs: 0 })).json();
  const replay = await (await f.call({ ...f.base(), verb: 'next', after: null, waitMs: 0 })).json();
  expect(replay.value).toEqual(first.value);
  const invalid = await (await f.call({ ...f.base(), verb: 'next', after: 'unknown-cursor', waitMs: 0 })).json();
  expect(invalid.error.code).toBe('JOB_CURSOR_INVALID');
  const abort = new AbortController();
  const waiting = f.call({ ...f.base(), verb: 'next', after: first.value.cursor, waitMs: 30_000 }, f.credentials.agent, abort.signal);
  await Bun.sleep(5);
  abort.abort();
  const cancelled = await (await waiting).json();
  expect(cancelled.error.code).toBe('JOB_REQUEST_INVALID');
  expect(f.session.status().generation).toBe(1);
});

test('P1 SSE cancellation leaves the actual daemon child alive for further requests', async () => {
  const f = await fixture();
  await f.publish();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/job-agent-client.ts'), 'subscription-server'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ options: { root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: { id: 'declared-owner', role: 'owner' } } }));
  child.stdin.end();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  const errors = new Response(child.stderr).text();
  let output = '';
  let drained: Promise<string> | undefined;
  try {
    while (!output.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw new Error('Subscription child did not start');
      output += decoder.decode(next.value);
    }
    const origin = JSON.parse(output.split('\n')[0]).origin;
    drained = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return output;
        output += decoder.decode(next.value);
      }
    })();
    for (const mode of ['stream-cancel', 'request-abort']) {
      const abort = new AbortController();
      const response = await fetch(origin + '/events', { signal: abort.signal });
      const events = response.body!.getReader();
      expect(new TextDecoder().decode((await events.read()).value)).toContain(': connected');
      if (mode === 'stream-cancel') await events.cancel();
      else { abort.abort(); await events.cancel().catch(() => {}); }
      const expected = mode === 'stream-cancel' ? 1 : 2;
      let completed = 0;
      const deadline = performance.now() + 2_000;
      while (completed < expected && child.exitCode === null && performance.now() < deadline) {
        try {
          const health = await (await fetch(origin + '/health', { signal: AbortSignal.timeout(500) })).json();
          completed = health.completions;
        } catch { if (child.exitCode !== null) break; }
        if (completed < expected) await Bun.sleep(10);
      }
      if (child.exitCode !== null) console.log(JSON.stringify({ childExitCode: child.exitCode, stdout: await drained, stderr: await errors }));
      expect(child.exitCode).toBeNull();
      expect(completed).toBe(expected);
    }
    expect((await (await fetch(origin + '/health')).json()).alive).toBe(true);
    await (await fetch(origin + '/shutdown')).json();
    const exit = await child.exited;
    expect(exit).toBe(0);
    expect(await errors).toBe('');
    expect((await drained).match(/SUBSCRIPTION_COMPLETED/g)).toHaveLength(2);
    console.log(JSON.stringify({ sseCancellation: { childPid: child.pid, afterStreamCancelAlive: true,
      afterRequestAbortAlive: true, normalCompletions: 2, childExitCode: exit } }));
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    if (drained) await drained;
    else reader.releaseLock();
    await errors;
  }
}, 10_000);

test('subscription preserves non-cancellation errors and an already cancelled subscription ends normally', async () => {
  const f = await fixture();
  await f.publish();
  const invalid = f.ports.subscribeJob({ jobId: f.session.jobId, after: 'invalid-cursor',
    signal: new AbortController().signal })[Symbol.asyncIterator]();
  await expect(invalid.next()).rejects.toMatchObject({ code: 'JOB_CURSOR_INVALID' });
  const wrongJob = f.ports.subscribeJob({ jobId: 'different-job', after: null,
    signal: new AbortController().signal })[Symbol.asyncIterator]();
  await expect(wrongJob.next()).rejects.toMatchObject({ code: 'JOB_UNKNOWN' });
  const abort = new AbortController();
  abort.abort();
  const cancelled = f.ports.subscribeJob({ jobId: f.session.jobId, after: null, signal: abort.signal })[Symbol.asyncIterator]();
  expect(await cancelled.next()).toEqual({ done: true, value: undefined });
});

test('explicit close revokes fetch immediately, close replay is stable and reopening creates a fresh incarnation/grant', async () => {
  const f = await fixture();
  await f.publish();
  const oldGrant = f.session.writerGrant();
  const close = { ...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'close-once', reason: 'explicit agent close' };
  expect((await (await f.call(close)).json()).ok).toBe(true);
  expect((await (await f.call(close)).json()).ok).toBe(true);
  const revoked = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: 'any-act' }, oldGrant.fetchCapability)).json();
  expect(revoked.error.code).toBe('JOB_CLOSED');
  const { JobSession } = await import('../src/job-session.ts');
  const reopened = new JobSession({ root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: { id: 'declared-owner', role: 'owner' } });
  expect(reopened.jobId).not.toBe(f.session.jobId);
  expect(reopened.writerGrant().fetchCapability).not.toBe(oldGrant.fetchCapability);
  reopened.dispose();
});

test('process death after a real uncommitted SQL write rolls back document and receipt together', async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'review-job-crash-'));
  directories.push(directory);
  const store = new JobStore<{ events: string[]; receipt: string | null }>(directory);
  stores.push(store);
  const job = store.open('root', () => ({ events: [], receipt: null }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/job-agent-client.ts'), 'sqlite-crash', directory, job.jobId], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stdout).toContain('SQL_WRITE_BEFORE_SIGKILL');
  expect(stderr).toBe('');
  expect(exit).not.toBe(0);
  expect(store.get(job.jobId)).toEqual(job);
  const committed = store.update(job.jobId, job.revision, () => ({ data: { events: ['complete'], receipt: 'saved' } }));
  expect(committed.data).toEqual({ events: ['complete'], receipt: 'saved' });
});

test('process death after act commit is recovered by same-act replay with no duplicate generation or event', async () => {
  const f = await fixture(), publication = await f.publish();
  const page = await f.display(publication);
  const input = { ...page, expectedGeneration: f.session.status().generation,
    submissionId: 'crash-retry', kind: 'comments', value: { comments: [{ text: 'crash retry' }] } };
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/job-agent-client.ts'), 'commit-act-crash'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ options: { root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: { id: 'declared-owner', role: 'owner' } }, submission: input }));
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).not.toBe(0);
  expect(stderr).toBe('');
  const committedId = JSON.parse(stdout).committedActId;
  const generation = f.session.status().generation;
  const replay = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(replay.ok).toBe(true);
  if (replay.ok) expect(replay.value.actId).toBe(committedId);
  expect(f.session.status().generation).toBe(generation);
  const next = await (await f.call({ ...f.base(), verb: 'next', after: null, waitMs: 0 })).json();
  expect(next.value.events.filter((event: { type: string }) => event.type === 'act')).toHaveLength(1);
});

test('concurrent publishes under one generation commit one source and refuse the competing CAS', async () => {
  let prepared = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ afterSnapshot: () => { if (++prepared === 2) release(); return gate; } });
  const first = await f.publishRequest('concurrent-one'), second = await f.publishRequest('concurrent-two');
  const replies = await Promise.all([f.call(first).then(response => response.json()), f.call(second).then(response => response.json())]);
  expect(replies.filter(result => result.ok)).toHaveLength(1);
  expect(replies.find(result => !result.ok).error.code).toBe('JOB_GENERATION_STALE');
  expect(f.session.status().generation).toBe(1);
});

test('cancelled body and publish preparation roll back without adding a publication', async () => {
  const f = await fixture();
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"schema":')); },
    cancel() { cancelled = true; },
  });
  const request = new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, signal: abort.signal,
  });
  const reading = f.ports.handleJobApi(request);
  await Bun.sleep(5);
  abort.abort();
  expect((await (await reading).json()).error.code).toBe('JOB_REQUEST_INVALID');
  expect(cancelled).toBe(true);
  expect(f.session.status().generation).toBe(0);

  const publishAbort = new AbortController();
  const duringPublish = await fixture({ afterSnapshot: () => { publishAbort.abort(); } });
  const response = await (await duringPublish.call(await duringPublish.publishRequest(), duringPublish.credentials.agent, publishAbort.signal)).json();
  expect(response.error.code).toBe('JOB_REQUEST_INVALID');
  expect(duringPublish.session.status().publication).toBeNull();
});

test('oversized single events refuse before commit, while existing oversized events refuse immediately instead of timing out forever', async () => {
  const f = await fixture(), publication = await f.publish();
  const originalCursor = f.session.status().cursor;
  const context = f.getContext(), hash = context.plan!.steps[0].hash;
  const steps = [{ ...context.plan!.steps[0] }];
  const cap = 512 * 1024, target = cap - 1;
  const eventBytes = (planSteps: typeof steps) => Buffer.byteLength(JSON.stringify({
    type: 'published', publication: { ...publication, generation: 2,
      previousPublicationId: publication.publicationId, source: { ...publication.source, plan: { steps: planSteps } } },
    cursor: publication.publicationId, jobId: f.session.jobId, generation: 2,
  }));
  let size = eventBytes(steps), index = 0;
  for (;;) {
    const step = { id: `step-${String(++index).padStart(8, '0')}`.padEnd(16, 'x'), hash };
    const added = Buffer.byteLength(JSON.stringify(step)) + 1;
    if (size + added > target) break;
    steps.push(step);
    size += added;
  }
  const padding = target - size;
  steps[steps.length - 1].id += 'x'.repeat(padding);
  expect(steps[steps.length - 1].id.length + 2).toBeLessThanOrEqual(128);
  expect(new Set(steps.map(step => step.id)).size).toBe(steps.length);
  expect(eventBytes(steps)).toBe(target);
  f.setContext({ ...context, plan: { steps } });
  const underResponse = await f.call(await f.publishRequest('under-cap'));
  expect(underResponse.status).toBe(200);
  const under = await underResponse.json();
  expect(under.ok).toBe(true);
  const delivered = await (await f.call({ ...f.base(), verb: 'next', after: originalCursor, waitMs: 0 })).json();
  expect(delivered.value.status).toBe('events');
  expect(Buffer.byteLength(JSON.stringify(delivered.value.events[0]))).toBe(target);

  // The twin changes only two ASCII bytes in one valid, unique published ID.
  const overSteps = steps.map((step, position) => position === steps.length - 1 ? { ...step, id: step.id + 'xx' } : step);
  expect(eventBytes(overSteps)).toBe(cap + 1);
  f.setContext({ ...context, plan: { steps: overSteps } });
  const overResponse = await f.call(await f.publishRequest('over-cap'));
  expect(overResponse.status).toBe(413);
  const tooLarge = await overResponse.json();
  expect(tooLarge.error.code).toBe('JOB_BODY_LIMIT');
  expect(f.session.status().publication).toEqual(under.value);
  const after = f.session.status().cursor;
  const idle = await (await f.call({ ...f.base(), verb: 'next', after, waitMs: 0 })).json();
  expect(idle.value.status).toBe('timeout');

  // Plant an older stored event in disposable daemon-owned state only.
  const database = new Database(join(f.state, 'jobs.sqlite'));
  const row = database.query<{ document: string }, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!;
  const data = JSON.parse(row.document);
  data.events[0].publication.label = 'legacy'.repeat(100_000);
  database.query('UPDATE jobs SET document=? WHERE job_id=?').run(JSON.stringify(data), f.session.jobId);
  database.close();
  const legacy = await (await f.call({ ...f.base(), verb: 'next', after: null, waitMs: 0 })).json();
  expect(legacy.error.code).toBe('JOB_BODY_LIMIT');
});

// #1022: an idempotent replay returns its stored receipt only while that receipt is still true.
test('#1022 replay of a superseded publish or ask refuses by name and names the head; current and finalized replays are unchanged', async () => {
  const f = await fixture();
  const publishA = await f.publishRequest('publish-a');
  const firstA = await (await f.call(publishA)).json();
  const askA = { ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation, idempotencyKey: 'ask-a',
    publicationId: firstA.value.publicationId, subject: { kind: 'review-verdict', stage: 'rig-review' } };
  const firstAskA = await (await f.call(askA)).json();
  expect(firstAskA.ok).toBe(true);
  // Still current: the stored receipts come back exactly as before (the envelope reports the current generation, as on main).
  const receipt = async (request: object) => { const {ok, value} = await (await f.call(request)).json(); return {ok, value}; };
  expect(await receipt(publishA)).toEqual({ok: true, value: firstA.value});
  expect(await receipt(askA)).toEqual({ok: true, value: firstAskA.value});

  // An ask whose act was finalized keeps its stored receipt.
  // #1235: the answered sample is the rig verdict with its synthetic still, not a signoff.
  const signoffA = { ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation, idempotencyKey: 'ask-a-signoff',
    publicationId: firstA.value.publicationId, subject: { kind: 'review-verdict', stage: 'rig-review' } };
  const firstSignoffA = await (await f.call(signoffA)).json();
  const page = await f.display(firstA.value);
  const committed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: firstSignoffA.value.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'signoff-a', kind: 'review-verdict',
    value: { stage: 'rig-review', verdict: 'approved', words: '' },
    capture: rigStillCapture(firstA.value, firstSignoffA.value, page).capture }));
  expect(committed.ok).toBe(true);

  // B replaces A before the first ask is answered.
  const publicationB = await f.publish();
  const head = 'head ' + publicationB.publicationId;
  const publishReplay = await (await f.call(publishA)).json();
  expect(publishReplay.ok).toBe(false);
  expect(publishReplay.error.code).toBe('JOB_ACT_SOURCE_STALE');
  expect(publishReplay.error.message).toBe(`publication ${firstA.value.publicationId} is superseded; ${head}`);
  const askReplay = await (await f.call(askA)).json();
  expect(askReplay.ok).toBe(false);
  expect(askReplay.error.code).toBe('JOB_ASK_SUPERSEDED');
  expect(askReplay.error.message).toBe(`ask ${firstAskA.value.askId} is superseded; ${head}`);
  expect(await receipt(signoffA)).toEqual({ok: true, value: firstSignoffA.value});
  // A refusal writes nothing and leaves B the head.
  expect(f.session.status().publication?.publicationId).toBe(publicationB.publicationId);
});

// #1022 measured case: two option sets in one record, B replaces A, then a producer retry replays A's publish and ask.
test('#1022 a byte-identical retry of a replaced option-set publish and ask refuses and names the head', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-1021-')), root = join(scratch, 'input');
  directories.push(scratch);
  await mkdir(root);
  const b = createSyntheticOptionRecordWorkspace(root, { questionId: 'q_b', setId: 'set_b' });
  const a = createSyntheticOptionRecordWorkspace(root, { questionId: 'q_a', setId: 'set_a' });
  const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
  project.interview.framing = [{ id: 'q_a', pending_options: a.optionSetFile }, { id: 'q_b', pending_options: b.optionSetFile }];
  const bytes = JSON.stringify(project, null, 2) + '\n';
  await writeFile(join(root, 'project.json'), bytes);
  const record = { path: 'project.json', sha256: createHash('sha256').update(bytes).digest('hex') };
  const files = [a.inputImage, a.inputSpec, a.optionSetFile, b.optionSetFile, record].sort((x, y) => x.path < y.path ? -1 : 1);
  const reader = createSyntheticRecordReader({ onOption: input => ({ ...(input.result.setId === 'set_a' ? a : b).context, files }) });
  const session = new JobSession({ root, stateDir: join(scratch, 'state'), fingerprint: 'a'.repeat(64),
    reviewer: { id: 'synthetic-owner', role: 'owner' }, publicationMode: 'record-and-package', readRecordPublished: reader.reader });
  try {
    const origin = 'http://127.0.0.1:19102', ports = createJobHostPorts(session, origin), agent = session.hostCredentials().agent;
    const call = async (body: object) => (await ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + agent },
      body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'r', ...body }) }))).json();
    const requests = (set: typeof a, key: string) => ({
      publish: { verb: 'publish', expectedGeneration: session.status().generation, idempotencyKey: 'publish-' + key, result: set.result,
        freeze: { kind: 'producer-held', holdId: key, record } },
      ask: (publicationId: string) => ({ verb: 'ask', expectedGeneration: session.status().generation, idempotencyKey: 'ask-' + key,
        publicationId, subject: set.context.subjects[0] }) });
    const first = requests(a, 'a'), publishedA = await call(first.publish), askBodyA = first.ask(publishedA.value.publicationId);
    const askedA = await call(askBodyA);
    const second = requests(b, 'b'), publishedB = await call(second.publish);
    expect((await call(second.ask(publishedB.value.publicationId))).ok).toBe(true);
    const head = 'head ' + publishedB.value.publicationId;
    expect(await call(first.publish)).toMatchObject({ ok: false, error: { code: 'JOB_ACT_SOURCE_STALE',
      message: `publication ${publishedA.value.publicationId} is superseded; ${head}` } });
    expect(await call(askBodyA)).toMatchObject({ ok: false, error: { code: 'JOB_ASK_SUPERSEDED',
      message: `ask ${askedA.value.askId} is superseded; ${head}` } });
    expect(session.status().pending.map(ask => ask.subject)).toEqual([b.context.subjects[0]]);
  } finally { session.dispose(); }
});
