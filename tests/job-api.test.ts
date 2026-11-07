import { afterEach, expect, test } from 'bun:test';
import { jobBodyLimit, parseJobRequest } from '../src/job-api.ts';
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
