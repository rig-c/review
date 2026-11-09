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
