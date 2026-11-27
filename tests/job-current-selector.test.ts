/** #1267 part A: server and contract coverage for the `current` selector. */
import {afterEach, expect, test} from 'bun:test';
import {cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {canonicalJson} from '../src/canonical-json.ts';
import * as api from '../src/job-api.ts';
import * as host from '../src/job-host.ts';
import {
  JOB_API_V3_SCHEMA,
  JOB_COMMENT_ONLY_ACT_SCHEMA,
  JOB_ERROR_CODES,
  JOB_PREVIOUS_DRAFT_SCHEMA,
  type JobMeshEditValue,
  type JobPublication,
  type JobPublishRequest,
  type JobSelector,
} from '../src/job-contract.ts';
import {retainedPublicationRoutes} from '../src/job-front.ts';
import {JobSession} from '../src/job-session.ts';
import {attachmentHashText} from '../src/mesh-edit.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {directionRows, directionSummary} from '../web/direction-panel.ts';
import {t} from '../web/i18n.ts';
import {createJobRigScreen, jobRigScreenRefusal, jobRigScreenRoute, jobRigScreenSubject} from '../web/job-rig-screen.ts';
import {jobPublicationRoutes, jobSourceDraftId} from '../web/job-session.ts';
import type {DisplayPublicationV3, SourceV3} from '../src/job-contract.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import model from './fixtures/viewport-387/package/skeleton.model.json';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function createCurrentFixture() {
  const f = await jobFixture();
  fixtures.push(f);
  const projectText = '{"schema":"rig-create/project@0","interview":{}}\n';
  await writeFile(join(f.root, 'project.json'), projectText);
  f.setRecordPath('project.json');
  const recordHash = api.jobHash(projectText);
  return {f, recordHash};
}

const createFixtureDir = 'tests/fixtures/create-example-current';
const createDirectionSha = '590bcbcba19148cd0bb90fe66a8a7c9d3a3017e76fd4d8f1075499d5e1133259';
const createModelSha = '69c07b3493f2eff0cba41870b39ed147214590fb4c69740cda55c33c8febfb5c';
const createAtlasSha = '528f05d78f47751321efa1281fdc74dc9f8248891561ac8be196d918b66cdd3e';
const createPngSha = '3cbaab9dc4c5dac0dcd5163221070ef7d17e52a905a0bc977bbddf32b3dec776';

/** Synthetic direction@1 for numbered `post` controls and `@1-refused-on-current` checks only; never used as a `current` fixture. */
function numberedDirectionV1Document(modelSha: string) {
  return {
    schema: 'rig-create/direction@1',
    rig: {version: 1, model: {path: 'skeleton.model.json', sha256: modelSha}},
    take: {duration: 1, loop: true},
    camera: {space: 'rig-world-y-up', keys: [{time: 0, easing: 'hold', box: {x: 0, y: 0, width: 80, height: 64}}]},
    timing: {keys: [{time: 0, source_time: 0, easing: 'linear'}, {time: 1, source_time: 1, easing: 'linear'}]},
  };
}

async function preparePartsOnlyPackage(f: Awaited<ReturnType<typeof jobFixture>>) {
  const parts = await syntheticJobParts(f);
  await unlink(join(f.root, 'out/skeleton.model.json'));
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.model;
  manifest.animations = [];
  manifest.checkpoints = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return parts;
}

async function prepareDirectionPackage(f: Awaited<ReturnType<typeof jobFixture>>, directionRelPath = 'direction.json') {
  const pkgRoot = join(f.root, 'out');
  for (const name of ['skeleton.model.json', 'skeleton.atlas', 'skeleton.png']) {
    await cp(join(createFixtureDir, name), join(pkgRoot, name));
  }
  const fullDirection = join(pkgRoot, directionRelPath);
  await mkdir(dirname(fullDirection), {recursive: true});
  await cp(join(createFixtureDir, 'direction.json'), fullDirection);
  const manifestPath = join(pkgRoot, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.model = 'skeleton.model.json';
  manifest.direction = directionRelPath;
  manifest.references = [];
  manifest.authoring = [];
  manifest.animations = [{id: 'idle', label: 'Idle', duration: 4}];
  manifest.checkpoints = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('Bar A (#1267 §5a): current rig accepts comments across project.json rewrites and refuses JOB_ACT_SOURCE_STALE when model changes', async () => {
  const {f, recordHash} = await createCurrentFixture();
  const selector: JobSelector = {kind: 'current', output: 'rig', record: recordHash};
  f.setContext({selector, plan: null, parts: null, subjects: [], partIds: [], files: []});

  // 1. Publish {current, rig, record}.
  const publication = await f.publish();
  const page = await f.display(publication);
  const submit = (text: string, submissionId: string) =>
    f.ports.commitUIAct(f.session.jobId, f.uiRequest({
      ...page,
      expectedGeneration: f.session.status().generation,
      submissionId,
      kind: 'comments',
      value: {comments: [{text}]},
    }));

  // 2. Send act@10 comment 1; it is accepted.
  const first = await submit('comment one', 'bar-a-1');
  expect(first).toMatchObject({ok: true, value: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, publicationId: publication.publicationId}});

  // 3. Rewrite project.json on disk.
  await writeFile(join(f.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{},"step":"advanced"}\n');

  // 4. Send comment 2 from the same page; it is accepted.
  const second = await submit('comment two after project rewrite', 'bar-a-2');
  expect(second).toMatchObject({ok: true, value: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, publicationId: publication.publicationId}});
  if (second.ok) {
    expect(second.value.source).toEqual(publication.source);
    expect(second.value.source.projectHash).toBe(recordHash);
  }

  // 5. Change the model file on disk.
  const modelPath = join(f.root, 'out/skeleton.model.json');
  const mutatedModel = JSON.parse(await readFile(modelPath, 'utf8'));
  mutatedModel.bones[0].x = (mutatedModel.bones[0].x ?? 0) + 5;
  await writeFile(modelPath, JSON.stringify(mutatedModel));

  // 6. Send comment 3; it is refused JOB_ACT_SOURCE_STALE.
  const third = await submit('comment three after model mutation', 'bar-a-3');
  expect(third).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
});

test('Bar B (#1267 §5a control): numbered {rig, version} publication with project.json rewritten after publish still refuses JOB_RECORD_MOVED', async () => {
  const {f} = await createCurrentFixture();
  f.setContext({selector: {kind: 'rig', version: 1}, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const publication = await f.publish();
  const page = await f.display(publication);

  await writeFile(join(f.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{},"moved":true}\n');
  const refused = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({
    ...page,
    expectedGeneration: f.session.status().generation,
    submissionId: 'bar-b-1',
    kind: 'comments',
    value: {comments: [{text: 'numbered comment after record move'}]},
  }));
  expect(refused).toMatchObject({ok: false, error: {code: 'JOB_RECORD_MOVED'}});
});

test('Bar C (#1267 §1): parseJobSelector accepts exact current shapes and refuses bad shapes with JOB_REQUEST_INVALID', () => {
  const record = '0123456789abcdef'.repeat(4);
  expect(api.parseJobSelector(null)).toBeNull();
  for (const output of ['parts', 'rig', 'direction'] as const) {
    const good = {kind: 'current' as const, output, record};
    expect(api.parseJobSelector(good)).toEqual(good);
  }
  for (const bad of [
    {kind: 'current'},
    {kind: 'current', output: 'rig'},
    {kind: 'current', record},
    {kind: 'current', output: 'scene', record},
    {kind: 'current', output: 'post', record},
    {kind: 'current', output: '', record},
    {kind: 'current', output: 1, record},
    {kind: 'current', output: 'rig', record: record.toUpperCase()},
    {kind: 'current', output: 'rig', record: record.slice(1)},
    {kind: 'current', output: 'rig', record: record + '0'},
    {kind: 'current', output: 'rig', record: 'g'.repeat(64)},
    {kind: 'current', output: 'rig', record: null},
    {kind: 'current', output: 'rig', record, version: 1},
    {kind: 'current', output: 'parts', record, id: 'draft-1'},
    {kind: 'current', output: 'direction', record, rigVersion: 1},
    {kind: 'current', output: 'rig', record, extra: true},
  ]) {
    expect(() => api.parseJobSelector(bad)).toThrow('JOB_REQUEST_INVALID');
  }
});

test('Bar D (#1267 §2): publish checks refuse missing project record with JOB_CURRENT_RECORD_MISSING and mismatched sha with JOB_CURRENT_RECORD_MISMATCH', async () => {
  const {f, recordHash} = await createCurrentFixture();
  const selector: JobSelector = {kind: 'current', output: 'rig', record: recordHash};
  f.setContext({selector, plan: null, parts: null, subjects: [], partIds: [], files: []});

  const baseReq = await f.publishRequest('bar-d-base') as JobPublishRequest;
  const nullRecordRes = await f.call({...baseReq, idempotencyKey: 'bar-d-null', freeze: {...baseReq.freeze, record: null}});
  expect(nullRecordRes.status).toBe(409);
  expect(await nullRecordRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_RECORD_MISSING'}});

  const nonProjectRecordRes = await f.call({
    ...baseReq,
    idempotencyKey: 'bar-d-other-record',
    freeze: {...baseReq.freeze, record: {path: 'record.json', sha256: api.jobHash(await readFile(join(f.root, 'record.json')))}},
  });
  expect(nonProjectRecordRes.status).toBe(409);
  expect(await nonProjectRecordRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_RECORD_MISSING'}});

  const otherSha = 'f'.repeat(64);
  const wrongSelector: JobSelector = {kind: 'current', output: 'rig', record: otherSha};
  f.setContext({selector: wrongSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const mismatchRes = await f.call({
    ...baseReq,
    idempotencyKey: 'bar-d-mismatch',
    result: {path: 'out', selector: wrongSelector},
  });
  expect(mismatchRes.status).toBe(409);
  expect(await mismatchRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_RECORD_MISMATCH'}});
  expect(f.session.status().generation).toBe(0);
});

test('Bar E (#1267 §3, §8): output checks refuse JOB_CURRENT_OUTPUT_MISMATCH, plan and numbered-only declarations refuse JOB_SOURCE_MISMATCH, and catalog entries match', async () => {
  for (const code of ['JOB_CURRENT_RECORD_MISSING', 'JOB_CURRENT_RECORD_MISMATCH', 'JOB_CURRENT_OUTPUT_MISMATCH'] as const) {
    expect(JOB_ERROR_CODES).toContain(code);
    expect(enCatalog[code]).toBe(code);
    expect(koCatalog[code]).toBe(code);
    expect(enCatalog[`job.refusal.${code}`]).toContain('The producer must publish');
    expect(koCatalog[`job.refusal.${code}`]).toContain('제작 도구에서');
  }

  // 1) rig without direction vs rig with direction; direction without direction
  {
    const {f, recordHash} = await createCurrentFixture();
    const rigSelector: JobSelector = {kind: 'current', output: 'rig', record: recordHash};
    const dirSelector: JobSelector = {kind: 'current', output: 'direction', record: recordHash};
    const partsSelector: JobSelector = {kind: 'current', output: 'parts', record: recordHash};

    // parts without parts -> JOB_CURRENT_OUTPUT_MISMATCH
    f.setContext({selector: partsSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
    const partsMissingRes = await f.call(await f.publishRequest('bar-e-parts-missing'));
    expect(partsMissingRes.status).toBe(409);
    expect(await partsMissingRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_OUTPUT_MISMATCH'}});

    // direction without direction file -> JOB_CURRENT_OUTPUT_MISMATCH
    f.setContext({selector: dirSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
    const dirMissingRes = await f.call(await f.publishRequest('bar-e-dir-missing'));
    expect(dirMissingRes.status).toBe(409);
    expect(await dirMissingRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_OUTPUT_MISMATCH'}});

    // Non-null plan and numbered-only declarations on current -> JOB_SOURCE_MISMATCH
    const badContexts: Record<string, unknown>[] = [
      {plan: {steps: [{id: 'step-1', hash: '1'.repeat(64)}]}},
      {previousDraft: {schema: JOB_PREVIOUS_DRAFT_SCHEMA, draft: {id: 'd1', revision: '2'.repeat(64)},
        composites: {current: {path: 'a.png', sha256: '3'.repeat(64)}, previous: {path: 'b.png', sha256: '4'.repeat(64)}}}},
      {previousBuild: {schema: 'rig-review-previous-build/1', label: 'v1', currentLabel: 'v2',
        model: {path: 'skeleton.model.json', sha256: '1'.repeat(64)}, atlas: {path: 'skeleton.atlas', sha256: '2'.repeat(64)},
        pages: [], clipMap: {}}},
      {answeredDirectionFeedback: []},
      {chestLandmarks: []},
      {checkpointEvidence: []},
    ];
    for (const [idx, extra] of badContexts.entries()) {
      f.setContext({selector: rigSelector, plan: null, parts: null, subjects: [], partIds: [], files: [], ...extra} as never);
      const res = await f.call(await f.publishRequest(`bar-e-decl-${idx}`));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
    }

    // Add a direction file: rig with a direction file -> JOB_CURRENT_OUTPUT_MISMATCH
    await prepareDirectionPackage(f);
    f.setContext({selector: rigSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
    const rigWithDirRes = await f.call(await f.publishRequest('bar-e-rig-with-dir'));
    expect(rigWithDirRes.status).toBe(409);
    expect(await rigWithDirRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_OUTPUT_MISMATCH'}});

    // Direction with Create direction@4 fixture -> accepted as composed build, no postVersion or rigVersion
    f.setContext({selector: dirSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
    const dirPub = await f.publish();
    const routes = retainedPublicationRoutes(f.session);
    const metaRes = await routes(f.session.jobId, dirPub.publicationId, dirPub.instanceKey, 'api/review', new Request(f.origin + '/api/review'));
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json() as {direction?: Record<string, unknown>; capabilities: {preRig: boolean}};
    expect(meta.direction).toBeDefined();
    expect('postVersion' in (meta.direction ?? {})).toBe(false);
    expect('rigVersion' in (meta.direction ?? {})).toBe(false);
    expect(meta.direction).toEqual({
      file: {path: 'direction.json', sha256: createDirectionSha},
      model: {path: 'skeleton.model.json', sha256: createModelSha},
      composed: true,
      camera: {space: 'rig-world-y-up', keys: []},
      take: {duration: 4, loop: true},
      timing: [],
    });
    expect(meta.capabilities.preRig).toBe(false);
  }

  // 2) parts with a model -> JOB_CURRENT_OUTPUT_MISMATCH; parts without model + empty partIds -> JOB_CURRENT_OUTPUT_MISMATCH; valid parts -> preRig: true
  {
    const {f, recordHash} = await createCurrentFixture();
    const partsSelector: JobSelector = {kind: 'current', output: 'parts', record: recordHash};
    const partsWithModel = await syntheticJobParts(f);
    f.setContext({selector: partsSelector, plan: null, parts: partsWithModel, subjects: [], partIds: ['base'], files: []});
    const withModelRes = await f.call(await f.publishRequest('bar-e-parts-with-model'));
    expect(withModelRes.status).toBe(409);
    expect(await withModelRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_OUTPUT_MISMATCH'}});

    await unlink(join(f.root, 'out/skeleton.model.json'));
    const manifestPath = join(f.root, 'out/review.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.model;
    manifest.animations = [];
    manifest.checkpoints = [];
    await writeFile(manifestPath, JSON.stringify(manifest));

    f.setContext({selector: partsSelector, plan: null, parts: partsWithModel, subjects: [], partIds: [], files: []});
    const emptyPartIdsRes = await f.call(await f.publishRequest('bar-e-parts-empty-ids'));
    expect(emptyPartIdsRes.status).toBe(409);
    expect(await emptyPartIdsRes.json()).toMatchObject({ok: false, error: {code: 'JOB_CURRENT_OUTPUT_MISMATCH'}});

    // Valid parts with real parts.json for retainedPublicationRoutes preRig check
    await writeFile(join(f.root, 'out/parts.json'), JSON.stringify({
      rig_size: [80, 64],
      scale_rig_per_source: 1,
      parts: [{name: 'base', from: 'full:base', x: 0, y: 0, w: 16, h: 16}],
    }));
    const validParts = {
      enumeratorVersion: f.partsEnumerator.version,
      manifest: {path: 'out/parts.json', sha256: api.jobHash(await readFile(join(f.root, 'out/parts.json')))},
      images: [{path: 'parts/base.png', role: 'part', sha256: api.jobHash(await readFile(join(f.root, 'out/parts/base.png')))}],
    };
    f.setPartsReferences([{path: 'parts/base.png', role: 'part'}]);
    f.setContext({selector: partsSelector, plan: null, parts: validParts, subjects: [], partIds: ['base'], files: []});
    const partsPub = await f.publish();
    const routes = retainedPublicationRoutes(f.session);
    const metaRes = await routes(f.session.jobId, partsPub.publicationId, partsPub.instanceKey, 'api/review', new Request(f.origin + '/api/review'));
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json() as {capabilities: {preRig: boolean; playback: boolean}};
    expect(meta.capabilities.preRig).toBe(true);
    expect(meta.capabilities.playback).toBe(false);
  }
});

test('Bar F (#1267 §4): every ask and ask-batch subject on a current publication refuses JOB_ASK_INVALID', async () => {
  // Check on current rig, current direction, and current parts (including V3 ask-batch)
  const {f, recordHash} = await createCurrentFixture();
  const stateV3 = await mkdtemp(join(realpathSync(tmpdir()), 'review-1267-v3-'));
  let context = f.getContext();
  const sessionV3 = new JobSession({
    root: f.root,
    stateDir: stateV3,
    fingerprint: 'c'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'},
    publicationMode: 'record-and-package',
    readPublished: async () => structuredClone(context),
    partsEnumerator: f.partsEnumerator,
  });
  const portsV3 = api.createJobHostPorts(sessionV3, f.origin);
  const credsV3 = sessionV3.hostCredentials();
  let seq = 0;
  const callV3 = async (body: object) => (await portsV3.handleJobApi(new Request(`${f.origin}/jobs/${sessionV3.jobId}/api`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${credsV3.agent}`},
    body: JSON.stringify({schema: JOB_API_V3_SCHEMA, jobId: sessionV3.jobId, requestId: `req-${++seq}`, ...body}),
  }))).json();

  try {
    const rigSelector: JobSelector = {kind: 'current', output: 'rig', record: recordHash};
    context = {
      selector: rigSelector,
      plan: null,
      parts: null,
      subjects: [{kind: 'review-verdict', stage: 'rig-review'}, {kind: 'parts-verdict', draftId: 'draft-1'}],
      partIds: [],
      files: [],
    };
    const publishedRig = await callV3({
      verb: 'publish',
      expectedGeneration: sessionV3.status().generation,
      idempotencyKey: 'pub-rig',
      result: {kind: 'package', path: 'out', selector: rigSelector},
      freeze: {kind: 'producer-held', holdId: 'hold', record: {path: 'project.json', sha256: recordHash}},
    });
    expect(publishedRig.ok).toBe(true);
    const rigPubId = publishedRig.value.publicationId as string;

    const subjects = [
      {kind: 'review-verdict', stage: 'rig-review'},
      {kind: 'review-verdict', stage: 'direction-review'},
      {kind: 'parts-verdict', draftId: 'draft-1'},
      {kind: 'signoff', stage: 'plan-approved'},
      {kind: 'checkpoint', checkpointId: 'step-one'},
      {kind: 'interview-picks', questionId: 'q1', setId: 's1'},
    ] as const;

    for (const [idx, subject] of subjects.entries()) {
      const res = await callV3({
        verb: 'ask',
        expectedGeneration: sessionV3.status().generation,
        idempotencyKey: `ask-rig-${idx}`,
        publicationId: rigPubId,
        subject,
      });
      expect(res).toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});
    }

    const batchRes = await callV3({
      verb: 'ask-batch',
      expectedGeneration: sessionV3.status().generation,
      idempotencyKey: 'batch-rig',
      publicationId: rigPubId,
      subjects: [{kind: 'review-verdict', stage: 'rig-review'}, {kind: 'parts-verdict', draftId: 'draft-1'}],
    });
    expect(batchRes).toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});

    // Also verify on current parts publication
    const parts = await preparePartsOnlyPackage(f);
    const partsSelector: JobSelector = {kind: 'current', output: 'parts', record: recordHash};
    context = {
      selector: partsSelector,
      plan: null,
      parts,
      subjects: [{kind: 'parts-verdict', draftId: 'draft-1'}],
      partIds: ['base'],
      files: [],
    };
    const publishedParts = await callV3({
      verb: 'publish',
      expectedGeneration: sessionV3.status().generation,
      idempotencyKey: 'pub-parts',
      result: {kind: 'package', path: 'out', selector: partsSelector},
      freeze: {kind: 'producer-held', holdId: 'hold-2', record: {path: 'project.json', sha256: recordHash}},
    });
    expect(publishedParts.ok).toBe(true);
    for (const [idx, subject] of [
      {kind: 'parts-verdict', draftId: 'draft-1'},
      {kind: 'review-verdict', stage: 'rig-review'},
    ].entries()) {
      const res = await callV3({
        verb: 'ask',
        expectedGeneration: sessionV3.status().generation,
        idempotencyKey: `ask-parts-${idx}`,
        publicationId: publishedParts.value.publicationId,
        subject,
      });
      expect(res).toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});
    }
    expect(sessionV3.status().pending).toEqual([]);
  } finally {
    sessionV3.dispose();
    await rm(stateV3, {recursive: true, force: true});
  }
});

test('Bar G (#1267 §5): act@10 source echoes current selector and output identities, optional commit, carriers, and distinct sourceHash per output', async () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const attachment = model.skins.find(({name}) => name === 'default')!.attachments.mesh.mesh;
  const meshHash = api.jobHash(attachmentHashText(attachment));
  const meshEdit: JobMeshEditValue = {
    skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
    source: {hash: meshHash, frame: {width: model.stage.width, height: model.stage.height},
      vertexCount: 4, triangleCount: 2, hullLength: 4, positions: [[48, 42], [48, 22], [68, 22], [68, 42]]},
    ops: [{op: 'add', at: [60.12, 29.57]}],
  };
  const boundMeshEdit = {edit: meshEdit, sha256: api.jobHash(canonicalJson(meshEdit))};

  const sendComment = async (f: Awaited<ReturnType<typeof jobFixture>>, publication: JobPublication, id: string, carriers?: unknown[]) => {
    const page = await f.display(publication);
    return f.ports.commitUIAct(f.session.jobId, f.uiRequest({
      ...page,
      expectedGeneration: f.session.status().generation,
      submissionId: id,
      kind: 'comments',
      value: {comments: [{text: `note ${id}`}], ...(carriers ? {carriers} : {})},
    }));
  };

  // Same record published as rig, then direction, then parts
  const {f, recordHash} = await createCurrentFixture();

  // 1) rig output (with commit and mesh-edits carrier)
  const rigSelector: JobSelector = {kind: 'current', output: 'rig', record: recordHash};
  f.setContext({selector: rigSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const rigPlainPub = await f.publish();
  expect('commit' in rigPlainPub.source).toBe(false);

  f.setContext({selector: rigSelector, plan: null, parts: null, subjects: [], partIds: [], files: [], commit});
  const rigPub = await f.publish();
  const rigActRes = await sendComment(f, rigPub, 'g-rig', [{kind: 'mesh-edits', file: rigPub.source.model!, meshEdits: [boundMeshEdit]}]);
  expect(rigActRes.ok).toBe(true);
  if (!rigActRes.ok) throw new Error(rigActRes.error.code);
  const rigAct = host.parseCommentOnlyAct(rigActRes.value);
  expect(rigAct.source.selector).toEqual(rigSelector);
  expect(rigAct.source.projectHash).toBe(recordHash);
  expect(rigAct.source.model).toEqual({path: 'out/skeleton.model.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(rigAct.source.direction).toBeNull();
  expect(rigAct.source.parts).toBeNull();
  expect(rigAct.source.plan).toBeNull();
  expect(rigAct.source.optionSet).toBeNull();
  expect(rigAct.source.appliedResult).toBeNull();
  expect(rigAct.source.commit).toBe(commit);

  // Publish Create's real direction@4 fixture at specs/direction/direction.json; rig, direction and parts on same record produce distinct sourceHash
  await prepareDirectionPackage(f, 'specs/direction/direction.json');
  const dirSelector: JobSelector = {kind: 'current', output: 'direction', record: recordHash};
  f.setContext({selector: dirSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const dirPub = await f.publish();
  const dirActRes = await sendComment(f, dirPub, 'g-dir');
  expect(dirActRes.ok).toBe(true);
  if (!dirActRes.ok) throw new Error(dirActRes.error.code);
  const dirAct = host.parseCommentOnlyAct(dirActRes.value);
  expect(dirAct.source.selector).toEqual(dirSelector);
  expect(dirAct.source.projectHash).toBe(recordHash);
  expect(dirAct.source.model).toEqual({path: 'out/skeleton.model.json', sha256: createModelSha});
  expect(dirAct.source.direction).toEqual({path: 'out/specs/direction/direction.json', sha256: createDirectionSha});
  expect(dirAct.source.parts).toBeNull();
  expect(dirAct.source.plan).toBeNull();
  expect(dirAct.source.optionSet).toBeNull();
  expect(dirAct.source.appliedResult).toBeNull();
  expect('commit' in dirAct.source).toBe(false);

  // Remove direction and model for parts output on the exact same recordHash
  await unlink(join(f.root, 'out/specs/direction/direction.json'));
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.direction;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const parts = await preparePartsOnlyPackage(f);
  const partsSelector: JobSelector = {kind: 'current', output: 'parts', record: recordHash};
  f.setContext({selector: partsSelector, plan: null, parts, subjects: [], partIds: ['base'], files: []});
  const partsPub = await f.publish();
  const partsActRes = await sendComment(f, partsPub, 'g-parts');
  expect(partsActRes.ok).toBe(true);
  if (!partsActRes.ok) throw new Error(partsActRes.error.code);
  const partsAct = host.parseCommentOnlyAct(partsActRes.value);
  expect(partsAct.source.selector).toEqual(partsSelector);
  expect(partsAct.source.projectHash).toBe(recordHash);
  expect(partsAct.source.model).toBeNull();
  expect(partsAct.source.direction).toBeNull();
  expect(partsAct.source.parts).toEqual(parts);
  expect(partsAct.source.plan).toBeNull();
  expect(partsAct.source.optionSet).toBeNull();
  expect(partsAct.source.appliedResult).toBeNull();

  // Carriers are refused on parts (model is null)
  const badCarrierRes = await sendComment(f, partsPub, 'g-parts-carrier', [
    {kind: 'mesh-edits', file: {path: 'out/skeleton.model.json', sha256: 'a'.repeat(64)}, meshEdits: [boundMeshEdit]},
  ]);
  expect(badCarrierRes).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});

  // Distinct sourceHashes across outputs of the same record
  expect(new Set([rigPlainPub.source.sourceHash, dirPub.source.sourceHash, partsPub.source.sourceHash]).size).toBe(3);
});

test('#1267 §5a: current parts and direction also ignore project.json rewrites at send and refuse JOB_ACT_SOURCE_STALE on output seal drift or superseded head', async () => {
  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  const dirSelector: JobSelector = {kind: 'current', output: 'direction', record: recordHash};
  f.setContext({selector: dirSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const dirPub = await f.publish();
  const dirPage = await f.display(dirPub);

  await writeFile(join(f.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{},"next":2}\n');
  const dirAccepted = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({
    ...dirPage,
    expectedGeneration: f.session.status().generation,
    submissionId: 'dir-after-record-move',
    kind: 'comments',
    value: {comments: [{text: 'direction comment after project rewrite'}]},
  }));
  expect(dirAccepted).toMatchObject({ok: true});

  const dirFile = join(f.root, 'out/direction.json');
  const mutatedDir = JSON.parse(await readFile(dirFile, 'utf8'));
  mutatedDir.take.loop = false;
  await writeFile(dirFile, JSON.stringify(mutatedDir));
  const dirStale = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({
    ...dirPage,
    expectedGeneration: f.session.status().generation,
    submissionId: 'dir-after-direction-drift',
    kind: 'comments',
    value: {comments: [{text: 'direction comment after direction drift'}]},
  }));
  expect(dirStale).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});

  // Parts output: project.json rewrite passes, parts image drift refuses JOB_ACT_SOURCE_STALE, republish supersedes old page
  const {f: fp, recordHash: partsRecordHash} = await createCurrentFixture();
  const parts = await preparePartsOnlyPackage(fp);
  const partsSelector: JobSelector = {kind: 'current', output: 'parts', record: partsRecordHash};
  fp.setContext({selector: partsSelector, plan: null, parts, subjects: [], partIds: ['base'], files: []});
  const partsPub = await fp.publish();
  const partsPage = await fp.display(partsPub);

  await writeFile(join(fp.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{},"next":3}\n');
  const partsAccepted = await fp.ports.commitUIAct(fp.session.jobId, fp.uiRequest({
    ...partsPage,
    expectedGeneration: fp.session.status().generation,
    submissionId: 'parts-after-record-move',
    kind: 'comments',
    value: {comments: [{text: 'parts comment after project rewrite'}]},
  }));
  expect(partsAccepted).toMatchObject({ok: true});

  await writeFile(join(fp.root, 'out/parts/base.png'), 'drifted-bytes');
  const partsStale = await fp.ports.commitUIAct(fp.session.jobId, fp.uiRequest({
    ...partsPage,
    expectedGeneration: fp.session.status().generation,
    submissionId: 'parts-after-image-drift',
    kind: 'comments',
    value: {comments: [{text: 'parts comment after image drift'}]},
  }));
  expect(partsStale).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
});

test('Part B (#1267 §3, §7): jobRigScreenSubject, jobRigScreenRoute, jobSourceDraftId and direction version omission for current outputs, with numbered rows unchanged', async () => {
  const record = 'ab'.repeat(32);
  const modelId = {path: 'out/skeleton.model.json', sha256: '1'.repeat(64)};
  const directionId = {path: 'out/direction.json', sha256: '2'.repeat(64)};
  const partsId = {
    enumeratorVersion: '2.25.1',
    manifest: {path: 'out/parts.json' as const, sha256: '3'.repeat(64)},
    images: [{path: 'parts/base.png', role: 'part', sha256: '4'.repeat(64)}],
  };
  const baseModelSource = {
    sourceHash: '5'.repeat(64),
    projectHash: record,
    package: {id: 'create', revision: record.slice(0, 12)},
    model: modelId,
    direction: null,
    optionSet: null,
    appliedResult: null,
    plan: null,
    parts: null,
  };
  const displayFor = (source: SourceV3, rigDraftVerdict = false): DisplayPublicationV3 => ({
    publication: {
      publicationId: 'pub-1',
      instanceKey: '6'.repeat(64),
      generation: 1,
      source,
      label: 'Create current check',
      previousPublicationId: null,
      visual: {status: 'available'},
    },
    ...(rigDraftVerdict ? {rigDraftVerdict: true} : {}),
  } as unknown as DisplayPublicationV3);

  // Screen subject and route rows: current vs numbered counterparts
  const rows: {
    name: string;
    source: SourceV3;
    rigDraftVerdict?: boolean;
    subject: boolean;
    route: boolean;
    refusal: string | null;
  }[] = [
    // current outputs
    {
      name: 'current/parts',
      source: {...baseModelSource, selector: {kind: 'current', output: 'parts', record}, model: null, parts: partsId} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'current/parts ignores rigDraftVerdict',
      source: {...baseModelSource, selector: {kind: 'current', output: 'parts', record}, model: null, parts: partsId} as SourceV3,
      rigDraftVerdict: true,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'current/parts without parts does not fall into rig',
      source: {...baseModelSource, selector: {kind: 'current', output: 'parts', record}, model: modelId, parts: null} as SourceV3,
      rigDraftVerdict: true,
      subject: false,
      route: false,
      refusal: 'JOB_ASK_UNSUPPORTED',
    },
    {
      name: 'current/rig',
      source: {...baseModelSource, selector: {kind: 'current', output: 'rig', record}} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'current/rig rejects direction-bearing source',
      source: {...baseModelSource, selector: {kind: 'current', output: 'rig', record}, direction: directionId} as SourceV3,
      subject: false,
      route: false,
      refusal: 'JOB_ASK_UNSUPPORTED',
    },
    {
      name: 'current/direction',
      source: {...baseModelSource, selector: {kind: 'current', output: 'direction', record}, direction: directionId} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'current/direction without direction does not fire JOB_DIRECTION_MISSING',
      source: {...baseModelSource, selector: {kind: 'current', output: 'direction', record}, direction: null} as SourceV3,
      subject: false,
      route: false,
      refusal: 'JOB_ASK_UNSUPPORTED',
    },
    // numbered counterparts (unchanged)
    {
      name: 'numbered draft with parts',
      source: {...baseModelSource, selector: {kind: 'draft', id: 'draft-1'}, model: null, parts: partsId} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'numbered draft without parts (no rigDraftVerdict)',
      source: {...baseModelSource, selector: {kind: 'draft', id: 'draft-1'}, model: modelId, parts: null} as SourceV3,
      subject: false,
      route: false,
      refusal: 'JOB_PARTS_MISSING',
    },
    {
      name: 'numbered draft with rigDraftVerdict',
      source: {...baseModelSource, selector: {kind: 'draft', id: 'draft-1'}, model: modelId, parts: null} as SourceV3,
      rigDraftVerdict: true,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'numbered rig{version}',
      source: {...baseModelSource, selector: {kind: 'rig', version: 2}} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'numbered post',
      source: {...baseModelSource, selector: {kind: 'post', version: 3, rigVersion: 2}, direction: directionId} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'numbered post without direction',
      source: {...baseModelSource, selector: {kind: 'post', version: 3, rigVersion: 2}, direction: null} as SourceV3,
      subject: false,
      route: false,
      refusal: 'JOB_DIRECTION_MISSING',
    },
    {
      name: 'standalone null selector',
      source: {...baseModelSource, selector: null} as SourceV3,
      subject: true,
      route: true,
      refusal: null,
    },
    {
      name: 'record plan',
      source: {
        record: {path: 'project.json', sha256: record},
        sourceHash: '7'.repeat(64),
        projectHash: record,
        subject: 'plan',
        plan: {steps: [{id: 'step-1', hash: '8'.repeat(64)}]},
        subjects: [],
        files: [],
      } as unknown as SourceV3,
      subject: false,
      route: false,
      refusal: null,
    },
  ];

  for (const row of rows) {
    expect(jobRigScreenSubject(row.source, row.rigDraftVerdict)).toBe(row.subject);
    const display = displayFor(row.source, row.rigDraftVerdict);
    expect(jobRigScreenRoute(display, [], new Set())).toBe(row.route);
    expect(jobRigScreenRefusal(display, [], new Set())).toBe(row.refusal);
  }

  // Storage keys (§7): each current output and distinct keys for two outputs of one record, with numbered rows unchanged
  const keyParts = jobSourceDraftId({...baseModelSource, selector: {kind: 'current', output: 'parts', record}, model: null, parts: partsId} as SourceV3);
  const keyRig = jobSourceDraftId({...baseModelSource, selector: {kind: 'current', output: 'rig', record}} as SourceV3);
  const keyDir = jobSourceDraftId({...baseModelSource, selector: {kind: 'current', output: 'direction', record}, direction: directionId} as SourceV3);
  expect(keyParts).toBe(`create:current:parts:${record}`);
  expect(keyRig).toBe(`create:current:rig:${record}`);
  expect(keyDir).toBe(`create:current:direction:${record}`);
  expect(new Set([keyParts, keyRig, keyDir]).size).toBe(3);

  expect(jobSourceDraftId({...baseModelSource, selector: {kind: 'draft', id: 'draft-1'}} as SourceV3)).toBe('draft-1');
  expect(jobSourceDraftId({...baseModelSource, selector: {kind: 'rig', version: 2}} as SourceV3)).toBe('create:rig:2');
  expect(jobSourceDraftId({...baseModelSource, selector: {kind: 'post', version: 3, rigVersion: 2}} as SourceV3)).toBe('create:post:3:2');
  expect(jobSourceDraftId({...baseModelSource, selector: null} as SourceV3)).toBe('create');
  expect(jobSourceDraftId({
    record: {path: 'project.json', sha256: record},
    subject: 'option-set',
    selection: {questionId: 'q1', setId: 's1'},
  } as unknown as SourceV3)).toBe('q1:s1');

  // Version label omission on current direction vs numbered post
  const baseDirectionView = {
    model: {...modelId, inspected: true},
    revision: '1',
    sourceHash: '5'.repeat(64),
    runtime: '1.27.0',
    dials: [],
    sets: [],
    authored: {
      file: directionId,
      model: modelId,
      rigVersion: 2,
      camera: {space: 'rig-world-y-up' as const, keys: [{time: 0, easing: 'hold', box: {x: 0, y: 0, width: 80, height: 64}}]},
      take: {duration: 1, loop: true},
      timing: [{time: 0, source_time: 0, easing: 'linear'}, {time: 1, source_time: 1, easing: 'linear'}],
    },
  };
  expect(directionSummary({...baseDirectionView, authored: {...baseDirectionView.authored, postVersion: 3}}, 'en'))
    .toBe('Direction v3 · 1 s · loop · fixed camera');
  expect(directionSummary(baseDirectionView, 'en'))
    .toBe('Direction · 1 s · loop · fixed camera');
  expect(directionSummary({...baseDirectionView, authored: {...baseDirectionView.authored, postVersion: 3}}, 'ko'))
    .toBe('연출 v3 · 1초 · 반복 · 카메라 고정');
  expect(directionSummary(baseDirectionView, 'ko'))
    .toBe('연출 · 1초 · 반복 · 카메라 고정');

  // Live prepare() for current/parts loads /api/stage-parts into prepared.parts just like draft with parts
  const live = await realJobWindowFixture();
  try {
    const projectText = '{"schema":"rig-create/project@0","interview":{}}\n';
    await writeFile(join(live.input.root, 'project.json'), projectText);
    live.input.setRecordPath('project.json');
    const liveRecord = api.jobHash(projectText);
    const pkgRoot = join(live.input.root, 'out');
    await writeComparisonPackage(pkgRoot, true);
    await writeFile(join(pkgRoot, 'config.json'), JSON.stringify({key: 'synthetic-current-parts'}));
    await unlink(join(pkgRoot, 'skeleton.model.json'));
    const manifestPath = join(pkgRoot, 'review.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.id = 'create';
    manifest.title = 'Create 1267 parts';
    manifest.revision = liveRecord.slice(0, 12);
    delete manifest.model;
    manifest.animations = [];
    manifest.checkpoints = [];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const refs = [
      {path: 'painting.png', role: 'painting'},
      {path: 'parts/body.png', role: 'part'},
      {path: 'parts/front.png', role: 'part'},
    ];
    const images = await Promise.all(refs.map(async r => ({...r, sha256: api.jobHash(await readFile(join(pkgRoot, r.path)))})));
    live.input.setPartsReferences(refs);
    live.input.setContext({
      selector: {kind: 'current', output: 'parts', record: liveRecord},
      plan: null,
      parts: {
        enumeratorVersion: live.input.partsEnumerator.version,
        manifest: {path: 'out/parts.json', sha256: api.jobHash(await readFile(join(pkgRoot, 'parts.json')))},
        images,
      },
      subjects: [],
      partIds: ['body', 'front'],
      files: [{path: 'out/rig.json', sha256: api.jobHash(await readFile(join(pkgRoot, 'rig.json')))}],
    });
    const pub = await live.publish();
    const readRes = await live.host.ports.readPublication(live.host.session.jobId, pub.publicationId);
    expect(readRes.ok).toBe(true);
    if (!readRes.ok) throw new Error(readRes.error.code);
    const screen = createJobRigScreen({
      host: {replaceChildren() {}} as unknown as HTMLElement,
      pageId: 'page-current-parts',
      access: {capability: live.credentials.ui, headers: init => new Headers(init)},
      window: {
        state: () => ({pending: [], receipt: null, generation: pub.generation, preparing: false, closed: false}),
        submit: async () => { throw new Error('unused'); },
      },
      routes: d => jobPublicationRoutes(d, live.host.origin),
      refusal: String,
      translate: String,
      load: async () => ({}),
    });
    const prepared = await screen.prepare(readRes.value, new AbortController().signal);
    expect(prepared?.parts?.mode).toBe('parts');
    expect(prepared?.parts?.sourceHash).toBe(pub.source.sourceHash);
    expect(prepared?.parts?.items.map(item => item.name)).toEqual(['body', 'front']);
  } finally {
    await live.close();
  }
});

test('#1280: Create example-current fixture bytes are intact and accepted on a current direction publication without top-level model, rig.version, camera or timing', async () => {
  expect(api.jobHash(await readFile(join(createFixtureDir, 'direction.json')))).toBe(createDirectionSha);
  expect(api.jobHash(await readFile(join(createFixtureDir, 'skeleton.model.json')))).toBe(createModelSha);
  expect(api.jobHash(await readFile(join(createFixtureDir, 'skeleton.atlas')))).toBe(createAtlasSha);
  expect(api.jobHash(await readFile(join(createFixtureDir, 'skeleton.png')))).toBe(createPngSha);
  const rawDirection = JSON.parse(await readFile(join(createFixtureDir, 'direction.json'), 'utf8'));
  expect(rawDirection.schema).toBe('rig-create/direction@4');
  // Create's direction@4 binds the upstream character rig, not the composed manifest model, and has no rig.version, camera or timing.
  expect(rawDirection.rig.model.sha256).not.toBe(createModelSha);
  expect('version' in rawDirection.rig).toBe(false);
  expect('model' in rawDirection).toBe(false);
  expect('camera' in rawDirection).toBe(false);
  expect('timing' in rawDirection).toBe(false);

  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  const selector: JobSelector = {kind: 'current', output: 'direction', record: recordHash};
  f.setContext({selector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const publication = await f.publish();
  expect(publication.source.model).toEqual({path: 'out/skeleton.model.json', sha256: createModelSha});
  expect(publication.source.direction).toEqual({path: 'out/direction.json', sha256: createDirectionSha});
  const page = await f.display(publication);
  const actRes = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({
    ...page,
    expectedGeneration: f.session.status().generation,
    submissionId: '1280-fixture-act',
    kind: 'comments',
    value: {comments: [{text: 'direction@4 current check'}]},
  }));
  expect(actRes.ok).toBe(true);
  if (!actRes.ok) throw new Error(actRes.error.code);
  const act = host.parseCommentOnlyAct(actRes.value);
  expect(act.source.direction).toEqual({path: 'out/direction.json', sha256: createDirectionSha});
  expect(act.source.model).toEqual({path: 'out/skeleton.model.json', sha256: createModelSha});
});

test('#1280 refusal: direction@1 on current is refused with bounded JOB_SOURCE_MISMATCH', async () => {
  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  const modelSha = api.jobHash(await readFile(join(f.root, 'out/skeleton.model.json')));
  await writeFile(join(f.root, 'out/direction.json'), JSON.stringify(numberedDirectionV1Document(modelSha)));
  f.setContext({selector: {kind: 'current', output: 'direction', record: recordHash}, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const res = await f.call(await f.publishRequest('1280-v1-on-current'));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  expect(JSON.stringify(body).length).toBeLessThan(1024);
});

test('#1280 refusal: non-@4 direction schemas (@2, @3, @0, @5) on current are refused with JOB_SOURCE_MISMATCH', async () => {
  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  f.setContext({selector: {kind: 'current', output: 'direction', record: recordHash}, plan: null, parts: null, subjects: [], partIds: [], files: []});
  for (const [idx, badDoc] of [
    {
      ...numberedDirectionV1Document(createModelSha),
      schema: 'rig-create/direction@2',
      scene: {n: 1, path: 'scene.json', sha256: 'a'.repeat(64)},
    },
    {
      schema: 'rig-create/direction@3',
      model: {path: 'skeleton.model.json', sha256: createModelSha},
      rig: {version: 1},
      take: {duration: 4, loop: true},
    },
    {schema: 'rig-create/direction@0', take: {duration: 4, loop: true}},
    {schema: 'rig-create/direction@5', take: {duration: 4, loop: true}},
  ].entries()) {
    await writeFile(join(f.root, 'out/direction.json'), JSON.stringify(badDoc));
    const res = await f.call(await f.publishRequest(`1280-bad-schema-${idx}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  }
});

test('#1280 refusal: missing or invalid take on current is refused with JOB_SOURCE_MISMATCH, while boolean take.loop false is accepted', async () => {
  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  f.setContext({selector: {kind: 'current', output: 'direction', record: recordHash}, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const baseDoc = JSON.parse(await readFile(join(createFixtureDir, 'direction.json'), 'utf8'));
  const {take: _omitted, ...withoutTake} = baseDoc;
  for (const [idx, badDoc] of [
    withoutTake,
    {...baseDoc, take: null},
    {...baseDoc, take: {duration: 0, loop: true}},
    {...baseDoc, take: {duration: -1, loop: true}},
    {...baseDoc, take: {duration: '4', loop: true}},
    {...baseDoc, take: {duration: 4}},
    {...baseDoc, take: {duration: 4, loop: 'true'}},
    {...baseDoc, take: {duration: 4, loop: 1}},
  ].entries()) {
    await writeFile(join(f.root, 'out/direction.json'), JSON.stringify(badDoc));
    const res = await f.call(await f.publishRequest(`1280-bad-take-${idx}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  }

  // Review only checks that take.loop is a boolean and take.duration > 0; rig/scene/citations are not required by Review.
  await writeFile(join(f.root, 'out/direction.json'), JSON.stringify({schema: 'rig-create/direction@4', take: {duration: 2.5, loop: false}}));
  const minimalPub = await f.publish();
  const routes = retainedPublicationRoutes(f.session);
  const metaRes = await routes(f.session.jobId, minimalPub.publicationId, minimalPub.instanceKey, 'api/review', new Request(f.origin + '/api/review'));
  expect(metaRes.status).toBe(200);
  const meta = await metaRes.json() as {direction: {take: {duration: number; loop: boolean}; composed?: boolean}};
  expect(meta.direction.take).toEqual({duration: 2.5, loop: false});
  expect(meta.direction.composed).toBe(true);
});

test('#1280 refusal: manifest declaring scene on current is refused with JOB_SOURCE_MISMATCH', async () => {
  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  await writeFile(join(f.root, 'out/scene.json'), JSON.stringify({schema: 'rig-create/scene@2'}));
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.scene = 'scene.json';
  await writeFile(manifestPath, JSON.stringify(manifest));

  f.setContext({selector: {kind: 'current', output: 'direction', record: recordHash}, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const res = await f.call(await f.publishRequest('1280-declared-scene'));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  expect(JSON.stringify(body).length).toBeLessThan(1024);
});

test('#1280 refusal: direction file over 256 KiB on current is refused with JOB_SOURCE_MISMATCH', async () => {
  const {f, recordHash} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  const oversized = JSON.stringify({
    schema: 'rig-create/direction@4',
    take: {duration: 4, loop: true},
    citations: {pad: 'x'.repeat(256 * 1024)},
  });
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(256 * 1024);
  await writeFile(join(f.root, 'out/direction.json'), oversized);

  f.setContext({selector: {kind: 'current', output: 'direction', record: recordHash}, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const res = await f.call(await f.publishRequest('1280-oversized-direction'));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  expect(JSON.stringify(body).length).toBeLessThan(1024);
});

test('#1280 numbered invariance: direction@4 on a numbered post is refused unchanged, while @1 and @3 keep model match and rig.version', async () => {
  const {f} = await createCurrentFixture();
  await prepareDirectionPackage(f);
  const postSelector: JobSelector = {kind: 'post', version: 3, rigVersion: 2};
  f.setContext({selector: postSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});

  // Create's direction@4 under numbered post is refused as today
  const v4OnPostRes = await f.call(await f.publishRequest('1280-v4-on-post'));
  expect(v4OnPostRes.status).toBe(409);
  expect(await v4OnPostRes.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});

  // direction@3 with mismatched model sha is still refused on numbered post
  await writeFile(join(f.root, 'out/direction.json'), JSON.stringify({
    schema: 'rig-create/direction@3',
    model: {path: 'skeleton.model.json', sha256: '0'.repeat(64)},
    rig: {version: 2},
    take: {duration: 4, loop: true},
  }));
  const mismatchRes = await f.call(await f.publishRequest('1280-v3-model-mismatch'));
  expect(mismatchRes.status).toBe(409);
  expect(await mismatchRes.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});

  // Valid direction@3 on numbered post succeeds and retains rigVersion and postVersion
  await writeFile(join(f.root, 'out/direction.json'), JSON.stringify({
    schema: 'rig-create/direction@3',
    model: {path: 'skeleton.model.json', sha256: createModelSha},
    rig: {version: 2},
    take: {duration: 4, loop: true},
  }));
  const postPub = await f.publish();
  const routes = retainedPublicationRoutes(f.session);
  const metaRes = await routes(f.session.jobId, postPub.publicationId, postPub.instanceKey, 'api/review', new Request(f.origin + '/api/review'));
  expect(metaRes.status).toBe(200);
  const meta = await metaRes.json() as {direction: Record<string, unknown>};
  expect(meta.direction.rigVersion).toBe(2);
  expect(meta.direction.postVersion).toBe(3);
  expect(meta.direction.composed).toBe(true);
});

test('#1280 HQ ruling B: directionRows renders direction.authored with rig version on numbered views and direction.authoredCurrent without version or undefined on current views', () => {
  const modelId = {path: 'skeleton.model.json', sha256: createModelSha, inspected: true};
  const fileId = {path: 'specs/direction/direction.json', sha256: createDirectionSha};
  const baseView = {
    model: modelId,
    revision: '1',
    sourceHash: '5'.repeat(64),
    runtime: '1.27.0',
    dials: [],
    sets: [],
  };
  const numberedRows = directionRows({
    ...baseView,
    authored: {
      file: fileId,
      model: {path: modelId.path, sha256: modelId.sha256},
      postVersion: 3,
      rigVersion: 2,
      composed: true,
      camera: {space: 'rig-world-y-up', keys: []},
      take: {duration: 4, loop: true},
      timing: [],
    },
  });
  const currentRows = directionRows({
    ...baseView,
    authored: {
      file: fileId,
      model: {path: modelId.path, sha256: modelId.sha256},
      composed: true,
      camera: {space: 'rig-world-y-up', keys: []},
      take: {duration: 4, loop: true},
      timing: [],
    },
  });
  expect(numberedRows.find(r => r.key.startsWith('direction.authored'))).toEqual({
    key: 'direction.authored',
    values: ['2', fileId.path, fileId.sha256],
  });
  expect(currentRows.find(r => r.key.startsWith('direction.authored'))).toEqual({
    key: 'direction.authoredCurrent',
    values: [fileId.path, fileId.sha256],
  });
  expect(t('direction.authored', ['2', fileId.path, fileId.sha256], 'en'))
    .toBe(`Authored direction · rig v2 · ${fileId.path} · SHA-256 ${fileId.sha256}`);
  expect(t('direction.authored', ['2', fileId.path, fileId.sha256], 'ko'))
    .toBe(`작성된 연출 · 리그 v2 · ${fileId.path} · SHA-256 ${fileId.sha256}`);
  const currentEn = t('direction.authoredCurrent', [fileId.path, fileId.sha256], 'en');
  const currentKo = t('direction.authoredCurrent', [fileId.path, fileId.sha256], 'ko');
  expect(currentEn).toBe(`Authored direction · ${fileId.path} · SHA-256 ${fileId.sha256}`);
  expect(currentKo).toBe(`작성된 연출 · ${fileId.path} · SHA-256 ${fileId.sha256}`);
  for (const rendered of [currentEn, currentKo]) {
    expect(rendered).not.toContain('undefined');
    expect(rendered).not.toContain('rig v');
    expect(rendered).not.toContain('리그 v');
  }
});
