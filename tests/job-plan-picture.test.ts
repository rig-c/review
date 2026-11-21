import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {PlanContext, PublicationV3} from '../src/job-contract.ts';
import {JOB_RECORD_READER_ID} from '../src/job-contract.ts';
import {planPictureFields} from '../src/job-checkpoint-evidence.ts';
import {assertEqualRecordContexts, buildRecordSource, jobHash, parseRecordPublishedContext, parseRecordSource,
  serializeRecordSourceDigestPayload} from '../src/job-api.ts';
import {assertStoredCheckpointEvidence} from '../src/job-source.ts';
import {retainedPublicationRoutes} from '../src/job-front.ts';
import {JobSession} from '../src/job-session.ts';
import {createSyntheticOptionRecordWorkspace, createSyntheticPlanRecordWorkspace, createSyntheticRecordReader,
  makeSyntheticPngBytes, writeWorkspaceFile} from './helpers/job-record-fixture.ts';

// #983: optional plan-level picture on record-plan publications (synthetic public fixtures).
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
function temp() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'review983-')));
  cleanups.push(() => rmSync(path, {recursive: true, force: true}));
  return path;
}
function planFixture() {
  const root = temp(), fixture = createSyntheticPlanRecordWorkspace(root);
  const picture = writeWorkspaceFile(root, 'post/v3/render.png', makeSyntheticPngBytes(30, 60, 90));
  const files = [...fixture.files, picture].sort((a, b) => a.path < b.path ? -1 : 1);
  const context: PlanContext = {...fixture.context, files, planPicture: {path: picture.path, sha256: picture.sha256}};
  return {root, fixture, picture, context};
}
const refusal = {code: 'JOB_SOURCE_MISMATCH', message: 'PLAN_PICTURE_INVALID'};

test('a plan picture parses, round-trips through the source and binds the source hash', () => {
  const f = planFixture();
  const parsed = parseRecordPublishedContext(f.context, f.fixture.result, f.fixture.record);
  expect(parsed.planPicture).toEqual({path: 'post/v3/render.png', sha256: f.picture.sha256});
  const source = buildRecordSource({record: f.fixture.record, selection: f.fixture.result, context: parsed});
  expect(source.planPicture).toEqual(parsed.planPicture);
  expect(parseRecordSource(source)).toEqual(source);
  const {planPicture, ...absent} = f.context;
  const without = buildRecordSource({record: f.fixture.record, selection: f.fixture.result, context: absent});
  expect(without.sourceHash).not.toBe(source.sourceHash);
  expect(JSON.parse(serializeRecordSourceDigestPayload(source)).planPicture).toEqual(planPicture);
  // The source hash binds the reference: swapping it on a stored copy is refused.
  expect(() => parseRecordSource({...without, planPicture})).toThrow();
  expect(() => parseRecordSource({...source, planPicture: {path: f.fixture.inputImage.path, sha256: f.fixture.inputImage.sha256}})).toThrow();
  expect(() => assertEqualRecordContexts(f.context, absent)).toThrow();
});

test('a plan picture is refused on option sets, extra or missing keys, closure, hash and non-raster files', () => {
  const f = planFixture(), at = f.context.planPicture!;
  const refuse = (planPicture: unknown) => {
    let error: unknown;
    try {parseRecordPublishedContext({...f.context, planPicture} as PlanContext, f.fixture.result);} catch (caught) {error = caught;}
    expect(error).toMatchObject(refusal);
  };
  refuse({...at, label: 'extra'});
  refuse({path: at.path});
  refuse({path: 'post/v3/absent.png', sha256: at.sha256});
  refuse({path: at.path, sha256: f.fixture.inputImage.sha256});
  refuse({path: f.fixture.inputSpec.path, sha256: f.fixture.inputSpec.sha256});
  for (const value of [undefined, null, [], 'post/v3/render.png']) refuse(value);
  expect(() => planPictureFields({planPicture: at}, null, f.context.files)).toThrow('PLAN_PICTURE_INVALID');
  const option = createSyntheticOptionRecordWorkspace(temp());
  const image = option.context.files.find(file => /\.png$/.test(file.path))!;
  expect(() => parseRecordPublishedContext({...option.context, planPicture: image} as never, option.result)).toThrow();
  const source = buildRecordSource({record: f.fixture.record, selection: f.fixture.result, context: f.context});
  expect(() => serializeRecordSourceDigestPayload({...source, planPicture: {...at, label: 'x'}} as never)).toThrow();
});

test('records without a plan picture keep their historical digest bytes and materialize nothing', () => {
  const root = temp(), f = createSyntheticPlanRecordWorkspace(root);
  const source = buildRecordSource({record: f.record, selection: f.result, context: f.context});
  const historical = JSON.stringify({schema: 'rig-review-job-record-source/1', record: f.record,
    selection: {kind: 'plan'}, inputs: f.context.inputs, optionSet: null, optionSetFile: null,
    plan: f.context.plan, subjects: f.context.subjects, files: f.context.files});
  expect(serializeRecordSourceDigestPayload(source)).toBe(historical);
  expect(source.sourceHash).toBe(jobHash(historical));
  expect(Object.hasOwn(source, 'planPicture')).toBe(false);
  expect(Object.hasOwn(parseRecordPublishedContext(f.context, f.result), 'planPicture')).toBe(false);
  expect(planPictureFields({}, null, [])).toEqual({});
});

test('a published plan picture is retained, served as its sealed bytes and absent elsewhere', async () => {
  const f = planFixture();
  const {reader} = createSyntheticRecordReader({onPlan: () => structuredClone(f.context)});
  const session = new JobSession({root: f.root, stateDir: temp(), fingerprint: 'record-plan-picture',
    reviewer: {id: 'owner', role: 'owner' as const}, publicationMode: 'record-and-package' as const,
    recordReaderId: JOB_RECORD_READER_ID, readRecordPublished: reader});
  cleanups.push(() => session.dispose());
  const publication = await session.execute({schema: 'rig-review/job-api@3' as const, jobId: session.jobId, requestId: 'publish',
    verb: 'publish' as const, expectedGeneration: 0, idempotencyKey: 'publish',
    freeze: {kind: 'producer-held' as const, holdId: 'synthetic', record: f.fixture.record}, result: f.fixture.result},
    new AbortController().signal) as PublicationV3;
  expect((publication.source as {planPicture?: unknown}).planPicture).toEqual(f.context.planPicture);
  const retained = session.retainedSourceV3(publication.publicationId);
  assertStoredCheckpointEvidence(retained);
  const routes = retainedPublicationRoutes(session);
  const read = (path: string) => routes(session.jobId, publication.publicationId, publication.instanceKey, path,
    new Request('http://127.0.0.1/' + path));
  const served = await read('api/plan-picture');
  expect(served.status).toBe(200);
  expect(jobHash(new Uint8Array(await served.arrayBuffer()))).toBe(f.picture.sha256);
  for (const path of ['api/plan-picture/0', 'api/plan-picture/../project.json']) {
    const response = await read(path); expect(response.status).toBe(404); await response.text();
  }
});
