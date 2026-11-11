import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import { afterEach, expect, test } from 'bun:test';
import { finalizeJobAct, parseUISubmission } from '../src/job-act.ts';
import { JOB_ENABLED_ACT_KINDS, JOB_RESERVED_ACT_KINDS, type JobPendingAsk, type JobUISubmission } from '../src/job-contract.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobFixture, syntheticJobParts } from './helpers/job-api-fixture.ts';
import {rigStillInput, rigStillCapture} from './helpers/job-rig-still.ts';
import {JobSession} from '../src/job-session.ts';
import {Database} from 'bun:sqlite';
import {jobSnapshotHash} from '../src/job-source.ts';
import {loadPartsView} from '../src/parts-view.ts';
import {preparePartsComment,validateStoredPartsComment} from '../src/parts-comment-crops.ts';
import {parsePartsIssue} from '../src/parts-comment.ts';
import {jobHash} from '../src/job-api.ts';
import {PNG} from 'pngjs';
import {parseCommentsAct, projectComments, parseRecordAct, type JobComment} from '../src/job-host.ts';
import {legacyFeedbackComments} from '../src/feedback-export.ts';
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

test('#646 ordered-general-and-image: exact whitespace and stored order use existing image names', () => {
  const act = commentsAct(), old = act.source;
  const images = [{name: 'original', role: 'source', path: 'original.png', sha256: 'a'.repeat(64)},
    {name: 'candidate', role: 'candidate', path: 'candidate.png', sha256: 'b'.repeat(64)}];
  const {selector: _selector, model: _model, ...common} = old;
  act.source = {...common, subject: 'image-set', imageSet: {purpose: 'plate-adoption', images},
    imageSetDigest: jobHash(JSON.stringify(images.map(({name, role, sha256}) => ({role, name, sha256})))), duplicateHashes: []};
  act.kind = 'review-verdict';
  act.value = {stage: 'image-review', verdict: 'approved', comments: [{text: '  First\nline  '}, {text: 'Second', anchor: {name: 'candidate'}}]};
  const parsed = parseCommentsAct(act);
  expect(projectComments(parsed.value.comments)).toBe('[general]\n  First\nline  \n\n[["candidate"]]\nSecond');
  const bad = structuredClone(act); bad.value.comments[1].anchor.name = 'unbound';
  expect(() => parseCommentsAct(bad)).toThrow('JOB_ACT_INVALID');
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

test('#646 source-and-replay-negative: UI @6 remains OFF and current replay digest stays authoritative', async () => {
  const f = await fixture(), publication = await f.publish(), ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'}),
    page = await f.display(publication);
  const base = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation, submissionId: '646-writer-off',
    kind: 'checkpoint', value: {checkpointId: 'step-one', outcome: 'pass', comments: [{text: 'one'}, {text: 'two'}]}};
  const generation = f.session.status().generation;
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(base))).ok).toBe(false);
  expect(f.session.status().generation).toBe(generation);
  const input = {...base, value: {checkpointId: 'step-one', outcome: 'pass', words: 'one\ntwo'}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.schema).toBe('rig-review/act@2');
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  const changed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, value: {...input.value, words: 'two\none'}}));
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.code).toBe('JOB_IDEMPOTENCY_CONFLICT');
  expect(f.session.readActExport(saved.value.actId, false).toString()).toBe(JSON.stringify(saved.value));
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

test('#646 interview-excluded-from-act6: survey bytes and existing answer inputs remain unchanged', () => {
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

test('actual UI ports finalize exact empty/whitespace words with host-declared authority and idempotent act IDs', async () => {
  const f = await fixture(), publication = await f.publish();
  for (const text of ['', ' \n\t ', '원문\nline two']) {
    const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' });
    const page = await f.display(publication);
    const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
      submissionId: 'submit-' + ask.askId, kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pass', words: text } };
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.value.value).toEqual({ checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass', words: text });
    expect(saved.value.authority).toEqual({ actor: 'human', channel: 'review-ui', reviewer: { id: 'declared-owner', role: 'owner' } });
    expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)))).toEqual(saved);
    const fetched = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: saved.value.actId }, f.session.writerGrant().fetchCapability)).json();
    expect(fetched.value).toEqual(saved.value);
  }
});

test('pending checkpoint and browser-supplied authority/plan mapping are refused; fail is a distinct nonapproval act', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'checkpoint', kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pending', words: '' } };
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).ok).toBe(false);
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, authority: { actor: 'human' } }))).ok).toBe(false);
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    value: { ...input.value, outcome: 'pass', planStepId: 'different' } }))).ok).toBe(false);
  const failed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, value: { ...input.value, outcome: 'fail' } }));
  expect(failed.ok).toBe(true);
  if (failed.ok) { expect(failed.value.kind).toBe('checkpoint'); expect(failed.value.value).toHaveProperty('outcome', 'fail'); }
});

test('all three plan sign-off stages require published IDs/hashes and accept only approval with exact words', async () => {
  const f = await fixture(), publication = await f.publish();
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
    const ask = await f.ask(publication, { kind: 'signoff', stage }), page = await f.display(publication);
    const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
      submissionId: stage, kind: 'signoff', value: { stage, decision: 'approved', words: '' } };
    const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, value: { ...input.value, decision: 'changes-requested' } }));
    expect(rejected.ok).toBe(false);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.source.plan?.steps).toEqual([{ id: 'step-one', hash: '1'.repeat(64) }]);
  }
  const missing = f.getContext();
  f.setContext({ ...missing, plan: null });
  const newer = await f.publish();
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
    const response = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'missing-' + stage, publicationId: newer.publicationId, subject: { kind: 'signoff', stage } })).json();
    expect(response.error.code).toBe('JOB_ASK_INVALID');
  }
});

test('review verdict remains separate from sign-off and is bound to the displayed model/version', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' }), page = await f.display(publication);
  const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'review', kind: 'review-verdict',
    value: { stage: 'rig-review', verdict: 'approved', words: 'exact verdict' },
    capture: rigStillCapture(publication, ask, page).capture }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.source.model).toEqual(publication.source.model);
    expect(result.value.source.selector).toEqual({ kind: 'rig', version: 1 });
    expect(result.value.kind).toBe('review-verdict');
  }
  expect(f.session.status().pending).toHaveLength(0);
});

test('P1 unrelated agent ask does not stale a captured pending UI act and future generations still refuse', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'captured-ui', kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pass', words: '' } };
  const unrelated = await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' });
  const future = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    submissionId: 'future-ui', expectedGeneration: f.session.status().generation + 1 }));
  expect(future.ok).toBe(false);
  if (!future.ok) expect(future.error.code).toBe('JOB_GENERATION_STALE');
  const agentGeneration = f.session.status().generation;
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) console.log(JSON.stringify({ pendingUIRefusal: saved.error }));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.askId).toBe(ask.askId);
  expect(f.session.status().pending.map(item => item.askId)).toContain(unrelated.askId);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  const duplicate = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    submissionId: 'duplicate-ui', expectedGeneration: f.session.status().generation }));
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.error.code).toBe('JOB_ASK_SUPERSEDED');
  const staleAgent = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: agentGeneration,
    idempotencyKey: 'stale-agent-cas', publicationId: publication.publicationId,
    subject: { kind: 'review-verdict', stage: 'rig-review' } })).json();
  expect(staleAgent.error.code).toBe('JOB_GENERATION_STALE');
});

test('pending UI act still refuses a rotated nonce, changed source and superseded publication', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'pending-bindings', kind: 'checkpoint' as const, value: { checkpointId: 'step-one', outcome: 'pass' as const, words: '' } };
  const freshPage = await f.display(publication);
  await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' });
  const wrongNonce = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(wrongNonce.ok).toBe(false);
  if (!wrongNonce.ok) expect(wrongNonce.error.code).toBe('JOB_DISPLAY_MISMATCH');
  const retained = f.session.retainedSource(publication.publicationId);
  expect(() => finalizeJobAct({ jobId: f.session.jobId, submission: { ...input, ...freshPage },
    ask: { ...ask, status: 'superseded' }, retained, reviewer: { id: 'declared-owner', role: 'owner' } })).toThrow('JOB_ASK_SUPERSEDED');
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

test('synthetic private adapters validate ordered interview picks without exposing storage formats', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const question = { ref: { path: 'synthetic/options.json', sha256: '2'.repeat(64) }, editable: true,
    set: { id: 'set-one', question: 'question-one', stage: 'interview', drafted_by: 'synthetic', drafted_at: '2020-01-01T00:00:00Z',
      asks: [{ id: 'item-one', prompt: 'Choose', options: [{ id: 'value-one', kind: 'value', label: 'One', effect: 'One', recommended: true }] }],
      assembly: { rule: 'single' } }, images: [], hasParts: false } as const;
  const withQuestion = { ...retained, questions: [structuredClone(question)] } as unknown as typeof retained;
  const ask: JobPendingAsk = { askId: 'ask-one', publicationId: publication.publicationId,
    subject: { kind: 'interview-picks', questionId: 'question-one', setId: 'set-one' },
    source: { ...retained.source, optionSet: { id: 'set-one', sha256: question.ref.sha256 } }, status: 'pending' };
  const common = { publicationId: publication.publicationId, askId: ask.askId, pageId: 'page', displayedNonce: 'nonce',
    expectedGeneration: 1, submissionId: 'submission' };
  const submission: JobUISubmission = { ...common, kind: 'interview-picks', value: {
    questionId: 'question-one', selections: [{ itemId: 'item-one', optionId: 'value-one', otherText: null }], note: '원문' } };
  const act = finalizeJobAct({ jobId: f.session.jobId, submission, ask, retained: withQuestion,
    reviewer: { id: 'owner', role: 'owner' } });
  expect(act.kind).toBe('interview-picks');
  expect(act.value).toEqual(submission.value);
  expect(() => finalizeJobAct({ jobId: f.session.jobId, submission: { ...submission, value: {
    ...submission.value, selections: [{ itemId: 'different', optionId: 'value-one', otherText: null }] } },
  ask, retained: withQuestion, reviewer: { id: 'owner', role: 'owner' } })).toThrow('JOB_ACT_INVALID');
});

test('parts-verdict UI save finalizes rig-review/act@5 with issues[], preserves words, rejects invalid issue bindings and binds all referenced bytes', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { project: true, painting: true });
  await writeFile(join(f.root,'out/parts.json'),JSON.stringify({rig_size:[30,20],parts:[
    {name:'body',x:0,y:0,w:20,h:20},{name:'head',x:10,y:0,w:20,h:20},
  ]}));
  parts.manifest.sha256=jobHash(await readFile(join(f.root,'out/parts.json')));
  f.setContext({...f.getContext(),parts});
  const publication = await f.publish();
  const retained=f.session.retainedSource(publication.publicationId);
  const pkg=await loadPartsView(join(retained.snapshotRoot,'out'));
  const ask = await f.ask(publication, { kind: 'parts-verdict', draftId: 'synthetic-draft' });
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
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'parts-submit', kind: 'parts-verdict',
    value: { verdict: 'changes-requested' as const, issues: [itemIssue, assembledIssue], words: ' \n원문 ' } };
  const invalidValues = [
    { verdict: 'approved', issues: [itemIssue], words: '' },
    { verdict: 'changes-requested', issues: [], words: '' },
    { verdict: 'changes-requested', issues: [{ ...itemIssue, parts: [] }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...itemIssue, parts: [{ name: 'body', imageHash: bodyHash }, { name: 'body', imageHash: bodyHash }], imageRegion: null, view: { ...itemIssue.view, mode: 'assembled' } }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...itemIssue, parts: [{ name: 'unknown', imageHash: bodyHash }] }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...itemIssue, parts: [{ name: 'body', imageHash: '0'.repeat(64) }] }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...itemIssue, sourceHash: '0'.repeat(64) }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...itemIssue, imageRegion: null }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...assembledIssue, imageRegion: { x: 1, y: 2, width: 3, height: 4 } }], words: '' },
    { verdict: 'changes-requested', issues: [{ ...assembledIssue, rigRegion: { x: 1.5, y: 2, width: 3, height: 4 } }], words: '' },
    { verdict: 'approved', parts: [], words: '' },
    { verdict: 'changes-requested', issues: [{...itemIssue, nativeCrop: null}], words: '' },
    { verdict: 'changes-requested', issues: [{
      ...itemIssue,
      crop: {...storedCrop, path: `comment-crops/${'b'.repeat(64)}.png`, sha256: 'b'.repeat(64)},
    }], words: '' },
    { verdict: 'changes-requested', issues: [{
      ...itemIssue,
      nativeCrop: {...itemIssue.nativeCrop!, path: `comment-crops/${'c'.repeat(64)}.png`, sha256: 'c'.repeat(64)},
    }], words: '' },
    { verdict: 'changes-requested', issues: [{
      ...itemIssue, rigRegion: {...itemIssue.rigRegion, x: itemIssue.rigRegion.x + 1},
    }], words: '' },
    { verdict: 'changes-requested', issues: [{...itemIssue, nativeCrop: {...itemIssue.nativeCrop!, width: 4}}], words: '' },
  ];
  const db = new Database(join(f.state, 'jobs.sqlite'));
  const storedDocument = () => db.query<{document: string}, [string]>(
    'SELECT document FROM jobs WHERE job_id=?',
  ).get(f.session.jobId)!.document;
  const before = storedDocument();
  try {
    for (const badValue of invalidValues) {
      const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, value: badValue}));
      expect(rejected.ok, JSON.stringify(badValue)).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe('parts' in badValue ? 'JOB_REQUEST_INVALID' : 'JOB_ACT_INVALID');
      expect(storedDocument()).toBe(before);
      expect(f.session.status().pending.map(pending => pending.askId)).toContain(ask.askId);
    }
  } finally { db.close(); }
  const unpreparedSubmission = parseUISubmission({...input,
    value: {verdict: 'changes-requested', issues: [{...itemIssue, nativeCrop: null}], words: ''},
  });
  expect(() => finalizeJobAct({jobId: f.session.jobId, submission: unpreparedSubmission, ask, retained,
    reviewer: {id: 'declared-owner', role: 'owner'},
  })).toThrow('JOB_ACT_INVALID');
  const [saved, replayed] = await Promise.all([
    f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)),
    f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)),
  ]);
  expect(replayed).toEqual(saved);
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.schema).toBe('rig-review/act@5');
  expect(saved.value.kind).toBe('parts-verdict');
  expect(saved.value.value).toEqual(input.value);
  expect(saved.value.source.parts).toEqual(parts);
  expect(saved.value.source.projectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  const fetched = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: saved.value.actId }, f.session.writerGrant().fetchCapability)).json();
  expect(fetched.value).toEqual(saved.value);
  const reopened = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    const restored = await reopened.execute({...f.base(), verb: 'fetch-act', actId: saved.value.actId}, new AbortController().signal);
    expect(restored).toEqual(saved.value);
    if (saved.value.kind !== 'parts-verdict' || saved.value.schema !== 'rig-review/act@5') throw new Error('Expected parts act');
    for (const issue of saved.value.value.issues) {
      expect(parsePartsIssue(issue, true, false, false)).toEqual(issue);
      expect(await validateStoredPartsComment(pkg, issue, false, {sourceHash: publication.source.sourceHash})).toEqual(issue);
    }
  } finally { reopened.dispose(); }
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
  for (const invalidPanels of [
    { ...panels, schema: 'rig-review/panels@0' },
    { ...panels, stage: ['parts.canvas', 'rig.playback'] },
    { ...panels, side: ['parts.issues'] },
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
  const mutableAsk=await f.ask(publication,{kind:'parts-verdict',draftId:'synthetic-draft'});
  const mutableInput={...input,askId:mutableAsk.askId,submissionId:'parts-mutable',
    expectedGeneration:f.session.status().generation,value:structuredClone(input.value)};
  const pending=f.session.commitUIAct(mutableInput);
  mutableInput.value.issues[0]!.rigRegion.x++;
  const isolated=await pending;
  expect(isolated.value).toEqual(input.value);
  const secondAsk = await f.ask(publication, { kind: 'parts-verdict', draftId: 'synthetic-draft' });
  await writeFile(join(f.root, 'out/parts/depth.png'), 'changed depth only');
  const stale = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, askId: secondAsk.askId,
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

test('#557 R01 setup UI submission finalizes act@3 with a daemon-hashed top-level PNG still', async () => {
  const f = await fixture();
  const {input, bytes, sha256} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value).toMatchObject({schema: 'rig-review/act@3', value: input.value,
    still: {path: sha256 + '.png', sha256, camera: 'fixed', frame: 'setup'}});
  expect(saved.value).not.toHaveProperty('sha256');
  expect(saved.value).not.toHaveProperty('manifest');
  const response = await f.ports.handleJobApi(new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'image/png',
      Authorization: 'Bearer ' + f.session.writerGrant().fetchCapability},
    body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: saved.value.actId}),
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
});

for (const [frame, animation] of [[0, 'still'], [0.375, 'inspect']] as const) {
  test(`#557 R02 playing ${animation} at ${frame} seconds retains exact named motion time`, async () => {
    const f = await fixture();
    const {input, sha256} = await rigStillInput(f, frame, animation);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.value).toMatchObject({schema: 'rig-review/act@3',
      still: {path: sha256 + '.png', sha256, camera: 'fixed', frame, animation}});
  });
}

test('#557 R02 numeric motion capture without an animation refuses by name', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f, 0.375);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(false);
  if (!saved.ok) expect(saved.error.code).toBe('JOB_STILL_CAPTURE_FAILED');
  expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
});

test('#557 R03 missing capture refuses by name before answering the rig ask', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  const {capture: _capture, ...withoutCapture} = input;
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(withoutCapture));
  expect(saved.ok).toBe(false);
  if (!saved.ok) expect(saved.error.code).toBe('JOB_STILL_CAPTURE_FAILED');
  expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
});

for (const camera of ['panned', 'zoomed']) {
  test(`#557 R04 ${camera} capture refuses the nondefault camera by name`, async () => {
    const f = await fixture();
    const {input} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId,
      f.uiRequest({...input, capture: {...input.capture, camera}}));
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('JOB_STILL_CAMERA_NOT_FIXED');
    expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
  });
}

for (const view of ['solo', 'highlight', 'comparison']) {
  test(`#557 R05 ${view} capture refuses the partial or comparison view by name`, async () => {
    const f = await fixture();
    const {input} = await rigStillInput(f);
    const saved = await f.ports.commitUIAct(f.session.jobId,
      f.uiRequest({...input, capture: {...input.capture, view}}));
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('JOB_STILL_VIEW_UNSUPPORTED');
    expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
  });
}

test('#557 R06 mismatched capture page refuses before a durable act is created', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  const capture = {...input.capture, binding: {...input.capture.binding, pageId: 'other-page'}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, capture}));
  expect(saved.ok).toBe(false);
  if (!saved.ok) expect(saved.error.code).toBe('JOB_STILL_BINDING_MISMATCH');
  expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
});

test('#557 R07 concurrent retry returns the first capture and restart preserves the act bytes', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  const [first, replay] = await Promise.all([
    f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)),
    f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)),
  ]);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error.code);
  expect(replay).toEqual(first);
  const changed = {...input, capture: {...input.capture, frame: 0.5, animation: 'inspect'}};
  const conflict = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(changed));
  expect(conflict.ok).toBe(false);
  if (!conflict.ok) expect(conflict.error.code).toBe('JOB_IDEMPOTENCY_CONFLICT');
  const reopened = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    const request = {...f.base(), verb: 'fetch-act' as const, actId: first.value.actId};
    expect(await reopened.execute(request, new AbortController().signal)).toEqual(first.value);
  } finally {
    reopened.dispose();
  }
});

for (const boundary of ['attachment-insert', 'job-update']) {
  test(`#557 backend ${boundary} failure rolls back PNG, act, replay and event together`, async () => {
    const f = await fixture();
    const {input} = await rigStillInput(f);
    const db = new Database(join(f.state, 'jobs.sqlite'));
    try {
      const before = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document;
      const target = boundary === 'attachment-insert' ? 'INSERT ON job_act_stills' : 'UPDATE ON jobs';
      db.exec(`CREATE TRIGGER fail_still_commit BEFORE ${target} BEGIN SELECT RAISE(ABORT,'557 planted storage fault'); END`);
      const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe('JOB_STORAGE_FAILED');
      expect(db.query('SELECT * FROM job_act_stills').all()).toHaveLength(0);
      expect(db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document).toBe(before);
      db.exec('DROP TRIGGER fail_still_commit');
      const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error.code);
      const rows = db.query<{png: Uint8Array; act_bytes: Uint8Array}, []>('SELECT png,act_bytes FROM job_act_stills').all();
      expect(rows).toHaveLength(1);
      expect(Buffer.from(rows[0].act_bytes)).toEqual(Buffer.from(JSON.stringify(saved.value)));
      expect(f.session.readActExport(saved.value.actId, false)).toEqual(Buffer.from(rows[0].act_bytes));
    } finally { db.close(); }
  });
}

test('#557 backend finalized PNG survives close and reclaim while both consumer representations revoke', async () => {
  const f = await fixture();
  const {input, publication, bytes} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const retained = f.session.retainedSource(publication.publicationId);
  const grant = f.session.writerGrant().fetchCapability;
  const snapshotHash = jobSnapshotHash(retained.seals);
  await f.session.execute({...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
    idempotencyKey: '557-close', reason: 'synthetic close'}, new AbortController().signal);
  for (const accept of ['image/png', 'application/vnd.rig-review.act+json']) {
    const response = await f.ports.handleJobApi(new Request(f.origin + `/jobs/${f.session.jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Accept: accept, Authorization: 'Bearer ' + grant},
      body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: saved.value.actId}),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('JOB_CLOSED');
  }
  await expect(f.session.reclaimSnapshot(publication.publicationId, snapshotHash)).rejects.toThrow('JOB_SNAPSHOT_PINNED');
  const db = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
  try {
    const row = db.query<{png: Uint8Array; act_bytes: Uint8Array}, []>('SELECT png,act_bytes FROM job_act_stills').get()!;
    expect(Buffer.from(row.png).equals(bytes)).toBe(true);
    expect(Buffer.from(row.act_bytes).toString('utf8')).toBe(JSON.stringify(saved.value));
  } finally { db.close(); }
});

test('#557 backend exact @2 historical rig act remains readable without a PNG backfill', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const db = new Database(join(f.state, 'jobs.sqlite'));
  try {
    const original = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!;
    const data = JSON.parse(original.document);
    const legacy = {...data.acts[saved.value.actId], schema: 'rig-review/act@2'};
    delete legacy.still;
    data.acts[saved.value.actId] = legacy;
    const legacyDocument = JSON.stringify(data);
    db.query('UPDATE jobs SET document=? WHERE job_id=?').run(legacyDocument, f.session.jobId);
    const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId}, f.session.writerGrant().fetchCapability)).json();
    expect(JSON.stringify(fetched.value)).toBe(JSON.stringify(legacy));
    expect(f.session.readActExport(saved.value.actId, false).toString('utf8')).toBe(JSON.stringify(legacy));
    expect(() => f.session.readActExport(saved.value.actId, true)).toThrow('JOB_STILL_UNAVAILABLE');
    expect(db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(f.session.jobId)!.document).toBe(legacyDocument);
  } finally { db.close(); }
});

test('#557 backend malformed PNG and forged hash fields cannot create an attachment or answer the ask', async () => {
  const f = await fixture();
  const {input} = await rigStillInput(f);
  for (const capture of [
    {...input.capture, png: 'data:image/png;base64,YmFk'},
    {...input.capture, width: 16385},
    {...input.capture, sha256: '0'.repeat(64)},
  ]) {
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, capture}));
    expect(result.ok).toBe(false);
    expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
  }
  const db = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
  try { expect(db.query('SELECT * FROM job_act_stills').all()).toHaveLength(0); }
  finally { db.close(); }
});

for (const [field, value] of [['sourceHash', 'wrong-source'], ['askId', 'other-ask'], ['instanceKey', 'other-instance'],
  ['drawGeneration', 0], ['playerGeneration', -1]] as const) {
  test(`#557 backend capture ${field} mismatch refuses before commit`, async () => {
    const f = await fixture();
    const {input} = await rigStillInput(f);
    const capture = {...input.capture, binding: {...input.capture.binding, [field]: value}};
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, capture}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('JOB_STILL_BINDING_MISMATCH');
    expect(f.session.status().pending.map(ask => ask.askId)).toContain(input.askId);
  });
}
