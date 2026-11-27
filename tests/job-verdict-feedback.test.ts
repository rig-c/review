import {afterEach, expect, test} from 'bun:test';
import {bindJobAsk} from '../src/job-act.ts';
import {jobHash, parseCommentOnlyAct, parseCommentsAct, parseContextCommentsAct} from '../src/job-api.ts';
import {feedbackContextComments, feedbackItemComments, parseStageComment, projectComments} from '../src/stage-comment.ts';
import type {JobContextComment, JobSubject} from '../src/job-contract.ts';
import type {JobActValues, JobCommentsActValues, JobLegacyAct, JobReviewStage, JobUIActValues} from '../src/job-host.ts';
import type {JobRetainedSource} from '../src/job-source.ts';
import type {Feedback} from '../src/session.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {noFeedbackBaseline as baseline, markedFeedback as marked} from './helpers/verdict-feedback-746.ts';
useTemporaryReviewState();

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {for (const f of fixtures.splice(0)) await f.close();});
async function fixture() {const f = await jobFixture(); fixtures.push(f); return f;}

/** Rebind synthetic marks to the publication under test, without recapturing or changing their evidence. */
function feedbackFor(source: typeof baseline.source): Feedback[] {
  const rows = structuredClone(marked.feedback);
  for (const row of rows) {
    row.target.name = source.package.id;
    const mark = row.context.comment;
    mark.sourceHash = mark.bookmark.binding.sourceHash = source.sourceHash;
    mark.modelHash = mark.bookmark.binding.rigs[0] = source.model.sha256;
  }
  return rows as Feedback[];
}

test('#746 the four historical envelopes retain exact act@6 bytes, including identity, time and still', () => {
  const source = baseline.source as unknown as JobRetainedSource['source'];
  const subject = {kind: 'review-verdict', stage: 'rig-review'} as const;
  const retained = {source, subjects: []} as unknown as JobRetainedSource;
  expect(JSON.stringify(bindJobAsk(subject, retained))).toBe(JSON.stringify(baseline.source));
  for (const item of baseline.cases) {
    expect(jobHash(item.raw)).toBe(item.sha256);
    const act = parseCommentsAct(JSON.parse(item.raw));
    expect(act).toMatchObject({actId: baseline.actId, at: baseline.at, still: baseline.still});
    expect(JSON.stringify(act)).toBe(item.raw);
  }
});

test('#746 the historical act@7 decoder retains ask-bound context on pointed and time-only comments', () => {
  const source = baseline.source as unknown as JobRetainedSource['source'];
  const selector = source.selector!;
  const ask = {kind: 'review-verdict', stage: 'rig-review'} as const;
  const subject = {ask, sourceHash: source.sourceHash, selector};
  const feedback = feedbackFor(baseline.source);
  const comments = feedbackContextComments(feedback, subject);
  const raw = {...JSON.parse(baseline.cases[0]!.raw), schema: 'rig-review/act@7',
    value: {stage: ask.stage, verdict: 'changes-requested', comments}};
  const act = parseContextCommentsAct(raw);
  expect(JSON.stringify(act)).toBe(JSON.stringify(raw));
  expect(act.value.comments.map(comment => comment.context?.subject)).toEqual([subject, subject]);
});

test('#746 live comments preserve ordered pins, view context, and exact replay and export', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const feedback = feedbackFor(publication.source as unknown as typeof baseline.source);
  const [point, timed] = (feedback as unknown as typeof marked.feedback).map(row => parseStageComment(row.context.comment));
  if (!point?.frame || !timed) throw new Error('Missing fixture evidence');
  const pins = feedbackItemComments(feedback);
  const comments = feedbackContextComments(feedback);
  const general = ['  원문 그대로 🚀  ', 'Another line\nwith a break'];
  const input = {...page, expectedGeneration: f.session.status().generation, submissionId: 'structured-746', kind: 'comments',
    value: {comments: [...comments, ...general.map(text => ({text}))]}};
  const commit = (raw: object) => f.ports.commitUIAct(f.session.jobId, f.uiRequest(raw));
  const saved = await commit(input);
  if (!saved.ok) throw new Error(saved.error.code);
  const act = parseCommentOnlyAct(saved.value);
  expect(act.value.comments).toEqual([
    {...pins[0]!, context: {mode: 'animate', tab: 'playback', region: point.world, camera: point.camera, frame: point.frame}},
    {...pins[1]!, context: {mode: 'animate', tab: 'playback', region: timed.world, camera: timed.camera}},
    ...general.map(text => ({text})),
  ]);
  const signed = act.value.comments.map(({context: _context, ...comment}) => comment);
  expect(projectComments(signed)).toBe(projectComments(pins) + '\n\n[general]\n' + general.join('\n\n[general]\n'));
  expect(act.value.comments[1]!.anchor).toMatchObject({frameStart: null, frameEnd: null,
    context: {frame: null, interval: null, comment: {frame: null, timeBasis: {basis: 'seconds'}}}});
  expect(f.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
  expect(await commit(input)).toEqual(saved);
  expect(await commit({...input, value: {comments: [...input.value.comments].reverse()}}))
    .toMatchObject({ok: false, error: {code: 'JOB_IDEMPOTENCY_CONFLICT'}});
});

test('#746 invalid comment values, source evidence and projection overflow refuse without writing', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const feedback = feedbackFor(publication.source as unknown as typeof baseline.source);
  const [point, timed] = feedbackContextComments(feedback);
  if (!point?.anchor || !timed?.anchor) throw new Error('Missing fixture pins');
  const pin = {text: '  exact  ', anchor: {id: 'ordinary', frameStart: 3, frameEnd: 5,
    target: {kind: 'slot', name: 'sleeve'}, category: 'quality'}} satisfies JobContextComment;
  const evidenceMutants = ['sourceHash', 'modelHash', 'crop'].map(field => {
    const row = structuredClone(point);
    const context = (row.anchor as {context: unknown}).context as typeof marked.feedback[number]['context'];
    if (field === 'crop') context.comment.crop.png = 'data:image/png;base64,AAAA';
    else if (field === 'sourceHash') context.comment.sourceHash = '0'.repeat(64);
    else context.comment.modelHash = '0'.repeat(64);
    return [row];
  });
  const invalid: unknown[] = [null, {}, 'feedback', [], [null], [{}], [{...pin, text: ''}],
    [{...pin, text: ' '}], [{...pin, text: 'two\nlines'}], [{...pin, text: 'x'.repeat(1001)}],
    [{...pin, anchor: {...pin.anchor, id: ''}}], [pin, pin],
    [{...pin, anchor: {...pin.anchor, frameStart: -1}}], [{...pin, anchor: {...pin.anchor, frameEnd: 2}}],
    [{...pin, anchor: {...pin.anchor, category: 'unknown'}}], [{...pin, anchor: {...pin.anchor, extra: 1}}],
    Array.from({length: 1001}, () => ({text: 'x'})), [{text: 'x'.repeat(10_000 - '[general]\n'.length + 1)}],
    [{...timed, anchor: {...timed.anchor, frameStart: 0}}], ...evidenceMutants];
  const before = f.session.status();
  const input = {...page, expectedGeneration: before.generation, kind: 'comments'};
  for (const [index, comments] of invalid.entries()) {
    const result = await f.ports.commitUIAct(f.session.jobId,
      f.uiRequest({...input, submissionId: 'bad-' + index, value: {comments}}));
    expect(result, 'invalid comment case ' + index).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
    expect(f.session.status()).toEqual(before);
  }
  const saved = await f.ports.commitUIAct(f.session.jobId,
    f.uiRequest({...input, submissionId: 'valid-after-refusals', value: {comments: [pin]}}));
  if (!saved.ok) throw new Error(saved.error.code);
  expect(parseCommentOnlyAct(saved.value).value.comments).toEqual([pin]);
});

test('#746 the legacy UI type still admits rig feedback only for rig-review', () => {
  // @ts-expect-error Feedback is admitted only on rig-review UI values.
  const direction: JobUIActValues['review-verdict'] = {stage: 'direction-review', verdict: 'approved', words: '', feedback: []};
  expect(direction.stage).toBe('direction-review');
});

test('#1104 image-review belongs to the historical act@2 value only', () => {
  type AdmitsImage<Stage> = 'image-review' extends Stage ? true : false;
  type LegacyStage = Extract<JobLegacyAct, {kind: 'review-verdict'}>['value']['stage'];
  const admitsImage: {
    stage: AdmitsImage<JobReviewStage>;
    act: AdmitsImage<JobActValues['review-verdict']['stage']>;
    ui: AdmitsImage<JobUIActValues['review-verdict']['stage']>;
    comments: AdmitsImage<JobCommentsActValues['review-verdict']['stage']>;
    legacy: AdmitsImage<LegacyStage>;
  } = {stage: false, act: false, ui: false, comments: false, legacy: true};
  expect(admitsImage.legacy).toBe(true);
});

test('#1011 a bound draft publication keeps its identity and round-trips a rig comment', async () => {
  const f = await fixture();
  await joinedVerdictFixture(f.root, '2-rigging-answers');
  await syntheticJobParts(f);
  f.setRecordPath('project.json');
  const selector = {kind: 'draft', id: 'chain'} as const;
  const subject = {kind: 'review-verdict', stage: 'rig-review'} as const;
  f.setContext({...f.getContext(), selector, subjects: [subject]});
  const publication = await f.publish(), page = await f.display(publication);
  const retained = f.session.retainedSource(publication.publicationId);
  expect(bindJobAsk(subject, retained)).toEqual(publication.source);
  expect(f.session.displayPublication(publication.publicationId).rigDraftVerdict).toBe(true);
  const comments = feedbackContextComments(feedbackFor(publication.source as unknown as typeof baseline.source).slice(0, 1));
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page,
    expectedGeneration: f.session.status().generation, submissionId: 'draft-comment', kind: 'comments', value: {comments}}));
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
  const act = parseCommentOnlyAct(saved.value);
  expect(act.source).toEqual(publication.source);
  if ('record' in act.source || !act.source.projectHash || !act.source.model) throw new Error('Expected a bound draft rig');
  expect(act.source.selector).toEqual(selector);
  expect(act.source.projectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(act.source.model.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(act.value.comments).toEqual(comments);
  expect(act.value.comments[0]?.context).not.toHaveProperty('subject');
  expect(f.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
});

test('#1011 refuses unsupported stages and invalid rig draft bindings', () => {
  const source = {...baseline.source, direction: null, projectHash: 'a'.repeat(64),
    selector: {kind: 'draft', id: 'chain'}} as unknown as JobRetainedSource['source'];
  const subject = {kind: 'review-verdict', stage: 'rig-review'} as const;
  const retained = {source, subjects: [subject]} as unknown as JobRetainedSource;
  for (const stage of ['direction-review', 'image-review'] as const) {
    // A raw caller can still present a historical stage at runtime.
    const ask = {...subject, stage} as Extract<JobSubject, {kind: 'review-verdict'}>;
    expect(() => bindJobAsk(ask, {...retained, subjects: [ask]})).toThrow(expect.objectContaining({
      code: 'JOB_ASK_INVALID', message: stage,
    }));
  }
  for (const patch of [{selector: {kind: 'draft' as const, id: '../chain'}},
    {selector: {...source.selector, kind: 'draft' as const, id: 'chain', version: 1}},
    {model: null}, {projectHash: null}, {direction: source.model}]) {
    expect(() => bindJobAsk(subject, {...retained, source: {...source, ...patch}}))
      .toThrow(expect.objectContaining({code: 'JOB_ASK_INVALID'}));
  }
  expect(() => bindJobAsk(subject, {...retained, subjects: []}))
    .toThrow(expect.objectContaining({code: 'JOB_ASK_INVALID'}));
});
