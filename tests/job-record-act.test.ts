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
import { parseRecordAct, buildRecordSource } from '../src/job-api.ts';
import {parseCommentsAct, projectComments} from '../src/job-host.ts';
import commentsLegacy from './fixtures/comments-contract-legacy.json';
import {
  bindJobAsk,
  bindJobRecordAsk,
  finalizeJobAct,
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

    const boundOpt = bindJobRecordAsk(
      { kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01' },
      optRetained,
    );
    expect(boundOpt).toEqual(optRetained.source);
    expect(
      bindJobAsk({ kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01' }, optRetained),
    ).toEqual(optRetained.source);

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

    // Binds declared checkpoints and plan-bound signoffs on plan source
    expect(bindJobRecordAsk({ kind: 'checkpoint', checkpointId: 'step_layout' }, planRetained)).toEqual(
      planRetained.source,
    );
    expect(bindJobAsk({ kind: 'signoff', stage: 'plan-approved' }, planRetained)).toEqual(planRetained.source);
    expect(bindJobAsk({ kind: 'signoff', stage: 'rigging-interview' }, planRetained)).toEqual(planRetained.source);
    expect(bindJobAsk({ kind: 'signoff', stage: 'post-interview' }, planRetained)).toEqual(planRetained.source);

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

  test('[SYNTHETIC] prepares rig-review/act@4 interview-picks with in-memory validatePicks, verbatim text preservation, and zero disk writes', async () => {
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
    const boundSource = bindJobRecordAsk(subject, retained);
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
    const beforeReviewer = structuredClone(reviewer);
    const workEntriesBefore = readdirSync(workRoot);

    const act = prepareJobRecordAct({
      jobId: 'job_1',
      submission,
      ask,
      retained,
      reviewer,
      actId: 'act_picks_1',
      at: '2026-11-08T12:00:00.000Z',
    });

    expect(act.schema).toBe(JOB_RECORD_ACT_SCHEMA);
    expect(act.kind).toBe('interview-picks');
    expect(act.authority).toEqual({
      actor: 'human',
      channel: 'review-ui',
      reviewer,
    });
    expect(act.source).toEqual(boundSource);
    if (act.kind === 'interview-picks') {
      expect(act.value.note).toBe(verbatimNote);
      expect(act.value.selections[0]!.otherText).toBe(verbatimOther);
      expect(act.value.selections[1]!.otherText).toBeNull();
    }
    expect(parseRecordAct(act)).toEqual(act);

    // Also works through the finalizeJobAct overload
    const viaFinalize = finalizeJobAct({
      jobId: 'job_1',
      submission: {
        ...submission,
        value: {
          ...submission.value,
          note: '',
        },
      },
      ask,
      retained,
      reviewer: { id: 'delegate_1', role: 'delegate' },
      actId: 'act_picks_2',
      at: '2026-11-08T12:05:00.000Z',
    });
    expect(viaFinalize.schema).toBe(JOB_RECORD_ACT_SCHEMA);
    if (viaFinalize.kind === 'interview-picks') {
      expect(viaFinalize.value.note).toBe('');
    }

    // Inputs and filesystem are completely untouched
    expect(submission).toEqual(beforeSubmission);
    expect(ask).toEqual(beforeAsk);
    expect(retained).toEqual(beforeRetained);
    expect(reviewer).toEqual(beforeReviewer);
    expect(readdirSync(workRoot)).toEqual(workEntriesBefore);
    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);

    // Disallowed constraint tuple refuses with JOB_ACT_INVALID
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: {
          ...submission,
          value: {
            questionId: 'rig_type',
            selections: [
              { itemId: 'topology', optionId: 'quad_alt', otherText: null },
              { itemId: 'detail_level', optionId: 'density_high', otherText: null },
            ],
            note: 'disallowed combination',
          },
        },
        ask,
        retained,
        reviewer,
        at: '2026-11-08T12:00:00.000Z',
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));

    // 'other' option with whitespace-only otherText refuses via validatePicks
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: {
          ...submission,
          value: {
            questionId: 'rig_type',
            selections: [
              { itemId: 'topology', optionId: 'topology_other', otherText: '   ' },
              { itemId: 'detail_level', optionId: 'density_high', otherText: null },
            ],
            note: '',
          },
        },
        ask,
        retained,
        reviewer,
        at: '2026-11-08T12:00:00.000Z',
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));
  });

  test('[SYNTHETIC] prepares rig-review/act@4 checkpoint (pass/fail with planStepId===checkpointId) and plan-bound signoff acts', async () => {
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
      bindJobRecordAsk(checkpointSubject, retained),
    );
    const reviewer: JobReviewerBinding = { id: 'reviewer_1', role: 'owner' };

    for (const outcome of ['pass', 'fail'] as const) {
      const cpAct = prepareJobRecordAct({
        jobId: 'job_plan_1',
        submission: {
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
        },
        ask: checkpointAsk,
        retained,
        reviewer,
        actId: `act_cp_${outcome}`,
        at: '2026-11-08T12:00:00.000Z',
      });
      expect(cpAct.schema).toBe(JOB_RECORD_ACT_SCHEMA);
      expect(cpAct.kind).toBe('checkpoint');
      if (cpAct.kind === 'checkpoint') {
        expect(cpAct.value).toEqual({
          checkpointId: 'step_layout',
          planStepId: 'step_layout',
          outcome,
          words: outcome === 'fail' ? '   Needs joint placement adjustment   ' : '',
        });
      }
      expect(parseRecordAct(cpAct)).toEqual(cpAct);
    }

    // Pending outcome on checkpoint refuses
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_plan_1',
        submission: {
          publicationId: 'pub_plan_1',
          askId: 'ask_cp_1',
          pageId: 'page_1',
          displayedNonce: 'nonce_1',
          expectedGeneration: 2,
          submissionId: 'sub_pending',
          kind: 'checkpoint',
          value: {
            checkpointId: 'step_layout',
            outcome: 'pending' as unknown as 'pass',
            words: '',
          },
        },
        ask: checkpointAsk,
        retained,
        reviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));

    for (const stage of ['plan-approved', 'rigging-interview', 'post-interview'] as const) {
      const signoffSubject: RecordSubject = { kind: 'signoff', stage };
      const signoffAsk = buildPendingRecordAsk(
        'pub_plan_1',
        `ask_${stage}`,
        signoffSubject,
        bindJobRecordAsk(signoffSubject, retained),
      );
      const signoffAct = prepareJobRecordAct({
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
      });
      expect(signoffAct.schema).toBe(JOB_RECORD_ACT_SCHEMA);
      expect(signoffAct.kind).toBe('signoff');
      if (signoffAct.kind === 'signoff') {
        expect(signoffAct.value).toEqual({
          stage,
          decision: 'approved',
          words: `Approved ${stage}`,
        });
      }
      expect(parseRecordAct(signoffAct)).toEqual(signoffAct);
    }
  });

  test('[SYNTHETIC] refuses capture/still, extra submission authority/source fields, invalid reviewer authority, superseded asks, and stale sources', async () => {
    const workRoot = makeTempDir('review-561-guards-root-');
    const stateRoot = makeTempDir('review-561-guards-state-');
    const fixture = createSyntheticPlanRecordWorkspace(workRoot);
    const { reader } = createSyntheticRecordReader({
      onPlan: () => structuredClone(fixture.context),
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

    const subject: RecordSubject = { kind: 'checkpoint', checkpointId: 'step_layout' };
    const ask = buildPendingRecordAsk('pub_1', 'ask_1', subject, bindJobRecordAsk(subject, retained));
    const baseSubmission: JobUISubmission = {
      publicationId: 'pub_1',
      askId: 'ask_1',
      pageId: 'page_1',
      displayedNonce: 'nonce_1',
      expectedGeneration: 1,
      submissionId: 'sub_1',
      kind: 'checkpoint',
      value: {
        checkpointId: 'step_layout',
        outcome: 'pass',
        words: 'ok',
      },
    };
    const validReviewer: JobReviewerBinding = { id: 'rev_1', role: 'owner' };

    // Rejects capture or still or injected authority/source on submission
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

    // Rejects invalid reviewer bindings
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: baseSubmission,
        ask,
        retained,
        reviewer: { id: '', role: 'owner' },
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_AUTHORITY_REFUSED' }));

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: baseSubmission,
        ask,
        retained,
        reviewer: { id: 'rev_1', role: 'admin' as unknown as 'owner' },
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_AUTHORITY_REFUSED' }));

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: baseSubmission,
        ask,
        retained,
        reviewer: { id: 'rev_1', role: 'owner', by: 'owner' } as unknown as JobReviewerBinding,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_AUTHORITY_REFUSED' }));

    // Superseded ask refuses with JOB_ASK_SUPERSEDED
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: baseSubmission,
        ask: { ...ask, status: 'answered' },
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ASK_SUPERSEDED' }));

    // Stale publicationId or sourceHash refuses with JOB_ACT_SOURCE_STALE
    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: { ...baseSubmission, publicationId: 'pub_other' },
        ask,
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_SOURCE_STALE' }));

    expect(() =>
      prepareJobRecordAct({
        jobId: 'job_1',
        submission: baseSubmission,
        ask: {
          ...ask,
          source: { ...ask.source, sourceHash: 'f'.repeat(64) },
        },
        retained,
        reviewer: validReviewer,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_SOURCE_STALE' }));
  });

  test('#586 binds declared reopen subjects and prepares rig-review/act@4 with verbatim words and negative controls', async () => {
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
    const bound = bindJobRecordAsk(reopenSubject, retained);
    expect(bound).toEqual(retained.source);
    expect(bindJobAsk(reopenSubject, retained)).toEqual(retained.source);
    if (retained.source.subject !== 'plan') {
      throw new Error('Expected plan record source');
    }

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

    // parseUISubmission refuses reopen in package-only mode and accepts it in record-and-package / API@3 mode
    const rawReopenSubmission: RecordUISubmission = {
      publicationId: 'pub_plan_reopen',
      askId: 'ask_reopen_1',
      pageId: 'page_1',
      displayedNonce: 'nonce_1',
      expectedGeneration: 2,
      submissionId: 'sub_reopen_1',
      kind: 'reopen',
      value: {
        stage: 'plan-approved',
        words: '  reopen note with surrounding spaces\n',
      },
    };
    expect(() => parseUISubmission(rawReopenSubmission)).toThrow(
      expect.objectContaining({ code: 'JOB_ACT_INVALID' }),
    );
    expect(parseUISubmission(rawReopenSubmission, JOB_API_V3_SCHEMA)).toEqual(rawReopenSubmission);
    expect(parseUISubmission(rawReopenSubmission, 'record-and-package')).toEqual(rawReopenSubmission);
    expect(() =>
      parseUISubmission(
        { ...rawReopenSubmission, capture: { png: 'data:image/png;base64,AA==' } },
        JOB_API_V3_SCHEMA,
      ),
    ).toThrow(expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }));

    const ask = buildPendingRecordAsk(
      'pub_plan_reopen',
      'ask_reopen_1',
      reopenSubject,
      bound,
    );
    const validReviewer: JobReviewerBinding = { id: 'rev_1', role: 'owner' };

    // Preserves empty string, whitespace-only, and non-empty words verbatim
    for (const verbatimWords of ['', '  \n\t  ', '  reopen note with surrounding spaces\n']) {
      const submission: RecordUISubmission = {
        ...rawReopenSubmission,
        value: {
          stage: 'plan-approved',
          words: verbatimWords,
        },
      };
      const act = finalizeJobAct({
        jobId: 'job_1',
        submission,
        ask,
        retained,
        reviewer: { id: 'rev_delegate', role: 'delegate' },
        actId: 'act_reopen_1',
        at: '2026-11-09T09:30:00.000Z',
      });
      expect(act).toEqual({
        schema: JOB_RECORD_ACT_SCHEMA,
        actId: 'act_reopen_1',
        jobId: 'job_1',
        askId: 'ask_reopen_1',
        publicationId: 'pub_plan_reopen',
        kind: 'reopen',
        authority: {
          actor: 'human',
          channel: 'review-ui',
          reviewer: { id: 'rev_delegate', role: 'delegate' },
        },
        at: '2026-11-09T09:30:00.000Z',
        source: retained.source,
        value: {
          stage: 'plan-approved',
          words: verbatimWords,
        },
      });
      expect(parseRecordAct(act)).toEqual(act);
    }

    // Rejects mismatched stage, extra keys, or words > 10_000
    for (const invalidValue of [
      { stage: 'design-interview', words: 'wrong stage' },
      { stage: 'plan-approved', decision: 'reopened', words: 'extra key' },
      { stage: 'plan-approved', words: 'x'.repeat(10_001) },
    ]) {
      expect(() =>
        prepareJobRecordAct({
          jobId: 'job_1',
          submission: {
            ...rawReopenSubmission,
            value: invalidValue,
          } as unknown as RecordUISubmission,
          ask,
          retained,
          reviewer: validReviewer,
        }),
      ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));
    }

    // Freshness verification succeeds before record movement and refuses after live project.json changes while snapshot stays intact
    const freshBeforeMove = await verifyJobRecordSourceFresh({
      retained,
      readRecordPublished: reader,
      phase: 'finalize',
      subject: reopenSubject,
    });
    expect(freshBeforeMove).toEqual(retained.source);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(workspaceRoot, 'project.json'),
      `${JSON.stringify({ schema: 'rig-create/project@1', mutated: true }, null, 2)}\n`,
      'utf8',
    );
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'ask',
        subject: reopenSubject,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'JOB_RECORD_MOVED' }));
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
        subject: reopenSubject,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'JOB_RECORD_MOVED' }));
    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);
  });
});
