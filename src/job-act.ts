import { randomUUID } from 'node:crypto';
import {
  JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_RECORD_ACT_KINDS, JOB_ENABLED_ACT_KINDS, JOB_RESERVED_ACT_KINDS,
  type JobApiSchema, type JobPublicationMode, type JobReviewerBinding,
  type JobUISubmission,
  type JobMeshEdit, type PendingAskV3, type RecordUIAct, type RecordSource, type RecordSubject, type SourceV3, type UISubmissionV3,
  type JobChestLandmarkEdit, type JobCommentCarrier, type JobCommentOnlyAct, type JobCommentUISubmission,
  JOB_COMMENT_ONLY_ACT_SCHEMA,
} from './job-contract.ts';
import {
  isRecordSource, commentsObject, jobId, jobInteger, jobObject,
  parseMeshEdits, parseRecordSource, requestDigest, validateRecordAskSubject,
  chestLandmarkIdentity, parseChestLandmarkEdits, parseCommentOnlyAct,
} from './job-api.ts';
import {
  isRetainedRecordSource,
  readJobEditMesh,
  readJobEditModel,
  type JobRetainedRecordSource,
  type JobRetainedSource,
  type JobRetainedSourceV3,
} from './job-source.ts';
import { JobError } from './job-store.ts';
import {applyMeshOps} from './mesh-edit.ts';
import {deriveBust} from './chest-landmarks.ts';

function validateRetainedMeshEdits(model: ReturnType<typeof readJobEditModel>, edits: readonly JobMeshEdit[]): void {
  for (const {edit} of edits) {
    const mesh = readJobEditMesh(model, edit, 'JOB_ACT_SOURCE_STALE', 'JOB_ACT_INVALID');
    const {positions, vertexCount, triangleCount, hullLength, hash} = edit.source;
    const uvs = mesh.entry.uvs;
    if (!Array.isArray(uvs) || uvs.length !== vertexCount * 2 ||
        mesh.vertices.length !== vertexCount || positions.length !== vertexCount ||
        mesh.triangles.length !== triangleCount * 3 || mesh.hull !== hullLength) {
      throw new JobError('JOB_ACT_INVALID');
    }
    try {
      applyMeshOps({slot: edit.slot, attachment: edit.attachment, skin: edit.skin,
        vertices: positions, triangles: mesh.triangles, hull: hullLength, hash}, edit.ops);
    } catch {
      throw new JobError('JOB_ACT_INVALID');
    }
  }
}

function validateRetainedChestLandmarks(retained: JobRetainedSource, model: ReturnType<typeof readJobEditModel>,
  edits: readonly JobChestLandmarkEdit[]): void {
  const seeds = new Set(retained.chestLandmarks?.map(chestLandmarkIdentity));
  for (const {edit} of edits) {
    readJobEditMesh(model, edit, 'JOB_ACT_SOURCE_STALE', 'JOB_ACT_INVALID');
    if (!seeds.has(chestLandmarkIdentity(edit))) throw new JobError('JOB_ACT_INVALID');
    const {cleavage} = edit.bust;
    if (cleavage) {
      const {refusal} = deriveBust({...edit.bust, cleavage});
      if (refusal) throw new JobError('JOB_ACT_INVALID', refusal);
    }
  }
}

export function bindJobRecordAsk(subject: unknown, retained: JobRetainedRecordSource): RecordSource {
  const source = structuredClone(parseRecordSource(retained.source));
  const parsedSubject = validateRecordAskSubject(subject, source);
  if (
    requestDigest(retained.subjects) !== requestDigest(source.subjects) ||
    !retained.subjects.some(candidate => requestDigest(candidate) === requestDigest(parsedSubject))
  ) {
    throw new JobError('JOB_ASK_INVALID');
  }
  throw new JobError('JOB_ASK_INVALID');
}

export function parseUISubmission(
  value: unknown,
  mode?: typeof JOB_API_SCHEMA | 'package-only',
): JobUISubmission;
export function parseUISubmission(
  value: unknown,
  mode: typeof JOB_API_V3_SCHEMA | 'record-and-package',
): UISubmissionV3;
export function parseUISubmission(
  value: unknown,
  mode?: JobApiSchema | JobPublicationMode,
): UISubmissionV3;
export function parseUISubmission(
  value: unknown,
  mode: JobApiSchema | JobPublicationMode = JOB_API_SCHEMA,
): JobUISubmission | UISubmissionV3 {
  const item = jobObject(value, ['publicationId', 'askId', 'pageId', 'displayedNonce', 'expectedGeneration', 'submissionId', 'kind', 'value', 'capture']);
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ACT_KIND_DISABLED');
  jobId(item.publicationId); jobId(item.askId); jobId(item.pageId); jobId(item.displayedNonce); jobId(item.submissionId);
  jobInteger(item.expectedGeneration);
  const recordEnabled = mode === JOB_API_V3_SCHEMA || mode === 'record-and-package';
  const kind = String(item.kind);
  const allowed = (JOB_ENABLED_ACT_KINDS as readonly string[]).includes(kind) ||
    (recordEnabled && (JOB_RECORD_ACT_KINDS as readonly string[]).includes(kind));
  if (!allowed) {
    throw new JobError('JOB_ACT_INVALID');
  }
  if (item.capture !== undefined && (item.kind !== 'review-verdict' ||
    (item.value as {stage?: unknown} | null)?.stage !== 'rig-review')) throw new JobError('JOB_REQUEST_INVALID');
  return item as unknown as UISubmissionV3;
}

/** #1226: the comment-only submission answers no ask and carries no still; `parseUISubmission` keeps refusing it. */
export function isCommentUISubmission(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as {kind?: unknown}).kind === 'comments';
}

export function parseCommentUISubmission(value: unknown): JobCommentUISubmission {
  const item = jobObject(value, ['publicationId', 'askId', 'pageId', 'displayedNonce', 'expectedGeneration', 'submissionId', 'kind', 'value', 'capture']);
  if (item.kind !== 'comments' || Object.hasOwn(item, 'askId') || Object.hasOwn(item, 'capture')) throw new JobError('JOB_ACT_INVALID');
  jobId(item.publicationId); jobId(item.pageId); jobId(item.displayedNonce); jobId(item.submissionId);
  jobInteger(item.expectedGeneration);
  return item as unknown as JobCommentUISubmission;
}

/** #1226: the act@10 writer. The daemon has already matched the page receipt to the head publication; the source is
 * the retained, sealed source of that publication. Carriers are re-checked against the retained model like @8/@9. */
export function finalizeCommentOnlyAct(options: {
  readonly jobId: string;
  readonly submission: JobCommentUISubmission;
  readonly retained: JobRetainedSourceV3;
  readonly reviewer: JobReviewerBinding;
}): JobCommentOnlyAct {
  const {submission, retained, reviewer} = options;
  if (!reviewer.id || !['owner', 'delegate'].includes(reviewer.role)) throw new JobError('JOB_AUTHORITY_REFUSED');
  const value = commentsObject(submission.value, ['comments'], ['carriers']);
  let source: SourceV3;
  if (isRetainedRecordSource(retained)) {
    const {directionReview: _directionReview, ...record} = structuredClone(parseRecordSource(retained.source));
    source = record;
  } else {
    source = structuredClone(retained.source);
  }
  if (Object.hasOwn(value, 'carriers')) {
    const model = isRetainedRecordSource(retained) ? null : retained.source.model;
    if (!Array.isArray(value.carriers) || !model) throw new JobError('JOB_ACT_INVALID');
    const carriers = value.carriers as readonly Partial<JobCommentCarrier>[];
    // A carrier edits the displayed model file; any other file is a stale view.
    if (carriers.some(carrier => carrier?.file?.path !== model.path || carrier.file.sha256 !== model.sha256)) {
      throw new JobError('JOB_ACT_SOURCE_STALE');
    }
    const retainedPackage = retained as JobRetainedSource;
    const edits = readJobEditModel(retainedPackage.snapshotRoot, model, 'JOB_ACT_SOURCE_STALE');
    for (const carrier of carriers) {
      if (carrier.kind === 'mesh-edits') validateRetainedMeshEdits(edits, parseMeshEdits(carrier.meshEdits));
      if (carrier.kind === 'chest-landmarks') validateRetainedChestLandmarks(retainedPackage, edits, parseChestLandmarkEdits(carrier.chestLandmarks));
    }
  }
  return parseCommentOnlyAct({
    schema: JOB_COMMENT_ONLY_ACT_SCHEMA, actId: randomUUID(), jobId: options.jobId, publicationId: submission.publicationId,
    kind: 'comments', authority: {actor: 'human', channel: 'review-ui', reviewer: structuredClone(reviewer)},
    at: new Date().toISOString(), source, value: structuredClone(value),
  });
}

export function prepareJobRecordAct(options: {
  readonly jobId: string;
  readonly submission: UISubmissionV3;
  readonly ask: PendingAskV3;
  readonly retained: JobRetainedRecordSource;
  readonly reviewer: JobReviewerBinding;
  readonly still?: unknown;
  readonly actId?: string;
  readonly at?: string;
}): RecordUIAct {
  const { submission, ask, retained, reviewer } = options;
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  const rawSubmission = submission as unknown as Record<string, unknown>;
  if (
    options.still !== undefined ||
    rawSubmission.capture !== undefined ||
    'authority' in rawSubmission ||
    'source' in rawSubmission
  ) {
    throw new JobError('JOB_REQUEST_INVALID');
  }
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(rawSubmission.kind) || rawSubmission.kind === 'signoff' ||
      rawSubmission.kind === 'checkpoint' || rawSubmission.kind === 'interview-picks') {
    throw new JobError('JOB_ACT_KIND_DISABLED');
  }
  if (ask.status !== 'pending') throw new JobError('JOB_ASK_SUPERSEDED');
  if (!isRecordSource(ask.source)) throw new JobError('JOB_ACT_SOURCE_STALE');
  let askSubject: RecordSubject;
  try {
    askSubject = validateRecordAskSubject(ask.subject, ask.source);
  } catch {
    throw new JobError('JOB_ACT_SOURCE_STALE');
  }
  if (submission.kind !== askSubject.kind || submission.publicationId !== ask.publicationId) {
    throw new JobError('JOB_ACT_SOURCE_STALE');
  }
  let boundSource: RecordSource;
  try {
    boundSource = bindJobRecordAsk(askSubject, retained);
  } catch {
    throw new JobError('JOB_ACT_SOURCE_STALE');
  }
  if (
    boundSource.sourceHash !== ask.source.sourceHash ||
    requestDigest(boundSource) !== requestDigest(ask.source)
  ) {
    throw new JobError('JOB_ACT_SOURCE_STALE');
  }
  if (
    !reviewer ||
    typeof reviewer !== 'object' ||
    Array.isArray(reviewer) ||
    Object.keys(reviewer).some(key => key !== 'id' && key !== 'role') ||
    typeof reviewer.id !== 'string' ||
    !reviewer.id ||
    (reviewer.role !== 'owner' && reviewer.role !== 'delegate')
  ) {
    throw new JobError('JOB_AUTHORITY_REFUSED');
  }
  switch (askSubject.kind) {
    case 'interview-picks':
    case 'checkpoint':
    case 'signoff':
      throw new JobError('JOB_ACT_KIND_DISABLED');
  }
  throw new JobError('JOB_ACT_INVALID');
}
