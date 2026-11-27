import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOB_API_V3_SCHEMA,
  JOB_RECORD_ACT_SCHEMA,
  type JobReviewerBinding,
  type JobUISubmission,
  type PendingAskV3,
  type RecordSubject,
  type RecordUISubmission,
} from '../src/job-contract.ts';
import { parseRecordAct, parseRecordSource, buildRecordSource, jobHash } from '../src/job-api.ts';

/** #1048: JSON bytes of the synthetic interview-picks act below, as 285a59f's writer emitted them. */
const PICKS_ACT_SHA256_285A59F = 'a7840d56090451e06143b4c5496e43338de57d387a255849ccb282f1776162e1';
import {parseCommentsAct, projectComments} from '../src/job-host.ts';
import commentsLegacy from './fixtures/comments-contract-legacy.json';
import {
  bindJobRecordAsk,
  parseUISubmission,
  prepareJobRecordAct,
} from '../src/job-act.ts';
import {
  assertRetainedSnapshotIntact,
  captureJobRoot,
  prepareJobRecordSource,
  verifyJobRecordSourceFresh,
} from '../src/job-source.ts';
import {
  createSyntheticOptionRecordWorkspace,
  createSyntheticPlanRecordWorkspace,
  createSyntheticRecordReader,
} from './helpers/job-record-fixture.ts';
import { seedHistoricalCheckpointAct, seedHistoricalCheckpointAsk } from './helpers/historical-checkpoint-act.ts';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts } from '../src/job-api.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#1229 fresh record checkpoint asks refuse JOB_REQUEST_INVALID, fresh submissions refuse JOB_ACT_KIND_DISABLED, and stored act@4 replays byte-for-byte', async () => {
  const workRoot = makeTempDir('review-1229-plan-root-');
  const stateRoot = makeTempDir('review-1229-plan-state-');
  const ws = createSyntheticPlanRecordWorkspace(workRoot);
  const { reader } = createSyntheticRecordReader({ onPlan: () => structuredClone(ws.context) });
  const session = new JobSession({
    root: workRoot,
    stateDir: stateRoot,
    fingerprint: 'a'.repeat(64),
    reviewer: { id: 'synthetic-owner', role: 'owner' },
    publicationMode: 'record-and-package',
    readRecordPublished: reader,
  });
  try {
    const origin = 'http://127.0.0.1:19129';
    const ports = createJobHostPorts(session, origin);
    const agent = session.hostCredentials().agent;
    const ui = session.hostCredentials().ui;
    const call = async (body: object) => (await ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + agent },
      body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'req-1229', ...body }),
    }))).json();
    const uiPost = (body: object) => new Request(origin + `/jobs/${session.jobId}/ui/acts`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Review-Capability': ui },
      body: JSON.stringify(body),
    });

    const pubRes = await call({
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'pub-1229',
      result: ws.result,
      freeze: { kind: 'producer-held', holdId: 'hold-1229', record: ws.record },
    });
    expect(pubRes.ok).toBe(true);
    const publicationId = pubRes.value.publicationId as string;
    expect(pubRes.value.source.subjects).toContainEqual({ kind: 'checkpoint', checkpointId: 'step_layout' });

    const askRes = await call({
      verb: 'ask',
      expectedGeneration: session.status().generation,
      idempotencyKey: 'ask-1229',
      publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'step_layout' },
    });
    expect(askRes).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask' } });

    const batchRes = await call({
      verb: 'ask-batch',
      expectedGeneration: session.status().generation,
      idempotencyKey: 'batch-1229',
      publicationId,
      subjects: [{ kind: 'checkpoint', checkpointId: 'step_layout' }],
    });
    expect(batchRes).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask-batch' } });

    const ackRes = await ports.ackDisplayed(session.jobId, new Request(origin + `/jobs/${session.jobId}/ui/displayed`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Review-Capability': ui },
      body: JSON.stringify({ publicationId, pageId: 'page-1229', sourceHash: pubRes.value.source.sourceHash }),
    }));
    expect(ackRes.ok).toBe(true);
    if (!ackRes.ok) throw new Error(ackRes.error.code);
    const displayedNonce = ackRes.value.displayedNonce;

    const legacyAsk = seedHistoricalCheckpointAsk(session, publicationId, { kind: 'checkpoint', checkpointId: 'step_layout' });
    const freshSubmit = await ports.commitUIAct(session.jobId, uiPost({
      publicationId,
      askId: legacyAsk.askId,
      pageId: 'page-1229',
      displayedNonce,
      expectedGeneration: session.status().generation,
      submissionId: 'fresh-rec-cp',
      kind: 'checkpoint',
      value: { checkpointId: 'step_layout', outcome: 'pass', words: '' },
    }));
    expect(freshSubmit).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });

    const replayGeneration = session.status().generation;
    const stored = seedHistoricalCheckpointAct(session, {
      publicationId,
      pageId: 'page-1229',
      displayedNonce,
      expectedGeneration: replayGeneration,
      submissionId: 'replay-rec-cp',
      checkpointId: 'step_layout',
      value: { checkpointId: 'step_layout', outcome: 'fail', words: '  Needs repair  ' },
    });
    expect(stored.schema).toBe(JOB_RECORD_ACT_SCHEMA);
    const replayBody = {
      publicationId,
      askId: stored.askId,
      pageId: 'page-1229',
      displayedNonce,
      expectedGeneration: replayGeneration,
      submissionId: 'replay-rec-cp',
      kind: 'checkpoint',
      value: { checkpointId: 'step_layout', outcome: 'fail', words: '  Needs repair  ' },
    };
    const replayed = await ports.commitUIAct(session.jobId, uiPost(replayBody));
    expect(replayed).toEqual({ ok: true, value: stored });
    expect(session.readActExport(stored.actId, false).toString()).toBe(JSON.stringify(stored));
  } finally {
    session.dispose();
  }
});

test('#646 record-plan @6 reuses declared checkpoint/signoff/reopen subjects and refuses option-set sources', () => {
  const root = makeTempDir('646-record-plan-'), workspace = createSyntheticPlanRecordWorkspace(root, {subjects: [
    {kind: 'checkpoint', checkpointId: 'step_layout'}, {kind: 'signoff', stage: 'plan-approved'}, {kind: 'reopen', stage: 'plan-approved'},
  ]});
  const source = buildRecordSource({record: workspace.record, selection: workspace.result, context: workspace.context});
  const old = JSON.parse(commentsLegacy.records['@4'].raw);
  for (const subject of source.subjects) {
    const value = subject.kind === 'checkpoint' ? {checkpointId: subject.checkpointId, planStepId: subject.checkpointId, outcome: 'pass', comments: [{text: 'Review plan'}]} :
      {stage: subject.stage, ...(subject.kind === 'signoff' ? {decision: 'approved'} : {}), comments: [{text: 'Review plan'}]};
    const parsed = parseCommentsAct({...old, schema: 'rig-review/act@6', source, kind: subject.kind, value});
    expect(parsed.source).toEqual(source);
    expect(projectComments(parsed.value.comments)).toBe('[general]\nReview plan');
  }
  const options = createSyntheticOptionRecordWorkspace(makeTempDir('646-record-options-'));
  const optionSource = buildRecordSource({record: options.record, selection: options.result, context: options.context, optionSetFile: options.optionSetFile});
  expect(() => parseCommentsAct({...old, schema: 'rig-review/act@6', source: optionSource,
    kind: 'signoff', value: {stage: 'plan-approved', decision: 'approved', comments: []}})).toThrow('JOB_ACT_INVALID');
});

test('#646 act@6 decodes record picks using the existing option-set binding', () => {
  const options = createSyntheticOptionRecordWorkspace(makeTempDir('646-record-picks-'));
  const source = buildRecordSource({record: options.record, selection: options.result, context: options.context, optionSetFile: options.optionSetFile});
  const old = JSON.parse(commentsLegacy.records['@4'].raw);
  const input = {...old, schema: 'rig-review/act@6', kind: 'interview-picks', source, value: {
    questionId: options.result.questionId, selections: [], note: '원문', comments: [{text: '  Keep this\n', anchor: {name: 'reference.png'}}],
  }};
  const historical = parseRecordAct({...input, schema: JOB_RECORD_ACT_SCHEMA, value: {
    questionId: input.value.questionId, selections: input.value.selections, note: input.value.note,
  }});
  expect(JSON.stringify(parseCommentsAct(input))).toBe(JSON.stringify({
    ...historical, schema: 'rig-review/act@6', value: input.value,
  }));
  expect(() => parseCommentsAct({...input, value: {...input.value, questionId: 'wrong-question'}})).toThrow('JOB_ACT_INVALID');
});

function buildPendingRecordAsk(
  publicationId: string,
  askId: string,
  subject: RecordSubject,
  source: PendingAskV3['source'],
  status: PendingAskV3['status'] = 'pending',
): PendingAskV3 {
  return {
    askId,
    publicationId,
    subject,
    status,
    source,
  };
}

describe('Review #561 model-free record ask binding and act@4 preparation (SYNTHETIC reader fixtures)', () => {
  test('[SYNTHETIC] binds declared record asks and refuses undeclared, ineligible, disabled, or aliased subjects', async () => {
    const optWorkRoot = makeTempDir('review-561-act-opt-root-');
    const planWorkRoot = makeTempDir('review-561-act-plan-root-');
    const stateRoot = makeTempDir('review-561-act-state-');

    const optFixture = createSyntheticOptionRecordWorkspace(optWorkRoot);
    const planFixture = createSyntheticPlanRecordWorkspace(planWorkRoot);
    const { reader } = createSyntheticRecordReader({
      onOption: () => structuredClone(optFixture.context),
      onPlan: () => structuredClone(planFixture.context),
    });

    const optRetained = await prepareJobRecordSource({
      root: captureJobRoot(optWorkRoot),
      stateRoot,
      fingerprint: 'fp-opt',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_opt', record: optFixture.record },
        result: optFixture.result,
      },
      readRecordPublished: reader,
    });

    const planRetained = await prepareJobRecordSource({
      root: captureJobRoot(planWorkRoot),
      stateRoot,
      fingerprint: 'fp-plan',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_plan', record: planFixture.record },
        result: planFixture.result,
      },
      readRecordPublished: reader,
    });

    // #1230: a declared picks subject still parses on the source but refuses a fresh ask
    expect(optRetained.source.subjects).toContainEqual({ kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01' });
    expect(() =>
      bindJobRecordAsk({ kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));

    // Refuses wrong questionId/setId or plan/package subjects on option-set source
    expect(() =>
      bindJobRecordAsk({ kind: 'interview-picks', questionId: 'other_q', setId: 'set_rig_type_01' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'checkpoint', checkpointId: 'step_layout' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'signoff', stage: 'plan-approved' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'parts-verdict', draftId: 'draft_1' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'review-verdict', stage: 'rig-review' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'mesh-edit' }, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_KIND_DISABLED' }));

    // Declared checkpoints (#1229) and signoffs (#1227) still parse on the source, while the historical binders refuse JOB_ASK_INVALID
    expect(planRetained.source.subjects).toContainEqual({ kind: 'checkpoint', checkpointId: 'step_layout' });
    expect(() => bindJobRecordAsk({ kind: 'checkpoint', checkpointId: 'step_layout' }, planRetained)).toThrow(
      expect.objectContaining({ code: 'JOB_ASK_INVALID' }),
    );
    for (const stage of ['plan-approved', 'rigging-interview', 'post-interview'] as const) {
      expect(planRetained.source.subjects).toContainEqual({ kind: 'signoff', stage });
      expect(() => bindJobRecordAsk({ kind: 'signoff', stage }, planRetained)).toThrow(
        expect.objectContaining({ code: 'JOB_ASK_INVALID' }),
      );
    }

    // Refuses checkpoint planStepId alias and non-record signoff stages
    expect(() =>
      bindJobRecordAsk(
        { kind: 'checkpoint', checkpointId: 'step_layout', planStepId: 'step_layout' },
        planRetained,
      ),
    ).toThrow(expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'checkpoint', checkpointId: 'undeclared_step' }, planRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'signoff', stage: 'parts-review' }, planRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01' }, planRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));

    // Empty plan inspection source refuses signoff and checkpoint asks with JOB_ASK_INVALID
    const emptyPlanWorkRoot = makeTempDir('review-561-act-empty-plan-root-');
    const emptyPlanFixture = createSyntheticPlanRecordWorkspace(emptyPlanWorkRoot, {
      steps: [],
      subjects: [],
    });
    const emptyPlanReader = createSyntheticRecordReader({
      onPlan: () => structuredClone(emptyPlanFixture.context),
    });
    const emptyPlanRetained = await prepareJobRecordSource({
      root: captureJobRoot(emptyPlanWorkRoot),
      stateRoot,
      fingerprint: 'fp-empty-plan',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_empty_plan', record: emptyPlanFixture.record },
        result: emptyPlanFixture.result,
      },
      readRecordPublished: emptyPlanReader.reader,
    });
    expect(() =>
      bindJobRecordAsk({ kind: 'signoff', stage: 'plan-approved' }, emptyPlanRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    expect(() =>
      bindJobRecordAsk({ kind: 'checkpoint', checkpointId: 'step_layout' }, emptyPlanRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
  });

  test('[SYNTHETIC] #1230 refuses interview-picks record submissions JOB_ACT_KIND_DISABLED with zero disk writes while historical act@4 picks bytes decode', async () => {
    const workRoot = makeTempDir('review-561-picks-root-');
    const stateRoot = makeTempDir('review-561-picks-state-');
    const fixture = createSyntheticOptionRecordWorkspace(workRoot);
    const { reader } = createSyntheticRecordReader({
      onOption: () => structuredClone(fixture.context),
    });

    const retained = await prepareJobRecordSource({
      root: captureJobRoot(workRoot),
      stateRoot,
      fingerprint: 'fp-picks',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_picks', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });

    const subject: RecordSubject = {
      kind: 'interview-picks',
      questionId: 'rig_type',
      setId: 'set_rig_type_01',
    };
    // A pending picks ask stored by an earlier Review, bound to the retained source as the removed binder did.
    const boundSource = parseRecordSource(retained.source);
    const ask = buildPendingRecordAsk('pub_opt_1', 'ask_opt_1', subject, boundSource);

    const reviewer: JobReviewerBinding = {
      id: 'reviewer-owner-\u0007-' + 'r'.repeat(180),
      role: 'owner',
    };
    const verbatimNote = '   \n\t  한국어 노트 & English   🚀  ';
    const verbatimOther = '  custom quadruped-biped hybrid  ';
    const submission: JobUISubmission = {
      publicationId: 'pub_opt_1',
      askId: 'ask_opt_1',
      pageId: 'page_1',
      displayedNonce: 'nonce_1',
      expectedGeneration: 1,
      submissionId: 'sub_1',
      kind: 'interview-picks',
      value: {
        questionId: 'rig_type',
        selections: [
          { itemId: 'topology', optionId: 'topology_other', otherText: verbatimOther },
          { itemId: 'detail_level', optionId: 'density_high', otherText: null },
        ],
        note: verbatimNote,
      },
    };

    const beforeSubmission = structuredClone(submission);
    const beforeAsk = structuredClone(ask);
    const beforeRetained = structuredClone(retained);
    const workEntriesBefore = readdirSync(workRoot);

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1', submission, ask, retained, reviewer, actId: 'act_picks_1', at: '2026-11-08T12:00:00.000Z',
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_KIND_DISABLED' }));
    // The act@4 picks bytes 285a59f's writer emitted for this submission still decode byte-identically.
    const survey = { questionId: 'rig_type', selections: submission.value.selections, note: verbatimNote };
    const historical = {
      schema: JOB_RECORD_ACT_SCHEMA, actId: 'act_picks_1', jobId: 'job_1', askId: 'ask_opt_1', publicationId: 'pub_opt_1',
      kind: 'interview-picks', authority: { actor: 'human', channel: 'review-ui', reviewer }, at: '2026-11-08T12:00:00.000Z',
      source: boundSource, value: survey,
    };
    const bytes = JSON.stringify(historical);
    expect(jobHash(bytes)).toBe(PICKS_ACT_SHA256_285A59F);
    expect(JSON.stringify(parseRecordAct(JSON.parse(bytes)))).toBe(bytes);
    const words = projectComments([{text: 'general'}]);
    const historicalWords = {...historical, value: {...survey, words}};
    expect(JSON.stringify(parseRecordAct(historicalWords))).toBe(JSON.stringify(historicalWords));
    // And the act@6 form the writer emitted before the refusal.
    const act6 = {...historical, schema: 'rig-review/act@6', value: {...survey, comments: []}};
    expect(JSON.stringify(parseCommentsAct(act6))).toBe(JSON.stringify(act6));

    // Inputs and filesystem are completely untouched
    expect(submission).toEqual(beforeSubmission);
    expect(ask).toEqual(beforeAsk);
    expect(retained).toEqual(beforeRetained);
    expect(readdirSync(workRoot)).toEqual(workEntriesBefore);
    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);
  });

  test('[SYNTHETIC] refuses fresh checkpoint and signoff record submissions while historical rig-review/act@4 checkpoint and signoff acts read byte-exact', async () => {
    const workRoot = makeTempDir('review-561-plan-act-root-');
    const stateRoot = makeTempDir('review-561-plan-act-state-');
    const fixture = createSyntheticPlanRecordWorkspace(workRoot);
    const { reader } = createSyntheticRecordReader({
      onPlan: () => structuredClone(fixture.context),
    });

    const retained = await prepareJobRecordSource({
      root: captureJobRoot(workRoot),
      stateRoot,
      fingerprint: 'fp-plan-act',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_plan_act', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });

    const checkpointSubject: RecordSubject = { kind: 'checkpoint', checkpointId: 'step_layout' };
    const checkpointAsk = buildPendingRecordAsk(
      'pub_plan_1',
      'ask_cp_1',
      checkpointSubject,
      retained.source,
    );
    const reviewer: JobReviewerBinding = { id: 'reviewer_1', role: 'owner' };
    const { directionReview: _directionReview, ...actSource } = retained.source;

    for (const outcome of ['pass', 'fail'] as const) {
      const submission: JobUISubmission = {
        publicationId: 'pub_plan_1',
        askId: 'ask_cp_1',
        pageId: 'page_1',
        displayedNonce: 'nonce_1',
        expectedGeneration: 2,
        submissionId: `sub_${outcome}`,
        kind: 'checkpoint',
        value: {
          checkpointId: 'step_layout',
          outcome,
          words: outcome === 'fail' ? '   Needs joint placement adjustment   ' : '',
        },
      };
      expect(() =>
        prepareJobRecordAct({
          jobId: 'job_plan_1',
          submission,
          ask: checkpointAsk,
          retained,
          reviewer,
          actId: `act_cp_${outcome}`,
          at: '2026-11-08T12:00:00.000Z',
        }),
      ).toThrow(expect.objectContaining({ code: 'JOB_ACT_KIND_DISABLED' }));
      const storedCheckpointAct = {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId: `act_cp_${outcome}`,
        jobId: 'job_plan_1',
        askId: 'ask_cp_1',
        publicationId: 'pub_plan_1',
        kind: 'checkpoint' as const,
        authority: { actor: 'human' as const, channel: 'review-ui' as const, reviewer },
        at: '2026-11-08T12:00:00.000Z',
        source: actSource,
        value: {
          checkpointId: 'step_layout',
          planStepId: 'step_layout',
          outcome,
          words: outcome === 'fail' ? '   Needs joint placement adjustment   ' : '',
        },
      };
      expect(JSON.stringify(parseRecordAct(storedCheckpointAct))).toBe(JSON.stringify(storedCheckpointAct));
    }

    // Pending outcome on stored checkpoint act refuses JOB_ACT_INVALID
    expect(() =>
      parseRecordAct({
        schema: JOB_RECORD_ACT_SCHEMA,
        actId: 'act_cp_pending',
        jobId: 'job_plan_1',
        askId: 'ask_cp_1',
        publicationId: 'pub_plan_1',
        kind: 'checkpoint',
        authority: { actor: 'human', channel: 'review-ui', reviewer },
        at: '2026-11-08T12:00:00.000Z',
        source: actSource,
        value: {
          checkpointId: 'step_layout',
          planStepId: 'step_layout',
          outcome: 'pending',
          words: '',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));

    for (const stage of ['plan-approved', 'rigging-interview', 'post-interview'] as const) {
      const signoffSubject: RecordSubject = { kind: 'signoff', stage };
      const signoffAsk = buildPendingRecordAsk(
        'pub_plan_1',
        `ask_${stage}`,
        signoffSubject,
        retained.source,
      );
      expect(() =>
        prepareJobRecordAct({
          jobId: 'job_plan_1',
          submission: {
            publicationId: 'pub_plan_1',
            askId: `ask_${stage}`,
            pageId: 'page_1',
            displayedNonce: 'nonce_1',
            expectedGeneration: 2,
            submissionId: `sub_${stage}`,
            kind: 'signoff',
            value: {
              stage,
              decision: 'approved',
              words: `Approved ${stage}`,
            },
          },
          ask: signoffAsk,
          retained,
          reviewer: { id: 'delegate_reviewer', role: 'delegate' },
          actId: `act_${stage}`,
          at: '2026-11-08T12:10:00.000Z',
        }),
      ).toThrow(expect.objectContaining({ code: 'JOB_ACT_KIND_DISABLED' }));

      const { directionReview: _directionReview, ...actSource } = retained.source;
      const storedSignoffAct = {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId: `act_${stage}`,
        jobId: 'job_plan_1',
        askId: `ask_${stage}`,
        publicationId: 'pub_plan_1',
        kind: 'signoff' as const,
        authority: {
          actor: 'human' as const,
          channel: 'review-ui' as const,
          reviewer: { id: 'delegate_reviewer', role: 'delegate' as const },
        },
        at: '2026-11-08T12:10:00.000Z',
        source: actSource,
        value: {
          stage,
          decision: 'approved' as const,
          words: `Approved ${stage}`,
        },
      };
      expect(JSON.stringify(parseRecordAct(storedSignoffAct))).toBe(JSON.stringify(storedSignoffAct));
    }
  });

  test('[SYNTHETIC] refuses capture/still, extra submission authority/source fields, retired record ask kinds, and invalid comment-act reviewer bindings', async () => {
    const { finalizeCommentOnlyAct } = await import('../src/job-act.ts');
    const workRoot = makeTempDir('review-561-guards-root-');
    const stateRoot = makeTempDir('review-561-guards-state-');
    // #1229 / #1230: all record ask kinds are retired; prepareJobRecordAct still rejects envelope injections first and then JOB_ACT_KIND_DISABLED, while finalizeCommentOnlyAct enforces reviewer and carrier guards on live record acts.
    const fixture = createSyntheticOptionRecordWorkspace(workRoot);
    const { reader } = createSyntheticRecordReader({
      onOption: () => structuredClone(fixture.context),
    });

    const retained = await prepareJobRecordSource({
      root: captureJobRoot(workRoot),
      stateRoot,
      fingerprint: 'fp-guards',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_guards', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });

    const subject: RecordSubject = { kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01' };
    expect(() => bindJobRecordAsk(subject, retained)).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
    const ask = buildPendingRecordAsk('pub_1', 'ask_1', subject, retained.source);
    const baseSubmission: JobUISubmission = {
      publicationId: 'pub_1',
      askId: 'ask_1',
      pageId: 'page_1',
      displayedNonce: 'nonce_1',
      expectedGeneration: 1,
      submissionId: 'sub_1',
      kind: 'interview-picks',
      value: {
        questionId: 'rig_type',
        selections: [
          { itemId: 'topology', optionId: 'biped_std', otherText: null },
          { itemId: 'detail_level', optionId: 'density_high', otherText: null },
        ],
        note: 'ok',
      },
    };
    const validReviewer: JobReviewerBinding = { id: 'rev_1', role: 'owner' };

    // Rejects capture or still or injected authority/source on submission before kind refusal
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: { ...baseSubmission, capture: {} as never },
        ask,
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }));

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: baseSubmission,
        ask,
        retained,
        reviewer: validReviewer,
        still: { path: 'a.png', sha256: '0'.repeat(64), camera: 'fixed', frame: 'setup' },
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }));

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: { ...baseSubmission, authority: { actor: 'human' } } as unknown as JobUISubmission,
        ask,
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }));

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: { ...baseSubmission, source: retained.source } as unknown as JobUISubmission,
        ask,
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }));

    // Retired record ask kinds refuse with JOB_ACT_KIND_DISABLED
    for (const disabledKind of ['interview-picks', 'checkpoint', 'signoff'] as const) {
      expect(() =>
        prepareJobRecordAct({
          jobId: 'job_1',
          submission: { ...baseSubmission, kind: disabledKind } as unknown as import('../src/job-contract.ts').UISubmissionV3,
          ask,
          retained,
          reviewer: validReviewer,
        }),
      ).toThrow(expect.objectContaining({ code: 'JOB_ACT_KIND_DISABLED' }));
    }

    // Live record comment-only acts reject invalid reviewer bindings and model carriers
    const commentSubmission: Extract<import('../src/job-contract.ts').UISubmissionV3, { kind: 'comments' }> = {
      publicationId: 'pub_1',
      pageId: 'page_1',
      displayedNonce: 'nonce_1',
      expectedGeneration: 1,
      submissionId: 'sub_comments_1',
      kind: 'comments',
      value: { comments: [{ text: 'ok' }] },
    };
    expect(() =>
      finalizeCommentOnlyAct({
        jobId: 'job_1',
        submission: commentSubmission,
        retained,
        reviewer: { id: '', role: 'owner' },
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_AUTHORITY_REFUSED' }));

    expect(() =>
      finalizeCommentOnlyAct({
        jobId: 'job_1',
        submission: commentSubmission,
        retained,
        reviewer: { id: 'rev_1', role: 'admin' as unknown as 'owner' },
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_AUTHORITY_REFUSED' }));

    expect(() =>
      finalizeCommentOnlyAct({
        jobId: 'job_1',
        submission: { ...commentSubmission, value: { comments: [{ text: 'ok' }], carriers: [] } },
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));
  });

  test('#586 / #989 refuses declared reopen asks and submissions while decoding stored rig-review/act@4 reopen acts with verbatim words', async () => {
    const workspaceRoot = makeTempDir('rig-review-rec-reopen-ws-');
    const stateRoot = makeTempDir('rig-review-rec-reopen-state-');
    const ws = createSyntheticPlanRecordWorkspace(workspaceRoot, {
      subjects: [
        { kind: 'checkpoint', checkpointId: 'step_layout' },
        { kind: 'signoff', stage: 'plan-approved' },
        { kind: 'reopen', stage: 'plan-approved' },
        { kind: 'reopen', stage: 'design-interview' },
      ],
    });
    const optWsRoot = makeTempDir('rig-review-rec-reopen-opt-ws-');
    const optWs = createSyntheticOptionRecordWorkspace(optWsRoot);
    const { reader } = createSyntheticRecordReader({
      onOption: () => structuredClone(optWs.context),
      onPlan: () => structuredClone(ws.context),
    });
    const retained = await prepareJobRecordSource({
      root: captureJobRoot(workspaceRoot),
      stateRoot,
      fingerprint: 'fp-reopen-plan',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_reopen_plan', record: ws.record },
        result: ws.result,
      },
      readRecordPublished: reader,
    });

    const reopenSubject: RecordSubject = {
      kind: 'reopen',
      stage: 'plan-approved',
    };
    if (retained.source.subject !== 'plan') {
      throw new Error('Expected plan record source');
    }
    expect(retained.source.subjects).toContainEqual(reopenSubject);

    // #989 Bar 2: declared reopen stage refuses with JOB_ASK_INVALID
    expect(() => bindJobRecordAsk(reopenSubject, retained)).toThrow(
      expect.objectContaining({ code: 'JOB_ASK_INVALID' }),
    );

    // Undeclared reopen stage refuses with JOB_ASK_INVALID
    expect(() =>
      bindJobRecordAsk({ kind: 'reopen', stage: 'post-interview' }, retained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));

    // Option-set retained source refuses reopen subject
    const optRetained = await prepareJobRecordSource({
      root: captureJobRoot(optWsRoot),
      stateRoot,
      fingerprint: 'fp-reopen-opt',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_reopen_opt', record: optWs.record },
        result: optWs.result,
      },
      readRecordPublished: reader,
    });
    expect(() =>
      bindJobRecordAsk(reopenSubject, optRetained),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));

    // Decoding a stored reopen act@4 preserves empty string, whitespace-only, and non-empty words verbatim
    for (const verbatimWords of ['', '  \n\t  ', '  reopen note with surrounding spaces\n']) {
      const storedAct = {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId: 'act_reopen_1',
        jobId: 'job_1',
        askId: 'ask_reopen_1',
        publicationId: 'pub_plan_reopen',
        kind: 'reopen' as const,
        authority: {
          actor: 'human' as const,
          channel: 'review-ui' as const,
          reviewer: { id: 'rev_delegate', role: 'delegate' as const },
        },
        at: '2026-11-09T09:30:00.000Z',
        source: retained.source,
        value: {
          stage: 'plan-approved',
          words: verbatimWords,
        },
      };
      expect(parseRecordAct(storedAct)).toEqual(storedAct);
    }

    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);
  });
});
