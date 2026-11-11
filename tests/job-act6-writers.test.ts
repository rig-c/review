import {afterEach, expect, test} from 'bun:test';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {bindJobAsk, finalizeJobAct} from '../src/job-act.ts';
import {jobHash} from '../src/job-api.ts';
import {parseCommentsAct, projectComments} from '../src/job-host.ts';
import {checkpointNoteComments, noteComments, partsIssueComments} from '../src/feedback-export.ts';
import type {JobComment, JobPendingAsk, JobUISubmission} from '../src/job-contract.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import vendored from './fixtures/act6-projection-create-c8382ba5.json';
useTemporaryReviewState();

// #713: fresh checkpoint, signoff, parts-verdict and rig/post review-verdict acts are act@6.
// Image-review and interview-picks stay act@2 (Create refuses them under @6); record acts stay act@4.

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {for (const f of fixtures.splice(0)) await f.close();});
async function fixture() {const f = await jobFixture(); fixtures.push(f); return f;}
const reviewer = {id: 'declared-owner', role: 'owner'} as const;

/** The stored act, its export bytes and the public decoder agree exactly. */
function roundTrip(f: Awaited<ReturnType<typeof fixture>>, act: {actId: string}) {
  const bytes = f.session.readActExport(act.actId, false).toString();
  expect(bytes).toBe(JSON.stringify(act));
  expect(parseCommentsAct(JSON.parse(bytes))).toEqual(act as never);
}

test('checkpoint and signoff UI acts are written as act@6 and read back through the public decoder', async () => {
  const f = await fixture(), publication = await f.publish();
  const checkpointAsk = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const signoffAsk = await f.ask(publication, {kind: 'signoff', stage: 'plan-approved'});
  const page = await f.display(publication);
  const checkpoint = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: checkpointAsk.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'act6-checkpoint', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'fail', words: '  Exact 한글\n'}}));
  if (!checkpoint.ok) throw new Error(checkpoint.error.code);
  expect(checkpoint.value).toMatchObject({schema: 'rig-review/act@6', kind: 'checkpoint', value: {
    checkpointId: 'step-one', planStepId: 'step-one', outcome: 'fail',
    comments: [{text: '  Exact 한글\n', anchor: {checkpointId: 'step-one', planStepId: 'step-one'}}]}});
  roundTrip(f, checkpoint.value);
  const signoff = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: signoffAsk.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'act6-signoff', kind: 'signoff',
    value: {stage: 'plan-approved', decision: 'approved', words: ' \n원문 그대로\t '}}));
  if (!signoff.ok) throw new Error(signoff.error.code);
  expect(signoff.value).toMatchObject({schema: 'rig-review/act@6', kind: 'signoff',
    value: {stage: 'plan-approved', decision: 'approved', comments: [{text: ' \n원문 그대로\t '}]}});
  roundTrip(f, signoff.value);
});

test('rig verdict keeps its still under act@6 and reads back through the public decoder', async () => {
  const f = await fixture(), {input, sha256} = await rigStillInput(f);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.schema).toBe('rig-review/act@6');
  expect(saved.value).toMatchObject({kind: 'review-verdict', still: {path: sha256 + '.png', sha256, camera: 'fixed'}});
  expect(f.session.readActExport(saved.value.actId, false).toString()).toBe(JSON.stringify(saved.value));
  expect(parseCommentsAct(JSON.parse(JSON.stringify(saved.value)))).toEqual(saved.value as never);
});

test('post direction verdict is written as act@6 and read back through the public decoder', async () => {
  const f = await fixture(), publication = await f.publish();
  const base = f.session.retainedSource(publication.publicationId);
  const retained = {...base, source: {...base.source, selector: {kind: 'post' as const, version: 2, rigVersion: 1},
    direction: {path: 'out/direction.json', sha256: 'd'.repeat(64)}}} as typeof base;
  const subject = {kind: 'review-verdict', stage: 'direction-review'} as const;
  const ask: JobPendingAsk = {askId: 'ask-post', publicationId: publication.publicationId, subject,
    source: bindJobAsk(subject, retained), status: 'pending'};
  const submission = {publicationId: publication.publicationId, askId: ask.askId, pageId: 'page', displayedNonce: 'nonce',
    expectedGeneration: 1, submissionId: 'post', kind: 'review-verdict',
    value: {stage: 'direction-review', verdict: 'changes-requested', words: 'tighten the turn'}} as JobUISubmission;
  const act = finalizeJobAct({jobId: f.session.jobId, submission, ask, retained, reviewer});
  expect(act).toMatchObject({schema: 'rig-review/act@6', kind: 'review-verdict',
    value: {stage: 'direction-review', verdict: 'changes-requested', comments: [{text: 'tighten the turn'}]}});
  expect(act).not.toHaveProperty('still');
  expect(parseCommentsAct(JSON.parse(JSON.stringify(act)))).toEqual(act as never);
});

test('image-review stays pinned at act@2 with words and imageNotes', async () => {
  const f = await fixture();
  const bytes = await readFile(join(f.root, 'out/rigid.png'));
  const images = [0, 1].map(index => ({role: index ? 'candidate' as const : 'source' as const,
    name: `Image ${index}`, path: `image-${index}.png`, sha256: jobHash(bytes)}));
  for (const image of images) await writeFile(join(f.root, image.path), bytes);
  await writeFile(join(f.root, 'out/review.json'), JSON.stringify({schema: 'rig-review/1',
    id: 'image-set-fixture', title: 'Synthetic image set', revision: 'one', references: []}));
  f.setContext({selector: null, plan: null, parts: null, subjects: [], partIds: [], files: [],
    imageSet: {purpose: 'plate-adoption', images}});
  const publication = await f.publish(), ask = await f.ask(publication, {kind: 'review-verdict', stage: 'image-review'});
  const page = await f.display(publication);
  const value = {stage: 'image-review', verdict: 'approved', words: '  exact  ', imageNotes: [{name: 'Image 0', words: ' note '}]};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'image-pin', kind: 'review-verdict', value}));
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.schema).toBe('rig-review/act@2');
  expect(saved.value.value).toEqual(value);
});

test('interview-picks stays pinned at act@2 with its note', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const question = {ref: {path: 'synthetic/options.json', sha256: '2'.repeat(64)}, editable: true,
    set: {id: 'set-one', question: 'question-one', stage: 'interview', drafted_by: 'synthetic', drafted_at: '2020-01-01T00:00:00Z',
      asks: [{id: 'item-one', prompt: 'Choose', options: [{id: 'value-one', kind: 'value', label: 'One', effect: 'One', recommended: true}]}],
      assembly: {rule: 'single'}}, images: [], hasParts: false} as const;
  const withQuestion = {...retained, questions: [structuredClone(question)]} as unknown as typeof retained;
  const ask: JobPendingAsk = {askId: 'ask-one', publicationId: publication.publicationId,
    subject: {kind: 'interview-picks', questionId: 'question-one', setId: 'set-one'},
    source: {...retained.source, optionSet: {id: 'set-one', sha256: question.ref.sha256}}, status: 'pending'};
  const submission: JobUISubmission = {publicationId: publication.publicationId, askId: ask.askId, pageId: 'page',
    displayedNonce: 'nonce', expectedGeneration: 1, submissionId: 'submission', kind: 'interview-picks', value: {
      questionId: 'question-one', selections: [{itemId: 'item-one', optionId: 'value-one', otherText: null}], note: '  원문 '}};
  const act = finalizeJobAct({jobId: f.session.jobId, submission, ask, retained: withQuestion, reviewer});
  expect(act.schema).toBe('rig-review/act@2');
  expect(act.value).toEqual(submission.value);
});

test('an empty or whitespace-only note has no comment form: zero comments, nothing padded', () => {
  for (const words of ['', ' ', ' \n\t ']) expect(noteComments(words)).toEqual([]);
  expect(noteComments(' x ')).toEqual([{text: ' x '}]);
});

test('a note whose act@6 projection exceeds 10,000 UTF-16 units is refused by name (JOB_ACT_INVALID)', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'signoff', stage: 'plan-approved'}), page = await f.display(publication);
  const generation = f.session.status().generation;
  // Act@2 accepted words up to 10,000 units; the @6 scalar adds the "[general]\n" label inside the same bound.
  const words = 'x'.repeat(10000 - '[general]\n'.length + 1);
  const refused = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: generation, submissionId: 'too-long', kind: 'signoff', value: {stage: 'plan-approved', decision: 'approved', words}}));
  expect(refused).toEqual({ok: false, error: {code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID'}});
  expect(f.session.status().generation).toBe(generation);
  const fits = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: generation, submissionId: 'fits', kind: 'signoff',
    value: {stage: 'plan-approved', decision: 'approved', words: words.slice(1)}}));
  expect(fits.ok).toBe(true);
});

test('writer comments project to the bytes Create c8382ba5 computes (vendored from the v2.12.0 projector)', () => {
  const cases = vendored.cases as Record<string, {comments: JobComment[]; projected: string}>;
  for (const [name, {comments, projected}] of Object.entries(cases)) expect(projectComments(comments), name).toBe(projected);
  // The writer mappers produce exactly these comments for the corresponding submissions.
  expect(noteComments('')).toEqual(cases.empty!.comments);
  expect(checkpointNoteComments({checkpointId: 'motion-card', planStepId: 'step-one', note: '  Exact 한글\n'}))
    .toEqual(cases.checkpointNote!.comments);
  expect(noteComments(' \n원문 그대로\t ')).toEqual(cases.generalNote!.comments);
  const [vendoredIssue, vendoredNote] = cases.partsIssuesAndNote!.comments;
  const issue = {...vendoredIssue!.anchor, summary: vendoredIssue!.text} as unknown as PartsIssue;
  const written = [...partsIssueComments([issue]), ...noteComments(vendoredNote!.text)];
  expect(written).toEqual(cases.partsIssuesAndNote!.comments);
  expect(projectComments(written)).toBe(cases.partsIssuesAndNote!.projected);
});
