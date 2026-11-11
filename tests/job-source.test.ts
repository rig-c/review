import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, readFile, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JobSession } from '../src/job-session.ts';
import { jobFixture, jobInputHashes, syntheticJobParts } from './helpers/job-api-fixture.ts';
import { joinedVerdictFixture } from './helpers/joined-verdict-fixture.ts';
import { readProject } from '../src/interview-project.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture(options?: Parameters<typeof jobFixture>[0]) { const f = await jobFixture(options); fixtures.push(f); return f; }

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

test('C4 compares claimed paths to authoritative rows and resolves root or prefixed manifests', async () => {
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
  f.setPartsReferences([{path: 'painting_in_rig.png', role: 'painting'}]);
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

import type {JobPartsEnumerator, JobPartsFileReference, JobPartsIdentity} from '../src/job-contract.ts';
import {jobHash} from '../src/job-api.ts';

// Runtime import of the approved dev-only public entry. Production Review has no Parts dependency.
const installedPartsEntry = '@rig-c/parts/src/parts.ts';
const installedParts = await import(installedPartsEntry);
const reviewManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  devDependencies: Record<string, string>;
};
const installedPartsPackage = JSON.parse(await readFile(new URL('../node_modules/@rig-c/parts/package.json', import.meta.url), 'utf8'));
const officialEnumerator: JobPartsEnumerator = {
  version: installedPartsPackage.version,
  enumerate: installedParts.partsFileReferences,
};

async function officialFixture() {
  const f = await fixture({partsEnumerator: officialEnumerator});
  const dir = join(f.root, 'standalone');
  await cp(new URL('./fixtures/job-parts-c4/standalone', import.meta.url), dir, {recursive: true});
  const references = officialEnumerator.enumerate(dir);
  const images = [];
  for (const reference of references) {
    images.push({...reference, sha256: jobHash(await readFile(join(dir, reference.path)))});
  }
  const parts: JobPartsIdentity = {enumeratorVersion: officialEnumerator.version,
    manifest: {path: 'standalone/parts.json', sha256: jobHash(await readFile(join(dir, 'parts.json')))}, images};
  f.setContext({...f.getContext(), parts});
  return {f, dir, references, parts};
}

test('C4 installed public enumeration binds five roles, shared roles and UTF-16 paths losslessly', async () => {
  expect(officialEnumerator.version).toBe(reviewManifest.devDependencies['@rig-c/parts']);
  const {f, references, parts} = await officialFixture();
  const before = await jobInputHashes(f.root);
  const publication = await f.publish();
  expect(publication.source.parts).toEqual(parts);
  expect(publication.source.parts!.images.map(({path, role}) => ({path, role}))).toEqual([...references]);
  expect(new Set(references.map(row => row.role))).toEqual(new Set(['part', 'alternate', 'depth', 'painting', 'figure_mask']));
  expect(references.filter(row => row.path === 'parts/body.png').map(row => row.role)).toEqual(['depth', 'part']);
  expect(references.filter(row => row.role === 'figure_mask')).toHaveLength(1);
  expect(references.findIndex(row => row.path === 'parts/𐀀.png')).toBeLessThan(references.findIndex(row => row.path === 'parts/\ue000.png'));
  const retained = f.session.retainedSource(publication.publicationId);
  expect(retained.seals.filter(row => row.path === 'standalone/parts/body.png')).toHaveLength(1);
  expect(retained.seals.some(row => row.path === 'standalone/render/figure_rig.png')).toBe(false);
  for (const row of parts.images) {
    expect(jobHash(await readFile(join(retained.snapshotRoot, 'standalone', row.path)))).toBe(row.sha256);
  }
  const expected = jobHash(JSON.stringify({schema: 'rig-review-job-source/2',
    packageSourceHash: (await (await import('../src/manifest.ts')).loadReview(join(f.root, 'out'))).sourceHash,
    record: retained.record, selector: publication.source.selector, plan: publication.source.plan,
    parts: publication.source.parts, files: retained.seals}));
  expect(publication.source.sourceHash).toBe(expected);
  await writeFile(join(f.root, 'standalone/unused.png'), 'unreferenced');
  const withExtra = await f.publish();
  expect(withExtra.source.sourceHash).toBe(publication.source.sourceHash);
  await unlink(join(f.root, 'standalone/unused.png'));
  expect(await jobInputHashes(f.root)).toEqual(before);
});

test('C4 standalone sibling removal names the official row even while render copy exists', async () => {
  const {f, dir, references} = await officialFixture();
  const original = await f.publish();
  const row = references.findIndex(reference => reference.role === 'figure_mask');
  const reference = references[row];
  await unlink(join(dir, reference.path));
  expect((await readFile(join(dir, 'render/figure_rig.png'))).length).toBeGreaterThan(0);
  const response = await (await f.call(await f.publishRequest())).json();
  expect(response.error).toEqual({code: 'JOB_SOURCE_MISMATCH',
    message: `PARTS_REFERENCE_MISSING row=${row} role=${reference.role} path=${JSON.stringify(reference.path)}`});
  expect(f.session.status().publication).toEqual(original);
});

test('C4 claimed inventory mutations refuse against the untouched public array', async () => {
  const {f, parts} = await officialFixture();
  const original = await f.publish();
  const images = parts.images;
  const mutations = [images.slice(1), [...images, images[0]], [...images].reverse(),
    images.map((row, index) => index ? row : {...row, role: 'part'}),
    [...images.slice(0, 1), images[0], ...images.slice(1)],
    [...images.slice(0, 1), {...images[1], path: 'unused.png'}, ...images.slice(2)]];
  for (const changed of mutations) {
    f.setContext({...f.getContext(), parts: {...parts, images: changed}});
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(response.error.message).toStartWith('PARTS_REFERENCE_SET_MISMATCH row=');
    expect(f.session.status().publication).toEqual(original);
  }
});

test('C4 PNG decode, decoded allocation and raw-hash refusals keep the committed publication', async () => {
  const {f, dir, parts} = await officialFixture();
  const original = await f.publish();
  const path = 'figure_rig.png';
  const bytes = await readFile(join(dir, path));
  const oversized = Buffer.from(bytes);
  oversized.writeUInt32BE(0xffffffff, 16);
  oversized.writeUInt32BE(0xffffffff, 20);
  for (const [data, name] of [[Buffer.from('invalid PNG'), 'PARTS_REFERENCE_PNG_INVALID'],
    [bytes.subarray(0, 33), 'PARTS_REFERENCE_PNG_INVALID'], [oversized, 'PARTS_REFERENCE_LIMIT']] as const) {
    await writeFile(join(dir, path), data);
    f.setContext({...f.getContext(), parts: {...parts,
      images: parts.images.map(row => row.path === path ? {...row, sha256: jobHash(data)} : row)}});
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.message).toStartWith(name + ' row=');
    expect(f.session.status().publication).toEqual(original);
  }
  await writeFile(join(dir, path), bytes);
  f.setContext({...f.getContext(), parts: {...parts,
    images: parts.images.map(row => row.path === path ? {...row, sha256: '0'.repeat(64)} : row)}});
  const response = await (await f.call(await f.publishRequest())).json();
  expect(response.error.message).toStartWith('PARTS_REFERENCE_HASH_MISMATCH row=');
  expect(f.session.status().publication).toEqual(original);
});

test('C4 bounds paths without role, filename, ordering or duplicate reclassification', async () => {
  let references: readonly JobPartsFileReference[] = [];
  const f = await fixture({partsEnumerator: {version: '2.25.1', enumerate: () => references}});
  const parts = await syntheticJobParts(f);
  const bytes = await readFile(join(f.root, 'out/rigid.png'));
  await mkdir(join(f.root, 'out/arbitrary'));
  await writeFile(join(f.root, 'out/arbitrary/image.bin'), bytes);
  references = [{path: 'arbitrary/image.bin', role: 'producer-owned-role'},
    {path: 'arbitrary/image.bin', role: 'another-role'}];
  f.setContext({...f.getContext(), parts: {...parts, images: references.map(row => ({...row, sha256: jobHash(bytes)}))}});
  const original = await f.publish();
  expect(original.source.parts?.images.map(({path, role}) => ({path, role}))).toEqual([...references]);
  for (const path of ['../escape.png', '/absolute.png', 'parts//x.png', 'parts/./x.png',
    'parts/%2e.png', 'parts\\escape.png', 'https://example.invalid/x.png', 'parts/x?.png', 'parts/x#.png', 'parts/x\n.png']) {
    references = [{path, role: 'bounded-role'}];
    f.setContext({...f.getContext(), parts: {...parts, images: references.map(row => ({...row, sha256: jobHash(bytes)}))}});
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error).toEqual({code: 'JOB_SOURCE_UNRETAINABLE', message: 'PARTS_REFERENCE_PATH_REFUSED row=0'});
    expect(f.session.status().publication).toEqual(original);
  }
});

test('C4 refuses symlink leaves, symlink parents, special paths and byte/row/role overflow', async () => {
  let references: readonly JobPartsFileReference[] = [];
  const f = await fixture({partsEnumerator: {version: '2.25.1', enumerate: () => references}});
  const parts = await syntheticJobParts(f);
  const data = await readFile(join(f.root, 'out/rigid.png'));
  const outside = join(f.scratch, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'image.png'), data);
  await symlink(join(outside, 'image.png'), join(f.root, 'out/parts/link.png'));
  await symlink(outside, join(f.root, 'out/link'));
  await mkdir(join(f.root, 'out/parts/directory.png'));
  async function refused(rows: readonly JobPartsFileReference[]) {
    references = rows;
    f.setContext({...f.getContext(), parts: {...parts, images: rows.map(row => ({...row, sha256: jobHash(data)}))}});
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.ok).toBe(false);
    expect(f.session.status().generation).toBe(0);
    return result.error;
  }
  for (const path of ['parts/link.png', 'link/image.png', 'parts/directory.png']) {
    expect((await refused([{path, role: 'part'}])).message).toStartWith('PARTS_REFERENCE_PATH_REFUSED row=0');
  }
  await truncate(join(f.root, 'out/parts/base.png'), 64 * 1024 * 1024 + 1);
  expect((await refused([{path: 'parts/base.png', role: 'part'}])).message).toStartWith('PARTS_REFERENCE_LIMIT row=0');
  for (const role of ['', 'x'.repeat(129), 'bad\nrole']) {
    expect((await refused([{path: 'parts/base.png', role}])).message).toBe('PARTS_REFERENCE_SET_MISMATCH row=0');
  }
  expect((await refused(Array.from({length: 4097}, () => ({path: 'parts/base.png', role: 'part'})))).message).toBe('PARTS_REFERENCE_LIMIT');
});

test('C4 preserves the public manifest reader refusal name', async () => {
  const {f, dir, parts} = await officialFixture();
  await writeFile(join(dir, 'parts.json'), '{');
  f.setContext({...f.getContext(), parts: {...parts, manifest: {...parts.manifest, sha256: jobHash('{')}}});
  const response = await (await f.call(await f.publishRequest())).json();
  expect(response.error).toEqual({code: 'JOB_SOURCE_MISMATCH', message: 'PARTS_ENUMERATION_REFUSED rule=PARTS_IS_JSON'});
  expect(f.session.status().generation).toBe(0);
});

// Literal release-8e1e3387 oracle from source copies frozen before projection edits.
// Provenance /tmp/review606-sol-implementation/ORACLE-03.test.ts and GOLDEN-03.json.
// Source/act strings are literals. IDs/time are fixed in the existing fixture helper.
const golden606 = {
  "samples": {
    "package-absent": {
      "sourceBytes": "{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null}",
      "preimage": "{\"schema\":\"rig-review-job-source/2\",\"packageSourceHash\":\"7e095240763ae30a8a592f2e5ae180b9a0900b1beed89777df89cdb07077f4e4\",\"record\":{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"files\":[{\"path\":\"out/mesh.png\",\"sha256\":\"3c53c17cafd9c4aebfadf42b20b379b35ff9a62099155c709789b16aa38b1287\"},{\"path\":\"out/report.json\",\"sha256\":\"75f2d38478ab548a713a638ba6ae7a7a31b5aac2c41c9fcbda3571716b7bf612\"},{\"path\":\"out/review.json\",\"sha256\":\"ae8c6771bf1d394e1c3e6d7351e017ec6475d1583af6af44c01ae6c85a6d0263\"},{\"path\":\"out/rigid.png\",\"sha256\":\"ae23847ba8cd901398cd2b9d5e0e3786871016235ac1ef2dd8e4bcb9ef655415\"},{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"}]}",
      "sourceHash": "1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42",
      "actBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null}",
      "replayActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    },
    "package-evidence": {
      "sourceBytes": "{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "preimage": "{\"schema\":\"rig-review-job-source/2\",\"packageSourceHash\":\"7e095240763ae30a8a592f2e5ae180b9a0900b1beed89777df89cdb07077f4e4\",\"record\":{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"out/mesh.png\",\"sha256\":\"3c53c17cafd9c4aebfadf42b20b379b35ff9a62099155c709789b16aa38b1287\"},{\"path\":\"out/report.json\",\"sha256\":\"75f2d38478ab548a713a638ba6ae7a7a31b5aac2c41c9fcbda3571716b7bf612\"},{\"path\":\"out/review.json\",\"sha256\":\"ae8c6771bf1d394e1c3e6d7351e017ec6475d1583af6af44c01ae6c85a6d0263\"},{\"path\":\"out/rigid.png\",\"sha256\":\"ae23847ba8cd901398cd2b9d5e0e3786871016235ac1ef2dd8e4bcb9ef655415\"},{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "sourceHash": "e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439",
      "actBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "replayActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    },
    "record-absent": {
      "sourceBytes": "{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "preimage": "{\"schema\":\"rig-review-job-record-source/1\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"selection\":{\"kind\":\"plan\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}]}",
      "sourceHash": "5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785",
      "actBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "replayActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    },
    "record-evidence": {
      "sourceBytes": "{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "preimage": "{\"schema\":\"rig-review-job-record-source/1\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"selection\":{\"kind\":\"plan\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "sourceHash": "329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2",
      "actBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "replayActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    }
  },
  "publicExports": [
    "JOB_ACT_SCHEMA",
    "JOB_API_SCHEMA",
    "JOB_API_V3_SCHEMA",
    "JOB_CAPABILITIES",
    "JOB_CONSUMER_AUTH_MODE",
    "JOB_ENABLED_ACT_KINDS",
    "JOB_ERROR_CODES",
    "JOB_PARTS_ENUMERATOR_RANGE",
    "JOB_PLAN_BOUND_SIGNOFF_STAGES",
    "JOB_RECORD_ACT_SCHEMA",
    "JOB_RECORD_READER_ID",
    "JOB_RESERVED_ACT_KINDS",
    "assertJobImageSetCapability",
    "parseRecordAct",
    "prepareJobRecordAct",
    "prepareJobRecordSource",
    "startJobHost",
    "startJobHub"
  ]
};

test('#606 literal package/record canonical, durable, replay and export compatibility in evidence/absence cases', async () => {
  const {collect606Canonical} = await import('./helpers/job-api-fixture.ts');
  const actual = await collect606Canonical();
  expect(actual).toEqual(golden606);
  for (const [name, sample] of Object.entries(actual.samples)) {
    expect(sample.durableSourceBytes).toBe(sample.sourceBytes);
    expect(sample.replayActBytes).toBe(sample.durableActBytes);
    expect(sample.reopenedActBytes).toBe(sample.durableActBytes);
    const changed = structuredClone(actual);
    changed.samples[name]!.sourceHash = '0'.repeat(64);
    expect(() => expect(changed).toEqual(golden606)).toThrow();
  }
});

import {retainedPublicationRoutes} from '../src/job-front.ts';
import {planTextMetadata, projectRetainedPlanText, isRetainedRecordSource} from '../src/job-source.ts';
import {parseJobPlanTextProjection, JOB_RECORD_READER_ID, type JobPlanTextProjection} from '../src/job-contract.ts';
import {jobCheckpointContext, jobPlanTextForSource} from '../web/job-session.ts';
import {createSyntheticPlanRecordWorkspace} from './helpers/job-record-fixture.ts';

const exact606 = {does:'  <mark>do</mark> 한글 e\u0301\r\n\t ', produces:'',bar:' bar\r\nvalue ',rests_on:['bones','bones','']};
async function textFixture606(kind:'package'|'record', change?:(project:any)=>void) {
  const f = await fixture();
  const synthetic = createSyntheticPlanRecordWorkspace(f.root);
  const project = JSON.parse(await readFile(join(f.root,'project.json'),'utf8'));
  Object.assign(project.plan.steps[0],exact606);
  Object.assign(project.plan.steps[1],exact606);
  change?.(project);
  const bytes = JSON.stringify(project);
  await writeFile(join(f.root,'project.json'),bytes);
  const record = {path:'project.json' as const,sha256:jobHash(bytes)};
  const context = {...synthetic.context,files:synthetic.files.map(file => file.path === 'project.json' ? record : file)};
  let session = f.session;
  let publication:any;
  if (kind === 'package') {
    f.setRecordPath('project.json');
    f.setContext({...f.getContext(),plan:{steps:[context.plan.steps[0]!]},files:context.files,
      subjects:[{kind:'checkpoint',checkpointId:'alias',planStepId:'step_layout'}]});
    publication = await f.publish();
  } else {
    session = new JobSession({root:f.root,stateDir:join(f.scratch,'record-state'),fingerprint:'record-text',
      reviewer:{id:'owner',role:'owner'},publicationMode:'record-and-package',recordReaderId:JOB_RECORD_READER_ID,
      readRecordPublished:(() => structuredClone(context)) as any});
    const {createJobHostPorts} = await import('../src/job-api.ts');
    const ports = createJobHostPorts(session,f.origin);
    const response = await ports.handleJobApi(new Request(f.origin+'/jobs/'+session.jobId+'/api',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.hostCredentials().agent},
      body:JSON.stringify({schema:'rig-review/job-api@3',jobId:session.jobId,requestId:'publish',verb:'publish',
        expectedGeneration:0,idempotencyKey:'publish',freeze:{kind:'producer-held',holdId:'held',record},result:{kind:'plan'}})}));
    const result = await response.json();
    expect(result.ok).toBe(true);
    publication = result.value;
  }
  const routes = retainedPublicationRoutes(session);
  const metadata = (method='GET') => routes(session.jobId,publication.publicationId,publication.instanceKey,'api/review',new Request(f.origin+'/api/review',{method}));
  return {f,session,publication,metadata,record,close:() => {if (session !== f.session) session.dispose();}};
}

test('#606 D1/D2 normal metadata authenticates retained project and preserves four fields, alias mapping and source bytes',async()=>{
  for (const kind of ['package','record'] as const) {
    const f = await textFixture606(kind);
    try {
      const retained = f.session.retainedSourceV3(f.publication.publicationId);
      const before = JSON.stringify(retained.source);
      await writeFile(join(f.f.root,'project.json'),'live record changed after publication');
      const response = await f.metadata();expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.planText.record).toEqual(f.record);
      expect(body.planText.steps).toHaveLength(kind === 'package' ? 1 : 2);
      expect(body.planText.steps[0]).toEqual({id:'step_layout',hash:'1'.repeat(64),...exact606,issues:[]});
      expect(Object.keys(body.planText.steps[0])).toEqual(['id','hash','does','produces','bar','rests_on','issues']);
      expect(JSON.stringify(retained.source)).toBe(before);
      expect(jobPlanTextForSource(body.planText,retained.source)).toEqual(body.planText);
      if (kind === 'package') {
        const checkpoint = jobCheckpointContext({subject:{kind:'checkpoint',checkpointId:'alias',planStepId:'step_layout'},source:retained.source} as any,[]);
        expect(checkpoint.step.id).toBe('step_layout');
        expect(body.planText.steps.find((row:any)=>row.id===checkpoint.step.id&&row.hash===checkpoint.step.hash).bar).toBe(exact606.bar);
      } else expect(body.recordSource).toEqual(retained.source);
      const altered = structuredClone(body.planText);altered.steps[0].bar = 'type-valid post-server text';
      expect(jobPlanTextForSource(altered,retained.source)?.status).toBe('projected');
      for (const alter of [
        (x:any)=>{x.record.sha256='0'.repeat(64);},
        (x:any)=>{x.steps[0].hash='0'.repeat(64);},
        (x:any)=>{x.steps[0].id='another';},
      ]) {
        const wrong = structuredClone(body.planText);alter(wrong);
        expect(()=>jobPlanTextForSource(wrong,retained.source)).toThrow('PLAN_TEXT_SOURCE_MISMATCH');
      }
      await writeFile(join(retained.snapshotRoot,'project.json'),'tampered sealed record');
      const refused = await f.metadata();expect(refused.status).toBe(409);
      expect((await refused.json()).error.message).toBe('PLAN_TEXT_RECORD_HASH_MISMATCH');
      expect((await f.metadata('HEAD')).status).toBe(409);
    } finally {f.close();}
  }
});

test('#606 missing versus malformed fields and legacy mapping/limits stay explicit and source-bound',async()=>{
  const f = await textFixture606('record',project=>{
    delete project.plan.steps[0].produces;
    project.plan.steps[0].bar = null;
    project.plan.steps[0].rests_on = ['okay',2];
  });
  try {
    const retained = f.session.retainedSourceV3(f.publication.publicationId);
    const projection = projectRetainedPlanText(retained)!;
    expect(projection.status).toBe('projected');
    if (projection.status !== 'projected') throw new Error('Expected fields');
    expect(projection.steps[0]).toEqual({id:'step_layout',hash:'1'.repeat(64),does:exact606.does,issues:[
      {field:'produces',reason:'absent'},{field:'bar',reason:'invalid'},{field:'rests_on',reason:'invalid'}]});
    expect(parseJobPlanTextProjection(projection)).toEqual(projection);
    const invalid = structuredClone(projection) as any;
    invalid.steps[0].issues[0].field = 'bar';
    expect(()=>parseJobPlanTextProjection(invalid)).toThrow('PLAN_TEXT_METADATA_INVALID');
    expect(()=>projectRetainedPlanText({...retained,source:{...retained.source,projectHash:'0'.repeat(64)}} as any))
      .toThrow('PLAN_TEXT_RECORD_MISMATCH');
    const fullOverhead = Buffer.byteLength(JSON.stringify({payload:'',planText:projection}));
    const base = {payload:'x'.repeat(2*1024*1024 - fullOverhead + 1)};
    const fallback = planTextMetadata(retained,base) as any;
    expect(fallback.planText.reason).toBe('PLAN_TEXT_LIMIT');
    expect(Buffer.byteLength(JSON.stringify(fallback))).toBeLessThanOrEqual(2*1024*1024);
    const small = {...base,planText:{schema:'rig-review/job-plan-text@1',record:projection.record,status:'unavailable',reason:'PLAN_TEXT_LIMIT'}};
    const overhead = Buffer.byteLength(JSON.stringify(small))-base.payload.length;
    expect(Buffer.byteLength(JSON.stringify(planTextMetadata(retained,{payload:'x'.repeat(2*1024*1024-overhead)})))).toBe(2*1024*1024);
    expect(()=>planTextMetadata(retained,{payload:'x'.repeat(2*1024*1024-overhead+1)})).toThrow('PLAN_TEXT_LIMIT');
  } finally {f.close();}
  for (const [change,reason] of [
    [(p:any)=>{p.plan.steps[0].bar='x'.repeat(512*1024);},'PLAN_TEXT_LIMIT'],
    [(p:any)=>{p.plan.steps[0].rests_on=Array(4097).fill('a');},'field-limit'],
  ] as const) {
    const f = await textFixture606('package',change);
    try {
      const body = await (await f.metadata()).json();
      if (reason === 'field-limit') expect(body.planText.steps[0].issues).toContainEqual({field:'rests_on',reason:'limit'});
      else expect(body.planText.reason).toBe(reason);
    } finally {f.close();}
  }
});

test('#606 explicit legacy absence and D1 mapping reasons preserve identities; parser keeps 4096 source identities',async()=>{
  for (const [change,reason] of [
    [(p:any)=>{delete p.plan;},'PLAN_TEXT_STEPS_ABSENT'],
    [(p:any)=>{p.plan=null;},'PLAN_TEXT_STEPS_INVALID'],
    [(p:any)=>{p.plan.steps='invalid';},'PLAN_TEXT_STEPS_INVALID'],
    [(p:any)=>{p.plan.steps[0].id='different';},'PLAN_TEXT_MAPPING_UNAVAILABLE'],
    [(p:any)=>{p.plan.steps.push(structuredClone(p.plan.steps[0]));},'PLAN_TEXT_MAPPING_UNAVAILABLE'],
  ] as const) {
    const f=await textFixture606('package',change);
    try {
      const before=JSON.stringify(f.publication.source);
      const body=await (await f.metadata()).json();
      expect(body.planText.reason).toBe(reason);
      expect(JSON.stringify(f.publication.source)).toBe(before);
    } finally {f.close();}
  }
  const f=await textFixture606('record');
  try {
    const retained=f.session.retainedSourceV3(f.publication.publicationId);
    expect(projectRetainedPlanText({...retained,record:{...retained.record!,path:'record.json'}} as any)).toMatchObject({status:'unavailable',reason:'PLAN_TEXT_RECORD_UNSUPPORTED'});
    expect(projectRetainedPlanText({...retained,record:null} as any)).toMatchObject({status:'unavailable',reason:'PLAN_TEXT_RECORD_UNAVAILABLE'});
    expect(projectRetainedPlanText({...retained,source:{...retained.source,plan:null}} as any)).toBeUndefined();
    expect(jobPlanTextForSource(undefined,retained.source)).toBeUndefined();
    const {buildRecordSource,parseRecordPublishedContext,parseRecordSource}=await import('../src/job-api.ts');
    if (!isRetainedRecordSource(retained)) throw new Error('Expected record');
    const steps=[...retained.source.plan!.steps,...Array.from({length:4094},(_,i)=>({id:'extra-'+i,hash:'d'.repeat(64)}))];
    const context={...retained.context,plan:{steps}};
    expect(parseRecordPublishedContext(context,{kind:'plan'},retained.record).plan!.steps).toHaveLength(4096);
    const source=buildRecordSource({record:retained.record,selection:{kind:'plan'},context:context as any});
    expect(parseRecordSource(source).plan!.steps).toHaveLength(4096);
    const tooMany={...context,plan:{steps:[...steps,{id:'extra-over-limit',hash:'d'.repeat(64)}]}};
    expect(()=>parseRecordPublishedContext(tooMany,{kind:'plan'},retained.record)).toThrow();
    expect(()=>parseRecordSource({...source,plan:tooMany.plan})).toThrow();
    const raw=JSON.parse(await readFile(join(f.f.root,'project.json'),'utf8'));
    raw.plan.steps.reverse();
    const bytes=JSON.stringify(raw), record={path:'project.json' as const,sha256:jobHash(bytes)};
    await writeFile(join(f.f.root,'project.json'),bytes);
    const {captureJobRoot,prepareJobRecordSource}=await import('../src/job-source.ts');
    const contextReordered={...retained.context,files:retained.context.files.map(file=>file.path==='project.json'?record:file)};
    await expect(prepareJobRecordSource({root:captureJobRoot(f.f.root),stateRoot:join(f.f.scratch,'reordered-state'),fingerprint:'reordered',
      request:{freeze:{kind:'producer-held',holdId:'held',record},result:{kind:'plan'}},
      readRecordPublished:(() => structuredClone(contextReordered)) as any})).rejects.toMatchObject({code:'JOB_SOURCE_MISMATCH'});
  } finally {f.close();}
});


test('#606 closed metadata grammar rejects malformed value/issue entries while retaining valid empty fields',()=>{
  const good:any={schema:'rig-review/job-plan-text@1',record:{path:'project.json',sha256:'a'.repeat(64)},status:'projected',
    steps:[{id:'step',hash:'b'.repeat(64),does:'',produces:' ',bar:'\r\n',rests_on:[],issues:[]}]};
  expect(parseJobPlanTextProjection(good)).toEqual(good);
  for (const mutate of [
    (p:any)=>{p.unknown=true;},
    (p:any)=>{p.record.path='other.json';},
    (p:any)=>{p.steps[0].unknown=true;},
    (p:any)=>{p.steps[0].bar=null;},
    (p:any)=>{delete p.steps[0].bar;},
    (p:any)=>{p.steps[0].rests_on=['a',null];},
    (p:any)=>{p.steps[0].rests_on=Array(4097).fill('a');},
    (p:any)=>{delete p.steps[0].bar;p.steps[0].issues=[{field:'bar',reason:['absent']}];},
    (p:any)=>{delete p.steps[0].bar;p.steps[0].issues=[{field:'bar',reason:'absent',extra:true}];},
    (p:any)=>{p.steps.push(structuredClone(p.steps[0]));},
  ]) {const bad=structuredClone(good);mutate(bad);expect(()=>parseJobPlanTextProjection(bad)).toThrow('PLAN_TEXT_METADATA_INVALID');}
});

// #645 backend-only cases: actual source/session/front paths, without changes to shared harnesses.
import {job645SidecarFixture} from './helpers/645-sidecar-fixture.ts';
import {JOB_PARTS_VERDICT_ACT_SCHEMA} from '../src/job-contract.ts';
import {loadPartsView as load645Parts} from '../src/parts-view.ts';
import {candidate as candidate645} from './helpers/parts-comments-package.ts';
import {PNG as JobPNG645} from 'pngjs';

test('#645 generic sidecar closure retains official identity and serves retained Difference', async () => {
  const {f, dir, packet, parts, files} = await job645SidecarFixture();
  try {
    const publication = await f.publish(), retained = f.session.retainedSource(publication.publicationId);
    expect(publication.source.parts).toEqual(parts);
    expect(publication.source.parts!.images.every(image => image.role === 'part')).toBe(true);
    expect(Object.hasOwn(publication.source, 'paintingInRig')).toBe(false);
    for (const file of files) {
      expect(retained.seals).toContainEqual(file);
      expect(jobHash(await readFile(join(retained.snapshotRoot, file.path)))).toBe(file.sha256);
    }
    expect(await readFile(join(dir, 'parts.json'))).toEqual(packet.manifestBytes);
    const route = retainedPublicationRoutes(f.session);
    const read = (path: string, query = '') => route(f.session.jobId, publication.publicationId, publication.instanceKey,
      path, new Request(f.origin + '/' + path + query));
    const metadata = await (await read('api/stage-parts')).json();
    expect(metadata.differenceAvailable).toBe(true);
    expect(metadata.sourceHash).toBe(publication.source.sourceHash);
    const response = await read('api/stage-parts/difference/0', '?threshold=16&footprints=false');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Difference-Count')).not.toBeNull();
    expect(JobPNG645.sync.read(Buffer.from(await response.arrayBuffer())).width).toBe(20);
    expect((await read('api/stage-parts/difference/0', '?threshold=256&footprints=false')).status).toBe(409);
    expect((await read('api/stage-parts/difference/99', '?threshold=16&footprints=false')).status).toBe(409);
    const changed = Buffer.concat([packet.sidecarBytes, Buffer.from(' ')]);
    await writeFile(join(dir, 'painting_in_rig.json'), changed);
    f.setContext({...f.getContext(), files: files.map(file => file.path.endsWith('.json') ? {...file, sha256: jobHash(changed)} : file)});
    const next = await f.publish();
    expect(next.source.sourceHash).not.toBe(publication.source.sourceHash);
    expect(next.instanceKey).not.toBe(publication.instanceKey);
    expect(next.source.parts).toEqual(parts);
    // The old route reads its sealed snapshot, never the modified live JSON.
    expect((await read('api/stage-parts/difference/0', '?threshold=16&footprints=false')).status).toBe(200);
  } finally {await f.close();}
});

test('#645 sidecar admission requires both generic identities and refuses malformed manifest binding', async () => {
  const {f, dir, packet, files} = await job645SidecarFixture();
  try {
    for (const missing of files) {
      f.setContext({...f.getContext(), files: files.filter(file => file.path !== missing.path)});
      const result = await (await f.call(await f.publishRequest())).json();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('JOB_SOURCE_MISMATCH');
      expect(f.session.status().publication).toBeNull();
    }
    f.setContext({...f.getContext(), files});
    await writeFile(join(dir, 'painting_in_rig.json'), JSON.stringify({...packet.sidecar, manifest_sha256: '0'.repeat(64)}));
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.message).toContain('PARTS_DIFFERENCE_HASH');
    expect(f.session.status().generation).toBe(0);
  } finally {await f.close();}
});

test('#645 item and assembled Difference comments reach native crop and final act with composite source binding', async () => {
  const {f, dir, packet} = await job645SidecarFixture();
  try {
    const publication = await f.publish(), retained = f.session.retainedSource(publication.publicationId);
    const route = retainedPublicationRoutes(f.session), pkg = await load645Parts(join(retained.snapshotRoot, 'standalone'));
    const issue = candidate645(pkg), item = pkg.items[0]!;
    issue.sourceHash = publication.source.sourceHash;
    issue.parts = [{name: item.name, imageHash: pkg.files.find(file => file.abs === pkg.imagePaths[0])!.sha256}];
    issue.rigRegion = {...issue.imageRegion!, x: item.x + issue.imageRegion!.x, y: item.y + issue.imageRegion!.y};
    issue.view.comparison = {mode: 'difference', opacity: .5, threshold: 16};
    const request = new Request(f.origin + '/api/stage-parts/comment', {method: 'POST',
      headers: {Origin: f.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui}, body: JSON.stringify(issue)});
    const response = await route(f.session.jobId, publication.publicationId, publication.instanceKey, 'api/stage-parts/comment', request);
    expect(response.status).toBe(200);
    const {comment} = await response.json();
    expect(comment.sourceHash).toBe(publication.source.sourceHash);
    expect(comment.nativeCrop).not.toBeNull();
    expect(comment.parts).toEqual(issue.parts);
    const assembled = {...issue, id: '645-assembled', imageRegion: null, nativeCrop: null,
      rigRegion: {x: 4, y: 4, width: 20, height: 16},
      view: {...issue.view, mode: 'assembled'},
      parts: pkg.items.map(part => ({name: part.name, imageHash: pkg.files.find(file => file.abs === pkg.imagePaths[part.index])!.sha256}))};
    const assembledResponse = await route(f.session.jobId, publication.publicationId, publication.instanceKey,
      'api/stage-parts/comment', new Request(f.origin + '/api/stage-parts/comment', {method: 'POST',
        headers: {Origin: f.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui}, body: JSON.stringify(assembled)}));
    expect(assembledResponse.status).toBe(200);
    const assembledComment = (await assembledResponse.json()).comment;
    expect(assembledComment.sourceHash).toBe(publication.source.sourceHash);
    expect(assembledComment.nativeCrop).toBeNull();
    expect(assembledComment.crop).toMatchObject({sha256: issue.crop.sha256, width: issue.crop.width, height: issue.crop.height});
    expect(assembledComment.view).toEqual(assembled.view);
    const ask = await f.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-draft'}), page = await f.display(publication);
    const input = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
      submissionId: '645-difference', kind: 'parts-verdict', value: {verdict: 'changes-requested', issues: [comment, assembledComment], words: ''}};
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.value.source.sourceHash).toBe(publication.source.sourceHash);
    expect(saved.value.schema).toBe(JOB_PARTS_VERDICT_ACT_SCHEMA);
    if (saved.value.schema !== JOB_PARTS_VERDICT_ACT_SCHEMA) throw new Error('Expected current Parts act schema');
    expect(saved.value.value.issues[1]).toEqual(assembledComment);
    const replay = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(replay).toEqual(saved);
    await writeFile(join(dir, packet.sidecar.path), Buffer.from('changed'));
    await expect(f.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-draft'})).rejects.toThrow('JOB_SOURCE_MISMATCH');
    await writeFile(join(retained.snapshotRoot, 'standalone/painting_in_rig.json'), '{}');
    const tamper = await route(f.session.jobId, publication.publicationId, publication.instanceKey,
      'api/stage-parts/difference/0', new Request(f.origin + '/api/stage-parts/difference/0?threshold=16&footprints=false'));
    expect(tamper.status).toBe(409);
  } finally {await f.close();}
});

test('#645 generic PNG uses the existing decoded allocation bound before sidecar decoding', async () => {
  const {f, dir, packet, files} = await job645SidecarFixture();
  try {
    const png = Buffer.from(await readFile(join(dir, packet.sidecar.path)));
    png.writeUInt32BE(1_000_000, 16);
    await writeFile(join(dir, packet.sidecar.path), png);
    const sidecarBytes = Buffer.from(JSON.stringify({...packet.sidecar, sha256: jobHash(png)}));
    await writeFile(join(dir, 'painting_in_rig.json'), sidecarBytes);
    f.setContext({...f.getContext(), files: files.map(file => ({...file,
      sha256: file.path.endsWith('.json') ? jobHash(sidecarBytes) : jobHash(png)}))});
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.code).toBe('JOB_SOURCE_UNRETAINABLE');
    expect(result.error.message).toContain('PARTS_REFERENCE_LIMIT');
    expect(f.session.status().publication).toBeNull();
  } finally {await f.close();}
});
