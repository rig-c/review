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

export const JOB_API_SCHEMA = 'rig-review/job-api@2' as const;
export const JOB_ACT_SCHEMA = 'rig-review/act@2' as const;
/** New rig verdicts only. Store/reuse markers and all other acts retain @2. */
export const JOB_RIG_REVIEW_ACT_SCHEMA = 'rig-review/act@3' as const;
export const jobStillByteLimit = 8 * 1024 * 1024;
export const jobCaptureBodyLimit = 12 * 1024 * 1024;
export const jobRawActMediaType = 'application/vnd.rig-review.act+json';
export const JOB_PARTS_ENUMERATOR_RANGE = '>=2.25.0 <3.0.0' as const;

export const JOB_ENABLED_ACT_KINDS = [
  'interview-picks',
  'checkpoint',
  'parts-verdict',
  'review-verdict',
  'signoff',
] as const;

export const JOB_RESERVED_ACT_KINDS = ['described-correction', 'mesh-edit'] as const;
export type JobEnabledActKind = typeof JOB_ENABLED_ACT_KINDS[number];
export type JobReservedActKind = typeof JOB_RESERVED_ACT_KINDS[number];
export type JobActKind = JobEnabledActKind | JobReservedActKind;

export const JOB_PLAN_BOUND_SIGNOFF_STAGES = [
  'plan-approved',
  'rigging-interview',
  'post-interview',
] as const;

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
  'subject' | 'model' | 'selector' | 'imageSet' | 'imageSetDigest' | 'duplicateHashes'> {
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
  readonly 'parts-verdict': {
    readonly verdict: JobVerdict;
    readonly parts: readonly {
      readonly partId: string;
      readonly part: { readonly outcome: JobPartOutcome; readonly note: string };
      readonly mesh: { readonly outcome: JobPartOutcome; readonly note: string };
    }[];
    readonly words: string;
  };
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
export type JobUIActValues = Omit<JobActValues, 'checkpoint'> & {
  readonly checkpoint: Omit<JobActValues['checkpoint'], 'planStepId'>;
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
  ) : {readonly source: JobActSources[Kind]; readonly value: JobActValues[Kind]});
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

/** Historical @2 rig acts remain readable without being backfilled or relabelled. */
export type JobAct = JobLegacyAct | JobRigReviewAct;

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
  }): AsyncIterable<JobEvent>;
  readPublication(jobId: JobId, publicationId: JobPublicationId): Promise<JobResult<JobDisplayPublication>>;
  commitUIAct(jobId: JobId, request: Request): Promise<JobResult<JobAct>>;
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
