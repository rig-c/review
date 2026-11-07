import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JobSession } from '../src/job-session.ts';
import { jobFixture, syntheticJobParts } from './helpers/job-api-fixture.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }

test('source root containment refuses symlink inputs and state inside source before creating state', async () => {
  const f = await fixture();
  expect(() => new JobSession({ root: f.root, stateDir: join(f.root, 'forbidden-state'), fingerprint: 'f'.repeat(64),
    reviewer: { id: 'owner', role: 'owner' } })).toThrow('Job state must be outside');
  await symlink(f.state, join(f.root, 'escaped'));
  const request = await f.publishRequest();
  const response = await (await f.call({ ...request, result: { path: 'escaped', selector: null } })).json();
  expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
  expect(f.session.status().publication).toBeNull();
});

test('missing/partial record and changed original assets never publish', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'record.json'), '{');
  const incomplete = await (await f.call(await f.publishRequest())).json();
  expect(incomplete.error.code).toBe('JOB_RECORD_INCOMPLETE');
  const request = await f.publishRequest();
  await writeFile(join(f.root, 'record.json'), '{}');
  expect((await (await f.call(request)).json()).error.code).toBe('JOB_RECORD_MOVED');
  expect(f.session.status().generation).toBe(0);
});

test('Create input without the declared producer reader is named unavailable and cannot be disguised as an ordinary record', async () => {
  const f = await fixture();
  const project = { schema: 'rig-create/project@0', interview: {} };
  await writeFile(join(f.root, 'project.json'), JSON.stringify(project));
  const request = await f.publishRequest();
  expect((await (await f.call(request)).json()).error.code).toBe('JOB_FREEZE_REQUIRED');
  const plain = new JobSession({ root: f.root, stateDir: join(f.scratch, 'other-state'), fingerprint: 'e'.repeat(64),
    reviewer: { id: 'owner', role: 'owner' } });
  const { createJobHostPorts, jobHash } = await import('../src/job-api.ts');
  const origin = 'http://127.0.0.1:19485', ports = createJobHostPorts(plain, origin);
  const response = await ports.handleJobApi(new Request(origin + `/jobs/${plain.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + plain.hostCredentials().agent },
    body: JSON.stringify({ ...request, jobId: plain.jobId, freeze: { kind: 'producer-held', holdId: 'held',
      record: { path: 'project.json', sha256: jobHash(await readFile(join(f.root, 'project.json'))) } } }),
  }));
  const result = await response.json();
  expect(result.error).toEqual({ code: 'JOB_SOURCE_UNRETAINABLE', message: 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE' });
  plain.dispose();
});

test('root directory replacement refuses a later operation without altering the committed head', async () => {
  const f = await fixture(), publication = await f.publish();
  await rename(f.root, f.root + '-original');
  await mkdir(f.root);
  const result = await (await f.call({ ...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'replaced-root', reason: 'close' })).json();
  expect(result.error.code).toBe('JOB_ROOT_REPLACED');
  expect(f.session.status().publication).toEqual(publication);
});

test('C3 accepts only the declared parts PNG shape or the exact painting sibling, including root and prefixed manifests', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { painting: true });
  const valid = await f.publish();
  expect(valid.source.parts).toEqual(parts);
  for (const path of ['out/rigid.png', 'wrong/painting_in_rig.png', 'out/parts/nested/image.png', 'out/parts/image.PNG']) {
    f.setContext({ ...f.getContext(), parts: { ...parts, images: [{ path: path as typeof parts.images[number]['path'], sha256: parts.images[0].sha256 }] } });
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(f.session.status().publication).toEqual(valid);
  }
  await writeFile(join(f.root, 'parts.json'), await readFile(join(f.root, parts.manifest.path)));
  await writeFile(join(f.root, 'painting_in_rig.png'), await readFile(join(f.root, 'out/painting_in_rig.png')));
  f.setContext({ ...f.getContext(), parts: {
    manifest: { path: 'parts.json', sha256: parts.manifest.sha256 },
    images: [{ path: 'painting_in_rig.png', sha256: parts.images.find(image => image.path.endsWith('/painting_in_rig.png'))!.sha256 }],
  } });
  expect((await f.publish()).source.parts?.images[0].path).toBe('painting_in_rig.png');
});

test('changed or missing referenced painting refuses while unreferenced stale PNGs stay outside the binding', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { painting: true });
  const original = await f.publish();
  await writeFile(join(f.root, 'out/parts/unreferenced.png'), 'unreferenced stale bytes');
  const withExtra = await f.publish();
  expect(withExtra.source.sourceHash).toBe(original.source.sourceHash);
  expect(withExtra.instanceKey).toBe(original.instanceKey);
  expect(withExtra.source.parts).toEqual(parts);
  await writeFile(join(f.root, 'out/painting_in_rig.png'), 'changed referenced bytes');
  const changed = await (await f.call(await f.publishRequest())).json();
  expect(changed.error.code).toBe('JOB_SOURCE_MISMATCH');
  expect(f.session.status().publication).toEqual(withExtra);
  await unlink(join(f.root, 'out/painting_in_rig.png'));
  const missing = await (await f.call(await f.publishRequest())).json();
  expect(missing.error.code).toBe('JOB_SOURCE_MISMATCH');
  expect(f.session.status().publication).toEqual(withExtra);
});

test('new snapshot directory entries are synced from leaves through snapshots and its state parent', async () => {
  const synced: string[] = [];
  const f = await jobFixture({ afterDirectorySync: path => { synced.push(path); } });
  fixtures.push(f);
  const publication = await f.publish(), retained = f.session.retainedSource(publication.publicationId);
  expect(synced).toContain(retained.snapshotRoot);
  expect(synced).toContain(dirname(retained.snapshotRoot));
  expect(synced).toContain(f.state);
  expect(synced.indexOf(retained.snapshotRoot)).toBeLessThan(synced.indexOf(dirname(retained.snapshotRoot)));
  expect(synced.indexOf(dirname(retained.snapshotRoot))).toBeLessThan(synced.indexOf(f.state));
});

test('ordinary canonical Review work-root publishing needs no Create adapter', async () => {
  const f = await jobFixture({ plain: true });
  fixtures.push(f);
  const { loadReview } = await import('../src/manifest.ts');
  const expected = await loadReview(join(f.root, 'out'));
  const publication = await f.publish();
  expect(publication.source.sourceHash).toBe(expected.sourceHash);
  expect(publication.source.plan).toBeNull();
  expect(publication.source.parts).toBeNull();
  expect(publication.source.projectHash).toBeNull();
});
