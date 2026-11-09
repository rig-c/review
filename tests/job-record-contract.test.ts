import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { jobFixture } from './helpers/job-api-fixture.ts';
import {
  JOB_ACT_SCHEMA,
  JOB_API_SCHEMA,
  JOB_API_V3_SCHEMA,
  JOB_CAPABILITIES,
  JOB_CAPABILITIES_V3,
  JOB_PUBLICATION_MODES,
  JOB_RECORD_ACT_SCHEMA,
  JOB_RECORD_INSTANCE_SCHEMA,
  JOB_RECORD_READER_ID,
  JOB_RECORD_SOURCE_SCHEMA,
  JOB_RIG_REVIEW_ACT_SCHEMA,
  type ActV3,
  type OptionContext,
  type OptionSource,
  type PlanContext,
  type PlanSource,
  type ProjectRecord,
  type PublishRequestV3,
  type RecordAct,
  type RecordOptionResult,
  type RecordPartsIdentity,
  type RecordPlanResult,
  type SourceV3,
} from '../src/job-contract.ts';
import {
  assertEqualRecordContexts,
  assertJobApiSchema,
  buildRecordSource,
  isRecordSource,
  jobApiSchemaForMode,
  parseJobRequest,
  parseJobRequestV3,
  parseJobSubject,
  parseProjectRecord,
  parsePublishResultV3,
  parseRecordAct,
  parseRecordFreeze,
  parseRecordPublishedContext,
  parseRecordResult,
  parseRecordSource,
  parseRecordSubject,
  recordInstanceKey,
  recordSourceDigest,
  serializeRecordSourceDigestPayload,
  stripPackageResultKind,
  validateRecordAskSubject,
} from '../src/job-api.ts';

const sha = (digit: string): string => digit.repeat(64);

const recordIdentity: ProjectRecord = {
  path: 'project.json',
  sha256: sha('a'),
};

const optionSelection: RecordOptionResult = {
  kind: 'option-set',
  questionId: 'post_composition',
  setId: 'set_current_1',
};

const planSelection: RecordPlanResult = {
  kind: 'plan',
};

const optionFile = {
  path: 'evidence/interview/set_current_1.json',
  sha256: sha('b'),
} as const;

const inputFileA = {
  path: 'inputs/reference-b.png',
  sha256: sha('c'),
} as const;

const inputFileB = {
  path: 'inputs/reference-a.png',
  sha256: sha('d'),
} as const;

const closureFiles = [
  optionFile,
  inputFileB,
  inputFileA,
  recordIdentity,
] as const;

const sealedParts: RecordPartsIdentity = {
  name: '@rig-c/parts',
  version: '2.25.1',
  integrity: 'sha512-contract-parts-integrity',
};

test('CP1 schema constants and capabilities preserve API@2 defaults alongside opt-in API@3 / act@4', () => {
  expect(JOB_API_SCHEMA).toBe('rig-review/job-api@2');
  expect(JOB_ACT_SCHEMA).toBe('rig-review/act@2');
  expect(JOB_RIG_REVIEW_ACT_SCHEMA).toBe('rig-review/act@3');
  expect(JOB_API_V3_SCHEMA).toBe('rig-review/job-api@3');
  expect(JOB_RECORD_ACT_SCHEMA).toBe('rig-review/act@4');
  expect(JOB_RECORD_READER_ID).toBe('rig-create/publication-reader/2');
  expect(JOB_RECORD_SOURCE_SCHEMA).toBe('rig-review-job-record-source/1');
  expect(JOB_RECORD_INSTANCE_SCHEMA).toBe('rig-review-job-record-instance/1');
  expect(JOB_PUBLICATION_MODES).toEqual(['package-only', 'record-and-package']);
  expect(JOB_CAPABILITIES).toEqual({ imageSetVerdict: true });
  expect(JOB_CAPABILITIES_V3).toEqual({
    imageSetVerdict: true,
    recordPublication: true,
    recordActSchema: 'rig-review/act@4',
  });
  expect(jobApiSchemaForMode()).toBe(JOB_API_SCHEMA);
  expect(jobApiSchemaForMode('package-only')).toBe(JOB_API_SCHEMA);
  expect(jobApiSchemaForMode('record-and-package')).toBe(JOB_API_V3_SCHEMA);
  expect(() => assertJobApiSchema(JOB_API_SCHEMA)).not.toThrow();
  expect(() => assertJobApiSchema(JOB_API_V3_SCHEMA)).toThrow('JOB_API_SCHEMA_MISMATCH');
  expect(() => assertJobApiSchema(JOB_API_V3_SCHEMA, JOB_API_V3_SCHEMA)).not.toThrow();
  expect(() => assertJobApiSchema(JOB_API_V3_SCHEMA, 'record-and-package')).not.toThrow();
  expect(() => assertJobApiSchema(JOB_API_SCHEMA, 'record-and-package')).toThrow('JOB_API_SCHEMA_MISMATCH');
});

test('CP1 API@2 parseJobRequest default remains closed and refuses API@3 schemas or tagged results', () => {
  const v2Publish = {
    schema: JOB_API_SCHEMA,
    jobId: 'job-1',
    requestId: 'req-1',
    verb: 'publish' as const,
    expectedGeneration: 0,
    idempotencyKey: 'key-1',
    result: { path: 'out/pkg', selector: { kind: 'rig' as const, version: 1 } },
    freeze: { kind: 'producer-held' as const, holdId: 'hold-1', record: recordIdentity },
  };
  expect(parseJobRequest(v2Publish)).toEqual(v2Publish);
  expect(parseJobRequest(v2Publish, 'package-only')).toEqual(v2Publish);

  expect(() => parseJobRequest({ ...v2Publish, schema: JOB_API_V3_SCHEMA })).toThrow('JOB_API_SCHEMA_MISMATCH');
  expect(() =>
    parseJobRequest({
      ...v2Publish,
      result: { kind: 'package', path: 'out/pkg', selector: null },
    }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parseJobRequest({
      ...v2Publish,
      result: optionSelection,
    }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parseJobRequest({
      ...v2Publish,
      result: planSelection,
    }),
  ).toThrow('JOB_REQUEST_INVALID');

  // Legacy package/API@2 subject parser still permits explicit planStepId alias and arbitrary signoff stage ID.
  expect(parseJobSubject({ kind: 'checkpoint', checkpointId: 'cp-1', planStepId: 'step-1' })).toEqual({
    kind: 'checkpoint',
    checkpointId: 'cp-1',
    planStepId: 'step-1',
  });
  expect(parseJobSubject({ kind: 'signoff', stage: 'custom-legacy-stage' })).toEqual({
    kind: 'signoff',
    stage: 'custom-legacy-stage',
  });
});

test('CP1 opt-in API@3 request parser validates discriminated package and record publish requests and freeze rules', () => {
  const base = {
    schema: JOB_API_V3_SCHEMA,
    jobId: 'job-v3',
    requestId: 'req-v3',
    expectedGeneration: 2,
    idempotencyKey: 'idem-v3',
  };

  const pkgPublish: PublishRequestV3 = {
    ...base,
    verb: 'publish',
    result: { kind: 'package', path: 'out/pkg', selector: { kind: 'post', version: 2, rigVersion: 1 } },
    freeze: { kind: 'producer-held', holdId: 'hold-pkg', record: null },
  };
  expect(parseJobRequest(pkgPublish, JOB_API_V3_SCHEMA)).toEqual(pkgPublish);
  expect(parseJobRequest(pkgPublish, 'record-and-package')).toEqual(pkgPublish);
  expect(parseJobRequestV3(pkgPublish)).toEqual(pkgPublish);
  expect(stripPackageResultKind(pkgPublish.result)).toEqual({
    path: 'out/pkg',
    selector: { kind: 'post', version: 2, rigVersion: 1 },
  });

  const optionPublish: PublishRequestV3 = {
    ...base,
    verb: 'publish',
    result: optionSelection,
    freeze: { kind: 'producer-held', holdId: 'hold-opt', record: recordIdentity },
  };
  expect(parseJobRequestV3(optionPublish)).toEqual(optionPublish);

  const planPublish: PublishRequestV3 = {
    ...base,
    verb: 'publish',
    result: planSelection,
    freeze: { kind: 'producer-held', holdId: 'hold-plan', record: recordIdentity },
  };
  expect(parseJobRequestV3(planPublish)).toEqual(planPublish);

  expect(
    parseJobRequestV3({
      schema: JOB_API_V3_SCHEMA,
      jobId: 'job-v3',
      requestId: 'req-next',
      verb: 'next',
      after: null,
      waitMs: 0,
    }),
  ).toEqual({
    schema: JOB_API_V3_SCHEMA,
    jobId: 'job-v3',
    requestId: 'req-next',
    verb: 'next',
    after: null,
    waitMs: 0,
  });

  expect(
    parseJobRequestV3({
      schema: JOB_API_V3_SCHEMA,
      jobId: 'job-v3',
      requestId: 'req-fetch',
      verb: 'fetch-act',
      actId: 'act-1',
    }),
  ).toEqual({
    schema: JOB_API_V3_SCHEMA,
    jobId: 'job-v3',
    requestId: 'req-fetch',
    verb: 'fetch-act',
    actId: 'act-1',
  });

  // Schema mismatch in V3 mode
  expect(() => parseJobRequestV3({ ...planPublish, schema: JOB_API_SCHEMA })).toThrow('JOB_API_SCHEMA_MISMATCH');

  // Untagged or mixed result shapes refuse JOB_REQUEST_INVALID
  expect(() =>
    parseJobRequestV3({
      ...planPublish,
      result: { path: 'out/pkg', selector: null },
    }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parsePublishResultV3({ kind: 'plan', path: 'out/pkg' }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parsePublishResultV3({ kind: 'option-set', questionId: 'q1', setId: 's1', selector: null }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parsePublishResultV3({ kind: 'package', path: 'out/pkg' }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() => parseRecordResult({ kind: 'package', path: 'out/pkg', selector: null })).toThrow('JOB_REQUEST_INVALID');

  // Record freeze must be producer-held with non-null project.json record
  expect(() =>
    parseJobRequestV3({
      ...planPublish,
      freeze: { kind: 'producer-held', holdId: 'hold-plan', record: null },
    }),
  ).toThrow('JOB_FREEZE_REQUIRED');
  expect(() =>
    parseJobRequestV3({
      ...optionPublish,
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-opt',
        record: { path: 'other-record.json', sha256: sha('a') },
      },
    }),
  ).toThrow('JOB_FREEZE_REQUIRED');
  expect(() =>
    parseRecordFreeze({
      kind: 'none',
      holdId: 'hold-opt',
      record: recordIdentity,
    }),
  ).toThrow('JOB_FREEZE_REQUIRED');
  expect(() => parseProjectRecord({ path: 'other.json', sha256: sha('a') })).toThrow('JOB_FREEZE_REQUIRED');
});

test('CP1 parseRecordSubject enforces canonical step-ID checkpoint wire shape and three signoff stages', () => {
  expect(parseRecordSubject({ kind: 'interview-picks', questionId: 'q_1', setId: 'set_1' })).toEqual({
    kind: 'interview-picks',
    questionId: 'q_1',
    setId: 'set_1',
  });
  expect(parseRecordSubject({ kind: 'checkpoint', checkpointId: 'step_rig_1' })).toEqual({
    kind: 'checkpoint',
    checkpointId: 'step_rig_1',
  });
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview'] as const) {
    expect(parseRecordSubject({ kind: 'signoff', stage })).toEqual({ kind: 'signoff', stage });
  }

  // Rejects alias planStepId and Create writer target {stage, checkpoint} wire keys
  expect(() =>
    parseRecordSubject({ kind: 'checkpoint', checkpointId: 'step_rig_1', planStepId: 'step_rig_1' }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parseRecordSubject({ kind: 'checkpoint', stage: 'rigging-interview', checkpoint: 'step_rig_1' }),
  ).toThrow('JOB_REQUEST_INVALID');
  expect(() =>
    parseRecordSubject({ stage: 'rigging-interview', checkpoint: 'step_rig_1' }),
  ).toThrow('JOB_REQUEST_INVALID');

  // Rejects non-CP1 signoff stages, package-only subjects, and reserved act kinds
  expect(() => parseRecordSubject({ kind: 'signoff', stage: 'direction-review' })).toThrow('JOB_ASK_INVALID');
  expect(() => parseRecordSubject({ kind: 'parts-verdict', draftId: 'draft-1' })).toThrow('JOB_ASK_INVALID');
  expect(() => parseRecordSubject({ kind: 'review-verdict', stage: 'rig-review' })).toThrow('JOB_ASK_INVALID');
  expect(() => parseRecordSubject({ kind: 'mesh-edit' })).toThrow('JOB_ACT_KIND_DISABLED');
  expect(() => parseRecordSubject({ kind: 'described-correction' })).toThrow('JOB_ACT_KIND_DISABLED');
});

test('CP1 parseRecordPublishedContext requires exact six keys (including A1 parts), removes CP0 kind, and enforces closure/subject invariants', () => {
  const validOptionContext: OptionContext = {
    label: '프로젝트 인터뷰 — 한글🙂',
    parts: sealedParts,
    inputs: [inputFileA, inputFileB],
    files: closureFiles,
    plan: null,
    subjects: [{ kind: 'interview-picks', questionId: optionSelection.questionId, setId: optionSelection.setId }],
  };
  const parsedOptionContext = parseRecordPublishedContext(validOptionContext, optionSelection, recordIdentity);
  expect(parsedOptionContext).toEqual(validOptionContext);
  expect(Object.keys(parsedOptionContext)).toEqual(['label', 'parts', 'inputs', 'files', 'plan', 'subjects']);
  expect(Object.keys(parsedOptionContext.parts)).toEqual(['name', 'version', 'integrity']);

  const validPlanContext: PlanContext = {
    label: '프로젝트 플랜 — 한글🙂',
    parts: sealedParts,
    inputs: [inputFileA, inputFileB],
    files: [inputFileB, inputFileA, recordIdentity],
    plan: {
      steps: [
        { id: 'step-2', hash: sha('2') },
        { id: 'step-1', hash: sha('1') },
      ],
    },
    subjects: [
      { kind: 'checkpoint', checkpointId: 'step-1' },
      { kind: 'signoff', stage: 'plan-approved' },
    ],
  };
  expect(parseRecordPublishedContext(validPlanContext, planSelection, recordIdentity)).toEqual(validPlanContext);

  // Former five-key context without parts or malformed parts refuses JOB_SOURCE_MISMATCH
  const { parts: _omittedParts, ...fiveKeyOptionContext } = validOptionContext;
  expect(() =>
    parseRecordPublishedContext(fiveKeyOptionContext, optionSelection, recordIdentity),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      { ...validOptionContext, parts: { ...sealedParts, extra: '1' } },
      optionSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      { ...validOptionContext, parts: { ...sealedParts, integrity: '' } },
      optionSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');

  // Inspection-only plan with empty subjects is allowed
  const inspectOnlyPlan: PlanContext = {
    ...validPlanContext,
    subjects: [],
  };
  expect(parseRecordPublishedContext(inspectOnlyPlan, planSelection, recordIdentity)).toEqual(inspectOnlyPlan);

  // Equal normalized contexts pass; any difference between inventory and retained fails JOB_SOURCE_MISMATCH
  expect(() =>
    assertEqualRecordContexts(
      parseRecordPublishedContext(validPlanContext, planSelection, recordIdentity),
      parseRecordPublishedContext(structuredClone(validPlanContext), planSelection, recordIdentity),
    ),
  ).not.toThrow();
  expect(() =>
    assertEqualRecordContexts(validPlanContext, { ...validPlanContext, label: 'Changed' }),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    assertEqualRecordContexts(validPlanContext, {
      ...validPlanContext,
      parts: { ...sealedParts, version: '2.25.2' },
    }),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    assertEqualRecordContexts(validPlanContext, {
      ...validPlanContext,
      parts: { ...sealedParts, integrity: 'sha512-different-integrity' },
    }),
  ).toThrow('JOB_SOURCE_MISMATCH');

  // Old CP0 kind field on context is rejected
  expect(() =>
    parseRecordPublishedContext(
      { ...validOptionContext, kind: 'option-set' },
      optionSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');

  // Mismatched OptionContext.subjects[0] questionId/setId or non-null plan refuses JOB_SOURCE_MISMATCH
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validOptionContext,
        subjects: [{ kind: 'interview-picks', questionId: 'other_q', setId: optionSelection.setId }],
      },
      optionSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      { ...validOptionContext, plan: { steps: [{ id: 's1', hash: sha('1') }] } },
      optionSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');

  // Unsorted or duplicate closure files refuse JOB_SOURCE_MISMATCH
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validPlanContext,
        files: [recordIdentity, inputFileB, inputFileA],
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validPlanContext,
        files: [inputFileB, inputFileB, inputFileA, recordIdentity],
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');

  // Duplicate step IDs, unknown checkpoint step ID, duplicate subjects, orcheckpoint with planStepId refuse
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validPlanContext,
        plan: {
          steps: [
            { id: 'step-1', hash: sha('1') },
            { id: 'step-1', hash: sha('2') },
          ],
        },
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validPlanContext,
        subjects: [{ kind: 'checkpoint', checkpointId: 'missing-step' }],
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validPlanContext,
        subjects: [
          { kind: 'signoff', stage: 'plan-approved' },
          { kind: 'signoff', stage: 'plan-approved' },
        ],
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordPublishedContext(
      {
        ...validPlanContext,
        subjects: [{ kind: 'checkpoint', checkpointId: 'step-1', planStepId: 'step-1' } as unknown as PlanContext['subjects'][number]],
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow('JOB_SOURCE_MISMATCH');
});

test('CP1 public digest, instance key and RecordSource enforce exact key order, Unicode preservation, and hash/closure matching', () => {
  const optionContext: OptionContext = {
    label: '옵션 세트 e\u0301 vs \u00e9',
    parts: sealedParts,
    inputs: [inputFileA, inputFileB],
    files: closureFiles,
    plan: null,
    subjects: [{ kind: 'interview-picks', questionId: optionSelection.questionId, setId: optionSelection.setId }],
  };
  const optionSource: OptionSource = buildRecordSource({
    record: recordIdentity,
    selection: optionSelection,
    context: optionContext,
    optionSetFile: optionFile,
  });

  // Verify exact top-level and nested key order in serialized digest payload
  const reversedDigestInput = {
    files: closureFiles.map(f => ({ sha256: f.sha256, path: f.path })),
    subjects: [{ setId: optionSelection.setId, questionId: optionSelection.questionId, kind: 'interview-picks' as const }],
    plan: null,
    optionSetFile: { sha256: optionFile.sha256, path: optionFile.path },
    optionSet: { sha256: optionFile.sha256, id: optionSelection.setId },
    inputs: [
      { sha256: inputFileA.sha256, path: inputFileA.path },
      { sha256: inputFileB.sha256, path: inputFileB.path },
    ],
    selection: { setId: optionSelection.setId, questionId: optionSelection.questionId, kind: 'option-set' as const },
    record: { sha256: recordIdentity.sha256, path: 'project.json' as const },
  };
  const serializedOption = serializeRecordSourceDigestPayload(reversedDigestInput);
  const parsedDigestObj = JSON.parse(serializedOption);
  expect(Object.keys(parsedDigestObj)).toEqual([
    'schema',
    'record',
    'selection',
    'inputs',
    'optionSet',
    'optionSetFile',
    'plan',
    'subjects',
    'files',
  ]);
  expect(Object.keys(parsedDigestObj.record)).toEqual(['path', 'sha256']);
  expect(Object.keys(parsedDigestObj.selection)).toEqual(['kind', 'questionId', 'setId']);
  expect(Object.keys(parsedDigestObj.optionSet)).toEqual(['id', 'sha256']);
  expect(Object.keys(parsedDigestObj.optionSetFile)).toEqual(['path', 'sha256']);
  expect(Object.keys(parsedDigestObj.subjects[0])).toEqual(['kind', 'questionId', 'setId']);
  expect(Object.keys(parsedDigestObj.files[0])).toEqual(['path', 'sha256']);

  const expectedOptionHash = createHash('sha256').update(serializedOption, 'utf8').digest('hex');
  expect(recordSourceDigest(reversedDigestInput)).toBe(expectedOptionHash);
  expect(optionSource.sourceHash).toBe(expectedOptionHash);
  expect(optionSource.projectHash).toBe(recordIdentity.sha256);
  expect(isRecordSource(optionSource)).toBe(true);
  expect(parseRecordSource(optionSource)).toEqual(optionSource);

  const planContext: PlanContext = {
    label: '플랜 컨텍스트',
    parts: sealedParts,
    inputs: [inputFileA, inputFileB],
    files: [inputFileB, inputFileA, recordIdentity],
    plan: {
      steps: [
        { id: 'step_z', hash: sha('9') },
        { id: 'step_a', hash: sha('8') },
      ],
    },
    subjects: [
      { kind: 'checkpoint', checkpointId: 'step_z' },
      { kind: 'signoff', stage: 'rigging-interview' },
    ],
  };
  const planSource: PlanSource = buildRecordSource({
    record: recordIdentity,
    selection: planSelection,
    context: planContext,
  });
  const serializedPlan = serializeRecordSourceDigestPayload(planSource);
  const parsedPlanDigestObj = JSON.parse(serializedPlan);
  expect(Object.keys(parsedPlanDigestObj.selection)).toEqual(['kind']);
  expect(parsedPlanDigestObj.optionSet).toBeNull();
  expect(parsedPlanDigestObj.optionSetFile).toBeNull();
  expect(Object.keys(parsedPlanDigestObj.plan)).toEqual(['steps']);
  expect(Object.keys(parsedPlanDigestObj.plan.steps[0])).toEqual(['id', 'hash']);
  expect(Object.keys(parsedPlanDigestObj.subjects[0])).toEqual(['kind', 'checkpointId']);
  expect(Object.keys(parsedPlanDigestObj.subjects[1])).toEqual(['kind', 'stage']);
  expect(planSource.sourceHash).toBe(createHash('sha256').update(serializedPlan, 'utf8').digest('hex'));
  expect(parseRecordSource(planSource)).toEqual(planSource);

  // Unicode code units are preserved without normalization and array order affects the digest
  const nfcSelection: RecordOptionResult = { kind: 'option-set', questionId: 'q_\u00e9', setId: 'set_1' };
  const nfdSelection: RecordOptionResult = { kind: 'option-set', questionId: 'q_e\u0301', setId: 'set_1' };
  // Wait: jobId restricts to ASCII [A-Za-z0-9._-], while paths in files/inputs/optionSetFile can carry Unicode!
  expect(() => parseRecordResult(nfcSelection)).toThrow('JOB_REQUEST_INVALID');
  expect(() => parseRecordResult(nfdSelection)).toThrow('JOB_REQUEST_INVALID');

  const nfcFile = { path: 'inputs/참고_\u00e9.png', sha256: sha('e') };
  const nfdFile = { path: 'inputs/참고_e\u0301.png', sha256: sha('e') };
  const nfcDigest = recordSourceDigest({
    ...planSource,
    inputs: [nfcFile],
    files: [nfcFile, recordIdentity],
  });
  const nfdDigest = recordSourceDigest({
    ...planSource,
    inputs: [nfdFile],
    files: [nfdFile, recordIdentity],
  });
  expect(nfcDigest).not.toBe(nfdDigest);

  // Reordering inputs or plan.steps changes the digest
  const reorderedInputsDigest = recordSourceDigest({
    ...planSource,
    inputs: [inputFileB, inputFileA],
  });
  expect(reorderedInputsDigest).not.toBe(planSource.sourceHash);

  const reorderedStepsDigest = recordSourceDigest({
    ...planSource,
    plan: {
      steps: [
        { id: 'step_a', hash: sha('8') },
        { id: 'step_z', hash: sha('9') },
      ],
    },
  });
  expect(reorderedStepsDigest).not.toBe(planSource.sourceHash);

  // Instance key uses exact key order {schema, fingerprint, sourceHash} and accepts raw string fingerprints (long, Unicode, opaque, empty)
  for (const fp of [
    sha('f'),
    'fp-' + 'a'.repeat(256),
    'fp-한글-🧪-' + 'x'.repeat(200),
    'opaque\tfp\nline2\u0000 ',
    '',
  ]) {
    const expectedInstanceKey = createHash('sha256')
      .update(
        JSON.stringify({
          schema: 'rig-review-job-record-instance/1',
          fingerprint: fp,
          sourceHash: planSource.sourceHash,
        }),
        'utf8',
      )
      .digest('hex');
    expect(recordInstanceKey(fp, planSource.sourceHash)).toBe(expectedInstanceKey);
  }
  expect(() => recordInstanceKey(null, planSource.sourceHash)).toThrow('JOB_REQUEST_INVALID');
  expect(() => recordInstanceKey(123, planSource.sourceHash)).toThrow('JOB_REQUEST_INVALID');

  // Structural source mismatches refuse JOB_SOURCE_MISMATCH
  expect(() => parseRecordSource({ ...optionSource, sourceHash: sha('0') })).toThrow('JOB_SOURCE_MISMATCH');
  expect(() => parseRecordSource({ ...optionSource, projectHash: sha('0') })).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordSource({
      ...optionSource,
      optionSet: { id: 'wrong_set', sha256: optionFile.sha256 },
    }),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordSource({
      ...optionSource,
      optionSet: { id: optionSelection.setId, sha256: sha('9') },
    }),
  ).toThrow('JOB_SOURCE_MISMATCH');
  expect(() =>
    parseRecordSource({
      ...optionSource,
      package: { id: 'pkg', revision: '1' },
    }),
  ).toThrow('JOB_SOURCE_MISMATCH');

  const sourceUnionCheck: readonly SourceV3[] = [optionSource, planSource];
  expect(sourceUnionCheck).toHaveLength(2);

  // Ask validation against RecordSource
  expect(
    validateRecordAskSubject(
      { kind: 'interview-picks', questionId: optionSelection.questionId, setId: optionSelection.setId },
      optionSource,
    ),
  ).toEqual({
    kind: 'interview-picks',
    questionId: optionSelection.questionId,
    setId: optionSelection.setId,
  });
  expect(() =>
    validateRecordAskSubject({ kind: 'checkpoint', checkpointId: 'step_z' }, optionSource),
  ).toThrow('JOB_ASK_INVALID');
  expect(validateRecordAskSubject({ kind: 'checkpoint', checkpointId: 'step_z' }, planSource)).toEqual({
    kind: 'checkpoint',
    checkpointId: 'step_z',
  });
  expect(() =>
    validateRecordAskSubject({ kind: 'checkpoint', checkpointId: 'step_a' }, planSource),
  ).toThrow('JOB_ASK_INVALID');
});

test('CP1 RecordAct (rig-review/act@4) validates interview-picks, checkpoint and signoff acts and refuses malformed variants', () => {
  const optionSource = buildRecordSource({
    record: recordIdentity,
    selection: optionSelection,
    context: {
      label: 'Interview',
      parts: sealedParts,
      inputs: [inputFileA],
      files: [optionFile, inputFileA, recordIdentity],
      plan: null,
      subjects: [{ kind: 'interview-picks', questionId: optionSelection.questionId, setId: optionSelection.setId }],
    },
    optionSetFile: optionFile,
  });

  const planSource = buildRecordSource({
    record: recordIdentity,
    selection: planSelection,
    context: {
      label: 'Plan',
      parts: sealedParts,
      inputs: [inputFileA],
      files: [inputFileA, recordIdentity],
      plan: { steps: [{ id: 'step-1', hash: sha('1') }] },
      subjects: [
        { kind: 'checkpoint', checkpointId: 'step-1' },
        { kind: 'signoff', stage: 'post-interview' },
      ],
    },
  });

  const baseEnvelope = {
    schema: JOB_RECORD_ACT_SCHEMA,
    actId: 'act-record-1',
    jobId: 'job-record-1',
    askId: 'ask-record-1',
    publicationId: 'pub-record-1',
    authority: {
      actor: 'human' as const,
      channel: 'review-ui' as const,
      reviewer: { id: 'reviewer-1', role: 'owner' as const },
    },
    at: '2026-11-08T14:30:00.000Z',
  };

  const picksAct: RecordAct = {
    ...baseEnvelope,
    kind: 'interview-picks',
    source: optionSource,
    value: {
      questionId: optionSelection.questionId,
      selections: [
        { itemId: 'ask_1', optionId: 'opt_a', otherText: null },
        { itemId: 'ask_2', optionId: 'opt_other', otherText: '직접 입력한 의견 🙂' },
      ],
      note: ' \n원문 노트 그대로\t ',
    },
  };
  expect(parseRecordAct(picksAct)).toEqual(picksAct);

  for (const outcome of ['pass', 'fail'] as const) {
    const checkpointAct: RecordAct = {
      ...baseEnvelope,
      kind: 'checkpoint',
      source: planSource,
      value: {
        checkpointId: 'step-1',
        planStepId: 'step-1',
        outcome,
        words: '',
      },
    };
    expect(parseRecordAct(checkpointAct)).toEqual(checkpointAct);
  }

  const signoffAct: RecordAct = {
    ...baseEnvelope,
    kind: 'signoff',
    source: planSource,
    value: {
      stage: 'post-interview',
      decision: 'approved',
      words: '   ',
    },
  };
  expect(parseRecordAct(signoffAct)).toEqual(signoffAct);

  const actUnionCheck: readonly ActV3[] = [picksAct, signoffAct];
  expect(actUnionCheck).toHaveLength(2);

  // Rejects mismatched checkpointId !== planStepId on RecordAct
  expect(() =>
    parseRecordAct({
      ...baseEnvelope,
      kind: 'checkpoint',
      source: planSource,
      value: {
        checkpointId: 'step-1',
        planStepId: 'alias-not-allowed',
        outcome: 'pass',
        words: '',
      },
    }),
  ).toThrow('JOB_ACT_INVALID');

  // Rejects wrong schema, attached still, wrong source branch, or non-CP1 signoff stage
  expect(() => parseRecordAct({ ...signoffAct, schema: JOB_ACT_SCHEMA })).toThrow('JOB_ACT_INVALID');
  expect(() => parseRecordAct({ ...signoffAct, still: { path: 'x.png', sha256: sha('1'), camera: 'fixed', frame: 'setup' } })).toThrow(
    'JOB_ACT_INVALID',
  );
  expect(() =>
    parseRecordAct({
      ...picksAct,
      source: planSource,
    }),
  ).toThrow('JOB_ACT_INVALID');
  expect(() =>
    parseRecordAct({
      ...signoffAct,
      value: { stage: 'custom-stage', decision: 'approved', words: '' },
    }),
  ).toThrow('JOB_ACT_INVALID');

  // Bootstrap human authority accepts any non-empty reviewer.id (long, Unicode, opaque) while keeping ID domains 128 ASCII
  for (const reviewerId of [
    'reviewer-' + 'r'.repeat(200),
    '리뷰어-유니코드-🧪-' + '가'.repeat(140),
    ' opaque\treviewer\nid\u0000 ',
  ]) {
    const actWithOpaqueReviewer: RecordAct = {
      ...signoffAct,
      authority: {
        actor: 'human',
        channel: 'review-ui',
        reviewer: { id: reviewerId, role: 'delegate' },
      },
    };
    expect(parseRecordAct(actWithOpaqueReviewer)).toEqual(actWithOpaqueReviewer);
  }
  expect(() =>
    parseRecordAct({
      ...signoffAct,
      authority: {
        actor: 'human',
        channel: 'review-ui',
        reviewer: { id: '', role: 'owner' },
      },
    }),
  ).toThrow('JOB_ACT_INVALID');
  expect(() =>
    parseRecordAct({
      ...signoffAct,
      authority: {
        actor: 'human',
        channel: 'review-ui',
        reviewer: { id: 42, role: 'owner' },
      },
    }),
  ).toThrow('JOB_ACT_INVALID');
  expect(() =>
    parseRecordAct({
      ...signoffAct,
      actId: 'act-' + 'x'.repeat(125),
    }),
  ).toThrow('JOB_ACT_INVALID');
});

test('CP1 default normal host (createJobHostPorts + JobSession) refuses API@3 record publish with HTTP 400 JOB_API_SCHEMA_MISMATCH, leaving generation/head unchanged and doing no reader or snapshot work', async () => {
  let snapshotCalls = 0;
  const f = await jobFixture({
    afterSnapshot: () => {
      snapshotCalls++;
    },
  });
  try {
    expect(f.session.status().generation).toBe(0);
    expect(f.session.status().publication).toBeNull();

    const optRes = await f.call({
      schema: JOB_API_V3_SCHEMA,
      jobId: f.session.jobId,
      requestId: 'req-v3-opt',
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'idem-v3-opt',
      result: optionSelection,
      freeze: { kind: 'producer-held', holdId: 'hold-opt', record: recordIdentity },
    });
    expect(optRes.status).toBe(400);
    expect(await optRes.json()).toEqual({
      schema: JOB_API_SCHEMA,
      verb: null,
      jobId: f.session.jobId,
      requestId: null,
      generation: 0,
      ok: false,
      error: { code: 'JOB_REQUEST_INVALID', message: 'JOB_API_SCHEMA_MISMATCH' },
    });
    expect(f.session.status().generation).toBe(0);
    expect(f.session.status().publication).toBeNull();
    expect(snapshotCalls).toBe(0);
    expect(existsSync(join(f.state, 'snapshots'))).toBe(false);

    const committedPublication = await f.publish();
    expect(f.session.status().generation).toBe(1);
    expect(f.session.status().publication).toEqual(committedPublication);
    const snapshotCallsAfterPackagePublish = snapshotCalls;
    const snapshotsAfterPackagePublish = readdirSync(join(f.state, 'snapshots')).sort();

    const planRes = await f.call({
      schema: JOB_API_V3_SCHEMA,
      jobId: f.session.jobId,
      requestId: 'req-v3-plan',
      verb: 'publish',
      expectedGeneration: 1,
      idempotencyKey: 'idem-v3-plan',
      result: planSelection,
      freeze: { kind: 'producer-held', holdId: 'hold-plan', record: recordIdentity },
    });
    expect(planRes.status).toBe(400);
    expect(await planRes.json()).toEqual({
      schema: JOB_API_SCHEMA,
      verb: null,
      jobId: f.session.jobId,
      requestId: null,
      generation: 1,
      ok: false,
      error: { code: 'JOB_REQUEST_INVALID', message: 'JOB_API_SCHEMA_MISMATCH' },
    });
    expect(f.session.status().generation).toBe(1);
    expect(f.session.status().publication).toEqual(committedPublication);
    expect(snapshotCalls).toBe(snapshotCallsAfterPackagePublish);
    expect(readdirSync(join(f.state, 'snapshots')).sort()).toEqual(snapshotsAfterPackagePublish);
  } finally {
    await f.close();
  }
});

test('#586 reopen subject and rig-review/act@4 contract enforce exact keys, declared plan subjects, and API@2 isolation', () => {
  expect(parseRecordSubject({ kind: 'reopen', stage: 'plan-approved' })).toEqual({
    kind: 'reopen',
    stage: 'plan-approved',
  });
  expect(parseRecordSubject({ kind: 'reopen', stage: 'design-interview' })).toEqual({
    kind: 'reopen',
    stage: 'design-interview',
  });

  // Alias, extra keys, and malformed stage IDs refuse with JOB_REQUEST_INVALID
  for (const invalid of [
    { kind: 'reopen' },
    { kind: 'reopen', stage: '' },
    { kind: 'reopen', stage: '   ' },
    { kind: 'reopen', stage: 'plan-approved', decision: 'reopen' },
    { kind: 'reopen', stage: 'plan-approved', checkpointId: 'step_1' },
    { kind: 'reopen', stage: 'plan-approved', version: 1 },
    { kind: 'reopen', step: 'plan-approved' },
    { kind: 'reopen', checkpoint: 'plan-approved' },
  ]) {
    expect(() => parseRecordSubject(invalid)).toThrow(
      expect.objectContaining({ code: 'JOB_REQUEST_INVALID' }),
    );
  }

  // Package API@2 refuses reopen subjects while opt-in API@3 accepts them
  expect(() => parseJobSubject({ kind: 'reopen', stage: 'plan-approved' })).toThrow(
    expect.objectContaining({ code: 'JOB_ASK_INVALID' }),
  );
  expect(() =>
    parseJobRequest({
      schema: JOB_API_SCHEMA,
      jobId: 'job-1',
      requestId: 'req-ask-v2-reopen',
      verb: 'ask',
      expectedGeneration: 1,
      idempotencyKey: 'idem-ask-v2-reopen',
      publicationId: 'pub-1',
      subject: { kind: 'reopen', stage: 'plan-approved' },
    }),
  ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));

  const v3Ask = parseJobRequestV3({
    schema: JOB_API_V3_SCHEMA,
    jobId: 'job-1',
    requestId: 'req-ask-v3-reopen',
    verb: 'ask',
    expectedGeneration: 1,
    idempotencyKey: 'idem-ask-v3-reopen',
    publicationId: 'pub-1',
    subject: { kind: 'reopen', stage: 'plan-approved' },
  });
  expect(v3Ask).toEqual({
    schema: JOB_API_V3_SCHEMA,
    jobId: 'job-1',
    requestId: 'req-ask-v3-reopen',
    verb: 'ask',
    expectedGeneration: 1,
    idempotencyKey: 'idem-ask-v3-reopen',
    publicationId: 'pub-1',
    subject: { kind: 'reopen', stage: 'plan-approved' },
  });

  const baseOptionContext: OptionContext = {
    label: 'Interview',
    parts: sealedParts,
    inputs: [inputFileA],
    files: [optionFile, inputFileA, recordIdentity],
    plan: null,
    subjects: [{ kind: 'interview-picks', questionId: optionSelection.questionId, setId: optionSelection.setId }],
  };
  const baseOptionSource = buildRecordSource({
    record: recordIdentity,
    selection: optionSelection,
    context: baseOptionContext,
    optionSetFile: optionFile,
  });

  const basePlanContext: PlanContext = {
    label: 'Plan',
    parts: sealedParts,
    inputs: [inputFileA],
    files: [inputFileA, recordIdentity],
    plan: { steps: [{ id: 'step-1', hash: sha('1') }] },
    subjects: [
      { kind: 'checkpoint', checkpointId: 'step-1' },
      { kind: 'signoff', stage: 'post-interview' },
    ],
  };
  const basePlanSource = buildRecordSource({
    record: recordIdentity,
    selection: planSelection,
    context: basePlanContext,
  });

  // Plan context and source bind declared reopen subjects into sourceHash
  const reopenPlanContext = parseRecordPublishedContext(
    {
      ...basePlanContext,
      subjects: [
        ...basePlanContext.subjects,
        { kind: 'reopen', stage: 'plan-approved' },
        { kind: 'reopen', stage: 'design-interview' },
      ],
    },
    planSelection,
    recordIdentity,
  );
  const reopenPlanSource = buildRecordSource({
    record: recordIdentity,
    selection: planSelection,
    context: reopenPlanContext,
  });
  expect(reopenPlanSource.sourceHash).toBe(recordSourceDigest(reopenPlanSource));
  expect(reopenPlanSource.sourceHash).not.toBe(basePlanSource.sourceHash);

  // Duplicate reopen stage in published context refuses with JOB_SOURCE_MISMATCH
  expect(() =>
    parseRecordPublishedContext(
      {
        ...basePlanContext,
        subjects: [
          { kind: 'reopen', stage: 'plan-approved' },
          { kind: 'reopen', stage: 'plan-approved' },
        ],
      },
      planSelection,
      recordIdentity,
    ),
  ).toThrow(expect.objectContaining({ code: 'JOB_SOURCE_MISMATCH' }));

  // Option context refuses reopen subjects
  expect(() =>
    parseRecordPublishedContext(
      {
        ...baseOptionContext,
        subjects: [{ kind: 'reopen', stage: 'plan-approved' }],
      },
      optionSelection,
      recordIdentity,
    ),
  ).toThrow(expect.objectContaining({ code: 'JOB_SOURCE_MISMATCH' }));

  // validateRecordAskSubject checks declared reopen subjects on plan source only
  expect(
    validateRecordAskSubject({ kind: 'reopen', stage: 'plan-approved' }, reopenPlanSource),
  ).toEqual({ kind: 'reopen', stage: 'plan-approved' });
  expect(
    validateRecordAskSubject({ kind: 'reopen', stage: 'design-interview' }, reopenPlanSource),
  ).toEqual({ kind: 'reopen', stage: 'design-interview' });
  expect(() =>
    validateRecordAskSubject({ kind: 'reopen', stage: 'post-interview' }, reopenPlanSource),
  ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));
  expect(() =>
    validateRecordAskSubject({ kind: 'reopen', stage: 'plan-approved' }, baseOptionSource),
  ).toThrow(expect.objectContaining({ code: 'JOB_ASK_INVALID' }));

  // parseRecordAct validates reopen act@4 and preserves verbatim words including empty/whitespace
  for (const verbatimWords of ['', '   \n\t  ', '다시 열어서 실루엣 확인 필요']) {
    const reopenAct = parseRecordAct({
      schema: JOB_RECORD_ACT_SCHEMA,
      actId: 'act-reopen-1',
      jobId: 'job-1',
      askId: 'ask-reopen-1',
      publicationId: 'pub-plan-1',
      kind: 'reopen',
      authority: {
        actor: 'human',
        channel: 'review-ui',
        reviewer: { id: 'reviewer-1', role: 'owner' },
      },
      at: '2026-11-09T09:00:00.000Z',
      source: reopenPlanSource,
      value: {
        stage: 'plan-approved',
        words: verbatimWords,
      },
    });
    expect(reopenAct.value).toEqual({
      stage: 'plan-approved',
      words: verbatimWords,
    });
  }

  // Undeclared reopen stage, extra value keys, > 10_000 words, or option-set source refuse with JOB_ACT_INVALID
  for (const badAct of [
    {
      source: reopenPlanSource,
      value: { stage: 'post-interview', words: 'undeclared stage' },
    },
    {
      source: reopenPlanSource,
      value: { stage: 'plan-approved', decision: 'reopened', words: 'extra key' },
    },
    {
      source: reopenPlanSource,
      value: { stage: 'plan-approved', words: 'x'.repeat(10_001) },
    },
    {
      source: baseOptionSource,
      value: { stage: 'plan-approved', words: 'wrong source' },
    },
  ]) {
    expect(() =>
      parseRecordAct({
        schema: JOB_RECORD_ACT_SCHEMA,
        actId: 'act-reopen-bad',
        jobId: 'job-1',
        askId: 'ask-reopen-1',
        publicationId: 'pub-plan-1',
        kind: 'reopen',
        authority: {
          actor: 'human',
          channel: 'review-ui',
          reviewer: { id: 'reviewer-1', role: 'owner' },
        },
        at: '2026-11-09T09:00:00.000Z',
        source: badAct.source,
        value: badAct.value,
      }),
    ).toThrow(expect.objectContaining({ code: 'JOB_ACT_INVALID' }));
  }
});
