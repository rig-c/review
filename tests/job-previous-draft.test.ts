import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync, truncateSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {finalizeJobAct} from '../src/job-act.ts';
import {commentsActForEmission, createJobHostPorts, jobHash} from '../src/job-api.ts';
import type {JobUISubmission} from '../src/job-contract.ts';
import {JOB_COMMENTS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, JOB_PREVIOUS_DRAFT_SCHEMA, parseCommentsAct, parseContextCommentsAct,
  type JobPreviousDraft, type JobPublishedContext} from '../src/job-host.ts';
import {assertStoredCheckpointEvidence, readPreviousDraftBytes} from '../src/job-source.ts';
import {JobSession} from '../src/job-session.ts';
import {loadJobReview} from '../src/manifest.ts';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';
import {partsDifferenceJobFixture} from './helpers/parts-difference-job-fixture.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader, makeSyntheticPngBytes,
  writeWorkspaceFile} from './helpers/job-record-fixture.ts';

type Fixture = Awaited<ReturnType<typeof jobFixture>>;
const cleanups: Fixture[] = [];
afterEach(async () => { for (const f of cleanups.splice(0)) await f.close(); });

async function fixture() {
  const f = await jobFixture();
  cleanups.push(f);
  const parts = await syntheticJobParts(f, {project: true});
  const manifest = writeWorkspaceFile(f.root, parts.manifest.path, JSON.stringify({rig_size: [2, 2]}));
  const current = writeWorkspaceFile(f.root, 'current/render/recomposite_rig.png', makeSyntheticPngBytes());
  const previousRaster = PNG.sync.read(makeSyntheticPngBytes());
  previousRaster.data[3] = 91;
  const previous = writeWorkspaceFile(f.root, 'previous/render/recomposite_rig.png', PNG.sync.write(previousRaster));
  const previousDraft: JobPreviousDraft = {schema: JOB_PREVIOUS_DRAFT_SCHEMA,
    draft: {id: 'accepted-draft', revision: 'b'.repeat(64)}, composites: {current, previous}};
  const context: JobPublishedContext = {...f.getContext(), parts: {...parts, manifest}, files: [current, previous], previousDraft};
  f.setContext(context);
  return {f, context, previousDraft};
}

function withCurrent({context, previousDraft}: Awaited<ReturnType<typeof fixture>>, current: JobPreviousDraft['composites']['current']) {
  return {...context, files: [current, previousDraft.composites.previous],
    previousDraft: {...previousDraft, composites: {...previousDraft.composites, current}}};
}

function withDiff({f, context, previousDraft}: Awaited<ReturnType<typeof fixture>>, bytes: Buffer | string) {
  const diff = writeWorkspaceFile(f.root, 'evidence/diff.json', bytes);
  return {...context, files: [...context.files, diff], previousDraft: {...previousDraft, diff}};
}

const refusalPlants: {detail: string; plant: (setup: Awaited<ReturnType<typeof fixture>>) => JobPublishedContext}[] = [
  {detail: 'INVALID', plant: s => withCurrent(s, {...s.previousDraft.composites.current, path: '../outside.png'})},
  {detail: 'SELECTOR', plant: ({context}) => ({...context, selector: {kind: 'rig', version: 1}})},
  {detail: 'SELF', plant: ({context, previousDraft}) => ({...context, previousDraft: {...previousDraft,
    draft: {...previousDraft.draft, id: 'synthetic-draft'}}})},
  {detail: 'UNSEALED operand=current', plant: ({context, previousDraft}) => ({...context, files: [
    {...previousDraft.composites.current, sha256: '1'.repeat(64)}, previousDraft.composites.previous]})},
  {detail: 'MISSING operand=current path="current/render/recomposite_rig.png"', plant: ({f, context, previousDraft}) => {
    unlinkSync(join(f.root, previousDraft.composites.current.path));
    return context;
  }},
  {detail: 'HASH_MISMATCH operand=current', plant: ({f, context, previousDraft}) => {
    writeWorkspaceFile(f.root, previousDraft.composites.current.path, makeSyntheticPngBytes(55));
    return context;
  }},
  {detail: 'PNG_INVALID operand=current', plant: s => {
    const rgba = PNG.sync.read(makeSyntheticPngBytes());
    return withCurrent(s, writeWorkspaceFile(s.f.root, s.previousDraft.composites.current.path,
      PNG.sync.write(rgba, {colorType: 2, inputColorType: 6})));
  }},
  {detail: 'SIZE operand=current expected=2x2 received=3x3', plant: s => withCurrent(s,
    writeWorkspaceFile(s.f.root, s.previousDraft.composites.current.path, PNG.sync.write(new PNG({width: 3, height: 3}))))},
  {detail: 'LIMIT operand=current', plant: ({f, context, previousDraft}) => {
    truncateSync(join(f.root, previousDraft.composites.current.path), 64 * 1024 * 1024 + 1);
    return context;
  }},
  {detail: 'DIFF_INVALID', plant: s => withDiff(s, '{"schema":"rig-parts-draft-diff/1"}')},
];

async function expectRefusal(f: Fixture, detail: string) {
  const generation = f.session.status().generation;
  const response = await f.call(await f.publishRequest());
  const code = detail.startsWith('LIMIT') ? 'JOB_SOURCE_UNRETAINABLE' : 'JOB_SOURCE_MISMATCH';
  expect(await response.json()).toMatchObject({ok: false, error: {code, message: 'PREVIOUS_DRAFT_' + detail}});
  expect(f.session.status().generation).toBe(generation);
}

for (const {detail, plant} of refusalPlants) {
  test(`previous draft admission refuses PREVIOUS_DRAFT_${detail}`, async () => {
    const setup = await fixture();
    setup.f.setContext(plant(setup));
    await expectRefusal(setup.f, detail);
  });
}

test('previous draft declaration, decoded raster and diff each have a bound', async () => {
  const s = await fixture();
  s.f.setContext(withCurrent(s, {...s.previousDraft.composites.current, path: 'p'.repeat(4096)}));
  await expectRefusal(s.f, 'LIMIT operand=declaration');
  const wide = makeSyntheticPngBytes();
  wide.writeUInt32BE(16384, 16);
  wide.writeUInt32BE(16384, 20);
  s.f.setContext(withCurrent(s, writeWorkspaceFile(s.f.root, s.previousDraft.composites.current.path, wide)));
  await expectRefusal(s.f, 'LIMIT operand=current');
  writeWorkspaceFile(s.f.root, s.previousDraft.composites.current.path, makeSyntheticPngBytes());
  const diff = writeWorkspaceFile(s.f.root, 'evidence/diff.json', Buffer.alloc(1024 * 1024 + 1));
  s.f.setContext({...s.context, files: [...s.context.files, diff], previousDraft: {...s.previousDraft, diff}});
  await expectRefusal(s.f, 'LIMIT operand=diff');
});

test('sealed diff admits exact hash values at arbitrary object and array depths and preserves its bytes', async () => {
  const s = await fixture(), {current, previous} = s.previousDraft.composites;
  const schema = 'rig-parts-draft-diff/1', depth = 24_000;
  const bytes = Buffer.from(`{"schema":"${schema}","opaque":${'['.repeat(depth)}{"pair":["${current.sha256}",{"value":"${previous.sha256}"}]}${']'.repeat(depth)}}`);
  const context = withDiff(s, bytes);
  s.f.setContext(context);
  const publication = await s.f.publish(), retained = s.f.session.retainedSource(publication.publicationId);
  const diff = context.previousDraft.diff;
  expect(publication.source.previousDraft).toEqual(context.previousDraft);
  expect(retained.seals).toContainEqual(diff);
  expect(readPreviousDraftBytes(retained.snapshotRoot, diff, 'diff')).toEqual(bytes);
});

test('sealed diff refuses wrong schema, missing or inexact hash values, JSON keys alone and invalid UTF-8', async () => {
  const s = await fixture(), {current, previous} = s.previousDraft.composites;
  const schema = 'rig-parts-draft-diff/1';
  const hashes = [current.sha256, previous.sha256];
  for (const value of [
    {schema: 'rig-parts-draft-diff/2', hashes},
    {payload: {schema, hashes}},
    {schema, hashes: [previous.sha256]},
    {schema, hashes: [current.sha256, current.sha256]},
    {schema, hashes: [current.sha256, 'sha256:' + previous.sha256]},
    {schema, hashes: [current.sha256, previous.sha256.toUpperCase()]},
    {schema, [current.sha256]: previous.sha256},
    [{schema, hashes}],
  ]) {
    s.f.setContext(withDiff(s, JSON.stringify(value)));
    await expectRefusal(s.f, 'DIFF_INVALID');
  }
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff])]) {
    s.f.setContext(withDiff(s, bytes));
    await expectRefusal(s.f, 'DIFF_INVALID');
  }
});

for (const phase of ['inventory', 'retained'] as const) {
  test(`record publish refuses previousDraft returned by the ${phase} reader`, async () => {
    const {f, previousDraft} = await fixture();
    const root = join(f.scratch, 'plan');
    const record = createSyntheticPlanRecordWorkspace(root);
    const {reader, calls} = createSyntheticRecordReader({onPlan: input =>
      input.phase === phase ? {...record.context, previousDraft} : record.context});
    let packageReads = 0;
    const session = new JobSession({root, stateDir: join(f.scratch, 'record-state'), fingerprint: 'synthetic-record',
      reviewer: {id: 'owner', role: 'owner'}, readRecordPublished: reader, readPublished: async () => {
        packageReads++;
        return {...f.getContext(), previousDraft};
      }});
    try {
      const ports = createJobHostPorts(session, f.origin);
      const publish = {schema: 'rig-review/job-api@3', jobId: session.jobId, requestId: 'publish', verb: 'publish',
        expectedGeneration: 0, idempotencyKey: 'publish', result: record.result,
        freeze: {kind: 'producer-held', holdId: 'synthetic', record: record.record}};
      const send = async (body: unknown) => (await ports.handleJobApi(new Request(f.origin + `/jobs/${session.jobId}/api`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.hostCredentials().agent},
        body: JSON.stringify(body),
      }))).json();
      for (const invalid of [{...publish, previousDraft}, {...publish, result: {...publish.result, previousDraft}},
        {...publish, freeze: {...publish.freeze, previousDraft}}]) {
        expect(await send(invalid)).toMatchObject({ok: false, error: {code: 'JOB_REQUEST_INVALID', message: 'JOB_REQUEST_INVALID'}});
      }
      expect(calls).toHaveLength(0);
      expect(await send(publish)).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH', message: 'PREVIOUS_DRAFT_SELECTOR'}});
      expect(calls.map(call => call.phase)).toEqual(phase === 'inventory' ? ['inventory'] : ['inventory', 'retained']);
      expect(packageReads).toBe(0);
      expect(session.status().generation).toBe(0);
    } finally { session.dispose(); }
  });
}

test('previous draft identity is declared, digested and retained with the same file seals', async () => {
  const {f, context, previousDraft} = await fixture();
  expect(JOB_PREVIOUS_DRAFT_SCHEMA).toBe('rig-review-previous-draft/1');
  const first = await f.publish(), retained = f.session.retainedSource(first.publicationId);
  const review = await loadJobReview(retained.manifestPath, f.root);
  const preimage = {schema: 'rig-review-job-source/2', packageSourceHash: review.sourceHash, record: retained.record,
    selector: first.source.selector, plan: first.source.plan, parts: first.source.parts, files: retained.seals};
  expect(first.source.previousDraft).toEqual(previousDraft);
  expect(first.source.sourceHash).toBe(jobHash(JSON.stringify({...preimage, previousDraft})));
  const {previousDraft: _removed, ...legacyContext} = context;
  f.setContext(legacyContext);
  const legacy = await f.publish();
  expect(legacy.source).not.toHaveProperty('previousDraft');
  expect(legacy.source.sourceHash).toBe(jobHash(JSON.stringify(preimage)));
  const changed = {...previousDraft, draft: {...previousDraft.draft, revision: 'c'.repeat(64)}};
  f.setContext({...context, previousDraft: changed});
  const revised = await f.publish();
  expect(revised.source.sourceHash).toBe(jobHash(JSON.stringify({...preimage, previousDraft: changed})));
  expect(revised.instanceKey).not.toBe(first.instanceKey);
  expect(f.session.retainedSource(revised.publicationId).seals).toEqual(retained.seals);
  expect(() => assertStoredCheckpointEvidence({...retained, source: {...retained.source, previousDraft: changed}})).toThrow();
  for (const operand of ['current', 'previous'] as const) {
    const file = previousDraft.composites[operand];
    expect(retained.seals).toContainEqual(file);
    expect(readPreviousDraftBytes(retained.snapshotRoot, file, operand)).toEqual(readFileSync(join(f.root, file.path)));
  }
  const file = previousDraft.composites.previous;
  writeFileSync(join(retained.snapshotRoot, file.path), makeSyntheticPngBytes(12));
  expect(() => readPreviousDraftBytes(retained.snapshotRoot, file, 'previous')).toThrow('PREVIOUS_DRAFT_HASH_MISMATCH operand=previous');
});

async function partsAct(f: Fixture) {
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-draft'});
  const retained = f.session.retainedSource(publication.publicationId);
  const crop = makeSyntheticPngBytes(), sha256 = jobHash(crop);
  const issue = {schema: 'rig-review-parts-comment/2', id: 'diff-pin', summary: '  한글\nexact  ',
    parts: [{name: 'body', imageHash: publication.source.parts!.images.find(image => image.path === 'parts/body.png')!.sha256}],
    sourceHash: publication.source.sourceHash, imageRegion: null, rigRegion: {x: 0, y: 0, width: 2, height: 2},
    view: {mode: 'assembled', camera: {zoom: 1, center: {x: 1, y: 1}, viewport: {width: 2, height: 2}},
      cameraSync: false, referenceCamera: null, background: 'checker', alpha: false, footprints: false, mesh: false},
    crop: {path: `comment-crops/${sha256}.png`, sha256, width: 2, height: 2}, nativeCrop: null};
  function write(comparison: unknown, source = retained) {
    const submission = {publicationId: publication.publicationId, askId: ask.askId, pageId: 'page', displayedNonce: 'nonce',
      expectedGeneration: publication.generation, submissionId: 'submit', kind: 'parts-verdict',
      value: {verdict: 'changes-requested', issues: [{...issue, view: {...issue.view, comparison}}], words: ''}} as JobUISubmission;
    const act = finalizeJobAct({jobId: f.session.jobId, submission, ask, retained: source, reviewer: {id: 'owner', role: 'owner'}});
    if (act.schema !== JOB_COMMENTS_ACT_SCHEMA || act.kind !== 'parts-verdict') throw new Error('Expected Parts comments act');
    return act;
  }
  return {write, retained};
}

test('legacy and previous-draft comments round-trip through writers and both public act decoders', async () => {
  const {f, context, previousDraft} = await fixture();
  const painting = {mode: 'difference', opacity: 0.5, threshold: 2};
  const comparison = {...painting, operand: 'previous-draft'};
  const current = await partsAct(f);
  const act = parseCommentsAct(current.write(comparison));
  if (act.kind !== 'parts-verdict' || 'record' in act.source) throw new Error('Expected Parts comments act');
  expect(act.source.previousDraft).toEqual(previousDraft);
  expect(act.value.comments[0]).toMatchObject({text: '  한글\nexact  ', anchor: {view: {comparison}}});
  const contextAct = parseContextCommentsAct({...act, schema: JOB_COMMENT_CONTEXT_ACT_SCHEMA});
  expect(commentsActForEmission(contextAct, false)).toEqual(act);
  const {previousDraft: _removed, ...legacySource} = act.source;
  expect(() => parseCommentsAct({...act, source: legacySource})).toThrow('JOB_ACT_INVALID');
  expect(() => parseContextCommentsAct({...contextAct, source: legacySource})).toThrow('JOB_ACT_INVALID');
  const forged = {...current.retained, source: {...current.retained.source,
    previousDraft: {...previousDraft, draft: {...previousDraft.draft, revision: 'a'.repeat(64)}}}};
  expect(() => current.write(comparison, forged)).toThrow('JOB_ACT_SOURCE_STALE');
  const {previousDraft: _unused, ...legacyContext} = context;
  f.setContext(legacyContext);
  const legacy = await partsAct(f), old = legacy.write(painting);
  expect(parseCommentsAct(old)).toEqual(old);
  expect(old.source).not.toHaveProperty('previousDraft');
  expect(old.value).toMatchObject({comments: [{anchor: {view: {comparison: painting}}}]});
  expect(() => legacy.write(comparison)).toThrow('JOB_ACT_INVALID');
});

test('standing owner prepares and commits a previous-draft pin without painting in rig and preserves durable copies', async () => {
  const f = await partsDifferenceJobFixture({declared: false, previousDraft: true});
  const previousState = process.env.RIG_REVIEW_STATE_DIR;
  process.env.RIG_REVIEW_STATE_DIR = join(f.input.scratch, 'crop-state');
  try {
    const {publication, host} = f, {session} = host;
    const subject = {kind: 'parts-verdict', draftId: 'synthetic-parts'} as const;
    const ask = await f.ask(publication, subject);
    const response = await f.ui('displayed', {publicationId: publication.publicationId, sourceHash: publication.source.sourceHash,
      pageId: 'previous-draft-page'});
    expect(response.status).toBe(200);
    const page = (await response.json()).value;
    const comparison = {mode: 'difference', opacity: 0.5, threshold: 0, operand: 'previous-draft'};
    const crop = makeSyntheticPngBytes(), sha256 = jobHash(crop);
    const prepare = await fetch(f.api + 'stage-parts/comment', {method: 'POST', headers: {'Content-Type': 'application/json',
      Origin: host.origin, 'X-Review-Capability': f.credentials.ui}, body: JSON.stringify({
      schema: 'rig-review-parts-comment/2', id: 'retained-pin', summary: '  changed edge\n', sourceHash: publication.source.sourceHash,
      parts: [{name: 'body', imageHash: publication.source.parts!.images.find(file => file.path === 'parts/body.png')!.sha256}],
      imageRegion: null, rigRegion: {x: f.source.body.x, y: f.source.body.y, width: 2, height: 2},
      view: {mode: 'assembled', comparison, camera: {zoom: 1, center: {x: 16, y: 12}, viewport: {width: 32, height: 24}},
        referenceCamera: null, cameraSync: false, background: 'checker', alpha: false, footprints: false, mesh: false},
      crop: {path: `comment-crops/${sha256}.png`, sha256, width: 2, height: 2, png: `data:image/png;base64,${crop.toString('base64')}`},
      nativeCrop: null,
    })});
    expect(prepare.status).toBe(200);
    const prepared = await prepare.json();
    const submission = {...page, askId: ask.askId, expectedGeneration: session.status().generation, submissionId: 'pinned-act',
      kind: 'parts-verdict', value: {verdict: 'changes-requested', issues: [prepared.comment], words: ''}};
    const committed = await f.ui('acts', submission);
    expect(committed.status).toBe(200);
    const act = parseCommentsAct((await committed.json()).value);
    expect(act.source).toMatchObject({previousDraft: f.previousDraft});
    expect(act.value.comments[0]).toMatchObject({text: '  changed edge\n', anchor: {view: {comparison}}});
    const reopened = JobSession.openReadOnly(f.hostOptions, session.jobId);
    try {
      expect(await reopened.commitUIAct(submission)).toEqual(act);
      expect(JSON.parse(reopened.readActExport(act.actId, false).toString())).toEqual(act);
    } finally { reopened.dispose(); }
    assertPreviousDraftCopiesRejectTampering(f.input.state, session, publication.publicationId, ask.askId, act.actId);
    const route = f.api + 'stage-parts/difference/0?threshold=0&footprints=false&operand=previous-draft';
    const raster = await fetch(route);
    expect(raster.status).toBe(200);
    expect(raster.headers.has('X-Difference-Count')).toBe(false);
    await raster.arrayBuffer();
    const retained = session.retainedSource(publication.publicationId);
    const previous = f.previousDraft!.composites.previous;
    writeFileSync(join(retained.snapshotRoot, previous.path), makeSyntheticPngBytes());
    const denied = await fetch(route);
    expect(denied.status).toBe(409);
    expect((await denied.json()).error).toMatchObject({message: 'PREVIOUS_DRAFT_HASH_MISMATCH operand=previous'});
    expect(await session.commitUIAct(submission)).toEqual(act);
    await expect(f.ask(publication, subject)).rejects.toThrow('JOB_SOURCE_UNRETAINABLE');
  } finally {
    if (previousState === undefined) delete process.env.RIG_REVIEW_STATE_DIR;
    else process.env.RIG_REVIEW_STATE_DIR = previousState;
    await f.close();
  }
});

function assertPreviousDraftCopiesRejectTampering(state: string, session: JobSession, publicationId: string, askId: string, actId: string) {
  const db = new Database(join(state, 'jobs.sqlite'));
  try {
    const row = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(session.jobId)!;
    const update = db.query('UPDATE jobs SET document=? WHERE job_id=?');
    const stored = JSON.parse(row.document);
    const copies = [stored.publications[publicationId].retained, stored.publications[publicationId].publication,
      stored.asks[askId], stored.acts[actId], ...stored.events.map((event: any) => event.publication ?? event.ask ?? event.act),
      ...Object.values(stored.replays).map((replay: any) => replay.value)];
    for (const copy of copies) {
      expect(copy.source.previousDraft).toEqual(stored.publications[publicationId].retained.source.previousDraft);
      const declaration = copy.source.previousDraft;
      delete copy.source.previousDraft;
      try {
        update.run(JSON.stringify(stored), session.jobId);
        expect(() => session.status()).toThrow('JOB_SOURCE_MISMATCH');
        expect(() => session.readActExport(actId, false)).toThrow('JOB_SOURCE_MISMATCH');
      } finally {
        copy.source.previousDraft = declaration;
        update.run(row.document, session.jobId);
      }
    }
  } finally { db.close(); }
}
