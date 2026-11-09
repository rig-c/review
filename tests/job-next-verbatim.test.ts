import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JOB_ACT_SCHEMA,
  JOB_RIG_REVIEW_ACT_SCHEMA,
  JOB_PARTS_VERDICT_ACT_SCHEMA,
  JOB_API_SCHEMA,
  type JobAct,
  type JobActSources,
  type JobActValues,
  type JobApiResponse,
  type JobEnabledActKind,
  type JobEvent,
  type JobHumanAuthority,
  type JobImageReviewValue,
  type JobImageSetInput,
  type JobNextValue,
  type JobRigStill,
  type JobRigReviewAct,
} from '../src/job-contract.ts';
import { jobHash } from '../src/job-api.ts';
import { jobCommand } from '../src/job-cli.ts';
import { readProject } from '../src/interview-project.ts';
import { jobFixture, jobInputHashes, syntheticJobParts } from './helpers/job-api-fixture.ts';
import { joinedVerdictFixture } from './helpers/joined-verdict-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {PNG} from 'pngjs';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {loadPartsView} from '../src/parts-view.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function fixture(options?: Parameters<typeof jobFixture>[0]) {
  const f = await jobFixture(options);
  fixtures.push(f);
  return f;
}

const EXPECTED_AUTHORITY: JobHumanAuthority = {
  actor: 'human',
  channel: 'review-ui',
  reviewer: { id: 'declared-owner', role: 'owner' },
};

interface ExpectedActOracleInput<Kind extends JobEnabledActKind = JobEnabledActKind> {
  readonly actId: string;
  readonly jobId: string;
  readonly askId: string;
  readonly publicationId: string;
  readonly kind: Kind;
  readonly authority: JobHumanAuthority;
  readonly source: JobActSources[Kind];
  readonly value: JobActValues[Kind];
  readonly still?: JobRigStill;
}

type NextSuccessEnvelope = Extract<JobApiResponse, { verb: 'next' }> & {
  readonly ok: true;
  readonly value: JobNextValue;
};

/**
 * Shared oracle for genuine semantic `next` responses and named in-memory mutants.
 * Validates the `next` envelope, event cursors, exact source/authority provenance,
 * and byte-for-byte reviewer-authored human words against original inputs.
 */
function assertNextVerbatimOracle(
  nextPayload: unknown,
  expectedJobId: string,
  expectedActs: readonly ExpectedActOracleInput[],
): NextSuccessEnvelope {
  expect(nextPayload).toBeDefined();
  expect(typeof nextPayload).toBe('object');
  const response = nextPayload as NextSuccessEnvelope;
  expect(response.schema).toBe(JOB_API_SCHEMA);
  expect(response.verb).toBe('next');
  expect(response.jobId).toBe(expectedJobId);
  expect(response.ok).toBe(true);
  expect(response.value.status).toBe('events');

  const actEvents = response.value.events.filter(
    (event): event is Extract<JobEvent, { readonly type: 'act' }> => event.type === 'act',
  );
  expect(actEvents).toHaveLength(expectedActs.length);
  expect(response.value.cursor).toBe(response.value.events.at(-1)?.cursor ?? null);

  for (const [index, expected] of expectedActs.entries()) {
    const event = actEvents[index]!;
    expect(event.jobId).toBe(expectedJobId);
    expect(typeof event.cursor).toBe('string');
    expect(event.cursor.length).toBeGreaterThan(0);

    const act: JobAct = event.act;
    const rig = expected.kind === 'review-verdict' &&
      (expected.value as {stage?: string}).stage === 'rig-review';
    expect(act.schema).toBe(rig ? JOB_RIG_REVIEW_ACT_SCHEMA :
      expected.kind === 'parts-verdict' ? JOB_PARTS_VERDICT_ACT_SCHEMA : JOB_ACT_SCHEMA);
    if (rig) {
      const expectedStill = expected.still;
      expect(expectedStill).toBeDefined();
      expect((act as JobRigReviewAct).still).toEqual(expectedStill!);
    }
    expect(act.actId).toBe(expected.actId);
    expect(act.jobId).toBe(expected.jobId);
    expect(act.askId).toBe(expected.askId);
    expect(act.publicationId).toBe(expected.publicationId);
    expect(act.kind).toBe(expected.kind);
    expect(act.authority).toEqual(expected.authority);
    expect(act.source).toEqual(expected.source);
    expect(act.value).toEqual(expected.value);
  }
  return response;
}

interface NamedMutantCase {
  readonly name: string;
  readonly targetField: string;
  readonly originalWords: string;
  readonly mutatedWords: string;
  readonly mutate: (clonedNext: NextSuccessEnvelope) => void;
}

function assertPlantedMutantRejectedBySameOracle(
  genuineNext: NextSuccessEnvelope,
  expectedJobId: string,
  expectedActs: readonly ExpectedActOracleInput[],
  mutant: NamedMutantCase,
) {
  const mutatedNext = structuredClone(genuineNext);
  mutant.mutate(mutatedNext);

  let caughtError: unknown = null;
  try {
    assertNextVerbatimOracle(mutatedNext, expectedJobId, expectedActs);
  } catch (error) {
    caughtError = error;
  }

  if (caughtError === null) {
    throw new Error(`UNEXPECTED_GREEN_MUTANT_ESCAPED: ${mutant.name} (${mutant.targetField})`);
  }

  const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
  const receipt = {
    status: 'EXPECTED_RED_PLANTED_MUTANT_DETECTED',
    mutant: mutant.name,
    targetField: mutant.targetField,
    originalWords: mutant.originalWords,
    mutatedWords: mutant.mutatedWords,
    rejectedBySameOracle: true,
    errorExcerpt: message.slice(0, 240),
  };
  console.log(JSON.stringify(receipt));
  expect(receipt.rejectedBySameOracle).toBe(true);
  expect(message.length).toBeGreaterThan(0);
  return receipt;
}

test('real semantic next preserves verbatim reviewer words across checkpoint, signoff and rig review-verdict and rejects named in-memory word mutations', async () => {
  const f = await fixture();
  const beforeHashes = await jobInputHashes(f.root);
  const publication = await f.publish();
  if (publication.source.subject === 'image-set') throw new Error('Expected model source binding');

  const checkpointWords =
    '  [검수/Checkpoint #1] 어깨 실루엣이 2px 어긋남 — needs exact hold! 🤔\n\t- line 2: 앞뒤 공백·탭·줄바꿈(CRLF 아님) & 기호(!@#$%^&*) 유지 ✨  ';
  const signoffWords = ' \n\t  [Sign-off 승인] 계획 단계(plan-approved) 원문 그대로 통과합니다. ✅\n\t  ';
  const rigVerdictWords =
    '  "Rig 검수 완료?" 아니오: 호흡(idle) 전환 시 목 회전 각도 +3.5° 조정 필요 🛠️\n\t다음 패스에서 다시 확인!  ';

  const checkpointAsk = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' });
  const signoffAsk = await f.ask(publication, { kind: 'signoff', stage: 'plan-approved' });
  const verdictAsk = await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' });
  const page = await f.display(publication);

  const rigCapture = rigStillCapture(publication, verdictAsk, page);

  const committedCheckpoint = await f.ports.commitUIAct(
    f.session.jobId,
    f.uiRequest({
      ...page,
      askId: checkpointAsk.askId,
      expectedGeneration: f.session.status().generation,
      submissionId: 'verbatim-checkpoint',
      kind: 'checkpoint',
      value: { checkpointId: 'step-one', outcome: 'fail', words: checkpointWords },
    }),
  );
  expect(committedCheckpoint.ok).toBe(true);
  if (!committedCheckpoint.ok) throw new Error(committedCheckpoint.error.code);

  const committedSignoff = await f.ports.commitUIAct(
    f.session.jobId,
    f.uiRequest({
      ...page,
      askId: signoffAsk.askId,
      expectedGeneration: f.session.status().generation,
      submissionId: 'verbatim-signoff',
      kind: 'signoff',
      value: { stage: 'plan-approved', decision: 'approved', words: signoffWords },
    }),
  );
  expect(committedSignoff.ok).toBe(true);
  if (!committedSignoff.ok) throw new Error(committedSignoff.error.code);

  const committedVerdict = await f.ports.commitUIAct(
    f.session.jobId,
    f.uiRequest({
      ...page,
      askId: verdictAsk.askId,
      expectedGeneration: f.session.status().generation,
      submissionId: 'verbatim-rig-verdict',
      kind: 'review-verdict',
      value: { stage: 'rig-review', verdict: 'changes-requested', words: rigVerdictWords },
      capture: rigCapture.capture,
    }),
  );
  expect(committedVerdict.ok).toBe(true);
  if (!committedVerdict.ok) throw new Error(committedVerdict.error.code);

  const expectedActs: ExpectedActOracleInput[] = [
    {
      actId: committedCheckpoint.value.actId,
      jobId: f.session.jobId,
      askId: checkpointAsk.askId,
      publicationId: publication.publicationId,
      kind: 'checkpoint',
      authority: EXPECTED_AUTHORITY,
      source: { ...publication.source, plan: { steps: [{ id: 'step-one', hash: '1'.repeat(64) }] } },
      value: { checkpointId: 'step-one', planStepId: 'step-one', outcome: 'fail', words: checkpointWords },
    },
    {
      actId: committedSignoff.value.actId,
      jobId: f.session.jobId,
      askId: signoffAsk.askId,
      publicationId: publication.publicationId,
      kind: 'signoff',
      authority: EXPECTED_AUTHORITY,
      source: publication.source,
      value: { stage: 'plan-approved', decision: 'approved', words: signoffWords },
    },
    {
      actId: committedVerdict.value.actId,
      jobId: f.session.jobId,
      askId: verdictAsk.askId,
      publicationId: publication.publicationId,
      kind: 'review-verdict',
      authority: EXPECTED_AUTHORITY,
      source: {
        ...publication.source,
        model: publication.source.model!,
        selector: { kind: 'rig', version: 1 },
      },
      value: { stage: 'rig-review', verdict: 'changes-requested', words: rigVerdictWords },
      still: {path: rigCapture.sha256 + '.png', sha256: rigCapture.sha256, camera: 'fixed', frame: 'setup'},
    },
  ];

  // 1. Direct HTTP port call (`handleJobApi` with `verb: 'next'`)
  const rawNext = await (await f.call({ ...f.base(), verb: 'next', after: null, waitMs: 0 })).json();
  const genuineNext = assertNextVerbatimOracle(rawNext, f.session.jobId, expectedActs);

  // 2. Semantic CLI `next` path (`jobCommand`)
  const cliLines: string[] = [];
  const locator = `${f.origin}/jobs/${f.session.jobId}`;
  await jobCommand(['next', locator, '--wait-ms', '0'], {
    agentCapability: f.credentials.agent,
    write: line => cliLines.push(line),
    fetch: ((url, init) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
  });
  expect(cliLines).toHaveLength(1);
  assertNextVerbatimOracle(JSON.parse(cliLines[0]!), f.session.jobId, expectedActs);

  // 3. Incremental cursor replay on real `next`
  const actEvents = genuineNext.value.events.filter(
    (event): event is Extract<JobEvent, { readonly type: 'act' }> => event.type === 'act',
  );
  const afterFirstAct = await (
    await f.call({ ...f.base(), verb: 'next', after: actEvents[0]!.cursor, waitMs: 0 })
  ).json();
  assertNextVerbatimOracle(afterFirstAct, f.session.jobId, expectedActs.slice(1));

  expect(await jobInputHashes(f.root)).toEqual(beforeHashes);

  // 4. Named in-memory mutations of the actual captured `next` output rejected by the SAME oracle
  const mutants: NamedMutantCase[] = [
    {
      name: 'planted-mutant:checkpoint-trimmed-whitespace-and-newlines',
      targetField: 'events[checkpoint].act.value.words',
      originalWords: checkpointWords,
      mutatedWords: checkpointWords.trim().replace(/\s+/g, ' '),
      mutate(cloned) {
        const event = cloned.value.events.find(e => e.type === 'act' && e.act.kind === 'checkpoint');
        if (!event || event.type !== 'act' || event.act.kind !== 'checkpoint') throw new Error('Missing checkpoint act');
        (event.act.value as { words: string }).words = checkpointWords.trim().replace(/\s+/g, ' ');
      },
    },
    {
      name: 'planted-mutant:signoff-stripped-emoji-and-korean',
      targetField: 'events[signoff].act.value.words',
      originalWords: signoffWords,
      mutatedWords: ' [Sign-off] plan-approved passed. ',
      mutate(cloned) {
        const event = cloned.value.events.find(e => e.type === 'act' && e.act.kind === 'signoff');
        if (!event || event.type !== 'act' || event.act.kind !== 'signoff') throw new Error('Missing signoff act');
        (event.act.value as { words: string }).words = ' [Sign-off] plan-approved passed. ';
      },
    },
    {
      name: 'planted-mutant:rig-review-paraphrased-reviewer-words',
      targetField: 'events[review-verdict].act.value.words',
      originalWords: rigVerdictWords,
      mutatedWords: rigVerdictWords.replace('+3.5° 조정 필요 🛠️', '+3.5도 수정 요망'),
      mutate(cloned) {
        const event = cloned.value.events.find(e => e.type === 'act' && e.act.kind === 'review-verdict');
        if (!event || event.type !== 'act' || event.act.kind !== 'review-verdict') throw new Error('Missing review-verdict act');
        (event.act.value as { words: string }).words = rigVerdictWords.replace('+3.5° 조정 필요 🛠️', '+3.5도 수정 요망');
      },
    },
  ];

  for (const mutant of mutants) {
    assertPlantedMutantRejectedBySameOracle(genuineNext, f.session.jobId, expectedActs, mutant);
  }
});

test('real semantic next preserves verbatim issue summaries in act5 parts-verdict and rejects named in-memory mutations', async () => {
  // Parts verdicts carry spatial issues. Preserve both human summaries and the final Words value.
  const partsFixture = await fixture();
  const partsIdentity = await syntheticJobParts(partsFixture, { project: true, painting: true });
  await writeFile(join(partsFixture.root, 'out/parts.json'), JSON.stringify({
    rig_size: [30, 20],
    parts: [
      {name: 'body', x: 0, y: 0, w: 20, h: 20},
      {name: 'head', x: 10, y: 0, w: 20, h: 20},
    ],
  }));
  partsIdentity.manifest.sha256 = jobHash(await readFile(join(partsFixture.root, 'out/parts.json')));
  partsFixture.setContext({...partsFixture.getContext(), parts: partsIdentity});
  const partsBeforeHashes = await jobInputHashes(partsFixture.root);
  const partsPublication = await partsFixture.publish();
  if (partsPublication.source.subject === 'image-set') throw new Error('Expected model source binding');
  const retained = partsFixture.session.retainedSource(partsPublication.publicationId);
  const pkg = await loadPartsView(join(retained.snapshotRoot, 'out'));
  const partsAsk = await partsFixture.ask(partsPublication, { kind: 'parts-verdict', draftId: 'synthetic-draft' });
  const partsPage = await partsFixture.display(partsPublication);

  const bodyPartNote = '  [몸통/Body] 외곽선 브릿지 1px 여백 확인 필요! 🔍\n\t(좌측 겨드랑이 라인)  ';
  const bodyMeshNote = '  [메쉬/Mesh] 삼각형 분할 밀도 부족 — add 2 edge loops 🔺\n';
  const partsSummaryWords = '  부품 & 메쉬 종합 의견: body 수정 후 재검수 요청합니다. 🚀\n  ';

  const original = PNG.sync.read(await readFile(join(retained.snapshotRoot, 'out/parts/body.png')));
  const native = new PNG({width: 1, height: 1});
  original.data.copy(native.data, 0, 0, 4);
  const png = PNG.sync.write(native);
  const sha256 = jobHash(png);
  const crop = {path: `comment-crops/${sha256}.png`, sha256, width: 1, height: 1};
  const body = partsIdentity.images.find(image => image.role === 'part' && image.path === 'parts/body.png')!;
  const unpreparedIssue: PartsIssue = {
    schema: 'rig-review-parts-comment/2', id: 'body-edge', summary: bodyPartNote,
    parts: [{name: 'body', imageHash: body.sha256}], sourceHash: partsPublication.source.sourceHash,
    imageRegion: {x: 0, y: 0, width: 1, height: 1}, rigRegion: {x: 0, y: 0, width: 1, height: 1},
    view: {mode: 'item', camera: {zoom: 1, center: {x: 0.5, y: 0.5}, viewport: {width: 32, height: 32}},
      cameraSync: false, referenceCamera: null, background: 'checker', alpha: false, footprints: false, mesh: false},
    crop: {...crop, png: 'data:image/png;base64,' + png.toString('base64')}, nativeCrop: null,
  };
  const prepared = await preparePartsComment(pkg, unpreparedIssue, false, {
    sourceHash: partsPublication.source.sourceHash,
  });
  const {png: _inlinePng, ...storedCrop} = prepared.crop;
  const issue = {...prepared, crop: storedCrop};
  expect(issue.nativeCrop).not.toBeNull();
  const partsValue: JobActValues['parts-verdict'] = {
    verdict: 'changes-requested',
    issues: [issue, {...issue, id: 'body-mesh', summary: bodyMeshNote}],
    words: partsSummaryWords,
  };

  const committedParts = await partsFixture.ports.commitUIAct(
    partsFixture.session.jobId,
    partsFixture.uiRequest({
      ...partsPage,
      askId: partsAsk.askId,
      expectedGeneration: partsFixture.session.status().generation,
      submissionId: 'verbatim-parts-verdict',
      kind: 'parts-verdict',
      value: partsValue,
    }),
  );
  expect(committedParts.ok).toBe(true);
  if (!committedParts.ok) throw new Error(committedParts.error.code);

  const expectedPartsActs: ExpectedActOracleInput<'parts-verdict'>[] = [
    {
      actId: committedParts.value.actId,
      jobId: partsFixture.session.jobId,
      askId: partsAsk.askId,
      publicationId: partsPublication.publicationId,
      kind: 'parts-verdict',
      authority: EXPECTED_AUTHORITY,
      source: {
        ...partsPublication.source,
        projectHash: partsPublication.source.projectHash!,
        selector: { kind: 'draft', id: 'synthetic-draft' },
        parts: partsIdentity,
      },
      value: partsValue,
    },
  ];

  const rawPartsNext = await (
    await partsFixture.call({ ...partsFixture.base(), verb: 'next', after: null, waitMs: 0 })
  ).json();
  const genuinePartsNext = assertNextVerbatimOracle(rawPartsNext, partsFixture.session.jobId, expectedPartsActs);
  expect(await jobInputHashes(partsFixture.root)).toEqual(partsBeforeHashes);

  assertPlantedMutantRejectedBySameOracle(genuinePartsNext, partsFixture.session.jobId, expectedPartsActs, {
    name: 'planted-mutant:parts-verdict-issue-summary-rewrite',
    targetField: 'events[parts-verdict].act.value.issues[1].summary',
    originalWords: bodyMeshNote,
    mutatedWords: bodyMeshNote.trim(),
    mutate(cloned) {
      const event = cloned.value.events.find(e => e.type === 'act' && e.act.kind === 'parts-verdict');
      if (!event || event.type !== 'act' || event.act.kind !== 'parts-verdict' || event.act.schema !== JOB_PARTS_VERDICT_ACT_SCHEMA)
        throw new Error('Missing act5 parts-verdict');
      event.act.value.issues[1]!.summary = bodyMeshNote.trim();
    },
  });
});

test('real semantic next preserves verbatim nested human notes in interview-picks and rejects named in-memory mutations', async () => {
  // Part B: interview-picks on real joined project fixture with `otherText` and `note`
  const interviewFixture = await fixture();
  await joinedVerdictFixture(interviewFixture.root, '2-rigging-answers');
  const openedProject = readProject(interviewFixture.root);
  const pendingQuestion = openedProject.questions.find(q => q.editable)!;
  expect(pendingQuestion).toBeDefined();
  interviewFixture.setRecordPath('project.json');
  interviewFixture.setContext({
    ...interviewFixture.getContext(),
    plan: null,
    subjects: [
      { kind: 'interview-picks', questionId: pendingQuestion.set.question, setId: pendingQuestion.set.id },
    ],
  });
  const interviewBeforeHashes = await jobInputHashes(interviewFixture.root);
  const interviewPublication = await interviewFixture.publish();
  if (interviewPublication.source.subject === 'image-set') throw new Error('Expected model source binding');
  const interviewAsk = await interviewFixture.ask(interviewPublication, {
    kind: 'interview-picks',
    questionId: pendingQuestion.set.question,
    setId: pendingQuestion.set.id,
  });
  const interviewPage = await interviewFixture.display(interviewPublication);

  const otherTextWords =
    '  [기타/Other] 사용자 직접 입력: 소매 끝단 흔들림을 0.8x로 감쇠 (damping=0.8) 🎐\n\t줄바꿈·기호 유지!  ';
  const interviewNoteWords =
    '  인터뷰 노트: 기본 추천안 대신 커스텀 감쇠값 적용 요청 📝\n\t(second line with spaces)  ';

  const selections = pendingQuestion.set.asks.map((askItem, index) => {
    if (index === 0) {
      const otherOption = askItem.options.find(option => option.kind === 'other')!;
      return { itemId: askItem.id, optionId: otherOption.id, otherText: otherTextWords };
    }
    const recommended = askItem.options.find(option => option.kind === 'value' && option.recommended)!;
    return { itemId: askItem.id, optionId: recommended.id, otherText: null };
  });

  const interviewValue: JobActValues['interview-picks'] = {
    questionId: pendingQuestion.set.question,
    selections,
    note: interviewNoteWords,
  };

  const committedInterview = await interviewFixture.ports.commitUIAct(
    interviewFixture.session.jobId,
    interviewFixture.uiRequest({
      ...interviewPage,
      askId: interviewAsk.askId,
      expectedGeneration: interviewFixture.session.status().generation,
      submissionId: 'verbatim-interview-picks',
      kind: 'interview-picks',
      value: interviewValue,
    }),
  );
  expect(committedInterview.ok).toBe(true);
  if (!committedInterview.ok) throw new Error(committedInterview.error.code);

  const expectedInterviewActs: ExpectedActOracleInput<'interview-picks'>[] = [
    {
      actId: committedInterview.value.actId,
      jobId: interviewFixture.session.jobId,
      askId: interviewAsk.askId,
      publicationId: interviewPublication.publicationId,
      kind: 'interview-picks',
      authority: EXPECTED_AUTHORITY,
      source: {
        ...interviewPublication.source,
        projectHash: openedProject.hash,
        optionSet: { id: pendingQuestion.set.id, sha256: pendingQuestion.ref.sha256 },
      },
      value: interviewValue,
    },
  ];

  const rawInterviewNext = await (
    await interviewFixture.call({ ...interviewFixture.base(), verb: 'next', after: null, waitMs: 0 })
  ).json();
  const genuineInterviewNext = assertNextVerbatimOracle(
    rawInterviewNext,
    interviewFixture.session.jobId,
    expectedInterviewActs,
  );
  expect(await jobInputHashes(interviewFixture.root)).toEqual(interviewBeforeHashes);

  assertPlantedMutantRejectedBySameOracle(
    genuineInterviewNext,
    interviewFixture.session.jobId,
    expectedInterviewActs,
    {
      name: 'planted-mutant:interview-picks-other-text-rewrite',
      targetField: 'events[interview-picks].act.value.selections[0].otherText',
      originalWords: otherTextWords,
      mutatedWords: otherTextWords.replace('0.8x로 감쇠 (damping=0.8) 🎐', '0.8배 감쇠'),
      mutate(cloned) {
        const event = cloned.value.events.find(e => e.type === 'act' && e.act.kind === 'interview-picks');
        if (!event || event.type !== 'act' || event.act.kind !== 'interview-picks') throw new Error('Missing interview-picks');
        (event.act.value.selections[0] as { otherText: string | null }).otherText = otherTextWords.replace(
          '0.8x로 감쇠 (damping=0.8) 🎐',
          '0.8배 감쇠',
        );
      },
    },
  );
});

test('real semantic next preserves verbatim nested human notes in image-set review-verdict and rejects named in-memory mutations', async () => {
  // Part C: image-set review-verdict with per-image `imageNotes` and top-level `words`
  const imageFixture = await fixture();
  const pngBytes = await readFile(join(imageFixture.root, 'out/rigid.png'));
  const images: JobImageSetInput['images'][number][] = [
    { role: 'source', name: 'Image 0', path: 'image-0.png', sha256: jobHash(pngBytes) },
    { role: 'candidate', name: 'Image 1', path: 'image-1.png', sha256: jobHash(pngBytes) },
  ];
  for (const img of images) await writeFile(join(imageFixture.root, img.path), pngBytes);
  await writeFile(
    join(imageFixture.root, 'out/review.json'),
    JSON.stringify({
      schema: 'rig-review/1',
      id: 'image-set-fixture',
      title: 'Synthetic image set',
      revision: 'one',
      references: [],
    }),
  );
  imageFixture.setContext({
    selector: null,
    plan: null,
    parts: null,
    subjects: [],
    partIds: [],
    files: [],
    imageSet: { purpose: 'plate-adoption', images },
  });
  const imageBeforeHashes = await jobInputHashes(imageFixture.root);
  const imagePublication = await imageFixture.publish();
  if (imagePublication.source.subject !== 'image-set') throw new Error('Expected image-set source binding');
  const imageAsk = await imageFixture.ask(imagePublication, { kind: 'review-verdict', stage: 'image-review' });
  const imagePage = await imageFixture.display(imagePublication);

  const imageVerdictWords =
    '  [이미지 세트/Plate Adoption] 후보 1번 채택 보류 — 명암 대비(contrast) 보정 필요 🎨\n\t"원문 그대로 전달"  ';
  const perImageNoteWords = '  후보 1 세부 메모: 머리카락 하이라이트 경계선 정리 필요 ✨\n\t  ';
  const imageValue: JobImageReviewValue = {
    stage: 'image-review',
    verdict: 'changes-requested',
    words: imageVerdictWords,
    imageNotes: [{ name: 'Image 1', words: perImageNoteWords }],
  };

  const committedImage = await imageFixture.ports.commitUIAct(
    imageFixture.session.jobId,
    imageFixture.uiRequest({
      ...imagePage,
      askId: imageAsk.askId,
      expectedGeneration: imageFixture.session.status().generation,
      submissionId: 'verbatim-image-verdict',
      kind: 'review-verdict',
      value: imageValue,
    }),
  );
  expect(committedImage.ok).toBe(true);
  if (!committedImage.ok) throw new Error(committedImage.error.code);

  const expectedImageActs: ExpectedActOracleInput<'review-verdict'>[] = [
    {
      actId: committedImage.value.actId,
      jobId: imageFixture.session.jobId,
      askId: imageAsk.askId,
      publicationId: imagePublication.publicationId,
      kind: 'review-verdict',
      authority: EXPECTED_AUTHORITY,
      source: imagePublication.source,
      value: imageValue,
    },
  ];

  const rawImageNext = await (
    await imageFixture.call({ ...imageFixture.base(), verb: 'next', after: null, waitMs: 0 })
  ).json();
  const genuineImageNext = assertNextVerbatimOracle(rawImageNext, imageFixture.session.jobId, expectedImageActs);
  expect(await jobInputHashes(imageFixture.root)).toEqual(imageBeforeHashes);

  assertPlantedMutantRejectedBySameOracle(genuineImageNext, imageFixture.session.jobId, expectedImageActs, {
    name: 'planted-mutant:image-review-per-image-note-rewrite',
    targetField: 'events[review-verdict].act.value.imageNotes[0].words',
    originalWords: perImageNoteWords,
    mutatedWords: perImageNoteWords.trim(),
    mutate(cloned) {
      const event = cloned.value.events.find(e => e.type === 'act' && e.act.kind === 'review-verdict');
      if (!event || event.type !== 'act' || event.act.kind !== 'review-verdict') throw new Error('Missing image review-verdict');
      const value = event.act.value as JobImageReviewValue;
      (value.imageNotes![0] as { words: string }).words = perImageNoteWords.trim();
    },
  });
});
