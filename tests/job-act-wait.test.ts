import {afterEach, expect, test} from 'bun:test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {JOB_API_SCHEMA, startJobHost, waitForJobAct, type JobHostOptions, type JobOwnerHost} from '../src/job-host.ts';
import {jobHash} from '../src/job-api.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

// Every UI submission here is an explicitly synthetic test fixture. No real
// owner's review or producer acceptance is represented by these acts.
const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop();
  for (const f of fixtures.splice(0)) await f.close();
});

let sequence = 0;
/** A live owner host, a strict attachment beside it and a pending checkpoint ask on its head. */
async function attachedPair() {
  const f = await jobFixture();
  fixtures.push(f);
  const options: JobHostOptions = {
    root: f.root, stateDir: join(f.scratch, 'host-state'), fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}, readPublished: async () => f.getContext(),
    readerId: 'reader/1', installWriterBinding: () => {}, bindingId: 'writer/1',
    partsEnumerator: f.partsEnumerator, partsEnumeratorId: 'parts/1',
  };
  const owner = await startJobHost(options);
  hosts.push(owner);
  const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}});
  hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.session).not.toBe(owner.session);
  const jobId = owner.session.jobId, {agent, ui} = owner.session.hostCredentials();
  async function agentCall(host: JobOwnerHost, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + agent}, signal,
      body: JSON.stringify({schema: JOB_API_SCHEMA, jobId, requestId: `request-${++sequence}`, ...body}),
    }));
    return response.json();
  }
  const uiRequest = (path: string, body: unknown) => new Request(`${owner.origin}/jobs/${jobId}/ui/${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': ui},
    body: JSON.stringify(body),
  });
  const published = await agentCall(owner, {verb: 'publish', expectedGeneration: owner.session.status().generation,
    idempotencyKey: `publish-${++sequence}`, result: {path: 'out', selector: f.getContext().selector},
    freeze: {kind: 'producer-held', holdId: 'synthetic-held-freeze',
      record: {path: 'record.json', sha256: jobHash(await readFile(join(f.root, 'record.json')))}}});
  expect(published.ok).toBe(true);
  const publication = published.value;
  const asked = await agentCall(owner, {verb: 'ask', expectedGeneration: owner.session.status().generation,
    idempotencyKey: `ask-${++sequence}`, publicationId: publication.publicationId,
    subject: {kind: 'checkpoint', checkpointId: 'step-one'}});
  expect(asked.ok).toBe(true);
  async function display(pageId = 'page-one') {
    const shown = await owner.ports.ackDisplayed(jobId, uiRequest('displayed',
      {publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash}));
    if (!shown.ok) throw new Error(JSON.stringify(shown));
    return shown.value;
  }
  const page = await display();
  const act = {...page, askId: asked.value.askId, expectedGeneration: owner.session.status().generation,
    submissionId: 'synthetic-cross-session-act', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'pass', words: 'synthetic'}};
  const head = await agentCall(attached, {verb: 'next', after: null, waitMs: 0});
  expect(head.ok).toBe(true);
  return {owner, attached, agentCall, display, act, cursor: head.value.cursor as string,
    commit: (value: unknown = act) => owner.ports.commitUIAct(jobId, uiRequest('acts', value))};
}

/** Count `next` requests the waiter sends through the attachment's ports. */
function counted(host: JobOwnerHost) {
  const requests: number[] = [];
  const wrapped: JobOwnerHost = {...host, session: host.session, ports: {...host.ports, async handleJobApi(request) {
    requests.push(performance.now());
    return host.ports.handleJobApi(request);
  }}};
  return {host: wrapped, requests};
}

test('#1005 control: a raw next blocked on a strict attachment wakes on the live host commit', async () => {
  const {attached, agentCall, commit, cursor} = await attachedPair();
  const started = performance.now();
  const blocked = agentCall(attached, {verb: 'next', after: cursor, waitMs: 3000});
  await Bun.sleep(100);
  expect((await commit()).ok).toBe(true);
  const result = await blocked;
  const elapsed = performance.now() - started;
  expect(result.ok).toBe(true);
  expect(result.value.events.map((event: {type: string}) => event.type)).toEqual(['act']);
  expect(elapsed).toBeLessThan(1500);
});

test('#1005 waiter on the attachment resolves act from a live host commit well before its deadline', async () => {
  const {attached, commit, cursor} = await attachedPair();
  const {host, requests} = counted(attached);
  const started = performance.now();
  const waiting = waitForJobAct(host, {after: cursor, deadlineMs: 5000});
  await Bun.sleep(100);
  const saved = await commit();
  expect(saved.ok).toBe(true);
  const outcome = await waiting;
  expect(performance.now() - started).toBeLessThan(1500);
  expect(outcome.kind).toBe('act');
  if (outcome.kind !== 'act' || !saved.ok) throw new Error('unreachable');
  expect(outcome.next.events).toHaveLength(1);
  expect(outcome.next.events[0]!.type).toBe('act');
  expect((outcome.next.events[0] as {act: {actId: string}}).act.actId).toBe(saved.value.actId);
  expect(outcome.cursor).toBe(outcome.next.cursor);
  expect(requests).toHaveLength(1);
});

test('#1005 a display receipt write and a refused save neither wake the waiter nor repeat next in one window', async () => {
  const {attached, display, act, commit, cursor} = await attachedPair();
  const {host, requests} = counted(attached);
  const started = performance.now();
  const waiting = waitForJobAct(host, {after: cursor, deadlineMs: 1200});
  await Bun.sleep(100);
  await display('page-two');
  const refused = await commit({...act, displayedNonce: '0'.repeat(64), submissionId: 'synthetic-refused'});
  expect(refused.ok).toBe(false);
  const outcome = await waiting;
  expect(performance.now() - started).toBeGreaterThanOrEqual(1150);
  // The one request was still open at the deadline, so no batch was accepted.
  expect(outcome).toEqual({kind: 'timeout', code: 'JOB_NEXT_TIMEOUT', next: null, cursor});
  // The deadline is inside one 30-second server window: exactly one next went out.
  expect(requests).toHaveLength(1);
});

test('#1005 a deadline with no write sends one next and names JOB_NEXT_TIMEOUT', async () => {
  const {attached, cursor} = await attachedPair();
  const {host, requests} = counted(attached);
  const outcome = await waitForJobAct(host, {after: cursor, deadlineMs: 300});
  expect(outcome.kind).toBe('timeout');
  if (outcome.kind === 'timeout') {
    expect(outcome.code).toBe('JOB_NEXT_TIMEOUT');
    expect(outcome.cursor).toBe(cursor);
  }
  expect(requests).toHaveLength(1);
});

test('#1005 abort cancels the wait with its reason and leaves no timer behind', async () => {
  const {attached, cursor} = await attachedPair();
  const timers = new Set<unknown>();
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const realInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id = realSet(() => {timers.delete(id); handler();}, ms);
    timers.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {timers.delete(id); realClear(id);}) as typeof clearTimeout;
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    const id = realInterval(handler, ms);
    timers.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {timers.delete(id); realClearInterval(id);}) as typeof clearInterval;
  try {
    const controller = new AbortController();
    const waiting = waitForJobAct(attached, {after: cursor, deadlineMs: 5000, signal: controller.signal});
    await Bun.sleep(100);
    expect(timers.size).toBeGreaterThan(0);
    controller.abort(new Error('synthetic explicit cancellation'));
    await expect(waiting).rejects.toThrow('synthetic explicit cancellation');
    await Bun.sleep(20);
    expect(timers.size).toBe(0);
  } finally {
    globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
    globalThis.setInterval = realInterval; globalThis.clearInterval = realClearInterval;
  }
});

test('#1005 the waiter refuses unbounded deadlines before any request and surfaces a refused next by code', async () => {
  const {attached} = await attachedPair();
  const {host, requests} = counted(attached);
  for (const deadlineMs of [0, -1, 0.5, 600_001, Number.POSITIVE_INFINITY, Number.NaN]) {
    await expect(waitForJobAct(host, {after: null, deadlineMs})).rejects.toThrow('JOB_REQUEST_INVALID');
  }
  expect(requests).toHaveLength(0);
  await expect(waitForJobAct(host, {after: '00000000-0000-4000-8000-000000000000', deadlineMs: 100}))
    .rejects.toMatchObject({code: 'JOB_CURSOR_INVALID'});
});
