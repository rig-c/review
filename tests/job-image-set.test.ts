import {afterEach, expect, test} from 'bun:test';
import {readFile, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertJobImageSetCapability, type JobImageSetInput, type JobImageReviewValue} from '../src/job-host.ts';
import {jobHash} from '../src/job-api.ts';
import {prepareJobImageSet} from '../src/job-image-set.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {parseJobSubject as oldParseJobSubject} from './fixtures/job-image-set/old-subject-parser.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {for (const fixture of fixtures.splice(0)) await fixture.close();});
async function fixture(imageCount = 2) {
  const f = await jobFixture(); fixtures.push(f);
  const bytes = await readFile(join(f.root, 'out/rigid.png'));
  const images: JobImageSetInput['images'][number][] = [];
  for (let index = 0; index < imageCount; index++) {
    const path = `image-${index}.png`;
    await writeFile(join(f.root, path), bytes);
    images.push({role: index ? 'candidate' : 'source', name: `Image ${index}`, path, sha256: jobHash(bytes)});
  }
  await writeFile(join(f.root, 'out/review.json'), JSON.stringify({schema: 'rig-review/1',
    id: 'image-set-fixture', title: 'Synthetic image set', revision: 'one', references: []}));
  f.setContext({selector: null, plan: null, parts: null, subjects: [], partIds: [], files: [],
    imageSet: {purpose: 'plate-adoption', images}});
  return f;
}
async function submission(f: Awaited<ReturnType<typeof fixture>>) {
  const discovery = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  assertJobImageSetCapability(discovery.value.capabilities);
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'review-verdict', stage: 'image-review'});
  const page = await f.display(publication);
  const value: JobImageReviewValue = {stage: 'image-review', verdict: 'approved', words: '  exact human words  '};
  return {publication, ask, input: {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'image-verdict', kind: 'review-verdict', value}};
}

test('522 two-image model-free ask and human verdict roundtrip preserve source, digest, duplicates and optional notes', async () => {
  const f = await fixture(), {publication, ask, input} = await submission(f);
  const source = publication.source;
  expect(source.subject).toBe('image-set');
  expect(Object.hasOwn(source, 'model')).toBe(false);
  expect(Object.hasOwn(source, 'selector')).toBe(false);
  if (source.subject !== 'image-set') throw new Error('Expected image source');
  expect(ask.source).toEqual(source);
  const rows = source.imageSet.images.map(({role, name, sha256}) => ({role, name, sha256}));
  expect(source.imageSetDigest).toBe(jobHash(Buffer.from(JSON.stringify(rows), 'utf8')));
  expect(source.duplicateHashes).toEqual([{names: ['Image 0', 'Image 1'], sha256: rows[0].sha256}]);
  const payload = {...input, value: {...input.value, imageNotes: [{name: 'Image 1', words: '  image note  '}]}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.source).toEqual(source);
  expect(saved.value.value).toEqual(payload.value);
  expect(saved.value.authority).toEqual({actor: 'human', channel: 'review-ui', reviewer: {id: 'declared-owner', role: 'owner'}});
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload))).toEqual(saved);
  const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId},
    f.session.writerGrant().fetchCapability)).json();
  expect(fetched.value).toEqual(saved.value);
  const next = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  expect(next.value.events.find((event: {type: string}) => event.type === 'act').act).toEqual(saved.value);
});

test('522 eight images are accepted in producer order, absent notes stay absent', async () => {
  const f = await fixture(8), {publication, input} = await submission(f);
  expect(publication.source.imageSet?.images.map(image => image.name)).toEqual(Array.from({length: 8}, (_, i) => `Image ${i}`));
  const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(result.ok).toBe(true);
  if (result.ok) expect(Object.hasOwn(result.value.value, 'imageNotes')).toBe(false);
});

test('522 absent capability refuses locally and the frozen old parser refuses the image stage by name', () => {
  for (const capabilities of [undefined, null, {}, {imageSetVerdict: false}]) {
    expect(() => assertJobImageSetCapability(capabilities)).toThrow('JOB_IMAGE_SET_UNSUPPORTED');
  }
  expect(() => assertJobImageSetCapability({imageSetVerdict: true})).not.toThrow();
  expect(() => oldParseJobSubject({kind: 'review-verdict', stage: 'image-review'})).toThrow('JOB_ASK_INVALID');
  expect(oldParseJobSubject({kind: 'review-verdict', stage: 'rig-review'})).toEqual({kind: 'review-verdict', stage: 'rig-review'});
});

test('522 neither model nor images refuses ask without changing generation', async () => {
  const f = await fixture(), context = {...f.getContext()};
  delete context.imageSet; f.setContext(context);
  const publication = await f.publish(), before = f.session.status();
  for (const stage of ['image-review', 'rig-review']) {
    const result = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: before.generation,
      idempotencyKey: stage, publicationId: publication.publicationId, subject: {kind: 'review-verdict', stage}})).json();
    expect(result.error.code).toBe('JOB_ASK_INVALID');
    expect(f.session.status()).toEqual(before);
  }
});

test('522 shape, purpose, counts, duplicate names/paths and closed role rules refuse publication atomically', async () => {
  const f = await fixture(), original = f.getContext(), imageSet = original.imageSet!;
  const images = imageSet.images;
  const cases: [unknown, string][] = [
    [{...imageSet, images: images.slice(0, 1)}, 'JOB_IMAGE_SET_INVALID'],
    [{...imageSet, images: Array(9).fill(images[0])}, 'JOB_IMAGE_SET_INVALID'],
    [{...imageSet, purpose: 'unknown'}, 'JOB_IMAGE_SET_INVALID'],
    [{...imageSet, images: [images[0], {...images[1], name: images[0].name}]}, 'JOB_IMAGE_SET_DUPLICATE_NAME'],
    [{...imageSet, images: [images[0], {...images[1], path: images[0].path}]}, 'JOB_IMAGE_SET_DUPLICATE_PATH'],
    [{...imageSet, images: images.map(image => ({...image, role: 'candidate'}))}, 'JOB_IMAGE_SET_ROLE_INVALID'],
    [{...imageSet, images: images.map(image => ({...image, role: 'source'}))}, 'JOB_IMAGE_SET_ROLE_INVALID'],
    [{...imageSet, images: [images[0], {...images[1], role: 'unknown'}]}, 'JOB_IMAGE_SET_ROLE_INVALID'],
    [{...imageSet, images: [images[0], {...images[1], sha256: '0'.repeat(64)}]}, 'JOB_SOURCE_MISMATCH'],
  ];
  for (const [claim, code] of cases) {
    f.setContext({...original, imageSet: claim as JobImageSetInput});
    const before = f.session.status();
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.code).toBe(code);
    expect(f.session.status()).toEqual(before);
  }
});

test('522 literal containment rejects traversal, absolute and symlink leaf/parent paths', async () => {
  const f = await fixture(), original = f.getContext();
  await symlink(join(f.root, 'image-1.png'), join(f.root, 'leaf.png'));
  await symlink(f.root, join(f.root, 'parent'));
  for (const path of ['../image-1.png', '/tmp/image.png', 'parent/image-1.png', 'leaf.png', 'a%2fb.png']) {
    f.setContext({...original, imageSet: {...original.imageSet!, images: [original.imageSet!.images[0],
      {...original.imageSet!.images[1], path}]}});
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.code).toBe('JOB_IMAGE_SET_PATH_REFUSED');
  }
});

for (const phase of ['ask', 'finalize']) {
  test(`522 changed disk bytes refuse at ${phase}`, async () => {
    const f = await fixture(), {publication, input} = await submission(f);
    await writeFile(join(f.root, 'image-1.png'), 'changed bytes');
    const before = f.session.status();
    const result = phase === 'ask'
      ? await (await f.call({...f.base(), verb: 'ask', expectedGeneration: before.generation, idempotencyKey: 'changed',
          publicationId: publication.publicationId, subject: {kind: 'review-verdict', stage: 'image-review'}})).json()
      : await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(result.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(f.session.status()).toEqual(before);
  });
}

test('522 notes reject extra fields, duplicate/nonmember names and browser-supplied digest', async () => {
  const f = await fixture(), {input} = await submission(f);
  for (const value of [
    {...input.value, imageNotes: [{name: 'unknown', words: ''}]},
    {...input.value, imageNotes: [{name: 'Image 0', words: ''}, {name: 'Image 0', words: ''}]},
    {...input.value, imageNotes: [{name: 'Image 0', words: '', unknown: true}]},
    {...input.value, imageSetDigest: '0'.repeat(64)},
  ]) {
    const before = f.session.status();
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, value}));
    expect(result.ok).toBe(false); expect(f.session.status()).toEqual(before);
  }
});

test('522 canonical JSON keeps Unicode exact, excludes paths and preserves row order', () => {
  const input: JobImageSetInput = {purpose: 'plate-adoption', images: [
    {role: 'source', name: 'e\u0301', path: 'a.png'}, {role: 'candidate', name: 'é', path: 'b.png'}]};
  const bound = prepareJobImageSet(input, () => Buffer.from('same'));
  const sha256 = jobHash('same');
  expect(bound.imageSetDigest).toBe(jobHash(JSON.stringify([
    {role: 'source', name: 'e\u0301', sha256}, {role: 'candidate', name: 'é', sha256}])));
  expect(prepareJobImageSet({...input, images: input.images.map((image, i) => ({...image, path: `${i}.png`}))},
    () => Buffer.from('same')).imageSetDigest).toBe(bound.imageSetDigest);
  expect(prepareJobImageSet({...input, images: [...input.images].reverse()}, () => Buffer.from('same')).imageSetDigest)
    .not.toBe(bound.imageSetDigest);
});

test('522 original model publication, ask, act source and value serialize byte-identically to pre-edit output', async () => {
  const f = await jobFixture(); fixtures.push(f);
  const publication = await f.publish(), ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const page = await f.display(publication);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'model-byte-control', kind: 'review-verdict',
    value: {stage: 'rig-review', verdict: 'approved', words: 'exact verdict'},
    capture: rigStillCapture(publication, ask, page).capture}));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const actual = JSON.stringify({publicationSource: publication.source, askSource: ask.source,
    source: saved.value.source, value: saved.value.value});
  const before = await readFile(new URL('./fixtures/job-image-set/model-branch.json', import.meta.url), 'utf8');
  expect(actual).toBe(before);
});
