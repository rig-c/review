import {afterEach, expect, spyOn, test} from 'bun:test';
import {waitForJobAct, type JobOwnerHost} from '../src/job-host.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {attachedPair as pair, recordAttachedPair} from './helpers/job-attach-fixture.ts';
import {rm} from 'node:fs/promises';
import {jobCommand} from '../src/job-cli.ts';
import {JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_RECORD_ACT_KINDS} from '../src/job-contract.ts';

// Every UI submission here is an explicitly synthetic test fixture. No real
// owner's review or producer acceptance is represented by these acts.
const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const hosts: JobOwnerHost[] = [];
const scratches: string[] = [];
const attachedPair = () => pair(fixtures, hosts);
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop();
  for (const scratch of scratches.splice(0)) await rm(scratch, {recursive: true, force: true});
  for (const f of fixtures.splice(0)) await f.close();
});


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
  // The one window either was still open at the deadline or ended empty just before it.
  expect(outcome.kind === 'timeout' && outcome.code === 'JOB_NEXT_TIMEOUT' && outcome.cursor === cursor).toBe(true);
  if (outcome.kind === 'timeout' && outcome.next) expect(outcome.next).toMatchObject({events: [], cursor, status: 'timeout'});
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

test('#1005 an empty window ending under a millisecond before the deadline sends no zero-wait repeat', async () => {
  const {attached, cursor} = await attachedPair();
  let clock = 1000;
  const now = spyOn(performance, 'now').mockImplementation(() => clock);
  const waits: number[] = [];
  const host: JobOwnerHost = {...attached, ports: {...attached.ports, async handleJobApi(request) {
    const body = JSON.parse(await request.text());
    waits.push(body.waitMs);
    // The first server window has elapsed: half a millisecond of the deadline is left, then it passes.
    if (waits.length === 1) {
      clock = 1299.5;
      setTimeout(() => {clock = 1300;}, 50);
    }
    // A zero-wait spin can starve that timer, so a repeat also ends the deadline.
    if (waits.length > 3) clock = 1300;
    return attached.ports.handleJobApi(new Request(request.url, {method: 'POST', headers: request.headers,
      body: JSON.stringify({...body, waitMs: 0})}));
  }}};
  try {
    const outcome = await waitForJobAct(host, {after: cursor, deadlineMs: 300});
    expect(outcome).toMatchObject({kind: 'timeout', code: 'JOB_NEXT_TIMEOUT', cursor,
      next: {events: [], cursor, status: 'timeout'}});
    expect(waits).toEqual([300]);
  } finally {now.mockRestore();}
});

test('#1005 abort cancels the wait with its reason and leaves no timer behind', async () => {
  const {attached, cursor} = await attachedPair();
  // Count only the wait's own timers: the waiter loop's (src/job-cli.ts) and those the attached
  // session's next arms for this request. The live owner host's closure watcher (startJobHost's
  // session.subscribe loop) re-arms its own 30000 ms window and 250 ms poll when its poll sees the
  // fixture's display-receipt write, up to 250 ms later. Those timers belong to the owner host until
  // it stops, and counting them made this bar flaky on #1012.
  const timers = new Map<unknown, string>();
  const session = attached.session as unknown as {next: (...args: unknown[]) => Promise<unknown>};
  const realNext = session.next;
  let inAttachedNext = false;
  session.next = function (this: unknown, ...args: unknown[]) {
    inAttachedNext = true;
    try { return realNext.apply(this, args); } finally { inAttachedNext = false; }
  };
  const owned = () => inAttachedNext || /src\/job-cli\.ts/.test(new Error().stack ?? '');
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const realInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  const track = (id: unknown, kind: string) => { if (owned()) timers.set(id, kind); return id; };
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id: ReturnType<typeof setTimeout> = realSet(() => {timers.delete(id); handler();}, ms);
    return track(id, 'timeout ' + ms);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {timers.delete(id); realClear(id);}) as typeof clearTimeout;
  globalThis.setInterval = ((handler: () => void, ms?: number) => track(realInterval(handler, ms), 'interval ' + ms)) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {timers.delete(id); realClearInterval(id);}) as typeof clearInterval;
  try {
    const controller = new AbortController();
    const waiting = waitForJobAct(attached, {after: cursor, deadlineMs: 5000, signal: controller.signal});
    await Bun.sleep(100);
    // The waiter's 5000 ms deadline, plus the attached next's window (the remaining budget) and its 250 ms revision poll.
    const live = [...timers.values()];
    expect(live).toHaveLength(3);
    expect(live).toContain('timeout 5000');
    expect(live).toContain('interval 250');
    controller.abort(new Error('synthetic explicit cancellation'));
    await expect(waiting).rejects.toThrow('synthetic explicit cancellation');
    // The waiter clears its deadline in its finally, and the aborted request signal clears the
    // attached next's window and poll before the rejection is observed: no drain is needed.
    expect([...timers.values()]).toEqual([]);
  } finally {
    session.next = realNext;
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
  // The one window either was still open at the deadline or ended empty just before it.
  expect(outcome.kind === 'timeout' && outcome.code === 'JOB_NEXT_TIMEOUT' && outcome.cursor === cursor).toBe(true);
  if (outcome.kind === 'timeout' && outcome.next) expect(outcome.next).toMatchObject({events: [], cursor, status: 'timeout'});
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

test('#1005 an empty window ending under a millisecond before the deadline sends no zero-wait repeat', async () => {
  const {attached, cursor} = await attachedPair();
  let clock = 1000;
  const now = spyOn(performance, 'now').mockImplementation(() => clock);
  const waits: number[] = [];
  const host: JobOwnerHost = {...attached, ports: {...attached.ports, async handleJobApi(request) {
    const body = JSON.parse(await request.text());
    waits.push(body.waitMs);
    // The first server window has elapsed: half a millisecond of the deadline is left, then it passes.
    if (waits.length === 1) {
      clock = 1299.5;
      setTimeout(() => {clock = 1300;}, 50);
    }
    // A zero-wait spin can starve that timer, so a repeat also ends the deadline.
    if (waits.length > 3) clock = 1300;
    return attached.ports.handleJobApi(new Request(request.url, {method: 'POST', headers: request.headers,
      body: JSON.stringify({...body, waitMs: 0})}));
  }}};
  try {
    const outcome = await waitForJobAct(host, {after: cursor, deadlineMs: 300});
    expect(outcome).toMatchObject({kind: 'timeout', code: 'JOB_NEXT_TIMEOUT', cursor,
      next: {events: [], cursor, status: 'timeout'}});
    expect(waits).toEqual([300]);
  } finally {now.mockRestore();}
});

test('#1005 abort cancels the wait with its reason and leaves no timer behind', async () => {
  const {attached, cursor} = await attachedPair();
  // Count only the wait's own timers: the waiter loop's (src/job-cli.ts) and those the attached
  // session's next arms for this request. The live owner host's closure watcher (startJobHost's
  // session.subscribe loop) re-arms its own 30000 ms window and 250 ms poll when its poll sees the
  // fixture's display-receipt write, up to 250 ms later. Those timers belong to the owner host until
  // it stops, and counting them made this bar flaky on #1012.
  const timers = new Map<unknown, string>();
  const session = attached.session as unknown as {next: (...args: unknown[]) => Promise<unknown>};
  const realNext = session.next;
  let inAttachedNext = false;
  session.next = function (this: unknown, ...args: unknown[]) {
    inAttachedNext = true;
    try { return realNext.apply(this, args); } finally { inAttachedNext = false; }
  };
  const owned = () => inAttachedNext || /src\/job-cli\.ts/.test(new Error().stack ?? '');
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const realInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  const track = (id: unknown, kind: string) => { if (owned()) timers.set(id, kind); return id; };
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id: ReturnType<typeof setTimeout> = realSet(() => {timers.delete(id); handler();}, ms);
    return track(id, 'timeout ' + ms);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {timers.delete(id); realClear(id);}) as typeof clearTimeout;
  globalThis.setInterval = ((handler: () => void, ms?: number) => track(realInterval(handler, ms), 'interval ' + ms)) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {timers.delete(id); realClearInterval(id);}) as typeof clearInterval;
  try {
    const controller = new AbortController();
    const waiting = waitForJobAct(attached, {after: cursor, deadlineMs: 5000, signal: controller.signal});
    await Bun.sleep(100);
    // The waiter's 5000 ms deadline, plus the attached next's window (the remaining budget) and its 250 ms revision poll.
    const live = [...timers.values()];
    expect(live).toHaveLength(3);
    expect(live).toContain('timeout 5000');
    expect(live).toContain('interval 250');
    controller.abort(new Error('synthetic explicit cancellation'));
    await expect(waiting).rejects.toThrow('synthetic explicit cancellation');
    // The waiter clears its deadline in its finally, and the aborted request signal clears the
    // attached next's window and poll before the rejection is observed: no drain is needed.
    expect([...timers.values()]).toEqual([]);
  } finally {
    session.next = realNext;
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

test('#1005 a record-and-package attachment resolves a live-committed comment act', async () => {
    expect(JOB_RECORD_ACT_KINDS).toEqual(['interview-picks', 'checkpoint', 'signoff', 'reopen']);
    const {attached, commit, cursor} = await recordAttachedPair(scratches, hosts);
    const {host, requests} = counted(attached);
    const sent: string[] = [];
    const probe: JobOwnerHost = {...host, ports: {...host.ports, async handleJobApi(request) {
      sent.push(JSON.parse(await request.clone().text()).schema);
      return host.ports.handleJobApi(request);
    }}};
    const started = performance.now();
    const waiting = waitForJobAct(probe, {after: cursor, deadlineMs: 5000});
    await Bun.sleep(100);
    const saved = await commit();
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    const outcome = await waiting;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(outcome.kind).toBe('act');
    if (outcome.kind !== 'act') throw new Error('unreachable');
    const row = outcome.next.events[0] as {type: string; act: {schema: string; kind: string; actId: string}};
    expect(row.type).toBe('act');
    expect(row.act).toMatchObject({schema: JOB_COMMENT_ONLY_ACT_SCHEMA,
      kind: 'comments', actId: saved.value.actId});
    expect(sent).toEqual(['rig-review/job-api@3']);
    expect(requests).toHaveLength(1);
});

test('#1005 a display receipt on a record host does not wake the attached waiter', async () => {
  const {attached, display, cursor} = await recordAttachedPair(scratches, hosts);
  const {host, requests} = counted(attached);
  const waiting = waitForJobAct(host, {after: cursor, deadlineMs: 1000});
  await Bun.sleep(100);
  await display('page-two');
  const outcome = await waiting;
  expect(outcome).toMatchObject({kind: 'timeout', code: 'JOB_NEXT_TIMEOUT', cursor});
  expect(requests).toHaveLength(1);
});

test('#1005 a malformed record act and an unknown act schema keep their JOB_ACT_INVALID refusal', async () => {
  // #1235: the record sample act is the comment-only act@10.
  const {attached, commit, cursor, agentCall} = await recordAttachedPair(scratches, hosts);
  expect((await commit()).ok).toBe(true);
  const real = await agentCall(attached, {verb: 'next', after: cursor, waitMs: 0});
  expect(real.value.events[0].act.schema).toBe(JOB_COMMENT_ONLY_ACT_SCHEMA);
  const variants = {
    'broken record value': (act: Record<string, unknown>) => ({...act, value: {...(act.value as object), comments: 'not-a-list'}}),
    'unknown schema': (act: Record<string, unknown>) => ({...act, schema: 'rig-review/act@99'}),
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const envelope = structuredClone(real);
    envelope.value.events[0].act = mutate(envelope.value.events[0].act);
    const fake: JobOwnerHost = {...attached, ports: {...attached.ports, handleJobApi: async () => Response.json(envelope)}};
    await expect(waitForJobAct(fake, {after: cursor, deadlineMs: 500}), name).rejects.toMatchObject({code: 'JOB_ACT_INVALID'});
    const cliEnvelope = {...envelope, schema: 'rig-review/job-api@2'};
    const out: string[] = [];
    await expect(jobCommand(['next', `${attached.origin}/jobs/${attached.session.jobId}`, '--after', cursor, '--until', 'act', '--wait-ms', '500'],
      {agentCapability: 'synthetic', fetch: (async () => Response.json(cliEnvelope)) as unknown as typeof fetch, write: text => out.push(text)}),
      name).rejects.toMatchObject({code: 'JOB_ACT_INVALID'});
    expect(out).toEqual([]);
  }
});

test('#1005 job next --until act returns a finalized record act from a record-and-package host', async () => {
  const {attached, commit, cursor} = await recordAttachedPair(scratches, hosts);
  expect((await commit()).ok).toBe(true);
  const out: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
    attached.ports.handleJobApi(new Request(url, init))) as typeof fetch;
  const previous = process.exitCode;
  try {
    await jobCommand(['next', `${attached.origin}/jobs/${attached.session.jobId}`, '--after', cursor, '--until', 'act', '--wait-ms', '2000'],
      {agentCapability: attached.session.hostCredentials().agent, fetch: fetcher, write: text => out.push(text)});
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toHaveLength(1);
    const envelope = JSON.parse(out[0]!);
    expect(envelope.schema).toBe('rig-review/job-api@2');
    expect(envelope.value.events.map((event: {act?: {schema: string}}) => event.act?.schema)).toEqual([JOB_COMMENT_ONLY_ACT_SCHEMA]);
  } finally {process.exitCode = previous ?? 0;}
});
