import {checkpointEvidenceFields, planPictureFields} from './job-checkpoint-evidence.ts';
import {previousDraftFields} from './job-previous-draft.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  JOB_ACT_SCHEMA, JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_ENABLED_ACT_KINDS, JOB_PARTS_ENUMERATOR_RANGE,
  JOB_PLAN_BOUND_SIGNOFF_STAGES, JOB_RECORD_SIGNOFF_STAGES, JOB_RECORD_ACT_SCHEMA, JOB_RECORD_INSTANCE_SCHEMA, JOB_RECORD_SOURCE_SCHEMA,
  JOB_RESERVED_ACT_KINDS,
  JOB_MESH_EDITS_ACT_SCHEMA, JOB_CHEST_LANDMARKS_ACT_SCHEMA,
  type AgentRequestV3, type FetchActRequestV3, type JobAgentRequest, type JobApiSchema,
  type JobCheckpointEvidence, type JobDisplayAcknowledgment, type JobErrorCode, type JobFetchActRequest, type JobFileIdentity,
  type JobHostPorts, type JobHumanAuthority, type JobInterviewDiagnostic, type JobInterviewDiagnostics, type JobProgressRequestV3,
  type JobInterviewJson, type JobInterviewRecord, type JobPlanIdentity, type JobPublicationMode,
  type JobAct, type JobMeshEdit, type JobMeshEditsAct, type JobMeshEditValue,
  type JobChestLandmarkEdit, type JobChestLandmarksAct, type JobChestLandmarkValue, type JobPublishedChestLandmark,
  type JobPublishRequest, type JobResult, type JobSelector, type JobSha256, type JobSourceBinding, type JobSubject,
  type OptionContext, type OptionSource, type PlanContext, type PlanSource, type ProjectRecord,
  type PublishRequestV3, type PublishResultV3, type RecordAct, type RecordFreeze,
  type RecordOptionResult, type RecordOptionSetBinding, type RecordOptionSetRef, type RecordPartsIdentity, type RecordPicksSubject, type RecordPlanResult, type RecordPlanSubject,
  type RecordResult, type RecordSignoffStage, type RecordSource, type RecordSubject,
  jobCaptureBodyLimit, jobRawActMediaType,
} from './job-contract.ts';
import { JobError } from './job-store.ts';
import type { JobSession } from './job-session.ts';
import { JOB_COMMENTS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, type JobCommentContext, type JobContextComment,
  type JobContextCommentsAct, type JobComment, type JobCommentAnchor, type JobCommentsAct,
  type SourceV3, type JobRigStill } from './job-contract.ts';
import { parseFeedback } from './session.ts';
import { parsePartsIssue } from './parts-comment.ts';
import { parseStageComment, hasStageComment, projectComments, commentModes } from './stage-comment.ts';
import { validatePngCrop, validatePngCropMetadata } from './comment-crops.ts';
import {parseJobPartsIdentity} from './job-source.ts';
import {parseControlPart, parseControlView} from './control.ts';
import {canonicalJson} from './canonical-json.ts';
import {MESH_EDIT_MAX_OPS, type Vec} from './mesh-edit.ts';
import {parseBustSpec} from './chest-landmarks.ts';

export type {
  JobInterviewJson,
  JobInterviewRecord,
  JobInterviewDiagnostic,
  JobInterviewDiagnostics,
} from './job-contract.ts';

export const jobBodyLimit = 256 * 1024;
export const jobWaitLimitMs = 30_000;
/** Subjects one `ask-batch` request may list (#963). */
export const jobAskBatchLimit = 64;
const jobProgressBodyLimit = 1024;
const requestDeadlineMs = 10_000;

export function jobHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Private replay digest. Preserve the original serializer for persisted request identity. */
export function requestDigest(value: unknown): string {
  return jobHash(canonicalJson(value));
}

export function sameCapability(given: string | null, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function jobObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw new JobError('JOB_REQUEST_INVALID');
  return value as Record<string, unknown>;
}

export function jobText(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  return value;
}

export function jobId(value: unknown): string {
  const id = jobText(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new JobError('JOB_REQUEST_INVALID');
  return id;
}

export function jobInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  return value;
}

export function jobSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new JobError('JOB_REQUEST_INVALID');
  return value;
}

export function jobPath(value: unknown): string {
  const path = jobText(value, 4096);
  if (path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:%?#]/.test(path)) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  return path;
}

export function parseJobSelector(value: unknown): JobSelector | null {
  if (value === null) return null;
  const item = jobObject(value, ['kind', 'id', 'version', 'rigVersion']);
  if (item.kind === 'draft') {
    jobObject(item, ['kind', 'id']);
    return { kind: 'draft', id: jobId(item.id) };
  }
  if (item.kind === 'rig') {
    jobObject(item, ['kind', 'version']);
    const version = jobInteger(item.version);
    if (!version) throw new JobError('JOB_REQUEST_INVALID');
    return { kind: 'rig', version };
  }
  if (item.kind === 'post') {
    jobObject(item, ['kind', 'version', 'rigVersion']);
    const version = jobInteger(item.version), rigVersion = jobInteger(item.rigVersion);
    if (!version || !rigVersion) throw new JobError('JOB_REQUEST_INVALID');
    return { kind: 'post', version, rigVersion };
  }
  throw new JobError('JOB_REQUEST_INVALID');
}

export function parseJobSubject(value: unknown): JobSubject {
  const item = jobObject(value, ['kind', 'questionId', 'setId', 'checkpointId', 'planStepId', 'draftId', 'stage']);
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ACT_KIND_DISABLED');
  if (!(JOB_ENABLED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ASK_INVALID');
  switch (item.kind) {
    case 'interview-picks':
      jobObject(item, ['kind', 'questionId', 'setId']);
      return { kind: item.kind, questionId: jobId(item.questionId), setId: jobId(item.setId) };
    case 'checkpoint':
      jobObject(item, ['kind', 'checkpointId', 'planStepId']);
      return {
        kind: item.kind, checkpointId: jobId(item.checkpointId),
        ...(item.planStepId === undefined ? {} : { planStepId: jobId(item.planStepId) }),
      };
    case 'parts-verdict':
      jobObject(item, ['kind', 'draftId']);
      return { kind: item.kind, draftId: jobId(item.draftId) };
    case 'review-verdict':
      jobObject(item, ['kind', 'stage']);
      if (item.stage !== 'rig-review' && item.stage !== 'direction-review' && item.stage !== 'image-review') throw new JobError('JOB_ASK_INVALID');
      return { kind: item.kind, stage: item.stage };
    case 'signoff':
      jobObject(item, ['kind', 'stage']);
      return { kind: item.kind, stage: jobId(item.stage) };
  }
  throw new JobError('JOB_ASK_INVALID');
}

/** Preserve the installed version while enforcing the jointly accepted range. */
export function jobPartsEnumeratorVersion(value: unknown): string {
  const bounded = typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[\x00-\x20\x7f]/.test(value);
  if (!bounded || !Bun.semver.satisfies(value, JOB_PARTS_ENUMERATOR_RANGE)) {
    const received = bounded ? JSON.stringify(value) : '<missing-or-invalid>';
    throw new JobError('JOB_SOURCE_UNRETAINABLE',
      `PARTS_ENUMERATOR_VERSION_MISMATCH range="${JOB_PARTS_ENUMERATOR_RANGE}" received=${received}`);
  }
  return value;
}

export function jobApiSchemaForMode(mode: JobPublicationMode = 'package-only'): JobApiSchema {
  if (mode === 'package-only') return JOB_API_SCHEMA;
  if (mode === 'record-and-package') return JOB_API_V3_SCHEMA;
  throw new JobError('JOB_REQUEST_INVALID');
}

export function assertJobApiSchema(
  value: unknown,
  expected: JobApiSchema | JobPublicationMode = JOB_API_SCHEMA,
): void {
  const schema = expected === 'package-only' || expected === 'record-and-package'
    ? jobApiSchemaForMode(expected)
    : expected;
  if (value !== schema) {
    throw new JobError('JOB_REQUEST_INVALID', 'JOB_API_SCHEMA_MISMATCH');
  }
}

export function parseProjectRecord(
  value: unknown,
  errorCode: JobErrorCode = 'JOB_FREEZE_REQUIRED',
): ProjectRecord {
  if (value === null || value === undefined) throw new JobError(errorCode);
  const record = jobObject(value, ['path', 'sha256']);
  const path = jobPath(record.path);
  const sha256 = jobSha(record.sha256);
  if (path !== 'project.json') throw new JobError(errorCode);
  return { path: 'project.json', sha256 };
}

export function parseRecordFreeze(value: unknown): RecordFreeze {
  if (value === null || value === undefined) throw new JobError('JOB_FREEZE_REQUIRED');
  const freeze = jobObject(value, ['kind', 'holdId', 'record']);
  if (freeze.kind !== 'producer-held') throw new JobError('JOB_FREEZE_REQUIRED');
  const holdId = jobId(freeze.holdId);
  const record = parseProjectRecord(freeze.record, 'JOB_FREEZE_REQUIRED');
  return { kind: 'producer-held', holdId, record };
}

export function parsePublishResultV3(value: unknown): PublishResultV3 {
  const item = jobObject(value, ['kind', 'path', 'selector', 'questionId', 'setId', 'sets']);
  switch (item.kind) {
    case 'package':
      jobObject(item, ['kind', 'path', 'selector']);
      if (!('selector' in item) || item.selector === undefined) throw new JobError('JOB_REQUEST_INVALID');
      return { kind: 'package', path: jobPath(item.path), selector: parseJobSelector(item.selector) };
    case 'option-set': {
      jobObject(item, ['kind', 'questionId', 'setId', 'sets']);
      const first = { questionId: jobId(item.questionId), setId: jobId(item.setId) };
      if (!('sets' in item)) return { kind: 'option-set', ...first };
      return { kind: 'option-set', ...first, sets: parseOptionSetRefs(item.sets, first) };
    }
    case 'plan':
      jobObject(item, ['kind']);
      return { kind: 'plan' };
  }
  throw new JobError('JOB_REQUEST_INVALID');
}

/** #1004: 2–64 distinct sets, `sets[0]` equal to the result's own `questionId`/`setId`. One set never uses `sets`,
 * so a one-set publication keeps a single encoding. A set named twice refuses `JOB_OPTION_SET_DUPLICATE`. */
function parseOptionSetRefs(value: unknown, first: RecordOptionSetRef): readonly RecordOptionSetRef[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > jobAskBatchLimit) throw new JobError('JOB_REQUEST_INVALID');
  const seen = new Set<string>();
  const sets = value.map(raw => {
    const row = exactObject(raw, ['questionId', 'setId'], 'JOB_REQUEST_INVALID');
    const ref = { questionId: jobId(row.questionId), setId: jobId(row.setId) };
    const key = JSON.stringify([ref.questionId, ref.setId]);
    if (seen.has(key)) throw new JobError('JOB_OPTION_SET_DUPLICATE', `set ${ref.questionId}/${ref.setId} is named twice`);
    seen.add(key);
    return ref;
  });
  if (sets[0]!.questionId !== first.questionId || sets[0]!.setId !== first.setId) throw new JobError('JOB_REQUEST_INVALID');
  return sets;
}

/** The sets a record option-set result publishes, in order. */
export function optionSetRefs(result: RecordOptionResult): readonly RecordOptionSetRef[] {
  return result.sets ?? [{ questionId: result.questionId, setId: result.setId }];
}

export function parseRecordResult(value: unknown): RecordResult {
  const result = parsePublishResultV3(value);
  if (result.kind === 'package') throw new JobError('JOB_REQUEST_INVALID');
  return result;
}

export function stripPackageResultKind(
  result: Extract<PublishResultV3, { readonly kind: 'package' }>,
): JobPublishRequest['result'] {
  const parsed = parsePublishResultV3(result);
  if (parsed.kind !== 'package') throw new JobError('JOB_REQUEST_INVALID');
  return { path: parsed.path, selector: parsed.selector };
}

export function parseRecordSubject(value: unknown): RecordSubject {
  const item = jobObject(value, ['kind', 'questionId', 'setId', 'checkpointId', 'draftId', 'stage']);
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(item.kind)) {
    throw new JobError('JOB_ACT_KIND_DISABLED');
  }
  if (
    item.kind !== 'interview-picks' &&
    item.kind !== 'checkpoint' &&
    item.kind !== 'signoff' &&
    item.kind !== 'reopen'
  ) {
    throw new JobError('JOB_ASK_INVALID');
  }
  switch (item.kind) {
    case 'interview-picks':
      jobObject(item, ['kind', 'questionId', 'setId']);
      return { kind: 'interview-picks', questionId: jobId(item.questionId), setId: jobId(item.setId) };
    case 'checkpoint':
      jobObject(item, ['kind', 'checkpointId']);
      return { kind: 'checkpoint', checkpointId: jobId(item.checkpointId) };
    case 'signoff': {
      jobObject(item, ['kind', 'stage']);
      const stage = jobId(item.stage);
      if (!(JOB_RECORD_SIGNOFF_STAGES as readonly string[]).includes(stage)) {
        throw new JobError('JOB_ASK_INVALID');
      }
      return { kind: 'signoff', stage: stage as RecordSignoffStage };
    }
    case 'reopen':
      jobObject(item, ['kind', 'stage']);
      return { kind: 'reopen', stage: jobId(item.stage) };
  }
}

export function parseJobRequest(
  value: unknown,
  mode?: typeof JOB_API_SCHEMA | 'package-only',
): JobAgentRequest | JobFetchActRequest;
export function parseJobRequest(
  value: unknown,
  mode: typeof JOB_API_V3_SCHEMA | 'record-and-package',
): AgentRequestV3 | FetchActRequestV3;
export function parseJobRequest(
  value: unknown,
  mode: JobApiSchema | JobPublicationMode,
): JobAgentRequest | JobFetchActRequest | AgentRequestV3 | FetchActRequestV3;
export function parseJobRequest(
  value: unknown,
  mode: JobApiSchema | JobPublicationMode = JOB_API_SCHEMA,
): JobAgentRequest | JobFetchActRequest | AgentRequestV3 | FetchActRequestV3 {
  const item = jobObject(value, [
    'schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey',
    'result', 'freeze', 'publicationId', 'subject', 'subjects', 'after', 'waitMs', 'reason', 'actId', 'seq', 'phase', 'text', 'step',
  ]);
  const targetSchema = mode === 'package-only' || mode === 'record-and-package'
    ? jobApiSchemaForMode(mode)
    : mode;
  assertJobApiSchema(item.schema, targetSchema);
  if (targetSchema === JOB_API_V3_SCHEMA) {
    const base = { schema: JOB_API_V3_SCHEMA, jobId: jobId(item.jobId), requestId: jobId(item.requestId) };
    if (item.verb === 'next') {
      jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'after', 'waitMs']);
      return { ...base, verb: 'next', after: item.after === null ? null : jobId(item.after), waitMs: jobInteger(item.waitMs, jobWaitLimitMs) };
    }
    if (item.verb === 'fetch-act') {
      jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'actId']);
      return { ...base, verb: 'fetch-act', actId: jobId(item.actId) };
    }
    if (item.verb === 'progress') {
      return { ...base, verb: 'progress', ...parseJobProgress(item) };
    }
    const mutation = { ...base, expectedGeneration: jobInteger(item.expectedGeneration), idempotencyKey: jobId(item.idempotencyKey) };
    switch (item.verb) {
      case 'publish': {
        jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'result', 'freeze']);
        const result = parsePublishResultV3(item.result);
        if (result.kind === 'package') {
          const freeze = jobObject(item.freeze, ['kind', 'holdId', 'record']);
          if (freeze.kind !== 'producer-held') throw new JobError('JOB_FREEZE_REQUIRED');
          const record = freeze.record === null ? null : jobObject(freeze.record, ['path', 'sha256']);
          const parsedPublish: PublishRequestV3 = {
            ...mutation,
            verb: 'publish',
            result,
            freeze: {
              kind: 'producer-held',
              holdId: jobId(freeze.holdId),
              record: record === null ? null : { path: jobPath(record.path), sha256: jobSha(record.sha256) },
            },
          };
          return parsedPublish;
        }
        const parsedRecordPublish: PublishRequestV3 = {
          ...mutation,
          verb: 'publish',
          result,
          freeze: parseRecordFreeze(item.freeze),
        };
        return parsedRecordPublish;
      }
      case 'ask': {
        jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'publicationId', 'subject']);
        return {
          ...mutation,
          verb: 'ask',
          publicationId: jobId(item.publicationId),
          subject: parseAskSubjectV3(item.subject),
        };
      }
      case 'ask-batch': {
        jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'publicationId', 'subjects']);
        const listed = item.subjects;
        if (!Array.isArray(listed) || listed.length < 1 || listed.length > jobAskBatchLimit) throw new JobError('JOB_REQUEST_INVALID');
        const seen = new Map<string, number>();
        const subjects = Array.from(listed, (value: unknown, index) => atSubject(index, () => {
          const subject = parseAskSubjectV3(value), digest = requestDigest(subject), first = seen.get(digest);
          if (first !== undefined) throw new JobError('JOB_REQUEST_INVALID', `duplicate of subjects[${first}]`);
          seen.set(digest, index);
          return subject;
        }));
        return { ...mutation, verb: 'ask-batch', publicationId: jobId(item.publicationId), subjects };
      }
      case 'close':
        jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'reason']);
        return { ...mutation, verb: 'close', reason: jobText(item.reason, 1024) };
    }
    throw new JobError('JOB_REQUEST_INVALID');
  }
  const base = { schema: JOB_API_SCHEMA, jobId: jobId(item.jobId), requestId: jobId(item.requestId) };
  if (item.verb === 'next') {
    jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'after', 'waitMs']);
    return { ...base, verb: 'next', after: item.after === null ? null : jobId(item.after), waitMs: jobInteger(item.waitMs, jobWaitLimitMs) };
  }
  if (item.verb === 'fetch-act') {
    jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'actId']);
    return { ...base, verb: 'fetch-act', actId: jobId(item.actId) };
  }
  const mutation = { ...base, expectedGeneration: jobInteger(item.expectedGeneration), idempotencyKey: jobId(item.idempotencyKey) };
  switch (item.verb) {
    case 'publish': {
      jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'result', 'freeze']);
      const result = jobObject(item.result, ['path', 'selector']);
      const freeze = jobObject(item.freeze, ['kind', 'holdId', 'record']);
      if (freeze.kind !== 'producer-held') throw new JobError('JOB_FREEZE_REQUIRED');
      const record = freeze.record === null ? null : jobObject(freeze.record, ['path', 'sha256']);
      return {
        ...mutation, verb: 'publish',
        result: { path: jobPath(result.path), selector: parseJobSelector(result.selector) },
        freeze: {
          kind: 'producer-held', holdId: jobId(freeze.holdId),
          record: record === null ? null : { path: jobPath(record.path), sha256: jobSha(record.sha256) },
        },
      };
    }
    case 'ask':
      jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'publicationId', 'subject']);
      return { ...mutation, verb: 'ask', publicationId: jobId(item.publicationId), subject: parseJobSubject(item.subject) };
    case 'close':
      jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey', 'reason']);
      return { ...mutation, verb: 'close', reason: jobText(item.reason, 1024) };
  }
  throw new JobError('JOB_REQUEST_INVALID');
}

function parseJobProgress(item: Record<string, unknown>): Omit<JobProgressRequestV3, 'schema' | 'jobId' | 'requestId' | 'verb'> {
  jobObject(item, ['schema', 'jobId', 'requestId', 'verb', 'seq', 'phase', 'text', 'step']);
  const seq = jobInteger(item.seq), phase = item.phase;
  if (seq < 1 || (phase !== 'ingest' && phase !== 'build' && phase !== 'measure' && phase !== 'publish' && phase !== 'other')) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  let text: string | undefined;
  if (Object.hasOwn(item, 'text')) {
    text = item.text === '' ? '' : jobText(item.text, 120);
    if (/[\u0085\u2028\u2029]/u.test(text)) throw new JobError('JOB_REQUEST_INVALID');
  }
  if (!Object.hasOwn(item, 'step')) return { seq, phase, ...(text !== undefined ? { text } : {}) };
  const step = jobObject(item.step, ['i', 'n']);
  const n = jobInteger(step.n, 1000), i = jobInteger(step.i, n);
  if (i < 1) throw new JobError('JOB_REQUEST_INVALID');
  return { seq, phase, ...(text !== undefined ? { text } : {}), step: { i, n } };
}

/** The single V3 `ask` subject parser; `ask-batch` parses each listed subject through it. */
function parseAskSubjectV3(value: unknown): JobSubject | RecordSubject {
  const isReopenSubject =
    value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === 'reopen';
  return isReopenSubject ? parseRecordSubject(value) : parseJobSubject(value);
}

/** `ask-batch` refuses with the subject's own code, its message prefixed by the subject's request index. */
export function atSubject<Value>(index: number, fn: () => Value): Value {
  try {
    return fn();
  } catch (error) {
    if (error instanceof JobError) throw new JobError(error.code, `subjects[${index}]: ${error.message}`);
    throw error;
  }
}

export function parseJobRequestV3(value: unknown): AgentRequestV3 | FetchActRequestV3 {
  return parseJobRequest(value, JOB_API_V3_SCHEMA);
}

const maxRecordFiles = 4096;
const maxActWords = 10_000;

function asCode<Value>(fn: () => Value, code: JobErrorCode): Value {
  try {
    return fn();
  } catch (error) {
    if (error instanceof JobError && error.code === code) throw error;
    throw new JobError(code);
  }
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
  code: JobErrorCode,
  optional: readonly string[] = [],
): Record<string, unknown> {
  const item = asCode(() => jobObject(value, [...keys, ...optional]), code);
  if (keys.some(key => !Object.hasOwn(item, key) || item[key] === undefined)) {
    throw new JobError(code);
  }
  return item;
}

export function parseFileRow(value: unknown, code: JobErrorCode): JobFileIdentity {
  const item = exactObject(value, ['path', 'sha256'], code);
  return asCode(() => ({ path: jobPath(item.path), sha256: jobSha(item.sha256) }), code);
}

function parseInterviewJson(value: unknown, code: JobErrorCode, depth = 0): JobInterviewJson {
  if (depth > 32) throw new JobError(code);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JobError(code);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => parseInterviewJson(entry, code, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        parseInterviewJson(child, code, depth + 1),
      ]),
    );
  }
  throw new JobError(code);
}

function parseInterviewJsonObject(
  value: unknown,
  code: JobErrorCode,
): { readonly [key: string]: JobInterviewJson } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobError(code);
  }
  return parseInterviewJson(value, code) as { readonly [key: string]: JobInterviewJson };
}

export function parseJobInterviewDiagnostics(
  value: unknown,
  code: JobErrorCode = 'JOB_REQUEST_INVALID',
): JobInterviewDiagnostics | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const item = exactObject(
    value,
    ['schema', 'project', 'evaluatedAt', 'records', 'diagnostics'],
    code,
  );
  if (item.schema !== 'rig-review/job-interview@1') throw new JobError(code);
  const project = asCode(() => parseProjectRecord(item.project, code), code);
  const evaluatedAt = asCode(() => jobText(item.evaluatedAt), code);
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new JobError(code);
  if (!Array.isArray(item.records) || item.records.length > maxRecordFiles ||
      !Array.isArray(item.diagnostics) || item.diagnostics.length > maxRecordFiles) {
    throw new JobError(code);
  }
  const recordsByLocator = new Map<string, JobInterviewRecord>();
  const records: JobInterviewRecord[] = item.records.map(rawRow => {
    const row = exactObject(
      rawRow,
      ['questionId', 'record', 'setId', 'ref', 'observedSet', 'timeKind', 'at', 'original'],
      code,
    );
    const questionId = asCode(() => jobId(row.questionId), code);
    const record = asCode(() => jobText(row.record, 256), code);
    if (recordsByLocator.has(record)) throw new JobError(code);
    const setId = row.setId === null ? null : asCode(() => jobId(row.setId), code);
    const ref = parseFileRow(row.ref, code);
    const observedSet = row.observedSet === null ? null : parseFileRow(row.observedSet, code);
    if (row.timeKind !== 'inspection' && row.timeKind !== 'answer' && row.timeKind !== 'decision') {
      throw new JobError(code);
    }
    const timeKind = row.timeKind;
    const at = row.at === null ? null : asCode(() => jobText(row.at), code);
    if (timeKind === 'inspection') {
      if (at !== evaluatedAt || row.original !== null) throw new JobError(code);
      const parsed: JobInterviewRecord = { questionId, record, setId, ref, observedSet, timeKind, at, original: null };
      recordsByLocator.set(record, parsed);
      return parsed;
    }
    const original = parseInterviewJsonObject(row.original, code);
    if (timeKind === 'decision') {
      const completed = ['at', 'value', 'fragments'].some(key => Object.hasOwn(original, key));
      if (!completed && at !== null) throw new JobError(code);
    }
    const parsed: JobInterviewRecord = { questionId, record, setId, ref, observedSet, timeKind, at, original };
    recordsByLocator.set(record, parsed);
    return parsed;
  });
  const seenDiagnosticRecords = new Set<string>();
  const diagnostics: JobInterviewDiagnostic[] = item.diagnostics.map(rawDiag => {
    const diag = exactObject(rawDiag, ['record', 'at', 'code', 'severity'], code);
    const record = asCode(() => jobText(diag.record, 256), code);
    const at = diag.at === null ? null : asCode(() => jobText(diag.at), code);
    if (seenDiagnosticRecords.has(record)) throw new JobError(code);
    const matching = recordsByLocator.get(record);
    if (!matching || matching.at !== at) throw new JobError(code);
    if (matching.timeKind === 'decision' && matching.original &&
        !['at', 'value', 'fragments'].some(key => Object.hasOwn(matching.original!, key))) {
      throw new JobError(code);
    }
    seenDiagnosticRecords.add(record);
    if (diag.code === 'INTERVIEW_OPTIONS_STALE' && diag.severity === 'error') {
      return { record, at, code: 'INTERVIEW_OPTIONS_STALE', severity: 'error' };
    }
    if (diag.code === 'INTERVIEW_OPTIONS_SCENE_LEGACY' && diag.severity === 'warning') {
      return { record, at, code: 'INTERVIEW_OPTIONS_SCENE_LEGACY', severity: 'warning' };
    }
    throw new JobError(code);
  });
  return {
    schema: 'rig-review/job-interview@1',
    project,
    evaluatedAt,
    records,
    diagnostics,
  };
}

function parseFileClosure(
  rawInputs: unknown,
  rawFiles: unknown,
  record: ProjectRecord | undefined,
  code: JobErrorCode,
): { readonly inputs: readonly JobFileIdentity[]; readonly files: readonly JobFileIdentity[]; readonly byPath: Map<string, string> } {
  if (!Array.isArray(rawInputs) || rawInputs.length > maxRecordFiles ||
      !Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > maxRecordFiles) {
    throw new JobError(code);
  }
  const files: JobFileIdentity[] = [];
  const byPath = new Map<string, string>();
  for (let index = 0; index < rawFiles.length; index++) {
    const file = parseFileRow(rawFiles[index], code);
    if (index > 0 && !(files[index - 1]!.path < file.path)) {
      throw new JobError(code);
    }
    files.push(file);
    byPath.set(file.path, file.sha256);
  }
  const sealedProjectHash = byPath.get('project.json');
  if (!sealedProjectHash || (record !== undefined && sealedProjectHash !== record.sha256)) {
    throw new JobError(code);
  }
  const inputs: JobFileIdentity[] = [];
  for (const rawInput of rawInputs) {
    const input = parseFileRow(rawInput, code);
    if (byPath.get(input.path) !== input.sha256) {
      throw new JobError(code);
    }
    inputs.push(input);
  }
  return { inputs, files, byPath };
}

function parsePlanIdentity(value: unknown, code: JobErrorCode): {
  readonly plan: JobPlanIdentity;
  readonly stepIds: Set<string>;
} {
  const item = exactObject(value, ['steps'], code);
  if (!Array.isArray(item.steps) || item.steps.length > maxRecordFiles) {
    throw new JobError(code);
  }
  const stepIds = new Set<string>();
  const steps = item.steps.map(rawStep => {
    const step = exactObject(rawStep, ['id', 'hash'], code);
    const id = asCode(() => jobId(step.id), code);
    const hash = asCode(() => jobSha(step.hash), code);
    if (stepIds.has(id)) throw new JobError(code);
    stepIds.add(id);
    return { id, hash };
  });
  return { plan: { steps }, stepIds };
}

function parsePlanSubjects(
  rawSubjects: unknown,
  stepIds: ReadonlySet<string>,
  code: JobErrorCode,
): readonly RecordPlanSubject[] {
  if (!Array.isArray(rawSubjects) || rawSubjects.length > maxRecordFiles) {
    throw new JobError(code);
  }
  const seen = new Set<string>();
  return rawSubjects.map(raw => {
    const parsed = asCode(() => parseRecordSubject(raw), code);
    if (parsed.kind === 'interview-picks') throw new JobError(code);
    if (parsed.kind === 'checkpoint') {
      if (!stepIds.has(parsed.checkpointId)) throw new JobError(code);
      const key = `checkpoint:${parsed.checkpointId}`;
      if (seen.has(key)) throw new JobError(code);
      seen.add(key);
      return { kind: 'checkpoint', checkpointId: parsed.checkpointId };
    }
    if (parsed.kind === 'reopen') {
      const key = `reopen:${parsed.stage}`;
      if (seen.has(key)) throw new JobError(code);
      seen.add(key);
      return { kind: 'reopen', stage: parsed.stage };
    }
    if (stepIds.size === 0) throw new JobError(code);
    const key = `signoff:${parsed.stage}`;
    if (seen.has(key)) throw new JobError(code);
    seen.add(key);
    return { kind: 'signoff', stage: parsed.stage };
  });
}

/** One `interview-picks` subject per published set, in set order. Two subjects for one set refuse by name. */
function parseOptionSubjects(
  rawSubjects: unknown,
  selection: RecordOptionResult,
  code: JobErrorCode,
): readonly RecordPicksSubject[] {
  const sets = optionSetRefs(selection);
  if (!Array.isArray(rawSubjects) || rawSubjects.length > jobAskBatchLimit) {
    throw new JobError(code);
  }
  const seen = new Set<string>();
  const subjects = rawSubjects.map(raw => {
    const parsed = asCode(() => parseRecordSubject(raw), code);
    if (parsed.kind !== 'interview-picks') throw new JobError(code);
    const key = JSON.stringify([parsed.questionId, parsed.setId]);
    if (seen.has(key)) {
      throw new JobError('JOB_OPTION_SET_DUPLICATE', `two subjects for set ${parsed.questionId}/${parsed.setId}`);
    }
    seen.add(key);
    return { kind: 'interview-picks' as const, questionId: parsed.questionId, setId: parsed.setId };
  });
  if (subjects.length !== sets.length ||
      subjects.some((subject, index) => subject.questionId !== sets[index]!.questionId || subject.setId !== sets[index]!.setId)) {
    throw new JobError(code);
  }
  return subjects;
}

export function parseRecordPartsIdentity(
  value: unknown,
  code: JobErrorCode = 'JOB_SOURCE_MISMATCH',
): RecordPartsIdentity {
  const raw = exactObject(value, ['name', 'version', 'integrity'], code);
  return {
    name: asCode(() => jobText(raw.name), code),
    version: asCode(() => jobText(raw.version), code),
    integrity: asCode(() => jobText(raw.integrity), code),
  };
}

type ParsedRecordPayload =
  | {
      readonly kind: 'option-set';
      readonly inputs: readonly JobFileIdentity[];
      readonly files: readonly JobFileIdentity[];
      readonly plan: null;
      readonly subjects: readonly RecordPicksSubject[];
    }
  | {
      readonly kind: 'plan';
      readonly checkpointEvidence?: readonly JobCheckpointEvidence[];
      readonly planPicture?: JobFileIdentity;
      readonly inputs: readonly JobFileIdentity[];
      readonly files: readonly JobFileIdentity[];
      readonly plan: JobPlanIdentity;
      readonly subjects: readonly RecordPlanSubject[];
    };

function parseRecordClosureAndSubjects(
  rawInputs: unknown,
  rawFiles: unknown,
  rawPlan: unknown,
  rawSubjects: unknown,
  selection: RecordResult,
  checkedRecord?: ProjectRecord,
  evidenceHolder: object = {},
): ParsedRecordPayload {
  const { inputs, files } = parseFileClosure(rawInputs, rawFiles, checkedRecord, 'JOB_SOURCE_MISMATCH');
  if (selection.kind === 'option-set') {
    if (rawPlan !== null || 'checkpointEvidence' in evidenceHolder || 'planPicture' in evidenceHolder) throw new JobError('JOB_SOURCE_MISMATCH');
    const subjects = parseOptionSubjects(rawSubjects, selection, 'JOB_SOURCE_MISMATCH');
    return { kind: 'option-set', inputs, files, plan: null, subjects };
  }
  if (rawPlan === null) throw new JobError('JOB_SOURCE_MISMATCH');
  const { plan, stepIds } = parsePlanIdentity(rawPlan, 'JOB_SOURCE_MISMATCH');
  const subjects = parsePlanSubjects(rawSubjects, stepIds, 'JOB_SOURCE_MISMATCH');
  return { kind: 'plan', inputs, files, plan, subjects, ...checkpointEvidenceFields(evidenceHolder, plan, subjects, files),
    ...planPictureFields(evidenceHolder, plan, files) };
}

export function parseRecordPublishedContext(
  value: unknown,
  result: RecordOptionResult,
  record?: ProjectRecord,
): OptionContext;
export function parseRecordPublishedContext(
  value: unknown,
  result: RecordPlanResult,
  record?: ProjectRecord,
): PlanContext;
export function parseRecordPublishedContext(
  value: unknown,
  result: RecordResult,
  record?: ProjectRecord,
): OptionContext | PlanContext;
export function parseRecordPublishedContext(
  value: unknown,
  result: RecordResult,
  record?: ProjectRecord,
): OptionContext | PlanContext {
  const selection = parseRecordResult(result);
  const checkedRecord = record === undefined ? undefined : parseProjectRecord(record, 'JOB_SOURCE_MISMATCH');
  if (value && typeof value === 'object') previousDraftFields(value, null);
  const item = exactObject(value, ['label', 'parts', 'inputs', 'files', 'plan', 'subjects'], 'JOB_SOURCE_MISMATCH', ['checkpointEvidence', 'planPicture']);
  const label = asCode(() => jobText(item.label), 'JOB_SOURCE_MISMATCH');
  const parts = parseRecordPartsIdentity(item.parts, 'JOB_SOURCE_MISMATCH');
  const body = parseRecordClosureAndSubjects(
    item.inputs,
    item.files,
    item.plan,
    item.subjects,
    selection,
    checkedRecord,
    item,
  );
  if (body.kind === 'option-set') {
    return { label, parts, inputs: body.inputs, files: body.files, plan: null, subjects: body.subjects };
  }
  return { label, parts, inputs: body.inputs, files: body.files, plan: body.plan, subjects: body.subjects,
    ...(body.checkpointEvidence ? {checkpointEvidence: body.checkpointEvidence} : {}),
    ...(body.planPicture ? {planPicture: body.planPicture} : {}) };
}

export function assertEqualRecordContexts(
  inventory: OptionContext | PlanContext,
  retained: OptionContext | PlanContext,
): void {
  const inferResult = (ctx: OptionContext | PlanContext): RecordResult => {
    if (ctx.plan === null) {
      const first = Array.isArray(ctx.subjects) ? ctx.subjects[0] : undefined;
      if (!first || first.kind !== 'interview-picks') throw new JobError('JOB_SOURCE_MISMATCH');
      if (ctx.subjects.length < 2) return { kind: 'option-set', questionId: first.questionId, setId: first.setId };
      // Several sets: the subjects name them; parseOptionSubjects still refuses a set named twice.
      return { kind: 'option-set', questionId: first.questionId, setId: first.setId,
        sets: ctx.subjects.map(subject => ({ questionId: subject.questionId, setId: subject.setId })) };
    }
    return { kind: 'plan' };
  };
  const selection = inferResult(inventory);
  const a = parseRecordPublishedContext(inventory, selection);
  const b = parseRecordPublishedContext(retained, selection);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
}

export interface RecordSourceDigestInput {
  readonly checkpointEvidence?: readonly JobCheckpointEvidence[];
  readonly planPicture?: JobFileIdentity;
  readonly schema?: typeof JOB_RECORD_SOURCE_SCHEMA;
  readonly sourceHash?: JobSha256;
  readonly projectHash?: JobSha256;
  readonly subject?: 'option-set' | 'plan';
  readonly record: ProjectRecord;
  readonly selection: RecordResult;
  readonly inputs: readonly JobFileIdentity[];
  readonly optionSet: { readonly id: string; readonly sha256: JobSha256 } | null;
  readonly optionSetFile: JobFileIdentity | null;
  readonly plan: JobPlanIdentity | null;
  readonly subjects: readonly RecordSubject[];
  readonly files: readonly JobFileIdentity[];
  readonly optionSets?: readonly RecordOptionSetBinding[];
}

export function serializeRecordSourceDigestPayload(input: RecordSourceDigestInput): string {
  const item = asCode(
    () =>
      jobObject(input, [
        'schema',
        'sourceHash',
        'projectHash',
        'subject',
        'record',
        'selection',
        'inputs',
        'optionSet',
        'optionSetFile',
        'plan',
        'subjects',
        'files',
        'checkpointEvidence',
        'optionSets',
        'planPicture',
      ]),
    'JOB_SOURCE_MISMATCH',
  );
  for (const key of ['record', 'selection', 'inputs', 'optionSet', 'optionSetFile', 'plan', 'subjects', 'files'] as const) {
    if (!(key in item) || item[key] === undefined) throw new JobError('JOB_SOURCE_MISMATCH');
  }
  if (item.schema !== undefined && item.schema !== JOB_RECORD_SOURCE_SCHEMA) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  if (item.sourceHash !== undefined) {
    asCode(() => jobSha(item.sourceHash), 'JOB_SOURCE_MISMATCH');
  }
  const record = parseProjectRecord(item.record, 'JOB_SOURCE_MISMATCH');
  if (item.projectHash !== undefined && asCode(() => jobSha(item.projectHash), 'JOB_SOURCE_MISMATCH') !== record.sha256) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const selection = asCode(() => parseRecordResult(item.selection), 'JOB_SOURCE_MISMATCH');
  if (item.subject !== undefined && item.subject !== selection.kind) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const { inputs, files, byPath } = parseFileClosure(item.inputs, item.files, record, 'JOB_SOURCE_MISMATCH');

  if (selection.kind === 'option-set') {
    if ('checkpointEvidence' in item || 'planPicture' in item || item.plan !== null || item.optionSet === null || item.optionSetFile === null) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    const rawOptionSet = exactObject(item.optionSet, ['id', 'sha256'], 'JOB_SOURCE_MISMATCH');
    const optionSet = {
      id: asCode(() => jobId(rawOptionSet.id), 'JOB_SOURCE_MISMATCH'),
      sha256: asCode(() => jobSha(rawOptionSet.sha256), 'JOB_SOURCE_MISMATCH'),
    };
    const optionSetFile = parseFileRow(item.optionSetFile, 'JOB_SOURCE_MISMATCH');
    if (optionSet.id !== selection.setId ||
        optionSet.sha256 !== optionSetFile.sha256 ||
        optionSetFile.path === 'project.json' ||
        byPath.get(optionSetFile.path) !== optionSetFile.sha256) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    const subjects = parseOptionSubjects(item.subjects, selection, 'JOB_SOURCE_MISMATCH');
    const optionSets = parseOptionSetBindings(item.optionSets, selection, optionSetFile, byPath);
    // One set keeps the original payload bytes; several sets add `sets` to the selection and `optionSets` last.
    return JSON.stringify({
      schema: JOB_RECORD_SOURCE_SCHEMA,
      record: { path: 'project.json', sha256: record.sha256 },
      selection: { kind: 'option-set', questionId: selection.questionId, setId: selection.setId,
        ...(selection.sets ? { sets: selection.sets.map(set => ({ questionId: set.questionId, setId: set.setId })) } : {}) },
      inputs,
      optionSet,
      optionSetFile,
      plan: null,
      subjects,
      files,
      ...(optionSets ? { optionSets } : {}),
    });
  }

  if (item.optionSets !== undefined) throw new JobError('JOB_SOURCE_MISMATCH');
  if (item.optionSet !== null || item.optionSetFile !== null || item.plan === null) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const { plan, stepIds } = parsePlanIdentity(item.plan, 'JOB_SOURCE_MISMATCH');
  const subjects = parsePlanSubjects(item.subjects, stepIds, 'JOB_SOURCE_MISMATCH');
  return JSON.stringify({
    schema: JOB_RECORD_SOURCE_SCHEMA,
    record: { path: 'project.json', sha256: record.sha256 },
    selection: { kind: 'plan' },
    inputs,
    optionSet: null,
    optionSetFile: null,
    plan,
    subjects,
    files,
    ...checkpointEvidenceFields(item, plan, subjects, files),
    // #983: last, and only when present, so a record without it keeps its source hash.
    ...planPictureFields(item, plan, files),
  });
}

/** #1004: the per-set bindings of a several-set publication. Absent for one set; row 0 repeats the singular fields. */
function parseOptionSetBindings(
  value: unknown,
  selection: RecordOptionResult,
  first: JobFileIdentity,
  byPath: ReadonlyMap<string, string>,
): readonly RecordOptionSetBinding[] | undefined {
  if (!selection.sets) {
    if (value !== undefined) throw new JobError('JOB_SOURCE_MISMATCH');
    return undefined;
  }
  const sets = selection.sets;
  if (!Array.isArray(value) || value.length !== sets.length) throw new JobError('JOB_SOURCE_MISMATCH');
  const paths = new Set<string>();
  return value.map((raw, index) => {
    const row = exactObject(raw, ['questionId', 'setId', 'optionSet', 'optionSetFile'], 'JOB_SOURCE_MISMATCH');
    const rawSet = exactObject(row.optionSet, ['id', 'sha256'], 'JOB_SOURCE_MISMATCH');
    const file = parseFileRow(row.optionSetFile, 'JOB_SOURCE_MISMATCH');
    const set = sets[index]!;
    if (row.questionId !== set.questionId || row.setId !== set.setId || rawSet.id !== set.setId ||
        rawSet.sha256 !== file.sha256 || file.path === 'project.json' || byPath.get(file.path) !== file.sha256 ||
        paths.has(file.path) || (index === 0 && (file.path !== first.path || file.sha256 !== first.sha256))) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    paths.add(file.path);
    return { questionId: set.questionId, setId: set.setId, optionSet: { id: set.setId, sha256: file.sha256 },
      optionSetFile: { path: file.path, sha256: file.sha256 } };
  });
}

export function recordSourceDigest(input: RecordSourceDigestInput): JobSha256 {
  return jobHash(serializeRecordSourceDigestPayload(input));
}

export function recordInstanceKey(fingerprint: unknown, sourceHash: unknown): JobSha256 {
  if (typeof fingerprint !== 'string') throw new JobError('JOB_REQUEST_INVALID');
  const checkedSourceHash = jobSha(sourceHash);
  return jobHash(
    JSON.stringify({
      schema: JOB_RECORD_INSTANCE_SCHEMA,
      fingerprint,
      sourceHash: checkedSourceHash,
    }),
  );
}

function assembleRecordSource(
  record: ProjectRecord,
  selection: RecordResult,
  body: ParsedRecordPayload,
  rawOptionSetFile?: unknown,
  rawOptionSets?: unknown,
): OptionSource | PlanSource {
  if (selection.kind === 'option-set') {
    if (body.kind !== 'option-set' || !rawOptionSetFile) throw new JobError('JOB_SOURCE_MISMATCH');
    const optionSetFile = parseFileRow(rawOptionSetFile, 'JOB_SOURCE_MISMATCH');
    const optionSet = { id: selection.setId, sha256: optionSetFile.sha256 };
    const optionSets = selection.sets === undefined && rawOptionSets === undefined ? undefined
      : parseOptionSetBindings(rawOptionSets, selection, optionSetFile, new Map(body.files.map(file => [file.path, file.sha256])));
    const sourceHash = recordSourceDigest({
      record,
      selection,
      inputs: body.inputs,
      optionSet,
      optionSetFile,
      plan: null,
      subjects: body.subjects,
      files: body.files,
      ...(optionSets ? { optionSets } : {}),
    });
    return {
      sourceHash,
      projectHash: record.sha256,
      record,
      inputs: body.inputs,
      files: body.files,
      subject: 'option-set',
      selection: { kind: 'option-set', questionId: selection.questionId, setId: selection.setId,
        ...(selection.sets ? { sets: selection.sets.map(set => ({ questionId: set.questionId, setId: set.setId })) } : {}) },
      optionSet,
      optionSetFile,
      plan: null,
      subjects: body.subjects,
      ...(optionSets ? { optionSets } : {}),
    };
  }
  if (rawOptionSets !== undefined) throw new JobError('JOB_SOURCE_MISMATCH');
  if (body.kind !== 'plan' || (rawOptionSetFile !== undefined && rawOptionSetFile !== null)) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const sourceHash = recordSourceDigest({
    record,
    selection,
    inputs: body.inputs,
    optionSet: null,
    optionSetFile: null,
    plan: body.plan,
    subjects: body.subjects,
    files: body.files,
    ...(body.checkpointEvidence ? {checkpointEvidence: body.checkpointEvidence} : {}),
    ...(body.planPicture ? {planPicture: body.planPicture} : {}),
  });
  return {
    sourceHash,
    projectHash: record.sha256,
    record,
    inputs: body.inputs,
    files: body.files,
    ...(body.checkpointEvidence ? {checkpointEvidence: body.checkpointEvidence} : {}),
    ...(body.planPicture ? {planPicture: body.planPicture} : {}),
    subject: 'plan',
    selection: { kind: 'plan' },
    optionSet: null,
    optionSetFile: null,
    plan: body.plan,
    subjects: body.subjects,
  };
}

export function buildRecordSource(input: {
  readonly record: ProjectRecord;
  readonly selection: RecordOptionResult;
  readonly context: OptionContext;
  readonly optionSetFile: JobFileIdentity;
  /** #1004: one sealed file per published set, in set order; required exactly when `selection.sets` is present. */
  readonly optionSetFiles?: readonly JobFileIdentity[];
}): OptionSource;
export function buildRecordSource(input: {
  readonly record: ProjectRecord;
  readonly selection: RecordPlanResult;
  readonly context: PlanContext;
  readonly optionSetFile?: null;
}): PlanSource;
export function buildRecordSource(input: {
  readonly record: ProjectRecord;
  readonly selection: RecordResult;
  readonly context: OptionContext | PlanContext;
  readonly optionSetFile?: JobFileIdentity | null;
  readonly optionSetFiles?: readonly JobFileIdentity[];
}): OptionSource | PlanSource {
  const record = parseProjectRecord(input.record, 'JOB_SOURCE_MISMATCH');
  const selection = asCode(() => parseRecordResult(input.selection), 'JOB_SOURCE_MISMATCH');
  const context = parseRecordPublishedContext(input.context, selection, record);
  const body: ParsedRecordPayload =
    context.plan === null
      ? {
          kind: 'option-set',
          inputs: context.inputs,
          files: context.files,
          plan: null,
          subjects: context.subjects,
        }
      : {
          kind: 'plan',
          inputs: context.inputs,
          files: context.files,
          plan: context.plan,
          subjects: context.subjects,
          ...(context.checkpointEvidence ? {checkpointEvidence: context.checkpointEvidence} : {}),
          ...(context.planPicture ? {planPicture: context.planPicture} : {}),
        };
  const sets = selection.kind === 'option-set' ? selection.sets : undefined;
  if ((sets === undefined) !== (input.optionSetFiles === undefined)) throw new JobError('JOB_SOURCE_MISMATCH');
  const optionSets = sets && input.optionSetFiles!.length === sets.length
    ? sets.map((set, index) => ({ questionId: set.questionId, setId: set.setId,
        optionSet: { id: set.setId, sha256: input.optionSetFiles![index]!.sha256 }, optionSetFile: input.optionSetFiles![index]! }))
    : sets ? [] : undefined;
  return assembleRecordSource(record, selection, body, input.optionSetFile, optionSets);
}

export function parseRecordSource(value: unknown): RecordSource {
  const item = exactObject(
    value,
    [
      'sourceHash',
      'projectHash',
      'record',
      'inputs',
      'files',
      'subject',
      'selection',
      'optionSet',
      'optionSetFile',
      'plan',
      'subjects',
    ],
    'JOB_SOURCE_MISMATCH',
    ['checkpointEvidence', 'optionSets', 'planPicture'],
  );
  const record = parseProjectRecord(item.record, 'JOB_SOURCE_MISMATCH');
  const projectHash = asCode(() => jobSha(item.projectHash), 'JOB_SOURCE_MISMATCH');
  const sourceHash = asCode(() => jobSha(item.sourceHash), 'JOB_SOURCE_MISMATCH');
  if (projectHash !== record.sha256) throw new JobError('JOB_SOURCE_MISMATCH');
  const selection = asCode(() => parseRecordResult(item.selection), 'JOB_SOURCE_MISMATCH');
  if (item.subject !== selection.kind) throw new JobError('JOB_SOURCE_MISMATCH');
  const body = parseRecordClosureAndSubjects(
    item.inputs,
    item.files,
    item.plan,
    item.subjects,
    selection,
    record,
    item,
  );
  if (selection.kind === 'option-set') {
    const rawOptionSet = exactObject(item.optionSet, ['id', 'sha256'], 'JOB_SOURCE_MISMATCH');
    const built = assembleRecordSource(record, selection, body, item.optionSetFile, item.optionSets) as OptionSource;
    if (rawOptionSet.id !== built.optionSet.id ||
        rawOptionSet.sha256 !== built.optionSet.sha256 ||
        sourceHash !== built.sourceHash) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    return built;
  }
  if (item.optionSet !== null || item.optionSetFile !== null || 'optionSets' in item) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const built = assembleRecordSource(record, selection, body, null) as PlanSource;
  if (sourceHash !== built.sourceHash) throw new JobError('JOB_SOURCE_MISMATCH');
  return built;
}

export function isRecordSource(value: unknown): value is RecordSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const subject = (value as { subject?: unknown }).subject;
  return subject === 'option-set' || subject === 'plan';
}

export function validateRecordAskSubject(subject: unknown, source: RecordSource): RecordSubject {
  const checkedSource = parseRecordSource(source);
  const parsed = parseRecordSubject(subject);
  if (checkedSource.subject === 'option-set') {
    if (parsed.kind !== 'interview-picks' ||
        !checkedSource.subjects.some(expected => parsed.questionId === expected.questionId && parsed.setId === expected.setId)) {
      throw new JobError('JOB_ASK_INVALID');
    }
    return parsed;
  }
  if (
    parsed.kind === 'interview-picks' ||
    ((parsed.kind === 'checkpoint' || parsed.kind === 'signoff') && checkedSource.plan.steps.length === 0)
  ) {
    throw new JobError('JOB_ASK_INVALID');
  }
  const declared = checkedSource.subjects.some(candidate =>
    candidate.kind === parsed.kind &&
    (candidate.kind === 'checkpoint'
      ? candidate.checkpointId === (parsed as Extract<RecordPlanSubject, { kind: 'checkpoint' }>).checkpointId
      : candidate.stage === (parsed as Extract<RecordPlanSubject, { kind: 'signoff' | 'reopen' }>).stage),
  );
  if (!declared) throw new JobError('JOB_ASK_INVALID');
  return parsed;
}

function parseHumanAuthority(value: unknown, code: JobErrorCode): JobHumanAuthority {
  const auth = exactObject(value, ['actor', 'channel', 'reviewer'], code);
  if (auth.actor !== 'human' || auth.channel !== 'review-ui') throw new JobError(code);
  const reviewer = exactObject(auth.reviewer, ['id', 'role'], code);
  if (typeof reviewer.id !== 'string' || !reviewer.id) throw new JobError(code);
  if (reviewer.role !== 'owner' && reviewer.role !== 'delegate') throw new JobError(code);
  return {
    actor: 'human',
    channel: 'review-ui',
    reviewer: { id: reviewer.id, role: reviewer.role },
  };
}

function parseActWords(value: unknown, code: JobErrorCode): string {
  if (typeof value !== 'string' || value.length > maxActWords) throw new JobError(code);
  return value;
}

/** #1004: an act's source names that act's own set. At K >= 2 the singular `selection` (`questionId`/`setId`, with
 * `sets` kept), `optionSet` and `optionSetFile` are re-pointed to the act's `optionSets` row; `subjects`, `optionSets`
 * and `sourceHash` stay the publication's. One set is returned unchanged. */
export function recordActSource(source: RecordSource, set: RecordOptionSetRef): RecordSource {
  if (source.subject !== 'option-set' || !source.optionSets) return source;
  const row = source.optionSets.find(item => item.questionId === set.questionId && item.setId === set.setId);
  if (!row) throw new JobError('JOB_ACT_INVALID', `act set ${set.questionId}/${set.setId} is not published`);
  return {
    ...source,
    selection: { kind: 'option-set', questionId: row.questionId, setId: row.setId, sets: source.selection.sets! },
    optionSet: { id: row.optionSet.id, sha256: row.optionSet.sha256 },
    optionSetFile: { path: row.optionSetFile.path, sha256: row.optionSetFile.sha256 },
  };
}

/** The inverse for a received act at K >= 2: check that the per-act singular fields agree with the act's own
 * `optionSets` row, then put set 0 back so the publication source (and its `sourceHash`) can be re-derived. */
function publicationFormOfActSource(raw: unknown): { readonly raw: unknown; readonly set?: RecordOptionSetRef } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { raw };
  const item = raw as Record<string, unknown>;
  const selection = item.selection as Record<string, unknown> | null | undefined;
  const rows = item.optionSets;
  if (item.subject !== 'option-set' || !Array.isArray(rows) || rows.length < 2 || !selection || typeof selection !== 'object' ||
      typeof selection.questionId !== 'string' || typeof selection.setId !== 'string') return { raw };
  const set = { questionId: selection.questionId, setId: selection.setId };
  const named = `${set.questionId}/${set.setId}`;
  const row = rows.find(entry => entry && typeof entry === 'object' &&
    (entry as RecordOptionSetBinding).questionId === set.questionId && (entry as RecordOptionSetBinding).setId === set.setId) as
    RecordOptionSetBinding | undefined;
  if (!row) throw new JobError('JOB_ACT_INVALID', `act set ${named} is not published`);
  const optionSet = item.optionSet as { id?: unknown; sha256?: unknown } | null;
  const file = item.optionSetFile as { path?: unknown; sha256?: unknown } | null;
  if (!optionSet || optionSet.id !== set.setId || optionSet.sha256 !== row.optionSet?.sha256) {
    throw new JobError('JOB_ACT_INVALID', `act optionSet does not name set ${named}`);
  }
  if (!file || file.path !== row.optionSetFile?.path || file.sha256 !== row.optionSetFile?.sha256) {
    throw new JobError('JOB_ACT_INVALID', `act optionSetFile is not the file of set ${named}`);
  }
  const first = rows[0] as RecordOptionSetBinding;
  return {
    set,
    raw: { ...item, selection: { ...selection, questionId: first.questionId, setId: first.setId },
      optionSet: first.optionSet, optionSetFile: first.optionSetFile },
  };
}

export function parseRecordAct(value: unknown): RecordAct {
  const item = exactObject(
    value,
    ['schema', 'actId', 'jobId', 'askId', 'publicationId', 'kind', 'authority', 'at', 'source', 'value'],
    'JOB_ACT_INVALID',
  );
  if (item.schema !== JOB_RECORD_ACT_SCHEMA) throw new JobError('JOB_ACT_INVALID');
  const actId = asCode(() => jobId(item.actId), 'JOB_ACT_INVALID');
  const jobIdValue = asCode(() => jobId(item.jobId), 'JOB_ACT_INVALID');
  const askId = asCode(() => jobId(item.askId), 'JOB_ACT_INVALID');
  const publicationId = asCode(() => jobId(item.publicationId), 'JOB_ACT_INVALID');
  const authority = parseHumanAuthority(item.authority, 'JOB_ACT_INVALID');
  const at = asCode(() => jobText(item.at, 128), 'JOB_ACT_INVALID');
  if (Number.isNaN(Date.parse(at))) throw new JobError('JOB_ACT_INVALID');
  const received = publicationFormOfActSource(item.source);
  const published = asCode(() => parseRecordSource(received.raw), 'JOB_ACT_INVALID');
  const source = received.set ? recordActSource(published, received.set) : published;

  switch (item.kind) {
    case 'interview-picks': {
      if (source.subject !== 'option-set') throw new JobError('JOB_ACT_INVALID');
      const rawValue = exactObject(item.value, ['questionId', 'selections', 'note'], 'JOB_ACT_INVALID');
      const questionId = asCode(() => jobId(rawValue.questionId), 'JOB_ACT_INVALID');
      if (received.set && questionId !== received.set.questionId) {
        throw new JobError('JOB_ACT_INVALID', `value.questionId ${questionId} is not the act set ${received.set.questionId}/${received.set.setId}`);
      }
      if (!optionSetRefs(source.selection).some(set => set.questionId === questionId) || !Array.isArray(rawValue.selections) ||
          rawValue.selections.length > maxRecordFiles) {
        throw new JobError('JOB_ACT_INVALID');
      }
      const selections = rawValue.selections.map(rawSelection => {
        const entry = exactObject(rawSelection, ['itemId', 'optionId', 'otherText'], 'JOB_ACT_INVALID');
        const itemId = asCode(() => jobId(entry.itemId), 'JOB_ACT_INVALID');
        const optionId = asCode(() => jobId(entry.optionId), 'JOB_ACT_INVALID');
        const otherText = entry.otherText === null ? null : parseActWords(entry.otherText, 'JOB_ACT_INVALID');
        return { itemId, optionId, otherText };
      });
      const note = parseActWords(rawValue.note, 'JOB_ACT_INVALID');
      return {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId,
        jobId: jobIdValue,
        askId,
        publicationId,
        kind: 'interview-picks',
        authority,
        at,
        source,
        value: { questionId, selections, note },
      };
    }
    case 'checkpoint': {
      if (source.subject !== 'plan' || source.plan.steps.length === 0) throw new JobError('JOB_ACT_INVALID');
      const rawValue = exactObject(item.value, ['checkpointId', 'planStepId', 'outcome', 'words'], 'JOB_ACT_INVALID');
      const checkpointId = asCode(() => jobId(rawValue.checkpointId), 'JOB_ACT_INVALID');
      const planStepId = asCode(() => jobId(rawValue.planStepId), 'JOB_ACT_INVALID');
      if (planStepId !== checkpointId) throw new JobError('JOB_ACT_INVALID');
      asCode(() => validateRecordAskSubject({ kind: 'checkpoint', checkpointId }, source), 'JOB_ACT_INVALID');
      if (rawValue.outcome !== 'pass' && rawValue.outcome !== 'fail') throw new JobError('JOB_ACT_INVALID');
      const words = parseActWords(rawValue.words, 'JOB_ACT_INVALID');
      return {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId,
        jobId: jobIdValue,
        askId,
        publicationId,
        kind: 'checkpoint',
        authority,
        at,
        source,
        value: { checkpointId, planStepId, outcome: rawValue.outcome, words },
      };
    }
    case 'signoff': {
      if (source.subject !== 'plan' || source.plan.steps.length === 0) throw new JobError('JOB_ACT_INVALID');
      const rawValue = exactObject(item.value, ['stage', 'decision', 'words'], 'JOB_ACT_INVALID');
      const stage = asCode(() => jobId(rawValue.stage), 'JOB_ACT_INVALID');
      if (!(JOB_RECORD_SIGNOFF_STAGES as readonly string[]).includes(stage) || rawValue.decision !== 'approved') {
        throw new JobError('JOB_ACT_INVALID');
      }
      asCode(() => validateRecordAskSubject({ kind: 'signoff', stage }, source), 'JOB_ACT_INVALID');
      const words = parseActWords(rawValue.words, 'JOB_ACT_INVALID');
      return {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId,
        jobId: jobIdValue,
        askId,
        publicationId,
        kind: 'signoff',
        authority,
        at,
        source,
        value: { stage: stage as RecordSignoffStage, decision: 'approved', words },
      };
    }
    case 'reopen': {
      if (source.subject !== 'plan') throw new JobError('JOB_ACT_INVALID');
      const rawValue = exactObject(item.value, ['stage', 'words'], 'JOB_ACT_INVALID');
      const stage = asCode(() => jobId(rawValue.stage), 'JOB_ACT_INVALID');
      asCode(() => validateRecordAskSubject({ kind: 'reopen', stage }, source), 'JOB_ACT_INVALID');
      const words = parseActWords(rawValue.words, 'JOB_ACT_INVALID');
      return {
        schema: JOB_RECORD_ACT_SCHEMA,
        actId,
        jobId: jobIdValue,
        askId,
        publicationId,
        kind: 'reopen',
        authority,
        at,
        source,
        value: { stage, words },
      };
    }
  }
  throw new JobError('JOB_ACT_INVALID');
}

/** Shared closed object reader for the comments contract; legacy readers retain their rules. */
export function commentsObject(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new JobError('JOB_ACT_INVALID');
  return exactObject(value, keys, 'JOB_ACT_INVALID', optional);
}

function commentCrop(value: unknown): void {
  const crop = commentsObject(value, ['path', 'sha256', 'width', 'height'], ['png']);
  jobSha(crop.sha256);
  validatePngCropMetadata(crop as unknown as Parameters<typeof validatePngCropMetadata>[0]);
  if (Object.hasOwn(crop, 'png')) validatePngCrop(crop as unknown as Parameters<typeof validatePngCrop>[0]);
}

/** Both checkpoint values and pins obey the source's declared checkpoint mapping. */
function assertCommentsCheckpointBinding(source: SourceV3, checkpointId: string, planStepId: string): void {
  if (!source.plan?.steps.some(step => step.id === planStepId) ||
      'record' in source && checkpointId !== planStepId) throw new JobError('JOB_ACT_INVALID');
  const evidence = source.checkpointEvidence?.find(packet => packet.checkpointId === checkpointId);
  if (evidence && evidence.planStepId !== planStepId) throw new JobError('JOB_ACT_INVALID');
}

function parseCommentAnchor(raw: unknown, text: string, source?: SourceV3 | string): JobCommentAnchor {
  const item = commentsObject(raw, [], Object.keys(raw && typeof raw === 'object' ? raw : {}));
  const sourceHash = typeof source === 'string' ? source : source?.sourceHash;
  if ('schema' in item) {
    commentsObject(item, ['schema', 'id', 'parts', 'sourceHash', 'rigRegion', 'imageRegion', 'view', 'crop', 'nativeCrop']);
    const issue = parsePartsIssue({...item, summary: text}, true, false, false);
    const comparison = issue.view.comparison;
    if (comparison?.mode === 'difference' && comparison.operand === 'previous-draft' &&
        (issue.view.mode !== 'assembled' || !source || typeof source === 'string' || 'record' in source || !source.previousDraft)) {
      throw new JobError('JOB_ACT_INVALID');
    }
    if (issue.crop.png !== undefined) validatePngCrop(issue.crop as Parameters<typeof validatePngCrop>[0]);
    if (sourceHash && issue.sourceHash !== sourceHash) throw new JobError('JOB_ACT_SOURCE_STALE');
    if (source && typeof source !== 'string' && !('record' in source)) {
      if (!source.parts || issue.parts.some(part => !source.parts!.images.some(image =>
        image.role === 'part' && image.path === `parts/${part.name}.png` && image.sha256 === part.imageHash))) throw new JobError('JOB_ACT_SOURCE_STALE');
    }
    const {summary: _summary, ...anchor} = issue;
    return anchor;
  }
  if ('frameStart' in item) {
    commentsObject(item, ['id', 'frameStart', 'frameEnd', 'target', 'category'], ['context', 'side']);
    commentsObject(item.target, ['kind', 'name']);
    jobId(item.id);
    if ('side' in item && item.side !== 'a' && item.side !== 'b') throw new JobError('JOB_ACT_INVALID');
    const feedback = parseFeedback({...item, summary: text});
    const context = feedback.context as Record<string, unknown> | undefined;
    if (hasStageComment(context?.comment)) {
      const mark = parseStageComment(context!.comment);
      validatePngCrop(mark.crop);
      if (sourceHash && mark.sourceHash !== sourceHash) throw new JobError('JOB_ACT_SOURCE_STALE');
      if (source && typeof source !== 'string' && !('record' in source) &&
          mark.viewport !== 'reference' && mark.modelHash !== source.model?.sha256) throw new JobError('JOB_ACT_SOURCE_STALE');
    }
    const {summary: _summary, ...anchor} = feedback;
    return {...anchor, ...('side' in item ? {side: item.side as 'a' | 'b'} : {})};
  }
  if ('checkpointId' in item) {
    commentsObject(item, ['checkpointId', 'planStepId']);
    const checkpointId = jobId(item.checkpointId), planStepId = jobId(item.planStepId);
    if (source && typeof source !== 'string') assertCommentsCheckpointBinding(source, checkpointId, planStepId);
    return {checkpointId, planStepId};
  }
  if ('name' in item) {
    commentsObject(item, ['name'], ['imageRegion', 'crop', 'nativeCrop']);
    const name = jobText(item.name);
    if (source) throw new JobError('JOB_ACT_SOURCE_STALE');
    if (Object.keys(item).length === 1) return {name};
    commentsObject(item, ['name', 'imageRegion', 'crop', 'nativeCrop']);
    const region = commentsObject(item.imageRegion, ['x', 'y', 'width', 'height']);
    for (const axis of ['x', 'y', 'width', 'height']) jobInteger(region[axis]);
    if (!region.width || !region.height || Number(region.width) * Number(region.height) > 16777216) throw new JobError('JOB_ACT_INVALID');
    commentsObject(item.nativeCrop, ['path', 'sha256', 'width', 'height']);
    commentCrop(item.crop); commentCrop(item.nativeCrop);
    if ((item.nativeCrop as {width: number}).width !== region.width ||
        (item.nativeCrop as {height: number}).height !== region.height) throw new JobError('JOB_ACT_INVALID');
    return structuredClone(item) as unknown as JobCommentAnchor;
  }
  throw new JobError('JOB_ACT_INVALID');
}

/** Structural/source-identity decoding only. Original asset freshness remains with the retained-source owner. */
export function parseComments(value: unknown, source?: SourceV3 | string): JobComment[] {
  return decodeComments(value, source, false);
}

function decodeComments(value: unknown, source: SourceV3 | string | undefined, withContext: false): JobComment[];
function decodeComments(value: unknown, source: SourceV3 | string | undefined, withContext: true): JobContextComment[];
function decodeComments(value: unknown, source: SourceV3 | string | undefined, withContext: boolean): JobContextComment[] {
  return asCode(() => {
    if (!Array.isArray(value) || value.length > 1000) throw new JobError('JOB_ACT_INVALID');
    const ids = new Set<string>();
    const comments: JobContextComment[] = value.map(raw => {
      const item = commentsObject(raw, ['text'], withContext ? ['anchor', 'context'] : ['anchor']);
      const text = parseActWords(item.text, 'JOB_ACT_INVALID');
      if (!text.trim()) throw new JobError('JOB_ACT_INVALID');
      const context = Object.hasOwn(item, 'context') ? {context: parseCommentContext(item.context, source)} : {};
      if (!Object.hasOwn(item, 'anchor')) return {text, ...context};
      const anchor = parseCommentAnchor(item.anchor, text, source);
      if ('id' in anchor) {
        if (ids.has(anchor.id)) throw new JobError('JOB_ACT_INVALID');
        ids.add(anchor.id);
      }
      return {text, anchor, ...context};
    });
    // The signed projection covers text and anchor only; context restores a view and is not signed text.
    projectComments(comments.map(({text, anchor}) => anchor === undefined ? {text} : {text, anchor}));
    return comments;
  }, 'JOB_ACT_INVALID');
}

/** act@7 comment context. Each field reuses the decoder of the pin or restore path it copies. */
function parseCommentContext(raw: unknown, source?: SourceV3 | string): JobCommentContext {
  const item = commentsObject(raw, [], ['subject', 'mode', 'tab', 'part', 'region', 'viewMode', 'camera', 'frame']);
  if (!Object.keys(item).length) throw new JobError('JOB_ACT_INVALID');
  const out: Record<string, unknown> = {};
  if ('subject' in item) {
    const subject = commentsObject(item.subject, ['ask', 'sourceHash'], ['selector']);
    const ask = parseJobSubject(subject.ask), sourceHash = jobSha(subject.sourceHash);
    const selector = 'selector' in subject ? parseJobSelector(subject.selector) : undefined;
    if (selector === null) throw new JobError('JOB_ACT_INVALID');
    const bound = typeof source === 'string' ? source : source?.sourceHash;
    if (bound && sourceHash !== bound) throw new JobError('JOB_ACT_SOURCE_STALE');
    if (selector && source && typeof source !== 'string' && !('record' in source) &&
        JSON.stringify(selector) !== JSON.stringify(source.selector)) throw new JobError('JOB_ACT_SOURCE_STALE');
    out.subject = {ask, sourceHash, ...(selector ? {selector} : {})};
  }
  if ('mode' in item) {
    if (!(commentModes as readonly unknown[]).includes(item.mode)) throw new JobError('JOB_ACT_INVALID');
    out.mode = item.mode;
  }
  if ('tab' in item) {
    // The inspector values parseBookmark accepts (web/inspection-persistence.ts).
    if (!['view', 'rig', 'playback', 'feedback'].includes(item.tab as string)) throw new JobError('JOB_ACT_INVALID');
    out.tab = item.tab;
  }
  if ('part' in item) {
    const part = parseControlPart(item.part);
    if (!part) throw new JobError('JOB_ACT_INVALID');
    out.part = part;
  }
  if ('region' in item) {
    const region = commentsObject(item.region, ['x', 'y', 'width', 'height']);
    for (const axis of ['x', 'y', 'width', 'height']) {
      const n = region[axis];
      if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new JobError('JOB_ACT_INVALID');
    }
    if ((region.width as number) < 0 || (region.height as number) < 0) throw new JobError('JOB_ACT_INVALID');
    out.region = {x: region.x, y: region.y, width: region.width, height: region.height};
  }
  if ('viewMode' in item) {
    if (item.viewMode !== 'item' && item.viewMode !== 'assembled') throw new JobError('JOB_ACT_INVALID');
    out.viewMode = item.viewMode;
  }
  if ('camera' in item) {
    const space = (item.camera as {space?: unknown} | null)?.space;
    if (space !== 'world' && space !== 'image') throw new JobError('JOB_ACT_INVALID');
    const cameras = {rig: null, a: null, b: null, reference: null, [space === 'world' ? 'rig' : 'reference']: item.camera};
    const view = parseControlView({schema: 'rig-review-view/1', cameras});
    out.camera = space === 'world' ? view.cameras.rig : view.cameras.reference;
  }
  if ('frame' in item) {
    const frame = commentsObject(item.frame, ['index', 'basis']);
    if (!Number.isSafeInteger(frame.index) || (frame.index as number) < 0 ||
        (frame.basis !== 'producer' && frame.basis !== 'reference')) throw new JobError('JOB_ACT_INVALID');
    out.frame = {index: frame.index, basis: frame.basis};
  }
  return out as JobCommentContext;
}

function commentsSource(raw: unknown): Exclude<SourceV3, OptionSource> {
  if (isRecordSource(raw)) {
    const record = parseRecordSource(raw);
    if (record.subject !== 'plan') throw new JobError('JOB_ACT_INVALID');
    return record;
  }
  const common = ['sourceHash', 'projectHash', 'package', 'direction', 'optionSet', 'appliedResult', 'plan', 'parts'];
  const item = commentsObject(raw, [...common, 'selector', 'model'], ['checkpointEvidence', 'previousDraft']);
  jobSha(item.sourceHash); if (item.projectHash !== null) jobSha(item.projectHash);
  const pkg = commentsObject(item.package, ['id', 'revision']); jobText(pkg.id); jobText(pkg.revision);
  for (const key of ['direction', 'model']) if (item[key] !== null) parseFileRow(item[key], 'JOB_ACT_INVALID');
  const selector = parseJobSelector(item.selector);
  const previousDraft = previousDraftFields(item, selector);
  if (previousDraft.previousDraft && item.parts === null) throw new JobError('JOB_ACT_INVALID');
  if (item.optionSet !== null) {
    const set = commentsObject(item.optionSet, ['id', 'sha256']); jobId(set.id); jobSha(set.sha256);
  }
  if (item.appliedResult !== null) {
    const applied = commentsObject(item.appliedResult, ['id', 'modelHash']); jobId(applied.id); jobSha(applied.modelHash);
  }
  if (item.plan !== null) parsePlanIdentity(item.plan, 'JOB_ACT_INVALID');
  if (item.parts !== null) parseJobPartsIdentity(item.parts);
  if ('checkpointEvidence' in item) {
    if (!Array.isArray(item.checkpointEvidence)) throw new JobError('JOB_ACT_INVALID');
    // Validate the declared packet with the existing codec. Actual closure seals remain
    // with the retained-source owner; a decoder has neither files nor source authority.
    const declarations = item.checkpointEvidence.map(raw => commentsObject(raw,
      ['schema', 'checkpointId', 'planStepId', 'tiles', 'table', 'routesText', 'recommendationText']));
    const subjects = declarations.map(row => ({kind: 'checkpoint' as const, checkpointId: jobId(row.checkpointId), planStepId: jobId(row.planStepId)}));
    const files = declarations.flatMap(row => {
      if (!Array.isArray(row.tiles)) throw new JobError('JOB_ACT_INVALID');
      return [...row.tiles, row.table].map(file => parseFileRow(
        {path: (file as JobFileIdentity)?.path, sha256: (file as JobFileIdentity)?.sha256}, 'JOB_ACT_INVALID'));
    });
    checkpointEvidenceFields(item, item.plan as JobPlanIdentity | null, subjects, files);
  }
  return structuredClone(item) as unknown as Exclude<SourceV3, OptionSource>;
}

export function isRigDraftVerdictSource(source: JobSourceBinding): boolean {
  return source.selector?.kind === 'draft' && !!source.model && !!source.projectHash && source.direction === null;
}

/** Public @6 decoder. The UI finalizers write checkpoint, parts, rig/post verdict and signoff acts at @6 (#713). */
export function parseCommentsAct(raw: unknown): JobCommentsAct {
  return decodeCommentsAct(raw, JOB_COMMENTS_ACT_SCHEMA) as JobCommentsAct;
}

/** Public @7 decoder: the @6 rules plus an optional `context` on each comment. @6 input refuses. */
export function parseContextCommentsAct(raw: unknown): JobContextCommentsAct {
  return decodeCommentsAct(raw, JOB_COMMENT_CONTEXT_ACT_SCHEMA) as JobContextCommentsAct;
}

/** Public @8 decoder. Model freshness and topology are checked by the writer. */
export function parseMeshEditsAct(raw: unknown): JobMeshEditsAct {
  return decodeCommentsAct(raw, JOB_MESH_EDITS_ACT_SCHEMA) as JobMeshEditsAct;
}

export function parseChestLandmarksAct(raw: unknown): JobChestLandmarksAct {
  return decodeCommentsAct(raw, JOB_CHEST_LANDMARKS_ACT_SCHEMA) as JobChestLandmarksAct;
}

export function meshEditDigest(edit: JobMeshEditValue): JobSha256 {
  return jobHash(canonicalJson(edit));
}

function meshNumber(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Object.is(raw, -0)) throw new JobError('JOB_ACT_INVALID');
  return raw;
}

function meshPair(raw: unknown, parse: (value: unknown) => number): Vec {
  if (!Array.isArray(raw) || raw.length !== 2) throw new JobError('JOB_ACT_INVALID');
  return [parse(raw[0]), parse(raw[1])];
}

function roundedMeshPair(raw: unknown): void {
  const pair = meshPair(raw, meshNumber);
  // A multiply-round-divide pass can change an already rounded large double.
  if (pair.some(n => Number(n.toFixed(2)) !== n)) throw new JobError('JOB_ACT_INVALID');
}

const meshIndex = (raw: unknown): number => jobInteger(meshNumber(raw));

function validateMeshOp(raw: unknown): void {
  const op = (raw as {op?: unknown} | null)?.op;
  switch (op) {
    case 'move': {
      const move = commentsObject(raw, ['op', 'v', 'from', 'to']);
      meshIndex(move.v); meshPair(move.from, meshNumber); roundedMeshPair(move.to);
      break;
    }
    case 'add': {
      const add = commentsObject(raw, ['op', 'at'], ['onEdge']);
      roundedMeshPair(add.at);
      if (Object.hasOwn(add, 'onEdge')) meshPair(add.onEdge, meshIndex);
      break;
    }
    case 'remove':
      meshIndex(commentsObject(raw, ['op', 'v']).v);
      break;
    case 'edge':
    case 'unedge': {
      const edge = commentsObject(raw, ['op', 'a', 'b']);
      meshIndex(edge.a); meshIndex(edge.b);
      break;
    }
    default:
      throw new JobError('JOB_ACT_INVALID');
  }
}

function validateMeshEdit(raw: unknown): asserts raw is JobMeshEditValue {
  const edit = commentsObject(raw, ['slot', 'skin', 'attachment', 'basis', 'source', 'ops']);
  if (edit.basis !== 'setup' || [edit.slot, edit.skin, edit.attachment].some(name => typeof name !== 'string' || !name)) {
    throw new JobError('JOB_ACT_INVALID');
  }
  const source = commentsObject(edit.source, ['vertexCount', 'triangleCount', 'hullLength', 'hash', 'frame', 'positions']);
  const vertexCount = meshIndex(source.vertexCount);
  meshIndex(source.triangleCount); meshIndex(source.hullLength); jobSha(source.hash);
  const frame = commentsObject(source.frame, ['width', 'height']);
  if (meshNumber(frame.width) <= 0 || meshNumber(frame.height) <= 0 ||
      !Array.isArray(source.positions) || source.positions.length !== vertexCount) throw new JobError('JOB_ACT_INVALID');
  for (const position of source.positions) meshPair(position, meshNumber);
  if (!Array.isArray(edit.ops) || !edit.ops.length || edit.ops.length > MESH_EDIT_MAX_OPS) throw new JobError('JOB_ACT_INVALID');
  for (const op of edit.ops) validateMeshOp(op);
}

/** Structures and digests only. The retained model is the writer's source of topology and freshness. */
export function parseMeshEdits(raw: unknown): readonly JobMeshEdit[] {
  return asCode(() => {
    if (!Array.isArray(raw) || !raw.length) throw new JobError('JOB_ACT_INVALID');
    const seen = new Set<string>();
    let previousOrder: string | undefined;
    for (const item of raw) {
      const {edit, sha256} = commentsObject(item, ['edit', 'sha256']);
      validateMeshEdit(edit);
      const identity = [edit.skin, edit.slot, edit.attachment];
      const order = identity.join('/'), key = JSON.stringify(identity);
      if (seen.has(key) || (previousOrder !== undefined && order < previousOrder) || jobSha(sha256) !== meshEditDigest(edit)) {
        throw new JobError('JOB_ACT_INVALID');
      }
      seen.add(key);
      previousOrder = order;
    }
    return structuredClone(raw) as JobMeshEdit[];
  }, 'JOB_ACT_INVALID');
}

function parseChestLandmarkValue(raw: unknown, code: JobErrorCode): JobChestLandmarkValue;
function parseChestLandmarkValue(raw: unknown, code: JobErrorCode, published: true): JobPublishedChestLandmark;
function parseChestLandmarkValue(raw: unknown, code: JobErrorCode, published = false): JobChestLandmarkValue | JobPublishedChestLandmark {
  const value = exactObject(raw, ['slot', 'skin', 'attachment', 'basis', 'source', 'bust'], code);
  if (value.basis !== 'setup') throw new JobError(code);
  const source = exactObject(value.source, published ? ['hash', 'frame', 'configHash'] : ['hash', 'frame'], code);
  const frame = exactObject(source.frame, ['width', 'height'], code);
  const width = meshNumber(frame.width), height = meshNumber(frame.height);
  if (width <= 0 || height <= 0) throw new JobError(code);
  const bust = parseBustSpec(value.bust, 'bust', true);
  for (const point of [bust.apex_r, bust.apex_l, bust.cleavage]) {
    if (point && (point[0] < 0 || point[0] > width || point[1] < 0 || point[1] > height)) throw new JobError(code);
  }
  return {
    slot: jobText(value.slot), skin: jobText(value.skin), attachment: jobText(value.attachment), basis: 'setup',
    source: {hash: jobSha(source.hash), frame: {width, height}, ...(published ? {configHash: jobSha(source.configHash)} : {})}, bust,
  };
}

export function chestLandmarkIdentity(edit: JobChestLandmarkValue): string {
  return JSON.stringify([edit.skin, edit.slot, edit.attachment]);
}

/** The seed and act use the same bounds and identity order. The act wraps each row in a digest. */
function readChestLandmarkRows<Row>(raw: unknown, code: JobErrorCode,
  read: (item: unknown) => {edit: JobChestLandmarkValue; row: Row}): readonly Row[] {
  return asCode(() => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new JobError(code);
    const seen = new Set<string>();
    let previousOrder: string | undefined;
    return Array.from(raw, item => {
      const {edit, row} = read(item);
      const key = chestLandmarkIdentity(edit), order = [edit.skin, edit.slot, edit.attachment].join('/');
      if (seen.has(key) || (previousOrder !== undefined && order < previousOrder)) throw new JobError(code);
      seen.add(key);
      previousOrder = order;
      return row;
    });
  }, code);
}

export function parsePublishedChestLandmarks(raw: unknown): readonly JobPublishedChestLandmark[] {
  return readChestLandmarkRows(raw, 'JOB_SOURCE_MISMATCH', item => {
    const edit = parseChestLandmarkValue(item, 'JOB_SOURCE_MISMATCH', true);
    return {edit, row: edit};
  });
}

export function parseChestLandmarkEdits(raw: unknown): readonly JobChestLandmarkEdit[] {
  return readChestLandmarkRows(raw, 'JOB_ACT_INVALID', item => {
    const {edit: value, sha256} = commentsObject(item, ['edit', 'sha256']);
    const edit = parseChestLandmarkValue(value, 'JOB_ACT_INVALID');
    if (jobSha(sha256) !== requestDigest(value)) throw new JobError('JOB_ACT_INVALID');
    return {edit, row: structuredClone(item) as unknown as JobChestLandmarkEdit};
  });
}

/** Write @7 when a comment carries context, otherwise keep the @6 envelope. */
export function commentsActForEmission(act: JobCommentsAct | JobContextCommentsAct): JobCommentsAct | JobContextCommentsAct {
  const value = act.value as {comments: readonly JobContextComment[]};
  const schema = value.comments.some(comment => Object.hasOwn(comment, 'context')) ? JOB_COMMENT_CONTEXT_ACT_SCHEMA : JOB_COMMENTS_ACT_SCHEMA;
  const next = {...act, schema};
  return schema === JOB_COMMENTS_ACT_SCHEMA ? parseCommentsAct(next) : parseContextCommentsAct(next);
}

/** Write @8 for a rig verdict carrying mesh evidence. */
export function meshEditsActForEmission(act: JobCommentsAct | (Extract<JobCommentsAct, {kind: 'review-verdict'}> & {
  readonly value: {readonly meshEdits: readonly JobMeshEdit[]};
})): JobCommentsAct | Extract<JobAct, {schema: typeof JOB_MESH_EDITS_ACT_SCHEMA}> {
  if (!Object.hasOwn(act.value, 'meshEdits')) {
    parseCommentsAct(act);
    return act;
  }
  return parseMeshEditsAct({...act, schema: JOB_MESH_EDITS_ACT_SCHEMA}) as Extract<JobAct, {schema: typeof JOB_MESH_EDITS_ACT_SCHEMA}>;
}

type CommentsWireAct = JobCommentsAct | JobContextCommentsAct | JobMeshEditsAct | JobChestLandmarksAct;

function decodeCommentsAct(raw: unknown, schema: CommentsWireAct['schema']): CommentsWireAct {
  return asCode(() => {
    const item = commentsObject(raw, ['schema', 'actId', 'jobId', 'askId', 'publicationId', 'kind', 'authority', 'at', 'source', 'value'], ['still']);
    if (item.schema !== schema) throw new JobError('JOB_ACT_INVALID');
    for (const key of ['actId', 'jobId', 'askId', 'publicationId']) jobId(item[key]);
    parseHumanAuthority(item.authority, 'JOB_ACT_INVALID');
    if (typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) throw new JobError('JOB_ACT_INVALID');
    const source = commentsSource(item.source);
    const fields: Record<string, readonly string[]> = {
      checkpoint: ['checkpointId', 'planStepId', 'outcome', 'comments'],
      'parts-verdict': ['verdict', 'comments'], 'review-verdict': ['stage', 'verdict', 'comments'],
      signoff: ['stage', 'decision', 'comments'], reopen: ['stage', 'comments'],
    };
    const keys = typeof item.kind === 'string' && Object.hasOwn(fields, item.kind) ? fields[item.kind] : undefined;
    if (!keys) throw new JobError('JOB_ACT_INVALID');
    const at9 = schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA;
    const supportsMesh = schema === JOB_MESH_EDITS_ACT_SCHEMA || at9;
    const value = commentsObject(item.value, at9 ? [...keys, 'chestLandmarks'] : keys,
      supportsMesh && item.kind === 'review-verdict' ? ['meshEdits'] : []);
    const comments = schema === JOB_COMMENTS_ACT_SCHEMA ? parseComments(value.comments, source) : decodeComments(value.comments, source, true);
    if (comments.some(comment => comment.anchor && 'side' in comment.anchor)) throw new JobError('JOB_ACT_INVALID');
    if ((comments as readonly JobContextComment[]).some(comment => comment.context?.subject &&
        comment.context.subject.ask.kind !== item.kind)) throw new JobError('JOB_ACT_INVALID');
    if (item.kind === 'checkpoint') {
      const checkpointId = jobId(value.checkpointId), planStepId = jobId(value.planStepId);
      if (typeof value.outcome !== 'string' || !['pass', 'fail'].includes(value.outcome)) throw new JobError('JOB_ACT_INVALID');
      assertCommentsCheckpointBinding(source, checkpointId, planStepId);
    } else if (item.kind === 'parts-verdict') {
      if ('record' in source || source.selector?.kind !== 'draft' || !source.parts || !source.projectHash ||
          typeof value.verdict !== 'string' || !['approved', 'changes-requested'].includes(value.verdict)) throw new JobError('JOB_ACT_INVALID');
      const issues = comments.filter(comment => comment.anchor && 'schema' in comment.anchor).length;
      if ((value.verdict === 'approved') !== (issues === 0)) throw new JobError('JOB_ACT_INVALID');
    } else if (item.kind === 'review-verdict') {
      if ('record' in source || typeof value.verdict !== 'string' || !['pending', 'approved', 'changes-requested'].includes(value.verdict)) throw new JobError('JOB_ACT_INVALID');
      if (!source.model || (value.stage === 'rig-review' ? source.selector?.kind !== 'rig' && !isRigDraftVerdictSource(source) : value.stage !== 'direction-review' || source.selector?.kind !== 'post' || !source.direction)) throw new JobError('JOB_ACT_INVALID');
    } else {
      const stage = jobId(value.stage);
      if (item.kind === 'signoff' && value.decision !== 'approved') throw new JobError('JOB_ACT_INVALID');
      if (item.kind === 'reopen' && !('record' in source)) throw new JobError('JOB_ACT_INVALID');
      const planBoundStages = 'record' in source ? JOB_RECORD_SIGNOFF_STAGES : JOB_PLAN_BOUND_SIGNOFF_STAGES;
      if (item.kind === 'signoff' && (planBoundStages as readonly string[]).includes(stage) && !source.plan?.steps.length) throw new JobError('JOB_ACT_INVALID');
    }
    if ('record' in source) validateRecordAskSubject(item.kind === 'checkpoint' ? {kind: item.kind, checkpointId: value.checkpointId} :
      {kind: item.kind, stage: value.stage}, source);
    const rig = item.kind === 'review-verdict' && value.stage === 'rig-review';
    let chestLandmarks: readonly JobChestLandmarkEdit[] | undefined;
    if (at9) {
      if (!rig || value.verdict !== 'changes-requested') throw new JobError('JOB_ACT_INVALID');
      chestLandmarks = parseChestLandmarkEdits(value.chestLandmarks);
    }
    let meshEdits: readonly JobMeshEdit[] | undefined;
    if (supportsMesh && Object.hasOwn(value, 'meshEdits')) {
      if (!rig || value.verdict !== 'changes-requested') throw new JobError('JOB_ACT_INVALID');
      meshEdits = parseMeshEdits(value.meshEdits);
    }
    if (supportsMesh && item.kind === 'review-verdict' && value.verdict === 'changes-requested' && !comments.length && !meshEdits && !chestLandmarks) {
      throw new JobError('JOB_ACT_INVALID');
    }
    if (rig) {
      const still = commentsObject(item.still, ['path', 'sha256', 'camera', 'frame'], ['animation']);
      if (still.path !== jobSha(still.sha256) + '.png' || still.camera !== 'fixed' ||
          (still.frame === 'setup' ? 'animation' in still : typeof still.frame !== 'number' || !Number.isFinite(still.frame) ||
            still.frame < 0 || typeof still.animation !== 'string' || !still.animation)) throw new JobError('JOB_ACT_INVALID');
    } else if ('still' in item) throw new JobError('JOB_ACT_INVALID');
    return {...structuredClone(item), source, value: {...value, comments, ...(meshEdits ? {meshEdits} : {}),
      ...(chestLandmarks ? {chestLandmarks} : {})}} as unknown as CommentsWireAct;
  }, 'JOB_ACT_INVALID');
}

export async function jobBody(request: Request, maximum = jobBodyLimit, validateSize?: (value: unknown, size: number) => void): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new JobError('JOB_REQUEST_INVALID');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new JobError('JOB_REQUEST_INVALID', 'Request cancelled'));
    timer = setTimeout(abort, requestDeadlineMs);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.length;
      if (size > maximum) throw new JobError('JOB_BODY_LIMIT');
      chunks.push(value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    validateSize?.(value, size);
    if (value?.value != null && Object.hasOwn(value.value, 'meshEdits') &&
        Buffer.byteLength(canonicalJson(value.value.meshEdits)) > jobBodyLimit) {
      throw new JobError('JOB_BODY_LIMIT');
    }
    if (size > jobBodyLimit) {
      const hasCommentImages = ['parts-verdict', 'review-verdict', 'checkpoint', 'signoff', 'reopen'].includes(value?.kind) &&
        /"png":"data:image\/png;base64,/.test(JSON.stringify(value?.value));
      const rigCapture = value?.kind === 'review-verdict' && value?.value?.stage === 'rig-review' && value.capture;
      if (!(maximum > jobBodyLimit && (rigCapture || hasCommentImages))) throw new JobError('JOB_BODY_LIMIT');
    }
    return value;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_REQUEST_INVALID');
  } finally {
    clearTimeout(timer);
    if (abort) request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function jobFailure(error: unknown): { ok: false; error: { code: JobError['code']; message: string } } {
  const known = error instanceof JobError ? error : new JobError('JOB_STORAGE_FAILED');
  return { ok: false, error: { code: known.code, message: known.message } };
}

const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** The supplied origin is the actual listener origin, not a client header. */
export function createJobHostPorts(session: JobSession, origin: string): JobHostPorts {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new JobError('JOB_LOOPBACK_REQUIRED');
  }
  const base = `/jobs/${session.jobId}`;
  function gate(request: Request, path: string, ui: boolean): void {
    const url = new URL(request.url);
    if (url.origin !== origin) throw new JobError('JOB_LOOPBACK_REQUIRED');
    if (request.method !== 'POST' || url.pathname !== path || url.search || url.hash) throw new JobError('JOB_REQUEST_INVALID');
    const sent = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site' ||
        (ui ? sent !== origin : sent !== null && sent !== origin)) throw new JobError('JOB_SAME_ORIGIN_REQUIRED');
  }
  async function uiCall<Value>(job: string, request: Request, path: string, action: (body: unknown) => Promise<Value>, maximum = jobBodyLimit): Promise<JobResult<Value>> {
    try {
      if (job !== session.jobId) throw new JobError('JOB_UNKNOWN');
      gate(request, path, true);
      session.authorize('ui', request.headers.get('X-Review-Capability'));
      return { ok: true, value: await action(await jobBody(request, maximum)) };
    } catch (error) { return jobFailure(error); }
  }
  return {
    async handleJobApi(request) {
      let input: JobAgentRequest | AgentRequestV3 | JobFetchActRequest | FetchActRequestV3 | null = null;
      let responseSchema: typeof JOB_API_SCHEMA | typeof JOB_API_V3_SCHEMA = session.apiSchema;
      try {
        const cropUrl = new URL(request.url);
        const crop = new RegExp('^' + base + '/comment-crops/([a-f0-9]{64})\\.png$').exec(cropUrl.pathname);
        if (crop && request.method === 'GET' && cropUrl.origin === origin && !cropUrl.search && !cropUrl.hash) {
          if (request.headers.get('sec-fetch-site') === 'cross-site' ||
              request.headers.get('origin') !== null && request.headers.get('origin') !== origin) {
            throw new JobError('JOB_SAME_ORIGIN_REQUIRED');
          }
          session.authorize('ui-evidence', request.headers.get('X-Review-Capability'));
          return new Response(new Uint8Array(session.readCommentCrop(crop[1]!)),
            {headers: {...responseHeaders, 'Content-Type': 'image/png'}});
        }
        gate(request, base + '/api', false);
        const body = await jobBody(request, jobBodyLimit, (value, size) => {
          if (size > jobProgressBodyLimit && (value as { verb?: unknown } | null)?.verb === 'progress') {
            throw new JobError('JOB_REQUEST_INVALID');
          }
        });
        const mode: JobPublicationMode =
          session.publicationMode === 'record-and-package' &&
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          (body as { schema?: unknown }).schema === JOB_API_SCHEMA
            ? 'package-only'
            : session.publicationMode;
        responseSchema = jobApiSchemaForMode(mode);
        input = parseJobRequest(body, mode);
        if (input.jobId !== session.jobId) throw new JobError('JOB_UNKNOWN');
        session.authorize(input.verb === 'fetch-act' ? 'consumer' : 'agent', request.headers.get('authorization'));
        if (input.verb === 'fetch-act') {
          const accept = request.headers.get('accept');
          if (accept === jobRawActMediaType || accept === 'image/png') {
            if (request.signal.aborted) throw new JobError('JOB_REQUEST_INVALID');
            const bytes = session.readActExport(input.actId, accept === 'image/png');
            return new Response(new Uint8Array(bytes), {headers: {...responseHeaders,
              'Content-Type': accept, 'Content-Length': String(bytes.byteLength)}});
          }
          if (accept && accept !== '*/*' && accept !== 'application/json') throw new JobError('JOB_REQUEST_INVALID');
        }
        const value = await session.execute(input, request.signal);
        return Response.json({ schema: responseSchema, verb: input.verb, jobId: input.jobId, requestId: input.requestId,
          generation: session.status().generation, ok: true, value }, { headers: responseHeaders });
      } catch (error) {
        const failure = jobFailure(error);
        const status = failure.error.code.includes('CAPABILITY') || failure.error.code === 'JOB_AUTHORITY_REFUSED' ? 403 :
          failure.error.code === 'JOB_BODY_LIMIT' ? 413 : failure.error.code === 'JOB_REQUEST_INVALID' ? 400 : 409;
        return Response.json({ schema: responseSchema, verb: input?.verb ?? null, jobId: session.jobId,
          requestId: input?.requestId ?? null, generation: session.lastObservedGeneration, ...failure }, { status, headers: responseHeaders });
      }
    },
    subscribeJob: input => session.subscribe(input),
    ...(session.apiSchema === JOB_API_V3_SCHEMA ? {
      subscribeJobPage: (input: Parameters<JobHostPorts['subscribeJob']>[0]) => session.subscribe(input, true),
    } : {}),
    async readPublication(job, publication) {
      try {
        if (job !== session.jobId) throw new JobError('JOB_UNKNOWN');
        return { ok: true, value: session.displayPublication(publication) };
      } catch (error) { return jobFailure(error); }
    },
    commitUIAct: (job, request) => uiCall(job, request, base + '/ui/acts', body => session.commitUIAct(body), jobCaptureBodyLimit),
    ackDisplayed: (job, request) => uiCall(job, request, base + '/ui/displayed', async body => {
      const item = jobObject(body, ['publicationId', 'pageId', 'sourceHash']);
      const ack: JobDisplayAcknowledgment = {
        publicationId: jobId(item.publicationId), pageId: jobId(item.pageId), sourceHash: jobSha(item.sourceHash),
      };
      return session.ackDisplayed(ack);
    }),
    async jobLiveness(job) {
      try {
        if (job !== session.jobId) throw new JobError('JOB_UNKNOWN');
        return { ok: true, value: { active: session.status().status === 'active', busy: session.busy } };
      } catch (error) { return jobFailure(error); }
    },
  };
}
