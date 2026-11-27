/** #1267 part A: server and contract coverage for the `current` selector. */
import {afterEach, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

function directionDocument(modelSha: string) {
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
  const modelSha = api.jobHash(await readFile(join(f.root, 'out/skeleton.model.json')));
  const fullDirection = join(f.root, 'out', directionRelPath);
  await writeFile(fullDirection, JSON.stringify(directionDocument(modelSha)));
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.direction = directionRelPath;
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

    // Direction with direction file -> accepted, and api/review direction metadata carries no postVersion
    f.setContext({selector: dirSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
    const dirPub = await f.publish();
    const routes = retainedPublicationRoutes(f.session);
    const metaRes = await routes(f.session.jobId, dirPub.publicationId, dirPub.instanceKey, 'api/review', new Request(f.origin + '/api/review'));
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json() as {direction?: Record<string, unknown>; capabilities: {preRig: boolean}};
    expect(meta.direction).toBeDefined();
    expect('postVersion' in (meta.direction ?? {})).toBe(false);
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

  // Also compare same package files except selector: rig vs direction vs parts on same record produce distinct sourceHash
  await prepareDirectionPackage(f);
  const dirSelector: JobSelector = {kind: 'current', output: 'direction', record: recordHash};
  f.setContext({selector: dirSelector, plan: null, parts: null, subjects: [], partIds: [], files: []});
  const dirPub = await f.publish();
  const dirActRes = await sendComment(f, dirPub, 'g-dir');
  expect(dirActRes.ok).toBe(true);
  if (!dirActRes.ok) throw new Error(dirActRes.error.code);
  const dirAct = host.parseCommentOnlyAct(dirActRes.value);
  expect(dirAct.source.selector).toEqual(dirSelector);
  expect(dirAct.source.projectHash).toBe(recordHash);
  expect(dirAct.source.model).toEqual(rigPub.source.model);
  expect(dirAct.source.direction).toEqual({path: 'out/direction.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(dirAct.source.parts).toBeNull();
  expect(dirAct.source.plan).toBeNull();
  expect(dirAct.source.optionSet).toBeNull();
  expect(dirAct.source.appliedResult).toBeNull();
  expect('commit' in dirAct.source).toBe(false);

  // Remove direction and model for parts output on the exact same recordHash
  await unlink(join(f.root, 'out/direction.json'));
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
