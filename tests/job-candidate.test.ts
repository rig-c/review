import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobHash, parseCommentOnlyAct, parseJobRequest, parseJobRequestV3, parseJobSelector } from '../src/job-api.ts';
import { loadReview } from '../src/manifest.ts';
import { jobFixture } from './helpers/job-api-fixture.ts';

type Fixture = Awaited<ReturnType<typeof jobFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

type Mutation = 'receipt SHA' | 'receipt identity' | 'descriptor SHA' | 'descriptor path' |
  'report/model' | 'unkeyed with report' | 'keyed duration' | 'unkeyed duration' | 'unkeyed loop';
const alternate = 'f'.repeat(64);

test('#1341 candidate selector validates closed receipt and identity fields', () => {
  const receipt = {path: 'candidate-receipt.json', sha256: alternate};
  const selector = {kind: 'candidate', receipt, setSha256: alternate, askId: 'composition', optionId: 'wide'} as const;
  expect(parseJobSelector(selector)).toEqual(selector);
  for (const invalid of [
    {...selector, output: 'direction'},
    {...selector, receipt: {...receipt, path: '../receipt.json'}},
    {...selector, receipt: {...receipt, version: 1}},
    {...selector, setSha256: alternate.toUpperCase()},
    {...selector, optionId: 'wide view'},
  ]) expect(() => parseJobSelector(invalid)).toThrow('JOB_REQUEST_INVALID');
});

async function candidate(camera: 'keyed' | 'unkeyed', mutation?: Mutation) {
  const f = await jobFixture({plain: true, packageAtRoot: true});
  fixtures.push(f);
  const root = f.root;
  async function seal(path: string, value: unknown) {
    const bytes = JSON.stringify(value) + '\n';
    await writeFile(join(root, path), bytes);
    return {path, sha256: jobHash(bytes)};
  }
  const manifest = JSON.parse(await readFile(join(root, 'review.json'), 'utf8'));
  const packed = JSON.parse(await readFile(join(root, manifest.model), 'utf8'));
  const idle = packed.animations.find((clip: {name: string}) => clip.name === 'inspect');
  idle.name = 'idle';
  packed.editorOrder.animations[packed.editorOrder.animations.indexOf('inspect')] = 'idle';
  const model = await seal(manifest.model, packed);
  const {width, height} = packed.stage;
  const sceneReport = camera === 'keyed' || mutation === 'unkeyed with report'
    ? await seal('candidate-scene.json', {
      spec: 'spine-parts-scene-report/2', canvas: {width, height},
      camera: {backdrop: 'synthetic', fps: 12,
        // Every report pointer is sealed below. Only the report's packed-model binding differs.
        model_sha256: mutation === 'report/model' ? jobHash(JSON.stringify(packed)) : model.sha256,
        coverage: {status: 'PASS', max_edge_overrun_px: 0, nonopaque_source_texels: 0, nonopaque_output_pixels: 0},
        tracks: {idle: {duration: 0.75, compiled_duration: 1, loop: true,
          keys: [{t: 0, pan: [0, 0], zoom: 1}, {t: 0.75, pan: [0, 0], zoom: 1}], frames: []}},
      },
    }) : null;
  const take = await seal('candidate-take.json', {
    schema: 'rig-create/candidate-take@1', clip: 'idle', model, sceneReport,
    duration: camera === 'keyed' ? mutation === 'keyed duration' ? 0.5 : 0.75 : mutation === 'unkeyed duration' ? 2 : 1,
    loop: mutation !== 'unkeyed loop',
  });
  const identity = {setSha256: 'a'.repeat(64), askId: 'framing', optionId: 'wide'};
  const receipt = await seal('candidate-receipt.json', {
    schema: 'rig-create/candidate-preview@1', ...identity, camera, model, sceneReport,
    ...(mutation === 'receipt identity' ? {optionId: 'other'} : {}),
    take: mutation === 'descriptor SHA' ? {...take, sha256: alternate} :
      mutation === 'descriptor path' ? {...take, path: 'another-take.json'} : take,
  });
  const selector = {kind: 'candidate' as const, ...identity,
    receipt: mutation === 'receipt SHA' ? {...receipt, sha256: alternate} : receipt};
  const manifestPath = join(root, 'review.json');
  await seal('review.json', {
    schema: manifest.schema, id: manifest.id, revision: manifest.revision,
    title: 'Wide option', model: model.path, direction: take.path,
    ...(sceneReport ? {sceneReport} : {}),
  });
  const request = {
    ...f.base(), verb: 'publish' as const, expectedGeneration: 0, idempotencyKey: 'candidate-publish',
    result: {path: 'review.json', selector},
    freeze: {kind: 'producer-held' as const, holdId: 'held', record: null},
  };
  return {f, manifestPath, request, receipt, take, model, sceneReport};
}

test.each([
  ['receipt SHA', 'keyed', 'JOB_CANDIDATE_RECEIPT_MISMATCH'],
  ['receipt identity', 'keyed', 'JOB_CANDIDATE_RECEIPT_MISMATCH'],
  ['descriptor SHA', 'keyed', 'JOB_CANDIDATE_TAKE_SEAL_MISMATCH'],
  ['descriptor path', 'keyed', 'JOB_CANDIDATE_TAKE_SEAL_MISMATCH'],
  ['report/model', 'keyed', 'SCENE_CAMERA_MODEL_MISMATCH'],
  ['unkeyed with report', 'unkeyed', 'SCENE_SOURCE_MISMATCH'],
  ['keyed duration', 'keyed', 'DIRECTION_TAKE_MISMATCH'],
  ['unkeyed duration', 'unkeyed', 'DIRECTION_TAKE_MISMATCH'],
  ['unkeyed loop', 'unkeyed', 'DIRECTION_TAKE_MISMATCH'],
] as const)('#1341 refuses planted %s before exposing a publication', async (mutation, camera, code) => {
  const {f, request} = await candidate(camera, mutation);
  expect(await (await f.call(request)).json()).toMatchObject({ok: false, generation: 0, error: {code}});
  expect(f.session.status().publication).toBeNull();
});

test.each(['keyed', 'unkeyed'] as const)('#1341 %s candidate is source-bound through publication and comment replay', async camera => {
  const {f, manifestPath, request, receipt, take, model, sceneReport} = await candidate(camera);
  await expect(loadReview(manifestPath)).rejects.toThrow('DIRECTION_SCHEMA');
  expect(parseJobRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  const v3 = {...request, schema: 'rig-review/job-api@3', result: {kind: 'package', ...request.result}} as const;
  expect(parseJobRequestV3(JSON.parse(JSON.stringify(v3)))).toEqual(v3);

  const published = await (await f.call(request)).json();
  expect(published).toMatchObject({ok: true, value: {label: 'Wide option', source: {selector: request.result.selector}}});
  const publication = published.value;
  const retained = f.session.retainedSource(publication.publicationId);
  for (const file of [receipt, take, model, sceneReport]) {
    if (file) expect(retained.seals).toContainEqual(file);
  }
  const page = await f.display(publication);
  const submit = (id: string) => f.ports.commitUIAct(f.session.jobId, f.uiRequest({
    ...page, expectedGeneration: f.session.status().generation,
    submissionId: id, kind: 'comments', value: {comments: [{text: 'A candidate comment'}]},
  }));
  const saved = await submit('candidate-comment');
  expect(saved).toMatchObject({ok: true, value: {
    schema: 'rig-review/act@10', jobId: f.session.jobId, publicationId: publication.publicationId,
    source: publication.source, value: {comments: [{text: 'A candidate comment'}]},
  }});
  if (!saved.ok) throw new Error(saved.error.code);
  if (saved.value.schema !== 'rig-review/act@10' || 'record' in saved.value.source)
    throw new Error('Expected a package comment-only act');
  expect(parseCommentOnlyAct(JSON.parse(JSON.stringify(saved.value)))).toEqual(saved.value);
  const legacySource = {...saved.value.source, selector: {kind: 'current', output: 'direction', record: alternate} as const};
  const legacyAct = {...saved.value, source: legacySource};
  expect(parseCommentOnlyAct(JSON.parse(JSON.stringify(legacyAct)))).toEqual(legacyAct);
  const current = {...request, result: {...request.result, selector: legacySource.selector}};
  expect(parseJobRequest(JSON.parse(JSON.stringify(current)))).toEqual(current);

  await writeFile(join(f.root, receipt.path), '{}');
  expect(await submit('stale-candidate-comment')).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
});
