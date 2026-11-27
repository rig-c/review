import {seedHistoricalVerdictAsk} from './helpers/historical-verdict-ask.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import { afterEach, expect, test } from 'bun:test';
import { parseUISubmission } from '../src/job-act.ts';
import { JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_ENABLED_ACT_KINDS, JOB_RESERVED_ACT_KINDS, type JobUISubmission } from '../src/job-contract.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobFixture, syntheticJobParts } from './helpers/job-api-fixture.ts';
import { seedHistoricalCheckpointAct, seedHistoricalCheckpointAsk } from './helpers/historical-checkpoint-act.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {JobSession} from '../src/job-session.ts';
import type {JobStore} from '../src/job-store.ts';
import historicalRig from './fixtures/job-decision-1233/rig.json';
import {Database} from 'bun:sqlite';
import {jobSnapshotHash} from '../src/job-source.ts';
import {loadPartsView} from '../src/parts-view.ts';
import {preparePartsComment,validateStoredPartsComment} from '../src/parts-comment-crops.ts';
import {commentPartsIssues, parsePartsIssue} from '../src/parts-comment.ts';
import {createJobHostPorts, jobHash, parseCommentOnlyAct} from '../src/job-api.ts';
import {PNG} from 'pngjs';
import {parseCommentsAct, parseContextCommentsAct, projectComments, parseRecordAct, type JobComment} from '../src/job-host.ts';
import {legacyFeedbackComments, partsIssueComments} from '../src/feedback-export.ts';
import legacyComments from './fixtures/comments-contract-legacy.json';

// Deliberately untyped fixture permits planted malformed packets at the public decoder.
function commentsAct(): any {
  const old = JSON.parse(legacyComments.records['@2'].raw);
  const {words: _words, ...value} = old.value;
  return {...old, schema: 'rig-review/act@6', value: {...value, comments: [] as JobComment[]}};
}
const feedbackAnchor = (id = 'feedback-one') => ({id, frameStart: 3, frameEnd: 3,
  target: {kind: 'slot' as const, name: 'sleeve'}, category: 'defect' as const});

test('#653 P1 checkpoint comment and top-level checkpoint share declared evidence mapping validation', () => {
  const act = commentsAct();
  act.source.plan.steps.push({id: 'step-two', hash: '2'.repeat(64)});
  act.source.checkpointEvidence = [{schema: 'rig-review-checkpoint-evidence/1', checkpointId: 'checkpoint-c', planStepId: 'step-one',
    tiles: [{id: 'tile', label: 'Declared tile', path: 'evidence/tile.png', sha256: 'a'.repeat(64)}],
    table: {path: 'evidence/table.json', sha256: 'b'.repeat(64)}, routesText: 'Pass or fail', recommendationText: 'Inspect this'}];
  act.value = {checkpointId: 'checkpoint-c', planStepId: 'step-one', outcome: 'pass',
    comments: [{text: 'Inspect checkpoint', anchor: {checkpointId: 'checkpoint-c', planStepId: 'step-one'}}]};
  expect(parseCommentsAct(act).value.comments).toEqual(act.value.comments);
  const contradictory = structuredClone(act);
  contradictory.value.comments[0].anchor.planStepId = 'step-two';
  expect(() => parseCommentsAct(contradictory)).toThrow('JOB_ACT_INVALID');
  const wrongTopLevel = structuredClone(act); wrongTopLevel.value.planStepId = 'step-two';
  expect(() => parseCommentsAct(wrongTopLevel)).toThrow('JOB_ACT_INVALID');
  const absent = structuredClone(act); delete absent.source.checkpointEvidence;
  absent.value.planStepId = 'step-two'; absent.value.comments[0].anchor.planStepId = 'step-two';
  expect(parseCommentsAct(absent).schema).toBe('rig-review/act@6');
});

test('#646 empty-comments: fresh blank refuses, historical empty/whitespace fields remain display-only', () => {
  expect(projectComments(parseCommentsAct(commentsAct()).value.comments)).toBe('');
  expect(() => parseCommentsAct({...commentsAct(), value: {...commentsAct().value, comments: [{text: ' \n'}]}})).toThrow('JOB_ACT_INVALID');
});

test('#646 parts-same-action: verdict and signoff retain separate identities and identical comments', () => {
  const old = JSON.parse(legacyComments.records['@5'].raw), comments = [{text: 'Approve overall'}];
  const verdict = parseCommentsAct({...old, schema: 'rig-review/act@6', value: {verdict: 'approved', comments}});
  const signoff = parseCommentsAct({...old, schema: 'rig-review/act@6', actId: 'separate-signoff', kind: 'signoff',
    value: {stage: 'parts-approved', decision: 'approved', comments}});
  expect(signoff.actId).not.toBe(verdict.actId);
  expect(projectComments(signoff.value.comments)).toBe('[general]\nApprove overall');
  expect(projectComments(signoff.value.comments)).toBe(projectComments(verdict.value.comments));
});

test('#646 legacy-fields-display: each old field yields one unmodified general display entry', () => {
  expect(legacyFeedbackComments(['  old\n', '', 'mesh'])).toEqual([{text: '  old\n'}, {text: ''}, {text: 'mesh'}]);
  for (const record of Object.values(legacyComments.records)) expect(jobHash(record.raw)).toBe(record.sha256);
  expect(parseRecordAct(JSON.parse(legacyComments.records['@4'].raw)).schema).toBe('rig-review/act@4');
});

test('#646 closed-key-negative: mixed anchors, historical words and browser plan mapping refuse', () => {
  const act = commentsAct();
  for (const value of [{...act.value, words: ''}, {...act.value, comments: [{text: 'x', note: ''}]},
    {...act.value, outcome: ['pass']},
    {...act.value, comments: [{summary: 'x'}]}, {...act.value, comments: [{text: 'x', anchor: {kind: 'region'}}]},
    {...act.value, comments: [{text: 'x', anchor: {...feedbackAnchor(), checkpointId: 'step-one', planStepId: 'step-one'}}]}]) {
    expect(() => parseCommentsAct({...act, value})).toThrow('JOB_ACT_INVALID');
  }
  expect(() => parseCommentsAct({...act, kind: ['checkpoint']})).toThrow('JOB_ACT_INVALID');
  // The request wrapper defers value validation to the ordinary finalizer/commit port.
  // The existing pending-checkpoint test below proves that port refuses browser planStepId.
});

// #1229: checkpoint asks and submissions are retired; historical act@6 checkpoint acts still replay and check digest conflicts.
test('#646 and #1229 source-and-replay-negative: fresh checkpoint submissions refuse while historical act@6 replay digest stays authoritative', async () => {
  const f = await fixture(), publication = await f.publish(),
    ask = seedHistoricalCheckpointAsk(f.session, publication.publicationId, {kind: 'checkpoint', checkpointId: 'step-one'}),
    page = await f.display(publication);
  const base = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation, submissionId: '646-writer-off',
    kind: 'checkpoint', value: {checkpointId: 'step-one', outcome: 'pass', comments: [{text: 'one'}, {text: 'two'}]}};
  const generation = f.session.status().generation;
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(base))).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
  expect(f.session.status().generation).toBe(generation);
  const stored = seedHistoricalCheckpointAct(f.session, {
    ...page, expectedGeneration: generation, submissionId: '646-replayed',
    checkpointId: 'step-one', value: {checkpointId: 'step-one', outcome: 'pass', words: 'one\ntwo'},
  });
  const input = {...page, askId: stored.askId, expectedGeneration: generation, submissionId: '646-replayed',
    kind: 'checkpoint', value: {checkpointId: 'step-one', outcome: 'pass', words: 'one\ntwo'}};
  expect(stored.schema).toBe('rig-review/act@6');
  expect(stored.value).toEqual({checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass',
    comments: [{text: 'one\ntwo', anchor: {checkpointId: 'step-one', planStepId: 'step-one'}}]});
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual({ok: true, value: stored});
  const changed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, value: {...input.value, words: 'two\none'}}));
  expect(changed).toMatchObject({ok: false, error: {code: 'JOB_IDEMPOTENCY_CONFLICT'}});
  expect(f.session.readActExport(stored.actId, false).toString()).toBe(JSON.stringify(stored));
});

test('#646 parts-and-feedback-text-limits: reuse existing feedback and scalar limits', () => {
  const act = commentsAct();
  const withText = (text: string) => ({...act, value: {...act.value, comments: [{text, anchor: feedbackAnchor()}]}});
  expect(parseCommentsAct(withText('x'.repeat(1000))).value.comments[0]!.text).toHaveLength(1000);
  for (const text of ['x'.repeat(1001), 'line\nline']) expect(() => parseCommentsAct(withText(text))).toThrow('JOB_ACT_INVALID');
  expect(() => projectComments([{text: 'x'.repeat(10000)}])).toThrow('JOB_ACT_INVALID');
});

test('#646 later-Apply-stable-wording: changing capture identity preserves logical target label', () => {
  const before = {text: 'Fix this', anchor: feedbackAnchor('old')}, after = {text: 'Fix this', anchor: feedbackAnchor('new')};
  expect(projectComments([before])).toBe('[["slot","sleeve",3,3,null]]\nFix this');
  expect(projectComments([after])).toBe(projectComments([before]));
});

test('#646 survey bytes stay readable and incomplete act@6 picks refuse', () => {
  const act = commentsAct();
  expect(() => parseCommentsAct({...act, kind: 'interview-picks', value: {comments: []}})).toThrow('JOB_ACT_INVALID');
  expect(jobHash(legacyComments.records.survey.raw)).toBe(legacyComments.records.survey.sha256);
  const survey = JSON.parse(legacyComments.records.survey.raw);
  expect(survey.picks[0].other_text).toBe('한글\r\nKeep spaces  \ne\u0301');
  expect(survey.note).toBe('  \n');
});

test('#646 question-answer-anchor-excluded: no question/ask feedback arm is invented', () => {
  const act = commentsAct();
  for (const anchor of [{questionId: 'framing', itemId: 'palette'}, {ask: 'palette'}]) {
    expect(() => parseCommentsAct({...act, value: {...act.value, comments: [{text: 'Answer text', anchor}]}})).toThrow('JOB_ACT_INVALID');
  }
});

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }

for (const schema of [JOB_API_SCHEMA, JOB_API_V3_SCHEMA]) {
  test(`#1319 fixture A: status omits act kind lists and only comments commit (${schema})`, async () => {
    const f = await fixture();
    const session = schema === JOB_API_SCHEMA ? f.session : new JobSession({
      root: f.root, stateDir: join(f.scratch, 'state-v3'), fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner'}, publicationMode: 'record-and-package',
      readPublished: async () => f.getContext(),
    });
    try {
      expect(session.apiSchema).toBe(schema);
      const ports = session === f.session ? f.ports : createJobHostPorts(session, f.origin);
      const {agent, ui} = session.hostCredentials();
      const url = `${f.origin}/jobs/${session.jobId}`;
      const call = async (body: object) => (await ports.handleJobApi(new Request(url + '/api', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + agent},
        body: JSON.stringify({...body, ...f.base(), schema, jobId: session.jobId}),
      }))).json();
      const uiPost = (path: 'displayed' | 'acts', body: object) => new Request(`${url}/ui/${path}`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Origin: f.origin, 'X-Review-Capability': ui},
        body: JSON.stringify(body),
      });

      const publish = await f.publishRequest();
      if (publish.verb !== 'publish') throw new Error('Expected a package publish request');
      const published = await call({...publish, expectedGeneration: session.status().generation,
        result: schema === JOB_API_V3_SCHEMA ? {kind: 'package', ...publish.result} : publish.result});
      expect(published).toMatchObject({ok: true, schema});
      const {publicationId, source} = published.value;
      const displayed = await ports.ackDisplayed(session.jobId, uiPost('displayed', {
        publicationId, pageId: 'page-1319', sourceHash: source.sourceHash,
      }));
      if (!displayed.ok) throw new Error(displayed.error.code);
      const before = session.status();
      expect(before.pending).toEqual([]);
      const submit = (body: object) => ports.commitUIAct(session.jobId, uiPost('acts', {
        ...displayed.value, expectedGeneration: before.generation, ...body,
      }));

      // Fresh legacy envelopes reach the replay-miss refusal. Reserved kinds can refuse during parsing.
      for (const kind of ['interview-picks', 'checkpoint', 'parts-verdict', 'review-verdict', 'signoff',
        'described-correction', 'mesh-edit']) {
        const refused = await submit({kind, askId: 'ask-1319', submissionId: `fresh-${kind}`, value: {}});
        expect(refused, kind).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
        expect(session.status()).toEqual(before);
      }

      const value = {comments: [{text: 'Current comment'}]};
      const saved = await submit({submissionId: 'comments-1319', kind: 'comments', value});
      expect(saved).toMatchObject({ok: true, value: {schema: 'rig-review/act@10', kind: 'comments', publicationId, value}});
      if (!saved.ok) throw new Error(saved.error.code);
      expect(Object.hasOwn(saved.value, 'askId')).toBe(false);
      const after = session.status();
      expect(after.generation).toBe(before.generation + 1);
      expect(after.pending).toEqual([]);
      const next = await call({verb: 'next', after: before.cursor, waitMs: 0});
      expect(next).toMatchObject({ok: true, schema});
      expect(next.value.events).toHaveLength(1);
      expect(next.value.events[0]).toMatchObject({type: 'act', act: saved.value});

      // Baseline is red here because status still owns enabledActKinds.
      const statusKeys = ['cursor', 'generation', 'jobId', 'pending', 'publication', 'status'];
      expect(Object.keys(before).sort()).toEqual(statusKeys);
      expect(Object.keys(after).sort()).toEqual(statusKeys);
    } finally {
      if (session !== f.session) session.dispose();
    }
  });
}

test('actual UI ports finalize exact whitespace-bearing comment text with host-declared authority and idempotent act IDs', async () => {
  const f = await fixture(), publication = await f.publish();
  // #1235: the sample act is the comment-only act@10; an act with no comment refuses (JOB_ACT_INVALID).
  for (const [index, text] of [' \n원문\t ', '원문\nline two'].entries()) {
    const page = await f.display(publication);
    const input = { ...page, expectedGeneration: f.session.status().generation,
      submissionId: 'submit-' + index, kind: 'comments', value: { comments: [{ text }] } };
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.value.value).toEqual({ comments: [{ text }] });
    expect(saved.value.authority).toEqual({ actor: 'human', channel: 'review-ui', reviewer: { id: 'declared-owner', role: 'owner' } });
    expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)))).toEqual(saved);
    const fetched = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: saved.value.actId }, f.session.writerGrant().fetchCapability)).json();
    expect(fetched.value).toEqual(saved.value);
  }
});

// #1229: fresh checkpoint submissions refuse JOB_ACT_KIND_DISABLED while browser-supplied authority still refuses JOB_REQUEST_INVALID
// and historical fail acts remain distinct nonapproval acts.
test('browser-supplied authority and fresh checkpoint submissions are refused; historical fail is a distinct nonapproval act', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const ask = seedHistoricalCheckpointAsk(f.session, publication.publicationId, { kind: 'checkpoint', checkpointId: 'step-one' });
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'checkpoint', kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pending', words: '' } };
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, authority: { actor: 'human' } }))).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID' } });
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    value: { ...input.value, outcome: 'pass', planStepId: 'different' } }))).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });
  const failed = seedHistoricalCheckpointAct(f.session, { ...page, expectedGeneration: f.session.status().generation,
    submissionId: 'historical-fail', checkpointId: 'step-one', value: { checkpointId: 'step-one', outcome: 'fail', words: '' } });
  expect(failed.kind).toBe('checkpoint');
  expect(parseCommentsAct(failed).value).toHaveProperty('outcome', 'fail');
});

test('#1229 fresh package checkpoint asks refuse JOB_REQUEST_INVALID, fresh submissions refuse JOB_ACT_KIND_DISABLED, and stored acts replay byte-for-byte', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const asked = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'refused-checkpoint', publicationId: publication.publicationId,
    subject: { kind: 'checkpoint', checkpointId: 'step-one' } })).json();
  expect(asked).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask' } });

  const legacyAsk = seedHistoricalCheckpointAsk(f.session, publication.publicationId, { kind: 'checkpoint', checkpointId: 'step-one' });
  const freshSubmit = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: legacyAsk.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'fresh-checkpoint', kind: 'checkpoint',
    value: { checkpointId: 'step-one', outcome: 'pass', words: 'fresh' } }));
  expect(freshSubmit).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });

  const replayGeneration = f.session.status().generation;
  const stored = seedHistoricalCheckpointAct(f.session, {
    ...page, expectedGeneration: replayGeneration, submissionId: 'replayed-checkpoint',
    checkpointId: 'step-one', value: { checkpointId: 'step-one', outcome: 'pass', words: 'one\ntwo' },
  });
  const replayInput = { ...page, askId: stored.askId, expectedGeneration: replayGeneration,
    submissionId: 'replayed-checkpoint', kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pass', words: 'one\ntwo' } };
  const replayed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(replayInput));
  expect(replayed).toEqual({ ok: true, value: stored });
  expect(f.session.readActExport(stored.actId, false).toString()).toBe(JSON.stringify(stored));
  const conflict = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...replayInput,
    value: { checkpointId: 'step-one', outcome: 'fail', words: 'one\ntwo' } }));
  expect(conflict).toMatchObject({ ok: false, error: { code: 'JOB_IDEMPOTENCY_CONFLICT' } });
});

test('#1227 fresh package sign-off asks refuse JOB_REQUEST_INVALID and page submissions refuse JOB_ACT_KIND_DISABLED while historical act@2 plan bounds stay', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const verdictAsk = seedHistoricalVerdictAsk(f.session, publication.publicationId, { kind: 'review-verdict', stage: 'rig-review' });
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
    const asked = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'refused-' + stage, publicationId: publication.publicationId, subject: { kind: 'signoff', stage } })).json();
    expect(asked).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask' } });
    const submitted = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: verdictAsk.askId,
      expectedGeneration: f.session.status().generation, submissionId: stage, kind: 'signoff',
      value: { stage, decision: 'approved', words: '' } }));
    expect(submitted).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });
    const historical = commentsAct();
    historical.kind = 'signoff';
    historical.value = { stage, decision: 'approved', comments: [] };
    expect(parseCommentsAct(historical).source.plan?.steps).toEqual([{ id: 'step-one', hash: '1'.repeat(64) }]);
    expect(() => parseCommentsAct({ ...historical, source: { ...historical.source, plan: null } })).toThrow('JOB_ACT_INVALID');
  }
  const missing = f.getContext();
  f.setContext({ ...missing, plan: null });
  const newer = await f.publish();
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
    const response = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'missing-' + stage, publicationId: newer.publicationId, subject: { kind: 'signoff', stage } })).json();
    expect(response.error).toEqual({code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'});
  }
});

test('P1 unrelated agent ask does not stale a captured pending UI act and future generations still refuse', async () => {
  const f = await fixture(), publication = await f.publish();
  // #1235: the captured sample is the comment-only act@10; it answers no ask.
  const page = await f.display(publication);
  const input = { ...page, expectedGeneration: f.session.status().generation,
    submissionId: 'captured-ui', kind: 'comments', value: { comments: [{ text: 'captured' }] } };
  const unrelated = seedHistoricalVerdictAsk(f.session, publication.publicationId, { kind: 'review-verdict', stage: 'rig-review' });
  const future = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    submissionId: 'future-ui', expectedGeneration: f.session.status().generation + 1 }));
  expect(future.ok).toBe(false);
  if (!future.ok) expect(future.error.code).toBe('JOB_GENERATION_STALE');
  const agentGeneration = f.session.status().generation;
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) console.log(JSON.stringify({ pendingUIRefusal: saved.error }));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value).not.toHaveProperty('askId');
  expect(f.session.status().pending.map(item => item.askId)).toContain(unrelated.askId);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  const staleAgent = await (await f.call({ ...f.base(), verb: 'close', expectedGeneration: agentGeneration,
    idempotencyKey: 'stale-agent-cas', reason: 'stale CAS control' })).json();
  expect(staleAgent.error.code).toBe('JOB_GENERATION_STALE');
});

test('pending UI act still refuses a rotated nonce, changed source and superseded publication', async () => {
  const f = await fixture(), publication = await f.publish();
  // #1235: the sample act is the comment-only act@10.
  const page = await f.display(publication);
  const input = { ...page, expectedGeneration: f.session.status().generation,
    submissionId: 'pending-bindings', kind: 'comments' as const, value: { comments: [{ text: 'pending bindings' }] } };
  const freshPage = await f.display(publication);
  seedHistoricalVerdictAsk(f.session, publication.publicationId, { kind: 'review-verdict', stage: 'rig-review' });
  const wrongNonce = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(wrongNonce.ok).toBe(false);
  if (!wrongNonce.ok) expect(wrongNonce.error.code).toBe('JOB_DISPLAY_MISMATCH');
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, revision: 'changed-source' }));
  const changed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, ...freshPage }));
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.code).toBe('JOB_SOURCE_MISMATCH');
  const newer = await f.publish();
  expect(newer.publicationId).not.toBe(publication.publicationId);
  const oldPublication = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, ...freshPage }));
  expect(oldPublication.ok).toBe(false);
  if (!oldPublication.ok) expect(oldPublication.error.code).toBe('JOB_ACT_SOURCE_STALE');
});

test('#1230 fresh package interview-picks asks refuse JOB_REQUEST_INVALID and submissions refuse JOB_ACT_KIND_DISABLED while historical picks acts decode byte-identically', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const asked = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'refused-picks', publicationId: publication.publicationId,
    subject: { kind: 'interview-picks', questionId: 'question-one', setId: 'set-one' } })).json();
  expect(asked).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask' } });
  const verdictAsk = seedHistoricalVerdictAsk(f.session, publication.publicationId, { kind: 'review-verdict', stage: 'rig-review' });
  const value = { questionId: 'question-one', selections: [{ itemId: 'item-one', optionId: 'value-one', otherText: null }], note: '원문' };
  const submitted = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: verdictAsk.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'refused-picks', kind: 'interview-picks', value }));
  expect(submitted).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });
  // Stored bytes in the removed writer's key order (questionId, selections, note, comments).
  const bytes = JSON.stringify(parseCommentsAct(packagePicksCommentsAct()));
  expect(JSON.parse(bytes).value).toMatchObject({ questionId: 'question-one', note: '  Survey note\r\n' });
  expect(JSON.stringify(parseCommentsAct(JSON.parse(bytes)))).toBe(bytes);
});

function packagePicksCommentsAct() {
  const {source, ...envelope} = commentsAct();
  const sha256 = 'a'.repeat(64);
  const crop = {path: `comment-crops/${sha256}.png`, sha256, width: 2, height: 3};
  return {...envelope, source: {...source, optionSet: {id: 'set-one', sha256}}, kind: 'interview-picks', value: {
    questionId: 'question-one', note: '  Survey note\r\n', selections: [
      {itemId: 'palette', optionId: 'other', otherText: '한글\r\n  '},
      {itemId: 'framing', optionId: 'wide', otherText: null},
    ],
    comments: [
      {text: '  첫 번째\r\n'},
      {text: 'Second\t ', anchor: {name: 'reference.png'}},
      {text: 'e\u0301\nThird', anchor: {name: 'reference.png', imageRegion: {x: 1, y: 2, width: 2, height: 3}, crop, nativeCrop: crop}},
    ],
  }};
}

test('#646 act@6 decodes package picks with exact comment text, order and image anchors', () => {
  const input = packagePicksCommentsAct();
  const decoded = parseCommentsAct(input);
  const {questionId, selections, note, comments} = input.value;
  expect(JSON.stringify(decoded)).toBe(JSON.stringify({...input, value: {questionId, selections, note, comments}}));
  expect(projectComments(decoded.value.comments)).toBe('[general]\n  첫 번째\r\n\n\n[["reference.png"]]\nSecond\t \n\n[["reference.png"]]\ne\u0301\nThird');
});

test('#646 act@6 picks refuses words, unknown members and checkpoint anchors by name', () => {
  const act = packagePicksCommentsAct();
  for (const extra of [
    {words: ''},
    {selections: [{...act.value.selections[0], extra: true}]},
    {comments: [{text: 'x', anchor: {name: 'reference.png', extra: true}}]},
    {comments: [{text: 'x', anchor: {checkpointId: 'step-one', planStepId: 'step-one'}}]},
    {comments: [{text: 'x', anchor: {questionId: 'question-one', itemId: 'palette'}}]},
  ]) expect(() => parseCommentsAct({...act, value: {...act.value, ...extra}})).toThrow('JOB_ACT_INVALID');
});

test('#646 picks requires an option-set identity and keeps act@7 closed', () => {
  const act = packagePicksCommentsAct();
  expect(() => parseCommentsAct({...act, source: {...act.source, optionSet: null}})).toThrow('JOB_ACT_INVALID');
  expect(() => parseContextCommentsAct({...act, schema: 'rig-review/act@7'})).toThrow('JOB_ACT_INVALID');
});

test('comment-only acts preserve pointed Parts comments and general text, validate issue bindings and bind all referenced bytes', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { project: true, painting: true });
  await writeFile(join(f.root,'out/parts.json'),JSON.stringify({rig_size:[30,20],parts:[
    {name:'body',x:0,y:0,w:20,h:20},{name:'head',x:10,y:0,w:20,h:20},
  ]}));
  parts.manifest.sha256=jobHash(await readFile(join(f.root,'out/parts.json')));
  f.setContext({...f.getContext(),parts});
  const publication = await f.publish();
  const retained=f.session.retainedSource(publication.publicationId);
  const pkg=await loadPartsView(join(retained.snapshotRoot,'out'));
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, { kind: 'parts-verdict', draftId: 'synthetic-draft' });
  const page = await f.display(publication);
  const bodyHash = parts.images.find(img => img.path === 'parts/body.png' && img.role === 'part')!.sha256;
  const headHash = parts.images.find(img => img.path === 'parts/head.png' && img.role === 'part')!.sha256;
  const cropPng=PNG.sync.write(new PNG({width:3,height:4})),cropSha=jobHash(cropPng);
  const unpreparedIssue = {
    schema: 'rig-review-parts-comment/2' as const,
    id: 'issue-item',
    summary: 'Seam gap on body',
    parts: [{ name: 'body', imageHash: bodyHash }],
    sourceHash: publication.source.sourceHash,
    imageRegion: { x: 1, y: 2, width: 3, height: 4 },
    rigRegion: { x: 1, y: 2, width: 3, height: 4 },
    view: {
      mode: 'item' as const,
      cameraSync: false,
      referenceCamera: null,
      camera: { zoom: 1, center: { x: 10, y: 10 }, viewport: { width: 100, height: 100 } },
      background: 'checker' as const,
      alpha: false,
      footprints: true,
      mesh: false,
    },
    crop: { path: `comment-crops/${cropSha}.png`, sha256: cropSha, width: 3, height: 4, png:'data:image/png;base64,'+cropPng.toString('base64') },
    nativeCrop: null,
  };
  const prepared = await preparePartsComment(pkg, unpreparedIssue, false, {sourceHash: publication.source.sourceHash});
  const {png: _inlinePng, ...storedCrop} = prepared.crop;
  const itemIssue = {...prepared, crop: storedCrop};
  expect(itemIssue.nativeCrop).not.toBeNull();
  const assembledIssue = {
    ...itemIssue,
    nativeCrop:null,
    id: 'issue-assembled',
    summary: 'Overlap between body and head',
    parts: [{ name: 'body', imageHash: bodyHash }, { name: 'head', imageHash: headHash }],
    imageRegion: null,
    view: { ...itemIssue.view, mode: 'assembled' as const },
  };
  const issues = [itemIssue, assembledIssue];
  const pinned = partsIssueComments(issues);
  const general = [' \n원문 ', '  Parts general 한글  ', 'Another observation'];
  const comments = [...pinned, ...general.map(text => ({text}))];
  const input = {...page, expectedGeneration: f.session.status().generation,
    submissionId: 'parts-submit', kind: 'comments', value: {comments}};
  const invalidIssues = [
    {...itemIssue, parts: []},
    {...itemIssue, parts: [{name: 'body', imageHash: bodyHash}, {name: 'body', imageHash: bodyHash}],
      imageRegion: null, view: {...itemIssue.view, mode: 'assembled'}},
    {...itemIssue, parts: [{name: 'unknown', imageHash: bodyHash}]},
    {...itemIssue, parts: [{name: 'body', imageHash: '0'.repeat(64)}]},
    {...itemIssue, sourceHash: '0'.repeat(64)},
    {...itemIssue, imageRegion: null},
    {...assembledIssue, imageRegion: {x: 1, y: 2, width: 3, height: 4}},
    {...assembledIssue, rigRegion: {x: 1.5, y: 2, width: 3, height: 4}},
    {...itemIssue, nativeCrop: null},
    {...itemIssue, crop: {...storedCrop, path: 'comment-crops/' + 'b'.repeat(64) + '.png', sha256: 'b'.repeat(64)}},
    {...itemIssue, nativeCrop: {...itemIssue.nativeCrop!, path: 'comment-crops/' + 'c'.repeat(64) + '.png', sha256: 'c'.repeat(64)}},
    {...itemIssue, rigRegion: {...itemIssue.rigRegion, x: itemIssue.rigRegion.x + 1}},
    {...itemIssue, nativeCrop: {...itemIssue.nativeCrop!, width: 4}},
  ];
  const db = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
  const document = () => db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?')
    .get(f.session.jobId)!.document;
  const before = document();
  try {
    for (const {summary: text, ...anchor} of invalidIssues) {
      const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, value: {comments: [{text, anchor}]}}));
      expect(rejected, JSON.stringify(anchor)).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
      expect(document()).toBe(before);
    }
  } finally { db.close(); }
  const [saved, replayed] = await Promise.all([
    f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)),
    f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)),
  ]);
  expect(replayed).toEqual(saved);
  if (!saved.ok) throw new Error(saved.error.code);
  const act = parseCommentOnlyAct(saved.value);
  expect(act.value).toEqual({comments});
  if ('record' in act.source || !act.source.projectHash) throw new Error('Expected a project-bound Parts act');
  expect(act.source.parts).toEqual(parts);
  expect(act.source.projectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(f.session.status().pending.map(pending => pending.askId)).toContain(ask.askId);
  const raw = f.session.readActExport(act.actId, false).toString();
  expect(raw).toBe(JSON.stringify(saved.value));
  expect(JSON.stringify(act)).toBe(raw);
  expect(projectComments(act.value.comments)).toBe(projectComments(pinned) + '\n\n[general]\n' + general.join('\n\n[general]\n'));
  const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: act.actId}, f.session.writerGrant().fetchCapability)).json();
  expect(fetched.value).toEqual(act);
  const reopened = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    expect(await reopened.execute({...f.base(), verb: 'fetch-act', actId: act.actId}, new AbortController().signal)).toEqual(act);
    expect(commentPartsIssues(act.value.comments)).toEqual(issues);
    for (const issue of commentPartsIssues(act.value.comments)) {
      expect(parsePartsIssue(issue, true, false, false)).toEqual(issue);
      expect(await validateStoredPartsComment(pkg, issue, false, {sourceHash: publication.source.sourceHash})).toEqual(issue);
    }
  } finally { reopened.dispose(); }
  const picks = packagePicksCommentsAct();
  expect(JSON.stringify(parseCommentsAct({...picks, value: {...picks.value, comments: pinned}}).value.comments))
    .toBe(JSON.stringify(pinned));
  const { parseManifest, parsePanelComposition } = await import('../src/manifest.ts');
  const panels = {
    schema: 'rig-review/panels@1' as const,
    left: ['parts.list' as const],
    stage: ['parts.canvas' as const],
    toolbar: ['parts.layers' as const],
    side: ['parts.issues' as const, 'act.submit' as const],
  };
  const withPanels = parseManifest({
    schema: 'rig-review/1', id: 'pkg', title: 'Test Package', revision: 'r1', model: 'rig.model.json', panels,
  });
  expect(withPanels.panels).toEqual(panels);
  const withoutPanels = parseManifest({
    schema: 'rig-review/1', id: 'pkg', title: 'Test Package', revision: 'r1', model: 'rig.model.json',
  });
  expect(withoutPanels.panels).toBeUndefined();
  for (const side of [['parts.issues'], []] as const) {
    const accepted = {...panels, side};
    expect(parsePanelComposition(accepted)).toEqual(accepted);
    expect(parseManifest({
      schema: 'rig-review/1', id: 'pkg', title: 'Test Package', revision: 'r1', model: 'rig.model.json',
      panels: accepted,
    }).panels).toEqual(accepted);
  }
  for (const invalidPanels of [
    { ...panels, schema: 'rig-review/panels@0' },
    { ...panels, stage: ['parts.canvas', 'rig.playback'] },
    { ...panels, unknownSlot: ['parts.list'] },
  ]) {
    expect(() => parsePanelComposition(invalidPanels)).toThrow('JOB_PANELS_INVALID');
    expect(parseManifest({
      schema: 'rig-review/1', id: 'pkg', title: 'Test Package', revision: 'r1', model: 'rig.model.json',
      panels: invalidPanels,
    }).panels).toBeUndefined();
  }
  const withUnknownComponent = parseManifest({
    schema: 'rig-review/1', id: 'pkg', title: 'Test Package', revision: 'r1', model: 'rig.model.json',
    panels: { ...panels, stage: ['unknown-component'] },
  });
  expect(withUnknownComponent.panels?.stage as readonly string[]).toEqual(['unknown-component']);
  await writeFile(join(f.root, 'out/parts/depth.png'), 'changed depth only');
  const stale = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    submissionId: 'stale-parts', expectedGeneration: f.session.status().generation }));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe('JOB_SOURCE_MISMATCH');
});

test('parseUISubmission accepts all 5 enabled act kinds, preserves String(kind) conversion, refuses reserved kinds first and rejects invalid kinds', async () => {
  const base = { publicationId: 'publication-one', askId: 'ask-one', pageId: 'page-one', displayedNonce: 'nonce-one',
    expectedGeneration: 0, submissionId: 'submit-one', value: {} };
  expect(JOB_ENABLED_ACT_KINDS).toEqual(['interview-picks', 'checkpoint', 'parts-verdict', 'review-verdict', 'signoff']);
  for (const kind of JOB_ENABLED_ACT_KINDS) {
    const input = { ...base, kind };
    expect(parseUISubmission(input)).toEqual(input as unknown as JobUISubmission);
  }
  const stringified = { ...base, kind: ['checkpoint'] };
  expect(parseUISubmission(stringified)).toEqual(stringified as unknown as JobUISubmission);
  for (const kind of JOB_RESERVED_ACT_KINDS) {
    expect(() => parseUISubmission({ ...base, kind })).toThrow('JOB_ACT_KIND_DISABLED');
    expect(() => parseUISubmission({ ...base, publicationId: '', expectedGeneration: -1, kind })).toThrow('JOB_ACT_KIND_DISABLED');
  }
  for (const kind of ['unknown-kind', '', null, undefined, 42, ['unknown-kind']]) {
    expect(() => parseUISubmission({ ...base, kind })).toThrow('JOB_ACT_INVALID');
  }
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  for (const kind of JOB_RESERVED_ACT_KINDS) {
    const reserved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: 'ask-one',
      expectedGeneration: f.session.status().generation, submissionId: 'reserved-' + kind, kind, value: {} }));
    expect(reserved).toEqual({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED', message: 'JOB_ACT_KIND_DISABLED' } });
  }
  for (const kind of ['unknown-kind', '']) {
    const invalid = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: 'ask-one',
      expectedGeneration: f.session.status().generation, submissionId: 'invalid-' + kind, kind, value: {} }));
    expect(invalid).toEqual({ ok: false, error: { code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID' } });
  }
});

type StillRows = {acts: Record<string, unknown>; replays: Record<string, {digest: string; value: unknown}>};

function seedHistoricalRigStill(f: Awaited<ReturnType<typeof jobFixture>>, publication?: Awaited<ReturnType<typeof f.publish>>) {
  const {store} = f.session as unknown as {store: JobStore<StillRows>};
  const fixture = historicalRig;
  const act = publication ? {...fixture.receipt.value, jobId: f.session.jobId, publicationId: publication.publicationId, source: publication.source}
    : fixture.receipt.value;
  const actBytes = Buffer.from(publication ? JSON.stringify(act) : fixture.still.actBytes);
  const png = Buffer.from(fixture.still.png, 'base64');
  store.update(f.session.jobId, null, ({data}) => {
    data.acts[act.actId] = act;
    if (!publication) data.replays[fixture.key] = fixture.receipt;
    return {data, still: {actId: act.actId, pageId: fixture.request.pageId, submissionId: fixture.request.submissionId,
      sha256: fixture.still.sha256, binding: fixture.still.binding, png, actBytes}};
  });
  return {act, actBytes, png};
}

test('#557 historical rig still exports with original act and PNG bytes through the consumer port', async () => {
  const f = await fixture();
  const {act, actBytes, png} = seedHistoricalRigStill(f);
  expect(actBytes.toString()).toBe(historicalRig.bytes);
  expect(jobHash(actBytes)).toBe(historicalRig.sha256);
  expect(JSON.stringify(parseCommentsAct(JSON.parse(actBytes.toString())))).toBe(historicalRig.bytes);
  for (const [accept, bytes, contentType] of [
    ['image/png', png, 'image/png'],
    ['application/vnd.rig-review.act+json', actBytes, 'application/vnd.rig-review.act+json'],
  ] as const) {
    const response = await f.ports.handleJobApi(new Request(f.origin + '/jobs/' + f.session.jobId + '/api', {
      method: 'POST', headers: {'Content-Type': 'application/json', Accept: accept,
        Authorization: 'Bearer ' + f.session.writerGrant().fetchCapability},
      body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: act.actId}),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe(contentType);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }
});

test('#557 historical rig motion stills preserve exact seconds and animation in the decoder', () => {
  for (const [frame, animation] of [[0, 'still'], [0.375, 'inspect']] as const) {
    const still = {...historicalRig.receipt.value.still, frame, animation};
    const act = {...historicalRig.receipt.value, still};
    expect(JSON.stringify(parseCommentsAct(act))).toBe(JSON.stringify(act));
    const {animation: _animation, ...withoutAnimation} = still;
    expect(() => parseCommentsAct({...act, still: withoutAnimation})).toThrow('JOB_ACT_INVALID');
  }
});

test('#1233 rig capture and parts payloads refuse on replay miss without writing an act or still', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  const {capture, ...withoutCapture} = input;
  const before = f.session.status();
  for (const submission of [input, withoutCapture,
    {...input, capture: {...capture, png: 'data:image/png;base64,YmFk'}},
    {...withoutCapture, kind: 'parts-verdict', value: {verdict: 'approved', issues: [], words: ''}},
  ]) {
    expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission)))
      .toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
    expect(f.session.status()).toEqual(before);
  }
  expect(before.pending.map(ask => ask.askId)).toContain(input.askId);
  const db = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
  try { expect(db.query('SELECT * FROM job_act_stills').all()).toHaveLength(0); }
  finally { db.close(); }
});

for (const boundary of ['attachment-insert', 'job-update']) {
  test('#557 retained still transaction rolls back the BLOB and document on ' + boundary + ' failure', async () => {
    const f = await fixture();
    const db = new Database(join(f.state, 'jobs.sqlite'));
    try {
      const storedJob = () => db.query<{revision: number; document: string}, [string]>(
        'SELECT revision, document FROM jobs WHERE job_id=?',
      ).get(f.session.jobId)!;
      const before = storedJob();
      const fixtureActId = historicalRig.receipt.value.actId;
      const target = boundary === 'attachment-insert'
        ? `INSERT ON job_act_stills WHEN NEW.act_id = '${fixtureActId}'`
        : `UPDATE ON jobs WHEN EXISTS (
            SELECT 1 FROM job_act_stills WHERE job_id = NEW.job_id AND act_id = '${fixtureActId}'
          )`;
      db.exec(`CREATE TRIGGER fail_still_commit BEFORE ${target}
        BEGIN SELECT RAISE(ABORT, '557 planted storage fault'); END`);
      expect(() => seedHistoricalRigStill(f)).toThrow(expect.objectContaining({
        code: 'JOB_STORAGE_FAILED', message: 'Job transaction could not be committed',
      }));
      expect(db.query('SELECT * FROM job_act_stills').all()).toHaveLength(0);
      expect(storedJob()).toEqual(before);
      db.exec('DROP TRIGGER fail_still_commit');
      const {act, actBytes, png} = seedHistoricalRigStill(f);
      expect(storedJob().revision).toBe(before.revision + 1);
      expect(f.session.readActExport(act.actId, false)).toEqual(actBytes);
      expect(f.session.readActExport(act.actId, true)).toEqual(png);
    } finally { db.close(); }
  });
}

test('#557 historical still survives close and blocks publication snapshot reclaim', async () => {
  const f = await fixture(), publication = await f.publish();
  const {act, actBytes, png} = seedHistoricalRigStill(f, publication);
  const retained = f.session.retainedSource(publication.publicationId);
  const grant = f.session.writerGrant().fetchCapability;
  const snapshotHash = jobSnapshotHash(retained.seals);
  await f.session.execute({...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
    idempotencyKey: '557-close', reason: 'synthetic close'}, new AbortController().signal);
  for (const accept of ['image/png', 'application/vnd.rig-review.act+json']) {
    const response = await f.ports.handleJobApi(new Request(f.origin + '/jobs/' + f.session.jobId + '/api', {
      method: 'POST', headers: {'Content-Type': 'application/json', Accept: accept, Authorization: 'Bearer ' + grant},
      body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: act.actId}),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('JOB_CLOSED');
  }
  await expect(f.session.reclaimSnapshot(publication.publicationId, snapshotHash)).rejects.toThrow('JOB_SNAPSHOT_PINNED');
  const db = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
  try {
    const row = db.query<{png: Uint8Array; act_bytes: Uint8Array}, []>('SELECT png,act_bytes FROM job_act_stills').get()!;
    expect(Buffer.from(row.png)).toEqual(png);
    expect(Buffer.from(row.act_bytes)).toEqual(actBytes);
  } finally { db.close(); }
});

test('#557 backend exact @2 historical rig act remains readable without a PNG backfill', async () => {
  const f = await fixture();
  // The @3 fixture has the same legacy verdict value and adds only the still.
  const {still: _still, ...envelope} = JSON.parse(legacyComments.records['@3'].raw);
  const legacy = {...envelope, schema: 'rig-review/act@2'};
  const {store} = f.session as unknown as {store: JobStore<StillRows>};
  store.update(f.session.jobId, null, ({data}) => {
    data.acts[legacy.actId] = legacy;
    return {data};
  });
  const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: legacy.actId}, f.session.writerGrant().fetchCapability)).json();
  expect(JSON.stringify(fetched.value)).toBe(JSON.stringify(legacy));
  expect(f.session.readActExport(legacy.actId, false).toString()).toBe(JSON.stringify(legacy));
  expect(() => f.session.readActExport(legacy.actId, true)).toThrow('JOB_STILL_UNAVAILABLE');
});

test('#794 / #1227 package direction signoff still parses on publish and historical acts while fresh asks and submissions refuse', async () => {
  const f = await fixture(), context = f.getContext();
  f.setContext({...context, plan: null, subjects: [{kind: 'signoff', stage: 'direction-review'}]});
  const publication = await f.publish(), page = await f.display(publication);
  expect(publication.source.plan).toBeNull();
  const asked = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'direction-signoff-ask', publicationId: publication.publicationId, subject: {kind: 'signoff', stage: 'direction-review'}})).json();
  expect(asked).toMatchObject({ok: false, error: {code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'}});
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: '00000000-0000-4000-8000-000000000001',
    expectedGeneration: f.session.status().generation, submissionId: 'direction-signoff', kind: 'signoff',
    value: {stage: 'direction-review', decision: 'approved', words: '  Original direction approval\n'}}));
  expect(saved).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});

  // A pre-existing act@6 package signoff is independent of the new record allowlist and still parses byte-identically.
  const historical = {...commentsAct(), kind: 'signoff',
    value: {stage: 'direction-review', decision: 'approved', comments: [{text: '  Original direction approval\n'}]}};
  historical.source.plan = null;
  const historicalBytes = JSON.stringify(historical);
  expect(JSON.stringify(parseCommentsAct(JSON.parse(historicalBytes)))).toBe(historicalBytes);
});

test('#800 / #1227 package interview signoff still parses on publish and historical acts while fresh asks and submissions refuse', async () => {
  const f = await fixture(), context = f.getContext();
  f.setContext({...context, plan: null, subjects: [{kind: 'signoff', stage: 'interview'}]});
  const publication = await f.publish(), page = await f.display(publication);
  expect(publication.source.plan).toBeNull();
  const asked = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'interview-signoff-ask', publicationId: publication.publicationId, subject: {kind: 'signoff', stage: 'interview'}})).json();
  expect(asked).toMatchObject({ok: false, error: {code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'}});
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: '00000000-0000-4000-8000-000000000002',
    expectedGeneration: f.session.status().generation, submissionId: 'interview-signoff', kind: 'signoff',
    value: {stage: 'interview', decision: 'approved', words: '  Original interview approval\n'}}));
  expect(saved).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});

  // A pre-existing act@6 package signoff is independent of the new record allowlist and still parses byte-identically.
  const historical = {...commentsAct(), kind: 'signoff',
    value: {stage: 'interview', decision: 'approved', comments: [{text: '  Original interview approval\n'}]}};
  historical.source.plan = null;
  const historicalBytes = JSON.stringify(historical);
  expect(JSON.stringify(parseCommentsAct(JSON.parse(historicalBytes)))).toBe(historicalBytes);
});
