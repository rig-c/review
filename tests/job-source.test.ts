import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JobSession } from '../src/job-session.ts';
import { jobFixture, jobInputHashes, syntheticJobParts } from './helpers/job-api-fixture.ts';
import { joinedVerdictFixture } from './helpers/joined-verdict-fixture.ts';
import { readProject } from '../src/interview-project.ts';

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

test('checkpoint 1 preserves legacy PNG restrictions through manifest-relative path plumbing', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { painting: true });
  const valid = await f.publish();
  expect(valid.source.parts).toEqual(parts);
  for (const path of ['rigid.png', 'wrong/painting_in_rig.png', 'parts/nested/image.png', 'parts/image.PNG']) {
    f.setContext({ ...f.getContext(), parts: { ...parts, images: [{ role: parts.images[0].role, path: path as typeof parts.images[number]['path'], sha256: parts.images[0].sha256 }] } });
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(f.session.status().publication).toEqual(valid);
  }
  await writeFile(join(f.root, 'parts.json'), await readFile(join(f.root, parts.manifest.path)));
  await writeFile(join(f.root, 'painting_in_rig.png'), await readFile(join(f.root, 'out/painting_in_rig.png')));
  f.setContext({ ...f.getContext(), parts: {
    enumeratorVersion: parts.enumeratorVersion,
    manifest: { path: 'parts.json', sha256: parts.manifest.sha256 },
    images: [{ path: 'painting_in_rig.png', role: 'painting', sha256: parts.images.find(image => image.path === 'painting_in_rig.png')!.sha256 }],
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

test('actual readProject pending questions publish, ask and save an act while optional answer absence stays persistable', async () => {
  const f = await fixture();
  await joinedVerdictFixture(f.root, '2-rigging-answers');
  const opened = readProject(f.root), pending = opened.questions.find(question => question.editable)!;
  expect(pending).toBeDefined();
  expect(Object.hasOwn(pending, 'answer')).toBe(true);
  expect(pending.answer).toBeUndefined();
  const historical = opened.questions.find(question => question.answer !== undefined)!;
  expect(historical).toBeDefined();
  f.setRecordPath('project.json');
  // The pending sets are real reader output. Only the producer publication
  // adapter is synthetic, selecting the ordinary compiled fixture beside them.
  f.setContext({ ...f.getContext(), plan: null, subjects: [{ kind: 'interview-picks',
    questionId: pending.set.question, setId: pending.set.id }] });
  const before = await jobInputHashes(f.root);
  const published = await (await f.call(await f.publishRequest('real-pending'))).json();
  expect(published.error?.code ?? null).toBeNull();
  expect(published.ok).toBe(true);
  const retained = f.session.retainedSource(published.value.publicationId);
  const savedPending = retained.questions.find(question => question.set.id === pending.set.id)!;
  expect(Object.hasOwn(savedPending, 'answer')).toBe(false);
  expect(retained.questions.find(question => question.set.id === historical.set.id)?.answer).toEqual(historical.answer);
  const ask = await f.ask(published.value, { kind: 'interview-picks', questionId: pending.set.question, setId: pending.set.id });
  const page = await f.display(published.value);
  const selections = pending.set.asks.map(item => ({ itemId: item.id,
    optionId: item.options.find(option => option.kind === 'value' && option.recommended)!.id, otherText: null }));
  const note = '실제 pending 원문\nunchanged';
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'real-pending-save',
    kind: 'interview-picks', value: { questionId: pending.set.question, selections, note } }));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.kind).toBe('interview-picks');
  expect(saved.value.value).toEqual({ questionId: pending.set.question, selections, note });
  expect(saved.value.source.optionSet).toEqual({ id: pending.set.id, sha256: pending.ref.sha256 });
  expect(saved.value.source.projectHash).toBe(opened.hash);
  expect(await jobInputHashes(f.root)).toEqual(before);
});
