import { randomUUID } from 'node:crypto';
import {
  JOB_API_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_API_V3_SCHEMA, JOB_RECORD_ACT_KINDS, JOB_RECORD_ACT_SCHEMA, jobStillByteLimit, JOB_ENABLED_ACT_KINDS, JOB_RESERVED_ACT_KINDS,
  type ActV3, type JobAct, type JobComment, type JobCommentsAct, type JobApiSchema, type JobPendingAsk, type JobPublicationMode, type JobReviewerBinding,
  type JobSourceBinding, type JobSubject, type JobUISubmission, type JobRigCapture, type JobRigStill,
  type JobMeshEdit, type PendingAskV3, type RecordUIAct, type RecordSource, type RecordSubject, type SourceV3, type UISubmissionV3,
  type JobCommentContext, type JobContextComment,
  type JobChestLandmarkEdit, type JobCommentCarrier, type JobCommentOnlyAct, type JobCommentUISubmission,
  JOB_COMMENT_ONLY_ACT_SCHEMA,
} from './job-contract.ts';
import { parsePartsIssue, type PartsIssue } from './parts-comment.ts';
import {
  isRecordSource, isRigDraftVerdictSource, parseJobSelector, commentsObject, jobHash, jobId, jobInteger, jobObject,
  commentsActForEmission, meshEditsActForEmission, parseCommentsAct, parseMeshEdits, parseRecordSource, requestDigest, validateRecordAskSubject,
  chestLandmarkIdentity, parseChestLandmarkEdits, parseChestLandmarksAct, parseCommentOnlyAct,
} from './job-api.ts';
import { noteComments, partsIssueComments } from './feedback-export.ts';
import { feedbackContextComments } from './stage-comment.ts';
import type { Feedback } from './session.ts';
import {
  isRetainedRecordSource,
  readJobEditMesh,
  readJobEditModel,
  type JobRetainedRecordSource,
  type JobRetainedSource,
  type JobRetainedSourceV3,
} from './job-source.ts';
import { JobError } from './job-store.ts';
import { checkedPath, readRegular } from './interview-project.ts';
import {validatePngBytes} from './comment-crops.ts';
import {applyMeshOps} from './mesh-edit.ts';
import {deriveBust} from './chest-landmarks.ts';

function words(value: unknown): string {
  if (typeof value !== 'string' || value.length > 10_000) throw new JobError('JOB_ACT_INVALID');
  return value;
}

/** The writer's output must decode through the public @6 decoder; its refusal is JOB_ACT_INVALID. */
function commentsAct<Act extends JobCommentsAct>(act: Act): Act {
  parseCommentsAct(act);
  return act;
}

function submittedComments(value: Record<string, unknown>, legacyWordsRequired = false): Extract<JobCommentsAct, {kind: 'interview-picks'}>['value']['comments'] {
  if (Object.hasOwn(value, 'comments')) {
    if ('words' in value) throw new JobError('JOB_ACT_INVALID');
    // commentsAct checks the complete wire value before emission.
    return value.comments as ReturnType<typeof submittedComments>;
  }
  const legacy = legacyWordsRequired || 'words' in value ? words(value.words) : '';
  return legacy.trim() ? [{text: legacy}] : [];
}


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

function generalComments(value: unknown): JobComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new JobError('JOB_ACT_INVALID');
  return Array.from(value, (text: unknown) => {
    if (typeof text !== 'string') throw new JobError('JOB_ACT_INVALID');
    return {text};
  });
}

function choice<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (!allowed.includes(value as Value)) throw new JobError('JOB_ACT_INVALID');
  return value as Value;
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

export function bindJobAsk(subject: JobSubject, retained: JobRetainedSource): JobSourceBinding;
export function bindJobAsk(subject: RecordSubject | JobSubject, retained: JobRetainedRecordSource): RecordSource;
export function bindJobAsk(subject: JobSubject | RecordSubject, retained: JobRetainedSourceV3): SourceV3;
export function bindJobAsk(subject: JobSubject | RecordSubject, retained: JobRetainedSourceV3): SourceV3 {
  if (isRetainedRecordSource(retained)) {
    return bindJobRecordAsk(subject, retained);
  }
  const source = structuredClone(retained.source);
  if (source.selector?.kind === 'current') throw new JobError('JOB_ASK_INVALID');
  const declared = retained.subjects.some(candidate => requestDigest(candidate) === requestDigest(subject));
  switch (subject.kind) {
    case 'parts-verdict':
      if (!declared || !source.projectHash || !source.parts || source.selector?.kind !== 'draft' ||
          source.selector.id !== subject.draftId || !retained.partIds.length) throw new JobError('JOB_ASK_INVALID');
      return source;
    case 'review-verdict':
      if (source.selector?.kind === 'draft') {
        try { parseJobSelector(source.selector); }
        catch { throw new JobError('JOB_ASK_INVALID', subject.stage); }
        if (subject.stage !== 'rig-review' || !declared || !isRigDraftVerdictSource(source)) {
          throw new JobError('JOB_ASK_INVALID', subject.stage);
        }
        return source;
      }
      if (subject.stage === 'image-review' || !source.model || (subject.stage === 'rig-review' ? source.selector?.kind !== 'rig' :
        source.selector?.kind !== 'post' || !source.direction)) throw new JobError('JOB_ASK_INVALID');
      return source;
    case 'interview-picks':
    case 'checkpoint':
    case 'signoff':
    case 'reopen':
      throw new JobError('JOB_ASK_INVALID');
  }
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

/** The browser supplies pixels and draw provenance, never a trusted hash or path. */
export function prepareJobStill(input: UISubmissionV3, ask: JobPendingAsk, retained: JobRetainedSource): {
  readonly still: JobRigStill;
  readonly bytes: Buffer;
  readonly binding: JobRigCapture['binding'];
} {
  if (input.kind !== 'review-verdict' || !input.capture) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  const capture = jobObject(input.capture, ['png', 'width', 'height', 'camera', 'framing', 'view', 'frame', 'animation', 'playing', 'binding']);
  if (capture.camera !== 'fixed' || capture.framing !== 'default') throw new JobError('JOB_STILL_CAMERA_NOT_FIXED');
  if (capture.view !== 'whole-rig') throw new JobError('JOB_STILL_VIEW_UNSUPPORTED');
  const binding = jobObject(capture.binding, ['publicationId', 'instanceKey', 'sourceHash', 'pageId', 'askId', 'drawGeneration', 'playerGeneration']);
  if (binding.publicationId !== input.publicationId || binding.publicationId !== ask.publicationId ||
      binding.instanceKey !== retained.instanceKey || binding.sourceHash !== retained.source.sourceHash ||
      binding.pageId !== input.pageId || binding.askId !== ask.askId ||
      !Number.isSafeInteger(binding.drawGeneration) || (binding.drawGeneration as number) < 1 ||
      !Number.isSafeInteger(binding.playerGeneration) || (binding.playerGeneration as number) < 0) {
    throw new JobError('JOB_STILL_BINDING_MISMATCH');
  }
  if (typeof capture.playing !== 'boolean') throw new JobError('JOB_STILL_CAPTURE_FAILED');
  const frame = capture.frame;
  if (frame === 'setup') {
    if (capture.animation !== undefined) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  } else {
    if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < 0 ||
        typeof capture.animation !== 'string' || !capture.animation || capture.animation.length > 512 ||
        !retained.source.model) throw new JobError('JOB_STILL_CAPTURE_FAILED');
    const model = JSON.parse(readRegular(checkedPath(retained.snapshotRoot, retained.source.model.path), 64 * 1024 * 1024).toString('utf8'));
    const clip = model.animations?.find((item: {name: string; duration: number}) => item.name === capture.animation);
    if (!clip || !Number.isFinite(clip.duration) || frame > clip.duration) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  }
  const prefix = 'data:image/png;base64,';
  if (typeof capture.png !== 'string') throw new JobError('JOB_STILL_CAPTURE_FAILED');
  if (capture.png.length > prefix.length + Math.ceil(jobStillByteLimit / 3) * 4) {
    throw new JobError('JOB_STILL_CAPTURE_FAILED', undefined, jobStillByteLimit);
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(capture.png)) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  const bytes = Buffer.from(capture.png.slice(prefix.length), 'base64');
  if (bytes.length > jobStillByteLimit) throw new JobError('JOB_STILL_CAPTURE_FAILED', undefined, jobStillByteLimit);
  if (prefix + bytes.toString('base64') !== capture.png) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  try { validatePngBytes(bytes, capture.width as number, capture.height as number); }
  catch { throw new JobError('JOB_STILL_CAPTURE_FAILED'); }
  const sha256 = jobHash(bytes);
  const common = {path: sha256 + '.png', sha256, camera: 'fixed' as const};
  const still: JobRigStill = frame === 'setup' ? {...common, frame} :
    {...common, frame: frame as number, animation: capture.animation as string};
  return {still, bytes, binding: binding as unknown as JobRigCapture['binding']};
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

/** Only the authenticated UI host invokes this adapter. All source and authority
 * fields are daemon-owned. Empty/whitespace strings remain exact human words.
 */
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: JobUISubmission;
  readonly ask: JobPendingAsk;
  readonly retained: JobRetainedSource;
  readonly reviewer: JobReviewerBinding;
  readonly still?: JobRigStill;
}): JobAct;
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: UISubmissionV3;
  readonly ask: PendingAskV3;
  readonly retained: JobRetainedRecordSource;
  readonly reviewer: JobReviewerBinding;
  readonly still?: undefined;
  readonly actId?: string;
  readonly at?: string;
}): RecordUIAct;
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: UISubmissionV3;
  readonly ask: JobPendingAsk | PendingAskV3;
  readonly retained: JobRetainedSourceV3;
  readonly reviewer: JobReviewerBinding;
  readonly still?: JobRigStill;
  readonly actId?: string;
  readonly at?: string;
}): ActV3;
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: UISubmissionV3;
  readonly ask: JobPendingAsk | PendingAskV3;
  readonly retained: JobRetainedSourceV3;
  readonly reviewer: JobReviewerBinding;
  readonly still?: JobRigStill;
  readonly actId?: string;
  readonly at?: string;
}): ActV3 {
  const {kind, value} = options.submission;
  const meshSubmission = !!value && typeof value === 'object' && Object.hasOwn(value, 'meshEdits');
  const chestSubmission = !!value && typeof value === 'object' && Object.hasOwn(value, 'chestLandmarks');
  if ((meshSubmission || chestSubmission) && (kind !== 'review-verdict' ||
      (value as {stage?: unknown}).stage !== 'rig-review' || (value as {verdict?: unknown}).verdict !== 'changes-requested' ||
      isRetainedRecordSource(options.retained) || options.ask.subject.kind !== 'review-verdict' || options.ask.subject.stage !== 'rig-review')) {
    throw new JobError('JOB_ACT_INVALID');
  }
  if (isRetainedRecordSource(options.retained)) {
    return prepareJobRecordAct({
      jobId: options.jobId,
      submission: options.submission,
      ask: options.ask,
      retained: options.retained,
      reviewer: options.reviewer,
      still: options.still,
      actId: options.actId,
      at: options.at,
    });
  }
  if (kind === 'interview-picks' || options.ask.subject.kind === 'interview-picks' ||
      (kind as string) === 'signoff' || (options.ask.subject.kind as string) === 'signoff' ||
      (kind as string) === 'checkpoint' || (options.ask.subject.kind as string) === 'checkpoint') {
    throw new JobError('JOB_ACT_KIND_DISABLED');
  }
  const { submission, ask, retained, reviewer } = options as {
    readonly jobId: string;
    readonly submission: JobUISubmission;
    readonly ask: JobPendingAsk;
    readonly retained: JobRetainedSource;
    readonly reviewer: JobReviewerBinding;
    readonly still?: JobRigStill;
  };
  if (ask.status !== 'pending') throw new JobError('JOB_ASK_SUPERSEDED');
  if (submission.kind !== ask.subject.kind || submission.publicationId !== ask.publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
  const source = bindJobAsk(ask.subject, retained);
  if (requestDigest(source) !== requestDigest(ask.source)) throw new JobError('JOB_ACT_SOURCE_STALE');
  if (!reviewer.id || !['owner', 'delegate'].includes(reviewer.role)) throw new JobError('JOB_AUTHORITY_REFUSED');
  const at = new Date().toISOString();
  const comments = {
    schema: JOB_COMMENTS_ACT_SCHEMA, actId: randomUUID(), jobId: options.jobId, askId: ask.askId,
    publicationId: ask.publicationId,
    authority: { actor: 'human' as const, channel: 'review-ui' as const, reviewer: structuredClone(reviewer) },
    at,
  };
  switch (submission.kind) {
    case 'interview-picks':
    case 'checkpoint':
      throw new JobError('JOB_ACT_KIND_DISABLED');
    case 'parts-verdict': {
      const value = jobObject(submission.value, ['verdict', 'issues', 'words', 'general']);
      const verdict = choice(value.verdict, ['approved', 'changes-requested'] as const);
      if (
        !Array.isArray(value.issues) ||
        value.issues.length > 1000 ||
        (verdict === 'approved') !== (value.issues.length === 0)
      ) {
        throw new JobError('JOB_ACT_INVALID');
      }
      const ids = new Set<string>();
      const issues: PartsIssue[] = value.issues.map(raw => {
        let issue: PartsIssue;
        try {
          issue = parsePartsIssue(raw, true, false, false);
        } catch {
          throw new JobError('JOB_ACT_INVALID');
        }
        if (issue.sourceHash !== source.sourceHash || ids.has(issue.id)) {
          throw new JobError('JOB_ACT_INVALID');
        }
        ids.add(issue.id);
        for (const part of issue.parts) {
          const matchesSource = source.parts!.images.some(
            img => img.role === 'part' && img.path === `parts/${part.name}.png` && img.sha256 === part.imageHash,
          );
          if (!retained.partIds.includes(part.name) || !matchesSource) {
            throw new JobError('JOB_ACT_INVALID');
          }
        }
        return structuredClone(issue);
      });
      return commentsAct({
        ...comments,
        kind: 'parts-verdict',
        source: {
          ...source,
          projectHash: source.projectHash!,
          selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, { kind: 'draft' }>,
          parts: source.parts!,
        },
        value: {
          verdict,
          comments: [...partsIssueComments(issues), ...noteComments(words(value.words)), ...generalComments(value.general)],
        },
      });
    }
    case 'review-verdict': {
      const stage = ask.subject.kind === 'review-verdict' ? ask.subject.stage : undefined;
      const value = jobObject(submission.value, ['stage', 'verdict', 'words',
        ...(stage === 'rig-review' ? ['feedback', 'general', 'meshEdits', 'chestLandmarks'] : []),
        ...(stage === 'direction-review' ? ['comments'] : [])]);
      if (ask.subject.kind !== 'review-verdict' || ask.subject.stage === 'image-review' || value.stage !== ask.subject.stage) throw new JobError('JOB_ACT_INVALID');
      const verdict = choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const);
      const act = {...comments, kind: 'review-verdict' as const};
      if (ask.subject.stage === 'rig-review') {
        const meshEdits = meshSubmission ? parseMeshEdits(value.meshEdits) : undefined;
        const chestLandmarks = chestSubmission ? parseChestLandmarkEdits(value.chestLandmarks) : undefined;
        if (meshEdits || chestLandmarks) {
          const model = readJobEditModel(retained.snapshotRoot, source.model, 'JOB_ACT_SOURCE_STALE');
          if (meshEdits) validateRetainedMeshEdits(model, meshEdits);
          if (chestLandmarks) validateRetainedChestLandmarks(retained, model, chestLandmarks);
        }
        if (!options.still) throw new JobError('JOB_STILL_CAPTURE_FAILED');
        const note = words(value.words);
        if (value.feedback !== undefined && !Array.isArray(value.feedback)) throw new JobError('JOB_ACT_INVALID');
        const selector = source.selector as Extract<NonNullable<JobSourceBinding['selector']>, {kind: 'rig' | 'draft'}>;
        let verdictComments: readonly JobContextComment[];
        try {
          verdictComments = value.feedback === undefined ? noteComments(note) : feedbackContextComments(value.feedback as Feedback[],
            {ask: ask.subject, sourceHash: source.sourceHash, selector});
        } catch { throw new JobError('JOB_ACT_INVALID'); }
        const rigAct = {...act,
          source: {...source, model: source.model!, selector},
          value: {stage: 'rig-review' as const, verdict, comments: [...verdictComments, ...generalComments(value.general)]},
          still: options.still};
        if (chestLandmarks) return parseChestLandmarksAct({...rigAct, schema: JOB_CHEST_LANDMARKS_ACT_SCHEMA,
          value: {...rigAct.value, ...(meshEdits ? {meshEdits} : {}), chestLandmarks}});
        if (meshEdits) return meshEditsActForEmission({...rigAct, value: {...rigAct.value, meshEdits}});
        if (verdictComments.some(comment => Object.hasOwn(comment, 'context'))) return commentsActForEmission(rigAct);
        return commentsAct(rigAct);
      }
      return commentsAct({ ...act, source: { ...source, model: source.model!,
        selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, { kind: 'rig' | 'post' }> }, value: {
        stage: ask.subject.stage, verdict, comments: submittedComments(value, true),
      } });
    }
    case 'signoff':
      throw new JobError('JOB_ACT_KIND_DISABLED');
  }
}
