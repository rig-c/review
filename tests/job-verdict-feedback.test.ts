import {seedHistoricalVerdictAsk} from './helpers/historical-verdict-ask.ts';
import {afterEach, expect, setSystemTime, spyOn, test} from 'bun:test';
import * as crypto from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {bindJobAsk, finalizeJobAct} from '../src/job-act.ts';
import {jobHash, parseCommentsAct, parseContextCommentsAct} from '../src/job-api.ts';
import {jobCommand} from '../src/job-cli.ts';
import {feedbackItemComments, parseStageComment, projectComments} from '../src/stage-comment.ts';
import type {JobPendingAsk, JobUIActValues, JobUISubmission, PendingAskV3} from '../src/job-contract.ts';
import type {JobRetainedSource} from '../src/job-source.ts';
import type {Feedback} from '../src/session.ts';
import {jobRigScreenDecisions} from '../web/job-rig-screen.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
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

test('#746 absent feedback keeps all four pre-edit deterministic envelope bytes, including identity, time and still', () => {
  const source = baseline.source as unknown as JobRetainedSource['source'];
  const ask: JobPendingAsk = {askId: 'verdict-746', publicationId: 'publication-746',
    subject: {kind: 'review-verdict', stage: 'rig-review'}, source, status: 'pending'};
  const retained = {source, subjects: []} as unknown as JobRetainedSource;
  expect(JSON.stringify(bindJobAsk(ask.subject, retained))).toBe(JSON.stringify(baseline.source));
  const uuid = spyOn(crypto, 'randomUUID').mockReturnValue(baseline.actId as `${string}-${string}-${string}-${string}-${string}`);
  setSystemTime(new Date(baseline.at));
  try {
    for (const item of baseline.cases) {
      expect(jobHash(item.raw)).toBe(item.sha256);
      const submission = {publicationId: ask.publicationId, askId: ask.askId, pageId: 'page-746', displayedNonce: 'nonce-746',
        expectedGeneration: 1, submissionId: item.name, kind: 'review-verdict', value: item.value} as JobUISubmission;
      const act = finalizeJobAct({jobId: 'job-746', submission, ask, retained, reviewer: {id: 'owner', role: 'owner'},
        still: baseline.still as Parameters<typeof finalizeJobAct>[0]['still']});
      expect(JSON.stringify(act)).toBe(item.raw);
      expect(JSON.stringify(parseCommentsAct(JSON.parse(item.raw)))).toBe(item.raw);
    }
  } finally {uuid.mockRestore(); setSystemTime();}
});

test('#746 decision → daemon → stored export preserves ordered pointed and time-only comments, including act@7 context', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'rig-review'}), page = await f.display(publication);
  const rows = feedbackFor(publication.source as unknown as typeof baseline.source), snapshot = structuredClone(rows);
  const [decision] = jobRigScreenDecisions({status: 'changes-requested', checkpoints: {}, feedback: rows},
    [ask] as unknown as PendingAskV3[], publication.publicationId);
  expect(decision?.kind).toBe('review-verdict');
  if (decision?.kind !== 'review-verdict') throw new Error('missing verdict');
  expect(decision.value.feedback).toEqual(snapshot);
  rows[0]!.summary = 'edited after decision';
  expect(decision.value.feedback).toEqual(snapshot);
  const input = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'structured-746', kind: 'review-verdict', value: decision.value,
    capture: rigStillCapture(publication, ask, page).capture};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.schema).toBe('rig-review/act@7');
  const act = parseContextCommentsAct(saved.value), comments = feedbackItemComments(snapshot);
  const selector = publication.source.selector;
  const [point, timed] = (snapshot as unknown as typeof marked.feedback).map(row => parseStageComment(row.context.comment));
  if (!selector || !point?.frame || !timed) throw new Error('missing fixture evidence');
  const subject = {ask: ask.subject, sourceHash: publication.source.sourceHash, selector};
  expect(act.value.comments).toEqual([
    {...comments[0]!, context: {subject, mode: 'animate', tab: 'playback', region: point.world,
      camera: point.camera, frame: point.frame}},
    {...comments[1]!, context: {subject, mode: 'animate', tab: 'playback', region: timed.world, camera: timed.camera}},
  ]);
  expect(projectComments(act.value.comments.map(({context: _context, ...comment}) => comment))).toBe(decision.value.words);
  const bytes = f.session.readActExport(act.actId, false);
  expect(bytes.toString()).toBe(JSON.stringify(act));
  if (!act.still) throw new Error('missing rig still');
  const directory = join(f.scratch, 'consumer-still');
  await mkdir(directory);
  const chunks: Buffer[] = [];
  await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', act.actId, '--still-out', directory], {
    consumerCapability: f.session.writerGrant().fetchCapability,
    fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
    writeBytes(chunk) {chunks.push(Buffer.from(chunk)); return chunk.length;},
  });
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  expect(jobHash(await readFile(join(directory, act.still.path)))).toBe(act.still.sha256);
  expect(act.value.comments[1]!.anchor).toMatchObject({frameStart: null, frameEnd: null,
    context: {frame: null, interval: null, comment: {frame: null, timeBasis: {basis: 'seconds'}}}});
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)))).toEqual(saved);
  const changed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input,
    value: {...input.value, feedback: rows}}));
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.code).toBe('JOB_IDEMPOTENCY_CONFLICT');
  expect(snapshot).toEqual(feedbackFor(publication.source as unknown as typeof baseline.source));
});

test('#746 malformed feedback and words refuse through existing decoding without answering the ask', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'rig-review'}), page = await f.display(publication);
  const [point, timed] = feedbackFor(publication.source as unknown as typeof baseline.source);
  const ordinary = {id: 'ordinary', frameStart: 3, frameEnd: 5, target: {kind: 'slot', name: 'sleeve'},
    category: 'quality', summary: '  exact  '};
  const evidenceMutants = ['sourceHash', 'modelHash', 'crop'].map(field => {
    const row = structuredClone(point!);
    const context = row.context as unknown as typeof marked.feedback[number]['context'];
    if (field === 'crop') context.comment.crop.png = 'data:image/png;base64,AAAA';
    else if (field === 'sourceHash') context.comment.sourceHash = '0'.repeat(64);
    else context.comment.modelHash = '0'.repeat(64);
    return [row];
  });
  const malformed: unknown[] = [null, {}, 'feedback', [null], [{}], [{...ordinary, summary: ''}],
    [{...ordinary, summary: ' '}], [{...ordinary, summary: 'two\nlines'}], [{...ordinary, summary: 'x'.repeat(1001)}],
    [{...ordinary, id: ''}], [ordinary, ordinary], [{...ordinary, frameStart: -1}], [{...ordinary, frameEnd: 2}],
    [{...ordinary, target: {kind: 'part', name: 'sleeve'}}], [{...ordinary, target: {...ordinary.target, unknown: true}}],
    [{...ordinary, category: 'unknown'}], [{...ordinary, unknown: true}], Array.from({length: 1001}, (_, i) => ({...ordinary, id: 'id-' + i})),
    Array.from({length: 11}, (_, i) => ({...ordinary, id: 'long-' + i, summary: 'x'.repeat(1000)})),
    [{...timed, context: undefined}], [{...timed, frameStart: 0}],
    [{...point, context: {...point!.context as object, comment: {schema: 'rig-review-comment/1'}}}], ...evidenceMutants];
  const generation = f.session.status().generation;
  const base = {...page, askId: ask.askId, expectedGeneration: generation, kind: 'review-verdict',
    capture: rigStillCapture(publication, ask, page).capture};
  for (const [i, feedback] of malformed.entries()) {
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...base, submissionId: 'bad-' + i,
      value: {stage: 'rig-review', verdict: 'changes-requested', words: 'must not mask invalid feedback', feedback}}));
    expect(result.ok, 'malformed feedback ' + i).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('JOB_ACT_INVALID');
    expect(f.session.status().generation).toBe(generation);
  }
  for (const words of [undefined, null, 1, 'x'.repeat(10001)]) {
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...base, submissionId: 'bad-words-' + typeof words,
      value: {stage: 'rig-review', verdict: 'approved', words, feedback: [ordinary]}}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('JOB_ACT_INVALID');
  }
  const accepted = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...base, submissionId: 'valid-after-refusals',
    value: {stage: 'rig-review', verdict: 'changes-requested', words: 'compatibility words', feedback: [ordinary]}}));
  if (!accepted.ok) throw new Error(accepted.error.code);
  expect(parseCommentsAct(accepted.value).value.comments).toEqual(feedbackItemComments([ordinary as Feedback]));
});

test('#746 a present empty list means zero comments, while the act bar omits feedback when there are no comments', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'rig-review'}), page = await f.display(publication);
  const [decision] = jobRigScreenDecisions({status: 'approved', checkpoints: {}, feedback: []},
    [ask] as unknown as PendingAskV3[], publication.publicationId);
  expect(decision?.value).toEqual({stage: 'rig-review', verdict: 'approved', words: ''});
  const value: JobUIActValues['review-verdict'] = {stage: 'rig-review', verdict: 'approved', words: 'not a second comment', feedback: []};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'empty-feedback', kind: 'review-verdict', value,
    capture: rigStillCapture(publication, ask, page).capture}));
  if (!saved.ok) throw new Error(saved.error.code);
  expect(parseCommentsAct(saved.value).value.comments).toEqual([]);
});

test('#831 rig appends ordered general comments after the existing #746 feedback and still validates words', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'rig-review'}), page = await f.display(publication);
  const feedback = feedbackFor(publication.source as unknown as typeof baseline.source);
  const general = ['  원문 그대로 🚀  ', 'Another line\nwith a break'] as const;
  const generation = f.session.status().generation;
  const input = {...page, askId: ask.askId, expectedGeneration: generation, kind: 'review-verdict',
    capture: rigStillCapture(publication, ask, page).capture};
  const value = {stage: 'rig-review', verdict: 'changes-requested', feedback, general};
  const pinned = feedbackItemComments(feedback);
  const projectedPinUnits = projectComments(pinned).length;
  const overflow = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, submissionId: 'mixed-overflow',
    value: {...value, words: '', general: ['x'.repeat(10_000 - projectedPinUnits - '\n\n[general]\n'.length + 1)]}}));
  expect(overflow).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
  expect(f.session.status().generation).toBe(generation);
  for (const words of [undefined, null, 1, 'x'.repeat(10001)]) {
    const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input,
      submissionId: 'invalid-words-' + typeof words, value: {...value, words}}));
    expect(rejected).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
    expect(f.session.status().generation).toBe(generation);
  }

  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, submissionId: 'mixed-rig-831',
    value: {...value, words: 'Compatibility words must not become a duplicate comment'}}));
  if (!saved.ok) throw new Error(saved.error.code);
  const bytes = f.session.readActExport(saved.value.actId, false).toString();
  const act = parseContextCommentsAct(JSON.parse(bytes));
  expect(act.kind).toBe('review-verdict');
  const signed = act.value.comments.map(({context: _context, ...comment}) => comment);
  expect({...act.value, comments: signed}).toEqual({stage: 'rig-review', verdict: 'changes-requested',
    comments: [...pinned, {text: general[0]}, {text: general[1]}]});
  expect(projectComments(signed)).toBe(projectComments(pinned) + '\n\n[general]\n' + general.join('\n\n[general]\n'));
  expect(JSON.stringify(act)).toBe(bytes);
});

test('#746 decisions never answer direction or image verdicts with rig feedback', () => {
  for (const stage of ['direction-review', 'image-review'] as const) {
    const ask = {askId: stage, publicationId: 'publication', status: 'pending', subject: {kind: 'review-verdict', stage}} as PendingAskV3;
    const decisions=jobRigScreenDecisions({status: 'approved', checkpoints: {}, feedback: feedbackFor(baseline.source)}, [ask], 'publication');
    if(stage==='image-review')expect(decisions).toEqual([]);
    else {expect(decisions).toHaveLength(1);expect(decisions[0]!.value).toMatchObject({stage,verdict:'approved'});expect(decisions[0]!.value).not.toHaveProperty('feedback');}
  }
  // @ts-expect-error Feedback is admitted only on rig-review UI values.
  const direction: JobUIActValues['review-verdict'] = {stage: 'direction-review', verdict: 'approved', words: '', feedback: []};
  // @ts-expect-error Image submissions retain their existing closed value shape.
  const image: JobUIActValues['review-verdict'] = {stage: 'image-review', verdict: 'approved', words: '', feedback: []};
  expect(direction.stage).toBe('direction-review');
  expect(image.stage).toBe('image-review');
});

test.each(['approved', 'changes-requested'] as const)('#1011 finalizes draft verdict %s', async verdict => {
  const f = await fixture();
  await joinedVerdictFixture(f.root, '2-rigging-answers');
  await syntheticJobParts(f);
  f.setRecordPath('project.json');
  const selector = {kind: 'draft', id: 'chain'} as const;
  const subject = {kind: 'review-verdict', stage: 'rig-review'} as const;
  f.setContext({...f.getContext(), selector, subjects: [subject]});
  const publication = await f.publish();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, subject), page = await f.display(publication);
  expect(ask.source).toEqual(publication.source);
  expect(f.session.displayPublication(publication.publicationId).rigDraftVerdict).toBe(true);
  const feedback = verdict === 'changes-requested'
    ? feedbackFor(publication.source as unknown as typeof baseline.source).slice(0, 1) : [];
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'draft-verdict', kind: subject.kind,
    value: {stage: subject.stage, verdict, words: '', feedback},
    capture: rigStillCapture(publication, ask, page).capture}));
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
  const act = (feedback.length ? parseContextCommentsAct : parseCommentsAct)(saved.value);
  if (act.kind !== 'review-verdict') throw new Error('Expected rig verdict');
  expect(act.source).toEqual(publication.source);
  expect(act.source.selector).toEqual(selector);
  expect(act.source.projectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(act.source.model?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(act.value.verdict).toBe(verdict);
  expect(act.still).toBeDefined();
  expect(act.value.comments).toHaveLength(feedback.length);
  if (feedback.length) {
    const comment = act.value.comments[0]!;
    expect(comment.anchor).toBeDefined();
    expect(('context' in comment ? comment.context as import('../src/job-contract.ts').JobCommentContext : undefined)?.subject)
      .toEqual({ask: subject, selector, sourceHash: publication.source.sourceHash});
  }
  expect(f.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
});

test('#1011 refuses unsupported stages and invalid rig draft bindings', () => {
  const source = {...baseline.source, direction: null, projectHash: 'a'.repeat(64),
    selector: {kind: 'draft', id: 'chain'}} as unknown as JobRetainedSource['source'];
  const subject = {kind: 'review-verdict', stage: 'rig-review'} as const;
  const retained = {source, subjects: [subject]} as unknown as JobRetainedSource;
  for (const stage of ['direction-review', 'image-review'] as const) {
    const ask = {...subject, stage};
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
