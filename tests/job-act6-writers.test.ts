import {seedHistoricalVerdictAsk} from './helpers/historical-verdict-ask.ts';
import {afterEach, expect, test} from 'bun:test';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {jobRigScreenDecisions} from '../web/job-rig-screen.ts';
import {feedbackItemComments, timeOnlyBasis, type StageComment} from '../src/stage-comment.ts';
import {bindJobAsk, finalizeJobAct, parseUISubmission} from '../src/job-act.ts';
import {jobHash} from '../src/job-api.ts';
import {parseCommentsAct, projectComments} from '../src/job-host.ts';
import {checkpointNoteComments, noteComments, partsIssueComments} from '../src/feedback-export.ts';
import {jobRawActMediaType, type JobComment, type JobPendingAsk, type JobUISubmission} from '../src/job-contract.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import type {Feedback} from '../src/session.ts';
import type {Json} from '../src/manifest.ts';
import {readProject} from '../src/interview-project.ts';
import {jobFixture, jobInputHashes, syntheticJobParts} from './helpers/job-api-fixture.ts';
import {seedHistoricalCheckpointAct} from './helpers/historical-checkpoint-act.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {seedHistoricalPicksAct} from './helpers/historical-picks-act.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import vendored from './fixtures/act6-projection-create-c8382ba5.json';
useTemporaryReviewState();

// #713: fresh checkpoint, signoff, parts-verdict and rig/post review-verdict acts are act@6.
// Interview-picks joined act@6 under #646; #1230 refuses fresh picks and keeps historical act@6 readers. Image-review stays act@2.

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

async function postFixture() {
  const f = await fixture(), out = join(f.root, 'out');
  const modelPath = join(out, 'skeleton.model.json'), compiled = JSON.parse(await readFile(modelPath, 'utf8'));
  compiled.animations.find((animation: {name: string}) => animation.name === 'inspect').name = 'idle';
  compiled.editorOrder.animations = compiled.editorOrder.animations.map((name: string) => name === 'inspect' ? 'idle' : name);
  const modelBytes = JSON.stringify(compiled);
  await writeFile(modelPath, modelBytes);
  const model = {path: 'skeleton.model.json', sha256: jobHash(modelBytes)};
  const direction = {schema: 'rig-create/direction@3', rig: {version: 1, acceptance: {signoff: {}, verdict: {}, review_package: {}}},
    compose: {out: 'outputs/v1/compose'}, model, take: {duration: 1, loop: true},
    citations: {camera: 'quoted', timing: 'quoted', composition: 'quoted'}};
  const directionBytes = JSON.stringify(direction);
  await writeFile(join(out, 'direction.json'), directionBytes);
  const {authoring: _clock, ...manifest} = JSON.parse(await readFile(join(out, 'review.json'), 'utf8'));
  await writeFile(join(out, 'review.json'), JSON.stringify({...manifest, direction: 'direction.json', animations: [{id: 'idle', label: 'Idle'}]}));
  f.setContext({...f.getContext(), selector: {kind: 'post', version: 3, rigVersion: 1}});
  const publication = await f.publish();
  expect(publication.source.direction).toEqual({path: 'out/direction.json', sha256: jobHash(directionBytes)});
  expect(publication.source.model?.sha256).toBe(model.sha256);
  return {f, publication, modelHash: model.sha256, directionBytes};
}

function smallCrop(offset: number) {
  const png = new PNG({width: 2, height: 2});
  png.data.fill(offset + 100);
  const bytes = PNG.sync.write(png), sha256 = jobHash(bytes);
  return {path: `comment-crops/${sha256}.png`, sha256, png: `data:image/png;base64,${bytes.toString('base64')}`, width: 2, height: 2};
}

function timedPin(sourceHash: string, modelHash: string, time: number, offset: number, summary: string) {
  const camera = {space: 'world', zoom: 2, center: {x: 25, y: 25}, viewport: {width: 100, height: 100},
    visible: {x: 0, y: 0, width: 50, height: 50}} as const;
  const turn = {schema: 'rig-review-turn/1', values: {yaw: offset / 4}, held: true, smoothing: 20};
  const mark = {schema: 'rig-review-comment/1', mode: 'animate', viewport: 'rig', frame: null, timeBasis: timeOnlyBasis,
    time, animation: 'idle', sourceHash, modelHash, referenceHash: null, referenceId: null, camera,
    screen: {x: offset * 2, y: 60 - offset * 2, width: 2, height: 2},
    world: {x: offset, y: 19 + offset, width: 1, height: 1}, slots: [],
    crop: smallCrop(offset),
    bookmark: {schema: 'rig-review-inspection/1', binding: {mode: 'single', sourceHash, rigs: [modelHash]},
      time, animation: 'idle', theme: 'light', layers: {images: true, meshes: false, bones: false},
      view: {schema: 'rig-review-view/1', cameras: {rig: camera, a: null, b: null, reference: null}},
      selection: {inspector: 'playback', turn}}} satisfies StageComment;
  const feedback: Feedback = {id: `direction-pin-${offset}`, frameStart: null, frameEnd: null,
    target: {kind: 'rig', name: 'viewport-387-public'}, category: 'defect', summary,
    context: {time, frame: null, animation: 'idle', interval: null, turn, comment: mark} as Json};
  const {summary: text, ...anchor} = feedback;
  return {text, anchor, mark};
}

async function rawAct(f: Awaited<ReturnType<typeof fixture>>, actId: string) {
  const response = await f.ports.handleJobApi(new Request(`${f.origin}/jobs/${f.session.jobId}/api`, {
    method: 'POST', headers: {'Content-Type': 'application/json', accept: jobRawActMediaType,
      Authorization: `Bearer ${f.session.writerGrant().fetchCapability}`},
    body: JSON.stringify({...f.base(), verb: 'fetch-act', actId}),
  }));
  const payload = await response.text();
  expect(response.status, response.ok ? undefined : payload).toBe(200);
  return payload;
}

// #1229: fresh checkpoint and signoff asks/acts refuse while historical act@6 checkpoint and signoff acts decode and round-trip.
test('fresh checkpoint and signoff asks/acts refuse while historical act@6 checkpoint and signoff acts decode', async () => {
  const f = await fixture(), publication = await f.publish();
  const refusedCheckpointAsk = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'act6-checkpoint-ask', publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step-one'}})).json();
  expect(refusedCheckpointAsk).toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});
  const refusedSignoffAsk = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'act6-signoff-ask', publicationId: publication.publicationId, subject: {kind: 'signoff', stage: 'plan-approved'}})).json();
  expect(refusedSignoffAsk).toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});
  const page = await f.display(publication);
  const checkpoint = seedHistoricalCheckpointAct(f.session, {...page,
    expectedGeneration: f.session.status().generation, submissionId: 'act6-checkpoint', checkpointId: 'step-one',
    value: {checkpointId: 'step-one', outcome: 'fail', words: '  Exact 한글\n'}});
  expect(checkpoint).toMatchObject({schema: 'rig-review/act@6', kind: 'checkpoint', value: {
    checkpointId: 'step-one', planStepId: 'step-one', outcome: 'fail',
    comments: [{text: '  Exact 한글\n', anchor: {checkpointId: 'step-one', planStepId: 'step-one'}}]}});
  roundTrip(f, checkpoint);
  const freshCheckpoint = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: checkpoint.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'act6-fresh-checkpoint', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'fail', words: '  Exact 한글\n'}}));
  expect(freshCheckpoint).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
  const signoff = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: checkpoint.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'act6-signoff', kind: 'signoff',
    value: {stage: 'plan-approved', decision: 'approved', words: ' \n원문 그대로\t '}}));
  expect(signoff).toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
  const historicalSignoff = parseCommentsAct({...checkpoint, actId: 'historical-act6-signoff', kind: 'signoff',
    value: {stage: 'plan-approved', decision: 'approved', comments: [{text: ' \n원문 그대로\t '}]}});
  expect(JSON.stringify(parseCommentsAct(JSON.parse(JSON.stringify(historicalSignoff))))).toBe(JSON.stringify(historicalSignoff));
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

test('legacy direct direction decisions still project words to one anchorless act@6 row', async () => {
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
  expect(() => finalizeJobAct({jobId: f.session.jobId, submission: {...submission,
    value: {...submission.value, feedback: []}} as JobUISubmission, ask, retained, reviewer})).toThrow('JOB_REQUEST_INVALID');
  const withGeneral = parseUISubmission({...submission, value: {...submission.value, general: ['Rig/Parts only']}});
  expect(() => finalizeJobAct({jobId: f.session.jobId, submission: withGeneral, ask, retained, reviewer}))
    .toThrow('JOB_REQUEST_INVALID');
  const rows = [{id:'first',frameStart:0,frameEnd:1,target:{kind:'rig' as const,name:'fixture'},category:'defect' as const,summary:'first comment'},
    {id:'second',frameStart:null,frameEnd:null,target:{kind:'rig' as const,name:'fixture'},category:'defect' as const,summary:'second comment'}];
  const decision = jobRigScreenDecisions({status:'changes-requested',checkpoints:{},feedback:rows}, [ask], publication.publicationId)[0]!;
  const projected = projectComments(feedbackItemComments(rows));
  const shared = finalizeJobAct({jobId:f.session.jobId,submission:{...submission,value:decision.value} as JobUISubmission,ask,retained,reviewer});
  expect(parseCommentsAct(shared)).toMatchObject({schema:'rig-review/act@6',value:{stage:'direction-review',comments:[{text:projected}]}});
  expect(shared).not.toHaveProperty('still');
  expect(decision.value).not.toHaveProperty('feedback');
});

test('#1136 direction@3 writes three exact time-only pins and an interleaved general row through the retained host', async () => {
  const {f, publication, modelHash, directionBytes} = await postFixture();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'direction-review'}), page = await f.display(publication);
  const originalInputs = await jobInputHashes(f.root);
  const pins = [timedPin(publication.source.sourceHash, modelHash, 0.125, 4, 'First held location'),
    timedPin(publication.source.sourceHash, modelHash, 0.5000000000000001, 12, '중간 위치'),
    timedPin(publication.source.sourceHash, modelHash, 0.875, 20, 'Third held location')];
  const [first, second, third] = pins.map(({text, anchor}) => ({text, anchor}));
  const comments: JobComment[] = [first!, {text: '  Direction 전체\r\n'}, second!, third!];
  const value = {stage: 'direction-review', verdict: 'changes-requested', comments};
  const input = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'direction-structured', kind: 'review-verdict', value};
  const commit = (body: object) => f.ports.commitUIAct(f.session.jobId, f.uiRequest(body));
  const withChangedMark = (change: Partial<StageComment>) => comments.map((row, index) => index !== 2 ? row : {
    text: pins[1]!.text, anchor: {...pins[1]!.anchor, context: {...pins[1]!.anchor.context as object,
      comment: {...pins[1]!.mark, ...change}}},
  });
  const pendingBeforeDrift = f.session.status();
  const directionPath = join(f.root, 'out/direction.json');
  await writeFile(directionPath, directionBytes + '\n');
  try {
    expect(await commit({...input, value: {...value, comments: []}})).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  } finally {await writeFile(directionPath, directionBytes);}
  expect(f.session.status()).toEqual(pendingBeforeDrift);
  const saved = await commit(input);
  if (!saved.ok) throw new Error(saved.error.code);
  const parsed = parseCommentsAct(saved.value);
  expect(parsed).toMatchObject({schema: 'rig-review/act@6', kind: 'review-verdict', source: ask.source});
  expect(parsed.value).toEqual(value);
  expect(parsed).not.toHaveProperty('still');
  for (const [index, pin] of pins.entries()) {
    const row = parsed.value.comments[index === 0 ? 0 : index + 1]!;
    expect(row.anchor).toEqual(pin.anchor);
    expect(new Set(Object.keys(row))).toEqual(new Set(['text', 'anchor']));
  }
  const label = '[["rig-review-comment/1","animate","rig","rig","viewport-387-public",null,null]]\n';
  expect(projectComments(parsed.value.comments)).toBe(label + 'First held location\n\n[general]\n  Direction 전체\r\n\n\n' +
    label + '중간 위치\n\n' + label + 'Third held location');
  roundTrip(f, saved.value);
  const bytes = await rawAct(f, parsed.actId);
  expect(bytes).toBe(JSON.stringify(saved.value));
  for (const {mark} of pins) {
    const crop = f.session.readCommentCrop(mark.crop.sha256);
    expect(jobHash(crop)).toBe(mark.crop.sha256);
    expect('data:image/png;base64,' + crop.toString('base64')).toBe(mark.crop.png);
  }
  const generation = f.session.status().generation;
  expect(await commit(input)).toEqual(saved);
  expect(await rawAct(f, parsed.actId)).toBe(bytes);
  expect(await commit({...input, value: {...value, comments: [...comments].reverse()}}))
    .toMatchObject({ok: false, error: {code: 'JOB_IDEMPOTENCY_CONFLICT'}});
  expect(f.session.status().generation).toBe(generation);

  const negativeAsk = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'direction-review'});
  const pending = f.session.status();
  const negative = {...input, askId: negativeAsk.askId, expectedGeneration: pending.generation};
  for (const [label, change, code] of [
    ['source hash', {comments: withChangedMark({sourceHash: '0'.repeat(64)})}, 'JOB_ACT_INVALID'],
    ['model hash', {comments: withChangedMark({modelHash: '0'.repeat(64)})}, 'JOB_ACT_INVALID'],
    ['crop bytes', {comments: withChangedMark({crop: {...pins[1]!.mark.crop, png: pins[0]!.mark.crop.png}})}, 'JOB_ACT_INVALID'],
    ['words mixed with comments', {words: ''}, 'JOB_ACT_INVALID'],
    ['invented frame', {comments: [{text: pins[0]!.text, anchor: {...pins[0]!.anchor, frameStart: 0}}]}, 'JOB_ACT_INVALID'],
    ['duplicate pin', {comments: [comments[0], comments[0]]}, 'JOB_ACT_INVALID'],
  ] as const) {
    expect(await commit({...negative, submissionId: 'invalid-' + label.replaceAll(' ', '-'), value: {...value, ...change}}), label)
      .toMatchObject({ok: false, error: {code}});
    expect(f.session.status(), label).toEqual(pending);
  }
  expect(await jobInputHashes(f.root)).toEqual(originalInputs);
});

test('#1136 direction verdict preserves producer and reference frame pins', async () => {
  const {f, publication, modelHash} = await postFixture();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'direction-review'}), page = await f.display(publication);
  const comments = (['producer', 'reference'] as const).map((basis, offset) => {
    const index = 4 + offset;
    const {text, anchor, mark: {timeBasis: _timeBasis, ...mark}} =
      timedPin(publication.source.sourceHash, modelHash, 0.25 + offset * 0.25, index, basis + ' pin');
    const comment = {...mark, frame: {index, basis}, ...(basis === 'reference' ? {
      viewport: 'reference' as const, modelHash: null, referenceId: 'reference', referenceHash: 'a'.repeat(64),
    } : {})} satisfies StageComment;
    return {text, anchor: {...anchor, frameStart: index, frameEnd: index, context: {
      ...anchor.context as object, frame: basis === 'producer' ? index : null,
      interval: {frameStart: index, frameEnd: index, inclusive: true}, comment,
    } as Json}};
  });
  const value = {stage: 'direction-review', verdict: 'approved', comments};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'direction-framed', kind: 'review-verdict', value}));
  if (!saved.ok) throw new Error(saved.error.code);
  const parsed = parseCommentsAct(saved.value);
  expect(parsed).toMatchObject({schema: 'rig-review/act@6', kind: 'review-verdict'});
  expect(parsed.value).toEqual(value);
});

test('#1136 words-only direction retains its anchorless export and replay bytes', async () => {
  const {f, publication} = await postFixture();
  const stage = 'direction-review', verdict = 'changes-requested', words = '  Legacy 연출\r\nKeep edges  \n';
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage}), page = await f.display(publication);
  const input = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'old-direction', kind: 'review-verdict', value: {stage, verdict, words}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) throw new Error(saved.error.code);
  const {value: _value, ...envelope} = saved.value;
  const expected = JSON.stringify({...envelope, value: {stage, verdict, comments: [{text: words}]}});
  expect(await rawAct(f, saved.value.actId)).toBe(expected);
  expect(JSON.stringify(parseCommentsAct(JSON.parse(expected)))).toBe(expected);
  expect(projectComments(parseCommentsAct(saved.value).value.comments)).toBe('[general]\n  Legacy 연출\r\nKeep edges  \n');
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  expect(await rawAct(f, saved.value.actId)).toBe(expected);
});

test('#1230 the interview-picks writer refuses JOB_ACT_KIND_DISABLED and a historical act@6 with its note decodes byte-identically', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const ask: JobPendingAsk = {askId: 'ask-one', publicationId: publication.publicationId,
    subject: {kind: 'interview-picks', questionId: 'question-one', setId: 'set-one'},
    source: {...retained.source, optionSet: {id: 'set-one', sha256: '2'.repeat(64)}}, status: 'pending'};
  const submission: JobUISubmission = {publicationId: publication.publicationId, askId: ask.askId, pageId: 'page',
    displayedNonce: 'nonce', expectedGeneration: 1, submissionId: 'submission', kind: 'interview-picks', value: {
      questionId: 'question-one', selections: [{itemId: 'item-one', optionId: 'value-one', otherText: null}], note: '  원문 '}};
  expect(() => finalizeJobAct({jobId: f.session.jobId, submission, ask, retained, reviewer})).toThrow('JOB_ACT_KIND_DISABLED');
  const historical = {schema: 'rig-review/act@6', actId: 'historical-picks', jobId: f.session.jobId, askId: ask.askId,
    publicationId: publication.publicationId, authority: {actor: 'human', channel: 'review-ui', reviewer}, at: '2026-11-01T00:00:00.000Z',
    kind: 'interview-picks', source: ask.source, value: {...submission.value, comments: []}};
  const bytes = JSON.stringify(historical);
  expect(JSON.stringify(parseCommentsAct(JSON.parse(bytes)))).toBe(bytes);
});

test('#1136 / #1230 a historical picks act keeps Feedback, PartsIssue and anchorless projection, export and replay bytes while a fresh submission refuses', async () => {
  const f = await fixture();
  await joinedVerdictFixture(f.root, '2-rigging-answers');
  f.setRecordPath('project.json');
  const question = readProject(f.root).questions.find(item => item.editable)!;
  const publication = await f.publish();
  const subject = {kind: 'interview-picks', questionId: question.set.question, setId: question.set.id};
  const asked = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'refused-picks', publicationId: publication.publicationId, subject})).json();
  expect(asked).toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});
  const page = await f.display(publication);
  const [vendoredIssue, vendoredNote] = vendored.cases.partsIssuesAndNote.comments;
  const camera = {zoom: 1, center: {x: 0, y: 0}, viewport: {width: 100, height: 100}};
  const issue = {text: vendoredIssue!.text, anchor: {...vendoredIssue!.anchor, sourceHash: publication.source.sourceHash,
    rigRegion: {x: 1, y: 2, width: 2, height: 2}, imageRegion: null, crop: smallCrop(4), nativeCrop: null,
    view: {mode: 'assembled', camera, referenceCamera: null, cameraSync: false, background: 'checker',
      alpha: false, footprints: false, mesh: false}}} as JobComment;
  const feedback = {text: '  Sleeve 그대로 ', anchor: {id: 'sleeve-mark', frameStart: 3, frameEnd: 5,
    target: {kind: 'slot', name: 'sleeve'}, category: 'defect'}} satisfies JobComment;
  const comments = [feedback, issue, vendoredNote!];
  const selections = question.set.asks.map(item => ({itemId: item.id,
    optionId: item.options.find(option => option.kind === 'value' && option.recommended)!.id, otherText: null}));
  const value = {questionId: question.set.question, selections, note: '  Picks 연출\r\n', comments};
  // Committed by Review 4.21.0 or earlier, before fresh picks asks refused.
  const stored = seedHistoricalPicksAct(f.session, {...page, expectedGeneration: f.session.status().generation,
    submissionId: 'old-picks', value, questionId: question.set.question, setId: question.set.id, optionSetSha256: question.ref.sha256});
  const input = {...page, askId: stored.askId, expectedGeneration: f.session.status().generation - 1,
    submissionId: 'old-picks', kind: 'interview-picks', value};
  const {value: _value, ...envelope} = stored;
  const expected = JSON.stringify({...envelope, value});
  const bytes = await rawAct(f, stored.actId);
  expect(bytes).toBe(expected);
  expect(f.session.readActExport(stored.actId, false).toString()).toBe(expected);
  const parsed = parseCommentsAct(JSON.parse(bytes));
  expect(parsed.source.optionSet).toEqual({id: question.set.id, sha256: question.ref.sha256});
  expect(projectComments(parsed.value.comments)).toBe('[["slot","sleeve",3,5,null]]\n  Sleeve 그대로 \n\n' +
    vendored.cases.partsIssuesAndNote.projected);
  // The replay lookup runs before the refusal: the stored act returns unchanged; a new submission refuses by name.
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual({ok: true, value: stored});
  expect(await rawAct(f, stored.actId)).toBe(bytes);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, submissionId: 'new-picks'})))
    .toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
});

test('an empty or whitespace-only note has no comment form: zero comments, nothing padded', () => {
  for (const words of ['', ' ', ' \n\t ']) expect(noteComments(words)).toEqual([]);
  expect(noteComments(' x ')).toEqual([{text: ' x '}]);
});

test('a note whose act@6 projection exceeds 10,000 UTF-16 units is refused by name (JOB_ACT_INVALID)', async () => {
  // #1229: checkpoint retired; exercise the 10,000-unit act@6 scalar bound on a live direction-review verdict.
  const {f, publication} = await postFixture();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'direction-review'}), page = await f.display(publication);
  const generation = f.session.status().generation;
  const label = '[general]\n';
  const words = 'x'.repeat(10000 - label.length + 1);
  const refused = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: generation, submissionId: 'too-long', kind: 'review-verdict',
    value: {stage: 'direction-review', verdict: 'changes-requested', words}}));
  expect(refused).toEqual({ok: false, error: {code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID'}});
  expect(f.session.status().generation).toBe(generation);
  const fits = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: generation, submissionId: 'fits', kind: 'review-verdict',
    value: {stage: 'direction-review', verdict: 'changes-requested', words: words.slice(1)}}));
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

const generalNote = vendored.cases.partsIssuesAndNote.comments[1]!.text;
const generalHeader = '[general]\n';
const projectionLimit = 10_000;
const boundaryUnits = projectionLimit - 2 * generalHeader.length - 2 - generalNote.length;
const boundaryTail = '🚀'.repeat(Math.floor(boundaryUnits / 2)) + 'x'.repeat(boundaryUnits % 2);

test.each([
  {name: 'multiple notes', general: [generalNote, 'Second Parts comment']},
  {name: 'exact projection limit', general: [generalNote, boundaryTail]},
])('#831 Parts Approve accepts anchorless comments ($name)', async ({name, general}) => {
  const f = await fixture();
  await syntheticJobParts(f, {project: true});
  const publication = await f.publish();
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'parts-verdict', draftId: 'synthetic-draft'}), page = await f.display(publication);
  const generation = f.session.status().generation;
  const input = {...page, askId: ask.askId, expectedGeneration: generation, kind: 'parts-verdict'};
  const approve = {verdict: 'approved', issues: [], words: ''};

  if (name === 'exact projection limit') {
    const invalid = [
      {label: 'aggregate projection overflow', value: {...approve, general: [generalNote, boundaryTail + 'x']}},
      {label: 'text omitted by a trim-and-filter implementation', value: {...approve, general: [' \t\n ']}},
      {label: 'entry type', value: {...approve, general: ['valid', {text: 'object'}]}},
      {label: 'list type', value: {...approve, general: 'not an array'}},
      {label: 'count', value: {...approve, general: Array.from({length: 1001}, () => 'x')}},
      {label: 'missing pinned issue', value: {...approve, verdict: 'changes-requested', general: [generalNote]}},
    ];
    for (const [index, {label, value}] of invalid.entries()) {
      const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, submissionId: 'invalid-' + index, value}));
      expect(rejected, label).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
      const status = f.session.status();
      expect(status.generation, label).toBe(generation);
      expect(status.pending.map(pending => pending.askId), label).toContain(ask.askId);
    }
  }

  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input,
    submissionId: 'general-parts-831', value: {...approve, general}}));
  if (!saved.ok) throw new Error(saved.error.code);
  roundTrip(f, saved.value);
  const act = parseCommentsAct(saved.value);
  expect(act.kind).toBe('parts-verdict');
  expect(act.value).toEqual({verdict: 'approved', comments: general.map(text => ({text}))});
  const projected = projectComments(act.value.comments);
  expect(projected).toBe(generalHeader + general.join('\n\n' + generalHeader));
  if (name === 'exact projection limit') expect(projected).toHaveLength(projectionLimit);
});
