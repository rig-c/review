import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalJson} from '../src/canonical-json.ts';
import {finalizeJobAct, prepareJobStill} from '../src/job-act.ts';
import * as api from '../src/job-api.ts';
import {jobCommand} from '../src/job-cli.ts';
import type {JobChestLandmarkValue, JobMeshEditValue, JobRigReviewAct, JobUISubmission} from '../src/job-contract.ts';
import {attachmentHashText} from '../src/mesh-edit.ts';
import legacy from './fixtures/comments-contract-legacy.json';
import model from './fixtures/viewport-387/package/skeleton.model.json';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';

const schema = 'rig-review/act@9';
const meshSchema = 'rig-review/act@8';
const attachment = model.skins.find(({name}) => name === 'default')!.attachments.mesh.mesh;
const hash = api.jobHash(attachmentHashText(attachment));
const frame = {width: model.stage.width, height: model.stage.height};
const edit: JobChestLandmarkValue = {
  skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
  source: {hash, frame},
  bust: {apex_r: [16 + 1 / 256, 20], apex_l: [56, 20], alpha: 0.22},
};
const meshEdit: JobMeshEditValue = {
  skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
  source: {hash, frame, vertexCount: 4, triangleCount: 2, hullLength: 4,
    positions: [[48, 42], [48, 22], [68, 22], [68, 42]]},
  ops: [{op: 'add', at: [60.12, 29.57]}],
};
const bind = <T>(edit: T) => ({edit, sha256: api.jobHash(canonicalJson(edit))});
const {value: _oldValue, ...rig} = JSON.parse(legacy.records['@3'].raw) as JobRigReviewAct;
const value = {stage: 'rig-review', verdict: 'changes-requested', comments: [], chestLandmarks: [bind(edit)]};

test('#990 decodes landmark-only and combined acts, preserving the point and comment bytes', () => {
  for (const fields of [value, {...value, meshEdits: [bind(meshEdit)],
    comments: [{text: '  가슴\n', context: {mode: 'setup'}}]}]) {
    const raw = {...rig, schema, value: fields};
    const bytes = JSON.stringify(raw);
    expect(JSON.stringify(api.parseChestLandmarksAct(JSON.parse(bytes)))).toBe(bytes);
    expect(api.parseChestLandmarksAct(raw).value.chestLandmarks[0]!.edit.bust).toEqual(edit.bust);
  }
});

test('#990 legacy @8 decoder rejects the new schema and refuses the chest field relabeled as @8', () => {
  expect(() => api.parseMeshEditsAct({...rig, schema, value})).toThrow('JOB_ACT_INVALID');
  expect(() => api.parseMeshEditsAct({...rig, schema: meshSchema, value})).toThrow('JOB_ACT_INVALID');
});

test('#990 refuses unknown fields, bad digests, off-grid and out-of-frame points, and bad ordering', () => {
  const first = bind({...edit, skin: '𐀀'}), last = bind({...edit, skin: '\uE000'});
  const raw = {...rig, schema};
  expect(api.parseChestLandmarksAct({...raw, value: {...value, chestLandmarks: [first, last]}}).value.chestLandmarks)
    .toEqual([first, last]);
  const invalid = [undefined, [], Array.from({length: 5}, (_, index) => bind({...edit, slot: String(index)})),
    [last, first], [first, first], [{...bind(edit), sha256: '1'.repeat(64)}],
    [bind({...edit, bust: {...edit.bust, cleavage: [0.1, 20]}})],
    [bind({...edit, bust: {...edit.bust, cleavage: [frame.width + 1, 20]}})],
    [bind({...edit, bust: {...edit.bust, cleavage: null}})],
    [bind({...edit, bust: {...edit.bust, regions: []}})],
    [bind({...edit, source: {...edit.source, configHash: '2'.repeat(64)}})]];
  for (const chestLandmarks of invalid) {
    expect(() => api.parseChestLandmarksAct({...raw, value: {...value, chestLandmarks}})).toThrow('JOB_ACT_INVALID');
  }
  expect(() => api.parseChestLandmarksAct({...raw, value: {...value, verdict: 'approved'}})).toThrow('JOB_ACT_INVALID');
  expect(() => api.parseChestLandmarksAct({...raw, value: {...value, stage: 'direction-review'}})).toThrow('JOB_ACT_INVALID');
  expect(() => api.parseChestLandmarksAct({...raw, kind: 'signoff', value: {stage: 'rig-review',
    decision: 'approved', comments: [], chestLandmarks: [bind(edit)]}})).toThrow('JOB_ACT_INVALID');
});

async function seedChest(f: Awaited<ReturnType<typeof jobFixture>>) {
  const path = 'producer-config.json';
  const bytes = JSON.stringify({meshes: {mesh: {contour: {bust: edit.bust}}}});
  await writeFile(join(f.root, path), bytes);
  const config = {path, sha256: api.jobHash(bytes)};
  const seed = {...edit, source: {...edit.source, configHash: config.sha256}};
  const context = {...f.getContext(), files: [config], chestLandmarks: [seed]};
  f.setContext(context);
  return {config, context, seed};
}

test('#990 publication retains the published spec, including its source config hash, across read and replay', async () => {
  const f = await jobFixture();
  try {
    const {config, context, seed} = await seedChest(f);
    const request = await f.publishRequest();
    const result = await (await f.call(request)).json();
    expect(result.ok).toBe(true);
    const publication = result.value;
    expect(publication.chestLandmarks).toEqual([seed]);
    expect(await f.ports.readPublication(f.session.jobId, publication.publicationId))
      .toMatchObject({ok: true, value: {publication}});
    expect(f.session.status().publication).toEqual(publication);
    expect(await (await f.call(request)).json()).toEqual(result);
    const retained = f.session.retainedSource(publication.publicationId);
    expect(api.jobHash(await readFile(join(retained.snapshotRoot, config.path)))).toBe(config.sha256);

    const bytes = JSON.stringify({meshes: {mesh: {contour: {bust: edit.bust}}}}, null, 2);
    const changed = {...config, sha256: api.jobHash(bytes)};
    await writeFile(join(f.root, config.path), bytes);
    f.setContext({...context, files: [changed], chestLandmarks: [{...seed, source: {...seed.source, configHash: changed.sha256}}]});
    const successor = await f.publish();
    expect(successor.source.model).toEqual(publication.source.model);
    expect(successor.source.sourceHash).not.toBe(publication.source.sourceHash);
    expect(successor.instanceKey).not.toBe(publication.instanceKey);
  } finally { await f.close(); }
});

test('#990 publication refuses missing or unsealed config hashes and seeds that differ from retained bytes', async () => {
  const f = await jobFixture();
  try {
    const {context, seed} = await seedChest(f);
    const wrongConfig = {...seed, source: {...seed.source, configHash: '1'.repeat(64)}};
    const wrongMesh = {...seed, source: {...seed.source, hash: '1'.repeat(64)}};
    const wrongFrame = {...seed, source: {...seed.source, frame: {...frame, width: frame.width + 1}}};
    const changedBust = {...seed, bust: {...seed.bust, clearance: 4}};
    for (const candidate of [edit, wrongConfig, wrongMesh, wrongFrame, changedBust]) {
      f.setContext({...context, chestLandmarks: [candidate as typeof seed]});
      const response = await f.call(await f.publishRequest());
      expect(await response.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
      expect(f.session.status().publication).toBeNull();
    }
    f.setContext({...context, selector: {kind: 'post', version: 1, rigVersion: 1}});
    expect(await (await f.call(await f.publishRequest())).json())
      .toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  } finally { await f.close(); }
});

test('#990 retained publication refuses corrupt seed copies', async () => {
  const f = await jobFixture();
  try {
    await seedChest(f);
    const publication = await f.publish();
    const db = new Database(join(f.state, 'jobs.sqlite'));
    try {
      const row = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!;
      const update = db.query('UPDATE jobs SET document=? WHERE job_id=?');
      const stored = JSON.parse(row.document);
      const copies = [stored.publications[publication.publicationId].retained, stored.publications[publication.publicationId].publication,
        stored.events.find((event: {type: string}) => event.type === 'published').publication,
        ...Object.values(stored.replays).map(replay => (replay as {value: unknown}).value)];
      for (const copy of copies) {
        const original = copy.chestLandmarks[0].source.configHash;
        copy.chestLandmarks[0].source.configHash = '1'.repeat(64);
        update.run(JSON.stringify(stored), f.session.jobId);
        expect(() => f.session.status()).toThrow('JOB_SOURCE_MISMATCH');
        copy.chestLandmarks[0].source.configHash = original;
      }
      update.run(row.document, f.session.jobId);
      expect(f.session.status().publication).toEqual(publication);
    } finally { db.close(); }
  } finally { await f.close(); }
});

async function pendingRigReview(f: Awaited<ReturnType<typeof jobFixture>>) {
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const page = await f.display(publication);
  const retained = f.session.retainedSource(publication.publicationId);
  const submission = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation, submissionId: 'chest-990',
    kind: 'review-verdict', capture: rigStillCapture(publication, ask, page).capture,
    value: {stage: 'rig-review', verdict: 'changes-requested', words: '', chestLandmarks: [bind(edit)]}} as const;
  const options = {jobId: f.session.jobId, retained, ask, reviewer: {id: 'owner', role: 'owner'} as const,
    still: prepareJobStill(submission, ask, retained).still};
  const finalize = (value: JobUISubmission['value'], source = retained) =>
    finalizeJobAct({...options, retained: source, submission: {...submission, value} as JobUISubmission});
  return {retained, submission, finalize};
}

test('#990 writer commits, replays, and fetches the same act@9 without changing producer inputs', async () => {
  const f = await jobFixture();
  try {
    await seedChest(f);
    const original = await jobInputHashes(f.root);
    const {submission, finalize} = await pendingRigReview(f);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission));
    expect(saved).toMatchObject({ok: true, value: {schema}});
    if (!saved.ok) throw new Error(saved.error.code);
    const act = api.parseChestLandmarksAct(saved.value);
    expect(act.value.comments).toEqual([]);
    expect(act.value.chestLandmarks).toEqual(submission.value.chestLandmarks);
    expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission))).toEqual(saved);
    const expected = JSON.stringify(act);
    expect(f.session.readActExport(act.actId, false).toString()).toBe(expected);
    const chunks: Buffer[] = [];
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', act.actId, '--still-out', f.scratch], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: (async (input, init) => f.ports.handleJobApi(new Request(input, init))) as typeof fetch,
      writeBytes: chunk => {chunks.push(Buffer.from(chunk)); return chunk.length;},
    });
    expect(Buffer.concat(chunks).toString()).toBe(expected);
    expect(api.jobHash(await readFile(join(f.scratch, act.still.path)))).toBe(act.still.sha256);
    const combined = finalize({...submission.value, meshEdits: [bind(meshEdit)]});
    expect(api.parseChestLandmarksAct(combined).value.meshEdits).toEqual([bind(meshEdit)]);
    expect(await jobInputHashes(f.root)).toEqual(original);
  } finally { await f.close(); }
});

test('#990 writer refuses unseeded, stale, invalid-frame, and failed-clearance submissions', async () => {
  const f = await jobFixture();
  try {
    const unseeded = await pendingRigReview(f);
    expect(() => unseeded.finalize(unseeded.submission.value)).toThrow('JOB_ACT_INVALID');
    await seedChest(f);
    const {retained, submission, finalize} = await pendingRigReview(f);
    const changed = (patch: Partial<JobChestLandmarkValue>) => ({...submission.value, chestLandmarks: [bind({...edit, ...patch})]});
    expect(() => finalize(changed({source: {...edit.source, frame: {...frame, height: 1 + frame.height}}}))).toThrow('JOB_ACT_INVALID');
    expect(() => finalize(changed({source: {...edit.source, hash: '1'.repeat(64)}}))).toThrow('JOB_ACT_SOURCE_STALE');
    expect(() => finalize(changed({bust: {...edit.bust, cleavage: [36, 20], clearance: 0}}))).toThrow('CONFIG_BUST_CLEARANCE');
    expect(api.parseChestLandmarksAct(finalize(changed({bust: {...edit.bust, cleavage: [36, 20]}}))).value.chestLandmarks)
      .toEqual(changed({bust: {...edit.bust, cleavage: [36, 20]}}).chestLandmarks);
    const modelPath = join(retained.snapshotRoot, retained.source.model!.path);
    await writeFile(modelPath, (await readFile(modelPath, 'utf8')) + '\n');
    expect(() => finalize(submission.value)).toThrow('JOB_ACT_SOURCE_STALE');
  } finally { await f.close(); }
});

test('#990 a changed retained config refuses finalization without consuming the ask or submission', async () => {
  const f = await jobFixture();
  try {
    const {config} = await seedChest(f);
    const {retained, submission} = await pendingRigReview(f);
    const path = join(retained.snapshotRoot, config.path);
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from('\n')]));
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission));
    expect(result).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
    expect(f.session.status().pending.some(row => row.askId === submission.askId)).toBe(true);
    await writeFile(path, bytes);
    expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission))).toMatchObject({ok: true, value: {schema}});
  } finally { await f.close(); }
});

test('#990 retains @8 linked-mesh refusal and hash precedence', async () => {
  const f = await jobFixture();
  try {
    const path = 'out/skeleton.model.json';
    const linkedModel = JSON.parse(await readFile(join(f.root, path), 'utf8'));
    const entries = linkedModel.skins.find((skin: {name: string}) => skin.name === 'default').attachments.mesh;
    const linked = {kind: 'linkedmesh', skin: 'default', slot: 'mesh', source: 'mesh-source'};
    entries['mesh-source'] = entries.mesh;
    entries.mesh = linked;
    await writeFile(join(f.root, path), JSON.stringify(linkedModel));
    const {finalize} = await pendingRigReview(f);
    const meshRequest = {stage: 'rig-review', verdict: 'changes-requested', words: ''} as const;
    expect(() => finalize({...meshRequest, meshEdits: [bind(meshEdit)]})).toThrow('JOB_ACT_SOURCE_STALE');
    const linkedEdit = {...meshEdit, source: {...meshEdit.source, hash: api.jobHash(attachmentHashText(linked))}};
    expect(() => finalize({...meshRequest, meshEdits: [bind(linkedEdit)]})).toThrow('JOB_ACT_INVALID');
  } finally { await f.close(); }
});
