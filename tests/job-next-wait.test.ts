import {afterEach, expect, spyOn, test} from 'bun:test';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createJobHostPorts} from '../src/job-api.ts';
import {JOB_API_SCHEMA} from '../src/job-contract.ts';
import {jobCommand, parseJobCLI, type JobCLIOptions} from '../src/job-cli.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

// Every UI submission here is an explicitly synthetic test fixture. No real
// owner's review or producer acceptance is represented by these acts.
const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const previousExit = process.exitCode;
afterEach(async () => {
  process.exitCode = previousExit ?? 0;
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(options: Parameters<typeof jobFixture>[0] = {}) {
  const f = await jobFixture(options);
  fixtures.push(f);
  return f;
}
const locator = 'http://127.0.0.1:4100/jobs/job-1';
const waitArgs = ['next', locator, '--until', 'act', '--wait-ms', '100'];
function envelope(value: unknown, requestId = 'request-one') {
  return {schema: JOB_API_SCHEMA, verb: 'next', jobId: 'job-1', requestId, generation: 1, ok: true, value};
}
const empty = () => envelope({events: [], cursor: null, status: 'timeout'});
function options(fetcher: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, output: string[] = []): JobCLIOptions {
  return {agentCapability: 'synthetic-agent', write: text => output.push(text), fetch: fetcher as typeof fetch};
}
async function recordControl(name: string, value: unknown) {
  const text = JSON.stringify({probe: name, value});
  console.error(text);
  const directory = process.env.REVIEW568_EVIDENCE_DIR;
  if (directory) await writeFile(join(directory, name + '.json'), text + '\n');
}
async function prepared() {
  const f = await fixture();
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const page = await f.display(publication);
  const input = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'synthetic-wait-act', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'pass', words: ' \n원문 그대로🙂\t '}};
  return {f, publication, ask, page, input};
}

test('--until act accepts the signed CLI ceiling while the HTTP request stays at 30 seconds', () => {
  for (const value of ['1', '30001', '600000']) {
    const parsed = parseJobCLI(['next', locator, '--until', 'act', '--wait-ms', value]);
    expect(parsed.request.verb).toBe('next');
    expect(parsed.request).not.toHaveProperty('until');
    if (parsed.request.verb === 'next') expect(parsed.request.waitMs).toBe(Math.min(Number(value), 30000));
  }
});

test('invalid opt-in flags, duplicates and conflicting verbs fail before HTTP', async () => {
  const variants = [
    ['--until', 'act'], ['--until', 'act', '--wait-ms'],
    ...['0', '-1', '0.5', '1.5', '600001', 'Infinity', 'NaN', '', ' '].map(value => ['--until', 'act', '--wait-ms', value]),
    ['--until', 'unknown', '--wait-ms', '10'],
    ['--until', 'act', '--until', 'act', '--wait-ms', '10'],
    ['--until', 'act', '--wait-ms', '10', '--wait-ms', '20'],
    ['--until', 'act', '--wait-ms', '10', '--generation', '1'],
  ];
  let requests = 0;
  const opts = options(async () => {requests++; return Response.json(empty());});
  for (const variant of variants) await expect(jobCommand(['next', locator, ...variant], opts)).rejects.toThrow('JOB_REQUEST_INVALID');
  for (const verb of ['ask', 'publish', 'close']) {
    await expect(jobCommand([verb, locator, '--until', 'act', '--wait-ms', '10'], opts)).rejects.toThrow('JOB_REQUEST_INVALID');
  }
  expect(requests).toBe(0);
});

test('non-act batches advance only the accepted cursor and the whole terminal batch is verbatim', async () => {
  const {f, publication, input} = await prepared();
  const first = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  const secondAsk = await f.ask(publication, {kind: 'signoff', stage: 'plan-approved'});
  const page = await f.display(publication);
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: secondAsk.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'synthetic-second', kind: 'signoff',
    value: {stage: 'plan-approved', decision: 'approved', words: '\n second act '}}))).ok).toBe(true);
  const terminal = await (await f.call({...f.base(), verb: 'next', after: first.value.cursor, waitMs: 0})).json();
  const requests: Record<string, unknown>[] = [], out: string[] = [];
  await jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--until', 'act', '--wait-ms', '600000'], options(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(requests.length === 1 ? first : terminal);
  }, out));
  expect(requests).toHaveLength(2);
  expect(requests.map(request => request.after)).toEqual([null, first.value.cursor]);
  expect(requests.every(request => request.waitMs === 30000 && !('until' in request))).toBe(true);
  expect(JSON.parse(out[0])).toEqual(terminal);
  expect(terminal.value.events.filter((event: {type: string}) => event.type === 'act')).toHaveLength(2);
});

test('one deadline covers a stalled first fetch and caller cancellation is distinct', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), out: string[] = [];
    let networkSignal: AbortSignal | null | undefined;
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    const timer = cancel ? setTimeout(() => controller.abort(new Error('synthetic user cancel')), 10) : undefined;
    const started = performance.now();
    try {
      const command = jobCommand(waitArgs, {...options(async (_url, init) => {
        networkSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true}));
      }, out), signal: controller.signal});
      if (cancel) await expect(command).rejects.toThrow('synthetic user cancel');
      else {
        await command;
        expect(process.exitCode).toBe(3);
        expect(stderr.mock.calls).toEqual([['JOB_NEXT_TIMEOUT']]);
      }
      expect(networkSignal?.aborted).toBe(true);
      expect(out).toEqual([]);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {clearTimeout(timer); stderr.mockRestore(); process.exitCode = 0;}
  }
});

test('deadline cancels a stalled body and outputs only the last fully accepted batch', async () => {
  const {f} = await prepared();
  const first = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  const out: string[] = [], requests: Record<string, unknown>[] = [];
  let cancelled = false;
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--until', 'act', '--wait-ms', '100'], options(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return Response.json(first);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {controller.enqueue(new TextEncoder().encode('{"schema":'));},
        cancel() {cancelled = true;},
      }));
    }, out));
    expect(process.exitCode).toBe(3);
    expect(cancelled).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].after).toBe(first.value.cursor);
    expect(out).toEqual([JSON.stringify(first)]);
    expect(JSON.parse(out[0]).value.status).toBe('events');
  } finally {stderr.mockRestore();}
});

test('deadline includes validation time and dispatches no next request after expiry', async () => {
  const out: string[] = [];
  let calls = 0;
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  const parse = JSON.parse;
  const parsing = spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    const result = parse(text, reviver);
    if (result?.schema === JOB_API_SCHEMA) {
      const until = performance.now() + 30;
      while (performance.now() < until) { /* Deliberately occupy the validation budget. */ }
    }
    return result;
  });
  try {
    await jobCommand(['next', locator, '--until', 'act', '--wait-ms', '10'], options(async () => {calls++; return Response.json(empty());}, out));
    expect(process.exitCode).toBe(3);
    expect(calls).toBe(1);
    expect(out).toEqual([]);
  } finally {parsing.mockRestore(); stderr.mockRestore();}
});

test('opt-in retains the existing 1 MiB streaming, UTF-8 and schema refusals', async () => {
  let cancelled = false;
  const overflow = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {controller.enqueue(new Uint8Array(1024 * 1024 + 1));},
    cancel() {cancelled = true; return Promise.reject(new Error('synthetic cancellation rejection'));},
  }, {highWaterMark: 0}));
  await expect(jobCommand(waitArgs, options(async () => overflow))).rejects.toThrow('JOB_BODY_LIMIT');
  expect(cancelled).toBe(true);
  for (const response of [new Response('{invalid'), new Response(new Uint8Array([0xff])), new Response(null)]) {
    await expect(jobCommand(waitArgs, options(async () => response))).rejects.toThrow('JOB_REQUEST_INVALID');
  }
  await expect(jobCommand(waitArgs, options(async () => Response.json({schema: 'wrong'}))))
    .rejects.toMatchObject({code: 'JOB_REQUEST_INVALID', message: 'JOB_API_SCHEMA_MISMATCH'});
  for (const value of [envelope({events: [null], cursor: 'invalid', status: 'events'}), envelope({events: [], cursor: 5, status: 'timeout'})]) {
    await expect(jobCommand(waitArgs, options(async () => Response.json(value)))).rejects.toThrow('JOB_REQUEST_INVALID');
  }
});

async function live(f: Awaited<ReturnType<typeof jobFixture>>) {
  const {createJobFront} = await import('../src/job-front.ts');
  const requests: {waitMs: number; after: string | null; startedMs: number; returnedMs?: number; status?: string; cursor?: string | null; types?: string[]}[] = [];
  const responses: {request: unknown; status: number; body: string}[] = [];
  const started = performance.now();
  let front: ReturnType<typeof createJobFront>;
  let firstRequest!: () => void;
  const ready = new Promise<void>(resolve => {firstRequest = resolve;});
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const input = request.url.endsWith('/api') ? await request.clone().json() : null;
    const entry = input?.verb === 'next' ? {waitMs: input.waitMs as number, after: input.after as string | null,
      startedMs: performance.now() - started} : undefined;
    if (entry) {requests.push(entry); firstRequest();}
    const response = await front.fetch(request) ?? new Response(null, {status: 404});
    if (entry) {
      const text = await response.clone().text();
      responses.push({request: input, status: response.status, body: text});
      const body = JSON.parse(text);
      Object.assign(entry, {returnedMs: performance.now() - started, status: body.value?.status,
        cursor: body.value?.cursor, types: body.value?.events?.map((event: {type: string}) => event.type)});
    }
    return response;
  }});
  const origin = `http://127.0.0.1:${server.port}`;
  const ports = createJobHostPorts(f.session, origin);
  front = createJobFront({origin, ports, resource: async () => ''});
  return {server, origin, requests, responses, ready, url: origin + '/jobs/' + f.session.jobId,
    async ui(path: 'displayed' | 'acts', value: unknown) {
      return fetch(origin + '/jobs/' + f.session.jobId + '/ui/' + path, {
        method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui},
        body: JSON.stringify(value),
      });
    },
    stop() {front.stop(); server.stop(true);},
  };
}
function cli(url: string, token: string, args: string[]) {
  const argv = [process.execPath, join(import.meta.dir, '../src/entry.ts'), 'session', 'next', url, ...args];
  const child = Bun.spawn(argv, {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: {...process.env, RIG_REVIEW_JOB_AGENT_CAPABILITY: token}});
  const timer = setTimeout(() => child.kill(), 45000);
  const result = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    .then(([stdout, stderr, exit]) => {
      console.error(JSON.stringify({probe: '568 normal CLI', argv, stdout, stderr, exit}));
      return {stdout, stderr, exit};
    }).finally(() => clearTimeout(timer));
  return {child, result};
}

test('normal CLI invocation waits across the genuine 30-second server boundary for a synthetic UI act after 31 seconds', async () => {
  const {f, publication, ask} = await prepared();
  const host = await live(f);
  const displayed = await (await host.ui('displayed', {publicationId: publication.publicationId, pageId: 'synthetic-live-page',
    sourceHash: publication.source.sourceHash})).json();
  expect(displayed.ok).toBe(true);
  const before = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  const wallStarted = Date.now(), monotonicStarted = performance.now();
  const process = cli(host.url, f.credentials.agent, ['--until', 'act', '--wait-ms', '40000', '--after', before.value.cursor]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await host.ready;
    await new Promise<void>(resolve => {timer = setTimeout(resolve, Math.max(0, 31000 - (performance.now() - monotonicStarted)));});
    const committedMs = performance.now() - monotonicStarted;
    const value = {checkpointId: 'step-one', outcome: 'pass', words: ' \nsynthetic UI fixture 원문🙂\t '};
    const committed = await (await host.ui('acts', {...displayed.value, askId: ask.askId,
      expectedGeneration: f.session.status().generation, submissionId: 'synthetic-live-31s', kind: 'checkpoint', value})).json();
    expect(committed.ok).toBe(true);
    const result = await process.result;
    const monotonicElapsedMs = performance.now() - monotonicStarted;
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe('');
    const terminal = JSON.parse(result.stdout);
    const event = terminal.value.events.find((event: {type: string}) => event.type === 'act');
    expect(event.act).toEqual(committed.value);
    expect(event.act.value.words).toBe(value.words);
    expect(committedMs).toBeGreaterThanOrEqual(31000);
    expect(monotonicElapsedMs).toBeGreaterThanOrEqual(31000);
    expect(host.requests).toHaveLength(2);
    expect(host.requests[0].waitMs).toBe(30000);
    expect(host.requests[0].status).toBe('timeout');
    const firstCursor = host.requests[0].cursor;
    if (typeof firstCursor !== 'string') throw new Error('First server response must include its actual cursor');
    expect(firstCursor).toBe(before.value.cursor);
    expect(host.requests[1].after).toBe(firstCursor);
    expect(host.requests[1].waitMs).toBeGreaterThan(0);
    expect(host.requests[1].waitMs).toBeLessThanOrEqual(30000);
    console.error(JSON.stringify({probe: '568 31s receipt', syntheticOnly: true, wallStarted,
      wallEnded: Date.now(), wallElapsedMs: Date.now() - wallStarted, monotonicElapsedMs, committedMs,
      actId: event.act.actId, requests: host.requests}));
  } finally {
    clearTimeout(timer);
    if (process.child.exitCode === null) process.child.kill();
    await process.result;
    host.stop();
  }
}, 45000);

test('normal CLI preserves ordinary zero/immediate/timeout output and timeout exit 3 with or without an accepted response', async () => {
  const f = await fixture(), host = await live(f);
  try {
    for (const args of [[], ['--wait-ms', '0'], ['--wait-ms', '10']]) {
      const result = await cli(host.url, f.credentials.agent, args).result;
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).value).toMatchObject({events: [], cursor: null, status: 'timeout'});
    }
    const timedOut = await cli(host.url, f.credentials.agent, ['--until', 'act', '--wait-ms', '100']).result;
    expect(timedOut.exit).toBe(3);
    expect(timedOut.stderr).toBe('JOB_NEXT_TIMEOUT\n');
    if (timedOut.stdout) expect(JSON.parse(timedOut.stdout).value).toMatchObject({events: [], cursor: null, status: 'timeout'});
    const noBodyServer = Bun.serve({hostname: '127.0.0.1', port: 0, idleTimeout: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new TextEncoder().encode('{'));}}))});
    try {
      const none = await cli(`http://127.0.0.1:${noBodyServer.port}/jobs/${f.session.jobId}`, f.credentials.agent,
        ['--until', 'act', '--wait-ms', '50']).result;
      expect(none).toEqual({stdout: '', stderr: 'JOB_NEXT_TIMEOUT\n', exit: 3});
    } finally {noBodyServer.stop(true);}
  } finally {host.stop();}
});

test('normal CLI retains authentication and cursor failures plus closure before an act', async () => {
  const f = await fixture(), host = await live(f);
  try {
    for (const [token, args, code] of [
      ['synthetic-wrong-token', [], 'JOB_CAPABILITY_REQUIRED'],
      [f.credentials.agent, ['--after', 'not-a-cursor'], 'JOB_CURSOR_INVALID'],
    ] as const) {
      const result = await cli(host.url, token, ['--until', 'act', '--wait-ms', '1000', ...args]).result;
      expect(result.exit).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe(code);
      expect(result.stderr).toBe('');
    }
    await f.call({...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'synthetic-close', reason: 'fixture complete'});
    const closed = await cli(host.url, f.credentials.agent, ['--until', 'act', '--wait-ms', '1000']).result;
    expect(closed.exit).toBe(1);
    expect(closed.stderr).toBe('JOB_CLOSED\n');
    expect(JSON.parse(closed.stdout).value.events[0].type).toBe('closed');
    const cursor = JSON.parse(closed.stdout).value.cursor;
    const exhausted = await cli(host.url, f.credentials.agent, ['--until', 'act', '--wait-ms', '1000', '--after', cursor]).result;
    expect(exhausted.exit).toBe(1);
    expect(exhausted.stderr).toBe('JOB_CLOSED\n');
    expect(JSON.parse(exhausted.stdout).value).toMatchObject({events: [], cursor, status: 'closed'});
  } finally {host.stop();}
});

test('a failed real storage commit and standalone file save cannot wake an act wait', async () => {
  const {Database} = await import('bun:sqlite');
  const {f, input} = await prepared();
  const before = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  const db = new Database(join(f.state, 'jobs.sqlite'));
  const host = await live(f);
  let command: ReturnType<typeof cli> | undefined;
  try {
    db.exec("CREATE TRIGGER fail_wait_commit BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'568 planted commit failure'); END");
    command = cli(host.url, f.credentials.agent, ['--until', 'act', '--wait-ms', '150', '--after', before.value.cursor]);
    let childExited = false;
    void command.result.then(() => {childExited = true;});
    await host.ready;
    await writeFile(join(f.scratch, 'synthetic-standalone-save.json'), '{"syntheticFileSaveOnly":true}\n');
    const failedResponse = await host.ui('acts', input);
    const failedText = await failedResponse.text();
    const childExitedAtCommitFailure = childExited;
    const completedRequestsAtCommitFailure = host.responses.length;
    const result = await command.result;
    await recordControl('failed-commit-terminal', {child: result, failedCommit: {status: failedResponse.status, body: failedText},
      childExitedAtCommitFailure, completedRequestsAtCommitFailure, requests: host.requests, responses: host.responses});
    const failed = JSON.parse(failedText);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('JOB_STORAGE_FAILED');
    expect(result.exit).toBe(3);
    expect(result.stderr).toBe('JOB_NEXT_TIMEOUT\n');
    expect(childExitedAtCommitFailure).toBe(false);
    expect(completedRequestsAtCommitFailure).toBe(0);
    for (const response of host.responses) expect(JSON.parse(response.body).value?.events ?? []).toEqual([]);
    if (result.stdout) {
      expect(JSON.parse(result.stdout).value.events).toEqual([]);
      expect(JSON.parse(result.stdout).value.cursor).toBe(before.value.cursor);
    }
    db.exec('DROP TRIGGER fail_wait_commit');
    const after = await (await f.call({...f.base(), verb: 'next', after: before.value.cursor, waitMs: 0})).json();
    await recordControl('failed-commit-replay', {before, after});
    expect(after.value.events).toEqual([]);
    expect(after.value.cursor).toBe(before.value.cursor);
    const saved = await (await host.ui('acts', input)).json();
    const duplicate = await (await host.ui('acts', input)).json();
    await recordControl('repaired-commit-dedup', {saved, duplicate});
    expect(saved.ok).toBe(true);
    expect(duplicate).toEqual(saved);
    command = cli(host.url, f.credentials.agent, ['--until', 'act', '--wait-ms', '100', '--after', before.value.cursor]);
    const resumed = await command.result;
    await recordControl('repaired-commit-resume', {child: resumed, requests: host.requests, responses: host.responses});
    expect(resumed.exit).toBe(0);
    const replayed = JSON.parse(resumed.stdout).value.events;
    expect(replayed).toHaveLength(1);
    if (saved.ok) expect(replayed[0].act.actId).toBe(saved.value.actId);
  } finally {
    if (command?.child.exitCode === null) command.child.kill();
    await command?.result;
    host.stop();
    db.close();
  }
});

test('pre-cancelled caller dispatches no HTTP and cancelling a response body releases it', async () => {
  for (const preCancelled of [true, false]) {
    const controller = new AbortController(), out: string[] = [];
    let requests = 0, cancelled = false;
    if (preCancelled) controller.abort(new Error('synthetic explicit cancellation'));
    const timer = preCancelled ? undefined : setTimeout(() => controller.abort(new Error('synthetic explicit cancellation')), 10);
    try {
      await expect(jobCommand(waitArgs, {...options(async () => {
        requests++;
        return new Response(new ReadableStream<Uint8Array>({cancel() {cancelled = true;}}));
      }, out), signal: controller.signal})).rejects.toThrow('synthetic explicit cancellation');
      expect(requests).toBe(preCancelled ? 0 : 1);
      expect(cancelled).toBe(!preCancelled);
      expect(out).toEqual([]);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {clearTimeout(timer);}
  }
});

test('positive sub-millisecond remaining budget sends server zero and accepts a complete act', async () => {
  const {f, input} = await prepared();
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).ok).toBe(true);
  const batch = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  const waits: number[] = [], out: string[] = [];
  const now = spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(0.75);
  try {
    await jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--until', 'act', '--wait-ms', '1'], options(async (_url, init) => {
      waits.push(JSON.parse(String(init?.body)).waitMs);
      return Response.json(batch);
    }, out));
    expect(waits).toEqual([0]);
    expect(out).toEqual([JSON.stringify(batch)]);
  } finally {now.mockRestore();}
});

test('a malformed row after an act rejects the entire batch without output', async () => {
  const {f, input} = await prepared();
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).ok).toBe(true);
  const batch = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  batch.value.events.push(null);
  const out: string[] = [];
  await expect(jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--until', 'act', '--wait-ms', '100'],
    options(async () => Response.json(batch), out))).rejects.toThrow('JOB_REQUEST_INVALID');
  expect(out).toEqual([]);
});

test('a late fetch response is cancelled after the deadline and transport errors remain failures', async () => {
  let cancelled = false;
  let resolve!: (response: Response) => void;
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await jobCommand(['next', locator, '--until', 'act', '--wait-ms', '10'], options(async () => new Promise<Response>(done => {resolve = done;})));
    expect(process.exitCode).toBe(3);
    resolve(new Response(new ReadableStream<Uint8Array>({cancel() {cancelled = true;}})));
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
    process.exitCode = 0;
    await expect(jobCommand(waitArgs, options(async () => {throw new Error('synthetic connection failure');}))).rejects.toThrow('synthetic connection failure');
    expect(process.exitCode).toBe(0);
  } finally {stderr.mockRestore();}
});
