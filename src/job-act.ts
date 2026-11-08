import { randomUUID } from 'node:crypto';
import {
  JOB_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, JOB_RIG_REVIEW_ACT_SCHEMA, jobStillByteLimit, JOB_ENABLED_ACT_KINDS, JOB_PLAN_BOUND_SIGNOFF_STAGES, JOB_RESERVED_ACT_KINDS,
  type ActV3, type JobAct, type JobActValues, type JobPendingAsk, type JobReviewerBinding,
  type JobSourceBinding, type JobSubject, type JobUISubmission, type JobRigCapture, type JobRigStill,
  type PendingAskV3, type RecordAct, type RecordSource, type RecordSubject, type SourceV3,
} from './job-contract.ts';
import {
  isRecordSource, jobHash, jobId, jobInteger, jobObject,
  parseRecordAct, parseRecordSource, requestDigest, validateRecordAskSubject,
} from './job-api.ts';
import { validatePicks } from './interview-picks.ts';
import {
  isRetainedRecordSource,
  type JobRetainedRecordSource,
  type JobRetainedSource,
  type JobRetainedSourceV3,
} from './job-source.ts';
import { JobError } from './job-store.ts';
import { checkedPath, readRegular } from './interview-project.ts';
import { prepareJobImageSet } from './job-image-set.ts';
import {validatePngBytes} from './comment-crops.ts';

function words(value: unknown): string {
  if (typeof value !== 'string' || value.length > 10_000) throw new JobError('JOB_ACT_INVALID');
  return value;
}

function choice<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (!allowed.includes(value as Value)) throw new JobError('JOB_ACT_INVALID');
  return value as Value;
}

function requirePlan(source: JobSourceBinding): void {
  if (!source.plan?.steps.length) throw new JobError('JOB_ASK_INVALID', 'Published plan step identities are required');
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
  switch (parsedSubject.kind) {
    case 'interview-picks': {
      if (source.subject !== 'option-set') throw new JobError('JOB_ASK_INVALID');
      const question = retained.questions.find(
        item => item.editable && item.set.question === parsedSubject.questionId && item.set.id === parsedSubject.setId,
      );
      if (
        !question ||
        question.ref.path !== source.optionSetFile.path ||
        question.ref.sha256 !== source.optionSet.sha256
      ) {
        throw new JobError('JOB_ASK_INVALID');
      }
      return source;
    }
    case 'checkpoint': {
      if (
        source.subject !== 'plan' ||
        !source.plan.steps.length ||
        !source.plan.steps.some(step => step.id === parsedSubject.checkpointId)
      ) {
        throw new JobError('JOB_ASK_INVALID');
      }
      return source;
    }
    case 'signoff': {
      if (source.subject !== 'plan' || !source.plan.steps.length) {
        throw new JobError('JOB_ASK_INVALID');
      }
      return source;
    }
  }
}

export function bindJobAsk(subject: JobSubject, retained: JobRetainedSource): JobSourceBinding;
export function bindJobAsk(subject: RecordSubject | JobSubject, retained: JobRetainedRecordSource): RecordSource;
export function bindJobAsk(subject: JobSubject | RecordSubject, retained: JobRetainedSourceV3): SourceV3;
export function bindJobAsk(subject: JobSubject | RecordSubject, retained: JobRetainedSourceV3): SourceV3 {
  if (isRetainedRecordSource(retained)) {
    return bindJobRecordAsk(subject, retained);
  }
  const source = structuredClone(retained.source);
  if (source.subject === 'image-set') {
    if (subject.kind !== 'review-verdict' || subject.stage !== 'image-review') throw new JobError('JOB_ASK_INVALID');
    const identity = prepareJobImageSet(source.imageSet,
      path => readRegular(checkedPath(retained.root.path, path), 64 * 1024 * 1024));
    if (requestDigest(identity) !== requestDigest({imageSet: source.imageSet,
      imageSetDigest: source.imageSetDigest, duplicateHashes: source.duplicateHashes})) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    return {...source, ...identity};
  }
  const declared = retained.subjects.some(candidate => requestDigest(candidate) === requestDigest(subject));
  switch (subject.kind) {
    case 'interview-picks': {
      const question = retained.questions.find(item => item.editable && item.set.question === subject.questionId && item.set.id === subject.setId);
      if (!question) throw new JobError('JOB_ASK_INVALID');
      return { ...source, optionSet: { id: question.set.id, sha256: question.ref.sha256 } };
    }
    case 'checkpoint': {
      requirePlan(source);
      const stepId = ('planStepId' in subject ? subject.planStepId : undefined) ?? subject.checkpointId;
      if (!declared || !source.plan!.steps.some(step => step.id === stepId)) throw new JobError('JOB_ASK_INVALID');
      return source;
    }
    case 'parts-verdict':
      if (!declared || !source.projectHash || !source.parts || source.selector?.kind !== 'draft' ||
          source.selector.id !== subject.draftId || !retained.partIds.length) throw new JobError('JOB_ASK_INVALID');
      return source;
    case 'review-verdict':
      if (subject.stage === 'image-review' || !source.model || (subject.stage === 'rig-review' ? source.selector?.kind !== 'rig' :
        source.selector?.kind !== 'post' || !source.direction)) throw new JobError('JOB_ASK_INVALID');
      return source;
    case 'signoff':
      if (!declared) throw new JobError('JOB_ASK_INVALID');
      if ((JOB_PLAN_BOUND_SIGNOFF_STAGES as readonly string[]).includes(subject.stage)) requirePlan(source);
      return source;
  }
}

export function parseUISubmission(value: unknown): JobUISubmission {
  const item = jobObject(value, ['publicationId', 'askId', 'pageId', 'displayedNonce', 'expectedGeneration', 'submissionId', 'kind', 'value', 'capture']);
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ACT_KIND_DISABLED');
  jobId(item.publicationId); jobId(item.askId); jobId(item.pageId); jobId(item.displayedNonce); jobId(item.submissionId);
  jobInteger(item.expectedGeneration);
  if (!(JOB_ENABLED_ACT_KINDS as readonly string[]).includes(String(item.kind))) {
    throw new JobError('JOB_ACT_INVALID');
  }
  if (item.capture !== undefined && (item.kind !== 'review-verdict' ||
    (item.value as {stage?: unknown} | null)?.stage !== 'rig-review')) throw new JobError('JOB_REQUEST_INVALID');
  return item as unknown as JobUISubmission;
}

/** The browser supplies pixels and draw provenance, never a trusted hash or path. */
export function prepareJobStill(input: JobUISubmission, ask: JobPendingAsk, retained: JobRetainedSource): {
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
        retained.source.subject === 'image-set' || !retained.source.model) throw new JobError('JOB_STILL_CAPTURE_FAILED');
    const model = JSON.parse(readRegular(checkedPath(retained.snapshotRoot, retained.source.model.path), 64 * 1024 * 1024).toString('utf8'));
    const clip = model.animations?.find((item: {name: string; duration: number}) => item.name === capture.animation);
    if (!clip || !Number.isFinite(clip.duration) || frame > clip.duration) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  }
  const prefix = 'data:image/png;base64,';
  if (typeof capture.png !== 'string' || capture.png.length > prefix.length + Math.ceil(jobStillByteLimit / 3) * 4 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(capture.png)) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  const bytes = Buffer.from(capture.png.slice(prefix.length), 'base64');
  if (bytes.length > jobStillByteLimit || prefix + bytes.toString('base64') !== capture.png) throw new JobError('JOB_STILL_CAPTURE_FAILED');
  try { validatePngBytes(bytes, capture.width as number, capture.height as number); }
  catch { throw new JobError('JOB_STILL_CAPTURE_FAILED'); }
  const sha256 = jobHash(bytes);
  const common = {path: sha256 + '.png', sha256, camera: 'fixed' as const};
  const still: JobRigStill = frame === 'setup' ? {...common, frame} :
    {...common, frame: frame as number, animation: capture.animation as string};
  return {still, bytes, binding: binding as unknown as JobRigCapture['binding']};
}

function actObject<Key extends string>(value: unknown, allowed: readonly Key[]): Record<Key, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobError('JOB_ACT_INVALID');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key as Key)) throw new JobError('JOB_ACT_INVALID');
  }
  return value as Record<Key, unknown>;
}

function actIdField(value: unknown): string {
  try {
    return jobId(value);
  } catch {
    throw new JobError('JOB_ACT_INVALID');
  }
}

export function prepareJobRecordAct(options: {
  readonly jobId: string;
  readonly submission: JobUISubmission;
  readonly ask: PendingAskV3;
  readonly retained: JobRetainedRecordSource;
  readonly reviewer: JobReviewerBinding;
  readonly still?: unknown;
  readonly actId?: string;
  readonly at?: string;
}): RecordAct {
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
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(rawSubmission.kind)) {
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
  const at = options.at ?? new Date().toISOString();
  const actId = options.actId ?? randomUUID();
  const envelope = {
    schema: JOB_RECORD_ACT_SCHEMA,
    actId: actIdField(actId),
    jobId: actIdField(options.jobId),
    askId: actIdField(ask.askId),
    publicationId: actIdField(ask.publicationId),
    authority: {
      actor: 'human' as const,
      channel: 'review-ui' as const,
      reviewer: { id: reviewer.id, role: reviewer.role },
    },
    at,
  };

  switch (askSubject.kind) {
    case 'interview-picks': {
      if (boundSource.subject !== 'option-set') throw new JobError('JOB_ACT_SOURCE_STALE');
      const value = actObject(submission.value, ['questionId', 'selections', 'note']);
      if (
        !('questionId' in value) ||
        !('selections' in value) ||
        !('note' in value) ||
        value.questionId !== askSubject.questionId ||
        !Array.isArray(value.selections)
      ) {
        throw new JobError('JOB_ACT_INVALID');
      }
      const question = retained.questions.find(
        item => item.editable && item.set.id === askSubject.setId && item.set.question === askSubject.questionId,
      );
      if (!question) throw new JobError('JOB_ACT_SOURCE_STALE');
      const selections = value.selections.map(raw => {
        const item = actObject(raw, ['itemId', 'optionId', 'otherText']);
        if (!('itemId' in item) || !('optionId' in item) || !('otherText' in item)) {
          throw new JobError('JOB_ACT_INVALID');
        }
        if (item.otherText !== null && typeof item.otherText !== 'string') {
          throw new JobError('JOB_ACT_INVALID');
        }
        return {
          itemId: actIdField(item.itemId),
          optionId: actIdField(item.optionId),
          otherText: item.otherText === null ? null : words(item.otherText),
        };
      });
      const note = words(value.note);
      try {
        validatePicks(
          {
            schema: 'rig-review/interview-picks@1',
            set: question.ref,
            by: 'user',
            at,
            picks: selections.map(item => ({
              ask: item.itemId,
              option_id: item.optionId,
              ...(item.otherText === null ? {} : { other_text: item.otherText }),
            })),
            note,
          },
          question,
        );
      } catch {
        throw new JobError('JOB_ACT_INVALID');
      }
      return parseRecordAct({
        ...envelope,
        kind: 'interview-picks',
        source: boundSource,
        value: { questionId: askSubject.questionId, selections, note },
      });
    }
    case 'checkpoint': {
      if (boundSource.subject !== 'plan') throw new JobError('JOB_ACT_SOURCE_STALE');
      const value = actObject(submission.value, ['checkpointId', 'outcome', 'words']);
      if (
        !('checkpointId' in value) ||
        !('outcome' in value) ||
        !('words' in value) ||
        value.checkpointId !== askSubject.checkpointId
      ) {
        throw new JobError('JOB_ACT_INVALID');
      }
      return parseRecordAct({
        ...envelope,
        kind: 'checkpoint',
        source: boundSource,
        value: {
          checkpointId: askSubject.checkpointId,
          planStepId: askSubject.checkpointId,
          outcome: choice(value.outcome, ['pass', 'fail'] as const),
          words: words(value.words),
        },
      });
    }
    case 'signoff': {
      if (boundSource.subject !== 'plan') throw new JobError('JOB_ACT_SOURCE_STALE');
      const value = actObject(submission.value, ['stage', 'decision', 'words']);
      if (
        !('stage' in value) ||
        !('decision' in value) ||
        !('words' in value) ||
        value.stage !== askSubject.stage ||
        value.decision !== 'approved'
      ) {
        throw new JobError('JOB_ACT_INVALID');
      }
      return parseRecordAct({
        ...envelope,
        kind: 'signoff',
        source: boundSource,
        value: {
          stage: askSubject.stage,
          decision: 'approved',
          words: words(value.words),
        },
      });
    }
  }
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
  readonly submission: JobUISubmission;
  readonly ask: PendingAskV3;
  readonly retained: JobRetainedRecordSource;
  readonly reviewer: JobReviewerBinding;
  readonly still?: undefined;
  readonly actId?: string;
  readonly at?: string;
}): RecordAct;
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: JobUISubmission;
  readonly ask: JobPendingAsk | PendingAskV3;
  readonly retained: JobRetainedSourceV3;
  readonly reviewer: JobReviewerBinding;
  readonly still?: JobRigStill;
  readonly actId?: string;
  readonly at?: string;
}): ActV3;
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: JobUISubmission;
  readonly ask: JobPendingAsk | PendingAskV3;
  readonly retained: JobRetainedSourceV3;
  readonly reviewer: JobReviewerBinding;
  readonly still?: JobRigStill;
  readonly actId?: string;
  readonly at?: string;
}): ActV3 {
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
  const envelope = {
    schema: JOB_ACT_SCHEMA, actId: randomUUID(), jobId: options.jobId, askId: ask.askId,
    publicationId: ask.publicationId,
    authority: { actor: 'human' as const, channel: 'review-ui' as const, reviewer: structuredClone(reviewer) },
    at,
  };
  if (source.subject === 'image-set') {
    if (submission.kind !== 'review-verdict' || ask.subject.kind !== 'review-verdict' ||
        ask.subject.stage !== 'image-review') throw new JobError('JOB_ACT_INVALID');
    const value = jobObject(submission.value, ['stage', 'verdict', 'words', 'imageNotes']);
    if (value.stage !== 'image-review') throw new JobError('JOB_ACT_INVALID');
    let imageNotes: {name: string; words: string}[] | undefined;
    if (value.imageNotes !== undefined) {
      if (!Array.isArray(value.imageNotes) || value.imageNotes.length > source.imageSet.images.length) {
        throw new JobError('JOB_ACT_INVALID');
      }
      const names = new Set<string>();
      imageNotes = value.imageNotes.map(raw => {
        const note = jobObject(raw, ['name', 'words']);
        if (typeof note.name !== 'string' || names.has(note.name) ||
            !source.imageSet.images.some(image => image.name === note.name)) throw new JobError('JOB_ACT_INVALID');
        names.add(note.name);
        return {name: note.name, words: words(note.words)};
      });
    }
    return {...envelope, kind: 'review-verdict', source, value: {stage: 'image-review',
      verdict: choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const), words: words(value.words),
      ...(imageNotes === undefined ? {} : {imageNotes})}};
  }
  switch (submission.kind) {
    case 'interview-picks': {
      const value = jobObject(submission.value, ['questionId', 'selections', 'note']);
      const subject = ask.subject;
      if (subject.kind !== 'interview-picks' || value.questionId !== subject.questionId || !Array.isArray(value.selections)) {
        throw new JobError('JOB_ACT_INVALID');
      }
      const question = retained.questions.find(item => item.editable && item.set.id === subject.setId && item.set.question === subject.questionId)!;
      const selections = value.selections.map(raw => {
        const item = jobObject(raw, ['itemId', 'optionId', 'otherText']);
        if (item.otherText !== null && typeof item.otherText !== 'string') throw new JobError('JOB_ACT_INVALID');
        return { itemId: jobId(item.itemId), optionId: jobId(item.optionId), otherText: item.otherText as string | null };
      });
      const note = words(value.note);
      try {
        validatePicks({ schema: 'rig-review/interview-picks@1', set: question.ref, by: 'user', at,
          picks: selections.map(item => ({ ask: item.itemId, option_id: item.optionId,
            ...(item.otherText === null ? {} : { other_text: item.otherText }) })), note }, question);
      } catch { throw new JobError('JOB_ACT_INVALID'); }
      return { ...envelope, kind: 'interview-picks', source: { ...source, optionSet: source.optionSet! },
        value: { questionId: subject.questionId, selections, note } };
    }
    case 'checkpoint': {
      const value = jobObject(submission.value, ['checkpointId', 'outcome', 'words']);
      const subject = ask.subject;
      if (subject.kind !== 'checkpoint' || value.checkpointId !== subject.checkpointId) throw new JobError('JOB_ACT_INVALID');
      return { ...envelope, kind: 'checkpoint', source: { ...source, plan: source.plan! }, value: {
        checkpointId: subject.checkpointId, planStepId: subject.planStepId ?? subject.checkpointId,
        outcome: choice(value.outcome, ['pass', 'fail'] as const), words: words(value.words),
      } };
    }
    case 'parts-verdict': {
      const value = jobObject(submission.value, ['verdict', 'parts', 'words']);
      if (!Array.isArray(value.parts) || value.parts.length !== retained.partIds.length) throw new JobError('JOB_ACT_INVALID');
      const ids = new Set<string>();
      const parts = value.parts.map(raw => {
        const item = jobObject(raw, ['partId', 'part', 'mesh']);
        const partId = jobId(item.partId);
        if (!retained.partIds.includes(partId) || ids.has(partId)) throw new JobError('JOB_ACT_INVALID');
        ids.add(partId);
        const outcome = (raw: unknown) => {
          const item = jobObject(raw, ['outcome', 'note']);
          const result = { outcome: choice(item.outcome, ['pending', 'clean', 'flagged'] as const), note: words(item.note) };
          // Match the existing parts verdict writer's flagged-note validation.
          if (result.outcome === 'flagged' && !result.note.trim()) throw new JobError('JOB_ACT_INVALID');
          return result;
        };
        return { partId, part: outcome(item.part), mesh: outcome(item.mesh) };
      });
      const verdict = choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const);
      const outcomes = parts.flatMap(part => [part.part.outcome, part.mesh.outcome]);
      if (verdict === 'approved' && outcomes.some(outcome => outcome !== 'clean') ||
          verdict === 'changes-requested' && !outcomes.includes('flagged')) throw new JobError('JOB_ACT_INVALID');
      return { ...envelope, kind: 'parts-verdict', source: { ...source, projectHash: source.projectHash!,
        selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, { kind: 'draft' }>, parts: source.parts! },
      value: { verdict, parts, words: words(value.words) } };
    }
    case 'review-verdict': {
      const value = jobObject(submission.value, ['stage', 'verdict', 'words']);
      if (ask.subject.kind !== 'review-verdict' || ask.subject.stage === 'image-review' || value.stage !== ask.subject.stage) throw new JobError('JOB_ACT_INVALID');
      if (ask.subject.stage === 'rig-review') {
        if (!options.still) throw new JobError('JOB_STILL_CAPTURE_FAILED');
        return {...envelope, schema: JOB_RIG_REVIEW_ACT_SCHEMA, kind: 'review-verdict',
          source: {...source, model: source.model!, selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, {kind: 'rig'}>},
          value: {stage: 'rig-review', verdict: choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const), words: words(value.words)},
          still: options.still};
      }
      return { ...envelope, kind: 'review-verdict', source: { ...source, model: source.model!,
        selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, { kind: 'rig' | 'post' }> }, value: {
        stage: ask.subject.stage, verdict: choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const), words: words(value.words),
      } };
    }
    case 'signoff': {
      const value = jobObject(submission.value, ['stage', 'decision', 'words']);
      if (ask.subject.kind !== 'signoff' || value.stage !== ask.subject.stage || value.decision !== 'approved') {
        throw new JobError('JOB_ACT_INVALID');
      }
      const result: JobActValues['signoff'] = { stage: ask.subject.stage, decision: 'approved', words: words(value.words) };
      return { ...envelope, kind: 'signoff', source, value: result };
    }
  }
}
