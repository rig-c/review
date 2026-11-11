import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {afterEach, expect, test} from 'bun:test';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {jobRigScreenDecisions, jobRigScreenRoute, jobRigScreenSubject} from '../web/job-rig-screen.ts';
import {checkpointNoteComments, feedbackItemComments} from '../src/stage-comment.ts';
// The projector Create applies to act@6 comments: the public job-host export (Create c8382ba5 pins @rig-c/review 2.12.0).
import {parseCommentsAct, projectComments} from '../src/job-host.ts';
import legacy from './fixtures/comments-contract-legacy.json';
import type {DisplayPublicationV3, PendingAskV3} from '../src/job-contract.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }
const feedback: Feedback = {id: 'one', frameStart: 3, frameEnd: 5, target: {kind: 'slot', name: 'sleeve'}, category: 'defect',
  summary: 'Sleeve tears at the elbow\nduring the swing'};
function session(value: Partial<Pick<ReviewSession, 'status' | 'checkpoints' | 'feedback'>>) {
  return {status: 'pending' as const, checkpoints: {}, feedback: [], ...value};
}
/** What the act carries apart from its own identity and time: the bytes a consumer reads. */
function actBytes(act: {actId: string; askId: string; at: string}): string {
  const {actId: _actId, askId: _askId, at: _at, ...rest} = act;
  return JSON.stringify(rest);
}

test('#715 mixed rig verdict and supported modal asks stay on the shared screen', async () => {
  const f = await fixture(), publication = await f.publish();
  const display = {publication} as unknown as DisplayPublicationV3, ids = new Set(['step-one']);
  expect(jobRigScreenSubject(publication.source as DisplayPublicationV3['publication']['source'])).toBe(true);
  const verdict = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const checkpoint = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const asks = [verdict, checkpoint] as unknown as PendingAskV3[];
  expect(jobRigScreenRoute(display, asks, ids)).toBe(true);
  expect(jobRigScreenRoute(display, asks, new Set())).toBe(false);
  const signoff = {...verdict, askId: 'signoff', subject: {kind: 'signoff', stage: 'rig-review'}} as unknown as PendingAskV3;
  expect(jobRigScreenRoute(display, [...asks, signoff], ids)).toBe(true);
  expect(jobRigScreenRoute(display, [...asks, {...signoff, status: 'answered'}], ids)).toBe(true);
  expect(jobRigScreenRoute(display, [...asks, {...signoff, publicationId: 'other'}], ids)).toBe(true);
  const interview = {...signoff, subject: {kind: 'interview-picks', questionId: 'q', setId: 's'}} as unknown as PendingAskV3;
  expect(jobRigScreenRoute(display, [interview], ids)).toBe(true);
  for (const subject of [{kind: 'parts-verdict', draftId: 'd'}, {kind: 'reopen', stage: 'rig-review'},
    {kind: 'review-verdict', stage: 'direction-review'}, {kind: 'review-verdict', stage: 'image-review'},
    {kind: 'checkpoint', checkpointId: 'undeclared'}]) {
    expect(jobRigScreenRoute(display, [...asks, {...signoff, subject} as PendingAskV3], ids)).toBe(false);
  }
  const image = {...publication, source: {...publication.source, subject: 'image-set'}};
  expect(jobRigScreenSubject(image.source as unknown as DisplayPublicationV3['publication']['source'])).toBe(false);
  expect(jobRigScreenRoute({publication: image} as unknown as DisplayPublicationV3, [], ids)).toBe(false);
  const draft = {...publication, source: {...publication.source, selector: {kind: 'draft', id: 'd'}}};
  expect(jobRigScreenRoute({publication: draft} as unknown as DisplayPublicationV3, [], ids)).toBe(false);
});

test('#709 pending decisions are never sent; the verdict goes last and words are the comments\' projection', async () => {
  const f = await fixture(), publication = await f.publish();
  const verdict = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const checkpoint = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const asks = [verdict, checkpoint] as unknown as PendingAskV3[];
  expect(jobRigScreenDecisions(session({}), asks, publication.publicationId)).toEqual([]);
  expect(jobRigScreenDecisions(session({checkpoints: {'step-one': {outcome: 'pending', note: 'x'}}}), asks, publication.publicationId)).toEqual([]);
  const decided = jobRigScreenDecisions(session({status: 'changes-requested', feedback: [feedback],
    checkpoints: {'step-one': {outcome: 'fail', note: ' '}}}), asks, publication.publicationId);
  expect(decided.map(item => item.kind)).toEqual(['checkpoint', 'review-verdict']);
  expect(decided[0]!.value).toEqual({checkpointId: 'step-one', outcome: 'fail', words: ''});
  expect(decided[1]!.value).toEqual({stage: 'rig-review', verdict: 'changes-requested',
    words: '[["slot","sleeve",3,5,null]]\nSleeve tears at the elbow\nduring the swing', feedback: [feedback]});
  expect(jobRigScreenDecisions(session({status: 'approved'}), asks, 'other-publication')).toEqual([]);
});

test('#746 the rig screen keeps act@6 and structured feedback instead of a general words projection', async () => {
  const f = await fixture(), publication = await f.publish();
  const rows = [{...feedback, summary: 'Sleeve tears at the elbow'}];
  const note = projectComments(feedbackItemComments(rows));
  async function commit(askId: string, value: unknown, submissionId: string) {
    const ask = f.session.status().pending.find(item => item.askId === askId)!, page = await f.display(publication);
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId, expectedGeneration: f.session.status().generation,
      submissionId, kind: 'review-verdict', value, capture: rigStillCapture(publication, ask as never, page).capture}));
    if (!result.ok) throw new Error(result.error.code);
    return result.value as unknown as {actId: string; askId: string; at: string};
  }
  const today = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  // The job window's value shape `{stage, verdict, words}`, carrying the same words.
  const before = await commit(today.askId, {stage: 'rig-review', verdict: 'approved', words: note}, 'today');
  const after = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const [decision] = jobRigScreenDecisions(session({status: 'approved', feedback: rows}),
    f.session.status().pending as unknown as PendingAskV3[], publication.publicationId);
  expect(decision!.ask.askId).toBe(after.askId);
  expect(decision!.value.words).toBe(note);
  const screen = await commit(after.askId, decision!.value, 'screen');
  expect(parseCommentsAct(screen)).toMatchObject({schema: 'rig-review/act@6', kind: 'review-verdict',
    value: {comments: feedbackItemComments(rows)}});
  expect(projectComments(parseCommentsAct(screen).value.comments)).toBe(note);
  expect(parseCommentsAct(before).value.comments).toEqual([{text: note}]);
  expect(actBytes(screen)).not.toBe(actBytes(before));
});

test('#709 a checkpoint act from the rig screen has the job window\'s kind, version and shape; words are the projection', async () => {
  const f = await fixture(), publication = await f.publish();
  const note = projectComments(checkpointNoteComments({checkpointId: 'step-one', planStepId: 'step-one', note: 'Elbow seam opens'}));
  async function commit(askId: string, value: unknown, submissionId: string) {
    const page = await f.display(publication);
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId, expectedGeneration: f.session.status().generation,
      submissionId, kind: 'checkpoint', value}));
    if (!result.ok) throw new Error(result.error.code);
    return result.value as unknown as {actId: string; askId: string; at: string};
  }
  const today = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const before = await commit(today.askId, {checkpointId: 'step-one', outcome: 'pass', words: note}, 'today');
  const after = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const [decision] = jobRigScreenDecisions(session({checkpoints: {'step-one': {outcome: 'pass', note: 'Elbow seam opens'}}}),
    f.session.status().pending as unknown as PendingAskV3[], publication.publicationId);
  expect(decision!.value).toEqual({checkpointId: 'step-one', outcome: 'pass', words: '[["checkpoint","step-one"]]\nElbow seam opens'});
  expect(decision!.value.words).toBe(note);
  const screen = await commit(after.askId, decision!.value, 'screen');
  expect(actBytes(screen)).toBe(actBytes(before));
});

test('#709 for the same comments[], words equal the job-host projectComments byte for byte; zero comments write empty words', () => {
  const ask = (askId: string, subject: unknown) => ({askId, publicationId: 'p', status: 'pending', subject, source: {}}) as unknown as PendingAskV3;
  const item = (id: string, summary: string): Feedback => ({...feedback, id, summary});
  for (const rows of [[], [item('a', 'one line')], [item('a', '  lead and trail  \n'), item('b', '원문 그대로\t둘째 줄')]]) {
    const [decision] = jobRigScreenDecisions(session({status: 'approved', feedback: rows}), [ask('v', {kind: 'review-verdict', stage: 'rig-review'})], 'p');
    expect(decision!.value.words).toBe(projectComments(feedbackItemComments(rows)));
  }
  for (const note of ['', ' \n\t', 'Elbow seam opens', '  keep\nspacing  ']) {
    const [decision] = jobRigScreenDecisions(session({checkpoints: {'step-one': {outcome: 'fail', note}}}),
      [ask('c', {kind: 'checkpoint', checkpointId: 'step-one'})], 'p');
    // An empty or whitespace-only note is no comment: comments [] project to '' and nothing is padded.
    const comments = note.trim() ? checkpointNoteComments({checkpointId: 'step-one', planStepId: 'step-one', note}) : [];
    expect(decision!.value.words).toBe(projectComments(comments));
  }
  expect(projectComments([])).toBe('');
});

test('#709 act@6 accepts comments [] for a rig verdict and a checkpoint, and refuses a whitespace-only comment as JOB_ACT_INVALID', () => {
  const at3 = JSON.parse(legacy.records['@3'].raw), at2 = JSON.parse(legacy.records['@2'].raw);
  const acts = [{...at3, schema: 'rig-review/act@6', value: {stage: 'rig-review', verdict: 'approved', comments: []}},
    {...at2, schema: 'rig-review/act@6', value: {checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass', comments: []}}];
  for (const act of acts) {
    expect(projectComments(parseCommentsAct(act).value.comments)).toBe('');
    expect(() => parseCommentsAct({...act, value: {...act.value, comments: [{text: ' '}]}})).toThrow('JOB_ACT_INVALID');
  }
});

test('#709 the rig screen still does not depend on the mesh or bone overlay toggles', async () => {
  // The still is rendered from the posed model with tool overlays excluded (docs/REVIEW_PACKAGE.md, "Rig verdict
  // still backend"); mesh edges and bone points are overlays, so they no longer make the whole rig ineligible.
  const main = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const stage = main.slice(main.indexOf('function hostStage():RigHostStage|null {'), main.indexOf('/** Old feedback bookmarks keep'));
  expect(stage).toContain('wholeRig:!rigDifference&&!parts?.value()&&player.slots===null&&layers.images,');
  expect(stage).not.toContain('layers.mesh');
  expect(stage).not.toContain('layers.bones');
});

// The job window retains only the image and direction verdict owners; rig capture belongs to this shared screen.
test('#709 job-window rig verdict mount and capture path are deleted, not hidden by a test override', async () => {
  const source = await Bun.file(new URL('../web/job-session.ts', import.meta.url)).text();
  const form = source.slice(source.indexOf('    function formFor('), source.indexOf('    function updateForms('));
  expect(form).toContain("else if (subject.kind === 'review-verdict' && (subject.stage === 'image-review' || subject.stage === 'direction-review'))");
  expect(form).not.toContain("else if (subject.kind === 'review-verdict')");
  expect(form).not.toContain('rigSubmission');
  expect(source).not.toContain('copyRigVerdict');
  expect(source).not.toContain('createJobRigSubmission');
  expect(source).not.toContain('freezeJobRigCapture');
  expect(source).not.toContain('copyJobRigViewport');
  const controls = await Bun.file(new URL('./job-window.test.ts', import.meta.url)).text();
  expect(controls).not.toContain('legacy' + 'RigForm');
});
