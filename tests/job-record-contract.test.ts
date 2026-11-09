import { createHash } from 'node:crypto';
import { existsSync, realpathSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { jobFixture } from './helpers/job-api-fixture.ts';
import { runRecordBrowserPreflightSetupCheck } from './job-record-browser.ts';
import {
  createJobWindow,
  createJobWindowTransport,
  jobCheckpointContext,
  jobWindowAccess,
  prepareJobForms,
  prepareJobInspection,
} from '../web/job-session.ts';
import * as publicJobHost from '@rig-c/review/job-host';
import {
  JOB_API_V3_SCHEMA as HOST_JOB_API_V3_SCHEMA,
  JOB_RECORD_ACT_SCHEMA as HOST_JOB_RECORD_ACT_SCHEMA,
  JOB_RECORD_READER_ID as HOST_JOB_RECORD_READER_ID,
  parseRecordAct as parseRecordActFromHost,
  prepareJobRecordAct as prepareJobRecordActFromHost,
  prepareJobRecordSource as prepareJobRecordSourceFromHost,
  startJobHost,
  type JobActV3,
  type JobFetchActRequestV3,
  type JobPlanSource,
  type JobRecordAct,
  type JobRecordHostHooks,
} from '@rig-c/review/job-host';
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

test('#588 @rig-c/review/job-host exports the record-mode constants, types and parser/preparer surface', () => {
  expect(HOST_JOB_API_V3_SCHEMA).toBe('rig-review/job-api@3');
  expect(HOST_JOB_RECORD_ACT_SCHEMA).toBe('rig-review/act@4');
  expect(HOST_JOB_RECORD_READER_ID).toBe('rig-create/publication-reader/2');
  expect(typeof parseRecordActFromHost).toBe('function');
  expect(typeof prepareJobRecordActFromHost).toBe('function');
  expect(typeof prepareJobRecordSourceFromHost).toBe('function');
  expect(publicJobHost.JOB_API_V3_SCHEMA).toBe(JOB_API_V3_SCHEMA);
  expect(publicJobHost.JOB_RECORD_ACT_SCHEMA).toBe(JOB_RECORD_ACT_SCHEMA);
  expect(publicJobHost.JOB_RECORD_READER_ID).toBe(JOB_RECORD_READER_ID);
  expect(publicJobHost.parseRecordAct).toBe(parseRecordAct);
});

// Archive-backed reader-double evidence using 2-rigging-answers.tar.gz with a local
// readRecordPublished double and synthetic parts integrity (distinct from official
// installed Create reader/consumer conformance in Create #278 and Create #317).
test('#588 archive-backed reader-double evidence: host started with readRecordPublished serves a Create project archive under job-api@3, asks and finalizes checkpoint and signoff subjects, fetches rig-review/act@4 acts via parseRecordAct, and refuses undeclared subjects by name', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-588-create-record-'));
  const root = join(scratch, 'project');
  const stateDir = join(scratch, 'state');
  await mkdir(root, { recursive: true });

  const archivePath = new URL('./fixtures/create-pre-rig/2-rigging-answers.tar.gz', import.meta.url).pathname;
  const sidecarPath = new URL('./fixtures/create-pre-rig/2-rigging-answers.json', import.meta.url).pathname;
  const archiveBytes = await readFile(archivePath);
  const extracted = Bun.spawnSync(['tar', '-xzf', '-', '-C', root], { stdin: archiveBytes });
  expect(extracted.exitCode).toBe(0);

  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
    project_sha256: string;
    files: { path: string; sha256: string }[];
  };
  const projectBytes = await readFile(join(root, 'project.json'));
  const projectSha = createHash('sha256').update(projectBytes).digest('hex');
  expect(projectSha).toBe(sidecar.project_sha256);

  const projectDoc = JSON.parse(projectBytes.toString('utf8')) as {
    name: string;
    inputs: { path: string; sha256: string }[];
    plan: { steps: { id: string; [key: string]: unknown }[] };
    signoffs: { stage: string; steps?: string[]; step_hashes?: Record<string, string> }[];
  };
  const planApprovedSignoff = projectDoc.signoffs.find(item => item.stage === 'plan-approved')!;
  const planSteps = projectDoc.plan.steps.map(step => ({
    id: step.id,
    hash:
      planApprovedSignoff.step_hashes?.[step.id] ??
      createHash('sha256').update(JSON.stringify(step)).digest('hex'),
  }));
  expect(planSteps.slice(0, 2).map(s => s.id)).toEqual(['seethrough', 'assemble']);

  const closureFiles = sidecar.files
    .filter(f => f.path === 'project.json' || f.path.startsWith('inputs/') || f.path.startsWith('evidence/'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const createInputs = projectDoc.inputs.map(({ path, sha256 }) => ({ path, sha256 }));
  const partsIdentity: RecordPartsIdentity = {
    name: '@rig-c/parts',
    version: '2.25.1',
    integrity: 'sha512-create-project-record-parts',
  };

  const readRecordPublished = (async (input: publicJobHost.JobRecordReaderInput) => {
    const currentProjectBytes = await readFile(join(input.root, input.record.path));
    const currentSha = createHash('sha256').update(currentProjectBytes).digest('hex');
    if (currentSha !== input.record.sha256) {
      throw new Error('Project record hash mismatch');
    }
    if (input.result.kind === 'option-set') {
      const optionContext: OptionContext = {
        label: `${projectDoc.name}:${input.result.questionId}`,
        parts: input.parts ?? partsIdentity,
        inputs: createInputs,
        files: closureFiles,
        plan: null,
        subjects: [
          {
            kind: 'interview-picks',
            questionId: input.result.questionId,
            setId: input.result.setId,
          },
        ],
      };
      return optionContext;
    }
    const planContext: PlanContext = {
      label: projectDoc.name,
      parts: input.parts ?? partsIdentity,
      inputs: createInputs,
      files: closureFiles,
      plan: { steps: planSteps },
      subjects: [
        { kind: 'checkpoint', checkpointId: 'seethrough' },
        { kind: 'checkpoint', checkpointId: 'assemble' },
        { kind: 'signoff', stage: 'plan-approved' },
        { kind: 'signoff', stage: 'rigging-interview' },
      ],
    };
    return planContext;
  }) as publicJobHost.JobRecordPublicationReader;

  const hooks: JobRecordHostHooks = {
    publicationMode: 'record-and-package',
    readerId: HOST_JOB_RECORD_READER_ID,
    readPublished: async () => {
      throw new Error('Unexpected package reader call on record publication');
    },
    readRecordPublished,
  };

  let consumerGrant: { jobId: string; fetchCapability: string; origin: string } | null = null;
  const host = await startJobHost({
    root,
    stateDir,
    fingerprint: 'f'.repeat(64),
    reviewer: { id: 'reviewer-create-588', role: 'owner' },
    ...hooks,
    bindingId: 'record-writer/1',
    installWriterBinding: grant => {
      consumerGrant = grant;
    },
  });

  try {
    expect(consumerGrant).not.toBeNull();
    const credentials = host.session.hostCredentials();
    let seq = 0;
    const callApi = async (body: Record<string, unknown>, token = credentials.agent, accept?: string) => {
      return host.ports.handleJobApi(
        new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(accept ? { Accept: accept } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    };

    // 1. next over job-api@3 reports record capabilities
    const nextInitialRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'next',
      after: null,
      waitMs: 0,
    });
    expect(nextInitialRes.status).toBe(200);
    const nextInitialJson = await nextInitialRes.json();
    expect(nextInitialJson).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      verb: 'next',
      jobId: host.session.jobId,
      ok: true,
      value: {
        status: 'timeout',
        capabilities: JOB_CAPABILITIES_V3,
        events: [],
      },
    });

    // 2. Publish plan record publication from the Create project over job-api@3
    const publishPlanRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'publish-create-plan-1',
      result: { kind: 'plan' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-create-plan-1',
        record: { path: 'project.json', sha256: projectSha },
      },
    });
    expect(publishPlanRes.status).toBe(200);
    const publishPlanJson = await publishPlanRes.json();
    expect(publishPlanJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
    expect(publishPlanJson.ok).toBe(true);
    const planPublication = publishPlanJson.value as publicJobHost.JobPublicationV3;
    const planSource = planPublication.source as JobPlanSource;
    expect(planSource.subject).toBe('plan');
    expect(planSource.projectHash).toBe(projectSha);
    expect(planSource.plan.steps).toEqual(planSteps);

    // 3. Undeclared subjects refuse by name (JOB_ASK_INVALID)
    for (const undeclaredSubject of [
      { kind: 'checkpoint', checkpointId: 'undeclared_step' },
      { kind: 'signoff', stage: 'post-interview' },
      { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
    ]) {
      const badAskRes = await callApi({
        schema: HOST_JOB_API_V3_SCHEMA,
        jobId: host.session.jobId,
        requestId: `req-${++seq}`,
        verb: 'ask',
        expectedGeneration: host.session.status().generation,
        idempotencyKey: `bad-ask-${seq}`,
        publicationId: planPublication.publicationId,
        subject: undeclaredSubject,
      });
      expect(badAskRes.status).toBe(409);
      const badAskJson = await badAskRes.json();
      expect(badAskJson).toMatchObject({
        schema: HOST_JOB_API_V3_SCHEMA,
        ok: false,
        error: { code: 'JOB_ASK_INVALID' },
      });
    }

    // Acknowledge display of the plan publication
    const ackPlanRes = await host.ports.ackDisplayed(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/displayed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: planPublication.publicationId,
          pageId: 'page-create-plan',
          sourceHash: planPublication.source.sourceHash,
        }),
      }),
    );
    expect(ackPlanRes.ok).toBe(true);
    if (!ackPlanRes.ok) throw new Error(ackPlanRes.error.code);
    const displayedNonce = ackPlanRes.value.displayedNonce;

    // 4. Ask a declared checkpoint subject, verify undeclared/mismatched act value refuses JOB_ACT_INVALID, then finalize and fetch over job-api@3
    const askCheckpointRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'ask-checkpoint-seethrough',
      publicationId: planPublication.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'seethrough' },
    });
    expect(askCheckpointRes.status).toBe(200);
    const askCheckpointJson = await askCheckpointRes.json();
    expect(askCheckpointJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
    expect(askCheckpointJson.ok).toBe(true);
    const checkpointAsk = askCheckpointJson.value as publicJobHost.JobPendingAskV3;

    const badCheckpointActRes = await host.ports.commitUIAct(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: planPublication.publicationId,
          askId: checkpointAsk.askId,
          pageId: 'page-create-plan',
          displayedNonce,
          expectedGeneration: host.session.status().generation,
          submissionId: 'sub-bad-checkpoint',
          kind: 'checkpoint',
          value: {
            checkpointId: 'undeclared_step',
            outcome: 'pass',
            words: 'Mismatched checkpoint ID',
          },
        }),
      }),
    );
    expect(badCheckpointActRes).toEqual({
      ok: false,
      error: { code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID' },
    });

    const commitCheckpointRes = await host.ports.commitUIAct(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: planPublication.publicationId,
          askId: checkpointAsk.askId,
          pageId: 'page-create-plan',
          displayedNonce,
          expectedGeneration: host.session.status().generation,
          submissionId: 'sub-checkpoint-seethrough',
          kind: 'checkpoint',
          value: {
            checkpointId: 'seethrough',
            outcome: 'pass',
            words: 'Seethrough checkpoint verified.',
          },
        }),
      }),
    );
    expect(commitCheckpointRes.ok).toBe(true);
    if (!commitCheckpointRes.ok) throw new Error(commitCheckpointRes.error.code);
    const finalizedCheckpointAct = commitCheckpointRes.value as unknown as JobRecordAct;
    expect(finalizedCheckpointAct.schema).toBe(HOST_JOB_RECORD_ACT_SCHEMA);

    const fetchCheckpointReq: JobFetchActRequestV3 = {
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'fetch-act',
      actId: finalizedCheckpointAct.actId,
    };
    const fetchCheckpointRes = await callApi(fetchCheckpointReq, consumerGrant!.fetchCapability);
    expect(fetchCheckpointRes.status).toBe(200);
    const fetchCheckpointJson = await fetchCheckpointRes.json();
    expect(fetchCheckpointJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
    expect(fetchCheckpointJson.ok).toBe(true);
    const parsedCheckpointAct: JobActV3 = parseRecordActFromHost(fetchCheckpointJson.value);
    expect(parsedCheckpointAct).toEqual(finalizedCheckpointAct);
    expect(parsedCheckpointAct.kind).toBe('checkpoint');
    if (parsedCheckpointAct.kind === 'checkpoint') {
      expect(parsedCheckpointAct.value).toEqual({
        checkpointId: 'seethrough',
        planStepId: 'seethrough',
        outcome: 'pass',
        words: 'Seethrough checkpoint verified.',
      });
    }

    // Raw act export succeeds while PNG still export refuses JOB_STILL_UNAVAILABLE
    const rawCheckpointRes = await callApi(
      fetchCheckpointReq,
      consumerGrant!.fetchCapability,
      'application/vnd.rig-review.act+json',
    );
    expect(rawCheckpointRes.status).toBe(200);
    expect(parseRecordActFromHost(JSON.parse(await rawCheckpointRes.text()))).toEqual(finalizedCheckpointAct);

    const pngCheckpointRes = await callApi(fetchCheckpointReq, consumerGrant!.fetchCapability, 'image/png');
    expect(pngCheckpointRes.status).toBe(409);
    expect(await pngCheckpointRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_STILL_UNAVAILABLE' },
    });

    // Undeclared subject inside a forged RecordAct also refuses JOB_ACT_INVALID via exported parseRecordAct
    expect(() =>
      parseRecordActFromHost({
        ...finalizedCheckpointAct,
        value: {
          checkpointId: 'undeclared_step',
          planStepId: 'undeclared_step',
          outcome: 'pass',
          words: '',
        },
      }),
    ).toThrow('JOB_ACT_INVALID');

    // 5. Ask a declared signoff subject, verify undeclared stage refuses JOB_ACT_INVALID, then finalize and fetch over job-api@3
    const askSignoffRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'ask-signoff-rigging-interview',
      publicationId: planPublication.publicationId,
      subject: { kind: 'signoff', stage: 'rigging-interview' },
    });
    expect(askSignoffRes.status).toBe(200);
    const askSignoffJson = await askSignoffRes.json();
    expect(askSignoffJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
    expect(askSignoffJson.ok).toBe(true);
    const signoffAsk = askSignoffJson.value as publicJobHost.JobPendingAskV3;

    const badSignoffActRes = await host.ports.commitUIAct(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: planPublication.publicationId,
          askId: signoffAsk.askId,
          pageId: 'page-create-plan',
          displayedNonce,
          expectedGeneration: host.session.status().generation,
          submissionId: 'sub-bad-signoff',
          kind: 'signoff',
          value: {
            stage: 'post-interview',
            decision: 'approved',
            words: 'Undeclared stage',
          },
        }),
      }),
    );
    expect(badSignoffActRes).toEqual({
      ok: false,
      error: { code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID' },
    });

    const commitSignoffRes = await host.ports.commitUIAct(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: planPublication.publicationId,
          askId: signoffAsk.askId,
          pageId: 'page-create-plan',
          displayedNonce,
          expectedGeneration: host.session.status().generation,
          submissionId: 'sub-signoff-rigging-interview',
          kind: 'signoff',
          value: {
            stage: 'rigging-interview',
            decision: 'approved',
            words: 'Approve rigging-interview plan.\n',
          },
        }),
      }),
    );
    expect(commitSignoffRes.ok).toBe(true);
    if (!commitSignoffRes.ok) throw new Error(commitSignoffRes.error.code);
    const finalizedSignoffAct = commitSignoffRes.value as unknown as JobRecordAct;
    expect(finalizedSignoffAct.schema).toBe(HOST_JOB_RECORD_ACT_SCHEMA);

    const fetchSignoffReq: JobFetchActRequestV3 = {
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'fetch-act',
      actId: finalizedSignoffAct.actId,
    };
    const fetchSignoffRes = await callApi(fetchSignoffReq, consumerGrant!.fetchCapability);
    expect(fetchSignoffRes.status).toBe(200);
    const fetchSignoffJson = await fetchSignoffRes.json();
    expect(fetchSignoffJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
    expect(fetchSignoffJson.ok).toBe(true);
    const parsedSignoffAct = parseRecordActFromHost(fetchSignoffJson.value);
    expect(parsedSignoffAct).toEqual(finalizedSignoffAct);
    expect(parsedSignoffAct.kind).toBe('signoff');
    if (parsedSignoffAct.kind === 'signoff') {
      expect(parsedSignoffAct.value).toEqual({
        stage: 'rigging-interview',
        decision: 'approved',
        words: 'Approve rigging-interview plan.\n',
      });
    }

    // 6. Publish option-set record publication from the same Create project and finalize interview-picks
    const publishOptionRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'publish-create-option-bones',
      result: { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-create-option-bones',
        record: { path: 'project.json', sha256: projectSha },
      },
    });
    expect(publishOptionRes.status).toBe(200);
    const publishOptionJson = await publishOptionRes.json();
    expect(publishOptionJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
    expect(publishOptionJson.ok).toBe(true);
    const optionPublication = publishOptionJson.value as publicJobHost.JobPublicationV3;
    expect(optionPublication.source.subject).toBe('option-set');

    const ackOptionRes = await host.ports.ackDisplayed(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/displayed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: optionPublication.publicationId,
          pageId: 'page-create-option',
          sourceHash: optionPublication.source.sourceHash,
        }),
      }),
    );
    expect(ackOptionRes.ok).toBe(true);
    if (!ackOptionRes.ok) throw new Error(ackOptionRes.error.code);

    const askOptionRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'ask-option-bones',
      publicationId: optionPublication.publicationId,
      subject: { kind: 'interview-picks', questionId: 'bones', setId: 'chain-bones' },
    });
    expect(askOptionRes.status).toBe(200);
    const optionAsk = (await askOptionRes.json()).value as publicJobHost.JobPendingAskV3;

    const commitOptionRes = await host.ports.commitUIAct(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: optionPublication.publicationId,
          askId: optionAsk.askId,
          pageId: 'page-create-option',
          displayedNonce: ackOptionRes.value.displayedNonce,
          expectedGeneration: host.session.status().generation,
          submissionId: 'sub-option-bones',
          kind: 'interview-picks',
          value: {
            questionId: 'bones',
            selections: [
              { itemId: 'chains', optionId: 'keep', otherText: null },
              { itemId: 'placement', optionId: 'keep', otherText: null },
              { itemId: 'length', optionId: 'keep', otherText: null },
            ],
            note: 'Keep synthetic bones options.',
          },
        }),
      }),
    );
    expect(commitOptionRes.ok).toBe(true);
    if (!commitOptionRes.ok) throw new Error(commitOptionRes.error.code);
    const finalizedOptionAct = commitOptionRes.value as unknown as JobRecordAct;
    const fetchOptionRes = await callApi(
      {
        schema: HOST_JOB_API_V3_SCHEMA,
        jobId: host.session.jobId,
        requestId: `req-${++seq}`,
        verb: 'fetch-act',
        actId: finalizedOptionAct.actId,
      },
      consumerGrant!.fetchCapability,
    );
    expect(fetchOptionRes.status).toBe(200);
    const parsedOptionAct = parseRecordActFromHost((await fetchOptionRes.json()).value);
    expect(parsedOptionAct).toEqual(finalizedOptionAct);
    expect(parsedOptionAct.kind).toBe('interview-picks');

    // 7. Close over job-api@3 succeeds and revokes consumer fetch
    const closeRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'close',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'close-create-record-job',
      reason: 'completed record review',
    });
    expect(closeRes.status).toBe(200);
    expect(await closeRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      verb: 'close',
      ok: true,
      value: { status: 'closed' },
    });

    const postCloseFetchRes = await callApi(fetchSignoffReq, consumerGrant!.fetchCapability);
    expect(postCloseFetchRes.status).toBe(409);
    expect(await postCloseFetchRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_CLOSED' },
    });
  } finally {
    host.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('#588 record host compatibility: cold start hook pairing, ordinary reuse, and strict reuseOnly prevent silent mode or reader substitution while preserving the 10-field reuse binding', async () => {
  const f = await jobFixture();
  try {
    const base: publicJobHost.JobHostOptions = {
      root: f.root,
      stateDir: f.state,
      fingerprint: 'f'.repeat(64),
      reviewer: { id: 'declared-owner', role: 'owner' },
    };
    const dummyRecordReader = (async () => {
      throw new Error('unused');
    }) as unknown as publicJobHost.JobRecordPublicationReader;

    // 1. Invalid or unpaired record hook options refuse JOB_HOST_OPTION_ID_INVALID on cold start
    for (const invalid of [
      { readRecordPublished: dummyRecordReader },
      { recordReaderId: HOST_JOB_RECORD_READER_ID },
      { readRecordPublished: dummyRecordReader, recordReaderId: '' },
      { publicationMode: 'record-and-package' as const },
      { publicationMode: 'package-only' as const, readRecordPublished: dummyRecordReader, recordReaderId: HOST_JOB_RECORD_READER_ID },
      { publicationMode: 'invalid-mode' as unknown as publicJobHost.JobPublicationMode },
    ]) {
      await expect(startJobHost({ ...base, ...invalid })).rejects.toMatchObject({
        code: 'JOB_HOST_OPTION_ID_INVALID',
        option: 'readPublished',
      });
    }

    // 2. Package-only listener refuses ordinary reuse and strict reuseOnly from record-mode callers
    const pkgOptions: publicJobHost.JobHostOptions = {
      ...base,
      readPublished: async () => f.getContext(),
      readerId: 'pkg-reader/1',
    };
    const pkgHost = await startJobHost(pkgOptions);
    try {
      expect(pkgHost.reused).toBe(false);
      expect(pkgHost.attachment).not.toBeNull();
      expect(Object.keys(pkgHost.attachment!.binding)).toEqual([
        'root', 'stateDir', 'fingerprint', 'reviewer',
        'readerId', 'bindingId', 'partsEnumeratorId', 'partsEnumeratorVersion',
        'apiSchema', 'actSchema',
      ]);

      // Descriptor for package-only host keeps exact legacy keys without publicationMode/recordReaderId
      const hostDescRes = await fetch(`${pkgHost.origin}/jobs/${pkgHost.session.jobId}/host`, {
        headers: { 'X-Review-Capability': pkgHost.session.hostCredentials().ui },
      });
      expect(hostDescRes.status).toBe(200);
      const pkgDesc = await hostDescRes.json();
      expect(pkgDesc).not.toHaveProperty('publicationMode');
      expect(pkgDesc).not.toHaveProperty('recordReaderId');

      const recordCallerOptions: publicJobHost.JobHostOptions = {
        ...base,
        publicationMode: 'record-and-package',
        readPublished: async () => f.getContext(),
        readRecordPublished: dummyRecordReader,
        readerId: 'pkg-reader/1',
      };
      await expect(startJobHost(recordCallerOptions)).rejects.toMatchObject({
        code: 'JOB_HOST_REUSE_MISMATCH',
        option: 'readPublished',
      });
      await expect(
        startJobHost({ ...recordCallerOptions, reuseOnly: { expected: pkgHost.attachment! } }),
      ).rejects.toMatchObject({
        code: 'JOB_HOST_REUSE_MISMATCH',
        field: 'readerId',
      });
    } finally {
      pkgHost.stop();
    }

    // 3. Stopped package-only host can restart in record-and-package mode; record listener enforces mode & reader ID on reuse and reuseOnly
    const recordOptions: publicJobHost.JobHostOptions = {
      ...base,
      publicationMode: 'record-and-package',
      readPublished: async () => f.getContext(),
      readRecordPublished: dummyRecordReader,
      readerId: HOST_JOB_RECORD_READER_ID,
    };
    const recordHost = await startJobHost(recordOptions);
    try {
      expect(recordHost.reused).toBe(false);
      expect(recordHost.attachment).not.toBeNull();
      expect(Object.keys(recordHost.attachment!.binding)).toEqual([
        'root', 'stateDir', 'fingerprint', 'reviewer',
        'readerId', 'bindingId', 'partsEnumeratorId', 'partsEnumeratorVersion',
        'apiSchema', 'actSchema',
      ]);
      expect(recordHost.attachment!.binding.readerId).toBe(HOST_JOB_RECORD_READER_ID);

      // Package-only caller cannot silently reuse the record-mode listener (even with same readerId string)
      const pkgSameIdCaller: publicJobHost.JobHostOptions = {
        ...base,
        readPublished: async () => f.getContext(),
        readerId: HOST_JOB_RECORD_READER_ID,
      };
      await expect(startJobHost(pkgSameIdCaller)).rejects.toMatchObject({
        code: 'JOB_HOST_REUSE_MISMATCH',
        option: 'readPublished',
      });
      await expect(
        startJobHost({ ...pkgSameIdCaller, reuseOnly: { expected: recordHost.attachment! } }),
      ).rejects.toMatchObject({
        code: 'JOB_HOST_REUSE_MISMATCH',
        field: 'readerId',
      });

      // Record caller with a different recordReaderId or missing readPublished refuses reuse
      for (const mismatch of [
        {
          ...base,
          publicationMode: 'record-and-package' as const,
          readPublished: async () => f.getContext(),
          readRecordPublished: dummyRecordReader,
          readerId: 'other-record-reader/2',
        },
        {
          ...base,
          publicationMode: 'record-and-package' as const,
          readRecordPublished: dummyRecordReader,
          recordReaderId: HOST_JOB_RECORD_READER_ID,
        },
      ]) {
        await expect(startJobHost(mismatch)).rejects.toMatchObject({
          code: 'JOB_HOST_REUSE_MISMATCH',
          option: 'readPublished',
        });
        await expect(
          startJobHost({ ...mismatch, reuseOnly: { expected: recordHost.attachment! } }),
        ).rejects.toMatchObject({
          code: 'JOB_HOST_REUSE_MISMATCH',
          field: 'readerId',
        });
      }

      // Matching record-mode caller succeeds in both ordinary reuse and strict reuseOnly
      const reusedRecord = await startJobHost(recordOptions);
      try {
        expect(reusedRecord.reused).toBe(true);
        expect(reusedRecord.ownerUrl).toBe(recordHost.ownerUrl);
        expect(reusedRecord.attachment).toEqual(recordHost.attachment);
      } finally {
        reusedRecord.stop();
      }

      const attachedRecord = await startJobHost({
        ...recordOptions,
        reuseOnly: { expected: recordHost.attachment! },
      });
      try {
        expect(attachedRecord.reused).toBe(true);
        expect(attachedRecord.attachment).toEqual(recordHost.attachment);
        const nextRes = await attachedRecord.ports.handleJobApi(
          new Request(`${attachedRecord.origin}/jobs/${attachedRecord.session.jobId}/api`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${recordHost.session.hostCredentials().agent}`,
            },
            body: JSON.stringify({
              schema: HOST_JOB_API_V3_SCHEMA,
              jobId: attachedRecord.session.jobId,
              requestId: 'req-attached-next',
              verb: 'next',
              after: null,
              waitMs: 0,
            }),
          }),
        );
        expect(nextRes.status).toBe(200);
        expect(await nextRes.json()).toMatchObject({
          schema: HOST_JOB_API_V3_SCHEMA,
          ok: true,
          value: { capabilities: JOB_CAPABILITIES_V3 },
        });
      } finally {
        attachedRecord.stop();
      }
    } finally {
      recordHost.stop();
    }
  } finally {
    await f.close();
  }
});

test('#588 record-move and freshness boundaries: publish, ask, and commitUIAct report JOB_RECORD_MOVED when project.json moves during reader phases or before synchronous store commit', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-588-move-boundary-'));
  const root = join(scratch, 'project');
  const stateDir = join(scratch, 'state');
  await mkdir(join(root, 'inputs'), { recursive: true });

  const originalProject = '{"schema":"rig-create/project@0","plan":{"steps":[{"id":"step-1"}]}}\n';
  const inputBytes = 'reference-image-bytes\n';
  await writeFile(join(root, 'project.json'), originalProject);
  await writeFile(join(root, 'inputs/ref.png'), inputBytes);

  const hashBytes = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
  const initialProjectSha = hashBytes(originalProject);
  const inputSha = hashBytes(inputBytes);

  let mode: 'normal' | 'move-on-retained-throw-generic' | 'move-after-retained-read' = 'normal';
  let afterSnapshotHook: (() => Promise<void>) | undefined;

  const readRecordPublished = (async (input: publicJobHost.JobRecordReaderInput) => {
    if (input.phase === 'retained' && mode === 'move-on-retained-throw-generic') {
      await writeFile(join(root, 'project.json'), '{"schema":"rig-create/project@0","plan":{"steps":[{"id":"step-1"}]},"moved":"during-retained"}\n');
      throw new Error('Untagged reader parse error after concurrent project.json write');
    }
    const planContext: PlanContext = {
      label: 'Move boundary plan',
      parts: sealedParts,
      inputs: [{ path: 'inputs/ref.png', sha256: inputSha }],
      files: [
        { path: 'inputs/ref.png', sha256: inputSha },
        { path: 'project.json', sha256: input.record.sha256 },
      ],
      plan: { steps: [{ id: 'step-1', hash: sha('1') }] },
      subjects: [
        { kind: 'checkpoint', checkpointId: 'step-1' },
        { kind: 'signoff', stage: 'plan-approved' },
      ],
    };
    if (input.phase === 'retained' && mode === 'move-after-retained-read') {
      await writeFile(join(root, 'project.json'), '{"schema":"rig-create/project@0","plan":{"steps":[{"id":"step-1"}]},"moved":"after-retained-read"}\n');
    }
    return planContext;
  }) as publicJobHost.JobRecordPublicationReader;

  const host = await startJobHost({
    root,
    stateDir,
    fingerprint: 'e'.repeat(64),
    reviewer: { id: 'reviewer-move-boundary', role: 'owner' },
    publicationMode: 'record-and-package',
    readerId: HOST_JOB_RECORD_READER_ID,
    readRecordPublished,
    afterSnapshot: async () => {
      await afterSnapshotHook?.();
    },
  });

  try {
    const credentials = host.session.hostCredentials();
    let seq = 0;
    const callApi = async (body: Record<string, unknown>) =>
      host.ports.handleJobApi(
        new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credentials.agent}`,
          },
          body: JSON.stringify(body),
        }),
      );

    // 1. Move during retained phase + untagged reader error must report JOB_RECORD_MOVED (never flattened to JOB_RECORD_INCOMPLETE)
    mode = 'move-on-retained-throw-generic';
    const moveRetainedRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'publish-move-retained',
      result: { kind: 'plan' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-1',
        record: { path: 'project.json', sha256: initialProjectSha },
      },
    });
    expect(moveRetainedRes.status).toBe(409);
    expect(await moveRetainedRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_RECORD_MOVED' },
    });
    expect(host.session.status().generation).toBe(0);

    // Restore project.json and test move in afterSnapshot (right before synchronous store.update commit)
    await writeFile(join(root, 'project.json'), originalProject);
    mode = 'normal';
    afterSnapshotHook = async () => {
      await writeFile(join(root, 'project.json'), '{"schema":"rig-create/project@1","step":"moved-before-store-commit"}\n');
    };
    const moveBeforeCommitRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'publish-move-before-commit',
      result: { kind: 'plan' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-1',
        record: { path: 'project.json', sha256: initialProjectSha },
      },
    });
    expect(moveBeforeCommitRes.status).toBe(409);
    expect(await moveBeforeCommitRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_RECORD_MOVED' },
    });
    expect(host.session.status().generation).toBe(0);

    // 2. Restore project.json and publish cleanly
    await writeFile(join(root, 'project.json'), originalProject);
    afterSnapshotHook = undefined;
    const cleanPublishRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'publish-clean',
      result: { kind: 'plan' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-1',
        record: { path: 'project.json', sha256: initialProjectSha },
      },
    });
    expect(cleanPublishRes.status).toBe(200);
    const publication = (await cleanPublishRes.json()).value as publicJobHost.JobPublicationV3;
    expect(host.session.status().generation).toBe(1);

    // 3. During ask, if project.json moves right after retained reader returns, ask refuses JOB_RECORD_MOVED without advancing generation
    mode = 'move-after-retained-read';
    const moveAskRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: 1,
      idempotencyKey: 'ask-move-after-retained',
      publicationId: publication.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'step-1' },
    });
    expect(moveAskRes.status).toBe(409);
    expect(await moveAskRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_RECORD_MOVED' },
    });
    expect(host.session.status().generation).toBe(1);
    expect(host.session.status().pending).toHaveLength(0);

    // 4. Restore project.json, ask cleanly, acknowledge display, then move project.json during commitUIAct retained check
    await writeFile(join(root, 'project.json'), originalProject);
    mode = 'normal';
    const cleanAskRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: 1,
      idempotencyKey: 'ask-clean',
      publicationId: publication.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'step-1' },
    });
    expect(cleanAskRes.status).toBe(200);
    const ask = (await cleanAskRes.json()).value as publicJobHost.JobPendingAskV3;
    expect(host.session.status().generation).toBe(2);

    const ackRes = await host.ports.ackDisplayed(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/displayed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: publication.publicationId,
          pageId: 'page-move-boundary',
          sourceHash: publication.source.sourceHash,
        }),
      }),
    );
    expect(ackRes.ok).toBe(true);
    if (!ackRes.ok) throw new Error(ackRes.error.code);

    mode = 'move-after-retained-read';
    const moveActRes = await host.ports.commitUIAct(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: publication.publicationId,
          askId: ask.askId,
          pageId: 'page-move-boundary',
          displayedNonce: ackRes.value.displayedNonce,
          expectedGeneration: 2,
          submissionId: 'sub-move-after-retained',
          kind: 'checkpoint',
          value: { checkpointId: 'step-1', outcome: 'pass', words: 'Should refuse' },
        }),
      }),
    );
    expect(moveActRes).toEqual({
      ok: false,
      error: { code: 'JOB_RECORD_MOVED', message: 'JOB_RECORD_MOVED' },
    });
    expect(host.session.status().generation).toBe(2);
    expect(host.session.status().pending[0]?.status).toBe('pending');
  } finally {
    host.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('#588 normal owner URL model-free record inspection: retainedPublicationRoutes and prepareJobInspection prepare option-set and plan record publications without fabricated package/model metadata and finalize act@4 through createJobWindow', async () => {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-588-owner-window-'));
  const root = join(scratch, 'project');
  const stateDir = join(scratch, 'state');
  await mkdir(root, { recursive: true });

  const archivePath = new URL('./fixtures/create-pre-rig/2-rigging-answers.tar.gz', import.meta.url).pathname;
  const sidecarPath = new URL('./fixtures/create-pre-rig/2-rigging-answers.json', import.meta.url).pathname;
  const archiveBytes = await readFile(archivePath);
  const extracted = Bun.spawnSync(['tar', '-xzf', '-', '-C', root], { stdin: archiveBytes });
  expect(extracted.exitCode).toBe(0);

  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
    project_sha256: string;
    files: { path: string; sha256: string }[];
  };
  const projectBytes = await readFile(join(root, 'project.json'));
  const projectSha = createHash('sha256').update(projectBytes).digest('hex');
  const projectDoc = JSON.parse(projectBytes.toString('utf8')) as {
    name: string;
    inputs: { path: string; sha256: string }[];
    plan: { steps: { id: string; [key: string]: unknown }[] };
    signoffs: { stage: string; steps?: string[]; step_hashes?: Record<string, string> }[];
  };
  const planApprovedSignoff = projectDoc.signoffs.find(item => item.stage === 'plan-approved')!;
  const planSteps = projectDoc.plan.steps.map(step => ({
    id: step.id,
    hash:
      planApprovedSignoff.step_hashes?.[step.id] ??
      createHash('sha256').update(JSON.stringify(step)).digest('hex'),
  }));
  const closureFiles = sidecar.files
    .filter(f => f.path === 'project.json' || f.path.startsWith('inputs/') || f.path.startsWith('evidence/'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const createInputs = projectDoc.inputs.map(({ path, sha256 }) => ({ path, sha256 }));
  const partsIdentity: RecordPartsIdentity = {
    name: '@rig-c/parts',
    version: '2.25.1',
    integrity: 'sha512-create-project-record-parts',
  };

  const readRecordPublished = (async (input: publicJobHost.JobRecordReaderInput) => {
    if (input.result.kind === 'option-set') {
      return {
        label: `${projectDoc.name}:${input.result.questionId}`,
        parts: input.parts ?? partsIdentity,
        inputs: createInputs,
        files: closureFiles,
        plan: null,
        subjects: [
          {
            kind: 'interview-picks',
            questionId: input.result.questionId,
            setId: input.result.setId,
          },
        ],
      } satisfies OptionContext;
    }
    return {
      label: projectDoc.name,
      parts: input.parts ?? partsIdentity,
      inputs: createInputs,
      files: closureFiles,
      plan: { steps: planSteps },
      subjects: [
        { kind: 'checkpoint', checkpointId: 'seethrough' },
        { kind: 'signoff', stage: 'rigging-interview' },
      ],
    } satisfies PlanContext;
  }) as publicJobHost.JobRecordPublicationReader;

  let consumerGrant: { jobId: string; fetchCapability: string; origin: string } | null = null;
  const host = await startJobHost({
    root,
    stateDir,
    fingerprint: 'd'.repeat(64),
    reviewer: { id: 'reviewer-owner-window', role: 'owner' },
    publicationMode: 'record-and-package',
    readerId: HOST_JOB_RECORD_READER_ID,
    readRecordPublished,
    bindingId: 'record-writer/1',
    installWriterBinding: grant => {
      consumerGrant = grant;
    },
  });

  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'location', {
      value: new URL(host.ownerUrl),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: () => ({ id: '' }) },
      configurable: true,
      writable: true,
    });

    const credentials = host.session.hostCredentials();
    let seq = 0;
    const callApi = async (body: Record<string, unknown>, token = credentials.agent) =>
      host.ports.handleJobApi(
        new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }),
      );

    // 1. Publish plan record and ask checkpoint + signoff
    const pubPlanRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: 0,
      idempotencyKey: 'window-publish-plan',
      result: { kind: 'plan' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-window-plan',
        record: { path: 'project.json', sha256: projectSha },
      },
    });
    const planPublication = (await pubPlanRes.json()).value as publicJobHost.JobPublicationV3;

    const askCpRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'window-ask-cp',
      publicationId: planPublication.publicationId,
      subject: { kind: 'checkpoint', checkpointId: 'seethrough' },
    });
    const cpAsk = (await askCpRes.json()).value as publicJobHost.JobPendingAskV3;

    const askSignoffRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'window-ask-signoff',
      publicationId: planPublication.publicationId,
      subject: { kind: 'signoff', stage: 'rigging-interview' },
    });
    const signoffAsk = (await askSignoffRes.json()).value as publicJobHost.JobPendingAskV3;

    // 2. Drive normal owner URL access -> transport -> createJobWindow -> prepareJobInspection -> prepareJobForms -> submit
    const slots = new Map<string, string>();
    const access = jobWindowAccess(
      host.ownerUrl,
      {
        getItem: key => slots.get(key) ?? null,
        setItem: (key, val) => {
          slots.set(key, val);
        },
      },
      () => {},
    );
    expect(access.capability).toBe(credentials.ui);

    const ownerFetcher: typeof fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' || input instanceof URL ? new URL(input, host.origin).href : input.url;
        const headers = new Headers(init?.headers);
        if (!headers.has('Origin') && init?.method === 'POST') {
          headers.set('Origin', host.origin);
        }
        return fetch(url, { ...init, headers });
      },
      { preconnect: fetch.preconnect },
    );
    const transport = createJobWindowTransport(access, ownerFetcher);

    // Direct check of the retainedPublicationRoutes api/review response: no fabricated manifest or package
    const displayResult = await transport.readPublication(planPublication.publicationId);
    expect(displayResult.ok).toBe(true);
    if (!displayResult.ok) throw new Error(displayResult.error.code);
    const reviewRouteRes = await fetch(`${host.origin}${displayResult.value.routes.apiBase}review`);
    expect(reviewRouteRes.status).toBe(200);
    const reviewMetadata = await reviewRouteRes.json();
    expect(reviewMetadata.manifest).toBeUndefined();
    expect(reviewMetadata.reviewedSource).toBeUndefined();
    expect(reviewMetadata.recordSource).toEqual(planPublication.source);
    expect(reviewMetadata.capabilities).toEqual({
      playback: false,
      interview: false,
      preRig: false,
      modeling: false,
      motion: false,
      feedback: true,
      audio: false,
    });
    expect(reviewMetadata.feedbackCatalog).toEqual({ slots: null });

    type PreparedWindowView = {
      inspection: Awaited<ReturnType<typeof prepareJobInspection>>;
      forms: Map<string, { askId: string; kind: string }>;
    };
    let preparedPlanInspection: Awaited<ReturnType<typeof prepareJobInspection>> | null = null;
    let preparedPlanForms: Map<string, { askId: string; kind: string }> | null = null;
    const pendingPlanAsks: readonly publicJobHost.JobPendingAskV3[] = [cpAsk, signoffAsk];
    const window = createJobWindow<PreparedWindowView>({
      jobId: host.session.jobId,
      pageId: 'owner-window-page-1',
      transport,
      adapter: {
        async prepare(display, signal): Promise<PreparedWindowView> {
          const inspection = await prepareJobInspection(display, signal);
          const forms = prepareJobForms(display, pendingPlanAsks, ask => {
            if (ask.subject.kind === 'checkpoint') {
              const cp = jobCheckpointContext(ask, inspection.metadata.manifest?.checkpoints ?? []);
              expect(cp.step.id).toBe('seethrough');
            }
            return { askId: ask.askId, kind: ask.subject.kind };
          });
          return { inspection, forms };
        },
        captureDraft: () => null,
        commit(prepared) {
          preparedPlanInspection = prepared.inspection;
          preparedPlanForms = prepared.forms;
          return {
            rollback() {},
            finalize() {},
          };
        },
        async painted() {},
        discard(prepared) {
          prepared.inspection.dispose();
        },
        changed() {},
      },
    });

    window.event({
      type: 'published',
      jobId: host.session.jobId,
      generation: planPublication.generation,
      cursor: 'c-1',
      publication: planPublication,
    });
    window.event({
      type: 'pending',
      jobId: host.session.jobId,
      generation: 2,
      cursor: 'c-2',
      ask: cpAsk,
    });
    window.event({
      type: 'pending',
      jobId: host.session.jobId,
      generation: 3,
      cursor: 'c-3',
      ask: signoffAsk,
    });
    await window.settled();

    expect(window.state().error).toBeNull();
    expect(window.state().receipt?.publicationId).toBe(planPublication.publicationId);
    expect(preparedPlanInspection).not.toBeNull();
    const committedPlanInspection = preparedPlanInspection!;
    const committedPlanForms = preparedPlanForms!;
    expect(committedPlanInspection.player).toBeNull();
    expect(committedPlanInspection.assets).toBeNull();
    expect(committedPlanInspection.metadata.manifest).toBeUndefined();
    expect(committedPlanInspection.metadata.recordSource).toEqual(
      planPublication.source as publicJobHost.JobRecordSource,
    );
    expect(committedPlanForms.size).toBe(2);

    const receipt = window.state().receipt!;
    const submitCp = await window.submit({
      publicationId: planPublication.publicationId,
      askId: cpAsk.askId,
      pageId: 'owner-window-page-1',
      displayedNonce: receipt.displayedNonce,
      expectedGeneration: window.state().generation,
      submissionId: 'owner-window-cp-1',
      kind: 'checkpoint',
      value: { checkpointId: 'seethrough', outcome: 'pass', words: 'Checked via owner window' },
    });
    expect(submitCp.ok).toBe(true);
    if (!submitCp.ok) throw new Error(submitCp.error.code);
    expect(submitCp.value.schema).toBe(HOST_JOB_RECORD_ACT_SCHEMA);

    const submitSignoff = await window.submit({
      publicationId: planPublication.publicationId,
      askId: signoffAsk.askId,
      pageId: 'owner-window-page-1',
      displayedNonce: receipt.displayedNonce,
      expectedGeneration: window.state().generation,
      submissionId: 'owner-window-signoff-1',
      kind: 'signoff',
      value: { stage: 'rigging-interview', decision: 'approved', words: 'Approved via owner window' },
    });
    expect(submitSignoff.ok).toBe(true);
    if (!submitSignoff.ok) throw new Error(submitSignoff.error.code);
    expect(submitSignoff.value.schema).toBe(HOST_JOB_RECORD_ACT_SCHEMA);

    // 3. Publish option-set record and verify prepareJobInspection loads retained interview questions
    const pubOptRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-${++seq}`,
      verb: 'publish',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'window-publish-opt',
      result: { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-window-opt',
        record: { path: 'project.json', sha256: projectSha },
      },
    });
    const optPublication = (await pubOptRes.json()).value as publicJobHost.JobPublicationV3;
    const optDisplayRes = await transport.readPublication(optPublication.publicationId);
    expect(optDisplayRes.ok).toBe(true);
    if (!optDisplayRes.ok) throw new Error(optDisplayRes.error.code);
    const optInspection = await prepareJobInspection(optDisplayRes.value, new AbortController().signal);
    expect(optInspection.metadata.manifest).toBeUndefined();
    expect(optInspection.metadata.recordSource).toEqual(
      optPublication.source as publicJobHost.JobRecordSource,
    );
    expect(optInspection.interview?.questions.map(q => q.set.id)).toEqual(['chain-bones']);
    optInspection.dispose();

    // 4. Explicit MODEL_UNAVAILABLE on a package publication still refuses before preparation
    window.event({
      type: 'published',
      jobId: host.session.jobId,
      generation: host.session.status().generation + 1,
      cursor: 'c-unavailable',
      publication: {
        publicationId: 'unavailable-pkg-pub',
        generation: host.session.status().generation + 1,
        previousPublicationId: null,
        label: 'Unavailable package model',
        instanceKey: sha('9'),
        visual: { status: 'unavailable', code: 'MODEL_UNAVAILABLE' },
        source: {
          sourceHash: sha('a'),
          projectHash: sha('b'),
          package: { id: 'pkg-id', revision: 'rev-1' },
          selector: { kind: 'rig', version: 1 },
          model: null,
          direction: null,
          optionSet: null,
          appliedResult: null,
          plan: null,
          parts: null,
        },
      },
    });
    await window.settled();
    expect(window.state().error).toBe('MODEL_UNAVAILABLE');
    window.stop();
  } finally {
    if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    host.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('#588 browser packet preflight: shared archive reader fixture passes non-browser publish/ask setup check with duplicate-free closureFiles', async () => {
  await runRecordBrowserPreflightSetupCheck();
});

test('#586 live host and session reopen lifecycle: package-only host refuses reopen ask/act, record-and-package host enforces declared stage, display receipt, and source currentness, and finalizes/fetches rig-review/act@4 {stage, words} with verbatim words via parseRecordAct', async () => {
  // Part A: package-only default session/host rejects reopen ask (JOB_ASK_INVALID) and reopen UI act (JOB_ACT_INVALID)
  const pkgFixture = await jobFixture();
  try {
    const pkgPub = await pkgFixture.publish();

    const badPkgAskRes = await pkgFixture.call({
      ...pkgFixture.base(),
      verb: 'ask',
      expectedGeneration: pkgFixture.session.status().generation,
      idempotencyKey: 'idem-pkg-reopen-ask',
      publicationId: pkgPub.publicationId,
      subject: { kind: 'reopen', stage: 'plan-approved' },
    });
    expect(badPkgAskRes.status).toBe(409);
    expect(await badPkgAskRes.json()).toMatchObject({
      schema: JOB_API_SCHEMA,
      ok: false,
      error: { code: 'JOB_ASK_INVALID' },
    });

    const pkgReceipt = await pkgFixture.display(pkgPub);
    const validPkgAsk = await pkgFixture.ask(pkgPub, { kind: 'signoff', stage: 'plan-approved' });

    const badPkgAct = await pkgFixture.ports.commitUIAct(
      pkgFixture.session.jobId,
      pkgFixture.uiRequest({
        publicationId: pkgPub.publicationId,
        askId: validPkgAsk.askId,
        pageId: pkgReceipt.pageId,
        displayedNonce: pkgReceipt.displayedNonce,
        expectedGeneration: pkgFixture.session.status().generation,
        submissionId: 'sub-pkg-reopen-rejected',
        kind: 'reopen',
        value: { stage: 'plan-approved', words: 'rejected on package-only session' },
      }),
    );
    expect(badPkgAct).toEqual({
      ok: false,
      error: { code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID' },
    });
  } finally {
    await pkgFixture.close();
  }

  // Part B: record-and-package host lifecycle for reopen ask, refusals, freshness, and verbatim act@4 fetch
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-586-live-host-'));
  const root = join(scratch, 'project');
  const stateDir = join(scratch, 'state');
  await mkdir(root, { recursive: true });

  const archivePath = new URL('./fixtures/create-pre-rig/2-rigging-answers.tar.gz', import.meta.url).pathname;
  const sidecarPath = new URL('./fixtures/create-pre-rig/2-rigging-answers.json', import.meta.url).pathname;
  const archiveBytes = await readFile(archivePath);
  const extracted = Bun.spawnSync(['tar', '-xzf', '-', '-C', root], { stdin: archiveBytes });
  expect(extracted.exitCode).toBe(0);

  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
    project_sha256: string;
    files: { path: string; sha256: string }[];
  };
  const originalProjectBytes = await readFile(join(root, 'project.json'));
  const projectSha = createHash('sha256').update(originalProjectBytes).digest('hex');
  expect(projectSha).toBe(sidecar.project_sha256);

  const projectDoc = JSON.parse(originalProjectBytes.toString('utf8')) as {
    name: string;
    inputs: { path: string; sha256: string }[];
    plan: { steps: { id: string; [key: string]: unknown }[] };
    signoffs: { stage: string; steps?: string[]; step_hashes?: Record<string, string> }[];
  };
  const planApprovedSignoff = projectDoc.signoffs.find(item => item.stage === 'plan-approved')!;
  const planSteps = projectDoc.plan.steps.map(step => ({
    id: step.id,
    hash:
      planApprovedSignoff.step_hashes?.[step.id] ??
      createHash('sha256').update(JSON.stringify(step)).digest('hex'),
  }));
  const closureFiles = sidecar.files
    .filter(f => f.path === 'project.json' || f.path.startsWith('inputs/') || f.path.startsWith('evidence/'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const createInputs = projectDoc.inputs.map(({ path, sha256 }) => ({ path, sha256 }));
  const partsIdentity: RecordPartsIdentity = {
    name: '@rig-c/parts',
    version: '2.25.1',
    integrity: 'sha512-create-project-record-parts-586',
  };

  let tamperContextOnFinalize = false;
  const readRecordPublished = (async (input: publicJobHost.JobRecordReaderInput) => {
    const currentProjectBytes = await readFile(join(input.root, input.record.path));
    const currentSha = createHash('sha256').update(currentProjectBytes).digest('hex');
    if (currentSha !== input.record.sha256) {
      throw new Error('Project record hash mismatch');
    }
    if (input.result.kind === 'option-set') {
      const optionContext: OptionContext = {
        label: `${projectDoc.name}:${input.result.questionId}`,
        parts: input.parts ?? partsIdentity,
        inputs: createInputs,
        files: closureFiles,
        plan: null,
        subjects: [
          {
            kind: 'interview-picks',
            questionId: input.result.questionId,
            setId: input.result.setId,
          },
        ],
      };
      return optionContext;
    }
    const planContext: PlanContext = {
      label: tamperContextOnFinalize ? `${projectDoc.name}-drifted` : projectDoc.name,
      parts: input.parts ?? partsIdentity,
      inputs: createInputs,
      files: closureFiles,
      plan: { steps: planSteps },
      subjects: [
        { kind: 'checkpoint', checkpointId: 'seethrough' },
        { kind: 'signoff', stage: 'plan-approved' },
        { kind: 'reopen', stage: 'plan-approved' },
        { kind: 'reopen', stage: 'design-interview' },
      ],
    };
    return planContext;
  }) as publicJobHost.JobRecordPublicationReader;

  let consumerGrant: { jobId: string; fetchCapability: string; origin: string } | null = null;
  const host = await startJobHost({
    root,
    stateDir,
    fingerprint: 'e'.repeat(64),
    reviewer: { id: 'reviewer-live-586', role: 'owner' },
    publicationMode: 'record-and-package',
    readerId: HOST_JOB_RECORD_READER_ID,
    readPublished: async () => {
      throw new Error('Unexpected package reader call on record publication');
    },
    readRecordPublished,
    bindingId: 'record-writer-586/1',
    installWriterBinding: grant => {
      consumerGrant = grant;
    },
  });

  try {
    expect(consumerGrant).not.toBeNull();
    const credentials = host.session.hostCredentials();
    let seq = 0;
    const callApi = async (body: Record<string, unknown>, token = credentials.agent, accept?: string) =>
      host.ports.handleJobApi(
        new Request(`${host.origin}/jobs/${host.session.jobId}/api`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(accept ? { Accept: accept } : {}),
          },
          body: JSON.stringify(body),
        }),
      );

    // 1. Publish option-set and verify reopen ask is refused on option-set (JOB_ASK_INVALID)
    const pubOptRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-586-${++seq}`,
      verb: 'publish',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'pub-opt-586',
      result: { kind: 'option-set', questionId: 'bones', setId: 'chain-bones' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-opt-586',
        record: { path: 'project.json', sha256: projectSha },
      },
    });
    expect(pubOptRes.status).toBe(200);
    const optPub = ((await pubOptRes.json()) as { value: publicJobHost.JobPublicationV3 }).value;

    const badOptReopenAsk = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-586-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'ask-opt-reopen-586',
      publicationId: optPub.publicationId,
      subject: { kind: 'reopen', stage: 'plan-approved' },
    });
    expect(badOptReopenAsk.status).toBe(409);
    expect(await badOptReopenAsk.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_ASK_INVALID' },
    });

    // 2. Publish plan with declared reopen stages ['plan-approved', 'design-interview']
    const pubPlanRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-586-${++seq}`,
      verb: 'publish',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'pub-plan-586',
      result: { kind: 'plan' },
      freeze: {
        kind: 'producer-held',
        holdId: 'hold-plan-586',
        record: { path: 'project.json', sha256: projectSha },
      },
    });
    expect(pubPlanRes.status).toBe(200);
    const planPub = ((await pubPlanRes.json()) as { value: publicJobHost.JobPublicationV3 }).value;
    const planSource = planPub.source as JobPlanSource;
    expect(planSource.subjects).toContainEqual({ kind: 'reopen', stage: 'plan-approved' });
    expect(planSource.subjects).toContainEqual({ kind: 'reopen', stage: 'design-interview' });

    // 3. Undeclared reopen stage refuses with JOB_ASK_INVALID
    const undeclaredAskRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-586-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'ask-undeclared-reopen-586',
      publicationId: planPub.publicationId,
      subject: { kind: 'reopen', stage: 'post-interview' },
    });
    expect(undeclaredAskRes.status).toBe(409);
    expect(await undeclaredAskRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_ASK_INVALID' },
    });

    // 4. Moving project.json before ask refuses with JOB_RECORD_MOVED, then restoring allows ask
    await writeFile(join(root, 'project.json'), Buffer.concat([originalProjectBytes, Buffer.from('\n')]));
    const movedAskRes = await callApi({
      schema: HOST_JOB_API_V3_SCHEMA,
      jobId: host.session.jobId,
      requestId: `req-586-${++seq}`,
      verb: 'ask',
      expectedGeneration: host.session.status().generation,
      idempotencyKey: 'ask-moved-reopen-586',
      publicationId: planPub.publicationId,
      subject: { kind: 'reopen', stage: 'plan-approved' },
    });
    expect(movedAskRes.status).toBe(409);
    expect(await movedAskRes.json()).toMatchObject({
      schema: HOST_JOB_API_V3_SCHEMA,
      ok: false,
      error: { code: 'JOB_RECORD_MOVED' },
    });
    await writeFile(join(root, 'project.json'), originalProjectBytes);

    // 5. Acknowledge display of plan publication
    const ackRes = await host.ports.ackDisplayed(
      host.session.jobId,
      new Request(`${host.origin}/jobs/${host.session.jobId}/ui/displayed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: host.origin,
          'X-Review-Capability': credentials.ui,
        },
        body: JSON.stringify({
          publicationId: planPub.publicationId,
          pageId: 'page-plan-586',
          sourceHash: planPub.source.sourceHash,
        }),
      }),
    );
    expect(ackRes.ok).toBe(true);
    if (!ackRes.ok) throw new Error(ackRes.error.code);
    const displayedNonce = ackRes.value.displayedNonce;

    // 6. Verify display receipt and source currentness enforcement on finalize, plus verbatim words (empty, whitespace, non-empty)
    const verbatimCases = [
      { stage: 'plan-approved', words: '' },
      { stage: 'design-interview', words: '  \n\t  ' },
      { stage: 'plan-approved', words: 'Reopen plan-approved from live host\nsecond line' },
    ] as const;

    for (let idx = 0; idx < verbatimCases.length; idx++) {
      const item = verbatimCases[idx]!;
      const askRes = await callApi({
        schema: HOST_JOB_API_V3_SCHEMA,
        jobId: host.session.jobId,
        requestId: `req-586-${++seq}`,
        verb: 'ask',
        expectedGeneration: host.session.status().generation,
        idempotencyKey: `ask-reopen-live-${idx}`,
        publicationId: planPub.publicationId,
        subject: { kind: 'reopen', stage: item.stage },
      });
      expect(askRes.status).toBe(200);
      const ask = ((await askRes.json()) as { value: publicJobHost.JobPendingAskV3 }).value;
      expect(ask.subject).toEqual({ kind: 'reopen', stage: item.stage });

      if (idx === 0) {
        // Wrong displayedNonce refuses with JOB_DISPLAY_MISMATCH
        const badNonceRes = await host.ports.commitUIAct(
          host.session.jobId,
          new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: host.origin,
              'X-Review-Capability': credentials.ui,
            },
            body: JSON.stringify({
              publicationId: planPub.publicationId,
              askId: ask.askId,
              pageId: 'page-plan-586',
              displayedNonce: '0'.repeat(64),
              expectedGeneration: host.session.status().generation,
              submissionId: 'sub-reopen-bad-nonce',
              kind: 'reopen',
              value: { stage: item.stage, words: item.words },
            }),
          }),
        );
        expect(badNonceRes).toEqual({
          ok: false,
          error: { code: 'JOB_DISPLAY_MISMATCH', message: 'JOB_DISPLAY_MISMATCH' },
        });

        // Mismatched stage or extra key in UI submission refuses with JOB_ACT_INVALID
        for (const badValue of [
          { stage: 'design-interview', words: 'wrong stage for this ask' },
          { stage: item.stage, decision: 'reopened', words: 'extra key' },
        ]) {
          const badValueRes = await host.ports.commitUIAct(
            host.session.jobId,
            new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Origin: host.origin,
                'X-Review-Capability': credentials.ui,
              },
              body: JSON.stringify({
                publicationId: planPub.publicationId,
                askId: ask.askId,
                pageId: 'page-plan-586',
                displayedNonce,
                expectedGeneration: host.session.status().generation,
                submissionId: `sub-reopen-bad-val-${ JSON.stringify(badValue).length }`,
                kind: 'reopen',
                value: badValue,
              }),
            }),
          );
          expect(badValueRes).toEqual({
            ok: false,
            error: { code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID' },
          });
        }

        // Moving project.json or reader drift before finalize refuses with JOB_RECORD_MOVED / JOB_ACT_SOURCE_STALE
        await writeFile(join(root, 'project.json'), Buffer.concat([originalProjectBytes, Buffer.from('\n')]));
        const movedCommitRes = await host.ports.commitUIAct(
          host.session.jobId,
          new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: host.origin,
              'X-Review-Capability': credentials.ui,
            },
            body: JSON.stringify({
              publicationId: planPub.publicationId,
              askId: ask.askId,
              pageId: 'page-plan-586',
              displayedNonce,
              expectedGeneration: host.session.status().generation,
              submissionId: 'sub-reopen-moved',
              kind: 'reopen',
              value: { stage: item.stage, words: item.words },
            }),
          }),
        );
        expect(movedCommitRes.ok).toBe(false);
        if (!movedCommitRes.ok) {
          expect(movedCommitRes.error.code).toBe('JOB_RECORD_MOVED');
        }
        await writeFile(join(root, 'project.json'), originalProjectBytes);

        tamperContextOnFinalize = true;
        const staleCommitRes = await host.ports.commitUIAct(
          host.session.jobId,
          new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: host.origin,
              'X-Review-Capability': credentials.ui,
            },
            body: JSON.stringify({
              publicationId: planPub.publicationId,
              askId: ask.askId,
              pageId: 'page-plan-586',
              displayedNonce,
              expectedGeneration: host.session.status().generation,
              submissionId: 'sub-reopen-stale',
              kind: 'reopen',
              value: { stage: item.stage, words: item.words },
            }),
          }),
        );
        expect(staleCommitRes.ok).toBe(false);
        if (!staleCommitRes.ok) {
          expect(staleCommitRes.error.code).toBe('JOB_ACT_SOURCE_STALE');
        }
        tamperContextOnFinalize = false;
      }

      // Finalize valid reopen act and fetch via consumer grant (both JSON envelope and raw application/vnd.rig-review.act+json)
      const commitRes = await host.ports.commitUIAct(
        host.session.jobId,
        new Request(`${host.origin}/jobs/${host.session.jobId}/ui/acts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: host.origin,
            'X-Review-Capability': credentials.ui,
          },
          body: JSON.stringify({
            publicationId: planPub.publicationId,
            askId: ask.askId,
            pageId: 'page-plan-586',
            displayedNonce,
            expectedGeneration: host.session.status().generation,
            submissionId: `sub-reopen-valid-${idx}`,
            kind: 'reopen',
            value: { stage: item.stage, words: item.words },
          }),
        }),
      );
      expect(commitRes.ok).toBe(true);
      if (!commitRes.ok) throw new Error(commitRes.error.code);
      const finalized = parseRecordActFromHost(commitRes.value);
      expect(finalized.schema).toBe(HOST_JOB_RECORD_ACT_SCHEMA);
      expect(finalized.kind).toBe('reopen');
      expect(finalized.authority).toEqual({
        actor: 'human',
        channel: 'review-ui',
        reviewer: { id: 'reviewer-live-586', role: 'owner' },
      });
      expect(finalized.source).toEqual(planSource);
      expect(finalized.value).toEqual({ stage: item.stage, words: item.words });
      expect(Object.keys(finalized.value).sort()).toEqual(['stage', 'words']);

      const fetchEnvelopeRes = await callApi(
        {
          schema: HOST_JOB_API_V3_SCHEMA,
          jobId: host.session.jobId,
          requestId: `req-586-${++seq}`,
          verb: 'fetch-act',
          actId: finalized.actId,
        },
        consumerGrant!.fetchCapability,
      );
      expect(fetchEnvelopeRes.status).toBe(200);
      const fetchEnvelopeJson = await fetchEnvelopeRes.json();
      expect(fetchEnvelopeJson.schema).toBe(HOST_JOB_API_V3_SCHEMA);
      expect(fetchEnvelopeJson.ok).toBe(true);
      expect(parseRecordActFromHost(fetchEnvelopeJson.value)).toEqual(finalized);

      const fetchRawRes = await callApi(
        {
          schema: HOST_JOB_API_V3_SCHEMA,
          jobId: host.session.jobId,
          requestId: `req-586-${++seq}`,
          verb: 'fetch-act',
          actId: finalized.actId,
        },
        consumerGrant!.fetchCapability,
        'application/vnd.rig-review.act+json',
      );
      expect(fetchRawRes.status).toBe(200);
      expect(fetchRawRes.headers.get('content-type')).toContain('application/vnd.rig-review.act+json');
      expect(parseRecordActFromHost(await fetchRawRes.json())).toEqual(finalized);
    }
  } finally {
    host.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
