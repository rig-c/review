import { afterEach, expect, spyOn, test } from 'bun:test';
import { createJobHostPorts, jobBodyLimit, parseJobRequest } from '../src/job-api.ts';
import { JOB_API_SCHEMA } from '../src/job-contract.ts';
import { parseJobCLI, jobCommand } from '../src/job-cli.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import * as fs from 'node:fs';
import {existsSync, fstatSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {readFile, readdir, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {createJobFront} from '../src/job-front.ts';
import {jobHash} from '../src/job-api.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }

async function consumerCLI(locator: string, actId: string, grant: string, destination?: string) {
  const args = [process.execPath, join(import.meta.dir, '../src/entry.ts'), 'session', 'fetch-act',
    locator, '--act', actId, '--consumer-capability-stdin'];
  if (destination !== undefined) args.push('--still-out', destination);
  const env = {...process.env};
  delete env.RIG_REVIEW_JOB_AGENT_CAPABILITY;
  const child = Bun.spawn(args, {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env});
  const timeout = setTimeout(() => child.kill(), 4000);
  try {
    child.stdin.write(grant + '\n');
    child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    console.error(JSON.stringify({probe: '#557 consumer CLI', argv: args, exit, stdout, stderr}));
    return {stdout, stderr, exit};
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

test('semantic requests are closed, require explicit null fields and reserve disabled act kinds', async () => {
  const f = await fixture(), request = await f.publishRequest();
  expect(parseJobRequest(request)).toEqual(request);
  expect(() => parseJobRequest({ ...request, internalSession: {} })).toThrow('JOB_REQUEST_INVALID');
  expect(() => parseJobRequest({ ...request, result: { path: 'out' } })).toThrow('JOB_REQUEST_INVALID');
  for (const kind of ['mesh-edit', 'described-correction']) {
    expect(() => parseJobRequest({ ...f.base(), verb: 'ask', expectedGeneration: 0, idempotencyKey: 'reserved',
      publicationId: 'publication', subject: { kind } })).toThrow('JOB_ACT_KIND_DISABLED');
  }
});

test('agent, UI and consumer capabilities remain separate and browser mutations require exact Origin', async () => {
  const f = await fixture(), publication = await f.publish();
  const request = { ...f.base(), verb: 'next', after: null, waitMs: 0 };
  for (const token of [f.credentials.ui, f.session.writerGrant().fetchCapability, 'unrelated']) {
    expect((await (await f.call(request, token)).json()).error.code).toBe('JOB_CAPABILITY_REQUIRED');
  }
  const invalidOrigin = new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.invalid',
      Authorization: 'Bearer ' + f.credentials.agent }, body: JSON.stringify(request),
  });
  expect((await (await f.ports.handleJobApi(invalidOrigin)).json()).error.code).toBe('JOB_SAME_ORIGIN_REQUIRED');
  const fakeUI = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({}, f.credentials.agent));
  expect(fakeUI.ok).toBe(false);
  if (!fakeUI.ok) expect(fakeUI.error.code).toBe('JOB_CAPABILITY_REQUIRED');
  const crossOrigin = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({}, f.credentials.ui, 'https://unrelated.invalid'));
  expect(crossOrigin.ok).toBe(false);
  if (!crossOrigin.ok) expect(crossOrigin.error.code).toBe('JOB_SAME_ORIGIN_REQUIRED');
  expect((await f.ports.readPublication(f.session.jobId, publication.publicationId)).ok).toBe(true);
});

test('body, wait, path and cross-job bounds refuse without applying a generation', async () => {
  const f = await fixture();
  const oversized = await f.ports.handleJobApi(new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(jobBodyLimit + 1),
  }));
  expect(oversized.status).toBe(413);
  expect((await oversized.json()).error.code).toBe('JOB_BODY_LIMIT');
  const request = await f.publishRequest();
  for (const path of ['../outside', '/absolute', 'out/link/../file', 'http://example.invalid/file', 'out%2fprivate']) {
    const refused = await (await f.call({ ...request, result: { path, selector: null } })).json();
    expect(refused.ok).toBe(false);
  }
  expect((await (await f.call({ ...f.base(), verb: 'next', after: null, waitMs: 30_001 })).json()).error.code).toBe('JOB_REQUEST_INVALID');
  expect((await (await f.call({ ...f.base(), jobId: 'another-job', verb: 'next', after: null, waitMs: 0 })).json()).error.code).toBe('JOB_UNKNOWN');
  expect(f.session.status().generation).toBe(0);
});

test('CLI constructs semantic vocabulary without a storage file and exposes no human-act or consumer-fetch verb', async () => {
  const f = await fixture();
  const locator = f.origin + '/jobs/' + f.session.jobId;
  const parsed = parseJobCLI(['publish', locator, '--generation', '0', '--key', 'first', '--result', 'out', '--freeze-hold', 'held']);
  expect(parsed.request.verb).toBe('publish');
  expect(() => parseJobCLI(['fetch-act', locator])).toThrow('JOB_REQUEST_INVALID');
  expect(() => parseJobCLI(['signoff', locator])).toThrow('JOB_REQUEST_INVALID');
  expect(() => parseJobCLI(['next', locator + '?state=/private/file'])).toThrow('JOB_LOOPBACK_REQUIRED');
  const output: string[] = [];
  await jobCommand(['next', locator, '--wait-ms', '0'], {
    agentCapability: f.credentials.agent,
    write: line => output.push(line),
    fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
  });
  expect(JSON.parse(output[0]).value.status).toBe('timeout');
  expect(output[0]).not.toContain(f.state);
});

test('CLI streams response bytes up to 1 MiB, cancels on overflow and preserves decode/schema/exit priorities', async () => {
  const locator = 'http://127.0.0.1:4100/jobs/job-1';
  const args = ['next', locator, '--wait-ms', '0'] as const;
  const run = (response: Response, out: string[] = []) => jobCommand(args, {
    agentCapability: 'cap-agent',
    write: line => out.push(line),
    fetch: (async () => response) as unknown as typeof fetch,
  });

  let pulls = 0;
  let cancelled = false;
  const chunkSize = 300 * 1024;
  const overflowStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 5) throw new Error('continued reading after overflow');
      const chunk = new Uint8Array(chunkSize);
      if (pulls === 1) chunk[0] = 0xff;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  await expect(run(new Response(overflowStream, { headers: { 'Content-Length': '2' } }))).rejects.toThrow('JOB_BODY_LIMIT');
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(5);

  const rejectCancelStream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { return Promise.reject(new Error('cancel boom')); },
  });
  await expect(run(new Response(rejectCancelStream))).rejects.toThrow('JOB_BODY_LIMIT');

  const prefix = `{"schema":${JSON.stringify(JOB_API_SCHEMA)},"pad":"`;
  const suffix = '"}';
  const exactBytes = new TextEncoder().encode(prefix + 'a'.repeat(1024 * 1024 - prefix.length - suffix.length) + suffix);
  expect(exactBytes.byteLength).toBe(1024 * 1024);
  const exactOut: string[] = [];
  await run(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(exactBytes.subarray(0, 512 * 1024));
      controller.enqueue(exactBytes.subarray(512 * 1024));
      controller.close();
    },
  })), exactOut);
  expect(exactOut).toHaveLength(1);
  expect(Buffer.byteLength(exactOut[0])).toBe(1024 * 1024);

  const boundaryPlusOneOut: string[] = [];
  await expect(run(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(exactBytes);
      controller.enqueue(new Uint8Array([0x20]));
      controller.close();
    },
  }), { headers: { 'Content-Length': '10' } }), boundaryPlusOneOut)).rejects.toThrow('JOB_BODY_LIMIT');
  expect(boundaryPlusOneOut).toHaveLength(0);

  const utf8Json = new TextEncoder().encode(JSON.stringify({ schema: JOB_API_SCHEMA, note: '한글🙂' }));
  const splitIndex = utf8Json.indexOf(0xed) + 1;
  const utf8Out: string[] = [];
  await run(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(utf8Json.subarray(0, splitIndex));
      controller.enqueue(utf8Json.subarray(splitIndex));
      controller.close();
    },
  })), utf8Out);
  expect(JSON.parse(utf8Out[0])).toEqual({ schema: JOB_API_SCHEMA, note: '한글🙂' });

  await expect(run(new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])))).rejects.toThrow('JOB_REQUEST_INVALID');
  await expect(run(new Response('{invalid-json'))).rejects.toThrow('JOB_REQUEST_INVALID');
  await expect(run(new Response(null))).rejects.toThrow('JOB_REQUEST_INVALID');
  await expect(run(new Response(''))).rejects.toThrow('JOB_REQUEST_INVALID');
  await expect(run(Response.json({ schema: 'wrong-schema' }))).rejects.toMatchObject({ code: 'JOB_REQUEST_INVALID', message: 'JOB_API_SCHEMA_MISMATCH' });

  const prevExitCode = process.exitCode;
  try {
    process.exitCode = 0;
    const errorOut: string[] = [];
    await run(Response.json({ schema: JOB_API_SCHEMA, ok: false, error: { code: 'JOB_UNKNOWN', message: 'no job' } }, { status: 409 }), errorOut);
    expect(JSON.parse(errorOut[0]).ok).toBe(false);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = prevExitCode ?? 0;
  }

  const readFailure = new Error('stream aborted');
  await expect(run(new Response(new ReadableStream<Uint8Array>({
    pull() { throw readFailure; },
  })))).rejects.toThrow('stream aborted');
});

test('public next and consumer act reads are independent of a renamed private page-storage field', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'storage-projection', kind: 'checkpoint',
    value: { checkpointId: 'step-one', outcome: 'pass', words: '' } }));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const request = { ...f.base(), verb: 'next', after: null, waitMs: 0 };
  const before = await (await f.call(request)).json();
  const grant = f.session.writerGrant();
  const database = new Database(join(f.state, 'jobs.sqlite'));
  const row = database.query<{ document: string }, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!;
  try {
    const data = JSON.parse(row.document);
    data.privateDisplayReceipts = data.pages;
    delete data.pages;
    database.query('UPDATE jobs SET document=? WHERE job_id=?').run(JSON.stringify(data), f.session.jobId);
    expect(await (await f.call(request)).json()).toEqual(before);
    const fetched = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: saved.value.actId }, grant.fetchCapability)).json();
    expect(fetched.value).toEqual(saved.value);
    expect(JSON.stringify(fetched)).not.toContain('privateDisplayReceipts');
  } finally {
    database.query('UPDATE jobs SET document=? WHERE job_id=?').run(row.document, f.session.jobId);
    database.close();
  }
});

test('#557 control default checkpoint fetch keeps the API envelope and exact reviewer value', async () => {
  const f = await fixture();
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const page = await f.display(publication);
  const value = {checkpointId: 'step-one', outcome: 'pass' as const, words: ' \n원문 그대로\t '};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: '557-default', kind: 'checkpoint', value}));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const request = {...f.base(), verb: 'fetch-act', actId: saved.value.actId};
  const response = await f.call(request, f.session.writerGrant().fetchCapability);
  expect(await response.text()).toBe(JSON.stringify({schema: JOB_API_SCHEMA, verb: 'fetch-act',
    jobId: f.session.jobId, requestId: request.requestId, generation: f.session.status().generation,
    ok: true, value: saved.value}));
  expect(saved.value.schema).toBe('rig-review/act@2');
  expect(saved.value).not.toHaveProperty('still');
  expect(saved.value.value).toEqual({...value, planStepId: 'step-one'});
});

test('#557 R08 raw negotiation returns the act bytes while the default envelope remains separate', async () => {
  const f = await fixture();
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const page = await f.display(publication);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: '557-raw', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'pass', words: ' \n원문\t '}}));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const response = await f.ports.handleJobApi(new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/vnd.rig-review.act+json',
      Authorization: 'Bearer ' + f.session.writerGrant().fetchCapability},
    body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: saved.value.actId}),
  }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(JSON.stringify(saved.value));
});

test('#557 control unauthorized capture refuses before reading a larger request stream', async () => {
  const f = await fixture();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(jobBodyLimit + 1));
      controller.close();
    },
  }, {highWaterMark: 0});
  const response = await f.ports.commitUIAct(f.session.jobId, new Request(f.origin + `/jobs/${f.session.jobId}/ui/acts`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: f.origin,
      'X-Review-Capability': f.credentials.agent}, body,
  }));
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe('JOB_CAPABILITY_REQUIRED');
  expect(pulls).toBe(0);
});

test('#557 control an agent bearer cannot negotiate raw act or PNG consumer reads', async () => {
  const f = await fixture();
  for (const accept of ['application/vnd.rig-review.act+json', 'image/png']) {
    const response = await f.ports.handleJobApi(new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Accept: accept,
        Authorization: 'Bearer ' + f.credentials.agent},
      body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: 'missing'}),
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('JOB_CAPABILITY_REQUIRED');
  }
});

test('#557 R09 production CLI consumes its existing grant on stdin and writes only raw act bytes', async () => {
  const f = await fixture();
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const page = await f.display(publication);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: '557-cli', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'pass', words: ' \n원문\t '}}));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: request => f.ports.handleJobApi(new Request(f.origin + new URL(request.url).pathname, request))});
  try {
    const grant = f.session.writerGrant().fetchCapability;
    const output = await consumerCLI(server.url.origin + `/jobs/${f.session.jobId}`, saved.value.actId, grant);
    expect(output.exit).toBe(0);
    expect(output.stdout).toBe(JSON.stringify(saved.value));
    expect(output.stderr).toBe('');
    expect(output.stdout + output.stderr).not.toContain(grant);
  } finally {
    await server.stop(true);
  }
});

test('#557 control oversized stdin grant fails before any request or stdout', async () => {
  let requests = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => {
    requests++;
    return new Response('unexpected request', {status: 500});
  }});
  try {
    const output = await consumerCLI(server.url.origin + '/jobs/oversized-input', 'absent', 'x'.repeat(4097));
    expect(output.exit).not.toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('JOB_');
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test('#557 R10 one production CLI call writes the PNG before emitting exact act bytes', async () => {
  const f = await fixture();
  const {input, bytes, sha256} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const destination = join(f.scratch, 'consumer-output');
  await mkdir(destination);
  await writeFile(join(destination, 'consumer-owned.txt'), 'preserve');
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: request => f.ports.handleJobApi(new Request(f.origin + new URL(request.url).pathname, request))});
  try {
    const output = await consumerCLI(server.url.origin + `/jobs/${f.session.jobId}`, saved.value.actId,
      f.session.writerGrant().fetchCapability, destination);
    expect(output.exit).toBe(0);
    expect(output.stdout).toBe(JSON.stringify(saved.value));
    expect(output.stderr).toBe('');
    expect((await readFile(join(destination, sha256 + '.png'))).equals(bytes)).toBe(true);
    expect((await readdir(destination)).sort()).toEqual([sha256 + '.png', 'consumer-owned.txt'].sort());
  } finally {
    await server.stop(true);
  }
});

test('#557 R11 failed PNG read emits empty stdout and preserves consumer-owned files', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const destination = join(f.scratch, 'consumer-output');
  await mkdir(destination);
  await writeFile(join(destination, 'act.json'), 'consumer-owned-before-command');
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: request => {
    if (request.headers.get('accept') === 'image/png') {
      return Response.json({schema: JOB_API_SCHEMA, ok: false,
        error: {code: 'JOB_STILL_CAPTURE_FAILED', message: 'JOB_STILL_CAPTURE_FAILED'}}, {status: 409});
    }
    return f.ports.handleJobApi(new Request(f.origin + new URL(request.url).pathname, request));
  }});
  try {
    const output = await consumerCLI(server.url.origin + `/jobs/${f.session.jobId}`, saved.value.actId,
      f.session.writerGrant().fetchCapability, destination);
    expect(output.exit).not.toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('JOB_STILL_CAPTURE_FAILED');
    expect(await readdir(destination)).toEqual(['act.json']);
    expect(await readFile(join(destination, 'act.json'), 'utf8')).toBe('consumer-owned-before-command');
  } finally {
    await server.stop(true);
  }
});

function padSyntheticPng(bytes: Buffer, length: number): Buffer {
  const chunk = Buffer.alloc(length - bytes.length, 120);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write('tEXt', 4);
  chunk.write('pad\0', 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
}

test('#557 backend actual HTTP front forwards an authenticated 8 MiB PNG and both consumer representations', async () => {
  const f = await fixture();
  const {input, bytes} = await rigStillInput(f);
  const png = padSyntheticPng(bytes, 8 * 1024 * 1024);
  const capture = {...input.capture, png: 'data:image/png;base64,' + png.toString('base64')};
  let front: ReturnType<typeof createJobFront>;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: async request => await front.fetch(request) ?? new Response(null, {status: 404})});
  const origin = server.url.origin;
  front = createJobFront({origin, ports: createJobHostPorts(f.session, origin), resource: async () => ''});
  try {
    const response = await fetch(origin + `/jobs/${f.session.jobId}/ui/acts`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui},
      body: JSON.stringify({...input, capture})});
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.ok).toBe(true);
    expect(saved.value.still.sha256).toBe(jobHash(png));
    const grant = f.session.writerGrant().fetchCapability;
    for (const accept of ['application/vnd.rig-review.act+json', 'image/png']) {
      const fetched = await fetch(origin + `/jobs/${f.session.jobId}/api`, {method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: accept, Authorization: 'Bearer ' + grant},
        body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: saved.value.actId})});
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-type')).toBe(accept);
      expect(Buffer.from(await fetched.arrayBuffer()).equals(accept === 'image/png' ? png : Buffer.from(JSON.stringify(saved.value)))).toBe(true);
    }
    const nonRig = await fetch(origin + `/jobs/${f.session.jobId}/ui/acts`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui},
      body: JSON.stringify({...input, kind: 'checkpoint', value: {words: 'x'.repeat(jobBodyLimit)}})});
    expect(nonRig.status).toBe(413);
    expect((await nonRig.json()).error.code).toBe('JOB_BODY_LIMIT');
  } finally {
    front.stop();
    await server.stop(true);
  }
}, 15000);

for (const ending of ['zero-write', 'midwrite', 'partial-success', 'existing-zero-write'] as const) {
  test(`#557 backend consumer ${ending} obeys PNG ownership and exact stdout ordering`, async () => {
    const f = await fixture();
    const {input, bytes, sha256} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    const directory = join(f.scratch, 'consumer');
    await mkdir(directory);
    if (ending === 'existing-zero-write') await writeFile(join(directory, sha256 + '.png'), bytes);
    const chunks: Buffer[] = [];
    let writes = 0;
    const pending = jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
      '--still-out', directory], {consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes(chunk) {
        writes++;
        if (ending === 'zero-write' || ending === 'existing-zero-write' || ending === 'midwrite' && writes > 1) {
          throw Object.assign(new Error('planted stdout EPIPE'), {code: 'EPIPE'});
        }
        const count = Math.min(17, chunk.byteLength);
        chunks.push(Buffer.from(chunk.subarray(0, count)));
        return count;
      }});
    if (ending === 'partial-success') {
      await pending;
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(JSON.stringify(saved.value)));
    } else await expect(pending).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
    const names = await readdir(directory);
    if (ending === 'zero-write') expect(names).toEqual([]);
    else {
      expect(names).toEqual([sha256 + '.png']);
      expect((await readFile(join(directory, sha256 + '.png'))).equals(bytes)).toBe(true);
    }
    if (ending === 'midwrite') expect(Buffer.concat(chunks)).toHaveLength(17);
    if (ending === 'zero-write' || ending === 'existing-zero-write') expect(Buffer.concat(chunks)).toHaveLength(0);
  });
}

for (const target of ['symlink', 'different-bytes', 'other-writer-lock'] as const) {
  test(`#557 backend ${target} output refuses without changing another writer's bytes`, async () => {
    const f = await fixture();
    const {input, sha256} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    const directory = join(f.scratch, 'consumer');
    await mkdir(directory);
    const sentinel = join(f.scratch, 'other-writer');
    await writeFile(sentinel, 'preserve other writer');
    if (target === 'symlink') await symlink(sentinel, join(directory, sha256 + '.png'));
    if (target === 'different-bytes') await writeFile(join(directory, sha256 + '.png'), 'different bytes');
    if (target === 'other-writer-lock') await writeFile(join(directory, '.rig-review-still.lock'), 'other owner');
    let stdout = '';
    await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
      '--still-out', directory], {consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      write: text => {stdout += text;}})).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
    expect(stdout).toBe('');
    expect(await readFile(sentinel, 'utf8')).toBe('preserve other writer');
    if (target === 'different-bytes') expect(await readFile(join(directory, sha256 + '.png'), 'utf8')).toBe('different bytes');
    if (target === 'other-writer-lock') expect(await readFile(join(directory, '.rig-review-still.lock'), 'utf8')).toBe('other owner');
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
}

test('#557 backend consumer bounds stdin and raw streams before filesystem or stdout mutation', async () => {
  const f = await fixture();
  let requests = 0, cancelled = false, stdout = '';
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {controller.enqueue(new Uint8Array(4097));},
    cancel() {cancelled = true;},
  }, {highWaterMark: 0});
  await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', 'absent',
    '--consumer-capability-stdin'], {consumerInput: input,
    fetch: Object.assign(async () => {requests++; throw new Error('must not request');}, {preconnect: fetch.preconnect}),
    write: text => {stdout += text;}})).rejects.toThrow('JOB_BODY_LIMIT');
  expect(requests).toBe(0);
  expect(cancelled).toBe(true);
  const overflow = new ReadableStream<Uint8Array>({
    pull(controller) {controller.enqueue(new Uint8Array(512 * 1024 + 1));},
  }, {highWaterMark: 0});
  await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', 'absent'], {
    consumerCapability: f.session.writerGrant().fetchCapability, write: text => {stdout += text;},
    fetch: Object.assign(async () => new Response(overflow, {headers: {'Content-Length': '1'}}), {preconnect: fetch.preconnect}),
  })).rejects.toThrow('JOB_BODY_LIMIT');
  expect(stdout).toBe('');
});

test('#567 consumer still output fsyncs destination directory after verified PNG rename and before first stdout byte, and reuses existing verified PNG', async () => {
  const f = await fixture();
  const {input, bytes, sha256} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const directory = join(f.scratch, 'consumer-dirsync');
  await mkdir(directory);
  const dirStat = statSync(directory);
  const realFsync = fs.fsyncSync;
  const fsyncEvents: Array<{isDirectory: boolean; isFile: boolean; dev: number; ino: number;
    pngPresent: boolean; pngVerified: boolean; tmpCount: number; stdoutBytes: number; writeCalls: number}> = [];
  const chunks: Buffer[] = [];
  let writes = 0;
  let fsyncCountAtFirstWrite = -1;
  let dirFsyncBeforeFirstWrite = false;
  const spy = spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
    const info = fstatSync(fd);
    const pngPath = join(directory, sha256 + '.png');
    const pngPresent = existsSync(pngPath);
    fsyncEvents.push({
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      dev: info.dev,
      ino: info.ino,
      pngPresent,
      pngVerified: pngPresent && readFileSync(pngPath).equals(bytes),
      tmpCount: readdirSync(directory).filter(name => name.endsWith('.tmp')).length,
      stdoutBytes: Buffer.concat(chunks).byteLength,
      writeCalls: writes,
    });
    return realFsync(fd);
  });
  try {
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
      '--still-out', directory], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes(chunk) {
        if (writes === 0) {
          fsyncCountAtFirstWrite = fsyncEvents.length;
          dirFsyncBeforeFirstWrite = fsyncEvents.some(event => event.isDirectory);
        }
        writes++;
        const count = Math.min(23, chunk.byteLength);
        chunks.push(Buffer.from(chunk.subarray(0, count)));
        return count;
      },
    });
    expect(fsyncEvents).toEqual([
      expect.objectContaining({
        isFile: true, isDirectory: false, pngPresent: false, pngVerified: false,
        tmpCount: 1, stdoutBytes: 0, writeCalls: 0,
      }),
      {
        isFile: false, isDirectory: true, dev: dirStat.dev, ino: dirStat.ino,
        pngPresent: true, pngVerified: true, tmpCount: 0, stdoutBytes: 0, writeCalls: 0,
      },
    ]);
    expect(fsyncCountAtFirstWrite).toBe(2);
    expect(dirFsyncBeforeFirstWrite).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(JSON.stringify(saved.value)));
    expect(await readdir(directory)).toEqual([sha256 + '.png']);

    const installedIno = statSync(join(directory, sha256 + '.png')).ino;
    fsyncEvents.length = 0;
    chunks.length = 0;
    writes = 0;
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
      '--still-out', directory], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes(chunk) {
        writes++;
        chunks.push(Buffer.from(chunk));
        return chunk.byteLength;
      },
    });
    expect(statSync(join(directory, sha256 + '.png')).ino).toBe(installedIno);
    expect(fsyncEvents).toEqual([{
      isFile: false, isDirectory: true, dev: dirStat.dev, ino: dirStat.ino,
      pngPresent: true, pngVerified: true, tmpCount: 0, stdoutBytes: 0, writeCalls: 0,
    }]);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(JSON.stringify(saved.value)));
  } finally {
    spy.mockRestore();
  }
});

for (const fault of ['ebadf', 'eio', 'einval'] as const) {
  test(`#567 directory fsync ${fault} failure emits zero stdout bytes, cleans up own install and lock, and preserves preexisting verified PNG`, async () => {
    const f = await fixture();
    const {input, bytes, sha256} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    const directory = join(f.scratch, 'consumer-dirsync-' + fault);
    await mkdir(directory);
    const realFsync = fs.fsyncSync;
    const spy = spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      if (fstatSync(fd).isDirectory()) {
        if (fault === 'ebadf') return realFsync(-1);
        const code = fault === 'eio' ? 'EIO' : 'EINVAL';
        throw Object.assign(new Error(`directory fsync ${code}`), {code});
      }
      return realFsync(fd);
    });
    try {
      let writes = 0;
      const chunks: Buffer[] = [];
      await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
        '--still-out', directory], {
        consumerCapability: f.session.writerGrant().fetchCapability,
        fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
        writeBytes(chunk) {
          writes++;
          chunks.push(Buffer.from(chunk));
          return chunk.byteLength;
        },
      })).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
      expect(writes).toBe(0);
      expect(Buffer.concat(chunks)).toHaveLength(0);
      expect(await readdir(directory)).toEqual([]);

      await writeFile(join(directory, sha256 + '.png'), bytes);
      const preexistingIno = statSync(join(directory, sha256 + '.png')).ino;
      await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
        '--still-out', directory], {
        consumerCapability: f.session.writerGrant().fetchCapability,
        fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
        writeBytes(chunk) {
          writes++;
          chunks.push(Buffer.from(chunk));
          return chunk.byteLength;
        },
      })).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
      expect(writes).toBe(0);
      expect(Buffer.concat(chunks)).toHaveLength(0);
      expect(await readdir(directory)).toEqual([sha256 + '.png']);
      expect(statSync(join(directory, sha256 + '.png')).ino).toBe(preexistingIno);
      expect((await readFile(join(directory, sha256 + '.png'))).equals(bytes)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
}

for (const ending of ['success', 'zero-write', 'midwrite', 'legacy-write'] as const) {
  test(`#567 newly installed PNG descriptor pins its unlinked inode through ${ending} output and closes once`, async () => {
    const f = await fixture();
    const {input, sha256} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    if (!saved.ok) throw new Error(saved.error.code);
    const directory = join(f.scratch, 'consumer-pinned-' + ending);
    await mkdir(directory);
    const target = join(directory, sha256 + '.png');
    const realFsync = fs.fsyncSync, realClose = fs.closeSync, realUnlink = fs.unlinkSync;
    let pngDescriptor: number | undefined;
    let original: fs.Stats | undefined;
    let beforeUnlink: fs.Stats | undefined;
    let afterUnlink: fs.Stats | undefined;
    let liveDuringLockCleanup = false;
    let closeCalls = 0, writeCalls = 0;
    const syncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      const info = fstatSync(fd);
      if (info.isFile()) { pngDescriptor = fd; original = info; }
      return realFsync(fd);
    });
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      if (fd === pngDescriptor) closeCalls++;
      return realClose(fd);
    });
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((path: fs.PathLike) => {
      if (path === join(directory, '.rig-review-still.lock')) {
        try { liveDuringLockCleanup = fstatSync(pngDescriptor!).nlink === 0; } catch {}
      }
      return realUnlink(path);
    });
    const writeBytes = (chunk: Uint8Array): number => {
      writeCalls++;
      if (writeCalls === 1) {
        try { beforeUnlink = fstatSync(pngDescriptor!); } catch {}
        unlinkSync(target);
        try { afterUnlink = fstatSync(pngDescriptor!); } catch {}
        writeFileSync(target, 'other-writer-replacement-png');
      }
      if (ending === 'zero-write' || ending === 'legacy-write' || ending === 'midwrite' && writeCalls > 1) {
        throw Object.assign(new Error('stdout EPIPE'), {code: 'EPIPE'});
      }
      return ending === 'midwrite' ? Math.min(17, chunk.byteLength) : chunk.byteLength;
    };
    try {
      const pending = jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
        '--still-out', directory], {
        consumerCapability: f.session.writerGrant().fetchCapability,
        fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
        ...(ending === 'legacy-write' ? {write: (text: string) => { writeBytes(Buffer.from(text)); }} : {writeBytes}),
      });
      if (ending === 'success') await pending;
      else await expect(pending).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
      console.error(JSON.stringify({probe: '#567 pinned PNG descriptor', ending, pngDescriptor,
        liveAtOutput: beforeUnlink !== undefined, liveAfterUnlink: afterUnlink !== undefined,
        liveDuringLockCleanup, closeCalls}));
      expect(pngDescriptor).toBeDefined();
      expect(beforeUnlink).toMatchObject({dev: original!.dev, ino: original!.ino, nlink: 1});
      expect(afterUnlink).toMatchObject({dev: original!.dev, ino: original!.ino, nlink: 0});
      expect(liveDuringLockCleanup).toBe(true);
      expect(statSync(target).ino).not.toBe(original!.ino);
      expect(readFileSync(target, 'utf8')).toBe('other-writer-replacement-png');
      expect(closeCalls).toBe(1);
      expect(() => fstatSync(pngDescriptor!)).toThrow();
      expect(readdirSync(directory)).toEqual([sha256 + '.png']);
    } finally {
      unlinkSpy.mockRestore();
      closeSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
}

for (const fault of ['file-fsync', 'directory-fsync', 'rename'] as const) {
  test(`#567 newly created PNG descriptor closes once after ${fault} failure`, async () => {
    const f = await fixture();
    const {input} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    if (!saved.ok) throw new Error(saved.error.code);
    const directory = join(f.scratch, 'consumer-close-' + fault);
    await mkdir(directory);
    const realFsync = fs.fsyncSync, realClose = fs.closeSync;
    let pngDescriptor: number | undefined;
    let closeCalls = 0, writeCalls = 0;
    const syncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      const info = fstatSync(fd);
      if (info.isFile()) pngDescriptor = fd;
      if (fault === 'file-fsync' && info.isFile() || fault === 'directory-fsync' && info.isDirectory()) {
        throw Object.assign(new Error('planted fsync EIO'), {code: 'EIO'});
      }
      return realFsync(fd);
    });
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      if (fd === pngDescriptor) closeCalls++;
      return realClose(fd);
    });
    const renameSpy = fault === 'rename' ? spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('planted rename EIO'), {code: 'EIO'});
    }) : undefined;
    try {
      await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
        '--still-out', directory], {
        consumerCapability: f.session.writerGrant().fetchCapability,
        fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
        writeBytes(chunk) { writeCalls++; return chunk.byteLength; },
      })).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
      expect(pngDescriptor).toBeDefined();
      expect(writeCalls).toBe(0);
      expect(closeCalls).toBe(1);
      expect(() => fstatSync(pngDescriptor!)).toThrow();
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      renameSpy?.mockRestore();
      closeSpy.mockRestore();
      syncSpy.mockRestore();
    }
  });
}

test('#567 retained .rig-review-still.lock produces named actionable refusal with exact local path, preserves lock bytes and owner serialization, and retries after removal', async () => {
  const f = await fixture();
  const {input, bytes, sha256} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const directory = join(f.scratch, 'consumer-lock');
  const alias = join(f.scratch, 'consumer-lock-alias');
  await mkdir(directory);
  await symlink(directory, alias);
  const lockPath = join(realpathSync(directory), '.rig-review-still.lock');
  await writeFile(lockPath, 'retained-by-killed-writer');

  let inProcessStdout = '';
  let caught: unknown;
  try {
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
      '--still-out', alias], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      write: text => {inProcessStdout += text;},
    });
  } catch (error) {
    caught = error;
  }
  expect(inProcessStdout).toBe('');
  expect(caught).toMatchObject({code: 'JOB_STILL_OUTPUT_FAILED'});
  expect((caught as Error).message).toContain('JOB_STILL_OUTPUT_FAILED');
  expect((caught as Error).message).toContain(lockPath);
  expect(await readFile(lockPath, 'utf8')).toBe('retained-by-killed-writer');
  expect(await readdir(directory)).toEqual(['.rig-review-still.lock']);

  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: request => f.ports.handleJobApi(new Request(f.origin + new URL(request.url).pathname, request))});
  try {
    const grant = f.session.writerGrant().fetchCapability;
    const locator = server.url.origin + `/jobs/${f.session.jobId}`;
    const refused = await consumerCLI(locator, saved.value.actId, grant, alias);
    expect(refused.exit).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('JOB_STILL_OUTPUT_FAILED');
    expect(refused.stderr).toContain(lockPath);
    expect(await readFile(lockPath, 'utf8')).toBe('retained-by-killed-writer');
    expect(await readdir(directory)).toEqual(['.rig-review-still.lock']);

    await rm(lockPath);
    const recovered = await consumerCLI(locator, saved.value.actId, grant, alias);
    expect(recovered.exit).toBe(0);
    expect(recovered.stdout).toBe(JSON.stringify(saved.value));
    expect(recovered.stderr).toBe('');
    expect((await readFile(join(directory, sha256 + '.png'))).equals(bytes)).toBe(true);
    expect(await readdir(directory)).toEqual([sha256 + '.png']);

    await rm(join(directory, sha256 + '.png'));
    await expect(jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId,
      '--still-out', directory], {
      consumerCapability: grant,
      fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes() {
        unlinkSync(lockPath);
        writeFileSync(lockPath, 'other-writer-replacement-lock');
        unlinkSync(join(directory, sha256 + '.png'));
        writeFileSync(join(directory, sha256 + '.png'), 'other-writer-replacement-png');
        throw Object.assign(new Error('stdout EPIPE'), {code: 'EPIPE'});
      },
    })).rejects.toThrow('JOB_STILL_OUTPUT_FAILED');
    expect(await readFile(lockPath, 'utf8')).toBe('other-writer-replacement-lock');
    expect(await readFile(join(directory, sha256 + '.png'), 'utf8')).toBe('other-writer-replacement-png');
  } finally {
    await server.stop(true);
  }
});

import {job645SidecarFixture} from './helpers/645-sidecar-fixture.ts';
import {retainedPublicationRoutes} from '../src/job-front.ts';

async function normal645OwnerHttp(withPublication = true) {
  const packet = await job645SidecarFixture(), {f} = packet;
  let front: ReturnType<typeof createJobFront> | undefined;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch: async request => await front?.fetch(request) ?? new Response(null, {status: 404})});
  try {
    const origin = server.url.origin, retained = retainedPublicationRoutes(f.session);
    const forwarded: string[] = [];
    front = createJobFront({origin, ports: createJobHostPorts(f.session, origin), hubIncarnation: '645-hub',
      resource: async name => name,
      publication: withPublication ? async (...args) => {forwarded.push(args[3]); return retained(...args);} : undefined});
    const publication = await f.publish(), display = f.session.displayPublication(publication.publicationId);
    return {...packet, origin, publication, forwarded, api: origin + display.routes.apiBase,
      entry: origin + `/jobs/${f.session.jobId}/`,
      close: async () => {front!.stop(); await server.stop(true); await f.close();}};
  } catch (error) {front?.stop(); await server.stop(true); await f.close(); throw error;}
}

test('#645 normal HTTP owner dispatcher admits only the retained Difference query shape', async () => {
  const owner = await normal645OwnerHttp();
  try {
    for (const query of ['threshold=0&footprints=false', 'threshold=16&footprints=true',
      'threshold=255&footprints=false', 'footprints=true&threshold=17']) {
      const response = await fetch(owner.api + 'stage-parts/difference/0?' + query);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/png');
      const png = Buffer.from(await response.arrayBuffer());
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(20);
      expect(response.headers.get('X-Difference-Count')).not.toBeNull();
    }
    expect((await fetch(owner.api + 'stage-parts')).status).toBe(200);
    const before = owner.forwarded.length;
    for (const path of [
      'stage-parts/difference/0?threshold=16', 'stage-parts/difference/0?footprints=true',
      'stage-parts/difference/0?threshold=16&threshold=17&footprints=false',
      'stage-parts/difference/0?threshold=16&footprints=false&footprints=true',
      'stage-parts/difference/0?threshold=16&%74hreshold=17&footprints=false',
      'stage-parts/difference/0?threshold=16&footprints=false&extra=1',
      'stage-parts/difference/0?threshold=16&footprints=false&lang=en',
      'stage-parts/difference/0?threshold=16&other=false',
      'stage-parts/difference/00?threshold=16&footprints=false',
      'stage-parts/difference/-1?threshold=16&footprints=false',
      'stage-parts/image/0?threshold=16&footprints=false',
      'stage-parts?threshold=16&footprints=false', 'review?threshold=16&footprints=false',
      'unknown?threshold=16&footprints=false',
    ]) expect((await fetch(owner.api + path)).status).toBe(400);
    expect(owner.forwarded.length).toBe(before);
    expect((await fetch(owner.api + 'stage-parts/difference/0?threshold=16&footprints=false', {method: 'HEAD'})).status).toBe(400);
    expect((await fetch(owner.api + 'stage-parts/difference/0?threshold=16&footprints=false', {method: 'POST'})).status).toBe(405);
    // The shared response remains the sole threshold/boolean value validator.
    for (const query of ['threshold=256&footprints=false', 'threshold=-1&footprints=false',
      'threshold=1.5&footprints=false', 'threshold=&footprints=false',
      'threshold=16&footprints=TRUE', 'threshold=16&footprints=0']) {
      const response = await fetch(owner.api + 'stage-parts/difference/0?' + query);
      expect(response.status).toBe(409);
      expect((await response.json()).error.message).toContain('PARTS_COMPARISON_INVALID');
    }
    expect((await fetch(owner.entry + '?lang=en')).status).toBe(200);
    expect((await fetch(owner.entry + '?lang=ko')).status).toBe(200);
    expect((await fetch(owner.entry + '?hub=645-hub&lang=ko')).status).toBe(200);
    for (const query of ['lang=fr', 'lang=en&lang=ko', 'lang=en&extra=1', 'hub=wrong&lang=en']) {
      expect((await fetch(owner.entry + '?' + query)).status).toBe(400);
    }
    expect((await fetch(owner.entry + 'job.js?threshold=16&footprints=false')).status).toBe(400);
    expect((await fetch(owner.api + 'unknown')).status).toBe(404);
    const noPublication = await normal645OwnerHttp(false);
    try {expect((await fetch(noPublication.api + 'stage-parts/difference/0?threshold=16&footprints=false')).status).toBe(400);}
    finally {await noPublication.close();}
  } finally {await owner.close();}
});

test('#645 normal HTTP Difference preserves origin capability instance and retained-source guards', async () => {
  const owner = await normal645OwnerHttp();
  try {
    const endpoint = owner.api + 'stage-parts/difference/0?threshold=16&footprints=false';
    expect((await fetch(endpoint, {headers: {Origin: 'http://example.invalid'}})).status).toBe(403);
    expect((await fetch(endpoint, {headers: {'Sec-Fetch-Site': 'cross-site'}})).status).toBe(403);
    expect(owner.forwarded).toHaveLength(0);
    const wrongHost = owner.origin.replace('127.0.0.1', 'localhost');
    expect((await fetch(wrongHost + new URL(endpoint).pathname + new URL(endpoint).search)).status).toBe(403);
    const wrongInstance = endpoint.replace(owner.publication.instanceKey, '0'.repeat(64));
    expect((await fetch(wrongInstance)).status).toBe(409);
    expect((await fetch(endpoint.replace(owner.publication.publicationId, 'unknown-publication'))).status).toBe(404);
    const displayed = owner.entry + 'ui/displayed';
    const body = JSON.stringify({publicationId: owner.publication.publicationId, pageId: '645-normal', sourceHash: owner.publication.source.sourceHash});
    expect((await fetch(displayed, {method: 'POST', headers: {Origin: owner.origin, 'Content-Type': 'application/json',
      'X-Review-Capability': 'wrong'}, body})).status).toBe(403);
    expect((await fetch(displayed, {method: 'POST', headers: {'Content-Type': 'application/json',
      'X-Review-Capability': owner.f.credentials.ui}, body})).status).toBe(403);
    expect((await fetch(displayed, {method: 'POST', headers: {Origin: owner.origin, 'Content-Type': 'application/json',
      'X-Review-Capability': owner.f.credentials.ui}, body})).status).toBe(200);
    expect((await fetch(endpoint)).status).toBe(200);
    const retained = owner.f.session.retainedSource(owner.publication.publicationId);
    await writeFile(join(retained.snapshotRoot, 'standalone/painting_in_rig.json'), '{}');
    expect((await fetch(endpoint)).status).toBe(409);
  } finally {await owner.close();}
});
