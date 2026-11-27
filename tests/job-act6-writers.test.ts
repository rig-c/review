import {afterEach, expect, test} from 'bun:test';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {timeOnlyBasis, type StageComment} from '../src/stage-comment.ts';
import {jobHash, parseCommentOnlyAct} from '../src/job-api.ts';
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
import {seedHistoricalPicksAct} from './helpers/historical-picks-act.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import historicalRig from './fixtures/job-decision-1233/rig.json';
import historicalDirection from './fixtures/job-decision-1233/direction.json';
import vendored from './fixtures/act6-projection-create-c8382ba5.json';
useTemporaryReviewState();

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
  expect(refusedCheckpointAsk).toMatchObject({ok: false, error: {code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'}});
  const refusedSignoffAsk = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'act6-signoff-ask', publicationId: publication.publicationId, subject: {kind: 'signoff', stage: 'plan-approved'}})).json();
  expect(refusedSignoffAsk).toMatchObject({ok: false, error: {code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'}});
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

test('the public act@6 decoder preserves the historical rig still and ordered direction comments byte-for-byte', () => {
  for (const historical of [historicalRig, historicalDirection]) {
    const act = parseCommentsAct(JSON.parse(historical.bytes));
    expect(JSON.stringify(act)).toBe(historical.bytes);
    expect(jobHash(historical.bytes)).toBe(historical.sha256);
  }
  expect(parseCommentsAct(historicalRig.receipt.value)).toMatchObject({
    kind: 'review-verdict', still: {path: historicalRig.still.sha256 + '.png', sha256: historicalRig.still.sha256, camera: 'fixed'},
  });
  expect(parseCommentsAct(historicalDirection.receipt.value)).not.toHaveProperty('still');
});

test('#1136 direction@3 comment acts keep three exact time-only pins and an interleaved general row through the retained host', async () => {
  const {f, publication, modelHash, directionBytes} = await postFixture();
  const page = await f.display(publication);
  const originalInputs = await jobInputHashes(f.root);
  const pins = [timedPin(publication.source.sourceHash, modelHash, 0.125, 4, 'First held location'),
    timedPin(publication.source.sourceHash, modelHash, 0.5000000000000001, 12, '중간 위치'),
    timedPin(publication.source.sourceHash, modelHash, 0.875, 20, 'Third held location')];
  const [first, second, third] = pins.map(({text, anchor}) => ({text, anchor}));
  const comments: JobComment[] = [first!, {text: '  Direction 전체\r\n'}, second!, third!];
  const value = {comments};
  const input = {...page, expectedGeneration: f.session.status().generation,
    submissionId: 'direction-structured', kind: 'comments', value};
  const commit = (body: object) => f.ports.commitUIAct(f.session.jobId, f.uiRequest(body));
  const withChangedMark = (change: Partial<StageComment>) => comments.map((row, index) => index !== 2 ? row : {
    text: pins[1]!.text, anchor: {...pins[1]!.anchor, context: {...pins[1]!.anchor.context as object,
      comment: {...pins[1]!.mark, ...change}}},
  });
  const pendingBeforeDrift = f.session.status();
  const directionPath = join(f.root, 'out/direction.json');
  await writeFile(directionPath, directionBytes + '\n');
  try {
    expect(await commit(input)).toMatchObject({ok: false, error: {code: 'JOB_SOURCE_MISMATCH'}});
  } finally {await writeFile(directionPath, directionBytes);}
  expect(f.session.status()).toEqual(pendingBeforeDrift);
  const saved = await commit(input);
  if (!saved.ok) throw new Error(saved.error.code);
  const parsed = parseCommentOnlyAct(saved.value);
  expect(parsed).toMatchObject({schema: 'rig-review/act@10', kind: 'comments', source: publication.source});
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
  expect(f.session.readActExport(parsed.actId, false).toString()).toBe(JSON.stringify(parsed));
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

  const pending = f.session.status();
  const negative = {...input, expectedGeneration: pending.generation};
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

test('#1136 direction comment acts preserve producer and reference frame pins', async () => {
  const {f, publication, modelHash} = await postFixture();
  const page = await f.display(publication);
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
  const value = {comments};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page,
    expectedGeneration: f.session.status().generation, submissionId: 'direction-framed', kind: 'comments', value}));
  if (!saved.ok) throw new Error(saved.error.code);
  const parsed = parseCommentOnlyAct(saved.value);
  expect(parsed).toMatchObject({schema: 'rig-review/act@10', kind: 'comments'});
  expect(parsed.value).toEqual(value);
});

test('#1136 a direction comment retains its anchorless export and replay bytes', async () => {
  const {f, publication} = await postFixture(), page = await f.display(publication);
  const text = '  Legacy 연출\r\nKeep edges  \n';
  const input = {...page, expectedGeneration: f.session.status().generation,
    submissionId: 'direction-general', kind: 'comments', value: {comments: [{text}]}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) throw new Error(saved.error.code);
  const act = parseCommentOnlyAct(saved.value);
  const expected = JSON.stringify(act);
  expect(act.value).toEqual(input.value);
  expect(await rawAct(f, act.actId)).toBe(expected);
  expect(projectComments(act.value.comments)).toBe('[general]\n' + text);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  expect(await rawAct(f, act.actId)).toBe(expected);
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
  const page = await f.display(publication);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...submission, ...page})))
    .toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
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
  expect(asked).toMatchObject({ok: false, error: {code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask'}});
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

test('a comment whose projection exceeds 10,000 UTF-16 units is refused by name (JOB_ACT_INVALID)', async () => {
  const {f, publication} = await postFixture();
  const page = await f.display(publication);
  const generation = f.session.status().generation;
  const label = '[general]\n';
  const words = 'x'.repeat(10000 - label.length + 1);
  const refused = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page,
    expectedGeneration: generation, submissionId: 'too-long', kind: 'comments',
    value: {comments: [{text: words}]}}));
  expect(refused).toEqual({ok: false, error: {code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID'}});
  expect(f.session.status().generation).toBe(generation);
  const fits = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page,
    expectedGeneration: generation, submissionId: 'fits', kind: 'comments',
    value: {comments: [{text: words.slice(1)}]}}));
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
])('#831 Parts accepts anchorless comments ($name)', async ({name, general}) => {
  const f = await fixture();
  await syntheticJobParts(f, {project: true});
  const publication = await f.publish();
  const page = await f.display(publication);
  const generation = f.session.status().generation;
  const input = {...page, expectedGeneration: generation, kind: 'comments'};

  if (name === 'exact projection limit') {
    const invalid = [
      {label: 'aggregate projection overflow', value: {comments: [{text: generalNote}, {text: boundaryTail + 'x'}]}},
      {label: 'text omitted by a trim-and-filter implementation', value: {comments: [{text: ' \t\n '}]}},
      {label: 'entry type', value: {comments: [{text: 'valid'}, {text: {text: 'object'}}]}},
      {label: 'list type', value: {comments: 'not an array'}},
      {label: 'count', value: {comments: Array.from({length: 1001}, () => ({text: 'x'}))}},
      {label: 'empty submission', value: {comments: []}},
    ];
    for (const [index, {label, value}] of invalid.entries()) {
      const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, submissionId: 'invalid-' + index, value}));
      expect(rejected, label).toMatchObject({ok: false, error: {code: 'JOB_ACT_INVALID'}});
      const status = f.session.status();
      expect(status.generation, label).toBe(generation);
    }
  }

  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input,
    submissionId: 'general-parts-831', value: {comments: general.map(text => ({text}))}}));
  if (!saved.ok) throw new Error(saved.error.code);
  const act = parseCommentOnlyAct(saved.value);
  expect(f.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
  expect(act.value).toEqual({comments: general.map(text => ({text}))});
  const projected = projectComments(act.value.comments);
  expect(projected).toBe(generalHeader + general.join('\n\n' + generalHeader));
  if (name === 'exact projection limit') expect(projected).toHaveLength(projectionLimit);
});
