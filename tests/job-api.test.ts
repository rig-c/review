import { afterEach, expect, test } from 'bun:test';
import { jobBodyLimit, parseJobRequest } from '../src/job-api.ts';
import { JOB_API_SCHEMA } from '../src/job-contract.ts';
import { parseJobCLI, jobCommand } from '../src/job-cli.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }

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
