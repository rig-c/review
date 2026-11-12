/**
 * Review #484 contract for Lane B, Create #182 and Parts #1159, with the HQ-approved #522 image branch.
 * People submit through the UI. Agents use publish, ask, next and close.
 * Public values contain semantic data and original source provenance. Private
 * session, picks, verdict, applied-record and snapshot formats stay behind ports.
 *
 * Publication requires an explicit producer-held freeze until acknowledgment.
 * Review validates retained bytes, detects a moved record and commits local CAS.
 * The freeze assertion is a caller obligation, not a lock Review can impose on
 * independent writers. No watched-root or automatic-close guarantee is offered.
 * Only explicit close ends an active job. Direction carriage is metadata-only.
 */

import type { JobPublicationReader } from './job-source.ts';
import type { PartsIssue } from './parts-comment.ts';
import type { Feedback, ReviewSession } from './session.ts';
import type { CompareFeedback, CompareSession } from './compare-session.ts';
import type { MarkRegion } from './stage-comment.ts';
import type { PartsVerdict } from './parts-view.ts';
import type { ControlNumericCamera, ControlPart } from './control.ts';

export const JOB_API_SCHEMA = 'rig-review/job-api@2' as const;
export const JOB_API_V3_SCHEMA = 'rig-review/job-api@3' as const;
export const JOB_ACT_SCHEMA = 'rig-review/act@2' as const;
/** New rig verdicts only. Store/reuse markers and all other acts retain @2. */
export const JOB_RIG_REVIEW_ACT_SCHEMA = 'rig-review/act@3' as const;
/** Record-source acts only under opt-in API@3. Package/image acts retain @2/@3. */
export const JOB_RECORD_ACT_SCHEMA = 'rig-review/act@4' as const;
/** New parts verdicts only. Historical @2 parts-verdict acts remain readable. */
export const JOB_PARTS_VERDICT_ACT_SCHEMA = 'rig-review/act@5' as const;
/** Fresh checkpoint, parts-verdict, rig/post review-verdict and signoff writers. Image-review and interview-picks stay @2; record acts stay @4. */
export const JOB_COMMENTS_ACT_SCHEMA = 'rig-review/act@6' as const;
/** @6 plus an optional per-comment `context`. Emitted only behind EMIT_UNPINNED_CREATE_FIELDS (#714). */
export const JOB_COMMENT_CONTEXT_ACT_SCHEMA = 'rig-review/act@7' as const;
export const REVIEW_COMMENTS_SESSION_SCHEMA = 'rig-review-session/2' as const;
export const REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA = 'rig-review-compare-session/2' as const;
export const PARTS_COMMENTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/5' as const;

export type JobCommentFeedbackAnchor = Omit<Feedback, 'summary'> | Omit<CompareFeedback, 'summary'>;
export type JobCommentPartsAnchor = Omit<PartsIssue, 'summary'>;
export type JobCommentImageAnchor = { readonly name: string } | {
  readonly name: string;
  readonly imageRegion: MarkRegion;
  readonly crop: PartsIssue['crop'];
  readonly nativeCrop: NonNullable<PartsIssue['nativeCrop']>;
};
export type JobCommentAnchor = JobCommentFeedbackAnchor | JobCommentPartsAnchor | JobCommentImageAnchor
  | { readonly checkpointId: string; readonly planStepId: string };
export interface JobComment { readonly text: string; readonly anchor?: JobCommentAnchor }
/** Where a comment was made, so opening it can restore that view (#714, act@7).
 * Every field is optional and copies a value an existing pin or restore path already carries.
 */
export interface JobCommentContext {
  /** The ask subject, its source hash and its version selector, bound to the act's own source. */
  readonly subject?: {
    readonly ask: JobSubject;
    readonly sourceHash: JobSha256;
    readonly selector?: JobSelector;
  };
  /** Workspace mode: StageComment.mode and InspectionSelection.mode. */
  readonly mode?: 'setup' | 'animate' | 'compare';
  /** Inspector tab: InspectionSelection.inspector. */
  readonly tab?: 'view' | 'rig' | 'playback' | 'feedback';
  /** Selected part: InspectionSelection.part. */
  readonly part?: ControlPart;
  /** Marked region in world space: StageComment.world and PartsIssue.rigRegion. */
  readonly region?: MarkRegion;
  /** Parts view mode: PartsIssue.view.mode. */
  readonly viewMode?: 'item' | 'assembled';
  /** Numeric camera: StageComment.camera. */
  readonly camera?: ControlNumericCamera;
  /** Explicit frame: StageComment.frame. */
  readonly frame?: { readonly index: number; readonly basis: 'producer' | 'reference' };
}
export interface JobContextComment extends JobComment { readonly context?: JobCommentContext }
export interface JobCommentsActValues {
  readonly checkpoint: { readonly checkpointId: string; readonly planStepId: string;
    readonly outcome: 'pass' | 'fail'; readonly comments: readonly JobComment[] };
  readonly 'parts-verdict': { readonly verdict: 'approved' | 'changes-requested'; readonly comments: readonly JobComment[] };
  readonly 'review-verdict': { readonly stage: JobReviewStage; readonly verdict: JobVerdict; readonly comments: readonly JobComment[] };
  readonly signoff: { readonly stage: string; readonly decision: 'approved'; readonly comments: readonly JobComment[] };
  readonly reopen: { readonly stage: string; readonly comments: readonly JobComment[] };
}
export type JobCommentsAct = {
  [Kind in keyof JobCommentsActValues]: {
    readonly schema: typeof JOB_COMMENTS_ACT_SCHEMA;
    readonly actId: string; readonly jobId: string; readonly askId: string; readonly publicationId: string;
    readonly kind: Kind; readonly authority: JobHumanAuthority; readonly at: string;
    readonly source: Exclude<SourceV3, OptionSource>; readonly value: JobCommentsActValues[Kind]; readonly still?: JobRigStill;
  }
}[keyof JobCommentsActValues];
/** act@7: the @6 envelope whose comments may carry `context`. */
export type JobContextCommentsAct = {
  [Kind in keyof JobCommentsActValues]: Omit<Extract<JobCommentsAct, { readonly kind: Kind }>, 'schema' | 'value'> & {
    readonly schema: typeof JOB_COMMENT_CONTEXT_ACT_SCHEMA;
    readonly value: Omit<JobCommentsActValues[Kind], 'comments'> & { readonly comments: readonly JobContextComment[] };
  }
}[keyof JobCommentsActValues];
export type ReviewCommentsSession = Omit<ReviewSession, 'schema' | 'feedback' | 'checkpoints'> & {
  schema: typeof REVIEW_COMMENTS_SESSION_SCHEMA;
  checkpoints: Record<string, { outcome: 'pending' | 'pass' | 'fail' }>;
  comments: JobComment[];
};
export type CompareCommentsSession = Omit<CompareSession, 'schema' | 'feedback'> & {
  schema: typeof REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA; comments: JobComment[];
};
export type PartsCommentsVerdict = Omit<PartsVerdict, 'schema' | 'issues'> & {
  schema: typeof PARTS_COMMENTS_VERDICT_SCHEMA; comments: JobComment[];
};
export const JOB_PANEL_COMPOSITION_SCHEMA = 'rig-review/panels@1' as const;

export type PanelSlot = 'left' | 'stage' | 'toolbar' | 'side';
export const PANEL_COMPONENTS = [
  'parts.canvas', 'parts.list', 'parts.issues', 'parts.layers', 'act.submit',
  'interview.picks', 'plan.body', 'rig.playback', 'scene.composite', 'images.set',
] as const;
export type PanelComponent = typeof PANEL_COMPONENTS[number];
export interface JobPanelComposition {
  readonly schema: typeof JOB_PANEL_COMPOSITION_SCHEMA;
  readonly left?: readonly PanelComponent[];
  readonly stage?: readonly PanelComponent[];
  readonly toolbar?: readonly PanelComponent[];
  readonly side?: readonly PanelComponent[];
}
export function isPanelComponent(value: string): value is PanelComponent {
  return (PANEL_COMPONENTS as readonly string[]).includes(value);
}

export function parsePanelComposition(input: unknown): JobPanelComposition {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error('JOB_PANELS_INVALID: panels must be a plain object');
  }
  const p = input as Record<string, unknown>;
  if (p.schema !== JOB_PANEL_COMPOSITION_SCHEMA) {
    throw new Error(`JOB_PANELS_INVALID: panels.schema must be ${JOB_PANEL_COMPOSITION_SCHEMA}`);
  }
  for (const key of Object.keys(p)) {
    if (!['schema', 'left', 'stage', 'toolbar', 'side'].includes(key)) {
      throw new Error(`JOB_PANELS_INVALID: unknown panel slot ${key}`);
    }
  }
  const slot = (value: unknown, field: string): PanelComponent[] => {
    if (!Array.isArray(value) || value.length > 32) {
      throw new Error(`JOB_PANELS_INVALID: ${field} must be an array of at most 32 components`);
    }
    return value.map((item, index) => {
      if (typeof item !== 'string' || !item.trim() || item.length > 128 || /[\r\n\0]/.test(item)) {
        throw new Error(`JOB_PANELS_INVALID: ${field}[${index}] must be a nonblank component id`);
      }
      // Unknown component IDs are preserved in their declared slot so the host renders JOB_PANEL_UNKNOWN: <id>.
      return item as PanelComponent;
    });
  };
  const stage = slot(p.stage, 'panels.stage');
  const side = slot(p.side, 'panels.side');
  if (stage.length !== 1 || side.length < 1 || side[side.length - 1] !== 'act.submit') {
    throw new Error('JOB_PANELS_INVALID: stage must have exactly one component and side must end with act.submit');
  }
  return {
    schema: JOB_PANEL_COMPOSITION_SCHEMA,
    ...(p.left === undefined ? {} : { left: slot(p.left, 'panels.left') }),
    stage,
    ...(p.toolbar === undefined ? {} : { toolbar: slot(p.toolbar, 'panels.toolbar') }),
    side,
  };
}
export const JOB_RECORD_READER_ID = 'rig-create/publication-reader/2' as const;
export const JOB_RECORD_SOURCE_SCHEMA = 'rig-review-job-record-source/1' as const;
export const JOB_RECORD_INSTANCE_SCHEMA = 'rig-review-job-record-instance/1' as const;
export const JOB_PUBLICATION_MODES = ['package-only', 'record-and-package'] as const;
export type JobPublicationMode = typeof JOB_PUBLICATION_MODES[number];
export type JobApiSchema = typeof JOB_API_SCHEMA | typeof JOB_API_V3_SCHEMA;
export const jobStillByteLimit = 8 * 1024 * 1024;
export const jobCaptureBodyLimit = 12 * 1024 * 1024;
/** Full act plus its envelope; comment pixels use separate private storage. */
export const jobActDeliveryLimit = 16 * 1024 * 1024;
export const jobResponseBodyLimit = jobActDeliveryLimit + 64 * 1024;
export const jobRawActMediaType = 'application/vnd.rig-review.act+json';
export const JOB_PARTS_ENUMERATOR_RANGE = '>=2.25.0 <3.0.0' as const;

export const JOB_ENABLED_ACT_KINDS = [
  'interview-picks',
  'checkpoint',
  'parts-verdict',
  'review-verdict',
  'signoff',
] as const;

export const JOB_RECORD_ACT_KINDS = [
  'interview-picks',
  'checkpoint',
  'signoff',
  'reopen',
] as const;

export const JOB_RESERVED_ACT_KINDS = ['described-correction', 'mesh-edit'] as const;
export type JobEnabledActKind = typeof JOB_ENABLED_ACT_KINDS[number];
export type RecordActKind = typeof JOB_RECORD_ACT_KINDS[number];
export type JobReservedActKind = typeof JOB_RESERVED_ACT_KINDS[number];
export type JobActKind = JobEnabledActKind | JobReservedActKind;

export const JOB_PLAN_BOUND_SIGNOFF_STAGES = [
  'plan-approved',
  'rigging-interview',
  'post-interview',
] as const;

/** Record-only approval stages; not part of the public job-host runtime exports. */
export const JOB_RECORD_SIGNOFF_STAGES = [...JOB_PLAN_BOUND_SIGNOFF_STAGES, 'direction-review'] as const;

/** Reserved kinds have no accepted value shape and cannot be asked or submitted.
 * Described correction awaits the joint Create #182 context allowlist.
 * Mesh edit awaits the joint Parts #1159 freeze. Proposal 6ff03ec9 discusses
 * slot/attachment/skin identity, setup basis, vertex/triangle/hull counts and
 * at most 300 closed move/add/remove/edge/unedge operations in crop pixels.
 * The exact attachment bytes behind source.hash and the canonical payload
 * digest replacing delta_sha256 are UNRESOLVED. This contract defines neither.
 * A future submitted mesh act must carry human UI authority, time, exact rig
 * revision/source and recomputable provenance. Drafts are never consumer acts.
 */
export const JOB_CONSUMER_AUTH_MODE = 'writer-owned-sibling-fetch-capability' as const;

/** Hex digests, opaque IDs/cursors and timestamps require runtime validation.
 * SHA-256 is 64 lowercase hex digits. Generations are nonnegative safe integers.
 * Original input paths are literal project/package-relative provenance only.
 * No public field names a Review state directory or stored document.
 */
export type JobSha256 = string;
export type JobId = string;
export type JobPublicationId = string;
export type JobAskId = string;
export type JobActId = string;
export type JobCursor = string;

export interface JobFileIdentity {
  readonly path: string;
  readonly sha256: JobSha256;
}

/** Optional sealed decision material, bound verbatim to the published source. */
export interface JobCheckpointEvidence {
  readonly schema: 'rig-review-checkpoint-evidence/1';
  readonly checkpointId: string;
  readonly planStepId: string;
  readonly tiles: readonly (JobFileIdentity & {readonly id: string; readonly label: string})[];
  readonly table: JobFileIdentity & {readonly label?: string};
  readonly routesText: string;
  readonly recommendationText: string;
}

export interface JobCheckpointTable {
  readonly schema: 'rig-review-checkpoint-table/1';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

/** IDs and existing step hashes published by Create #184 for the displayed plan.
 * Review retains these values without importing or computing Create's internal
 * stepHash. Create validates them with its existing writer. No plan revision
 * hash or additional revision gate exists in this contract.
 */
export interface JobPlanStepIdentity {
  readonly id: string;
  readonly hash: JobSha256;
}

export interface JobPlanIdentity {
  readonly steps: readonly JobPlanStepIdentity[];
}

/** Ephemeral owner metadata, projected by the daemon from the sealed project. */
export const JOB_PLAN_TEXT_SCHEMA = 'rig-review/job-plan-text@1' as const;
export const JOB_PLAN_TEXT_FIELDS = ['does', 'produces', 'bar', 'rests_on'] as const;
export type JobPlanTextField = typeof JOB_PLAN_TEXT_FIELDS[number];
export interface JobPlanTextStep {
  readonly id: string;
  readonly hash: string;
  does?: string;
  produces?: string;
  bar?: string;
  rests_on?: readonly string[];
  readonly issues: {field: JobPlanTextField; reason: 'absent' | 'invalid' | 'limit'}[];
}
export const JOB_PLAN_TEXT_UNAVAILABLE = [
  'PLAN_TEXT_RECORD_UNAVAILABLE', 'PLAN_TEXT_RECORD_UNSUPPORTED', 'PLAN_TEXT_STEPS_ABSENT',
  'PLAN_TEXT_STEPS_INVALID', 'PLAN_TEXT_MAPPING_UNAVAILABLE', 'PLAN_TEXT_LIMIT',
] as const;
export type JobPlanTextProjection = {
  readonly schema: typeof JOB_PLAN_TEXT_SCHEMA;
  readonly record: {readonly path: 'project.json'; readonly sha256: string};
  readonly status: 'projected';
  readonly steps: readonly JobPlanTextStep[];
} | {
  readonly schema: typeof JOB_PLAN_TEXT_SCHEMA;
  readonly record: {readonly path: 'project.json'; readonly sha256: string} | null;
  readonly status: 'unavailable';
  readonly reason: typeof JOB_PLAN_TEXT_UNAVAILABLE[number];
};

/** Closed delivery grammar. Field contents have the normal daemon's authority. */
export function parseJobPlanTextProjection(value: unknown): JobPlanTextProjection {
  const fail = (): never => {throw new Error('PLAN_TEXT_METADATA_INVALID');};
  const object = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !keys.includes(key))) return fail();
    return input as Record<string, unknown>;
  };
  const envelope = object(value, ['schema', 'record', 'status', 'steps', 'reason']);
  if (envelope.schema !== JOB_PLAN_TEXT_SCHEMA || !Object.hasOwn(envelope, 'record') ||
      new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024) return fail();
  if (envelope.record !== null) {
    const record = object(envelope.record, ['path', 'sha256']);
    if (record.path !== 'project.json' || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return fail();
  }
  if (envelope.status === 'unavailable') {
    if (Object.hasOwn(envelope, 'steps') || !(JOB_PLAN_TEXT_UNAVAILABLE as readonly unknown[]).includes(envelope.reason)) return fail();
    return value as JobPlanTextProjection;
  }
  if (envelope.status !== 'projected' || envelope.record === null || Object.hasOwn(envelope, 'reason') ||
      !Array.isArray(envelope.steps) || envelope.steps.length > 4096) return fail();
  const ids = new Set<string>();
  for (const raw of envelope.steps) {
    const row = object(raw, ['id', 'hash', ...JOB_PLAN_TEXT_FIELDS, 'issues']);
    if (typeof row.id !== 'string' || row.id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.id) ||
        ids.has(row.id) || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash) || !Array.isArray(row.issues)) return fail();
    ids.add(row.id);
    const missing = JOB_PLAN_TEXT_FIELDS.filter(field => !Object.hasOwn(row, field));
    if (row.issues.length !== missing.length) return fail();
    row.issues.forEach((rawIssue, index) => {
      const issue = object(rawIssue, ['field', 'reason']);
      if (issue.field !== missing[index] || typeof issue.reason !== 'string' || !['absent', 'invalid', 'limit'].includes(issue.reason)) fail();
    });
    for (const field of JOB_PLAN_TEXT_FIELDS) {
      if (!Object.hasOwn(row, field)) continue;
      const content = row[field];
      if (field === 'rests_on') {
        if (!Array.isArray(content) || content.length > 4096 || content.some(item => typeof item !== 'string')) return fail();
      } else if (typeof content !== 'string') return fail();
    }
  }
  return value as JobPlanTextProjection;
}

/** Literal work-root-relative manifest path, validated at runtime. */
export type JobPartsManifestPath = string;
/** Literal path relative to the bound manifest directory. */
export type JobPartImagePath = string;
/** Bounded string only. Parts owns role membership, order and duplicate rules. */
export type JobPartsRole = string;

export interface JobPartsFileReference {
  readonly path: JobPartImagePath;
  readonly role: JobPartsRole;
}

/** Trusted host wires the official partsFileReferences export from its actual
 * installed @rig-c/parts/src/parts.ts and checks that installation's version.
 * A version claim alone does not authenticate a substituted callback.
 */
export interface JobPartsEnumerator {
  readonly version: string;
  readonly enumerate: (dir: string) => readonly JobPartsFileReference[];
}

/** Exact official enumeration, preserved positionally with roles and raw-byte
 * hashes. Manifest provenance is work-root-relative. Image paths are relative
 * to its directory. enumeratorVersion is the actual installed Parts version
 * within JOB_PARTS_ENUMERATOR_RANGE. Unreferenced extras are outside identity.
 */
export interface JobPartsIdentity {
  readonly enumeratorVersion: string;
  readonly manifest: {
    readonly path: JobPartsManifestPath;
    readonly sha256: JobSha256;
  };
  readonly images: readonly {
    readonly path: JobPartImagePath;
    readonly role: JobPartsRole;
    readonly sha256: JobSha256;
  }[];
}

export type JobSelector =
  | { readonly kind: 'draft'; readonly id: string }
  | { readonly kind: 'rig'; readonly version: number }
  | { readonly kind: 'post'; readonly version: number; readonly rigVersion: number };

/** The original model branch keeps required explicit nulls. The image branch
 * omits model and selector entirely. The daemon derives the binding from
 * validated retained bytes and the actual displayed publication. Clients never
 * provide trusted source hashes or transfer old approval onto a new binding.
 */
export interface JobModelSourceBinding {
  readonly checkpointEvidence?: readonly JobCheckpointEvidence[];
  readonly subject?: never;
  readonly imageSet?: never;
  readonly imageSetDigest?: never;
  readonly duplicateHashes?: never;
  readonly sourceHash: JobSha256;
  readonly projectHash: JobSha256 | null;
  readonly package: { readonly id: string; readonly revision: string };
  readonly selector: JobSelector | null;
  readonly model: JobFileIdentity | null;
  readonly direction: JobFileIdentity | null;
  readonly optionSet: { readonly id: string; readonly sha256: JobSha256 } | null;
  readonly appliedResult: { readonly id: string; readonly modelHash: JobSha256 } | null;
  readonly plan: JobPlanIdentity | null;
  readonly parts: JobPartsIdentity | null;
}

/** Trusted-reader input. Hashes are optional claims, checked against retained bytes. */
export interface JobImageSetInput {
  readonly purpose: 'plate-adoption';
  readonly images: readonly {
    readonly role: 'source' | 'candidate' | 'reference';
    readonly name: string;
    readonly path: string;
    readonly sha256?: JobSha256;
  }[];
}

export interface JobImageSet {
  readonly purpose: 'plate-adoption';
  readonly images: readonly (Omit<JobImageSetInput['images'][number], 'sha256'> & {readonly sha256: JobSha256})[];
}

export interface JobImageSourceBinding extends Omit<JobModelSourceBinding,
  'subject' | 'model' | 'selector' | 'imageSet' | 'imageSetDigest' | 'duplicateHashes' | 'checkpointEvidence'> {
  readonly checkpointEvidence?: never;
  readonly subject: 'image-set';
  readonly model?: never;
  readonly selector?: never;
  readonly imageSet: JobImageSet;
  readonly imageSetDigest: JobSha256;
  readonly duplicateHashes: readonly {readonly names: readonly string[]; readonly sha256: JobSha256}[];
}

export type JobSourceBinding = JobModelSourceBinding | JobImageSourceBinding;
export interface JobCapabilities { readonly imageSetVerdict: true }
export const JOB_CAPABILITIES: JobCapabilities = Object.freeze({imageSetVerdict: true});

export interface JobModelReviewValue {
  readonly stage: 'rig-review' | 'direction-review';
  readonly verdict: JobVerdict;
  readonly words: string;
}
export interface JobImageReviewValue {
  readonly stage: 'image-review';
  readonly verdict: JobVerdict;
  readonly words: string;
  readonly imageNotes?: readonly {readonly name: string; readonly words: string}[];
}

/** Trusted host bootstrap declares who the window was opened for. The UI cannot
 * type or override this binding. It is not keyboard-user authentication. Create
 * maps role to its existing by authority and preserves the declared identity.
 */
export interface JobReviewerBinding {
  readonly id: string;
  readonly role: 'owner' | 'delegate';
}

export interface JobHumanAuthority {
  readonly actor: 'human';
  readonly channel: 'review-ui';
  readonly reviewer: JobReviewerBinding;
}

export type JobVerdict = 'pending' | 'approved' | 'changes-requested';
export type JobPartOutcome = 'pending' | 'clean' | 'flagged';
export type JobReviewStage = 'rig-review' | 'direction-review' | 'image-review';

export type PartsVerdictValue = {
  readonly verdict: 'approved' | 'changes-requested';
  readonly issues: readonly PartsIssue[];
  readonly words: string;
};

export interface JobLegacyPartsVerdictValue {
  readonly verdict: JobVerdict;
  readonly parts: readonly {
    readonly partId: string;
    readonly part: { readonly outcome: JobPartOutcome; readonly note: string };
    readonly mesh: { readonly outcome: JobPartOutcome; readonly note: string };
  }[];
  readonly words: string;
}

export interface JobActValues {
  readonly 'interview-picks': {
    readonly questionId: string;
    readonly selections: readonly {
      readonly itemId: string;
      readonly optionId: string;
      readonly otherText: string | null;
    }[];
    readonly note: string;
  };
  readonly checkpoint: {
    readonly checkpointId: string;
    readonly planStepId: string;
    /** Pending stays in the UI draft and never produces a finalized act.
     * Only pass is eligible for Create's checkpoint sign-off writer. Fail is
     * feedback or a named consumer refusal and never an approval write.
     */
    readonly outcome: 'pass' | 'fail';
    /** Required string, preserved verbatim including empty or whitespace-only
     * words, matching Create's existing writer. This adds no UI action.
     */
    readonly words: string;
  };
  readonly 'parts-verdict': PartsVerdictValue;
  readonly 'review-verdict': JobModelReviewValue | JobImageReviewValue;
  readonly signoff: {
    /** An explicitly declared Create stage. Validation belongs to its writer. */
    readonly stage: string;
    /** Changes requested are a verdict. These three approval stages require
     * source.plan with exact displayed IDs/hashes at runtime, plan-approved,
     * rigging-interview and post-interview. Other stages keep plan nullable
     * where appropriate. Create validates through its existing steps/step_hashes
     * logic. No new owner approval or revision-hash gate is introduced.
     */
    readonly decision: 'approved';
    /** Required string. Empty and whitespace-only words remain valid verbatim. */
    readonly words: string;
  };
}

/** The daemon copies checkpoint planStepId from the validated ask. The browser
 * supplies checkpoint ID, outcome and words only. Create derives execution
 * stage from its authoritative step phase/order. Review never stamps a stage.
 */
export type JobUIActValues = Omit<JobActValues, 'checkpoint' | 'review-verdict'> & {
  readonly checkpoint: Omit<JobActValues['checkpoint'], 'planStepId'>;
  readonly 'review-verdict': JobImageReviewValue
    | (JobModelReviewValue & {readonly stage: 'direction-review'})
    | (JobModelReviewValue & {readonly stage: 'rig-review'; readonly feedback?: readonly Feedback[]});
};

export interface JobActSources {
  readonly 'interview-picks': JobModelSourceBinding & {
    readonly optionSet: NonNullable<JobSourceBinding['optionSet']>;
  };
  readonly checkpoint: JobModelSourceBinding & { readonly plan: JobPlanIdentity };
  readonly 'parts-verdict': JobModelSourceBinding & {
    readonly projectHash: JobSha256;
    readonly selector: Extract<JobSelector, { kind: 'draft' }>;
    readonly parts: JobPartsIdentity;
  };
  readonly 'review-verdict': JobImageSourceBinding | (JobModelSourceBinding & {
    readonly selector: Extract<JobSelector, { kind: 'rig' | 'post' }>;
    readonly model: JobFileIdentity;
  });
  readonly signoff: JobModelSourceBinding;
}

/** Immutable, finalized explicit UI submissions only. All human text and ordered
 * selections are preserved verbatim. A verdict, a signoff and a Create stage
 * transition are separate writes. This union grants no transition authority.
 * Review-verdict stage/selector/direction consistency is checked at runtime.
 * Checkpoint stage is derived by Create. Plan-bound signoff requirements apply
 * to every stage in JOB_PLAN_BOUND_SIGNOFF_STAGES before act creation.
 */
export type JobLegacyAct = {
  [Kind in JobEnabledActKind]: {
    readonly schema: typeof JOB_ACT_SCHEMA;
    readonly actId: JobActId;
    readonly jobId: JobId;
    readonly askId: JobAskId;
    readonly publicationId: JobPublicationId;
    readonly kind: Kind;
    readonly authority: JobHumanAuthority;
    readonly at: string;
  } & (Kind extends 'review-verdict' ? (
    | {readonly source: Exclude<JobActSources['review-verdict'], JobImageSourceBinding>; readonly value: JobModelReviewValue}
    | {readonly source: JobImageSourceBinding; readonly value: JobImageReviewValue}
  ) : Kind extends 'parts-verdict' ? {readonly source: JobActSources['parts-verdict']; readonly value: JobLegacyPartsVerdictValue}
  : {readonly source: JobActSources[Kind]; readonly value: JobActValues[Kind]});
}[JobEnabledActKind];

export type JobRigStill = {
  readonly path: string;
  readonly sha256: JobSha256;
  readonly camera: 'fixed';
} & (
  | {readonly frame: 'setup'; readonly animation?: never}
  | {readonly frame: number; readonly animation: string}
);

export type JobRigReviewAct = Omit<Extract<JobLegacyAct, {kind: 'review-verdict'}>, 'schema' | 'source' | 'value'> & {
  readonly schema: typeof JOB_RIG_REVIEW_ACT_SCHEMA;
  readonly source: JobModelSourceBinding & {
    readonly selector: Extract<JobSelector, {kind: 'rig'}>;
    readonly model: JobFileIdentity;
  };
  readonly value: JobModelReviewValue & {readonly stage: 'rig-review'};
  readonly still: JobRigStill;
};

export type JobPartsVerdictAct = Omit<Extract<JobLegacyAct, {kind: 'parts-verdict'}>, 'schema' | 'value'> & {
  readonly schema: typeof JOB_PARTS_VERDICT_ACT_SCHEMA;
  readonly value: PartsVerdictValue;
};

/** Historical @2 acts remain readable without being backfilled or relabelled.
 * Fresh checkpoint, parts, rig/post verdict and signoff acts are written as act@6. */
export type JobAct = JobLegacyAct | JobRigReviewAct | JobPartsVerdictAct | JobCommentsAct;

/** Authenticated browser provenance. The daemon validates identity and hashes PNG bytes. */
export interface JobRigCapture {
  readonly png: string;
  readonly width: number;
  readonly height: number;
  readonly camera: 'fixed';
  readonly framing: 'default';
  readonly view: 'whole-rig';
  readonly frame: 'setup' | number;
  readonly animation?: string;
  readonly playing: boolean;
  readonly binding: {
    readonly publicationId: JobPublicationId;
    readonly instanceKey: string;
    readonly sourceHash: JobSha256;
    readonly pageId: string;
    readonly askId: JobAskId;
    readonly drawGeneration: number;
    readonly playerGeneration: number;
  };
}

export type JobSubject =
  | { readonly kind: 'interview-picks'; readonly questionId: string; readonly setId: string }
  | {
    readonly kind: 'checkpoint';
    /** The Create plan step ID by default. */
    readonly checkpointId: string;
    /** Required when the displayed Review checkpoint ID differs. The mapping
     * must match Create #184's published binding. Never infer an alias or trust
     * a browser-supplied mapping. Finalized acts always name the resolved ID.
     */
    readonly planStepId?: string;
  }
  | { readonly kind: 'parts-verdict'; readonly draftId: string }
  | { readonly kind: 'review-verdict'; readonly stage: JobReviewStage }
  | { readonly kind: 'signoff'; readonly stage: string };

export interface JobPendingAsk {
  readonly askId: JobAskId;
  readonly publicationId: JobPublicationId;
  readonly subject: JobSubject;
  readonly source: JobSourceBinding;
  readonly status: 'pending' | 'answered' | 'superseded';
}

export type JobInterviewJson =
  | null
  | boolean
  | number
  | string
  | readonly JobInterviewJson[]
  | { readonly [key: string]: JobInterviewJson };

export interface JobInterviewRecord {
  readonly questionId: string;
  readonly record: string;
  readonly setId: string | null;
  readonly ref: JobFileIdentity;
  readonly observedSet: JobFileIdentity | null;
  readonly timeKind: 'inspection' | 'answer' | 'decision';
  readonly at: string | null;
  readonly original: { readonly [key: string]: JobInterviewJson } | null;
}

export type JobInterviewDiagnostic = {
  readonly record: string;
  readonly at: string | null;
} & (
  | {
      readonly code: 'INTERVIEW_OPTIONS_STALE';
      readonly severity: 'error';
    }
  | {
      readonly code: 'INTERVIEW_OPTIONS_SCENE_LEGACY';
      readonly severity: 'warning';
    }
);

export interface JobInterviewDiagnostics {
  readonly schema: 'rig-review/job-interview@1';
  readonly project: JobFileIdentity;
  readonly evaluatedAt: string;
  readonly records: readonly JobInterviewRecord[];
  readonly diagnostics: readonly JobInterviewDiagnostic[];
}

export interface JobPublication {
  readonly publicationId: JobPublicationId;
  readonly instanceKey: JobSha256;
  readonly generation: number;
  readonly source: JobSourceBinding;
  readonly label: string;
  readonly previousPublicationId: JobPublicationId | null;
  readonly visual: { readonly status: 'available' } | {
    readonly status: 'unavailable';
    readonly code: string;
  };
  readonly interview?: JobInterviewDiagnostics | null;
}

export interface JobStatus {
  readonly jobId: JobId;
  readonly generation: number;
  readonly status: 'active' | 'closed';
  readonly publication: JobPublication | null;
  readonly pending: readonly JobPendingAsk[];
  readonly cursor: JobCursor | null;
  readonly enabledActKinds: readonly JobEnabledActKind[];
}

interface JobRequestBase {
  readonly schema: typeof JOB_API_SCHEMA;
  readonly jobId: JobId;
  readonly requestId: string;
}

interface JobMutation extends JobRequestBase {
  readonly expectedGeneration: number;
  readonly idempotencyKey: string;
}

export interface JobPublishRequest extends JobMutation {
  readonly verb: 'publish';
  readonly result: {
    /** Root-relative result designated by the producer, never a command. */
    readonly path: string;
    readonly selector: JobSelector | null;
  };
  readonly freeze: {
    readonly kind: 'producer-held';
    readonly holdId: string;
    /** Exact record used for selection, or null for a declared non-Create root. */
    readonly record: JobFileIdentity | null;
  };
}

export interface JobAskRequest extends JobMutation {
  readonly verb: 'ask';
  readonly publicationId: JobPublicationId;
  readonly subject: JobSubject;
}

export interface JobNextRequest extends JobRequestBase {
  readonly verb: 'next';
  readonly after: JobCursor | null;
  /** Bounded by the daemon. Waiting is abortable and never consumes an act. */
  readonly waitMs: number;
}

export interface JobCloseRequest extends JobMutation {
  readonly verb: 'close';
  readonly reason: string;
}

export type JobAgentRequest =
  | JobPublishRequest
  | JobAskRequest
  | JobNextRequest
  | JobCloseRequest;

/** Consumer fetch is a separate read-only transport, never a human-act writer. */
export interface JobFetchActRequest extends JobRequestBase {
  readonly verb: 'fetch-act';
  readonly actId: JobActId;
}

export const JOB_ERROR_CODES = [
  'JOB_REQUEST_INVALID',
  'JOB_BODY_LIMIT',
  'JOB_LOOPBACK_REQUIRED',
  'JOB_SAME_ORIGIN_REQUIRED',
  'JOB_CAPABILITY_REQUIRED',
  'JOB_AUTHORITY_REFUSED',
  'JOB_UNKNOWN',
  'JOB_CLOSED',
  'JOB_GENERATION_STALE',
  'JOB_IDEMPOTENCY_CONFLICT',
  'JOB_FREEZE_REQUIRED',
  'JOB_RECORD_INCOMPLETE',
  'JOB_RECORD_MOVED',
  'JOB_SOURCE_MISMATCH',
  'JOB_SOURCE_UNRETAINABLE',
  'JOB_ROOT_REPLACED',
  'JOB_PUBLICATION_UNKNOWN',
  'JOB_SNAPSHOT_RECLAIMED',
  'JOB_IMAGE_SET_UNSUPPORTED',
  'JOB_IMAGE_SET_INVALID',
  'JOB_IMAGE_SET_DUPLICATE_NAME',
  'JOB_IMAGE_SET_DUPLICATE_PATH',
  'JOB_IMAGE_SET_ROLE_INVALID',
  'JOB_IMAGE_SET_PATH_REFUSED',
  'JOB_ASK_INVALID',
  'JOB_ASK_SUPERSEDED',
  'JOB_ACT_UNKNOWN',
  'JOB_ACT_INVALID',
  'JOB_ACT_KIND_DISABLED',
  'JOB_ACT_SOURCE_STALE',
  'JOB_DISPLAY_MISMATCH',
  'JOB_STILL_CAPTURE_FAILED',
  'JOB_STILL_CAMERA_NOT_FIXED',
  'JOB_STILL_VIEW_UNSUPPORTED',
  'JOB_STILL_BINDING_MISMATCH',
  'JOB_STILL_UNAVAILABLE',
  'JOB_STILL_OUTPUT_FAILED',
  'JOB_CURSOR_INVALID',
  'JOB_STORAGE_FAILED',
  'JOB_AGENT_ISOLATION_HOLE',
] as const;
export type JobErrorCode = typeof JOB_ERROR_CODES[number];

export interface JobFailure {
  readonly ok: false;
  readonly error: {
    readonly code: JobErrorCode;
    /** Safe bounded detail only. No arbitrary worker text or private paths. */
    readonly message: string;
  };
}

export type JobResult<Value> = { readonly ok: true; readonly value: Value } | JobFailure;

export type JobEvent = {
  readonly cursor: JobCursor;
  readonly jobId: JobId;
  readonly generation: number;
} & (
  | { readonly type: 'published'; readonly publication: JobPublication }
  | { readonly type: 'pending'; readonly ask: JobPendingAsk }
  | { readonly type: 'act'; readonly act: JobAct }
  | { readonly type: 'closed'; readonly reason: string }
);

export interface JobNextValue {
  readonly capabilities?: JobCapabilities;
  readonly events: readonly JobEvent[];
  readonly cursor: JobCursor | null;
  readonly status: 'events' | 'timeout' | 'closed';
}

export interface JobResponseValues {
  readonly publish: JobPublication;
  readonly ask: JobPendingAsk;
  readonly next: JobNextValue;
  readonly close: { readonly status: 'closed'; readonly cursor: JobCursor | null };
  readonly 'fetch-act': JobAct;
}

export type JobApiResponse = {
  [Verb in keyof JobResponseValues]: {
    readonly schema: typeof JOB_API_SCHEMA;
    readonly verb: Verb;
    readonly jobId: JobId;
    readonly requestId: string;
    readonly generation: number;
  } & JobResult<JobResponseValues[Verb]>;
}[keyof JobResponseValues];

/** UI-only payload. Neither authority nor source is accepted from the browser.
 * The daemon authenticates the actual Request and derives both from the nonce.
 * Retrying submissionId returns the same immutable act. Changed payload refuses.
 */
export type JobUISubmission = {
  [Kind in JobEnabledActKind]: {
    readonly publicationId: JobPublicationId;
    readonly askId: JobAskId;
    readonly pageId: string;
    readonly displayedNonce: string;
    readonly expectedGeneration: number;
    readonly submissionId: string;
    readonly kind: Kind;
    readonly value: JobUIActValues[Kind];
    readonly capture?: Kind extends 'review-verdict' ? JobRigCapture : never;
  };
}[JobEnabledActKind];

export interface JobDisplayAcknowledgment {
  readonly publicationId: JobPublicationId;
  readonly pageId: string;
  readonly sourceHash: JobSha256;
}

export interface JobDisplayReceipt {
  readonly publicationId: JobPublicationId;
  readonly pageId: string;
  /** Page-scoped UI secret, never returned by the agent/consumer API. */
  readonly displayedNonce: string;
}

export interface JobDisplayPublication {
  readonly publication: JobPublication;
  /** Same-origin routes pinned to this publication and instance. No current alias. */
  readonly routes: {
    readonly entry: string;
    readonly apiBase: string;
    readonly assetsBase: string;
  };
}

/** Trusted host ports for Lane B. Raw Requests preserve real Origin, capability,
 * size and abort context. A TypeScript value is never authentication evidence.
 * handleJobApi accepts agent verbs and consumer fetch only. The host wires UI
 * methods on separate closed same-origin routes, unavailable to agent tokens.
 * Subscriptions abort cleanly and replay only complete durable events.
 */
export interface JobHostPorts {
  handleJobApi(request: Request): Promise<Response>;
  subscribeJob(input: {
    readonly jobId: JobId;
    readonly after: JobCursor | null;
    readonly signal: AbortSignal;
  }): AsyncIterable<EventV3>;
  readPublication(jobId: JobId, publicationId: JobPublicationId): Promise<JobResult<DisplayPublicationV3>>;
  commitUIAct(jobId: JobId, request: Request): Promise<JobResult<ActV3>>;
  ackDisplayed(jobId: JobId, request: Request): Promise<JobResult<JobDisplayReceipt>>;
  jobLiveness(jobId: JobId): Promise<JobResult<{
    readonly active: boolean;
    readonly busy: boolean;
  }>>;
}

/** HQ-approved honest-agent-shortcut model. Create #184 owns creation and path
 * of a private writer-owned sibling binding outside project.json. Its versioned
 * record carries only the semantic job locator. The binding is never tracked,
 * present in unstaged project output, or shipped in templates/public examples/
 * fixtures. The writer reads its own binding. Agents never construct or carry it.
 * Actual separate-UID isolation remains required for Review's distinct state
 * unreadability test. No same-user forger-resistance claim is made here.
 *
 * The binding's random per-job bearer capability grants finalized act fetch
 * only, via exact loopback routes and Authorization. No next/status response
 * returns it. Human metadata alone never authenticates a fetch. The capability
 * dies at explicit close. Old project history cannot restore it. A new job
 * incarnation has a new grant. Invalid grants refuse by capability/authority
 * name and closed-job fetch refuses JOB_CLOSED. No self-service grant API exists.
 *
 * Create fetches a future mesh act, then passes its typed value IN PROCESS to
 * Parts' public exported API owned by Parts #1159. Parts reads neither Review
 * nor Create storage and takes no Create-project argument for that API. No active
 * rig-parts grant/audience is introduced. Standalone --delta remains legacy
 * outside this cycle. Mesh-edit stays reserved until its separate joint freeze.
 *
 * Consumer writers deduplicate actId before current-source checks, then validate
 * each new source and atomically commit writer result plus replay identity.
 * Replay returns the existing record. A new stale act refuses before mutation.
 * Verdict, sign-off and stage transition remain three separate consumer writes.
 */
export interface JobConsumerGrant {
  readonly mode: typeof JOB_CONSUMER_AUTH_MODE;
  readonly jobId: JobId;
  readonly operation: 'fetch-act';
  readonly actKinds: readonly JobEnabledActKind[];
  readonly lifetime: 'until-explicit-close';
}

export interface RecordOptionResult {
  readonly kind: 'option-set';
  readonly questionId: string;
  readonly setId: string;
}

export interface RecordPlanResult {
  readonly kind: 'plan';
}

export type RecordResult = RecordOptionResult | RecordPlanResult;

export interface PackageResultV3 {
  readonly kind: 'package';
  readonly path: string;
  readonly selector: JobSelector | null;
}

export type PublishResultV3 = PackageResultV3 | RecordResult;

export type ProjectRecord = JobFileIdentity & { readonly path: 'project.json' };

export type RecordFreeze = Omit<JobPublishRequest['freeze'], 'record'> & {
  readonly record: ProjectRecord;
};

export type PublishRequestV3 = Omit<JobPublishRequest, 'schema' | 'result' | 'freeze'> & {
  readonly schema: typeof JOB_API_V3_SCHEMA;
} & (
  | {
    readonly result: Extract<PublishResultV3, { readonly kind: 'package' }>;
    readonly freeze: JobPublishRequest['freeze'];
  }
  | {
    readonly result: RecordResult;
    readonly freeze: RecordFreeze;
  }
);

export type AskRequestV3 = Omit<JobAskRequest, 'schema' | 'subject'> & {
  readonly schema: typeof JOB_API_V3_SCHEMA;
  readonly subject: JobSubject | RecordSubject;
};

export type NextRequestV3 = Omit<JobNextRequest, 'schema'> & {
  readonly schema: typeof JOB_API_V3_SCHEMA;
};

export type CloseRequestV3 = Omit<JobCloseRequest, 'schema'> & {
  readonly schema: typeof JOB_API_V3_SCHEMA;
};

export type AgentRequestV3 =
  | PublishRequestV3
  | AskRequestV3
  | NextRequestV3
  | CloseRequestV3;

export type FetchActRequestV3 = Omit<JobFetchActRequest, 'schema'> & {
  readonly schema: typeof JOB_API_V3_SCHEMA;
};

export interface RecordPicksSubject {
  readonly kind: 'interview-picks';
  readonly questionId: string;
  readonly setId: string;
}

export interface RecordCheckpointSubject {
  readonly kind: 'checkpoint';
  readonly checkpointId: string;
}

export type RecordSignoffStage = typeof JOB_RECORD_SIGNOFF_STAGES[number];

export interface RecordSignoffSubject {
  readonly kind: 'signoff';
  readonly stage: RecordSignoffStage;
}

export interface RecordReopenSubject {
  readonly kind: 'reopen';
  readonly stage: JobId;
}

export type RecordPlanSubject = RecordCheckpointSubject | RecordSignoffSubject | RecordReopenSubject;
export type RecordSubject = RecordPicksSubject | RecordPlanSubject;

export interface RecordPartsIdentity {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

export interface RecordContextBase {
  readonly label: string;
  readonly parts: RecordPartsIdentity;
  readonly inputs: readonly JobFileIdentity[];
  readonly files: readonly JobFileIdentity[];
}

export type OptionContext = RecordContextBase & {
  readonly checkpointEvidence?: never;
  readonly plan: null;
  readonly subjects: readonly [RecordPicksSubject];
};

export type PlanContext = RecordContextBase & {
  readonly checkpointEvidence?: readonly JobCheckpointEvidence[];
  readonly plan: JobPlanIdentity;
  readonly subjects: readonly RecordPlanSubject[];
};

export type RecordPublishedContext = OptionContext | PlanContext;

export interface RecordReaderInput<Result extends RecordResult = RecordResult> {
  readonly root: string;
  readonly record: ProjectRecord;
  readonly result: Result;
  readonly phase: 'inventory' | 'retained';
  readonly parts?: RecordPartsIdentity;
}

export type ReaderValue<Value> = Value | Promise<Value>;

export interface RecordPublicationReader {
  (input: RecordReaderInput<RecordOptionResult>): ReaderValue<OptionContext>;
  (input: RecordReaderInput<RecordPlanResult>): ReaderValue<PlanContext>;
}

export interface RecordHostHooks {
  readonly publicationMode: 'record-and-package';
  readonly readerId: typeof JOB_RECORD_READER_ID;
  readonly readPublished: JobPublicationReader;
  readonly readRecordPublished: RecordPublicationReader;
}

export interface RecordSourceBase {
  readonly package?: never;
  readonly selector?: never;
  readonly model?: never;
  readonly direction?: never;
  readonly appliedResult?: never;
  readonly parts?: never;
  readonly imageSet?: never;
  readonly imageSetDigest?: never;
  readonly duplicateHashes?: never;
  readonly sourceHash: JobSha256;
  readonly projectHash: JobSha256;
  readonly record: ProjectRecord;
  readonly inputs: readonly JobFileIdentity[];
  readonly files: readonly JobFileIdentity[];
}

export type OptionSource = RecordSourceBase & {
  readonly checkpointEvidence?: never;
  readonly subject: 'option-set';
  readonly selection: RecordOptionResult;
  readonly optionSet: { readonly id: string; readonly sha256: JobSha256 };
  readonly optionSetFile: JobFileIdentity;
  readonly plan: null;
  readonly subjects: readonly [RecordPicksSubject];
};

export type PlanSource = RecordSourceBase & {
  readonly checkpointEvidence?: readonly JobCheckpointEvidence[];
  readonly subject: 'plan';
  readonly selection: RecordPlanResult;
  readonly optionSet: null;
  readonly optionSetFile: null;
  readonly plan: JobPlanIdentity;
  readonly subjects: readonly RecordPlanSubject[];
};

export type RecordSource = OptionSource | PlanSource;

export type RecordSignoffValue = Omit<JobActValues['signoff'], 'stage'> & {
  readonly stage: RecordSignoffStage;
};

export interface RecordReopenValue {
  readonly stage: JobId;
  readonly words: string;
}

export interface RecordUIActValues {
  readonly 'interview-picks': JobUIActValues['interview-picks'];
  readonly checkpoint: JobUIActValues['checkpoint'];
  readonly signoff: JobUIActValues['signoff'];
  readonly reopen: RecordReopenValue;
}

export type RecordUISubmission = {
  [Kind in keyof RecordUIActValues]: {
    readonly publicationId: JobPublicationId;
    readonly askId: JobAskId;
    readonly pageId: string;
    readonly displayedNonce: string;
    readonly expectedGeneration: number;
    readonly submissionId: string;
    readonly kind: Kind;
    readonly value: RecordUIActValues[Kind];
    readonly capture?: never;
  };
}[keyof RecordUIActValues];

export type UISubmissionV3 = JobUISubmission | RecordUISubmission;

export type RecordAct = Pick<JobLegacyAct,
  'actId' | 'jobId' | 'askId' | 'publicationId' | 'authority' | 'at'> & {
  readonly schema: typeof JOB_RECORD_ACT_SCHEMA;
} & (
  | {
    readonly kind: 'interview-picks';
    readonly source: OptionSource;
    readonly value: JobActValues['interview-picks'];
  }
  | {
    readonly kind: 'checkpoint';
    readonly source: PlanSource;
    readonly value: JobActValues['checkpoint'];
  }
  | {
    readonly kind: 'signoff';
    readonly source: PlanSource;
    readonly value: RecordSignoffValue;
  }
  | {
    readonly kind: 'reopen';
    readonly source: PlanSource;
    readonly value: RecordReopenValue;
  }
);

export type SourceV3 = JobSourceBinding | RecordSource;
export type ActV3 = JobAct | RecordAct;

export interface JobCapabilitiesV3 extends JobCapabilities {
  readonly recordPublication: true;
  readonly recordActSchema: typeof JOB_RECORD_ACT_SCHEMA;
}

export const JOB_CAPABILITIES_V3: JobCapabilitiesV3 = Object.freeze({
  imageSetVerdict: true,
  recordPublication: true,
  recordActSchema: JOB_RECORD_ACT_SCHEMA,
});

export interface PendingAskV3 extends Omit<JobPendingAsk, 'subject' | 'source'> {
  readonly subject: JobSubject | RecordSubject;
  readonly source: SourceV3;
}

export interface PublicationV3 extends Omit<JobPublication, 'source'> {
  readonly source: SourceV3;
}

export interface DisplayPublicationV3 extends Omit<JobDisplayPublication, 'publication'> {
  readonly publication: PublicationV3;
}

export interface StatusV3 extends Omit<JobStatus, 'publication' | 'pending'> {
  readonly publication: PublicationV3 | null;
  readonly pending: readonly PendingAskV3[];
}

export type EventV3 = {
  readonly cursor: JobCursor;
  readonly jobId: JobId;
  readonly generation: number;
} & (
  | { readonly type: 'published'; readonly publication: PublicationV3 }
  | { readonly type: 'pending'; readonly ask: PendingAskV3 }
  | { readonly type: 'act'; readonly act: ActV3 }
  | { readonly type: 'closed'; readonly reason: string }
);

export interface NextValueV3 {
  readonly capabilities?: JobCapabilities | JobCapabilitiesV3;
  readonly events: readonly EventV3[];
  readonly cursor: JobCursor | null;
  readonly status: 'events' | 'timeout' | 'closed';
}

export interface ResponseValuesV3 {
  readonly publish: PublicationV3;
  readonly ask: PendingAskV3;
  readonly next: NextValueV3;
  readonly close: { readonly status: 'closed'; readonly cursor: JobCursor | null };
  readonly 'fetch-act': ActV3;
}

export type ApiResponseV3 = {
  [Verb in keyof ResponseValuesV3]: {
    readonly schema: typeof JOB_API_V3_SCHEMA;
    readonly verb: Verb;
    readonly jobId: JobId;
    readonly requestId: string;
    readonly generation: number;
  } & JobResult<ResponseValuesV3[Verb]>;
}[keyof ResponseValuesV3];

export type JobRecordOptionResult = RecordOptionResult;
export type JobRecordPlanResult = RecordPlanResult;
export type JobRecordResult = RecordResult;
export type JobPublishResultV3 = PublishResultV3;
export type JobProjectRecord = ProjectRecord;
export type JobRecordFreeze = RecordFreeze;
export type JobPublishRequestV3 = PublishRequestV3;
export type JobAskRequestV3 = AskRequestV3;
export type JobNextRequestV3 = NextRequestV3;
export type JobCloseRequestV3 = CloseRequestV3;
export type JobAgentRequestV3 = AgentRequestV3;
export type JobFetchActRequestV3 = FetchActRequestV3;
export type JobRecordPicksSubject = RecordPicksSubject;
export type JobRecordCheckpointSubject = RecordCheckpointSubject;
export type JobRecordSignoffStage = RecordSignoffStage;
export type JobRecordSignoffSubject = RecordSignoffSubject;
export type JobRecordReopenSubject = RecordReopenSubject;
export type JobRecordPlanSubject = RecordPlanSubject;
export type JobRecordSubject = RecordSubject;
export type JobRecordActKind = RecordActKind;
export type JobRecordPartsIdentity = RecordPartsIdentity;
export type JobRecordContextBase = RecordContextBase;
export type JobOptionContext = OptionContext;
export type JobPlanContext = PlanContext;
export type JobRecordPublishedContext = RecordPublishedContext;
export type JobRecordReaderInput<Result extends RecordResult = RecordResult> = RecordReaderInput<Result>;
export type JobRecordPublicationReader = RecordPublicationReader;
export type JobRecordHostHooks = RecordHostHooks;
export type JobRecordSourceBase = RecordSourceBase;
export type JobOptionSource = OptionSource;
export type JobPlanSource = PlanSource;
export type JobRecordSource = RecordSource;
export type JobRecordSignoffValue = RecordSignoffValue;
export type JobRecordReopenValue = RecordReopenValue;
export type JobRecordUIActValues = RecordUIActValues;
export type JobRecordUISubmission = RecordUISubmission;
export type JobUISubmissionV3 = UISubmissionV3;
export type JobRecordAct = RecordAct;
export type JobSourceV3 = SourceV3;
export type JobActV3 = ActV3;
export type JobPendingAskV3 = PendingAskV3;
export type JobPublicationV3 = PublicationV3;
export type JobDisplayPublicationV3 = DisplayPublicationV3;
export type JobStatusV3 = StatusV3;
export type JobEventV3 = EventV3;
export type JobNextValueV3 = NextValueV3;
export type JobResponseValuesV3 = ResponseValuesV3;
export type JobApiResponseV3 = ApiResponseV3;

