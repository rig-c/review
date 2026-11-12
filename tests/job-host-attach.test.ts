import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmod, cp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {lstatSync, readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {JobSession} from '../src/job-session.ts';
import {JobStore, JobError} from '../src/job-store.ts';
import {createJobRequestContext, jobHostIdentity} from '../src/job-front.ts';
import {startJobHub} from '../src/job-host.ts';
import {
  JOB_ACT_SCHEMA,
  JOB_API_SCHEMA,
  startJobHost,
  type JobHostAttachField,
  type JobHostOptions,
  type JobHostReuseExpectation,
  type JobOwnerHost,
} from '../src/job-host.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const hosts: JobOwnerHost[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const server of servers.splice(0)) server.stop(true);
  for (const host of hosts.splice(0)) host.stop();
  for (const f of fixtures.splice(0)) await f.close();
});

async function createFixture() {
  const f = await jobFixture();
  fixtures.push(f);
  return f;
}

function baseOptions(f: Awaited<ReturnType<typeof jobFixture>>): JobHostOptions {
  return {
    root: f.root,
    stateDir: join(f.scratch, 'host-state'),
    fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'},
    readPublished: async () => f.getContext(),
    readerId: 'reader/1',
    installWriterBinding: () => {},
    bindingId: 'writer/1',
    partsEnumerator: f.partsEnumerator,
    partsEnumeratorId: 'parts/1',
  };
}

function cloneExpected(expected: JobHostReuseExpectation): JobHostReuseExpectation {
  return {
    jobId: expected.jobId,
    origin: expected.origin,
    listenerIncarnation: expected.listenerIncarnation,
    binding: {
      ...expected.binding,
      reviewer: {...expected.binding.reviewer},
    },
  };
}

test('ordinary startJobHost mints frozen attachment, keeps GET /host unchanged, and strict reuseOnly attaches without writer reinstall', async () => {
  const f = await createFixture();
  let writerInstalls = 0;
  const options: JobHostOptions = {
    ...baseOptions(f),
    installWriterBinding: () => { writerInstalls++; },
  };
  const owner = await startJobHost(options);
  hosts.push(owner);
  expect(owner.reused).toBe(false);
  expect(writerInstalls).toBe(1);
  expect(owner.attachment).not.toBeNull();
  const expected = owner.attachment!;
  expect(Object.isFrozen(expected)).toBe(true);
  expect(Object.isFrozen(expected.binding)).toBe(true);
  expect(Object.isFrozen(expected.binding.reviewer)).toBe(true);
  expect(expected.jobId).toBe(owner.session.jobId);
  expect(expected.origin).toBe(owner.origin);
  expect(expected.listenerIncarnation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // Ordinary GET /jobs/<jobId>/host projection and keys remain unchanged.
  const getHostRes = await fetch(`${owner.origin}/jobs/${owner.session.jobId}/host`, {
    headers: {'X-Review-Capability': owner.session.hostCredentials().ui},
  });
  expect(getHostRes.status).toBe(200);
  const getHostJson = await getHostRes.json() as Record<string, unknown>;
  expect(Object.keys(getHostJson).sort()).toEqual([
    'actSchema', 'apiSchema', 'bindingId', 'fingerprint', 'jobId',
    'origin', 'partsEnumeratorId', 'partsEnumeratorVersion', 'pid', 'readerId', 'schema',
  ]);
  expect('listenerIncarnation' in getHostJson).toBe(false);
  expect('binding' in getHostJson).toBe(false);

  // Ordinary reuse populates attachment when POST /host full attestation is available.
  const ordinaryReused = await startJobHost(options);
  hosts.push(ordinaryReused);
  expect(ordinaryReused.reused).toBe(true);
  expect(ordinaryReused.attachment).toEqual(expected);
  expect(writerInstalls).toBe(2);

  // Strict reuseOnly attaches without calling installWriterBinding and returns working semantic ports.
  const attached = await startJobHost({
    ...options,
    reuseOnly: {expected: cloneExpected(expected)},
  });
  hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.origin).toBe(owner.origin);
  expect(attached.ownerUrl).toBe(owner.ownerUrl);
  expect(attached.attachment).toEqual(expected);
  expect(writerInstalls).toBe(2);

  const liveness = await attached.ports.jobLiveness(owner.session.jobId);
  expect(liveness).toEqual({ok: true, value: {active: true, busy: false}});

  const nextReq = new Request(`${attached.origin}/jobs/${owner.session.jobId}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + attached.session.hostCredentials().agent,
    },
    body: JSON.stringify({
      schema: JOB_API_SCHEMA,
      jobId: owner.session.jobId,
      requestId: 'strict-next-1',
      verb: 'next',
      after: null,
      waitMs: 0,
    }),
  });
  const nextRes = await attached.ports.handleJobApi(nextReq);
  expect(nextRes.status).toBe(200);
  expect(await nextRes.json()).toMatchObject({ok: true, value: {status: 'timeout', events: []}});
});

test('hook IDs and fingerprints longer than 1024 bytes succeed within the 65536-byte transport envelope', async () => {
  const f = await createFixture();
  const longToken = 'x'.repeat(2048);
  const options: JobHostOptions = {
    ...baseOptions(f),
    fingerprint: 'fp-' + longToken,
    readerId: 'reader-' + longToken,
    bindingId: 'writer-' + longToken,
    partsEnumeratorId: 'parts-' + longToken,
  };
  const owner = await startJobHost(options);
  hosts.push(owner);
  expect(owner.attachment).not.toBeNull();
  const attached = await startJobHost({
    ...options,
    reuseOnly: {expected: owner.attachment!},
  });
  hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.attachment?.binding.fingerprint).toBe('fp-' + longToken);
});

test('input validation rejects malformed reuseOnly and options before any filesystem, SQLite, listener, or callback side effects', async () => {
  const f = await createFixture();
  const missingState = join(f.scratch, 'never-created-state');
  let callbackCalls = 0;
  const options: JobHostOptions = {
    ...baseOptions(f),
    stateDir: missingState,
    readPublished: async () => { callbackCalls++; return f.getContext(); },
    installWriterBinding: () => { callbackCalls++; },
  };
  const validExpected: JobHostReuseExpectation = {
    jobId: 'job-valid-1',
    origin: 'http://127.0.0.1:41234',
    listenerIncarnation: '00000000-0000-4000-8000-000000000001',
    binding: {
      root: f.root,
      stateDir: missingState,
      fingerprint: options.fingerprint,
      reviewer: {id: 'declared-owner', role: 'owner'},
      readerId: 'reader/1',
      bindingId: 'writer/1',
      partsEnumeratorId: 'parts/1',
      partsEnumeratorVersion: f.partsEnumerator.version,
      apiSchema: JOB_API_SCHEMA,
      actSchema: JOB_ACT_SCHEMA,
    },
  };

  const badReuseOnlyInputs: unknown[] = [
    null,
    true,
    false,
    {},
    {expected: validExpected, extra: 1},
    {expected: {...validExpected, extra: 1}},
    {expected: {...validExpected, binding: {...validExpected.binding, extra: 1}}},
    {expected: {...validExpected, binding: {...validExpected.binding, reviewer: {id: 'a', role: 'owner', extra: 1}}}},
    {expected: {...validExpected, origin: 'https://127.0.0.1:41234'}},
    {expected: {...validExpected, origin: 'http://localhost:41234'}},
    {expected: {...validExpected, origin: 'http://127.0.0.1:41234/'}},
    {expected: {...validExpected, origin: 'http://127.0.0.1:0'}},
    {expected: {...validExpected, origin: 'http://127.0.0.1:65536'}},
    {expected: {...validExpected, listenerIncarnation: '00000000-0000-4000-8000-00000000000A'}},
    {expected: {...validExpected, listenerIncarnation: '00000000-0000-1000-8000-000000000001'}},
    {expected: {...validExpected, listenerIncarnation: '00000000-0000-4000-0000-000000000001'}},
    {expected: {...validExpected, listenerIncarnation: ' 00000000-0000-4000-8000-000000000001'}},
    {expected: {...validExpected, binding: {...validExpected.binding, root: 'relative/path'}}},
    {expected: {...validExpected, binding: {...validExpected.binding, stateDir: 'relative/state'}}},
    {expected: {...validExpected, binding: {...validExpected.binding, readerId: undefined}}},
    {expected: {...validExpected, binding: {...validExpected.binding, readerId: ''}}},
    {expected: {...validExpected, binding: {...validExpected.binding, partsEnumeratorId: null, partsEnumeratorVersion: '2.25.1'}}},
    {expected: {...validExpected, binding: {...validExpected.binding, partsEnumeratorId: 'parts/1', partsEnumeratorVersion: null}}},
    {expected: {...validExpected, binding: {...validExpected.binding, partsEnumeratorId: 'parts/1', partsEnumeratorVersion: '1.0.0'}}},
    {expected: {...validExpected, binding: {...validExpected.binding, apiSchema: 'rig-review/job-api@1'}}},
    {expected: {...validExpected, binding: {...validExpected.binding, actSchema: 'rig-review/act@1'}}},
  ];

  for (const bad of badReuseOnlyInputs) {
    await expect(startJobHost({...options, reuseOnly: bad as {expected: JobHostReuseExpectation}}))
      .rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
  }
  await expect(startJobHost({...options, port: -1, reuseOnly: {expected: validExpected}}))
    .rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
  await expect(startJobHost({...options, readerId: undefined, reuseOnly: {expected: validExpected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_OPTION_ID_INVALID', option: 'readPublished'});
  await expect(startJobHost({
    ...options,
    partsEnumerator: {version: '1.0.0', enumerate: () => []},
    reuseOnly: {expected: validExpected},
  })).rejects.toMatchObject({code: 'JOB_SOURCE_UNRETAINABLE'});
  await expect(startJobHost({...options, root: join(f.scratch, 'missing-root'), reuseOnly: {expected: validExpected}}))
    .rejects.toMatchObject({code: 'JOB_ROOT_REPLACED'});
  await expect(startJobHost({...options, stateDir: join(f.root, 'nested-state'), reuseOnly: {expected: validExpected}}))
    .rejects.toMatchObject({code: 'JOB_SOURCE_UNRETAINABLE'});

  expect(callbackCalls).toBe(0);
  expect(await Bun.file(missingState).exists()).toBe(false);
});

test('state and record refusals preserve read-only discipline across missing, closed, sidecar, replaced, and descriptor overflow cases', async () => {
  const f = await createFixture();
  const options = baseOptions(f);

  // 1. Missing stateDir refuses without creating stateDir.
  const absentState = join(f.scratch, 'absent-state');
  const dummyExpected: JobHostReuseExpectation = {
    jobId: 'job-missing-1',
    origin: 'http://127.0.0.1:41234',
    listenerIncarnation: '00000000-0000-4000-8000-000000000001',
    binding: {
      root: f.root,
      stateDir: absentState,
      fingerprint: options.fingerprint,
      reviewer: options.reviewer,
      readerId: 'reader/1',
      bindingId: 'writer/1',
      partsEnumeratorId: 'parts/1',
      partsEnumeratorVersion: f.partsEnumerator.version,
      apiSchema: JOB_API_SCHEMA,
      actSchema: JOB_ACT_SCHEMA,
    },
  };
  await expect(startJobHost({...options, stateDir: absentState, reuseOnly: {expected: dummyExpected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'missing', phase: 'state'});
  expect(await Bun.file(absentState).exists()).toBe(false);

  // 2. Empty existing stateDir (missing jobs.sqlite) refuses without creating jobs.sqlite.
  await mkdir(absentState, {mode: 0o700});
  await expect(startJobHost({...options, stateDir: absentState, reuseOnly: {expected: dummyExpected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'missing', phase: 'state'});
  expect(await Bun.file(join(absentState, 'jobs.sqlite')).exists()).toBe(false);

  // 3. Start real owner host, then test sidecar refusal (-wal, -shm, -journal).
  const owner = await startJobHost(options);
  hosts.push(owner);
  const expected = owner.attachment!;
  const sqlitePath = join(expected.binding.stateDir, 'jobs.sqlite');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = sqlitePath + suffix;
    await writeFile(sidecar, 'sidecar', {mode: 0o600});
    try {
      await expect(startJobHost({...options, reuseOnly: {expected}}))
        .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: 'state'});
    } finally {
      await unlink(sidecar);
    }
  }

  // 4. Record refusals: missing record, oversized record (>65536 bytes), dead PID, missing listenerIncarnation.
  const recordPath = join(expected.binding.stateDir, 'job-ui', `${expected.jobId}.json`);
  const originalRecord = await readFile(recordPath, 'utf8');
  await unlink(recordPath);
  await expect(startJobHost({...options, reuseOnly: {expected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'missing', phase: 'record'});

  await writeFile(recordPath, JSON.stringify({...JSON.parse(originalRecord), pad: 'a'.repeat(66_000)}), {mode: 0o600});
  await expect(startJobHost({...options, reuseOnly: {expected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: 'record'});

  await writeFile(recordPath, JSON.stringify({...JSON.parse(originalRecord), pid: 999_999}), {mode: 0o600});
  await expect(startJobHost({...options, reuseOnly: {expected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'record'});

  const withoutIncarnation = JSON.parse(originalRecord) as Record<string, unknown>;
  delete withoutIncarnation.listenerIncarnation;
  await writeFile(recordPath, JSON.stringify(withoutIncarnation), {mode: 0o600});
  await expect(startJobHost({...options, reuseOnly: {expected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'record'});
  const legacyOrdinary = await startJobHost(options);
  hosts.push(legacyOrdinary);
  expect(legacyOrdinary.reused).toBe(true);
  expect(legacyOrdinary.attachment).toBeNull();
  await writeFile(recordPath, originalRecord, {mode: 0o600});

  // 5. Closed job (without and with successor) refuses with reason: 'closed', phase: 'state'.
  const closeRes = await fetch(`${owner.origin}/jobs/${owner.session.jobId}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + owner.session.hostCredentials().agent,
    },
    body: JSON.stringify({
      schema: JOB_API_SCHEMA,
      jobId: owner.session.jobId,
      requestId: 'close-1',
      verb: 'close',
      expectedGeneration: owner.session.status().generation,
      idempotencyKey: 'close-key-1',
      reason: 'done',
    }),
  });
  expect(closeRes.status).toBe(200);
  await expect(startJobHost({...options, reuseOnly: {expected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'closed', phase: 'state'});

  owner.stop();
  const successor = await startJobHost(options);
  hosts.push(successor);
  expect(successor.session.jobId).not.toBe(expected.jobId);
  await expect(startJobHost({...options, reuseOnly: {expected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'closed', phase: 'state'});

  // 6. Descriptor 65,536-byte boundary overflow omits listenerIncarnation while preserving ordinary behavior.
  const overflowState = join(f.scratch, 'overflow-state');
  const baseOverhead = JSON.stringify({
    schema: 'rig-review-job-host/1',
    apiSchema: JOB_API_SCHEMA,
    actSchema: JOB_ACT_SCHEMA,
    partsEnumeratorId: 'parts/1',
    partsEnumeratorVersion: f.partsEnumerator.version,
    jobId: '00000000-0000-4000-8000-000000000000',
    origin: 'http://127.0.0.1:65535',
    fingerprint: '',
    pid: process.pid,
    readerId: 'reader/1',
    bindingId: 'writer/1',
  }).length;
  const nearLimitFingerprint = 'z'.repeat(65_536 - baseOverhead - 10);
  const overflowOptions: JobHostOptions = {
    ...options,
    stateDir: overflowState,
    fingerprint: nearLimitFingerprint,
  };
  const nearLimitHost = await startJobHost(overflowOptions);
  hosts.push(nearLimitHost);
  expect(nearLimitHost.reused).toBe(false);
  expect(nearLimitHost.attachment).toBeNull();
  const nearLimitReused = await startJobHost(overflowOptions);
  hosts.push(nearLimitReused);
  expect(nearLimitReused.reused).toBe(true);
  expect(nearLimitReused.attachment).toBeNull();
  await expect(startJobHost({
    ...overflowOptions,
    reuseOnly: {
      expected: {
        ...expected,
        jobId: nearLimitHost.session.jobId,
        origin: nearLimitHost.origin,
        binding: {
          ...expected.binding,
          stateDir: nearLimitHost.session.attestation().stateDir,
          fingerprint: nearLimitFingerprint,
        },
      },
    },
  })).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'record'});
});

test('one-field changes across options, expected, descriptor, and live owner report exact JOB_HOST_REUSE_MISMATCH', async () => {
  const f = await createFixture();
  const other = await createFixture();
  const options = baseOptions(f);
  const owner = await startJobHost(options);
  hosts.push(owner);
  const expected = owner.attachment!;
  const otherState = join(other.scratch, 'other-state');
  await mkdir(otherState, {mode: 0o700});
  const otherOwner = await startJobHost({...baseOptions(other), stateDir: otherState});
  hosts.push(otherOwner);
  const canonicalOtherState = otherOwner.attachment!.binding.stateDir;

  // 1. Options vs expected mismatches (covering root, stateDir, fingerprint, reviewer.id, reviewer.role, readerId, bindingId, partsEnumeratorId, partsEnumeratorVersion, port).
  const optionMutations: Array<{
    patch: Partial<JobHostOptions>;
    expectedPatch?: Partial<JobHostReuseExpectation['binding']>;
    field: JobHostAttachField;
    exp: string | null;
    act: string | null;
  }> = [
    {patch: {root: other.root}, field: 'root', exp: expected.binding.root, act: other.root},
    {patch: {stateDir: canonicalOtherState}, field: 'stateDir', exp: expected.binding.stateDir, act: canonicalOtherState},
    {patch: {fingerprint: 'changed-fp'}, field: 'fingerprint', exp: expected.binding.fingerprint, act: 'changed-fp'},
    {patch: {reviewer: {id: 'other-user', role: 'owner'}}, field: 'reviewer.id', exp: 'declared-owner', act: 'other-user'},
    {patch: {reviewer: {id: 'declared-owner', role: 'delegate'}}, field: 'reviewer.role', exp: 'owner', act: 'delegate'},
    {patch: {readerId: 'reader/2'}, field: 'readerId', exp: 'reader/1', act: 'reader/2'},
    {patch: {readPublished: undefined, readerId: undefined}, field: 'readerId', exp: 'reader/1', act: null},
    {patch: {bindingId: 'writer/2'}, field: 'bindingId', exp: 'writer/1', act: 'writer/2'},
    {patch: {partsEnumeratorId: 'parts/2'}, field: 'partsEnumeratorId', exp: 'parts/1', act: 'parts/2'},
    {
      patch: {partsEnumerator: {version: '2.26.0', enumerate: () => []}},
      field: 'partsEnumeratorVersion',
      exp: f.partsEnumerator.version,
      act: '2.26.0',
    },
    {
      patch: {port: 1},
      field: 'port',
      exp: new URL(expected.origin).port,
      act: '1',
    },
  ];
  for (const item of optionMutations) {
    await expect(startJobHost({...options, ...item.patch, reuseOnly: {expected}})).rejects.toMatchObject({
      code: 'JOB_HOST_REUSE_MISMATCH',
      field: item.field,
      expected: item.exp,
      actual: item.act,
    });
  }

  // 2. Expected jobId mismatch when active job exists for (root, fingerprint).
  await expect(startJobHost({
    ...options,
    reuseOnly: {expected: {...expected, jobId: 'wrong-job-id'}},
  })).rejects.toMatchObject({
    code: 'JOB_HOST_ATTACH_REFUSED', reason: 'missing', phase: 'state',
  });

  // 3. Descriptor one-field mismatches (including missing/null hook distinction and UUID case/version/variant/whitespace).
  const recordPath = join(expected.binding.stateDir, 'job-ui', `${expected.jobId}.json`);
  const originalRecordText = await readFile(recordPath, 'utf8');
  const originalRecord = JSON.parse(originalRecordText) as Record<string, unknown>;
  const descriptorCases: Array<{
    mutate: (rec: Record<string, unknown>) => void;
    field: JobHostAttachField;
    exp: string | null;
    act: string | null;
  }> = [
    {mutate: rec => { rec.jobId = 'desc-other-job'; }, field: 'jobId', exp: expected.jobId, act: 'desc-other-job'},
    {mutate: rec => { rec.origin = 'http://127.0.0.1:65001'; }, field: 'origin', exp: expected.origin, act: 'http://127.0.0.1:65001'},
    {
      mutate: rec => { rec.listenerIncarnation = '00000000-0000-4000-8000-000000000099'; },
      field: 'listenerIncarnation',
      exp: expected.listenerIncarnation,
      act: '00000000-0000-4000-8000-000000000099',
    },
    {
      mutate: rec => { rec.listenerIncarnation = expected.listenerIncarnation.toUpperCase(); },
      field: 'listenerIncarnation',
      exp: expected.listenerIncarnation,
      act: expected.listenerIncarnation.toUpperCase(),
    },
    {
      mutate: rec => { rec.listenerIncarnation = '00000000-0000-1000-8000-000000000099'; },
      field: 'listenerIncarnation',
      exp: expected.listenerIncarnation,
      act: '00000000-0000-1000-8000-000000000099',
    },
    {
      mutate: rec => { rec.listenerIncarnation = '00000000-0000-4000-0000-000000000099'; },
      field: 'listenerIncarnation',
      exp: expected.listenerIncarnation,
      act: '00000000-0000-4000-0000-000000000099',
    },
    {
      mutate: rec => { rec.listenerIncarnation = expected.listenerIncarnation + ' '; },
      field: 'listenerIncarnation',
      exp: expected.listenerIncarnation,
      act: expected.listenerIncarnation + ' ',
    },
    {mutate: rec => { rec.fingerprint = 'desc-fp'; }, field: 'fingerprint', exp: expected.binding.fingerprint, act: 'desc-fp'},
    {mutate: rec => { rec.readerId = null; }, field: 'readerId', exp: 'reader/1', act: null},
    {mutate: rec => { delete rec.readerId; }, field: 'readerId', exp: 'reader/1', act: null},
    {mutate: rec => { rec.bindingId = 'writer/desc'; }, field: 'bindingId', exp: 'writer/1', act: 'writer/desc'},
    {mutate: rec => { rec.partsEnumeratorId = 'parts/desc'; }, field: 'partsEnumeratorId', exp: 'parts/1', act: 'parts/desc'},
    {mutate: rec => { rec.partsEnumeratorVersion = '2.26.0'; }, field: 'partsEnumeratorVersion', exp: f.partsEnumerator.version, act: '2.26.0'},
    {mutate: rec => { rec.apiSchema = 'rig-review/job-api@1'; }, field: 'apiSchema', exp: JOB_API_SCHEMA, act: 'rig-review/job-api@1'},
    {mutate: rec => { rec.actSchema = 'rig-review/act@1'; }, field: 'actSchema', exp: JOB_ACT_SCHEMA, act: 'rig-review/act@1'},
  ];
  try {
    for (const item of descriptorCases) {
      const copy = {...originalRecord};
      item.mutate(copy);
      await writeFile(recordPath, JSON.stringify(copy), {mode: 0o600});
      const missing = !Object.hasOwn(copy, item.field);
      const malformedUUID = item.field === 'listenerIncarnation' &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(item.act));
      await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject(missing || malformedUUID
        ? {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: 'record'}
        : {code: 'JOB_HOST_REUSE_MISMATCH', field: item.field, expected: item.exp, actual: item.act});
    }
  } finally {
    await writeFile(recordPath, originalRecordText, {mode: 0o600});
  }

  // Missing vs null hook distinction when expected has readerId: null.
  const noHookOptions: JobHostOptions = {
    root: f.root,
    stateDir: join(f.scratch, 'no-hook-state'),
    fingerprint: 'no-hook-fp',
    reviewer: {id: 'declared-owner', role: 'owner'},
  };
  const noHookOwner = await startJobHost(noHookOptions);
  hosts.push(noHookOwner);
  const noHookExpected = noHookOwner.attachment!;
  const noHookRecordPath = join(noHookExpected.binding.stateDir, 'job-ui', `${noHookExpected.jobId}.json`);
  const noHookRecord = JSON.parse(await readFile(noHookRecordPath, 'utf8')) as Record<string, unknown>;
  delete noHookRecord.readerId;
  await writeFile(noHookRecordPath, JSON.stringify(noHookRecord), {mode: 0o600});
  await expect(startJobHost({...noHookOptions, reuseOnly: {expected: noHookExpected}})).rejects.toMatchObject({
    code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: 'record',
  });

  // 4. Live owner POST /jobs/<jobId>/host one-field mismatches.
  const liveMutations: Array<{
    mutate: (payload: Record<string, unknown>, binding: Record<string, unknown>) => void;
    field: JobHostAttachField;
    exp: string | null;
    act: string | null;
  }> = [
    {mutate: p => { p.jobId = 'live-other-job'; }, field: 'jobId', exp: expected.jobId, act: 'live-other-job'},
    {mutate: p => { p.origin = 'http://127.0.0.1:65002'; }, field: 'origin', exp: expected.origin, act: 'http://127.0.0.1:65002'},
    {
      mutate: p => { p.listenerIncarnation = '00000000-0000-4000-8000-000000000088'; },
      field: 'listenerIncarnation',
      exp: expected.listenerIncarnation,
      act: '00000000-0000-4000-8000-000000000088',
    },
    {mutate: (_p, b) => { b.root = '/tmp/live-other-root'; }, field: 'root', exp: expected.binding.root, act: '/tmp/live-other-root'},
    {mutate: (_p, b) => { b.stateDir = '/tmp/live-other-state'; }, field: 'stateDir', exp: expected.binding.stateDir, act: '/tmp/live-other-state'},
    {mutate: (_p, b) => { b.fingerprint = 'live-fp'; }, field: 'fingerprint', exp: expected.binding.fingerprint, act: 'live-fp'},
    {mutate: (_p, b) => { b.reviewer = {id: 'live-user', role: 'owner'}; }, field: 'reviewer.id', exp: 'declared-owner', act: 'live-user'},
    {mutate: (_p, b) => { b.reviewer = {id: 'declared-owner', role: 'delegate'}; }, field: 'reviewer.role', exp: 'owner', act: 'delegate'},
    {mutate: (_p, b) => { b.readerId = 'reader/live'; }, field: 'readerId', exp: 'reader/1', act: 'reader/live'},
    {mutate: (_p, b) => { delete b.readerId; }, field: 'readerId', exp: 'reader/1', act: null},
    {mutate: (_p, b) => { b.bindingId = null; }, field: 'bindingId', exp: 'writer/1', act: null},
    {mutate: (_p, b) => { b.partsEnumeratorId = 'parts/live'; }, field: 'partsEnumeratorId', exp: 'parts/1', act: 'parts/live'},
    {mutate: (_p, b) => { b.partsEnumeratorVersion = '2.26.0'; }, field: 'partsEnumeratorVersion', exp: f.partsEnumerator.version, act: '2.26.0'},
    {mutate: (_p, b) => { b.apiSchema = 'rig-review/job-api@1'; }, field: 'apiSchema', exp: JOB_API_SCHEMA, act: 'rig-review/job-api@1'},
    {mutate: (_p, b) => { b.actSchema = 'rig-review/act@1'; }, field: 'actSchema', exp: JOB_ACT_SCHEMA, act: 'rig-review/act@1'},
  ];
  for (const item of liveMutations) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await originalFetch(input, init);
      const body = JSON.parse(await res.text()) as {attachment: Record<string, unknown>};
      const attachment = body.attachment;
      const binding = {...(attachment.binding as Record<string, unknown>)};
      attachment.binding = binding;
      item.mutate(attachment, binding);
      return Response.json(body, {status: 200});
    }) as typeof fetch;
    await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({
      ...(item.act === null && item.field === 'readerId'
        ? {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: 'probe'}
        : {code: 'JOB_HOST_REUSE_MISMATCH', field: item.field, expected: item.exp, actual: item.act}),
    });
  }
  globalThis.fetch = originalFetch;
});

test('probe failures and POST /jobs/<jobId>/host security boundaries refuse cleanly', async () => {
  const f = await createFixture();
  const options = baseOptions(f);
  const owner = await startJobHost(options);
  hosts.push(owner);
  const expected = owner.attachment!;
  const uiCap = owner.session.hostCredentials().ui;
  const hostUrl = `${owner.origin}/jobs/${expected.jobId}/host`;

  // Direct POST /jobs/<jobId>/host boundary checks.
  expect((await fetch(hostUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Review-Capability': uiCap},
    body: JSON.stringify({expected, observed: observed(expected)}),
  })).status).toBe(403);
  expect((await fetch(hostUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': 'wrong'},
    body: JSON.stringify({expected, observed: observed(expected)}),
  })).status).toBe(403);
  expect((await fetch(hostUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': uiCap},
    body: JSON.stringify({schema: 'wrong', jobId: expected.jobId, listenerIncarnation: expected.listenerIncarnation}),
  })).status).toBe(400);
  expect((await fetch(hostUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': uiCap},
    body: 'x'.repeat(65_537),
  })).status).toBe(413);

  // Simulated probe responses (403, 500, redirect, oversized >65536 bytes, malformed JSON, wrong PID, GET-only listener).
  const badResponses: Array<[() => Response, 'probe' | 'read']> = [
    [() => new Response(null, {status: 403}), 'probe'],
    [() => new Response(null, {status: 405}), 'probe'],
    [() => new Response(null, {status: 500}), 'probe'],
    [() => new Response(null, {status: 302, headers: {Location: 'http://127.0.0.1:1/'}}), 'probe'],
    [() => new Response('{"pad":"' + 'a'.repeat(66_000) + '"}', {status: 200}), 'probe'],
    [() => new Response('not-json', {status: 200}), 'probe'],
    [() => Response.json({ok: true, attachment: expected, pid: process.pid + 1}), 'read'],
  ];
  for (const [makeResponse, reason] of badResponses) {
    globalThis.fetch = (async () => makeResponse()) as unknown as typeof fetch;
    await expect(startJobHost({...options, reuseOnly: {expected}}))
      .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason, phase: 'probe'});
  }
  globalThis.fetch = originalFetch;
});

test('stop and restart on same jobId, port, and PID rotates listenerIncarnation and refuses stale expected', async () => {
  const f = await createFixture();
  const options = baseOptions(f);
  const first = await startJobHost(options);
  hosts.push(first);
  const staleExpected = first.attachment!;
  first.stop();

  // Stopped host refuses strict attach.
  await expect(startJobHost({...options, reuseOnly: {expected: staleExpected}}))
    .rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'probe'});

  const restarted = await startJobHost(options);
  hosts.push(restarted);
  expect(restarted.reused).toBe(false);
  expect(restarted.session.jobId).toBe(staleExpected.jobId);
  expect(restarted.origin).toBe(staleExpected.origin);
  expect(restarted.attachment).not.toBeNull();
  expect(restarted.attachment!.listenerIncarnation).not.toBe(staleExpected.listenerIncarnation);

  // Stale listenerIncarnation is rejected with JOB_HOST_REUSE_MISMATCH.
  await expect(startJobHost({...options, reuseOnly: {expected: staleExpected}})).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH',
    field: 'listenerIncarnation',
    expected: staleExpected.listenerIncarnation,
    actual: restarted.attachment!.listenerIncarnation,
  });

  // Fresh listenerIncarnation attaches cleanly.
  const attached = await startJobHost({...options, reuseOnly: {expected: restarted.attachment!}});
  hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.attachment).toEqual(restarted.attachment);
});

test('accepted validation precedes later close and stop; no post-probe adoption occurs', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    // Fully receive success before committing the later lifecycle event.
    const payload = await response.json();
    const independent = new JobSession(options);
    try {
      const ports = (await import('../src/job-api.ts')).createJobHostPorts(independent, owner.origin);
      const later = {...owner, session: independent, ports};
      expect(await semantic(later, 'close', {expectedGeneration: 0, idempotencyKey: 'after-accept', reason: 'later'}))
        .toMatchObject({ok: true});
    } finally {independent.dispose();}
    owner.stop();
    return Response.json(payload);
  }) as typeof fetch;
  const attached = await startJobHost({...options, reuseOnly: {expected}}); hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.session.status().status).toBe('closed');
});

// CP1 independent repair controls. Their original RED input is frozen separately.
function observed(expected: JobHostReuseExpectation) {
  const paths = {root: expected.binding.root, stateDir: expected.binding.stateDir,
    store: join(expected.binding.stateDir, 'jobs.sqlite'),
    record: join(expected.binding.stateDir, 'job-ui', expected.jobId + '.json')};
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => {
    const {dev, ino} = lstatSync(path); return [key, {dev, ino}];
  }));
}
function probeRequest(owner: JobOwnerHost, body: unknown, signal?: AbortSignal) {
  return new Request(owner.origin + `/jobs/${owner.session.jobId}/host`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: new URL(owner.origin).origin,
      'X-Review-Capability': owner.session.hostCredentials().ui},
    body: JSON.stringify(body), signal});
}
async function semantic(host: JobOwnerHost, verb: string, fields: Record<string, unknown> = {}, agentCapability = host.session.hostCredentials().agent) {
  const response = await host.ports.handleJobApi(new Request(host.origin + `/jobs/${host.session.jobId}/api`, {
    method: 'POST', headers: {'Content-Type': 'application/json',
      Authorization: 'Bearer ' + agentCapability},
    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: host.session.jobId,
      requestId: verb + '-repair', verb, ...fields})}));
  return await response.json() as any;
}

test('CP1 item 1: strict local semantic close lazily adopts writable existing store', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}}); hosts.push(attached);
  const closed = await semantic(attached, 'close', {expectedGeneration: 0, idempotencyKey: 'lazy-close', reason: 'done'});
  expect(closed).toMatchObject({ok: true, value: {status: 'closed'}});
  expect(owner.session.status().status).toBe('closed');
});

test('CP1 item 2: private POST exact expected and observed shape attests full binding', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!;
  const res = await originalFetch(probeRequest(owner, {expected, observed: observed(expected)}));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ok: true, attachment: expected, pid: process.pid});
});

test('CP1 item 3: stop wins after a paused body parse', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!;
  const context = createJobRequestContext(owner.session, options, owner.origin, jobHostIdentity(options),
    undefined, undefined, expected.listenerIncarnation);
  (context as typeof context & {publish?: () => void}).publish?.();
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(r => entered = r), barrier = new Promise<void>(r => release = r);
  const body = new ReadableStream<Uint8Array>({async pull(c) {
    entered(); await barrier; c.enqueue(Buffer.from(JSON.stringify({expected, observed: observed(expected)}))); c.close();
  }});
  const req = probeRequest(owner, {});
  const pending = context.fetch(new Request(req, {body}));
  await paused; context.stop(); release();
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ok: false, error: {
    code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'acceptance'}});
});

test('CP1 item 4: exact readonly session is staged before the final network probe', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const original = JobSession.openReadOnly;
  let adopted = 0;
  JobSession.openReadOnly = (...args) => {adopted++; return original(...args);};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(adopted).toBe(1); return originalFetch(input, init);
  }) as typeof fetch;
  try {const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}}); hosts.push(attached);}
  finally {JobSession.openReadOnly = original;}
});

test('CP1 item 5: hub exposes canonical shared listener incarnation', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const hub = await startJobHub({stateDir: options.stateDir, reviewer: options.reviewer});
  let originalBinding: JobHostReuseExpectation;
  try {
    const first = await hub.openJob(options);
    const value = (first as typeof first & {attachment?: JobHostReuseExpectation}).attachment;
    expect(value).toBeDefined();
    originalBinding = value!;
    expect(value!.listenerIncarnation).toMatch(/^[0-9a-f-]{36}$/);
    const secondRoot = join(f.scratch, 'second-root'); await mkdir(secondRoot);
    const second = await hub.openJob({...options, root: secondRoot});
    expect((second as typeof second & {attachment?: JobHostReuseExpectation}).attachment!.listenerIncarnation)
      .toBe(value!.listenerIncarnation);
  } finally {await hub.stop();}
  const restarted = await startJobHub({stateDir: options.stateDir, reviewer: options.reviewer, port: Number(new URL(hub.origin).port)});
  try {
    const job = await restarted.openJob(options);
    expect(job.attachment.jobId).toBe(originalBinding!.jobId);
    expect(job.attachment.origin).toBe(originalBinding!.origin);
    expect(job.attachment.listenerIncarnation).not.toBe(originalBinding!.listenerIncarnation);
  } finally {await restarted.stop();}
});

test('CP1 item 6: missing incarnation has the named record refusal', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, path = join(expected.binding.stateDir, 'job-ui', expected.jobId + '.json');
  const descriptor = JSON.parse(await readFile(path, 'utf8')); delete descriptor.listenerIncarnation;
  await writeFile(path, JSON.stringify(descriptor));
  await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({
    code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'record'});
});

test('CP1 item 7: explicit port 80 is valid input and retains literal spelling', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = {...owner.attachment!, origin: 'http://127.0.0.1:80'};
  await expect(startJobHost({...options, port: 80, reuseOnly: {expected}})).rejects.toMatchObject({
    code: 'JOB_HOST_REUSE_MISMATCH', field: 'origin', expected: expected.origin, actual: owner.origin});
});

test('CP1 item 8: exact data objects reject accessors without invoking them', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = cloneExpected(owner.attachment!);
  let reads = 0;
  Object.defineProperty(expected.binding.reviewer, 'id', {enumerable: true, get() {reads++; return 'declared-owner';}});
  let attached: JobOwnerHost | undefined, failure: unknown;
  try {attached = await startJobHost({...options, reuseOnly: {expected}});} catch (error) {failure = error;}
  if (attached) hosts.push(attached);
  expect(reads).toBe(0);
  expect(failure).toMatchObject({code: 'JOB_REQUEST_INVALID'});
});

async function stateImage(path: string): Promise<Record<string, unknown>> {
  const image: Record<string, unknown> = {};
  async function visit(path: string, label: string) {
    const info = lstatSync(path);
    image[label] = {dev: info.dev, ino: info.ino, mode: info.mode, mtime: info.mtimeMs,
      ...(info.isFile() ? {bytes: (await readFile(path)).toString('base64')} : {})};
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), label + '/' + name);
  }
  await visit(path, '.'); return image;
}

test('CP1 simultaneous attaches have empty bootstrap writes, zero hooks and independent disposal', async () => {
  const f = await createFixture();
  const calls = {install: 0, reader: 0, enumerate: 0, snapshot: 0, allocate: 0};
  const options: JobHostOptions = {...baseOptions(f),
    installWriterBinding: () => {calls.install++;}, readPublished: async () => {calls.reader++; return f.getContext();},
    partsEnumerator: {version: f.partsEnumerator.version, enumerate: () => {calls.enumerate++; return [];}},
    afterSnapshot: () => {calls.snapshot++;}};
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, before = await stateImage(options.stateDir), grant = owner.session.writerGrant();
  const open = JobStore.prototype.open;
  JobStore.prototype.open = function(...args) {calls.allocate++; return open.apply(this, args);};
  let attached: JobOwnerHost[];
  try {attached = await Promise.all([startJobHost({...options, reuseOnly: {expected}}), startJobHost({...options, reuseOnly: {expected}})]);}
  finally {JobStore.prototype.open = open;}
  hosts.push(...attached);
  console.error(JSON.stringify({proof: 'strict-bootstrap-counters', calls}));
  expect(calls).toEqual({install: 1, reader: 0, enumerate: 0, snapshot: 0, allocate: 0});
  expect(await stateImage(options.stateDir)).toEqual(before);
  attached[0]!.stop();
  expect(attached[1]!.session.writerGrant()).toEqual(grant);
  expect(await attached[1]!.ports.jobLiveness(expected.jobId)).toMatchObject({ok: true, value: {active: true}});
  attached[1]!.stop();
  expect(await stateImage(options.stateDir)).toEqual(before);
  expect(owner.session.status().status).toBe('active');
});

test('CP1 staged adoption rechecks all four filesystem identities before sending credentials', async () => {
  for (const target of ['root', 'stateDir', 'store', 'record'] as const) {
    const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
    const expected = owner.attachment!, paths = {root: expected.binding.root, stateDir: expected.binding.stateDir,
      store: join(expected.binding.stateDir, 'jobs.sqlite'), record: join(expected.binding.stateDir, 'job-ui', expected.jobId + '.json')};
    const path = paths[target], backup = path + '.saved';
    const original = JobSession.openReadOnly;
    let probes = 0, moved = false;
    JobSession.openReadOnly = (...args) => {
      const staged = original(...args);
      renameSync(path, backup); moved = true;
      if (target === 'root' || target === 'stateDir') mkdirSync(path, {mode: 0o700});
      else writeFileSync(path, readFileSync(backup), {mode: 0o600});
      return staged;
    };
    globalThis.fetch = (async () => {probes++; throw new Error('must not send');}) as unknown as typeof fetch;
    try {
      await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({
        code: 'JOB_HOST_ATTACH_REFUSED', reason: 'race', phase: 'adoption'});
      expect(probes).toBe(0);
    } finally {
      JobSession.openReadOnly = original; globalThis.fetch = originalFetch;
      if (moved) {await rm(path, {recursive: true, force: true}); await rename(backup, path);}
    }
  }
});

test('CP1 owner compares every observed identity, full binding and exact POST keys', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, initial = await stateImage(options.stateDir);
  for (const key of ['root', 'stateDir', 'store', 'record']) {
    const files = observed(expected); (files[key] as {ino: number}).ino++;
    const response = await originalFetch(probeRequest(owner, {expected, observed: files}));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ok: false, error: {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'replaced', phase: 'acceptance'}});
  }
  const wrong = cloneExpected(expected); (wrong.binding as {fingerprint: string}).fingerprint = 'different';
  const mismatch = await originalFetch(probeRequest(owner, {expected: wrong, observed: observed(expected)}));
  expect(await mismatch.json()).toEqual({ok: false, error: {code: 'JOB_HOST_REUSE_MISMATCH', field: 'fingerprint', expected: 'different', actual: expected.binding.fingerprint}});
  for (const body of [
    {expected, observed: observed(expected), extra: true},
    {expected}, {schema: 'rig-review-job-host-attach/1', jobId: expected.jobId, listenerIncarnation: expected.listenerIncarnation},
    {expected, observed: {...observed(expected), extra: {dev: 0, ino: 0}}},
    ...[-1, 0.1, Number.MAX_SAFE_INTEGER + 1, null, '1'].map(dev => ({expected, observed: {...observed(expected), root: {dev, ino: 1}}})),
  ]) {
    const res = await originalFetch(probeRequest(owner, body)); expect(res.status).toBe(400); await res.body?.cancel();
  }
  expect(await stateImage(options.stateDir)).toEqual(initial);
});

test('CP1 owner detects actual root state store and descriptor replacement at acceptance', async () => {
  for (const target of ['root', 'stateDir', 'store', 'record'] as const) {
    const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
    const expected = owner.attachment!;
    const context = createJobRequestContext(owner.session, options, owner.origin, jobHostIdentity(options), undefined, undefined, expected.listenerIncarnation);
    context.publish();
    const originalFiles = observed(expected), paths = {root: expected.binding.root, stateDir: expected.binding.stateDir,
      store: join(expected.binding.stateDir, 'jobs.sqlite'), record: join(expected.binding.stateDir, 'job-ui', expected.jobId + '.json')};
    const path = paths[target], backup = path + '.original';
    const request = probeRequest(owner, {expected, observed: originalFiles});
    await rename(path, backup);
    try {
      if (target === 'root') await mkdir(path);
      else if (target === 'stateDir') await cp(backup, path, {recursive: true});
      else await writeFile(path, await readFile(backup), {mode: 0o600});
      const before = await stateImage(path);
      const res = await context.fetch(request);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({error: {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'replaced', phase: 'acceptance'}});
      expect(await stateImage(path)).toEqual(before);
    } finally {context.stop(); await rm(path, {recursive: true, force: true}); await rename(backup, path);}
  }
});

test('CP1 lazy write adopts only the same existing file and same exact job identity', async () => {
  for (const target of ['missing-store', 'replaced-store', 'replaced-state', 'changed-row', 'replaced-root']) {
    const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
    const expected = owner.attachment!, attached = await startJobHost({...options, reuseOnly: {expected}}); hosts.push(attached);
    const path = target === 'replaced-state' ? expected.binding.stateDir : target === 'replaced-root' ? expected.binding.root : join(expected.binding.stateDir, 'jobs.sqlite');
    const backup = path + '.lazy-original', token = attached.session.hostCredentials().agent;
    if (target === 'changed-row') {
      const db = new Database(path);
      try {db.query("UPDATE jobs SET document=json_set(document,'$.uiCapability',?) WHERE job_id=?").run('0'.repeat(64), expected.jobId);} finally {db.close();}
    } else {
      await rename(path, backup);
      if (target === 'replaced-state') await cp(backup, path, {recursive: true});
      else if (target === 'replaced-root') await mkdir(path);
      else if (target === 'replaced-store') await writeFile(path, await readFile(backup), {mode: 0o600});
    }
    try {
      const before = target === 'missing-store' ? null : await stateImage(path);
      const result = await semantic(attached, 'close', {expectedGeneration: 0, idempotencyKey: 'reject-lazy', reason: 'cannot adopt'}, token);
      expect(result.ok).toBe(false);
      expect(['JOB_STORAGE_FAILED', 'JOB_ROOT_REPLACED']).toContain(result.error.code);
      if (before) expect(await stateImage(path)).toEqual(before);
      else expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      attached.stop();
      if (target !== 'changed-row') {await rm(path, {recursive: true, force: true}); await rename(backup, path);}
    }
  }
});

test('CP1 later semantic publish ask next UI finalization writer fetch and close preserve CAS and revocation', async () => {
  const f = await createFixture(); let installs = 0, reads = 0;
  const options = {...baseOptions(f), installWriterBinding: () => {installs++;},
    readPublished: async () => {reads++; return f.getContext();}};
  const owner = await startJobHost(options); hosts.push(owner);
  const before = await stateImage(options.stateDir), credentials = owner.session.hostCredentials(), grant = owner.session.writerGrant();
  const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}}); hosts.push(attached);
  expect(await stateImage(options.stateDir)).toEqual(before); expect(installs).toBe(1); expect(reads).toBe(0);
  expect(attached.session.hostCredentials()).toEqual(credentials); expect(attached.session.writerGrant()).toEqual(grant);
  const input = await f.publishRequest(); if (input.verb !== 'publish') throw new Error('fixture');
  const fields = {expectedGeneration: 0, idempotencyKey: 'attached-publish', result: input.result, freeze: input.freeze};
  const published = await semantic(attached, 'publish', fields);
  expect(published.ok).toBe(true); expect(reads).toBe(1);
  expect((await semantic(attached, 'publish', fields)).value).toEqual(published.value); expect(reads).toBe(1);
  const stale = await semantic(attached, 'ask', {expectedGeneration: 0, idempotencyKey: 'stale', publicationId: published.value.publicationId,
    subject: {kind: 'checkpoint', checkpointId: 'step-one'}});
  expect(stale).toMatchObject({ok: false, error: {code: 'JOB_GENERATION_STALE'}});
  const ask = await semantic(attached, 'ask', {expectedGeneration: 1, idempotencyKey: 'attached-ask', publicationId: published.value.publicationId,
    subject: {kind: 'checkpoint', checkpointId: 'step-one'}}); expect(ask.ok).toBe(true);
  expect(await semantic(attached, 'next', {after: null, waitMs: 0})).toMatchObject({ok: true, value: {status: 'events'}});
  const uiHeaders = {'Content-Type': 'application/json', Origin: attached.origin, 'X-Review-Capability': credentials.ui};
  const display = await attached.ports.ackDisplayed(attached.session.jobId, new Request(attached.origin + `/jobs/${attached.session.jobId}/ui/displayed`, {
    method: 'POST', headers: uiHeaders, body: JSON.stringify({publicationId: published.value.publicationId, pageId: 'attached-page', sourceHash: published.value.source.sourceHash})}));
  expect(display.ok).toBe(true); if (!display.ok) throw new Error('display');
  const act = await attached.ports.commitUIAct(attached.session.jobId, new Request(attached.origin + `/jobs/${attached.session.jobId}/ui/acts`, {
    method: 'POST', headers: uiHeaders, body: JSON.stringify({...display.value, askId: ask.value.askId,
      expectedGeneration: attached.session.status().generation, submissionId: 'attached-act', kind: 'checkpoint', value: {checkpointId: 'step-one', outcome: 'pass', words: ' exact '}})}));
  expect(act.ok).toBe(true); if (!act.ok) throw new Error('act');
  const fetchAct = async (capability: string) => {
    const res = await attached.ports.handleJobApi(new Request(attached.origin + `/jobs/${attached.session.jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability},
      body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: attached.session.jobId, requestId: 'writer-read', verb: 'fetch-act', actId: act.value.actId})}));
    return await res.json();
  };
  expect(await fetchAct(grant.fetchCapability)).toMatchObject({ok: true, value: act.value});
  expect(await fetchAct(credentials.agent)).toMatchObject({ok: false, error: {code: 'JOB_CAPABILITY_REQUIRED'}});
  expect(await semantic(attached, 'close', {expectedGeneration: attached.session.status().generation, idempotencyKey: 'attached-close', reason: 'done'})).toMatchObject({ok: true});
  expect(await fetchAct(grant.fetchCapability)).toMatchObject({ok: false, error: {code: 'JOB_CLOSED'}});
});

test('CP1 synchronous deferred owner snapshot orders against independent process close commits', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, original = owner.session.attestation.bind(owner.session);
  let lockProofs = 0;
  owner.session.attestation = () => {
    const live = original();
    const argv = [process.execPath, '-e', `import {Database} from 'bun:sqlite';
      const db=new Database(${JSON.stringify(join(expected.binding.stateDir, 'jobs.sqlite'))});
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      db.query('UPDATE jobs SET active=0 WHERE job_id=?').run(${JSON.stringify(expected.jobId)});
      let blocked=false;try{db.exec('COMMIT')}catch(e){blocked=e.code==='SQLITE_BUSY';db.exec('ROLLBACK')}
      db.close();if(!blocked)process.exit(7);console.log('close-commit-blocked-by-accepted-read');`];
    const child = Bun.spawnSync(argv);
    console.error(JSON.stringify({proof: 'accepted-read-vs-close', argv, exit: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString()}));
    expect(child.exitCode).toBe(0); expect(child.stdout.toString().trim()).toBe('close-commit-blocked-by-accepted-read'); lockProofs++;
    return live;
  };
  const attached = await startJobHost({...options, reuseOnly: {expected}}); hosts.push(attached);
  owner.session.attestation = original;
  expect(lockProofs).toBe(1); expect(attached.session.status().status).toBe('active');
  const code = `import {JobSession} from ${JSON.stringify(new URL('../src/job-session.ts', import.meta.url).pathname)};
    const s=JobSession.openReadOnly(${JSON.stringify({...options, readPublished: undefined, installWriterBinding: undefined, partsEnumerator: undefined})},${JSON.stringify(expected.jobId)});
    try{await s.execute({schema:${JSON.stringify(JOB_API_SCHEMA)},jobId:s.jobId,requestId:'external-close',verb:'close',expectedGeneration:0,idempotencyKey:'external-close',reason:'prior'},new AbortController().signal);console.log('close-committed')}finally{s.dispose()}`;
  const argv = [process.execPath, '-e', code], child = Bun.spawnSync(argv);
  console.error(JSON.stringify({proof: 'independent-close', argv, exit: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString()}));
  expect(child.exitCode).toBe(0); expect(child.stdout.toString().trim()).toBe('close-committed');
  await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'closed', phase: 'state'});
});

test('CP1 cross-process managed starter shares exact tuple with concurrent attachers and rotates on replacement', async () => {
  const f = await createFixture();
  const options: JobHostOptions = {root: f.root, stateDir: join(f.scratch, 'foreign-state'), fingerprint: 'foreign', reviewer: {id: 'owner', role: 'owner'}};
  const module = new URL('../src/job-host.ts', import.meta.url).pathname;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  async function starter() {
    const argv = [process.execPath, '-e', `import {startJobHost} from ${JSON.stringify(module)};
      const host=await startJobHost(${JSON.stringify(options)});
      console.log(JSON.stringify({attachment:host.attachment,pid:process.pid}));
      for await(const _ of Bun.stdin.stream()){host.stop();break;}`];
    const child = Bun.spawn(argv, {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    children.push(child);
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('\n')) {const next = await reader.read(); if (next.done) throw new Error('starter closed'); text += new TextDecoder().decode(next.value);}
    reader.releaseLock();
    console.error(JSON.stringify({proof: 'foreign-starter-ready', argv, stdout: text}));
    return {child, ready: JSON.parse(text) as {attachment: JobHostReuseExpectation; pid: number}};
  }
  async function stop(child: ReturnType<typeof Bun.spawn>) {
    (child.stdin as import('bun').FileSink).write('stop\n'); (child.stdin as import('bun').FileSink).end();
    expect(await child.exited).toBe(0);
  }
  try {
    const first = await starter(), expected = first.ready.attachment;
    expect(first.ready.pid).not.toBe(process.pid);
    const before = await stateImage(options.stateDir);
    const [a, b] = await Promise.all([startJobHost({...options, reuseOnly: {expected}}), startJobHost({...options, reuseOnly: {expected}})]); hosts.push(a, b);
    expect(a.attachment).toEqual(expected); expect(b.attachment).toEqual(expected);
    a.stop(); expect(b.session.status().status).toBe('active'); b.stop();
    expect(await stateImage(options.stateDir)).toEqual(before);
    await stop(first.child);
    const second = await starter();
    expect(second.ready.attachment.jobId).toBe(expected.jobId);
    expect(second.ready.attachment.listenerIncarnation).not.toBe(expected.listenerIncarnation);
    await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({
      code: 'JOB_HOST_REUSE_MISMATCH', field: 'listenerIncarnation', expected: expected.listenerIncarnation,
      actual: second.ready.attachment.listenerIncarnation});
    const fresh = await startJobHost({...options, reuseOnly: {expected: second.ready.attachment}}); hosts.push(fresh); fresh.stop();
    await stop(second.child);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill(); await child.exited;
      const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
      console.error(JSON.stringify({proof: 'foreign-starter-exit', pid: child.pid, exit: child.exitCode, stderr}));
    }
  }
});

test('CP1 real hub closing flag wins while incoming HTTP body parser is paused', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const hub = await startJobHub({stateDir: options.stateDir, reviewer: options.reviewer});
  const originalReader = ReadableStream.prototype.getReader;
  let resume!: () => void, parsing!: () => void;
  const entered = new Promise<void>(r => parsing = r), barrier = new Promise<void>(r => resume = r);
  let pending: Promise<Response> | undefined;
  try {
    const job = await hub.openJob(options), expected = job.attachment;
    const bytes = Buffer.from(JSON.stringify({expected, observed: observed(expected)}));
    const hostPath = `/jobs/${job.session.jobId}/host`;
    const stream = new ReadableStream<Uint8Array>({start(c) {c.enqueue(bytes.subarray(0, 12));}, async pull(c) {
      await barrier; c.enqueue(bytes.subarray(12)); c.close();
    }});
    ReadableStream.prototype.getReader = function(this: ReadableStream, ...args: any[]) {
      const reader = Reflect.apply(originalReader, this, args);
      if (this !== stream) parsing();
      return reader;
    } as typeof originalReader;
    pending = originalFetch(hub.origin + hostPath, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: hub.origin,
      'X-Review-Capability': job.session.hostCredentials().ui}, body: stream});
    await entered;
    const stopping = hub.stop(); resume();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ok: false, error: {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'acceptance'}});
    await stopping;
  } finally {ReadableStream.prototype.getReader = originalReader; resume?.(); await pending?.catch(() => {}); await hub.stop();}
});

test('CP1 cancelled and stalled request or response bodies are bounded and released', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, before = await stateImage(options.stateDir);
  let cancelled = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({start(c) {c.enqueue(Buffer.from('{'));}, cancel() {cancelled++;}}))) as unknown as typeof fetch;
  await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'probe'});
  expect(cancelled).toBe(1);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('headers timeout')), {once: true});
  })) as typeof fetch;
  await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'probe'});
  globalThis.fetch = originalFetch;
  const context = createJobRequestContext(owner.session, options, owner.origin, jobHostIdentity(options), undefined, undefined, expected.listenerIncarnation); context.publish();
  const abort = new AbortController(); let bodyCancelled = false;
  const stalled = new ReadableStream<Uint8Array>({start(c) {c.enqueue(Buffer.from('{'));}, cancel() {bodyCancelled = true;}});
  const pending = context.fetch(new Request(probeRequest(owner, {}), {body: stalled, signal: abort.signal}));
  abort.abort(); const response = await pending; expect(response.status).toBe(400); await response.body?.cancel();
  expect(bodyCancelled).toBe(true); expect(stalled.locked).toBe(false);
  expect(context.busy).toBe(false); context.stop();
  expect(await stateImage(options.stateDir)).toEqual(before);
}, 10_000);

test('CP1 input snapshot rejects hidden keys and preserves data and callback references across first await', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const original = owner.attachment!;
  for (const location of ['wrapper', 'expectation', 'binding', 'reviewer', 'options']) {
    const expected = cloneExpected(original), wrapper = {expected}, input = {...options, reuseOnly: wrapper};
    const targets = {wrapper, expectation: expected, binding: expected.binding, reviewer: expected.binding.reviewer, options: input};
    Object.defineProperty(targets[location as keyof typeof targets], 'hidden', {value: 1, enumerable: false});
    await expect(startJobHost(input)).rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
  }
  const expected = cloneExpected(original), input = {...options, reviewer: {...options.reviewer}, partsEnumerator: {...options.partsEnumerator!}, reuseOnly: {expected}};
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(JSON.parse(init!.body as string).expected).toEqual(original);
    input.root = 'changed'; input.stateDir = 'changed'; input.fingerprint = 'changed'; input.reviewer.id = 'changed';
    input.partsEnumerator.version = '2.26.0';
    (expected.binding as {fingerprint: string}).fingerprint = 'changed';
    return originalFetch(url, init);
  }) as typeof fetch;
  const attached = await startJobHost(input); hosts.push(attached);
  expect(attached.attachment).toEqual(original);
  expect(Object.isFrozen(attached.attachment!.binding.reviewer)).toBe(true);
});

test('CP1 structured server refusals survive client validation and missing live incarnation is named', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!;
  for (const [status, error] of [
    [503, {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'acceptance'}],
    [409, {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'closed', phase: 'acceptance'}],
    [409, {code: 'JOB_HOST_REUSE_MISMATCH', field: 'reviewer.id', expected: 'e', actual: 'a'}],
  ] as const) {
    globalThis.fetch = (async () => Response.json({ok: false, error}, {status})) as unknown as typeof fetch;
    await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject(error);
  }
  const attachment: Record<string, unknown> = {...expected}; delete attachment.listenerIncarnation;
  globalThis.fetch = (async () => Response.json({ok: true, attachment, pid: process.pid})) as unknown as typeof fetch;
  await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'probe'});
  for (const bad of [
    {ok: false, error: {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'commit'}},
    {ok: false, error: {code: 'JOB_HOST_REUSE_MISMATCH', field: 'invented', expected: '', actual: ''}},
    {ok: false, error: {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'stopped', phase: 'acceptance', extra: true}},
  ]) {
    globalThis.fetch = (async () => Response.json(bad, {status: 409})) as unknown as typeof fetch;
    await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'probe'});
  }
});


test('HQ first-read reachability requires successful storage read before a session can expose API ports', async () => {
  const f = await createFixture(), options = baseOptions(f);
  const owner = await startJobHost(options); hosts.push(owner);
  const originalOpen = JobStore.prototype.open, originalGet = JobStore.prototype.get;
  const refusal = new JobError('JOB_STORAGE_FAILED', 'planted before first successful read');
  let published = 0;
  try {
    JobStore.prototype.open = () => {throw refusal;};
    JobStore.prototype.get = () => {throw refusal;};
    for (const mode of ['ordinary', 'readonly']) {
      let session: JobSession | undefined, caught: unknown;
      try {
        session = mode === 'ordinary' ? new JobSession(options) : JobSession.openReadOnly(options, owner.session.jobId);
        published++;
      } catch (error) {caught = error;}
      expect(caught).toBe(refusal);
      expect(session).toBeUndefined();
    }
    expect(published).toBe(0);
  } finally {JobStore.prototype.open = originalOpen; JobStore.prototype.get = originalGet;}
  const generations: number[] = [];
  JobStore.prototype.get = function(...args) {
    const row = originalGet.apply(this, args);
    generations.push(row.closure?.generation ?? (row.data as {generation: number}).generation);
    return row;
  };
  let session: JobSession | undefined;
  try {
    session = JobSession.openReadOnly(options, owner.session.jobId);
    expect(generations.length).toBeGreaterThan(0);
    expect(generations.every(Number.isSafeInteger)).toBe(true);
    const {createJobHostPorts} = await import('../src/job-api.ts');
    const ports = createJobHostPorts(session, owner.origin);
    const response = await ports.handleJobApi(new Request(owner.origin + `/jobs/${session.jobId}/api`, {method: 'POST'}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({generation: generations[0], ok: false, error: {code: 'JOB_REQUEST_INVALID'}});
  } finally {JobStore.prototype.get = originalGet; session?.dispose();}
});

test('HQ failure catch keeps original refusal and last observed generation without storage reread', async () => {
  for (const mode of ['renamed', 'deleted']) {
    const f = await createFixture(), options = baseOptions(f);
    const owner = await startJobHost(options); hosts.push(owner);
    const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}}); hosts.push(attached);
    const published = await f.publishRequest(); if (published.verb !== 'publish') throw new Error('fixture');
    expect(await semantic(attached, 'publish', {expectedGeneration: 0, idempotencyKey: 'hq-generation', result: published.result, freeze: published.freeze})).toMatchObject({ok: true});
    const known = attached.session.status().generation;
    expect(known).toBeGreaterThan(0);
    const token = attached.session.hostCredentials().agent;
    const file = join(options.stateDir, 'jobs.sqlite'), backup = file + '.hq-saved', bytes = await readFile(file);
    const authorize = attached.session.authorize.bind(attached.session), status = attached.session.status.bind(attached.session);
    const originalGet = JobStore.prototype.get;
    let catchReads = 0, getReads = 0, missing = false;
    JobStore.prototype.get = function(...args) {if (missing) getReads++; return originalGet.apply(this, args);};
    attached.session.authorize = (role, given) => {
      authorize(role, given);
      if (mode === 'renamed') renameSync(file, backup); else require('node:fs').unlinkSync(file);
      missing = true;
      throw new JobError('JOB_SOURCE_MISMATCH', 'original named refusal');
    };
    attached.session.status = () => {catchReads++; return status();};
    try {
      const result = await semantic(attached, 'next', {after: null, waitMs: 0}, token);
      expect(result).toMatchObject({generation: known, ok: false, error: {code: 'JOB_SOURCE_MISMATCH', message: 'original named refusal'}});
      expect(catchReads).toBe(0); expect(getReads).toBe(0);
    } finally {
      JobStore.prototype.get = originalGet;
      attached.session.authorize = authorize; attached.session.status = status;
      if (missing) {if (mode === 'renamed') await rename(backup, file); else await writeFile(file, bytes, {mode: 0o600});}
    }
  }
});

test('CP1 GET raw projection and exact 65536-byte descriptor budget preserve ordinary behavior', async () => {
  const f = await createFixture(), options = baseOptions(f), first = await startJobHost(options); hosts.push(first);
  const initial = first.attachment!, recordPath = join(options.stateDir, 'job-ui', initial.jobId + '.json');
  const descriptor = JSON.parse(await readFile(recordPath, 'utf8'));
  const {listenerIncarnation: _token, ...legacy} = descriptor;
  const get = () => originalFetch(first.origin + `/jobs/${first.session.jobId}/host`, {headers: {'X-Review-Capability': first.session.hostCredentials().ui}});
  expect(await (await get()).text()).toBe(JSON.stringify(legacy));
  const legacyBytes = JSON.stringify(legacy).padEnd(65536, ' ');
  await writeFile(recordPath, legacyBytes);
  const reused = await startJobHost(options); hosts.push(reused);
  expect(reused.reused).toBe(true); expect(reused.attachment).toBeNull();
  expect(await readFile(recordPath, 'utf8')).toBe(legacyBytes);
  await writeFile(recordPath, legacyBytes + ' ');
  await expect(startJobHost(options)).rejects.toThrow('bounded regular file required');
  await writeFile(recordPath, JSON.stringify(descriptor));
  first.stop();
  const overhead = Buffer.byteLength(JSON.stringify({...descriptor, fingerprint: ''}));
  for (const extra of [0, 1]) {
    const long = {...options, fingerprint: 'x'.repeat(65536 - overhead + extra), port: Number(new URL(first.origin).port)};
    const host = await startJobHost(long); hosts.push(host);
    const path = join(options.stateDir, 'job-ui', host.session.jobId + '.json');
    const bytes = await readFile(path), value = JSON.parse(bytes.toString());
    if (!extra) {expect(bytes.length).toBe(65536); expect(value.listenerIncarnation).toMatch(/^[0-9a-f-]{36}$/);}
    else {expect(value.listenerIncarnation).toBeUndefined(); expect(bytes.length).toBeLessThanOrEqual(65536);}
    expect(host.attachment).toBeNull();
    const ordinary = await startJobHost(long); hosts.push(ordinary);
    expect(ordinary.reused).toBe(true); expect(ordinary.attachment).toBeNull(); ordinary.stop();
    expect(await readFile(path)).toEqual(bytes);
    const full = {...initial, jobId: host.session.jobId, origin: host.origin, binding: {...initial.binding, fingerprint: long.fingerprint}};
    if (extra) await expect(startJobHost({...long, reuseOnly: {expected: full}})).rejects.toMatchObject({
      code: 'JOB_HOST_ATTACH_REFUSED', reason: 'incarnation-missing', phase: 'record'});
    host.stop();
  }
});

test('CP1 request and response envelopes accept exactly 65536 bytes and refuse 65537', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, input = JSON.stringify({expected, observed: observed(expected)});
  const req = (bytes: string) => new Request(owner.origin + `/jobs/${expected.jobId}/host`, {method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': owner.session.hostCredentials().ui}, body: bytes});
  const accepted = await originalFetch(req(input.padEnd(65536, ' ')));
  expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ok: true, attachment: expected});
  const refused = await originalFetch(req(input.padEnd(65537, ' ')));
  expect(refused.status).toBe(413); expect(await refused.json()).toMatchObject({error: {code: 'JOB_BODY_LIMIT'}});
  for (const extra of [0, 1]) {
    const payload = JSON.stringify({ok: true, attachment: expected, pid: process.pid}).padEnd(65536 + extra, ' ');
    globalThis.fetch = (async () => new Response(payload)) as unknown as typeof fetch;
    if (!extra) {const attached = await startJobHost({...options, reuseOnly: {expected}}); hosts.push(attached); expect(attached.attachment).toEqual(expected);}
    else await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'probe'});
  }
});

test('CP1 explicit port 80 uses normalized HTTP Origin while preserving the tuple spelling', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const incarnation = owner.attachment!.listenerIncarnation;
  const context = createJobRequestContext(owner.session, options, 'http://127.0.0.1:80', jobHostIdentity(options), undefined, undefined, incarnation);
  const path = join(options.stateDir, 'job-ui', owner.session.jobId + '.json'), bytes = await readFile(path);
  await writeFile(path, JSON.stringify(context.descriptor().record)); context.publish();
  try {
    const expected = context.ownerAttachment();
    const response = await context.fetch(new Request(`http://127.0.0.1:80/jobs/${expected.jobId}/host`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: 'http://127.0.0.1', 'X-Review-Capability': owner.session.hostCredentials().ui},
      body: JSON.stringify({expected, observed: observed(expected)})}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ok: true, attachment: expected, pid: process.pid});
    expect(expected.origin).toBe('http://127.0.0.1:80');
  } finally {context.stop(); await writeFile(path, bytes);}
});

test('CP1 real redirect is refused without following it or changing inspected state', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  let followed = 0;
  const sink = Bun.serve({hostname: '127.0.0.1', port: 0, fetch() {followed++; return new Response('unexpected');}}); servers.push(sink);
  const redirect = Bun.serve({hostname: '127.0.0.1', port: 0, fetch() {return new Response(null, {status: 302, headers: {Location: `http://127.0.0.1:${sink.port}/`}});}}); servers.push(redirect);
  const before = await stateImage(options.stateDir);
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => originalFetch(`http://127.0.0.1:${redirect.port}/`, init)) as typeof fetch;
  await expect(startJobHost({...options, reuseOnly: {expected: owner.attachment!}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'probe', phase: 'probe'});
  expect(followed).toBe(0); expect(await stateImage(options.stateDir)).toEqual(before);
});

test('CP1 standalone disposed stop and an independent close each win during body parsing', async () => {
  for (const event of ['stop', 'close']) {
    const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
    const expected = owner.attachment!, context = createJobRequestContext(owner.session, options, owner.origin,
      jobHostIdentity(options), undefined, undefined, expected.listenerIncarnation); context.publish();
    const payload = Buffer.from(JSON.stringify({expected, observed: observed(expected)}));
    let resume!: () => void, entered!: () => void;
    const barrier = new Promise<void>(r => resume = r), parsing = new Promise<void>(r => entered = r);
    const stream = new ReadableStream<Uint8Array>({async pull(c) {entered(); await barrier; c.enqueue(payload); c.close();}});
    const request = probeRequest(owner, {}), pending = context.fetch(new Request(request, {body: stream}));
    await parsing;
    if (event === 'stop') {context.stop(); owner.stop();}
    else {
      const independent = JobSession.openReadOnly(options, expected.jobId);
      try {await independent.execute({schema: JOB_API_SCHEMA, jobId: expected.jobId, requestId: 'before-accept', verb: 'close',
        expectedGeneration: 0, idempotencyKey: 'before-accept', reason: 'prior'}, new AbortController().signal);} finally {independent.dispose();}
    }
    resume(); const response = await pending;
    expect(response.status).toBe(event === 'stop' ? 503 : 409);
    expect(await response.json()).toMatchObject({error: {code: 'JOB_HOST_ATTACH_REFUSED', reason: event === 'stop' ? 'stopped' : 'closed', phase: 'acceptance'}});
    context.stop();
  }
});

test('CP1 real recovery-required SQLite journal refuses without recovery or bootstrap writes', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!; owner.stop();
  const file = join(options.stateDir, 'jobs.sqlite');
  const argv = [process.execPath, '-e', `import {Database} from 'bun:sqlite';
    const db=new Database(${JSON.stringify(file)});db.exec('PRAGMA cache_size=1; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.query("UPDATE jobs SET document=json_set(document,'$.crashPad',?) WHERE job_id=?").run('x'.repeat(2*1024*1024),${JSON.stringify(expected.jobId)});
    process.kill(process.pid,'SIGKILL');`];
  const child = Bun.spawnSync(argv);
  console.error(JSON.stringify({proof: 'hot-journal-plant', argv, exit: child.exitCode, signal: child.signalCode, stdout: child.stdout.toString(), stderr: child.stderr.toString()}));
  expect(child.exitCode).not.toBe(0);
  const journal = await readFile(file + '-journal'); expect(journal.length).toBeGreaterThan(0);
  const before = await stateImage(options.stateDir);
  await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject({code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: 'state'});
  expect(await stateImage(options.stateDir)).toEqual(before);
});

test('CP1 private entry, missing control, schema and stored-document refusals preserve bytes', async () => {
  for (const target of ['state', 'store', 'control', 'record', 'missing-control', 'missing-job', 'schema', 'missing-schema', 'oversized-document', 'missing-table', 'record-symlink', 'store-hardlink']) {
    const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
    const expected = owner.attachment!; owner.stop();
    const store = join(options.stateDir, 'jobs.sqlite'), control = join(options.stateDir, 'job-ui'), record = join(control, expected.jobId + '.json');
    const entries: Record<string, string> = {state: options.stateDir, store, control, record};
    let expectedError: Record<string, unknown> = {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'read', phase: ['control', 'record', 'record-symlink'].includes(target) ? 'record' : 'state'};
    let restore: (() => Promise<void>) | undefined;
    if (target in entries) {
      const path = entries[target]!, mode = lstatSync(path).mode & 0o777;
      await chmod(path, mode | 0o044); restore = () => chmod(path, mode);
    } else if (target === 'missing-control') {
      await rename(control, control + '.saved'); restore = () => rename(control + '.saved', control);
      expectedError = {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'missing', phase: 'record'};
    } else if (target === 'record-symlink') {
      await rename(record, record + '.saved'); await symlink(record + '.saved', record);
      restore = async () => {await unlink(record); await rename(record + '.saved', record);};
    } else if (target === 'store-hardlink') {
      require('node:fs').linkSync(store, store + '.link'); restore = () => unlink(store + '.link');
    } else {
      const db = new Database(store);
      try {
        if (target === 'missing-job') {db.query('DELETE FROM jobs WHERE job_id=?').run(expected.jobId); expectedError = {code: 'JOB_HOST_ATTACH_REFUSED', reason: 'missing', phase: 'state'};}
        if (target === 'schema') {db.query("UPDATE jobs SET document=json_set(document,'$.apiSchema','old') WHERE job_id=?").run(expected.jobId);
          expectedError = {code: 'JOB_HOST_REUSE_MISMATCH', field: 'apiSchema', expected: JOB_API_SCHEMA, actual: 'old'};}
        if (target === 'missing-schema') db.query("UPDATE jobs SET document=json_remove(document,'$.actSchema') WHERE job_id=?").run(expected.jobId);
        if (target === 'oversized-document') db.query("UPDATE jobs SET document=json_set(document,'$.oversized',?) WHERE job_id=?").run('x'.repeat(16 * 1024 * 1024), expected.jobId);
        if (target === 'missing-table') db.exec('DROP TABLE job_act_stills');
      } finally {db.close();}
    }
    try {
      const before = await stateImage(options.stateDir);
      await expect(startJobHost({...options, reuseOnly: {expected}})).rejects.toMatchObject(expectedError);
      expect(await stateImage(options.stateDir)).toEqual(before);
    } finally {await restore?.();}
  }
});

test('CP1 ordinary reuse ignores unavailable added metadata and retains callback timing and descriptor bytes', async () => {
  const f = await createFixture(); let calls = 0;
  const options = {...baseOptions(f), installWriterBinding: () => {calls++;}};
  const owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!, record = join(options.stateDir, 'job-ui', expected.jobId + '.json'), bytes = await readFile(record);
  for (const token of [undefined, 'MALFORMED', '00000000-0000-4000-8000-000000000099']) {
    const value = {...JSON.parse(bytes.toString()), listenerIncarnation: token};
    const frozen = JSON.stringify(value); await writeFile(record, frozen);
    const reused = await startJobHost(options); hosts.push(reused);
    expect(reused.reused).toBe(true); expect(reused.ownerUrl).toBe(owner.ownerUrl); expect(reused.attachment).toBeNull();
    expect(await readFile(record, 'utf8')).toBe(frozen);
  }
  await writeFile(record, bytes);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ok: true, attachment: {}, pid: process.pid});
    return originalFetch(input, init);
  }) as typeof fetch;
  const reused = await startJobHost(options); hosts.push(reused);
  expect(reused.reused).toBe(true); expect(reused.attachment).toBeNull(); expect(calls).toBe(5);
  expect(await readFile(record)).toEqual(bytes);
});

test('CP1 malformed origins, own accessors and HTTP gates refuse through normal entry points', async () => {
  const f = await createFixture(), options = baseOptions(f), owner = await startJobHost(options); hosts.push(owner);
  const expected = owner.attachment!;
  for (const origin of ['http://127.0.0.1:080', 'http://127.0.0.1:80/', 'http://127.0.0.1:80?x', 'http://127.0.0.1:80#x',
    'http://user@127.0.0.1:80', 'http://127.1:80', 'http://2130706433:80', 'http://127.0.0.1', ' http://127.0.0.1:80']) {
    await expect(startJobHost({...options, reuseOnly: {expected: {...expected, origin}}})).rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
  }
  for (const level of ['options', 'wrapper', 'expectation', 'binding', 'reviewer']) {
    const expectation = cloneExpected(expected), wrapper = {expected: expectation}, input = {...options, reuseOnly: wrapper};
    const entries = {options: [input, 'fingerprint'], wrapper: [wrapper, 'expected'], expectation: [expectation, 'origin'],
      binding: [expectation.binding, 'root'], reviewer: [expectation.binding.reviewer, 'role']} as const;
    const [object, field] = entries[level as keyof typeof entries]; let invoked = 0;
    Object.defineProperty(object, field, {enumerable: true, get() {invoked++; throw new Error('getter must not run');}});
    await expect(startJobHost(input)).rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'}); expect(invoked).toBe(0);
  }
  const hostUrl = owner.origin + `/jobs/${expected.jobId}/host`, body = JSON.stringify({expected, observed: observed(expected)});
  for (const headers of [
    {'Content-Type': 'application/json', Origin: 'http://localhost', 'X-Review-Capability': owner.session.hostCredentials().ui},
    {'Content-Type': 'application/json', Origin: owner.origin, 'Sec-Fetch-Site': 'cross-site', 'X-Review-Capability': owner.session.hostCredentials().ui},
  ] as Record<string, string>[]) {const res = await originalFetch(hostUrl, {method: 'POST', headers, body}); expect(res.status).toBe(403); await res.body?.cancel();}
  for (const content of ['text/plain', 'application/json; charset=utf-8']) {
    const res = await originalFetch(hostUrl, {method: 'POST', headers: {'Content-Type': content, Origin: owner.origin,
      'X-Review-Capability': owner.session.hostCredentials().ui}, body}); expect(res.status).toBe(400); await res.body?.cancel();
  }
  const query = await originalFetch(hostUrl + '?extra=1', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: owner.origin,
    'X-Review-Capability': owner.session.hostCredentials().ui}, body}); expect(query.status).toBe(403); await query.body?.cancel();
  const ordinary = await startJobHost({...options, reuseOnly: undefined}); hosts.push(ordinary); expect(ordinary.reused).toBe(true);
});

test('CP1 ordinary startJobHost preserves released 2.6.0 getter and prototype option compatibility while strict reuseOnly enforces own-data snapshots', async () => {
  const f = await createFixture(), base = baseOptions(f);
  const proto = {inheritedTag: 'prototype-backed'};
  const makeGetterOptions = (stateDir: string, counters: {root: number; reviewer: number; installs: number}, withUndefinedReuseOnly = false): JobHostOptions => {
    const reviewerObj = Object.create(proto) as JobHostOptions['reviewer'];
    Object.assign(reviewerObj, base.reviewer);
    const target: Record<string, unknown> = {
      stateDir,
      fingerprint: base.fingerprint,
      readPublished: base.readPublished,
      readerId: base.readerId,
      installWriterBinding: () => {counters.installs++;},
      bindingId: base.bindingId,
      partsEnumerator: base.partsEnumerator,
      partsEnumeratorId: base.partsEnumeratorId,
      ...(withUndefinedReuseOnly ? {reuseOnly: undefined} : {}),
    };
    Object.defineProperties(target, {
      root: {enumerable: true, get() {counters.root++; return base.root;}},
      reviewer: {enumerable: true, get() {counters.reviewer++; return reviewerObj;}},
    });
    return target as unknown as JobHostOptions;
  };
  const makeProtoOptions = (stateDir: string, counters: {root: number; reviewer: number; installs: number}, withUndefinedReuseOnly = false): JobHostOptions => {
    const target = Object.create(proto) as Record<string, unknown>;
    Object.defineProperties(target, {
      root: {enumerable: true, get() {counters.root++; return base.root;}},
      stateDir: {enumerable: true, value: stateDir},
      fingerprint: {enumerable: true, value: base.fingerprint},
      reviewer: {enumerable: true, get() {counters.reviewer++; return base.reviewer;}},
      readPublished: {enumerable: true, value: base.readPublished},
      readerId: {enumerable: true, value: base.readerId},
      installWriterBinding: {enumerable: true, value: () => {counters.installs++;}},
      bindingId: {enumerable: true, value: base.bindingId},
      partsEnumerator: {enumerable: true, value: base.partsEnumerator},
      partsEnumeratorId: {enumerable: true, value: base.partsEnumeratorId},
      ...(withUndefinedReuseOnly ? {reuseOnly: {enumerable: true, value: undefined}} : {}),
    });
    return target as unknown as JobHostOptions;
  };

  for (const [label, factory] of [['getter', makeGetterOptions], ['proto', makeProtoOptions]] as const) {
    const currentState = join(f.scratch, `current-ordinary-${label}`);
    const currentCounts = {root: 0, reviewer: 0, installs: 0};
    const owner = await startJobHost(factory(currentState, currentCounts));
    hosts.push(owner);
    expect(owner.reused).toBe(false);
    expect(owner.attachment).not.toBeNull();
    expect(currentCounts).toEqual({root: 1, reviewer: 1, installs: 1});

    const reused = await startJobHost(factory(currentState, currentCounts, true));
    hosts.push(reused);
    expect(reused.reused).toBe(true);
    expect(reused.attachment).toEqual(owner.attachment);
    expect(currentCounts).toEqual({root: 2, reviewer: 2, installs: 2});
    reused.stop();
    owner.stop();
  }

  const owner = await startJobHost(base);
  hosts.push(owner);

  let reuseOnlyGetterCalls = 0;
  const withReuseOnlyAccessor = {...base};
  Object.defineProperty(withReuseOnlyAccessor, 'reuseOnly', {
    enumerable: true,
    get() {reuseOnlyGetterCalls++; return undefined;},
  });
  await expect(startJobHost(withReuseOnlyAccessor)).rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
  expect(reuseOnlyGetterCalls).toBe(0);

  const protoWithReuseOnlyAccessor = Object.create({
    get reuseOnly() {reuseOnlyGetterCalls++; return undefined;},
  }) as JobHostOptions;
  Object.assign(protoWithReuseOnlyAccessor, base);
  await expect(startJobHost(protoWithReuseOnlyAccessor)).rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
  expect(reuseOnlyGetterCalls).toBe(0);

  const expected = owner.attachment!;
  await expect(startJobHost(Object.assign(Object.create(proto), {...base, reuseOnly: {expected}})))
    .rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});

  const nonEnumDeclared = {...base, reuseOnly: {expected: cloneExpected(expected)}} as Record<string, unknown>;
  Object.defineProperty(nonEnumDeclared, 'fingerprint', {
    value: base.fingerprint, enumerable: false, configurable: true, writable: true,
  });
  const strictAttached = await startJobHost(nonEnumDeclared as unknown as JobHostOptions);
  hosts.push(strictAttached);
  expect(strictAttached.reused).toBe(true);
  expect(strictAttached.attachment).toEqual(expected);
});

test('CP1 standalone attachment checks serialized strict request budget while preserving ownerAttachment and exact 65536-byte boundary', async () => {
  const f = await createFixture(), options = baseOptions(f), first = await startJobHost(options); hosts.push(first);
  const initial = first.attachment!, port = Number(new URL(first.origin).port);
  first.stop();
  const reqOverhead = Buffer.byteLength(JSON.stringify({
    expected: {...initial, binding: {...initial.binding, readerId: ''}},
    observed: observed(initial),
  }));

  const overOptions: JobHostOptions = {...options, port, readerId: 'r'.repeat(65536 - reqOverhead + 1)};
  const over = await startJobHost(overOptions); hosts.push(over);
  const overRecordPath = join(options.stateDir, 'job-ui', over.session.jobId + '.json');
  const overDescriptorBytes = await readFile(overRecordPath, 'utf8');
  const overDescriptor = JSON.parse(overDescriptorBytes) as {listenerIncarnation?: string};
  expect(Buffer.byteLength(overDescriptorBytes)).toBeLessThanOrEqual(65536);
  expect(overDescriptor.listenerIncarnation).toMatch(/^[0-9a-f-]{36}$/);
  const unadvertised: JobHostReuseExpectation = {
    ...initial,
    jobId: over.session.jobId,
    origin: over.origin,
    listenerIncarnation: overDescriptor.listenerIncarnation!,
    binding: {...initial.binding, readerId: overOptions.readerId!},
  };
  expect(Buffer.byteLength(JSON.stringify({ok: true, attachment: unadvertised, pid: process.pid}))).toBeLessThanOrEqual(65536);
  expect(Buffer.byteLength(JSON.stringify({expected: unadvertised, observed: observed(unadvertised)}))).toBe(65537);
  expect(over.attachment).toBeNull();
  const ordinaryOver = await startJobHost(overOptions); hosts.push(ordinaryOver);
  expect(ordinaryOver.reused).toBe(true);
  expect(ordinaryOver.attachment).toBeNull();
  await expect(startJobHost({...overOptions, reuseOnly: {expected: unadvertised}})).rejects.toMatchObject({code: 'JOB_BODY_LIMIT'});
  const overContext = createJobRequestContext(over.session, overOptions, over.origin, jobHostIdentity(overOptions), undefined, undefined, overDescriptor.listenerIncarnation!);
  overContext.publish();
  expect(overContext.ownerAttachment()).toEqual(unadvertised);
  expect(overContext.attachment()).toBeNull();
  overContext.stop();
  ordinaryOver.stop();
  over.stop();

  const exactOptions: JobHostOptions = {...options, port, readerId: 'r'.repeat(65536 - reqOverhead)};
  const exact = await startJobHost(exactOptions); hosts.push(exact);
  expect(exact.attachment).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify({expected: exact.attachment, observed: observed(exact.attachment!)}))).toBe(65536);
  expect(Buffer.byteLength(JSON.stringify({ok: true, attachment: exact.attachment, pid: process.pid}))).toBeLessThanOrEqual(65536);
  const ordinaryExact = await startJobHost(exactOptions); hosts.push(ordinaryExact);
  expect(ordinaryExact.reused).toBe(true);
  expect(ordinaryExact.attachment).toEqual(exact.attachment);
  const strictExact = await startJobHost({...exactOptions, reuseOnly: {expected: exact.attachment!}}); hosts.push(strictExact);
  expect(strictExact.reused).toBe(true);
  expect(strictExact.attachment).toEqual(exact.attachment);
  strictExact.stop();
  ordinaryExact.stop();
  exact.stop();
});
