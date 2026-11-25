/** #1226: the comment-only act (act@10). Synthetic public fixtures only. */
import {expect, test} from 'bun:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalJson} from '../src/canonical-json.ts';
import * as host from '../src/job-host.ts';
import * as api from '../src/job-api.ts';
import {jobCommand} from '../src/job-cli.ts';
import type {JobChestLandmarkValue, JobMeshEditValue, JobPublication} from '../src/job-contract.ts';
import {attachmentHashText} from '../src/mesh-edit.ts';
import {feedbackItemComments} from '../src/stage-comment.ts';
import model from './fixtures/viewport-387/package/skeleton.model.json';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {syntheticPinnedFeedback} from './helpers/job-pinned-comments.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

const schema = 'rig-review/act@10';
const attachment = model.skins.find(({name}) => name === 'default')!.attachments.mesh.mesh;
const meshHash = api.jobHash(attachmentHashText(attachment));
const frame = {width: model.stage.width, height: model.stage.height};
const meshEdit: JobMeshEditValue = {
  skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
  source: {hash: meshHash, frame, vertexCount: 4, triangleCount: 2, hullLength: 4,
    positions: [[48, 42], [48, 22], [68, 22], [68, 42]]},
  ops: [{op: 'add', at: [60.12, 29.57]}],
};
const chestEdit: JobChestLandmarkValue = {
  skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
  source: {hash: meshHash, frame},
  bust: {apex_r: [16 + 1 / 256, 20], apex_l: [56, 20], alpha: 0.22},
};
const bind = <T>(edit: T) => ({edit, sha256: api.jobHash(canonicalJson(edit))});
const context = {mode: 'animate', tab: 'playback', frame: {index: 3, basis: 'producer'}} as const;

async function live() {
  const f = await jobFixture();
  const publication = await f.publish();
  const page = await f.display(publication);
  const submit = (value: unknown, submissionId = 'comments-1226', extra: Record<string, unknown> = {}, shown = page) =>
    f.ports.commitUIAct(f.session.jobId, f.uiRequest({...shown, expectedGeneration: f.session.status().generation,
      submissionId, kind: 'comments', value, ...extra}));
  return {f, publication, page, submit};
}

function sampleAct(publication: JobPublication, value: unknown): any {
  return {schema, actId: '12345678-1234-4abc-8def-123456789abc', jobId: 'job-1226', publicationId: publication.publicationId,
    kind: 'comments', authority: {actor: 'human', channel: 'review-ui', reviewer: {id: 'owner', role: 'owner'}},
    at: '2026-11-25T00:00:00.000Z', source: structuredClone(publication.source), value};
}

test('#1226 job-host exports the act@10 schema and decoder', () => {
  expect(host.JOB_COMMENT_ONLY_ACT_SCHEMA).toBe(schema);
  expect(typeof host.parseCommentOnlyAct).toBe('function');
});

test('#1226 a person sends comments with no ask; next and fetch-act deliver the same bytes', async () => {
  const {f, publication, submit} = await live();
  try {
    const original = await jobInputHashes(f.root);
    const pinned = feedbackItemComments(syntheticPinnedFeedback(publication.source as never, 1));
    const value = {comments: [{text: 'The motion reads a little fast.', context}, ...pinned]};
    const shown = {expectedGeneration: f.session.status().generation};
    const saved = await submit(value, 'comments-1226', shown);
    expect(saved).toMatchObject({ok: true, value: {schema, kind: 'comments', publicationId: publication.publicationId}});
    if (!saved.ok) throw new Error(saved.error.code);
    const act = host.parseCommentOnlyAct(saved.value);
    expect('askId' in act).toBe(false);
    expect('still' in act).toBe(false);
    expect(act.source).toEqual(publication.source);
    expect(act.value.comments).toEqual(value.comments);
    expect(act.authority).toEqual({actor: 'human', channel: 'review-ui', reviewer: {id: 'declared-owner', role: 'owner'}});
    // The retried submission returns the same immutable act; a changed payload under the same id refuses.
    expect(await submit(value, 'comments-1226', shown)).toEqual(saved);
    expect(await submit({comments: [{text: 'changed'}]}, 'comments-1226', shown)).toMatchObject({ok: false, error: {code: 'JOB_IDEMPOTENCY_CONFLICT'}});
    // `next` carries the ordinary act event; nothing else is asked or answered.
    const next = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
    const events = next.value.events as {type: string; act?: unknown}[];
    expect(events.filter(event => event.type === 'act').map(event => event.act)).toEqual([saved.value]);
    expect(events.some(event => event.type === 'pending')).toBe(false);
    const expected = JSON.stringify(act);
    expect(f.session.readActExport(act.actId, false).toString()).toBe(expected);
    const chunks: Buffer[] = [];
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', act.actId], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: (async (input, init) => f.ports.handleJobApi(new Request(input, init))) as typeof fetch,
      writeBytes: chunk => {chunks.push(Buffer.from(chunk)); return chunk.length;},
    });
    expect(Buffer.concat(chunks).toString()).toBe(expected);
    expect(await jobInputHashes(f.root)).toEqual(original);
  } finally { await f.close(); }
});

test('#1226 the job next CLI delivers an act@10 event (--until act and plain next)', async () => {
  const {f, submit} = await live();
  try {
    const saved = await submit({comments: [{text: 'general'}]});
    if (!saved.ok) throw new Error(saved.error.code);
    const locator = f.origin + '/jobs/' + f.session.jobId;
    for (const args of [['next', locator, '--wait-ms', '0'], ['next', locator, '--until', 'act', '--wait-ms', '100']]) {
      const lines: string[] = [];
      await jobCommand(args, {agentCapability: f.credentials.agent, write: line => lines.push(line),
        fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch});
      const events = JSON.parse(lines.at(-1)!).value.events as {type: string; act?: unknown}[];
      expect(events.filter(event => event.type === 'act').map(event => event.act)).toEqual([saved.value]);
    }
  } finally { await f.close(); }
});

test('#1226 a pending ask stays pending when comments are sent beside it', async () => {
  const {f, publication, submit} = await live();
  try {
    const ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    expect(await submit({comments: [{text: 'general'}]})).toMatchObject({ok: true});
    expect(f.session.status().pending.map(row => [row.askId, row.status])).toEqual([[ask.askId, 'pending']]);
  } finally { await f.close(); }
});

test('#1226 the writer refuses an ask id, a stale or unshown page and an empty or decision-shaped value', async () => {
  const {f, page, submit} = await live();
  try {
    const refused = async (result: Promise<unknown>, code: string) => expect(await result).toMatchObject({ok: false, error: {code}});
    await refused(submit({comments: [{text: 'x'}]}, 's1', {askId: 'some-ask'}), 'JOB_ACT_INVALID');
    await refused(submit({comments: []}, 's2'), 'JOB_ACT_INVALID');
    await refused(submit({comments: [{text: 'x'}], verdict: 'approved'}, 's3'), 'JOB_ACT_INVALID');
    await refused(submit({comments: [{text: 'x'}]}, 's4', {displayedNonce: 'f'.repeat(64)}), 'JOB_DISPLAY_MISMATCH');
    await refused(submit({comments: [{text: 'x', anchor: {name: 'question.png'}}]}, 's5'), 'JOB_ACT_INVALID');
    await refused(submit({comments: [{text: 'x', anchor: {checkpointId: 'step-one', planStepId: 'step-one'}}]}, 's6'), 'JOB_ACT_INVALID');
    await refused(submit({comments: [{text: 'x', context: {subject: {ask: {kind: 'review-verdict', stage: 'rig-review'},
      sourceHash: page.publicationId}}}]}, 's7'), 'JOB_ACT_INVALID');
    const second = await f.publish();
    await refused(submit({comments: [{text: 'x'}]}, 's8'), 'JOB_ACT_SOURCE_STALE');
    expect(await submit({comments: [{text: 'x'}]}, 's9', {}, await f.display(second))).toMatchObject({ok: true});
    expect(Object.keys(f.session.status().pending)).toEqual([]);
  } finally { await f.close(); }
});

test('#1226 carriers ride without a verdict, bound to the displayed model file', async () => {
  const {f, publication, submit} = await live();
  try {
    const file = publication.source.model!;
    const mesh = {kind: 'mesh-edits' as const, file, meshEdits: [bind(meshEdit)]};
    const saved = await submit({comments: [], carriers: [mesh]});
    expect(saved).toMatchObject({ok: true, value: {schema}});
    if (!saved.ok) throw new Error(saved.error.code);
    expect(host.parseCommentOnlyAct(saved.value).value.carriers).toEqual([mesh]);
    const refused = async (carriers: unknown, id: string, code: string) =>
      expect(await submit({comments: [{text: 'x'}], carriers}, id)).toMatchObject({ok: false, error: {code}});
    await refused([{...mesh, file: {...file, sha256: '1'.repeat(64)}}], 'c1', 'JOB_ACT_SOURCE_STALE');
    await refused([{...mesh, file: {...file, path: 'other.json'}}], 'c2', 'JOB_ACT_SOURCE_STALE');
    await refused([{...mesh, meshEdits: [bind({...meshEdit, source: {...meshEdit.source, hash: '1'.repeat(64)}})]}], 'c3', 'JOB_ACT_SOURCE_STALE');
    await refused([{...mesh, meshEdits: [bind({...meshEdit, source: {...meshEdit.source, triangleCount: 9}})]}], 'c4', 'JOB_ACT_INVALID');
    await refused([mesh, mesh], 'c5', 'JOB_ACT_INVALID');
    await refused([{...mesh, kind: 'mesh-edit'}], 'c6', 'JOB_ACT_INVALID');
    // Chest landmarks keep their one non-verdict rule: the publication must declare the seed.
    await refused([{kind: 'chest-landmarks', file, chestLandmarks: [bind(chestEdit)]}], 'c7', 'JOB_ACT_INVALID');
  } finally { await f.close(); }
});

test('#1226 chest landmark carriers need the declared seed and keep the act@9 payload', async () => {
  const f = await jobFixture();
  try {
    const path = 'producer-config.json', bytes = JSON.stringify({meshes: {mesh: {contour: {bust: chestEdit.bust}}}});
    await writeFile(join(f.root, path), bytes);
    const config = {path, sha256: api.jobHash(bytes)};
    f.setContext({...f.getContext(), files: [config], chestLandmarks: [{...chestEdit, source: {...chestEdit.source, configHash: config.sha256}}]});
    const publication = await f.publish();
    const page = await f.display(publication);
    const chest = {kind: 'chest-landmarks' as const, file: publication.source.model!, chestLandmarks: [bind(chestEdit)]};
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, expectedGeneration: f.session.status().generation,
      submissionId: 'chest-1226', kind: 'comments', value: {comments: [{text: 'apex sits low'}], carriers: [chest]}}));
    expect(saved).toMatchObject({ok: true, value: {schema}});
    if (!saved.ok) throw new Error(saved.error.code);
    expect(host.parseCommentOnlyAct(saved.value).value.carriers).toEqual([chest]);
  } finally { await f.close(); }
});

test('#1226 the decoder is closed, refuses older schemas and is refused by them', () => {
  const publication = {publicationId: 'publication-1226', source: {
    sourceHash: 'f'.repeat(64), projectHash: 'b'.repeat(64), package: {id: 'synthetic', revision: 'one'},
    selector: null, model: {path: 'skeleton.model.json', sha256: 'a'.repeat(64)}, direction: null, optionSet: null,
    appliedResult: null, plan: null, parts: null,
  }} as unknown as JobPublication;
  const good = sampleAct(publication, {comments: [{text: ' general\n', context}],
    carriers: [{kind: 'mesh-edits', file: publication.source.model, meshEdits: [bind(meshEdit)]}]});
  const bytes = JSON.stringify(good);
  expect(JSON.stringify(host.parseCommentOnlyAct(JSON.parse(bytes)))).toBe(bytes);
  const refuse = (raw: unknown) => expect(() => host.parseCommentOnlyAct(raw)).toThrow('JOB_ACT_INVALID');
  refuse({...good, askId: 'ask'});
  refuse({...good, still: {path: 'a.png', sha256: 'a'.repeat(64), camera: 'fixed', frame: 'setup'}});
  refuse({...good, kind: 'review-verdict'});
  refuse({...good, schema: 'rig-review/act@9'});
  refuse({...good, value: {comments: []}});
  refuse({...good, value: {comments: [{text: 'x'}], verdict: 'approved'}});
  refuse({...good, value: {comments: [{text: 'x'}], carriers: []}});
  refuse({...good, value: {comments: [{text: 'x', anchor: {name: 'question.png'}}]}});
  refuse({...good, value: {comments: [{text: 'x', context: {subject: {ask: {kind: 'review-verdict', stage: 'rig-review'}, sourceHash: 'f'.repeat(64)}}}]}});
  refuse({...good, value: {comments: [], carriers: [{kind: 'mesh-edits', file: {path: 'x.json', sha256: 'a'.repeat(64)}, meshEdits: [bind(meshEdit)]}]}});
  refuse({...good, source: {...good.source, model: null}});
  for (const decode of [host.parseCommentsAct, host.parseContextCommentsAct, host.parseMeshEditsAct, host.parseChestLandmarksAct]) {
    expect(() => decode(JSON.parse(bytes))).toThrow('JOB_ACT_INVALID');
  }
});

test('#1226 an act@10 with no comments and no carriers is refused by the writer and the decoder', async () => {
  const {f, publication, submit} = await live();
  try {
    expect(await submit({comments: []}, 'empty-1226')).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
    expect(f.session.status().generation).toBe(publication.generation);
    expect(() => host.parseCommentOnlyAct(sampleAct(publication, {comments: []}))).toThrow('JOB_ACT_INVALID');
  } finally { await f.close(); }
});

test('#1226 a declared commit is validated, sealed and echoed as source.commit; absent stays absent', async () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const f = await jobFixture();
  try {
    const plain = await f.publish();
    expect('commit' in plain.source).toBe(false);
    f.setContext({...f.getContext(), commit});
    const declared = await f.publish();
    expect(declared.source.commit).toBe(commit);
    // Sealed: the commit is part of the publication's source hash.
    expect(declared.source.sourceHash).not.toBe(plain.source.sourceHash);
    const page = await f.display(declared);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, expectedGeneration: f.session.status().generation,
      submissionId: 'commit-1226', kind: 'comments', value: {comments: [{text: 'at this commit'}]}}));
    if (!saved.ok) throw new Error(saved.error.code);
    expect(host.parseCommentOnlyAct(saved.value).source.commit).toBe(commit);
    for (const bad of [commit.toUpperCase(), commit.slice(1), null, 7]) {
      f.setContext({...f.getContext(), commit: bad as string});
      await expect(f.publish()).rejects.toThrow('JOB_SOURCE_INVALID');
    }
  } finally { await f.close(); }
});

test('#1226 record sources carry a declared commit, and act@10 comments on option-set and plan records', async () => {
  const {mkdtemp} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const rec = await import('./helpers/job-record-fixture.ts');
  const commit = 'fedcba9876543210fedcba9876543210fedcba98';
  const option = rec.createSyntheticOptionRecordWorkspace(await mkdtemp(join(tmpdir(), 'review-1226-')));
  const plan = rec.createSyntheticPlanRecordWorkspace(await mkdtemp(join(tmpdir(), 'review-1226-')));
  for (const w of [{...option, optionSetFile: option.optionSetFile}, {...plan, optionSetFile: undefined}]) {
    const build = (context: unknown) => api.buildRecordSource({record: w.record, selection: w.result, context, optionSetFile: w.optionSetFile} as never);
    const plain = build(w.context), declared = build({...w.context, commit});
    expect('commit' in plain).toBe(false);
    expect(declared.commit).toBe(commit);
    expect(declared.sourceHash).not.toBe(plain.sourceHash);
    expect(api.parseRecordSource(structuredClone(declared))).toEqual(declared);
    expect(() => api.parseRecordSource({...declared, commit: commit.slice(2)})).toThrow();
    expect(() => api.parseRecordSource({...plain, commit})).toThrow('JOB_SOURCE_MISMATCH');
    expect(() => build({...w.context, commit: null})).toThrow('JOB_SOURCE_INVALID');
    const act = sampleAct({publicationId: 'publication-1226', source: declared} as never, {comments: [{text: 'on the record'}]});
    expect(host.parseCommentOnlyAct(act).source).toEqual(declared);
  }
});
