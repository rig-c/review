import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {JOB_API_SCHEMA, JOB_ACT_SCHEMA, JOB_PARTS_ENUMERATOR_RANGE} from '../src/job-contract.ts';
import {jobPartsEnumeratorVersion} from '../src/job-api.ts';
import {jobCommand} from '../src/job-cli.ts';
import {startJobHost, type JobHostOptions} from '../src/job-front.ts';
import {JobSession} from '../src/job-session.ts';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';
import * as publicHost from '../src/job-host.ts';
import type {
  JobLegacyPartsVerdictValue,
  JobPanelComposition,
  JobPartsVerdictAct,
  PanelComponent,
  PartsVerdictValue,
} from '../src/job-host.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {for (const fixture of fixtures.splice(0)) await fixture.close();});
async function fixture() {
  const value = await jobFixture();
  fixtures.push(value);
  return value;
}

test('#557/#588 control public job-host retains its runtime exports, record-mode surface, and legacy markers', () => {
  const legacyRuntimeExports = [
    'JOB_CAPABILITIES', 'startJobHost',
    'JOB_API_SCHEMA', 'JOB_API_V3_SCHEMA', 'JOB_ACT_SCHEMA', 'JOB_RECORD_ACT_SCHEMA', 'JOB_RECORD_READER_ID',
    'JOB_PARTS_ENUMERATOR_RANGE', 'JOB_ENABLED_ACT_KINDS',
    'JOB_RESERVED_ACT_KINDS', 'JOB_PLAN_BOUND_SIGNOFF_STAGES', 'JOB_CONSUMER_AUTH_MODE', 'JOB_ERROR_CODES',
    'parseRecordAct', 'prepareJobRecordAct', 'prepareJobRecordSource',
  ];
  const expectedRuntimeExports = [...legacyRuntimeExports,
    'JOB_COMMENTS_ACT_SCHEMA', 'PARTS_COMMENTS_VERDICT_SCHEMA',
    'REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA', 'REVIEW_COMMENTS_SESSION_SCHEMA',
    'parseCommentsAct', 'parseCommentsCompareSession', 'parseCommentsPartsVerdict', 'parseCommentsSession',
    'projectComments', 'projectSelectedCommentsFeedback',
    // #714: the act@7 decoder and its schema constant.
    'JOB_COMMENT_CONTEXT_ACT_SCHEMA', 'parseContextCommentsAct',
  ].sort();
  expect(legacyRuntimeExports).toHaveLength(16);
  expect(expectedRuntimeExports).toHaveLength(28);
  expect(Object.keys(publicHost).sort()).toEqual(expectedRuntimeExports);
  for (const name of expectedRuntimeExports) {
    const missing = new Set(Object.keys(publicHost));
    missing.delete(name);
    expect(() => expect([...missing].sort()).toEqual(expectedRuntimeExports)).toThrow();
  }
  const extra = new Set(Object.keys(publicHost));
  extra.add('UNAPPROVED_PUBLIC_EXPORT');
  expect(() => expect([...extra].sort()).toEqual(expectedRuntimeExports)).toThrow();
  expect(publicHost.JOB_API_SCHEMA).toBe('rig-review/job-api@2');
  expect(publicHost.JOB_API_V3_SCHEMA).toBe('rig-review/job-api@3');
  expect(publicHost.JOB_ACT_SCHEMA).toBe('rig-review/act@2');
  expect(publicHost.JOB_RECORD_ACT_SCHEMA).toBe('rig-review/act@4');
  expect(publicHost.JOB_RECORD_READER_ID).toBe('rig-create/publication-reader/2');
  expect(publicHost.JOB_COMMENTS_ACT_SCHEMA).toBe('rig-review/act@6');
  expect(publicHost.JOB_COMMENT_CONTEXT_ACT_SCHEMA).toBe('rig-review/act@7');
  const _c2Types: [
    JobPartsVerdictAct['schema'],
    PartsVerdictValue['verdict'],
    JobLegacyPartsVerdictValue['verdict'],
    JobPanelComposition['schema'],
    PanelComponent,
  ] = ['rig-review/act@5', 'approved', 'pending', 'rig-review/panels@1', 'act.submit'];
  expect(_c2Types[0]).toBe('rig-review/act@5');
});

// Planned incompatible-schema and version controls operate only on disposable state.
test('C4 schemas and enumerator range retain the actual installed version', () => {
  expect(JOB_API_SCHEMA).toBe('rig-review/job-api@2');
  expect(JOB_ACT_SCHEMA).toBe('rig-review/act@2');
  expect(JOB_PARTS_ENUMERATOR_RANGE).toBe('>=2.25.0 <3.0.0');
  for (const version of ['2.25.0', '2.25.1', '2.26.0', '2.37.0', '2.99.99']) {
    expect(jobPartsEnumeratorVersion(version)).toBe(version);
  }
  for (const version of [undefined, '', '2.24.9', '3.0.0', '3.7.0', 'invalid', '2.25.1\n']) {
    expect(() => jobPartsEnumeratorVersion(version)).toThrow('PARTS_ENUMERATOR_VERSION_MISMATCH');
    expect(() => jobPartsEnumeratorVersion(version)).toThrow(JOB_PARTS_ENUMERATOR_RANGE);
  }
});

test('C4 rejects old and missing request schema before generation or replay changes', async () => {
  const f = await fixture();
  const before = f.session.status();
  for (const schema of ['rig-review/job-api@1', undefined]) {
    const response = await f.call({...await f.publishRequest(), schema});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({schema: JOB_API_SCHEMA, ok: false,
      error: {code: 'JOB_REQUEST_INVALID', message: 'JOB_API_SCHEMA_MISMATCH'}});
    expect(f.session.status()).toEqual(before);
  }
});

test('C4 CLI refuses an old response before printing its value', async () => {
  const f = await fixture();
  const output: string[] = [];
  await expect(jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--wait-ms', '0'], {
    agentCapability: f.credentials.agent,
    write: line => output.push(line),
    fetch: (async () => Response.json({schema: 'rig-review/job-api@1', ok: true, value: {}})) as unknown as typeof fetch,
  })).rejects.toThrow('JOB_API_SCHEMA_MISMATCH');
  expect(output).toEqual([]);
});

test('C4 stored schemas survive reopening and old markers refuse without rewriting state', async () => {
  const f = await fixture();
  const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner' as const}};
  const reopened = new JobSession(options);
  expect(reopened.jobId).toBe(f.session.jobId);
  reopened.dispose();
  const db = new Database(join(f.state, 'jobs.sqlite'));
  try {
    const query = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?');
    const original = JSON.parse(query.get(f.session.jobId)!.document);
    expect(original).toMatchObject({apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA});
    for (const key of ['apiSchema', 'actSchema']) {
      for (const version of [undefined, 'old']) {
        const moved = {...original, [key]: version};
        const frozen = JSON.stringify(moved);
        db.query('UPDATE jobs SET document=? WHERE job_id=?').run(frozen, f.session.jobId);
        expect(() => new JobSession(options)).toThrow('JOB_STORED_SCHEMA_MISMATCH');
        expect(() => f.session.status()).toThrow('JOB_STORED_SCHEMA_MISMATCH');
        expect(query.get(f.session.jobId)!.document).toBe(frozen);
      }
    }
  } finally {db.close();}
});

test('C4 publication version must match the trusted host installation', async () => {
  const f = await fixture();
  const parts = await syntheticJobParts(f);
  f.setContext({...f.getContext(), parts: {...parts, enumeratorVersion: '2.25.0'}});
  const response = await f.call(await f.publishRequest());
  const failure = await response.json();
  expect(response.status).toBe(409);
  expect(failure.error.code).toBe('JOB_SOURCE_UNRETAINABLE');
  expect(failure.error.message).toContain('PARTS_ENUMERATOR_VERSION_MISMATCH');
  expect(failure.error.message).toContain('received="2.25.0"');
  expect(failure.error.message).toContain('installed="2.25.1"');
  expect(f.session.status().generation).toBe(0);
});

test('C4 managed host compares enumerator ID and actual version before writer installation', async () => {
  const f = await fixture();
  let installed = 0;
  const options: JobHostOptions = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}, partsEnumerator: f.partsEnumerator,
    partsEnumeratorId: 'synthetic-parts/1',
    installWriterBinding: () => {installed++;}, bindingId: 'synthetic-writer/1'};
  const host = await startJobHost(options);
  try {
    const reused = await startJobHost({...options,
      partsEnumerator: {...f.partsEnumerator, enumerate: () => []}});
    expect(reused.reused).toBe(true);
    expect(reused.ownerUrl).toBe(host.ownerUrl);
    reused.stop();
    expect(installed).toBe(2);
    for (const change of [
      {partsEnumeratorId: 'synthetic-parts/2'},
      {partsEnumerator: {...f.partsEnumerator, version: '2.26.0'}},
    ]) {
      await expect(startJobHost({...options, ...change})).rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH'});
      expect(installed).toBe(2);
    }
    const request = await f.call({...f.base(), verb: 'next', after: null, waitMs: 0});
    expect(request.status).toBe(200);
  } finally {host.stop();}
});

test('C4 host descriptor rejects old semantic markers while preserving the listener', async () => {
  const f = await fixture();
  const options: JobHostOptions = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}};
  const host = await startJobHost(options);
  const path = join(f.state, 'job-ui', host.session.jobId + '.json');
  const original = await readFile(path, 'utf8');
  const descriptor = JSON.parse(original);
  try {
    expect(descriptor).toMatchObject({apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
      partsEnumeratorId: null, partsEnumeratorVersion: null});
    for (const key of ['apiSchema', 'actSchema']) {
      for (const value of [undefined, 'old']) {
        const frozen = JSON.stringify({...descriptor, [key]: value});
        await writeFile(path, frozen);
        await expect(startJobHost(options)).rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH', option: key});
        expect(await readFile(path, 'utf8')).toBe(frozen);
        const response = await fetch(host.origin + '/jobs/' + host.session.jobId + '/host', {
          headers: {'X-Review-Capability': host.session.hostCredentials().ui},
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA});
      }
    }
  } finally {
    await writeFile(path, original);
    host.stop();
  }
});

test('C4 enumerator hook and its declared ID are paired before creating a listener', async () => {
  const f = await fixture();
  const base: JobHostOptions = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}};
  for (const change of [{partsEnumerator: f.partsEnumerator}, {partsEnumeratorId: 'orphan'},
    {partsEnumerator: f.partsEnumerator, partsEnumeratorId: ''}]) {
    await expect(startJobHost({...base, ...change})).rejects.toMatchObject({
      code: 'JOB_HOST_OPTION_ID_INVALID', option: 'partsEnumerator',
    });
  }
});

// Planned RED demonstrates that a stopped listener is not an active reuse target.
test('C4 stopped host restarts the same job with changed valid hook IDs or enumerator version', async () => {
  for (const change of [
    {readerId: 'restart-reader/2'},
    {bindingId: 'restart-writer/2'},
    {partsEnumeratorId: 'restart-parts/2'},
    {partsEnumerator: {version: '2.26.0', enumerate: () => []}},
  ]) {
    const f = await fixture();
    let installed = 0;
    const options: JobHostOptions = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner'},
      readPublished: async () => f.getContext(), readerId: 'restart-reader/1',
      installWriterBinding: () => {installed++;}, bindingId: 'restart-writer/1',
      partsEnumerator: f.partsEnumerator, partsEnumeratorId: 'restart-parts/1'};
    const host = await startJobHost(options);
    const jobId = host.session.jobId;
    const ownerUrl = host.ownerUrl;
    host.stop();
    let restarted: Awaited<ReturnType<typeof startJobHost>> | undefined;
    try {
      restarted = await startJobHost({...options, ...change});
      expect(restarted.reused).toBe(false);
      expect(restarted.session.jobId).toBe(jobId);
      expect(restarted.ownerUrl).toBe(ownerUrl);
      expect(installed).toBe(2);
      const response = await fetch(restarted.origin + '/jobs/' + jobId + '/host', {
        headers: {'X-Review-Capability': restarted.session.hostCredentials().ui},
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({jobId, apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
        readerId: change.readerId ?? options.readerId,
        bindingId: change.bindingId ?? options.bindingId,
        partsEnumeratorId: change.partsEnumeratorId ?? options.partsEnumeratorId,
        partsEnumeratorVersion: change.partsEnumerator?.version ?? f.partsEnumerator.version});
    } finally {restarted?.stop();}
  }
});

test('C4 authenticated active listener with old semantic schemas still refuses reuse', async () => {
  const f = await fixture();
  let installed = 0;
  let probes = 0;
  const capability = f.session.hostCredentials().ui;
  let returned: Record<string, unknown> = {};
  const server = Bun.serve({hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (request.method !== 'GET' || new URL(request.url).pathname !== '/jobs/' + f.session.jobId + '/host' ||
        request.headers.get('X-Review-Capability') !== capability) return new Response(null, {status: 403});
      probes++;
      return Response.json(returned);
    },
  });
  const origin = 'http://127.0.0.1:' + server.port;
  const descriptor = {schema: 'rig-review-job-host/1', jobId: f.session.jobId,
    origin, fingerprint: 'f'.repeat(64), pid: process.pid,
    apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
    readerId: null, bindingId: 'old-listener-writer/1', partsEnumeratorId: null, partsEnumeratorVersion: null};
  const directory = join(f.state, 'job-ui');
  const path = join(directory, f.session.jobId + '.json');
  const frozen = JSON.stringify(descriptor);
  const options: JobHostOptions = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'},
    installWriterBinding: () => {installed++;}, bindingId: 'old-listener-writer/1'};
  try {
    await mkdir(directory, {mode: 0o700});
    await writeFile(path, frozen, {mode: 0o600});
    for (const [key, oldSchema] of [['apiSchema', 'rig-review/job-api@1'], ['actSchema', 'rig-review/act@1']] as const) {
      for (const value of [undefined, oldSchema]) {
        returned = {...descriptor, [key]: value};
        await expect(startJobHost(options)).rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH', option: key});
        expect(installed).toBe(0);
        expect(await readFile(path, 'utf8')).toBe(frozen);
      }
    }
    expect(probes).toBe(4);
    expect(server.port).toBe(Number(new URL(origin).port));
  } finally {server.stop(true);}
});

test('#563 public job-host re-exports strict reuse-only types while preserving the twelve runtime exports', async () => {
  const f = await fixture();
  const options: publicHost.JobHostOptions = {
    root: f.root,
    stateDir: f.state,
    fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'},
  };
  const owner = await publicHost.startJobHost(options);
  try {
    const expected: publicHost.JobHostReuseExpectation | null = owner.attachment;
    expect(expected).not.toBeNull();
    const attached = await publicHost.startJobHost({
      ...options,
      reuseOnly: {expected: expected!},
    });
    expect(attached.reused).toBe(true);
    expect(attached.attachment).toEqual(expected);
    attached.stop();
  } finally {
    owner.stop();
  }
});
