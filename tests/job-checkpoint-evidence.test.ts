import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, symlinkSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {JobCheckpointEvidence, PlanContext, JobPublication, PublicationV3} from '../src/job-contract.ts';
import {JOB_RECORD_READER_ID} from '../src/job-contract.ts';
import {checkpointEvidenceFields, checkpointEvidenceMetadata, parseCheckpointTable} from '../src/job-checkpoint-evidence.ts';
import {assertEqualRecordContexts, buildRecordSource, createJobHostPorts, jobHash, parseRecordPublishedContext,
  parseRecordSource, serializeRecordSourceDigestPayload, parseRecordAct} from '../src/job-api.ts';
import {assertStoredCheckpointEvidence, captureJobRoot, prepareJobRecordSource, verifyJobRecordSourceFresh} from '../src/job-source.ts';
import {retainedPublicationRoutes} from '../src/job-front.ts';
import {JobSession} from '../src/job-session.ts';
import {JobError} from '../src/job-store.ts';
import {loadReview} from '../src/manifest.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticOptionRecordWorkspace, createSyntheticRecordReader,
  makeSyntheticPngBytes, writeWorkspaceFile} from './helpers/job-record-fixture.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
function temp() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'review629-synthetic-')));
  cleanups.push(() => rmSync(path, {recursive: true, force: true}));
  return path;
}
async function packageFixture() {
  const f = await jobFixture();
  cleanups.push(() => f.close());
  return f;
}
function evidence(root: string, checkpointId = 'step-one', planStepId = checkpointId) {
  const tiles = Array.from({length: 4}, (_, index) => ({id: `pair-${index}`, label: `Pair ${index} frame 0 / worst <marked>`,
    ...writeWorkspaceFile(root, `evidence/pair-${index}.png`, makeSyntheticPngBytes(index, 100, 200))}));
  const document = {schema: 'rig-review-checkpoint-table/1', columns: ['Pair', 'Frame', 'Classification', 'Accepted'],
    rows: Array.from({length: 103}, (_, index) => [`pair-${102 - index}`, index, index === 0 ? '<script>& 한글\nraw' : 'FAIL', index % 2 === 0])};
  const table = {...writeWorkspaceFile(root, 'evidence/table.json', JSON.stringify(document)), label: 'Full ordered table'};
  const packet: JobCheckpointEvidence = {schema: 'rig-review-checkpoint-evidence/1', checkpointId, planStepId,
    tiles, table, routesText: '(i) accept\n(ii) repair\n(iii) stop', recommendationText: 'Prefer (ii)\nraw producer FAIL'};
  return {packet, document, files: [...tiles.map(({path, sha256}) => ({path, sha256})), {path: table.path, sha256: table.sha256}]};
}
function contextWithEvidence(f: Awaited<ReturnType<typeof packageFixture>>, packet = evidence(f.root)) {
  const context = {...f.getContext(), checkpointEvidence: [packet.packet], files: packet.files};
  f.setContext(context);
  return {context, ...packet};
}
function recordFixture() {
  const root = temp(), state = temp();
  const fixture = createSyntheticPlanRecordWorkspace(root);
  const packet = evidence(root, 'step_layout');
  let context: PlanContext = {...fixture.context, checkpointEvidence: [packet.packet],
    files: [...fixture.files, ...packet.files].sort((a, b) => a.path < b.path ? -1 : 1)};
  const {reader} = createSyntheticRecordReader({onPlan: () => structuredClone(context)});
  const options = {root, stateDir: state, fingerprint: 'record-evidence', reviewer: {id: 'owner', role: 'owner' as const},
    publicationMode: 'record-and-package' as const, recordReaderId: JOB_RECORD_READER_ID, readRecordPublished: reader};
  const session = new JobSession(options);
  cleanups.push(() => session.dispose());
  const request = {schema: 'rig-review/job-api@3' as const, jobId: session.jobId, requestId: 'publish', verb: 'publish' as const,
    expectedGeneration: 0, idempotencyKey: 'publish', freeze: {kind: 'producer-held' as const, holdId: 'synthetic', record: fixture.record},
    result: fixture.result};
  return {root, state, fixture, packet, reader, options, session, request,
    context: () => context, setContext: (value: PlanContext) => {context = value;}};
}
async function metadata(session: JobSession, publication: JobPublication | PublicationV3, path = 'api/review') {
  const routes = retainedPublicationRoutes(session);
  return routes(session.jobId, publication.publicationId, publication.instanceKey, path,
    new Request('http://127.0.0.1/' + path));
}
function tamper(state: string, jobId: string, mutate: (value: any) => void) {
  const db = new Database(join(state, 'jobs.sqlite'));
  try {
    const row = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(jobId)!;
    const document = JSON.parse(row.document);
    mutate(document);
    db.query('UPDATE jobs SET document=? WHERE job_id=?').run(JSON.stringify(document), jobId);
  } finally {db.close();}
}

test('optional declarations omit legacy fields and preserve literal record digest bytes', async () => {
  const root = temp(), f = createSyntheticPlanRecordWorkspace(root);
  const source = buildRecordSource({record: f.record, selection: f.result, context: f.context});
  const historical = JSON.stringify({schema: 'rig-review-job-record-source/1', record: f.record,
    selection: {kind: 'plan'}, inputs: f.context.inputs, optionSet: null, optionSetFile: null,
    plan: f.context.plan, subjects: f.context.subjects, files: f.context.files});
  expect(serializeRecordSourceDigestPayload(source)).toBe(historical);
  expect(source.sourceHash).toBe(jobHash(historical));
  expect(parseRecordSource(source)).toEqual(source);
  expect(Object.hasOwn(source, 'checkpointEvidence')).toBe(false);
  expect(Object.hasOwn(parseRecordPublishedContext(f.context, f.result), 'checkpointEvidence')).toBe(false);
  expect(checkpointEvidenceFields({}, null, [], [])).toEqual({});
  const pkg = await packageFixture(), publication = await pkg.publish();
  const retained = pkg.session.retainedSource(publication.publicationId), review = await loadReview(retained.manifestPath);
  const expected = jobHash(JSON.stringify({schema: 'rig-review-job-source/2', packageSourceHash: review.sourceHash,
    record: retained.record, selector: retained.source.selector, plan: retained.source.plan, parts: null, files: retained.seals}));
  expect(publication.source.sourceHash).toBe(expected);
  expect(Object.hasOwn(publication.source, 'checkpointEvidence')).toBe(false);
  expect(Object.hasOwn(await (await metadata(pkg.session, publication)).json(), 'checkpointEvidence')).toBe(false);
  expect((await metadata(pkg.session, publication, 'api/checkpoint-evidence/step-one/tiles/0')).status).toBe(404);
});

test('metadata-only edits change package identity with identical sealed asset bytes', async () => {
  const f = await packageFixture(), {context} = contextWithEvidence(f);
  const first = await f.publish(), seals = f.session.retainedSource(first.publicationId).seals;
  for (const mutate of [
    (p: any) => {p.tiles[0].label += '!';},
    (p: any) => {p.table.label += '!';},
    (p: any) => {p.routesText += '!';},
    (p: any) => {p.recommendationText += '!';},
    (p: any) => {p.tiles.reverse();},
  ]) {
    const changed = structuredClone(context); mutate(changed.checkpointEvidence[0]); f.setContext(changed);
    const next = await f.publish();
    expect(next.source.sourceHash).not.toBe(first.source.sourceHash);
    expect(next.instanceKey).not.toBe(first.instanceKey);
    expect(f.session.retainedSource(next.publicationId).seals).toEqual(seals);
  }
});

test('canonical declaration key order ignores input object order while preserving exact text', () => {
  const root = temp(), {packet, files} = evidence(root);
  const plan = {steps: [{id: 'step-one', hash: '1'.repeat(64)}]}, subjects = [{kind: 'checkpoint' as const, checkpointId: 'step-one'}];
  const reordered = Object.fromEntries(Object.entries(packet).reverse());
  const parsed = checkpointEvidenceFields({checkpointEvidence: [reordered]}, plan, subjects, files);
  expect(JSON.stringify(parsed.checkpointEvidence)).toBe(JSON.stringify([packet]));
});

test('closed declaration keys, required fields, null/undefined, duplicate IDs, association and literal paths refuse', () => {
  const {packet, files} = evidence(temp());
  const plan = {steps: [{id: 'step-one', hash: '1'.repeat(64)}]}, subjects = [{kind: 'checkpoint' as const, checkpointId: 'step-one'}];
  for (const raw of [undefined, null, [], [packet, packet], [{...packet, routes: []}],
    [{...packet, routesText: undefined}], [{...packet, checkpointId: 'other'}], [{...packet, planStepId: 'other'}],
    [{...packet, tiles: [packet.tiles[0], packet.tiles[0]]}], [{...packet, table: {...packet.table, rows: []}}],
    [{...packet, table: {...packet.table, label: undefined}}], [{...packet, table: {...packet.table, label: null}}],
    [{...packet, recommendationText: 'x'.repeat(4097)}]]) {
    expect(() => checkpointEvidenceFields({checkpointEvidence: raw}, plan, subjects, files)).toThrow('CHECKPOINT_EVIDENCE_INVALID');
  }
  for (const path of ['../escape.png', '/absolute.png', 'https://example/image', 'a\\b', 'a//b', 'a/%2e', 'a?x', 'a#x']) {
    expect(() => checkpointEvidenceFields({checkpointEvidence: [{...packet, table: {...packet.table, path}}]}, plan, subjects, files)).toThrow();
  }
  for (const key of Object.keys(packet)) {
    const copy: any = {...packet}; delete copy[key];
    expect(() => checkpointEvidenceFields({checkpointEvidence: [copy]}, plan, subjects, files)).toThrow();
  }
  expect(() => checkpointEvidenceFields({checkpointEvidence: [packet]}, plan, subjects, [])).toThrow();
});

test('package checkpoint aliases follow admitted subject mapping and daemon derives planStepId', async () => {
  const f = await packageFixture(), packet = evidence(f.root, 'motion-card', 'step-one');
  const {context} = contextWithEvidence(f, packet);
  f.setContext({...context, subjects: [{kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}]});
  const publication = await f.publish(), ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'});
  const page = await f.display(publication);
  const submission = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation, submissionId: 'alias',
    kind: 'checkpoint', value: {checkpointId: 'motion-card', outcome: 'fail' as const, words: '  (iii)\nverbatim 한글  '}};
  const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.value.value).toEqual({...submission.value, planStepId: 'step-one'});
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...submission, submissionId: 'forged',
    value: {...submission.value, planStepId: 'step-one'}}))).toMatchObject({ok: false});
});

test('retained metadata delivers all 103 rows and four exact pinned tiles after live drift', async () => {
  const f = await packageFixture(), {packet, document, context} = contextWithEvidence(f), publication = await f.publish();
  writeFileSync(join(f.root, packet.table.path), '{}');
  f.setContext({...context, checkpointEvidence: [{...packet, recommendationText: 'new live text'}]});
  const response = await metadata(f.session, publication), body = await response.json();
  expect(response.status).toBe(200);
  expect(body.checkpointEvidence[0].table.rows).toEqual(document.rows);
  expect(body.checkpointEvidence[0].table.columns).toEqual(document.columns);
  expect(body.checkpointEvidence[0].table.rows.length).toBe(103);
  expect(body.checkpointEvidence[0].routesText).toBe(packet.routesText);
  expect(body.checkpointEvidence[0].recommendationText).toBe(packet.recommendationText);
  for (let index = 0; index < 4; index++) {
    const tile = body.checkpointEvidence[0].tiles[index];
    const image = await metadata(f.session, publication, tile.url.slice(1));
    expect(image.status).toBe(200);
    expect(jobHash(new Uint8Array(await image.arrayBuffer()))).toBe(packet.tiles[index]!.sha256);
  }
  for (const path of ['api/checkpoint-evidence/other/tiles/0', 'api/checkpoint-evidence/step-one/tiles/4',
    'api/checkpoint-evidence/step-one/tiles/00', 'api/checkpoint-evidence/step-one/tiles/999999999999999999999']) {
    const refusal = await metadata(f.session, publication, path); expect(refusal.status).toBe(404); await refusal.text();
  }
});

test('sealed table validates bounds, scalar widths and preserves rows including null and empty strings', () => {
  const base = {schema: 'rig-review-checkpoint-table/1' as const, columns: ['c'], rows: [[null], [''], [true], [12.5], ['<b>']]};
  expect(parseCheckpointTable(Buffer.from(JSON.stringify(base)))).toEqual(base);
  for (const bad of [{...base, extra: 1}, {...base, schema: 'wrong'}, {...base, columns: []}, {...base, columns: Array(33).fill('x')},
    {...base, rows: [[{}]]}, {...base, rows: [[[]]]}, {...base, rows: [[]]}, {...base, rows: [[1, 2]]},
    {...base, rows: [['x'.repeat(2049)]]}, {...base, rows: Array(2049).fill([1])},
    {...base, columns: Array(32).fill('x'), rows: Array(513).fill(Array(32).fill(null))}]) {
    expect(() => parseCheckpointTable(Buffer.from(JSON.stringify(bad)))).toThrow('CHECKPOINT_EVIDENCE_TABLE_INVALID');
  }
  for (const bytes of [Buffer.from('x'.repeat(256 * 1024 + 1)), Buffer.from('{"schema":"rig-review-checkpoint-table/1","columns":["c"],"rows":[[1e999]]}'),
    Buffer.from([0xff])]) expect(() => parseCheckpointTable(bytes)).toThrow('CHECKPOINT_EVIDENCE_TABLE_INVALID');
});

test('regular files, no symlinks, actual hash and full PNG decoding are enforced', () => {
  const root = temp(), {packet} = evidence(root), tile = packet.tiles[0]!;
  writeFileSync(join(root, tile.path), 'changed');
  expect(() => checkpointEvidenceMetadata(root, [packet])).toThrow('CHECKPOINT_EVIDENCE_HASH_MISMATCH');
  unlinkSync(join(root, tile.path)); symlinkSync(join(root, packet.tiles[1]!.path), join(root, tile.path));
  expect(() => checkpointEvidenceMetadata(root, [packet])).toThrow('CHECKPOINT_EVIDENCE_PATH_REFUSED');
  unlinkSync(join(root, tile.path)); mkdirSync(join(root, tile.path));
  expect(() => checkpointEvidenceMetadata(root, [packet])).toThrow('CHECKPOINT_EVIDENCE_PATH_REFUSED');
  rmSync(join(root, tile.path), {recursive: true});
  const bytes = makeSyntheticPngBytes(); bytes[bytes.length - 1] ^= 1; writeFileSync(join(root, tile.path), bytes);
  expect(() => checkpointEvidenceMetadata(root, [{...packet, tiles: [{...tile, sha256: jobHash(bytes)}]}])).toThrow('CHECKPOINT_EVIDENCE_PNG_INVALID');
});

test('record normalization, source parser and digest retain declaration and reject metadata drift and aliases', () => {
  const f = recordFixture(), context = f.context();
  const parsed = parseRecordPublishedContext(context, f.fixture.result, f.fixture.record);
  const source = buildRecordSource({record: f.fixture.record, selection: f.fixture.result, context: parsed});
  expect(parseRecordSource(source)).toEqual(source);
  expect(parsed.checkpointEvidence).toEqual(context.checkpointEvidence);
  const changed = {...context, checkpointEvidence: [{...f.packet.packet, routesText: 'different routes'}]};
  const next = buildRecordSource({record: f.fixture.record, selection: f.fixture.result, context: changed});
  expect(next.sourceHash).not.toBe(source.sourceHash);
  expect(() => assertEqualRecordContexts(context, changed)).toThrow();
  expect(() => parseRecordSource({...source, checkpointEvidence: changed.checkpointEvidence})).toThrow();
  expect(() => parseRecordPublishedContext({...context, checkpointEvidence: [{...f.packet.packet, checkpointId: 'alias'}]}, f.fixture.result)).toThrow();
  for (const key of Object.keys(context)) {
    if (key === 'checkpointEvidence') continue;
    const copy: any = {...context}; delete copy[key];
    expect(() => parseRecordPublishedContext(copy, f.fixture.result)).toThrow();
  }
  for (const value of [undefined, null, []]) {
    expect(() => parseRecordPublishedContext({...context, checkpointEvidence: value}, f.fixture.result)).toThrow();
    expect(() => parseRecordSource({...source, checkpointEvidence: value})).toThrow();
    expect(() => serializeRecordSourceDigestPayload({...source, checkpointEvidence: value} as any)).toThrow();
  }
  const option = createSyntheticOptionRecordWorkspace(temp());
  expect(() => parseRecordPublishedContext({...option.context, checkpointEvidence: [f.packet.packet]}, option.result)).toThrow();
});

test('record two-phase evidence mismatch refuses and fresh mutations detect metadata-only changes', async () => {
  const f = recordFixture();
  const mismatched = createSyntheticRecordReader({onPlan: input => ({...f.context(), checkpointEvidence: [{...f.packet.packet,
    recommendationText: input.phase === 'inventory' ? 'first' : 'second'}]})}).reader;
  await expect(prepareJobRecordSource({root: captureJobRoot(f.root), stateRoot: f.state, fingerprint: 'f',
    request: f.request, readRecordPublished: mismatched})).rejects.toThrow();
  const publication = await f.session.execute(f.request, new AbortController().signal) as PublicationV3;
  const retained = f.session.retainedSourceV3(publication.publicationId);
  if (!('kind' in retained)) throw new Error('record expected');
  f.setContext({...f.context(), checkpointEvidence: [{...f.packet.packet, recommendationText: 'changed live metadata'}]});
  await expect(verifyJobRecordSourceFresh({retained, readRecordPublished: f.reader, phase: 'finalize'})).rejects.toThrow('JOB_ACT_SOURCE_STALE');
  await expect(f.session.execute({...f.request, verb: 'ask', requestId: 'ask', idempotencyKey: 'ask', expectedGeneration: 1,
    publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step_layout'}}, new AbortController().signal)).rejects.toThrow();
});

for (const outcome of ['pass', 'fail'] as const) test(`record ${outcome} commits normal owner words, reopens and retries exact act after live output drift`, async () => {
  const f = recordFixture(), signal = new AbortController().signal;
  const publication = await f.session.execute(f.request, signal) as PublicationV3;
  const ask = await f.session.execute({...f.request, verb: 'ask', requestId: 'ask', idempotencyKey: 'ask', expectedGeneration: 1,
    publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step_layout'}}, signal) as any;
  const ports = createJobHostPorts(f.session, 'http://127.0.0.1:19484');
  const ack = await ports.ackDisplayed(f.session.jobId, new Request(`http://127.0.0.1:19484/jobs/${f.session.jobId}/ui/displayed`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://127.0.0.1:19484', 'X-Review-Capability': f.session.hostCredentials().ui},
    body: JSON.stringify({publicationId: publication.publicationId, pageId: 'page', sourceHash: publication.source.sourceHash})}));
  if (!ack.ok) throw new Error(JSON.stringify(ack));
  const submission = {...ack.value, askId: ask.askId, expectedGeneration: f.session.status().generation, submissionId: `owner-${outcome}`,
    kind: 'checkpoint', value: {checkpointId: 'step_layout', outcome, words: '  owner 한글\nunchanged  '}};
  const act = await f.session.commitUIAct(submission);
  expect(act.value).toEqual({...submission.value, planStepId: 'step_layout'});
  if (act.schema !== 'rig-review/act@4') throw new Error('record act expected');
  expect(parseRecordAct(act)).toEqual(act);
  const body = await (await metadata(f.session, publication)).json();
  expect(body.checkpointEvidence[0].table.rows).toEqual(f.packet.document.rows);
  expect(body.recordSource.checkpointEvidence).toEqual([f.packet.packet]);
  writeFileSync(join(f.root, f.packet.packet.table.path), '{}');
  f.setContext({...f.context(), checkpointEvidence: [{...f.packet.packet, recommendationText: 'new live text'}]});
  const reopened = new JobSession(f.options), readonly = JobSession.openReadOnly(f.options, f.session.jobId);
  cleanups.push(() => reopened.dispose(), () => readonly.dispose());
  expect(await reopened.commitUIAct(submission)).toEqual(act);
  expect(await readonly.commitUIAct(submission)).toEqual(act);
  expect(await reopened.execute({...f.request, requestId: 'retry-publication'}, signal)).toEqual(publication);
  expect(await reopened.execute({schema: 'rig-review/job-api@3', jobId: f.session.jobId, requestId: 'fetch', verb: 'fetch-act', actId: act.actId}, signal)).toEqual(act);
  expect(JSON.parse(reopened.readActExport(act.actId, false).toString())).toEqual(act);
  const events = await reopened.execute({schema: 'rig-review/job-api@3', jobId: f.session.jobId, requestId: 'next', verb: 'next', after: null, waitMs: 0}, signal) as any;
  expect(events.events.find((event: any) => event.type === 'act').act).toEqual(act);
  await expect(reopened.commitUIAct({...submission, submissionId: 'fresh'})).rejects.toThrow();
});

for (const target of ['retained', 'publication', 'context', 'event', 'replay', 'ask', 'act'] as const) {
  test(`stored record evidence corruption in ${target} refuses reads and exact retry`, async () => {
    const f = recordFixture(), signal = new AbortController().signal;
    const publication = await f.session.execute(f.request, signal) as PublicationV3;
    const askRequest = {...f.request, verb: 'ask' as const, requestId: 'ask', idempotencyKey: 'ask', expectedGeneration: 1,
      publicationId: publication.publicationId, subject: {kind: 'checkpoint' as const, checkpointId: 'step_layout'}};
    const ask: any = await f.session.execute(askRequest, signal);
    // Only ordinary tests construct deliberate persisted-corruption controls.
    tamper(f.state, f.session.jobId, data => {
      const stored = data.publications[publication.publicationId];
      if (target === 'retained') stored.retained.source.checkpointEvidence[0].routesText = 'tampered';
      if (target === 'publication') delete stored.publication.source.checkpointEvidence;
      if (target === 'context') stored.retained.context.checkpointEvidence[0].routesText = 'tampered';
      if (target === 'event') data.events[0].publication.source.checkpointEvidence[0].routesText = 'tampered';
      if (target === 'replay') data.replays['agent:publish'].value.source.checkpointEvidence[0].routesText = 'tampered';
      if (target === 'ask') data.asks[ask.askId].source.checkpointEvidence[0].routesText = 'tampered';
      if (target === 'act') data.acts.corrupt = {publicationId: publication.publicationId,
        source: {...stored.retained.source, checkpointEvidence: []}};
    });
    expect(() => f.session.status()).toThrow();
    await expect(f.session.execute(f.request, signal)).rejects.toThrow();
    expect(() => JobSession.openReadOnly(f.options, f.session.jobId)).toThrow();
  });
}

test('package retained evidence and base preimage cannot silently change or disappear on reopen', async () => {
  const f = await packageFixture(); contextWithEvidence(f);
  const publication = await f.publish(), retained = f.session.retainedSource(publication.publicationId);
  assertStoredCheckpointEvidence(retained);
  const changed = structuredClone(retained); (changed.source.checkpointEvidence![0] as any).recommendationText = 'tampered';
  expect(() => assertStoredCheckpointEvidence(changed)).toThrow();
  const missing: any = structuredClone(retained); delete missing.source.checkpointEvidence;
  expect(() => assertStoredCheckpointEvidence(missing)).toThrow();
  tamper(f.state, f.session.jobId, data => {data.publications[publication.publicationId].retained.checkpointEvidencePackageHash = '0'.repeat(64);});
  expect(() => f.session.status()).toThrow();
});

test('API@3 package path keeps optional evidence and literal absent package source', async () => {
  const f = await packageFixture(), {packet} = contextWithEvidence(f);
  const options = {root: f.root, stateDir: temp(), fingerprint: 'mode3', reviewer: {id: 'owner', role: 'owner' as const},
    publicationMode: 'record-and-package' as const, readPublished: async () => f.getContext()};
  const session = new JobSession(options); cleanups.push(() => session.dispose());
  const original: any = await f.publishRequest();
  const request = {...original, schema: 'rig-review/job-api@3' as const, jobId: session.jobId,
    expectedGeneration: 0, result: {...original.result, kind: 'package' as const}};
  const publication = await session.execute(request, new AbortController().signal) as PublicationV3;
  expect(publication.source.checkpointEvidence).toEqual([packet]);
  const body = await (await metadata(session, publication)).json();
  expect(body.checkpointEvidence[0].table.rows.length).toBe(103);
  const context = f.getContext(); delete (context as any).checkpointEvidence; f.setContext(context);
  const absent = await session.execute({...request, requestId: 'absent', idempotencyKey: 'absent', expectedGeneration: 1},
    new AbortController().signal) as PublicationV3;
  expect(Object.hasOwn(absent.source, 'checkpointEvidence')).toBe(false);
  const retained = session.retainedSource(absent.publicationId), review = await loadReview(retained.manifestPath);
  const historical = jobHash(JSON.stringify({schema: 'rig-review-job-source/2', packageSourceHash: review.sourceHash,
    record: retained.record, selector: retained.source.selector, plan: retained.source.plan, parts: null, files: retained.seals}));
  expect(absent.source.sourceHash).toBe(historical);
});

test('legacy record option source retains literal historical source and digest serialization', () => {
  const f = createSyntheticOptionRecordWorkspace(temp());
  const source = buildRecordSource({record: f.record, selection: f.result, context: f.context, optionSetFile: f.optionSetFile});
  const historical = JSON.stringify({schema: 'rig-review-job-record-source/1', record: f.record, selection: f.result,
    inputs: f.context.inputs, optionSet: {id: f.result.setId, sha256: f.optionSetFile.sha256}, optionSetFile: f.optionSetFile,
    plan: null, subjects: f.context.subjects, files: f.context.files});
  expect(serializeRecordSourceDigestPayload(source)).toBe(historical);
  expect(JSON.stringify(source)).toBe(JSON.stringify({sourceHash: jobHash(historical), projectHash: f.record.sha256, record: f.record,
    inputs: f.context.inputs, files: f.context.files, subject: 'option-set', selection: f.result,
    optionSet: {id: f.result.setId, sha256: f.optionSetFile.sha256}, optionSetFile: f.optionSetFile, plan: null, subjects: f.context.subjects}));
});

test('legacy reopen omits evidence when the live reader later offers it', async () => {
  const f = await packageFixture(), legacy = await f.publish(); contextWithEvidence(f);
  const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64), reviewer: {id: 'declared-owner', role: 'owner' as const},
    readPublished: async () => f.getContext()};
  const reopened = new JobSession(options); cleanups.push(() => reopened.dispose());
  expect(reopened.status().publication).toEqual(legacy);
  expect(Object.hasOwn(await (await metadata(reopened, legacy)).json(), 'checkpointEvidence')).toBe(false);
});

test('declaration count, byte, text and table aggregate bounds reject without truncation', () => {
  const root = temp(), {packet, files} = evidence(root);
  const plan = {steps: [{id: 'step-one', hash: '1'.repeat(64)}]}, subjects = [{kind: 'checkpoint' as const, checkpointId: 'step-one'}];
  for (const change of [
    {...packet, tiles: Array.from({length: 9}, (_, i) => ({...packet.tiles[0], id: `tile-${i}`}))},
    {...packet, tiles: [{...packet.tiles[0], label: 'x'.repeat(513)}]},
    {...packet, routesText: '\r'}, {...packet, routesText: ''}, {...packet, routesText: null},
  ]) expect(() => checkpointEvidenceFields({checkpointEvidence: [change]}, plan, subjects, files)).toThrow();
  const packets = Array.from({length: 8}, (_, index) => ({...packet, checkpointId: `step-${index}`, planStepId: `step-${index}`,
    routesText: '한'.repeat(4096), recommendationText: '한'.repeat(4096)}));
  const steps = packets.map(p => ({id: p.planStepId, hash: '1'.repeat(64)}));
  const asks = packets.map(p => ({kind: 'checkpoint' as const, checkpointId: p.checkpointId}));
  expect(() => checkpointEvidenceFields({checkpointEvidence: packets}, {steps}, asks, files)).toThrow();
  expect(() => checkpointEvidenceFields({checkpointEvidence: [...packets, packet]}, {steps}, asks, files)).toThrow();
  const largeTable = {schema: 'rig-review-checkpoint-table/1', columns: ['large'], rows: Array.from({length: 120}, () => ['x'.repeat(2000)])};
  const table = writeWorkspaceFile(root, 'evidence/large.json', JSON.stringify(largeTable));
  expect(() => checkpointEvidenceMetadata(root, Array(3).fill({...packet, table}))).toThrow('CHECKPOINT_EVIDENCE_TABLE_LIMIT');
});

test('tile and table declarations retain closed required and optional key semantics', () => {
  const {packet, files} = evidence(temp()), plan = {steps: [{id: 'step-one', hash: '1'.repeat(64)}]};
  const subjects = [{kind: 'checkpoint' as const, checkpointId: 'step-one'}];
  for (const key of Object.keys(packet.tiles[0]!)) {
    const tile: any = {...packet.tiles[0]}; delete tile[key];
    expect(() => checkpointEvidenceFields({checkpointEvidence: [{...packet, tiles: [tile]}]}, plan, subjects, files)).toThrow();
  }
  for (const key of ['path', 'sha256']) {
    const table: any = {...packet.table}; delete table[key];
    expect(() => checkpointEvidenceFields({checkpointEvidence: [{...packet, table}]}, plan, subjects, files)).toThrow();
  }
  for (const key of ['schema', 'columns', 'rows']) {
    const table: any = {schema: 'rig-review-checkpoint-table/1', columns: ['c'], rows: []}; delete table[key];
    expect(() => parseCheckpointTable(Buffer.from(JSON.stringify(table)))).toThrow();
  }
  const {label, ...table} = packet.table;
  const parsed = checkpointEvidenceFields({checkpointEvidence: [{...packet, table}]}, plan, subjects, files);
  expect(Object.hasOwn(parsed.checkpointEvidence![0]!.table, 'label')).toBe(false);
  expect(() => checkpointEvidenceFields({checkpointEvidence: [{...packet, tiles: [{...packet.tiles[0], frame0: 'duplicate'}]}]}, plan, subjects, files)).toThrow();
});

test('fresh package ask and finalization refuse corrupted retained evidence but exact act retry stays pinned', async () => {
  const f = await packageFixture(); contextWithEvidence(f);
  const request = await f.publishRequest('publication-retry'), first: any = await (await f.call(request)).json();
  expect(first.ok).toBe(true); const publication = first.value;
  const ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'}), page = await f.display(publication);
  const submission = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation, submissionId: 'package-act',
    kind: 'checkpoint', value: {checkpointId: 'step-one', outcome: 'pass', words: ''}};
  const act = await f.session.commitUIAct(submission), retained = f.session.retainedSource(publication.publicationId);
  writeFileSync(join(retained.snapshotRoot, 'evidence/table.json'), '{}');
  expect(await f.session.commitUIAct(submission)).toEqual(act);
  expect((await (await f.call(request)).json()).value).toEqual(publication);
  const result = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'fresh-ask', publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step-one'}})).json();
  expect(result.ok).toBe(false);
  await expect(f.session.commitUIAct({...submission, submissionId: 'fresh-act'})).rejects.toThrow();
});

test('all durable record copies losing evidence cannot preserve the old sealed identity', async () => {
  const f = recordFixture(), publication: any = await f.session.execute(f.request, new AbortController().signal);
  tamper(f.state, f.session.jobId, data => {
    delete data.publications[publication.publicationId].retained.context.checkpointEvidence;
    delete data.publications[publication.publicationId].retained.source.checkpointEvidence;
    delete data.publications[publication.publicationId].publication.source.checkpointEvidence;
    delete data.replays['agent:publish'].value.source.checkpointEvidence;
    delete data.events[0].publication.source.checkpointEvidence;
  });
  expect(() => f.session.status()).toThrow();
});

for (const kind of ['package', 'record'] as const) test(`consistent metadata tampering across every ${kind} copy still refuses the old hash`, async () => {
  let session: JobSession, state: string;
  if (kind === 'package') {
    const f = await packageFixture(); contextWithEvidence(f); await f.publish(); session = f.session; state = f.state;
  } else {
    const f = recordFixture(); await f.session.execute(f.request, new AbortController().signal); session = f.session; state = f.state;
  }
  tamper(state, session.jobId, data => {
    for (const stored of Object.values(data.publications) as any[]) {
      stored.retained.source.checkpointEvidence[0].recommendationText = 'consistently changed';
      stored.publication.source.checkpointEvidence[0].recommendationText = 'consistently changed';
      if (stored.retained.context) stored.retained.context.checkpointEvidence[0].recommendationText = 'consistently changed';
    }
    data.events[0].publication.source.checkpointEvidence[0].recommendationText = 'consistently changed';
    data.replays['agent:publish' in data.replays ? 'agent:publish' : Object.keys(data.replays)[0]].value.source.checkpointEvidence[0].recommendationText = 'consistently changed';
  });
  expect(() => session.status()).toThrow();
});

test('pinned tile route rejects retained symlink replacement even when target bytes match the seal', async () => {
  const f = await packageFixture(), {packet} = contextWithEvidence(f), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId), tile = packet.tiles[0]!;
  const same = join(retained.snapshotRoot, 'same.png');
  writeFileSync(same, makeSyntheticPngBytes(0, 100, 200));
  expect(jobHash(makeSyntheticPngBytes(0, 100, 200))).toBe(tile.sha256);
  unlinkSync(join(retained.snapshotRoot, tile.path)); symlinkSync(same, join(retained.snapshotRoot, tile.path));
  const response = await metadata(f.session, publication, 'api/checkpoint-evidence/step-one/tiles/0');
  expect(response.status).toBe(409); await response.text();
  const meta = await metadata(f.session, publication); expect(meta.status).toBe(409); await meta.text();
});

test('publication and pinned reads expose named evidence seal and table refusals', async () => {
  const f = await packageFixture(), {packet, context} = contextWithEvidence(f), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  writeFileSync(join(retained.snapshotRoot, packet.table.path), '{}');
  const response = await metadata(f.session, publication);
  expect(await response.json()).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH', message: 'CHECKPOINT_EVIDENCE_HASH_MISMATCH'}});
  const bad = writeWorkspaceFile(f.root, packet.table.path, '{}');
  f.setContext({...context, files: context.files.map(file => file.path === bad.path ? bad : file),
    checkpointEvidence: [{...packet, table: bad}]});
  const refused = await (await f.call(await f.publishRequest())).json();
  expect(refused).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH', message: 'CHECKPOINT_EVIDENCE_TABLE_INVALID'}});
  expect(f.session.status().publication).toEqual(publication);
  writeFileSync(join(retained.snapshotRoot, packet.tiles[0]!.path), 'wrong');
  const tile = await metadata(f.session, publication, 'api/checkpoint-evidence/step-one/tiles/0');
  expect(await tile.json()).toMatchObject({error: {message: 'CHECKPOINT_EVIDENCE_HASH_MISMATCH'}});
});

test('model-free record tile route is pinned, member-only and instance-bound', async () => {
  const f = recordFixture(), publication = await f.session.execute(f.request, new AbortController().signal) as PublicationV3;
  const routes = retainedPublicationRoutes(f.session), path = 'api/checkpoint-evidence/step_layout/tiles/0';
  const valid = await metadata(f.session, publication, path);
  expect(jobHash(new Uint8Array(await valid.arrayBuffer()))).toBe(f.packet.packet.tiles[0]!.sha256);
  const wrong = await routes(f.session.jobId, publication.publicationId, '0'.repeat(64), path, new Request('http://127.0.0.1/' + path));
  expect(wrong.status).toBe(409); await wrong.text();
  for (const path of ['api/checkpoint-evidence/step_weights/tiles/0', 'api/checkpoint-evidence/step_layout/tiles/-1',
    'api/checkpoint-evidence/step_layout/tiles/0/../../project.json',
    'api/checkpoint-evidence/step_layout/tiles/%30']) {
    const response = await metadata(f.session, publication, path); expect(response.status).toBe(404); await response.text();
  }
});

test('record legacy absence survives reopen with a newly enriched live reader', async () => {
  const f = recordFixture(), {checkpointEvidence, ...legacy} = f.context(); f.setContext(legacy);
  const publication = await f.session.execute(f.request, new AbortController().signal) as PublicationV3;
  f.setContext({...legacy, checkpointEvidence});
  const reopened = new JobSession(f.options); cleanups.push(() => reopened.dispose());
  expect(reopened.status().publication).toEqual(publication);
  const body = await (await metadata(reopened, publication)).json();
  expect(Object.hasOwn(body, 'checkpointEvidence')).toBe(false);
  expect(Object.hasOwn(body.recordSource, 'checkpointEvidence')).toBe(false);
});

test('accepted table and declaration count boundaries retain exact values', () => {
  const root = temp(), {packet, files} = evidence(root);
  const packets = Array.from({length: 8}, (_, index) => ({...packet, checkpointId: `step-${index}`, planStepId: `step-${index}`}));
  const plan = {steps: packets.map(p => ({id: p.planStepId, hash: '1'.repeat(64)}))};
  const subjects = packets.map(p => ({kind: 'checkpoint' as const, checkpointId: p.checkpointId}));
  expect(checkpointEvidenceFields({checkpointEvidence: packets}, plan, subjects, files).checkpointEvidence).toEqual(packets);
  const rows = Array.from({length: 2048}, () => Array(8).fill(null));
  expect(parseCheckpointTable(Buffer.from(JSON.stringify({schema: 'rig-review-checkpoint-table/1', columns: Array(8).fill('c'), rows}))).rows).toEqual(rows);
  const boundary = {schema: 'rig-review-checkpoint-table/1' as const, columns: Array(32).fill('x'.repeat(512)), rows: []};
  expect(parseCheckpointTable(Buffer.from(JSON.stringify(boundary)))).toEqual(boundary);
});

function expectSourceMismatch(read: () => unknown) {
  let refusal: unknown;
  try {read();} catch (error) {refusal = error;}
  expect(refusal).toBeInstanceOf(JobError);
  expect(refusal).toMatchObject({code: 'JOB_SOURCE_MISMATCH'});
}

test('v3 package table route returns exact pinned raw JSON for authenticated projection comparison', async () => {
  const f = await packageFixture(), {packet, context, document} = contextWithEvidence(f);
  const raw = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  const table = {...packet.table, ...writeWorkspaceFile(f.root, packet.table.path, raw)};
  f.setContext({...context, checkpointEvidence: [{...packet, table}],
    files: context.files.map(file => file.path === table.path ? {path: table.path, sha256: table.sha256} : file)});
  const publication = await f.publish(), body = await (await metadata(f.session, publication)).json();
  const projected = body.checkpointEvidence[0].table;
  expect(projected.url).toBe('/api/checkpoint-evidence/step-one/table');
  expect(publication.source.checkpointEvidence![0]!.table).toEqual(table);
  expect(Object.hasOwn(publication.source.checkpointEvidence![0]!.table, 'url')).toBe(false);
  writeFileSync(join(f.root, table.path), '{}');
  const response = await metadata(f.session, publication, projected.url.slice(1));
  expect(response.status).toBe(200);
  const retainedBytes = Buffer.from(await response.arrayBuffer());
  expect(retainedBytes).toEqual(raw);
  expect(jobHash(retainedBytes)).toBe(publication.source.checkpointEvidence![0]!.table.sha256);
  const sealed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(retainedBytes));
  expect({schema: projected.schema, columns: projected.columns, rows: projected.rows}).toEqual(sealed);
  expect(sealed.rows.length).toBe(103);
  const routes = retainedPublicationRoutes(f.session), path = projected.url.slice(1);
  const head = await routes(f.session.jobId, publication.publicationId, publication.instanceKey, path,
    new Request('http://127.0.0.1/' + path, {method: 'HEAD'}));
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(raw.length));
  expect(await head.text()).toBe('');
});

test('v3 record table route enforces checkpoint association, instance and retained SHA', async () => {
  const f = recordFixture(), publication = await f.session.execute(f.request, new AbortController().signal) as PublicationV3;
  const body = await (await metadata(f.session, publication)).json(), table = body.checkpointEvidence[0].table;
  expect(table.url).toBe('/api/checkpoint-evidence/step_layout/table');
  const response = await metadata(f.session, publication, table.url.slice(1));
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(jobHash(bytes)).toBe(publication.source.checkpointEvidence![0]!.table.sha256);
  expect(JSON.parse(bytes.toString())).toEqual(f.packet.document);
  for (const path of ['api/checkpoint-evidence/step_weights/table', 'api/checkpoint-evidence/undeclared/table',
    'api/checkpoint-evidence/step_layout/table/evidence/table.json', 'api/checkpoint-evidence/step_layout/table?path=project.json']) {
    const refusal = await metadata(f.session, publication, path);
    expect(refusal.status).toBe(404); await refusal.text();
  }
  const routes = retainedPublicationRoutes(f.session), path = table.url.slice(1);
  const wrong = await routes(f.session.jobId, publication.publicationId, '0'.repeat(64), path, new Request('http://127.0.0.1/' + path));
  expect(wrong.status).toBe(409); await wrong.text();
  const retained = f.session.retainedSourceV3(publication.publicationId);
  writeFileSync(join(retained.snapshotRoot, f.packet.packet.table.path), '{}');
  const mismatch = await metadata(f.session, publication, path);
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({error: {code: 'JOB_SOURCE_MISMATCH', message: 'CHECKPOINT_EVIDENCE_HASH_MISMATCH'}});
});

test('v3 sealed raw table exposes same-source metadata row and column corruption without another grammar', async () => {
  const f = await packageFixture(); contextWithEvidence(f);
  const publication = await f.publish(), original = await (await metadata(f.session, publication)).json();
  const table = original.checkpointEvidence[0].table;
  expect(table.url).toBe('/api/checkpoint-evidence/step-one/table');
  const raw = Buffer.from(await (await metadata(f.session, publication, table.url.slice(1))).arrayBuffer());
  expect(jobHash(raw)).toBe(publication.source.checkpointEvidence![0]!.table.sha256);
  const sealed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
  for (const change of [
    (value: any) => {value.rows[0][2] = 'corrupted classification';},
    (value: any) => {value.rows.reverse();},
    (value: any) => {value.columns[0] = 'corrupted column';},
    (value: any) => {value.schema = 'corrupted schema';},
  ]) {
    const corrupted = structuredClone(original);
    change(corrupted.checkpointEvidence[0].table);
    expect(corrupted.sourceHash).toBe(publication.source.sourceHash);
    expect(corrupted.checkpointEvidence[0].table.sha256).toBe(publication.source.checkpointEvidence![0]!.table.sha256);
    const projected = corrupted.checkpointEvidence[0].table;
    expect({schema: projected.schema, columns: projected.columns, rows: projected.rows}).not.toEqual(sealed);
  }
});

test('v3 absent legacy package and record evidence have no table route', async () => {
  const f = await packageFixture(), publication = await f.publish();
  const pkg = await metadata(f.session, publication, 'api/checkpoint-evidence/step-one/table');
  expect(pkg.status).toBe(404); await pkg.text();
  const r = recordFixture(), {checkpointEvidence, ...legacy} = r.context(); r.setContext(legacy);
  const record = await r.session.execute(r.request, new AbortController().signal) as PublicationV3;
  const absent = await metadata(r.session, record, 'api/checkpoint-evidence/step_layout/table');
  expect(absent.status).toBe(404); await absent.text();
});

for (const target of ['retained', 'publication', 'ask', 'act', 'event', 'replay'] as const) {
  for (const missing of [null, undefined]) {
    test(`v3 malformed ${target} source ${String(missing)} yields named JobError with bound evidence`, async () => {
      const f = recordFixture(), signal = new AbortController().signal;
      const publication = await f.session.execute(f.request, signal) as PublicationV3;
      const ask: any = await f.session.execute({...f.request, verb: 'ask', requestId: 'ask', idempotencyKey: 'ask', expectedGeneration: 1,
        publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step_layout'}}, signal);
      tamper(f.state, f.session.jobId, data => {
        const stored = data.publications[publication.publicationId];
        if (target === 'retained') stored.retained.source = missing;
        if (target === 'publication') stored.publication.source = missing;
        if (target === 'ask') data.asks[ask.askId].source = missing;
        if (target === 'act') data.acts.corrupt = {publicationId: publication.publicationId, source: missing};
        if (target === 'event') data.events[0].publication.source = missing;
        if (target === 'replay') data.replays['agent:publish'].value.source = missing;
      });
      expectSourceMismatch(() => f.session.status());
      expectSourceMismatch(() => JobSession.openReadOnly(f.options, f.session.jobId));
    });
  }
}

for (const missing of [null, undefined]) test(`v3 direct retained source ${String(missing)} yields named JobError`, async () => {
  const f = await packageFixture(); contextWithEvidence(f);
  const publication = await f.publish(), retained = structuredClone(f.session.retainedSource(publication.publicationId));
  (retained as any).source = missing;
  expectSourceMismatch(() => assertStoredCheckpointEvidence(retained));
});

test('v3 package table route follows the admitted checkpoint alias rather than the plan step ID', async () => {
  const f = await packageFixture(), packet = evidence(f.root, 'motion-card', 'step-one');
  const {context} = contextWithEvidence(f, packet);
  f.setContext({...context, subjects: [{kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}]});
  const publication = await f.publish(), body = await (await metadata(f.session, publication)).json();
  expect(body.checkpointEvidence[0].table.url).toBe('/api/checkpoint-evidence/motion-card/table');
  const correct = await metadata(f.session, publication, 'api/checkpoint-evidence/motion-card/table');
  expect(correct.status).toBe(200);
  expect(jobHash(new Uint8Array(await correct.arrayBuffer()))).toBe(packet.packet.table.sha256);
  const wrong = await metadata(f.session, publication, 'api/checkpoint-evidence/step-one/table');
  expect(wrong.status).toBe(404); await wrong.text();
});

for (const format of ['png', 'svg', 'SvG'] as const) test(`#636: ${format} original retains metadata and evidence without requiring a PNG comparison`, async () => {
  const f = await packageFixture(), out = join(f.root, 'out');
  const part = readFileSync(join(out, 'rigid.png'));
  const painting = format === 'png' ? makeSyntheticPngBytes(10, 100, 200)
    : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
  mkdirSync(join(out, 'draft/parts'), {recursive: true});
  writeFileSync(join(out, 'draft/parts/body.png'), part);
  const partsBytes = JSON.stringify({rig_size: [2, 2], scale_rig_per_source: 1,
    parts: [{name: 'body', x: 0, y: 0, w: 1, h: 1}]});
  writeFileSync(join(out, 'draft/parts.json'), partsBytes);
  writeFileSync(join(out, 'config.json'), '{}');
  writeFileSync(join(out, `painting.${format}`), painting);
  const manifest = JSON.parse(readFileSync(join(out, 'review.json'), 'utf8'));
  writeFileSync(join(out, 'review.json'), JSON.stringify({...manifest,
    producer: {config: 'config.json', parts: 'draft', source: `painting.${format}`}}));
  const parts = {enumeratorVersion: f.partsEnumerator.version,
    manifest: {path: 'out/draft/parts.json' as const, sha256: jobHash(partsBytes)},
    images: [{path: 'parts/body.png', role: 'part', sha256: jobHash(part)}]};
  f.setPartsReferences(parts.images.map(({path, role}) => ({path, role})));
  f.setContext({...f.getContext(), parts, partIds: ['body']});
  const {packet} = contextWithEvidence(f), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const sourceBytes = JSON.stringify(retained.source);
  expect(retained.source.checkpointEvidence).toEqual([packet]);
  expect(publication.source.checkpointEvidence).toEqual([packet]);
  const response = await metadata(f.session, publication), body = await response.json();
  expect(response.status).toBe(200);
  expect(body.sourceHash).toBe(publication.source.sourceHash);
  expect(body.sourcePainting.sha256).toBe(jobHash(painting));
  const original = await metadata(f.session, publication, 'review-painting');
  expect(original.status).toBe(200);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(painting);
  const view = await metadata(f.session, publication, 'api/stage-parts');
  expect(view.status).toBe(200);
  const inventory = await view.json();
  expect(inventory.items.map((item: {name: string}) => item.name)).toEqual(['body']);
  expect(inventory.painting).toEqual(format === 'png' ? {sha256: jobHash(painting), width: 2, height: 2} : null);
  expect(inventory.differenceAvailable).toBe(false);
  for (const member of [...packet.tiles, packet.table]) {
    expect(retained.seals).toContainEqual({path: member.path, sha256: member.sha256});
  }
  for (const member of body.checkpointEvidence[0].tiles) {
    const tile = await metadata(f.session, publication, member.url.slice(1));
    expect(tile.status).toBe(200);
    expect(jobHash(new Uint8Array(await tile.arrayBuffer()))).toBe(member.sha256);
  }
  const table = await metadata(f.session, publication, body.checkpointEvidence[0].table.url.slice(1));
  expect(table.status).toBe(200);
  expect(jobHash(new Uint8Array(await table.arrayBuffer()))).toBe(packet.table.sha256);
  const retainedPainting = join(retained.snapshotRoot, `out/painting.${format}`);
  expect(readFileSync(retainedPainting)).toEqual(painting);
  expect(readFileSync(join(out, `painting.${format}`))).toEqual(painting);
  expect(JSON.stringify(f.session.retainedSource(publication.publicationId).source)).toBe(sourceBytes);
  // Omitting SVG from the optional comparison never removes its original seal.
  const changed = Buffer.from(painting); changed[changed.length - 1] ^= 1;
  writeFileSync(retainedPainting, changed);
  try {
    for (const path of ['api/review', 'api/stage-parts', 'review-painting']) {
      const refusal = await metadata(f.session, publication, path);
      expect(refusal.status).toBe(409);
      await refusal.text();
    }
  } finally { writeFileSync(retainedPainting, painting); }
  expect(readFileSync(retainedPainting)).toEqual(painting);
  expect(readFileSync(join(out, `painting.${format}`))).toEqual(painting);
});
