import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_ACT_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, JOB_MESH_EDITS_ACT_SCHEMA, JOB_CHEST_LANDMARKS_ACT_SCHEMA, JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_PARTS_VERDICT_ACT_SCHEMA, JOB_RIG_REVIEW_ACT_SCHEMA, JOB_RECORD_READER_ID, jobStillByteLimit, jobActDeliveryLimit, JOB_CAPABILITIES, JOB_CAPABILITIES_V3, JOB_ENABLED_ACT_KINDS,
  type ActV3, type AgentRequestV3, type EventV3, type JobPartsEnumerator, type JobAct, type JobAgentRequest, type JobDisplayAcknowledgment,
  type JobDisplayPublication, type JobDisplayPublicationV3, type JobDisplayReceipt, type JobEvent, type JobFetchActRequest, type JobFetchActRequestV3,
  type JobHostPorts, type JobProgressLineV3, type JobProgressRequestV3, type JobProgressV3, type JobProgressValueV3,
  type JobAnsweredDirectionFeedback, type JobErrorCode, type JobNextValue, type JobPendingAsk, type JobPublication,
  type JobPublicationMode, type JobReviewerBinding,
  type JobSubject, type NextValueV3, type PendingAskV3, type PublicationV3, type RecordPublicationReader, type RecordSubject, type StatusV3,
} from './job-contract.ts';
import { bindJobAsk, bindJobRecordAsk, finalizeCommentOnlyAct, finalizeJobAct, isCommentUISubmission, parseCommentUISubmission, parseUISubmission, prepareJobRecordAct, prepareJobStill } from './job-act.ts';
import { atSubject, isRecordSource, parseRecordSource, parseCommentsAct, parseContextCommentsAct, parseMeshEditsAct, parseChestLandmarksAct, parseCommentOnlyAct, jobApiSchemaForMode, jobHash, jobPartsEnumeratorVersion, jobWaitLimitMs, requestDigest, sameCapability } from './job-api.ts';
import {
  assertStoredCheckpointEvidence, assertJobRoot, assertJobSourceCurrent, assertRetainedSnapshotIntact, captureJobRoot, isRetainedRecordSource, loadRetainedJobReview, parseAnsweredDirectionFeedbackReferences, prepareJobSource, retainedRigDraftVerdict, jobSnapshotHash, removeOwnedJobSnapshot, verifyJobRecordSourceFresh,
  type JobPublicationReader, type JobRetainedSource, type JobRetainedSourceV3, type JobRootIdentity,
} from './job-source.ts';
import { JobError, JobStore, jobCropReferences, type JobSnapshotOwner, type StoredJob } from './job-store.ts';
import { canonicalStatePath } from './state-dir.ts';
import { loadPartsView } from './parts-view.ts';
import { validateStoredPartsComment } from './parts-comment-crops.ts';
import { commentPartsIssues, type PartsIssue } from './parts-comment.ts';
import { noteComments } from './feedback-export.ts';

export type { JobDisplayPublicationV3 } from './job-contract.ts';

type JobEventPayload =
  | { readonly type: 'published'; readonly publication: JobPublication | PublicationV3 }
  | { readonly type: 'pending'; readonly ask: JobPendingAsk | PendingAskV3 }
  | { readonly type: 'act'; readonly act: JobAct | ActV3 }
  | { readonly type: 'closed'; readonly reason: string };

interface StoredPublication {
  publication: JobPublication | PublicationV3;
  retained: JobRetainedSourceV3;
}

interface Replay {
  digest: string;
  value: unknown;
}

interface JobData {
  apiSchema: typeof JOB_API_SCHEMA;
  actSchema: typeof JOB_ACT_SCHEMA;
  root: JobRootIdentity;
  fingerprint: string;
  reviewer: JobReviewerBinding;
  agentCapability: string;
  uiCapability: string;
  fetchCapability: string | null;
  generation: number;
  head: string | null;
  publications: Record<string, StoredPublication>;
  asks: Record<string, JobPendingAsk | PendingAskV3>;
  acts: Record<string, JobAct | ActV3>;
  events: (JobEvent | EventV3)[];
  replays: Record<string, Replay>;
  pages: Record<string, JobDisplayReceipt>;
  progress?: JobProgressV3;
  progressReceipt?: Pick<JobProgressV3, 'seq' | 'at'> & { writes: number };
}

const maximumEventBytes = 512 * 1024;
const progressIntervalMs = 1000;
type JobSubscription = Parameters<JobHostPorts['subscribeJob']>[0];

export interface JobSessionOptions {
  readonly root: string;
  readonly stateDir: string;
  readonly fingerprint: string;
  readonly reviewer: JobReviewerBinding;
  readonly publicationMode?: JobPublicationMode;
  readonly readPublished?: JobPublicationReader;
  readonly readRecordPublished?: RecordPublicationReader;
  readonly recordReaderId?: typeof JOB_RECORD_READER_ID | (string & {});
  readonly partsEnumerator?: JobPartsEnumerator;
  /** Deterministic boundary hook for disposable concurrency controls only. */
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}

function assertStoredSchemas(data: JobData, jobId: string): void {
  if (data.apiSchema !== JOB_API_SCHEMA || data.actSchema !== JOB_ACT_SCHEMA) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'JOB_STORED_SCHEMA_MISMATCH');
  }
  assertStoredEvidence(data, jobId);
}

/** Check optional evidence declarations and their durable copies, including committed replay values. */
function assertStoredEvidence(data: JobData, jobId: string): void {
  for (const stored of Object.values(data.publications)) {
    assertStoredCheckpointEvidence(stored.retained);
    if (Object.hasOwn(stored.retained, 'answeredDirectionFeedback')) {
      const code = 'JOB_SOURCE_MISMATCH';
      if (isRetainedRecordSource(stored.retained) ||
          !Object.hasOwn(stored.publication, 'answeredDirectionFeedback') ||
          requestDigest(stored.publication.answeredDirectionFeedback) !== requestDigest(
            resolveAnsweredDirectionFeedback(stored.retained, stored.publication, data, jobId, code),
          )) throw new JobError(code);
    }
    assertStoredEvidenceCopy(stored.publication, data, true);
  }
  for (const ask of Object.values(data.asks)) assertStoredEvidenceCopy(ask, data);
  for (const act of Object.values(data.acts)) assertStoredEvidenceCopy(act, data);
  for (const event of data.events) {
    if (event.type === 'published') assertStoredEvidenceCopy(event.publication, data, true);
    if (event.type === 'pending') assertStoredEvidenceCopy(event.ask, data);
    if (event.type === 'act') assertStoredEvidenceCopy(event.act, data);
  }
  for (const replay of Object.values(data.replays)) {
    // An ask-batch receipt wraps its asks; each one is a durable copy like a single ask's receipt.
    const asks = (replay.value as {asks?: unknown} | null)?.asks;
    if (Array.isArray(asks)) for (const ask of asks) assertStoredEvidenceCopy(ask, data);
    else assertStoredEvidenceCopy(replay.value, data, !!replay.value && typeof replay.value === 'object' && 'instanceKey' in replay.value);
  }
}

function resolveAnsweredDirectionFeedback(
  retained: JobRetainedSource, publication: Pick<PublicationV3, 'generation'>, data: JobData,
  jobId: string, code: JobErrorCode = 'JOB_ANSWERED_DIRECTION_FEEDBACK_INVALID',
): readonly JobAnsweredDirectionFeedback[] {
  const selector = retained.source.selector;
  if (selector?.kind !== 'post' || !retained.source.direction) throw new JobError(code);
  const references = parseAnsweredDirectionFeedbackReferences(retained.answeredDirectionFeedback, code);
  return references.map(reference => {
    if (reference.jobId !== jobId || !Object.hasOwn(data.acts, reference.actId)) throw new JobError(code);
    const act = data.acts[reference.actId];
    // #1231: direction feedback is a finished direction verdict or a comment-only act@10 on a post (checked below).
    const commentOnly = act?.schema === JOB_COMMENT_ONLY_ACT_SCHEMA && act.kind === 'comments';
    if (act?.actId !== reference.actId || act.jobId !== jobId ||
        !(commentOnly || (act.kind === 'review-verdict' && act.value.stage === 'direction-review')) ||
        !Object.hasOwn(data.publications, act.publicationId)) {
      throw new JobError(code);
    }
    const earlier = data.publications[act.publicationId];
    const post = 'record' in act.source ? null : act.source.selector;
    if (post?.kind !== 'post' || !('direction' in act.source) || !act.source.direction || post.version >= selector.version ||
        earlier.publication.generation >= publication.generation ||
        earlier.retained.source.sourceHash !== act.source.sourceHash ||
        requestDigest(earlier.retained.source.selector) !== requestDigest(post) ||
        requestDigest(earlier.retained.source.direction) !== requestDigest(act.source.direction)) throw new JobError(code);
    const comments = act.schema === JOB_ACT_SCHEMA ? noteComments(act.value.words) :
      act.schema === JOB_COMMENTS_ACT_SCHEMA || act.schema === JOB_COMMENT_CONTEXT_ACT_SCHEMA || commentOnly ? act.value.comments : undefined;
    if (!Array.isArray(comments)) throw new JobError(code);
    return {...reference, postVersion: post.version, answeredByPostVersion: selector.version,
      comments: comments.map(({text, anchor}) => ({text, kind: anchor === undefined ? 'general' : 'pinned'})),
    };
  });
}

function hasStoredEvidence(source: object | undefined): boolean {
  return !!source && ('checkpointEvidence' in source || 'previousDraft' in source);
}

function needsSnapshotRecheck(retained: JobRetainedSourceV3): boolean {
  return isRetainedRecordSource(retained) || hasStoredEvidence(retained.source) || retained.chestLandmarks !== undefined ||
    Object.hasOwn(retained, 'previousBuild');
}

function assertStoredEvidenceCopy(value: unknown, data: JobData, publication = false): void {
  if (!value || typeof value !== 'object') return;
  const copy = value as Pick<PublicationV3, 'publicationId' | 'source' | 'answeredDirectionFeedback'>;
  const stored = data.publications[copy.publicationId];
  const bound = stored?.retained.source;
  const seeds = stored && !isRetainedRecordSource(stored.retained) ? stored.retained.chestLandmarks : undefined;
  if (publication || 'chestLandmarks' in copy) {
    if (('chestLandmarks' in copy) !== (seeds !== undefined) ||
        ('chestLandmarks' in copy && (!publication || requestDigest(copy.chestLandmarks ?? null) !== requestDigest(seeds)))) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
  }
  if (seeds && requestDigest(copy.source ?? null) !== requestDigest(bound)) throw new JobError('JOB_SOURCE_MISMATCH');
  if (stored && Object.hasOwn(stored.retained, 'previousBuild') &&
      copy.source?.sourceHash !== bound?.sourceHash) throw new JobError('JOB_SOURCE_MISMATCH');
  const carriesAnswered = Object.hasOwn(copy, 'answeredDirectionFeedback');
  const boundAnswered = !!stored && Object.hasOwn(stored.retained, 'answeredDirectionFeedback');
  if ((carriesAnswered || (publication && boundAnswered)) &&
      (!publication || !carriesAnswered || !boundAnswered ||
        requestDigest(copy.source ?? null) !== requestDigest(bound) ||
        requestDigest(copy.answeredDirectionFeedback) !== requestDigest(stored.publication.answeredDirectionFeedback))) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const carriesDirection = copy.source && Object.hasOwn(copy.source, 'directionReview');
  const boundDirection = bound && isRecordSource(bound) ? bound.directionReview : undefined;
  if (carriesDirection || (boundDirection && (publication || ('askId' in copy && !('actId' in copy))))) {
    if (!isRecordSource(copy.source) || !boundDirection || 'actId' in copy ||
        copy.source.sourceHash !== bound?.sourceHash ||
        requestDigest(copy.source.directionReview ?? null) !== requestDigest(boundDirection)) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
  }
  if (!('source' in value) && !hasStoredEvidence(bound)) return;
  if (!copy.source || typeof copy.source !== 'object' || Array.isArray(copy.source)) throw new JobError('JOB_SOURCE_MISMATCH');
  if (!hasStoredEvidence(copy.source) && !hasStoredEvidence(bound)) return;
  const copyDraft = 'previousDraft' in copy.source ? copy.source.previousDraft : undefined;
  const boundDraft = bound && 'previousDraft' in bound ? bound.previousDraft : undefined;
  if (!bound || copy.source.sourceHash !== bound.sourceHash ||
      ('previousDraft' in copy.source) !== ('previousDraft' in bound) ||
      requestDigest(copyDraft ?? null) !== requestDigest(boundDraft ?? null) ||
      requestDigest(copy.source.checkpointEvidence ?? null) !== requestDigest(bound.checkpointEvidence ?? null) ||
      !('plan' in copy.source) || requestDigest(copy.source.plan) !== requestDigest(bound.plan)) throw new JobError('JOB_SOURCE_MISMATCH');
  if (isRecordSource(copy.source)) parseRecordSource(copy.source);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** Trusted daemon service. Only createJobHostPorts exposes network operations.
 * Source paths and credentials returned by the trusted host helpers below must
 * never enter an agent response. Create #184 installs its own private binding.
 */
export class JobSession {
  readonly jobId: string;
  readonly publicationMode: JobPublicationMode;
  readonly apiSchema: typeof JOB_API_SCHEMA | typeof JOB_API_V3_SCHEMA;
  private readonly store: JobStore<JobData>;
  private readonly listeners = new Set<() => void>();
  private progressBroadcast?: { seq: number; when: number };
  private operations = 0;
  private disposed = false;
  private observedGeneration: number;
  /** A strict attach shares the live host's store but not its in-process listeners. */
  private readonly attached: boolean;

  /** Last durable generation successfully read by this session. Requires no I/O. */
  get lastObservedGeneration(): number { return this.observedGeneration; }

  static openReadOnly(options: JobSessionOptions, jobId: string): JobSession {
    return new JobSession(options, { jobId });
  }

  constructor(private readonly options: JobSessionOptions, readonlyTarget?: { readonly jobId: string }) {
    if (options.publicationMode !== undefined &&
        options.publicationMode !== 'package-only' &&
        options.publicationMode !== 'record-and-package') {
      throw new JobError('JOB_REQUEST_INVALID');
    }
    if (options.readRecordPublished !== undefined && typeof options.readRecordPublished !== 'function') {
      throw new JobError('JOB_REQUEST_INVALID');
    }
    this.publicationMode = options.publicationMode ?? (options.readRecordPublished ? 'record-and-package' : 'package-only');
    this.apiSchema = jobApiSchemaForMode(this.publicationMode);
    this.attached = readonlyTarget !== undefined;
    const root = captureJobRoot(options.root), state = canonicalStatePath(options.stateDir);
    if (within(root.path, state)) {
      throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Job state must be outside the designated work root');
    }
    if (within(state, root.path)) {
      throw new JobError('JOB_SOURCE_UNRETAINABLE', 'The designated work root must be outside job state');
    }
    if (!options.reviewer.id || !['owner', 'delegate'].includes(options.reviewer.role)) throw new JobError('JOB_AUTHORITY_REFUSED');
    if (options.partsEnumerator) jobPartsEnumeratorVersion(options.partsEnumerator.version);
    const rootKey = jobHash(JSON.stringify([root.path, options.fingerprint]));
    this.store = new JobStore(state, readonlyTarget ? { readonly: true } : {});
    try {
      const row = readonlyTarget
        ? this.store.get(readonlyTarget.jobId)
        : this.store.open(rootKey, () => ({
          apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
          root, fingerprint: options.fingerprint, reviewer: structuredClone(options.reviewer),
          agentCapability: randomBytes(32).toString('hex'), uiCapability: randomBytes(32).toString('hex'),
          fetchCapability: randomBytes(32).toString('hex'), generation: 0, head: null,
          publications: {}, asks: {}, acts: {}, events: [], replays: {}, pages: {},
        }), root.path);
      this.jobId = row.jobId;
      assertStoredSchemas(row.data, this.jobId);
      this.observedGeneration = row.closure?.generation ?? row.data.generation;
      assertJobRoot(row.data.root);
      if (row.rootKey !== rootKey || row.data.root.path !== root.path || row.data.fingerprint !== options.fingerprint) {
        throw new JobError('JOB_SOURCE_MISMATCH');
      }
      if (requestDigest(row.data.reviewer) !== requestDigest(options.reviewer)) {
        throw new JobError('JOB_AUTHORITY_REFUSED', 'Active window reviewer binding differs');
      }
      if (readonlyTarget && !row.active) throw new JobError('JOB_CLOSED');
      if (readonlyTarget) {
        const identity = (item: StoredJob<JobData>) => JSON.stringify([item.jobId, item.rootKey,
          item.data.root, item.data.fingerprint, item.data.reviewer, item.data.apiSchema,
          item.data.actSchema, item.data.agentCapability, item.data.uiCapability]);
        const captured = identity(row);
        this.store.allowExistingWrites(() => {
          const current = this.store.get(this.jobId);
          if (identity(current) !== captured) throw new JobError('JOB_STORAGE_FAILED');
          assertJobRoot(current.data.root);
        });
      }

    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  get busy(): boolean { return this.operations > 0; }

  private current(): StoredJob<JobData> {
    const row = this.store.get(this.jobId);
    assertStoredSchemas(row.data, this.jobId);
    if (!row.active) {
      row.data.fetchCapability = null;
      row.data.pages = {};
      // The durable closure clears the slot without rewriting the historical row.
      delete row.data.progress;
      for (const ask of Object.values(row.data.asks)) {
        if (ask.status === 'pending') row.data.asks[ask.askId] = {...ask, status: 'superseded'};
      }
    }
    if (row.closure) {
      row.data.generation = row.closure.generation;
      row.data.events.push(row.closure.event);
      row.data.replays[row.closure.replayKey] = row.closure.replay;
    }
    this.observedGeneration = row.data.generation;
    return row;
  }

  /** Bootstrap delivery is private host work. Agent and owner credentials go to
   * their separate launch channels. The fetch grant is installed by Create's
   * writer-owned sibling adapter, never printed by the semantic CLI.
   */
  hostCredentials(): { agent: string; ui: string } {
    const { agentCapability, uiCapability } = this.current().data;
    return { agent: agentCapability, ui: uiCapability };
  }

  writerGrant(): { jobId: string; fetchCapability: string } {
    const current = this.current();
    if (!current.active || !current.data.fetchCapability) throw new JobError('JOB_CLOSED');
    return { jobId: this.jobId, fetchCapability: current.data.fetchCapability };
  }

  authorize(role: 'agent' | 'ui' | 'ui-evidence' | 'consumer', given: string | null): void {
    const current = this.current();
    if (role === 'consumer' && !current.active) throw new JobError('JOB_CLOSED');
    const ui = role === 'ui' || role === 'ui-evidence';
    const secret = role === 'agent' ? current.data.agentCapability : ui ? current.data.uiCapability : current.data.fetchCapability;
    if (!secret || !sameCapability(given, ui ? secret : 'Bearer ' + secret)) {
      throw new JobError('JOB_CAPABILITY_REQUIRED');
    }
    if (role === 'ui' && !current.active) throw new JobError('JOB_CLOSED');
  }

  status(): StatusV3 {
    const current = this.current(), data = current.data;
    return {
      jobId: this.jobId, generation: data.generation, status: current.active ? 'active' : 'closed',
      publication: data.head ? data.publications[data.head].publication : null,
      pending: Object.values(data.asks).filter(ask => ask.status === 'pending'),
      cursor: data.events.at(-1)?.cursor ?? null,
      enabledActKinds: JOB_ENABLED_ACT_KINDS,
    };
  }

  /** Internal synchronous owner acceptance snapshot. No external hooks run here. */
  inspectAttach<Value>(inspect: () => Value): Value {
    return this.store.inspect(() => { this.store.assertStorage(); return inspect(); });
  }

  attestation(): {
    readonly jobId: string;
    readonly status: 'active' | 'closed';
    readonly revision: number;
    readonly root: JobRootIdentity;
    readonly stateDir: string;
    readonly fingerprint: string;
    readonly reviewer: JobReviewerBinding;
    readonly apiSchema: typeof JOB_API_SCHEMA;
    readonly actSchema: typeof JOB_ACT_SCHEMA;
  } {
    const current = this.current();
    return {
      jobId: this.jobId,
      status: current.active ? 'active' : 'closed',
      revision: current.revision,
      root: structuredClone(current.data.root),
      stateDir: this.store.root,
      fingerprint: current.data.fingerprint,
      reviewer: structuredClone(current.data.reviewer),
      apiSchema: current.data.apiSchema,
      actSchema: current.data.actSchema,
    };
  }

  retainedSource(publicationId: string): JobRetainedSource {
    const retained = this.retainedSourceV3(publicationId);
    if (isRetainedRecordSource(retained)) {
      throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Record publication has no package manifest');
    }
    return retained;
  }

  retainedSourceV3(publicationId: string): JobRetainedSourceV3 {
    const current = this.current();
    if (!current.active) throw new JobError('JOB_CLOSED');
    const stored = current.data.publications[publicationId];
    if (!stored) throw new JobError('JOB_PUBLICATION_UNKNOWN');
    return stored.retained;
  }

  displayPublication(publicationId: string): JobDisplayPublicationV3 {
    const current = this.current();
    if (!current.active) throw new JobError('JOB_CLOSED');
    const stored = current.data.publications[publicationId];
    if (!stored) throw new JobError('JOB_PUBLICATION_UNKNOWN');
    const base = `/jobs/${this.jobId}/publications/${publicationId}/instances/${stored.publication.instanceKey}/`;
    const rigDraftVerdict = retainedRigDraftVerdict(stored.retained);
    return { publication: stored.publication, ...(rigDraftVerdict ? {rigDraftVerdict: true as const} : {}), routes: { entry: base, apiBase: base + 'api/', assetsBase: base + 'assets/' } };
  }

  /** Internal front seam. A count covers preparation and the entire file stream. */
  async readPublicationResponse(publicationId: string,
    read: (retained: JobRetainedSourceV3) => Promise<Response>): Promise<Response> {
    const retained = this.retainedSourceV3(publicationId);
    const readId = this.store.beginSnapshotRead(this.jobId, publicationId,
      jobSnapshotHash(retained.seals), retained.snapshotRoot);
    this.operations++;
    let operationEnded = false;
    const endOperation = () => {
      if (operationEnded) return;
      operationEnded = true;
      this.finishOperation();
    };
    let finishing: Promise<void> | undefined;
    const finish = () => finishing ??= (async () => {
      try {
        this.store.endSnapshotRead(readId);
        await this.reclaimClosedSnapshots(publicationId);
      } finally { endOperation(); }
    })();
    try {
      const response = await read(retained);
      if (!response.body) { await finish(); return response; }
      const reader = response.body.getReader();
      let cancellation: Promise<void> | undefined;
      const cancel = (reason?: unknown) => cancellation ??= Promise.resolve()
        .then(() => reader.cancel(reason))
        .catch(error => {endOperation(); throw error;});
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { await cancellation; await finish(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) {
            try { await cancel(error); await finish(); }
            catch (cleanupError) {controller.error(cleanupError); return;}
            controller.error(error);
          }
        },
        async cancel(reason) {
          await cancel(reason);
          await finish();
        },
      }, {highWaterMark: 0});
      return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
    } catch (error) {
      // Failed preparation or rejected cancellation cannot prove file closure.
      endOperation();
      throw error;
    }
  }

  /** Internal maintenance, never an agent or consumer operation. */
  async reclaimSnapshot(publicationId: string, snapshotHash: string): Promise<void> {
    const owner = this.store.markSnapshotReclaimed(this.jobId, publicationId, snapshotHash,
      data => Object.values(data.acts).some(act => act.publicationId === publicationId));
    if (!owner) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'JOB_SNAPSHOT_PINNED');
    await removeOwnedJobSnapshot(this.store.root, owner);
  }

  private async reclaimClosedSnapshots(onlyPublicationId?: string): Promise<void> {
    const current = this.current();
    if (current.active) return;
    const publications = onlyPublicationId === undefined ? Object.keys(current.data.publications) : [onlyPublicationId];
    for (const publicationId of publications) {
      // Legacy snapshots without an explicit creation identity stay preserved.
      const owner = this.store.snapshotOwner(this.jobId, publicationId);
      if (!owner) continue;
      const reclaimed = this.store.markSnapshotReclaimed(this.jobId, publicationId, owner.snapshotHash,
        data => Object.values(data.acts).some(act => act.publicationId === publicationId));
      if (reclaimed) await removeOwnedJobSnapshot(this.store.root, reclaimed);
    }
  }

  private finishOperation(): void {
    this.operations--;
    if (this.disposed && !this.busy) this.store.close();
  }

  private replay(data: JobData, key: string, digest: string): Replay | null {
    assertStoredSchemas(data, this.jobId);
    const previous = data.replays[key];
    if (previous && previous.digest !== digest) throw new JobError('JOB_IDEMPOTENCY_CONFLICT');
    return previous ?? null;
  }

  /** A stored agent receipt is returned only while it is still true (#1022). A publication that is no longer the
   * head, or an ask that is no longer pending and has no finalized act, refuses by name and names the head. */
  private assertReplayCurrent(current: StoredJob<JobData>, verb: string, value: unknown): void {
    const data = current.data, head = 'head ' + (data.head ?? 'none');
    if (verb === 'publish') {
      const publicationId = (value as {publicationId: string}).publicationId;
      if (data.head !== publicationId) throw new JobError('JOB_ACT_SOURCE_STALE', `publication ${publicationId} is superseded; ${head}`);
      return;
    }
    const asks = verb === 'ask' ? [value as {askId: string}] : verb === 'ask-batch' ? (value as {asks: {askId: string}[]}).asks : [];
    asks.forEach((ask, index) => {
      const status = data.asks[ask.askId]?.status;
      if (status === 'pending' || status === 'answered') return;
      const prefix = verb === 'ask-batch' ? `subjects[${index}]: ` : '';
      if (!current.active) throw new JobError('JOB_CLOSED', `${prefix}ask ${ask.askId} ended when the job closed`);
      throw new JobError('JOB_ASK_SUPERSEDED', `${prefix}ask ${ask.askId} is superseded; ${head}`);
    });
  }

  private active(current: StoredJob<JobData>, generation: number): void {
    if (!current.active) throw new JobError('JOB_CLOSED');
    if (current.data.generation !== generation) throw new JobError('JOB_GENERATION_STALE');
    assertJobRoot(current.data.root);
  }

  private sameSemanticRevision(observed: StoredJob<JobData>) {
    // Progress writes wake cross-connection observers without invalidating semantic CAS.
    const revision = observed.revision - (observed.data.progressReceipt?.writes ?? 0);
    return (fresh: StoredJob<JobData>) => fresh.revision - (fresh.data.progressReceipt?.writes ?? 0) === revision;
  }

  private event(data: JobData, value: JobEventPayload): EventV3 {
    const event: EventV3 = { ...value, cursor: randomUUID(), jobId: this.jobId, generation: data.generation };
    if (Buffer.byteLength(jobCropReferences(event)) > maximumEventBytes) {
      throw new JobError('JOB_BODY_LIMIT', 'Job event exceeds its delivery bound', maximumEventBytes);
    }
    data.events.push(event);
    if (value.type === 'published' || value.type === 'pending') delete data.progress;
    return event;
  }

  /** The committed head's retained source, re-checked against the work root and its sealed snapshot. */
  private headRetained(data: JobData, publicationId: string): JobRetainedSourceV3 {
    if (data.head !== publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
    const retained = data.publications[publicationId].retained;
    assertJobSourceCurrent(retained);
    if (needsSnapshotRecheck(retained)) {
      assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity, 'JOB_SOURCE_UNRETAINABLE');
    }
    return retained;
  }

  /** Bind one subject to the retained source, store its pending ask and write its `pending` event. */
  private addAsk(data: JobData, publicationId: string, subject: JobSubject | RecordSubject, retained: JobRetainedSourceV3): JobPendingAsk | PendingAskV3 {
    const ask: JobPendingAsk | PendingAskV3 = isRetainedRecordSource(retained)
      ? { askId: randomUUID(), publicationId, subject, source: bindJobRecordAsk(subject, retained), status: 'pending' }
      : { askId: randomUUID(), publicationId, subject, source: bindJobAsk(subject, retained), status: 'pending' };
    data.asks[ask.askId] = ask;
    this.event(data, { type: 'pending', ask });
    return ask;
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  private recordProgress(input: JobProgressRequestV3, signal: AbortSignal): JobProgressValueV3 {
    if (signal.aborted || this.apiSchema !== JOB_API_V3_SCHEMA) throw new JobError('JOB_REQUEST_INVALID');
    const { seq, phase, text, step } = input, at = new Date().toISOString();
    let receipt: JobProgressValueV3 = { status: 'accepted', seq, at };
    this.store.update(this.jobId, null, fresh => {
      const { data } = fresh;
      data.progress = { seq, phase, ...(text !== undefined ? { text } : {}), ...(step ? { step } : {}), at, generation: data.generation };
      data.progressReceipt = { seq, at, writes: (data.progressReceipt?.writes ?? 0) + 1 };
      return { data };
    }, fresh => {
      assertStoredSchemas(fresh.data, this.jobId);
      if (!fresh.active) throw new JobError('JOB_CLOSED');
      const previous = fresh.data.progressReceipt;
      if (!previous || seq > previous.seq) return false;
      receipt = { status: 'ignored', seq: previous.seq, at: previous.at };
      return true;
    });
    return receipt;
  }

  async execute(input: JobAgentRequest | AgentRequestV3 | JobFetchActRequest | JobFetchActRequestV3, signal: AbortSignal): Promise<unknown> {
    if (input.jobId !== this.jobId) throw new JobError('JOB_UNKNOWN');
    // An attached session never sees the live host's notify(), so it watches shared writes like subscribe.
    if (input.verb === 'next') return this.next(input.after, input.waitMs, signal, this.attached ? 'events' : false);
    if (input.verb === 'progress') return this.recordProgress(input, signal);
    if (input.verb === 'fetch-act') {
      const current = this.current();
      if (!current.active) throw new JobError('JOB_CLOSED');
      const act = current.data.acts[input.actId];
      if (!act) throw new JobError('JOB_ACT_UNKNOWN');
      return act;
    }
    const { requestId: _requestId, ...semantic } = input;
    const digest = requestDigest(semantic), key = 'agent:' + input.idempotencyKey;
    let current = this.current();
    const previous = this.replay(current.data, key, digest);
    if (previous) {
      this.assertReplayCurrent(current, input.verb, previous.value);
      this.operations++;
      try {
        if (input.verb === 'close') await this.reclaimClosedSnapshots();
        return previous.value;
      } finally { this.finishOperation(); }
    }
    this.active(current, input.expectedGeneration);
    if (signal.aborted) throw new JobError('JOB_REQUEST_INVALID', 'Request cancelled');
    if (input.verb === 'close') {
      this.operations++;
      try {
        const closure = this.store.sealClose(this.jobId, current.revision, fresh => {
          if (fresh.closure?.replayKey === key) {
            if (fresh.closure.replay.digest !== digest) throw new JobError('JOB_IDEMPOTENCY_CONFLICT');
            return fresh.closure;
          }
          const previous = this.replay(fresh.data, key, digest);
          return previous ? {replay: previous} : null;
        }, fresh => {
          this.active(fresh, input.expectedGeneration);
          fresh.data.generation++;
          const event: JobEvent = {
            type: 'closed',
            reason: input.reason,
            cursor: randomUUID(),
            jobId: this.jobId,
            generation: fresh.data.generation,
          };
          if (Buffer.byteLength(jobCropReferences(event)) > maximumEventBytes) {
            throw new JobError('JOB_BODY_LIMIT', 'Job event exceeds its delivery bound');
          }
          fresh.data.events.push(event);
          const value = {status: 'closed', cursor: event.cursor};
          return {generation: fresh.data.generation, event, replayKey: key, replay: {digest, value}};
        }, this.sameSemanticRevision(current));
        this.notify();
        await this.reclaimClosedSnapshots();
        return closure.replay.value;
      } finally { this.finishOperation(); }
    }
    let candidate: JobRetainedSourceV3 | null = null;
    this.operations++;
    try {
      if (input.verb === 'publish') {
        candidate = input.schema === JOB_API_V3_SCHEMA
          ? await prepareJobSource({
              root: current.data.root,
              stateRoot: this.store.root,
              fingerprint: current.data.fingerprint,
              request: input,
              readPublished: this.options.readPublished,
              readRecordPublished: this.options.readRecordPublished,
              partsEnumerator: this.options.partsEnumerator,
              afterSnapshot: this.options.afterSnapshot,
              afterDirectorySync: this.options.afterDirectorySync,
            })
          : await prepareJobSource({
              root: current.data.root,
              stateRoot: this.store.root,
              fingerprint: current.data.fingerprint,
              request: input,
              readPublished: this.options.readPublished,
              partsEnumerator: this.options.partsEnumerator,
              afterSnapshot: this.options.afterSnapshot,
              afterDirectorySync: this.options.afterDirectorySync,
            });
      } else if (input.verb === 'ask') {
        if (current.data.head === input.publicationId) {
          const stored = current.data.publications[input.publicationId];
          if (stored && isRetainedRecordSource(stored.retained)) {
            bindJobRecordAsk(input.subject, stored.retained);
            if (!this.options.readRecordPublished) {
              throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Record publication requires a trusted record reader');
            }
            await verifyJobRecordSourceFresh({
              retained: stored.retained,
              readRecordPublished: this.options.readRecordPublished,
              phase: 'ask',
              subject: input.subject as RecordSubject,
            });
          }
        }
      } else if (input.verb === 'ask-batch') {
        // One freshness read for the whole batch; every subject binds and validates against it (#963).
        if (current.data.head !== input.publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
        const retained = current.data.publications[input.publicationId].retained;
        if (!isRetainedRecordSource(retained)) throw new JobError('JOB_REQUEST_INVALID', 'ask-batch requires a record publication');
        input.subjects.forEach((subject, index) => atSubject(index, () => bindJobRecordAsk(subject, retained)));
        if (!this.options.readRecordPublished) {
          throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Record publication requires a trusted record reader');
        }
        await verifyJobRecordSourceFresh({
          retained,
          readRecordPublished: this.options.readRecordPublished,
          phase: 'ask',
          subjects: input.subjects as readonly RecordSubject[],
        });
      }
      if (signal.aborted) throw new JobError('JOB_REQUEST_INVALID', 'Request cancelled');
      current = this.current();
      let result: unknown;
      this.store.update(this.jobId, current.revision, fresh => {
        this.active(fresh, input.expectedGeneration);
        const data = fresh.data;
        let snapshot: JobSnapshotOwner | undefined;
        data.generation++;
        switch (input.verb) {
          case 'publish': {
            assertJobSourceCurrent(candidate!);
            if (needsSnapshotRecheck(candidate!)) {
              assertRetainedSnapshotIntact(
                candidate!.snapshotRoot,
                candidate!.seals,
                candidate!.snapshotIdentity,
                'JOB_SOURCE_UNRETAINABLE',
              );
            }
            const publication: JobPublication | PublicationV3 = {
              publicationId: randomUUID(), instanceKey: candidate!.instanceKey, generation: data.generation,
              source: candidate!.source, label: candidate!.label, previousPublicationId: data.head, visual: candidate!.visual,
              ...(!isRetainedRecordSource(candidate!) && candidate!.interview !== undefined ? { interview: candidate!.interview } : {}),
              ...(!isRetainedRecordSource(candidate!) && candidate!.chestLandmarks ? {chestLandmarks: candidate!.chestLandmarks} : {}),
              ...(!isRetainedRecordSource(candidate!) && candidate!.answeredDirectionFeedback ? {
                answeredDirectionFeedback: resolveAnsweredDirectionFeedback(candidate!, {generation: data.generation}, data, this.jobId),
              } : {}),
            };
            for (const ask of Object.values(data.asks)) {
              if (ask.status === 'pending') data.asks[ask.askId] = { ...ask, status: 'superseded' };
            }
            data.publications[publication.publicationId] = { publication, retained: candidate! };
            snapshot = {publicationId: publication.publicationId, snapshotHash: jobSnapshotHash(candidate!.seals),
              snapshotRoot: candidate!.snapshotRoot, ...candidate!.snapshotIdentity!};
            data.head = publication.publicationId;
            this.event(data, { type: 'published', publication });
            result = publication;
            break;
          }
          case 'ask': {
            result = this.addAsk(data, input.publicationId, input.subject, this.headRetained(data, input.publicationId));
            break;
          }
          case 'ask-batch': {
            // One head/source/snapshot re-check, then every ask under its own generation and pending event.
            const retained = this.headRetained(data, input.publicationId);
            const asks = input.subjects.map((subject, index) => {
              if (index > 0) data.generation++;
              return atSubject(index, () => this.addAsk(data, input.publicationId, subject, retained));
            });
            result = { asks };
            break;
          }
        }
        data.replays[key] = { digest, value: result };
        return { data, ...(snapshot ? {snapshot} : {}) };
      }, fresh => {
        const raced = this.replay(fresh.data, key, digest);
        if (!raced) return false;
        this.assertReplayCurrent(fresh, input.verb, raced.value);
        result = raced.value;
        return true;
      }, this.sameSemanticRevision(current));
      this.notify();
      return result;
    } finally {
      try {
        if (candidate?.snapshotIdentity && !this.store.snapshotReferenced(candidate.snapshotRoot)) {
          await removeOwnedJobSnapshot(this.store.root, {snapshotRoot: candidate.snapshotRoot, ...candidate.snapshotIdentity});
        }
      } finally { this.finishOperation(); }
    }
  }

  /** Bounded immutable bytes selected only through the authenticated consumer port. */
  readActExport(actId: string, png: boolean): Buffer {
    const current = this.current();
    if (!current.active) throw new JobError('JOB_CLOSED');
    const storedAct = current.data.acts[actId];
    if (!storedAct) throw new JobError('JOB_ACT_UNKNOWN');
    // Validation must not replace the stored representation or reorder its keys.
    if (storedAct.schema === JOB_COMMENTS_ACT_SCHEMA) parseCommentsAct(storedAct);
    if (storedAct.schema === JOB_COMMENT_CONTEXT_ACT_SCHEMA) parseContextCommentsAct(storedAct);
    if (storedAct.schema === JOB_MESH_EDITS_ACT_SCHEMA) parseMeshEditsAct(storedAct);
    if (storedAct.schema === JOB_CHEST_LANDMARKS_ACT_SCHEMA) parseChestLandmarksAct(storedAct);
    if (storedAct.schema === JOB_COMMENT_ONLY_ACT_SCHEMA) parseCommentOnlyAct(storedAct);
    const still = 'still' in storedAct ? storedAct.still : undefined;
    const actBytes = Buffer.from(JSON.stringify(storedAct));
    if (storedAct.schema !== JOB_RIG_REVIEW_ACT_SCHEMA && !still) {
      if (png) throw new JobError('JOB_STILL_UNAVAILABLE');
      return actBytes;
    }
    if (!still) throw new JobError('JOB_STILL_CAPTURE_FAILED');
    const stored = this.store.readStill(this.jobId, actId);
    if (!stored || stored.png.byteLength > jobStillByteLimit || stored.actBytes.byteLength > jobActDeliveryLimit ||
        stored.sha256 !== still.sha256 || jobHash(stored.png) !== still.sha256 ||
        still.path !== still.sha256 + '.png' ||
        !Buffer.from(stored.actBytes).equals(actBytes)) {
      throw new JobError('JOB_STILL_CAPTURE_FAILED');
    }
    return Buffer.from(png ? stored.png : stored.actBytes);
  }

  readCommentCrop(sha256: string): Buffer {
    const current = this.current();
    let referenced = false;
    jobCropReferences(current.data.events, hash => { if (hash === sha256) referenced = true; });
    if (!/^[a-f0-9]{64}$/.test(sha256) || !referenced) {
      throw new JobError('JOB_ACT_UNKNOWN');
    }
    return this.store.readCrop(sha256);
  }

  ackDisplayed(input: JobDisplayAcknowledgment): JobDisplayReceipt {
    const current = this.current();
    let receipt: JobDisplayReceipt;
    this.store.update(this.jobId, current.revision, fresh => {
      this.active(fresh, fresh.data.generation);
      const publication = fresh.data.publications[input.publicationId]?.publication;
      if (fresh.data.head !== input.publicationId || publication?.source.sourceHash !== input.sourceHash) {
        throw new JobError('JOB_DISPLAY_MISMATCH');
      }
      receipt = { publicationId: input.publicationId, pageId: input.pageId, displayedNonce: randomBytes(32).toString('hex') };
      fresh.data.pages[input.pageId] = receipt;
      return { data: fresh.data };
    }, undefined, this.sameSemanticRevision(current));
    return receipt!;
  }

  /** Pointed Parts issues are re-read against the sealed parts package before the act is stored. */
  private async validatePartsPins(publicationId: string, issues: readonly PartsIssue[]): Promise<void> {
    if (!issues.length) return;
    await this.readPublicationResponse(publicationId, async retained => {
      if (isRetainedRecordSource(retained) || !retained.source.parts) throw new JobError('JOB_ACT_SOURCE_STALE');
      assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals,
        retained.snapshotIdentity, 'JOB_ACT_SOURCE_STALE');
      try {
        const review = await loadRetainedJobReview(retained, this.attestation().fingerprint);
        const painting = review.handoff?.source;
        const sealedPainting = painting && retained.seals.some(file =>
          file.path === relative(retained.snapshotRoot, painting).split(sep).join('/')) ? painting : undefined;
        const pkg = await loadPartsView(dirname(join(retained.snapshotRoot, retained.source.parts.manifest.path)),
          {painting: sealedPainting, paintingRoot: retained.snapshotRoot});
        for (const issue of issues) {
          await validateStoredPartsComment(pkg, issue, false, {
            sourceHash: retained.source.sourceHash, previousDraft: retained.source.previousDraft,
          });
        }
      } catch (error) {
        if (error instanceof JobError) throw error;
        throw new JobError('JOB_ACT_INVALID');
      }
      assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals,
        retained.snapshotIdentity, 'JOB_ACT_SOURCE_STALE');
      return new Response(null, {status: 204});
    });
  }

  async commitUIAct(raw: unknown): Promise<ActV3> {
    const parsed = isCommentUISubmission(raw) ? parseCommentUISubmission(raw) : parseUISubmission(raw, this.publicationMode);
    const input = parsed.kind === 'parts-verdict' ? {...parsed, value: structuredClone(parsed.value)} : parsed;
    const digest = requestDigest(input), key = `ui:${input.pageId}:${input.submissionId}`;
    const current = this.current();
    const previous = this.replay(current.data, key, digest);
    if (previous) return previous.value as ActV3;
    if (input.kind === 'signoff' || input.kind === 'checkpoint' || input.kind === 'interview-picks') {
      throw new JobError('JOB_ACT_KIND_DISABLED');
    }
    if (current.active && input.expectedGeneration <= current.data.generation) {
      const page = current.data.pages[input.pageId];
      if (page && page.publicationId === input.publicationId && sameCapability(input.displayedNonce, page.displayedNonce) &&
          current.data.head === input.publicationId) {
        const ask = input.kind === 'comments' ? undefined : current.data.asks[input.askId];
        const stored = current.data.publications[input.publicationId];
        if (input.kind === 'comments') {
          if (!stored) throw new JobError('JOB_ACT_SOURCE_STALE');
          // #1226: the same writer runs again inside the store update; this pass reads what that update cannot.
          const candidate = finalizeCommentOnlyAct({jobId: this.jobId, submission: input, retained: stored.retained,
            reviewer: current.data.reviewer});
          if (isRetainedRecordSource(stored.retained)) {
            if (!this.options.readRecordPublished) {
              throw new JobError('JOB_ACT_SOURCE_STALE', 'Record publication requires a trusted record reader');
            }
            await verifyJobRecordSourceFresh({retained: stored.retained, readRecordPublished: this.options.readRecordPublished,
              phase: 'finalize'});
          } else {
            await this.validatePartsPins(input.publicationId, commentPartsIssues(candidate.value.comments));
          }
        } else if (ask && stored && isRetainedRecordSource(stored.retained)) {
          prepareJobRecordAct({
            jobId: this.jobId,
            submission: input,
            ask,
            retained: stored.retained,
            reviewer: current.data.reviewer,
          });
          if (!this.options.readRecordPublished) {
            throw new JobError('JOB_ACT_SOURCE_STALE', 'Record publication requires a trusted record reader');
          }
          await verifyJobRecordSourceFresh({
            retained: stored.retained,
            readRecordPublished: this.options.readRecordPublished,
            phase: 'finalize',
            subject: ask.subject as RecordSubject,
          });
        } else if (ask && stored && input.kind === 'parts-verdict') {
          assertJobSourceCurrent(stored.retained);
          const candidate = finalizeJobAct({jobId: this.jobId, submission: input, ask,
            retained: stored.retained, reviewer: current.data.reviewer});
          const issues = candidate.kind !== 'parts-verdict' ? [] : candidate.schema === JOB_COMMENTS_ACT_SCHEMA ?
            commentPartsIssues(candidate.value.comments) : candidate.schema === JOB_PARTS_VERDICT_ACT_SCHEMA ? candidate.value.issues : [];
          await this.validatePartsPins(input.publicationId, issues);
        }
      }
    }
    let act: ActV3;
    this.store.update(this.jobId, null, fresh => {
      // UI captures an observed generation. Unrelated asks may advance it while
      // this same ask/source/publication/nonce stays valid. Agent mutation CAS
      // remains global. Future UI generations cannot describe a displayed state.
      this.active(fresh, fresh.data.generation);
      if (input.expectedGeneration > fresh.data.generation) throw new JobError('JOB_GENERATION_STALE');
      const page = fresh.data.pages[input.pageId];
      if (!page || page.publicationId !== input.publicationId || !sameCapability(input.displayedNonce, page.displayedNonce)) {
        throw new JobError('JOB_DISPLAY_MISMATCH');
      }
      if (fresh.data.head !== input.publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
      if (input.kind === 'comments') {
        // #1226: answers no ask and supersedes none; the receipt above is the binding.
        const retained = fresh.data.publications[input.publicationId].retained;
        assertJobSourceCurrent(retained);
        assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity, 'JOB_ACT_SOURCE_STALE');
        act = finalizeCommentOnlyAct({jobId: this.jobId, submission: input, retained, reviewer: fresh.data.reviewer});
        fresh.data.generation++;
        fresh.data.acts[act.actId] = act;
        fresh.data.replays[key] = {digest, value: act};
        this.event(fresh.data, {type: 'act', act});
        return {data: fresh.data};
      }
      const ask = fresh.data.asks[input.askId];
      if (!ask) throw new JobError('JOB_ASK_INVALID');
      const retained = fresh.data.publications[input.publicationId].retained;
      assertJobSourceCurrent(retained);
      if (needsSnapshotRecheck(retained) || input.kind === 'parts-verdict') {
        assertRetainedSnapshotIntact(
          retained.snapshotRoot,
          retained.seals,
          retained.snapshotIdentity,
          'JOB_ACT_SOURCE_STALE',
        );
      }
      const captured = !isRetainedRecordSource(retained) && ask.subject.kind === 'review-verdict' && ask.subject.stage === 'rig-review' ?
        prepareJobStill(input, ask as JobPendingAsk, retained) : undefined;
      act = finalizeJobAct({ jobId: this.jobId, submission: input, ask, retained, reviewer: fresh.data.reviewer,
        still: captured?.still });
      fresh.data.generation++;
      fresh.data.acts[act.actId] = act;
      fresh.data.asks[ask.askId] = { ...ask, status: 'answered' };
      fresh.data.replays[key] = { digest, value: act };
      this.event(fresh.data, { type: 'act', act });
      return { data: fresh.data, ...(captured ? {still: {
        actId: act.actId, pageId: input.pageId, submissionId: input.submissionId,
        sha256: captured.still.sha256, binding: JSON.stringify(captured.binding),
        png: captured.bytes, actBytes: Buffer.from(JSON.stringify(act)),
      }} : {}) };
    }, fresh => {
      const raced = this.replay(fresh.data, key, digest);
      if (!raced) return false;
      act = raced.value as ActV3;
      return true;
    });
    this.notify();
    return act!;
  }

  private events(after: string | null, current = this.current()): JobNextValue | NextValueV3 {
    const events = current.data.events;
    const index = after === null ? -1 : events.findIndex(event => event.cursor === after);
    if (after !== null && index < 0) throw new JobError('JOB_CURSOR_INVALID');
    const batch: EventV3[] = [];
    let size = 0;
    for (const event of events.slice(index + 1, index + 65)) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      const metadataBytes = Buffer.byteLength(jobCropReferences(event));
      if (metadataBytes > maximumEventBytes || bytes > jobActDeliveryLimit) throw new JobError('JOB_BODY_LIMIT', 'Stored job event exceeds its delivery bound');
      if (batch.length && size + bytes > jobActDeliveryLimit) break;
      size += bytes;
      batch.push(event);
    }
    const cursor = batch.at(-1)?.cursor ?? after;
    const status = batch.length ? 'events' : current.active ? 'timeout' : 'closed';
    return {
      capabilities: this.publicationMode === 'record-and-package' ? JOB_CAPABILITIES_V3 : JOB_CAPABILITIES,
      events: batch,
      cursor,
      status,
    };
  }

  /**
   * `observeWrites` polls the shared store revision for commits from other sessions. `'revision'` (subscribe)
   * wakes on any commit; `'events'` (an attached act wait) wakes only once a commit left an event to deliver.
   */
  private async next(after: string | null, waitMs: number, signal: AbortSignal,
    observeWrites: false | 'revision' | 'events' = false): Promise<JobNextValue | NextValueV3> {
    if (waitMs < 0 || waitMs > jobWaitLimitMs || !Number.isSafeInteger(waitMs)) throw new JobError('JOB_REQUEST_INVALID');
    if (signal.aborted) throw new JobError('JOB_REQUEST_INVALID', 'Request cancelled');
    // Capture before reading events so a commit between the read and listener registration still wakes us.
    const observe = observeWrites ? { revision: this.store.revision(this.jobId), mode: observeWrites } : null;
    const ready = this.events(after);
    if (ready.status !== 'timeout' || !waitMs) return ready;
    await this.waitForChange(after, waitMs, signal, observe);
    return this.events(after);
  }

  private waitForChange(after: string | null, waitMs: number, signal: AbortSignal,
    observe: { readonly revision: number; readonly mode: 'revision' | 'events' } | null): Promise<void> {
    let revision = observe?.revision ?? null;
    return new Promise<void>((resolve, reject) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      let settled = false;
      const cleanup = () => { clearTimeout(timer); clearInterval(poll); this.listeners.delete(finish); signal.removeEventListener('abort', abort); };
      const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
      const abort = () => fail(new JobError('JOB_REQUEST_INVALID', 'Request cancelled'));
      const changed = () => {
        try {
          const observed = this.store.revision(this.jobId);
          if (observed === revision) return;
          if (observe?.mode === 'revision') return finish();
          // An act wait stays open across a write without a deliverable event (display receipt).
          revision = observed;
          if (this.events(after).status !== 'timeout') finish();
        }
        catch (error) { fail(error); }
      };
      const timer = setTimeout(finish, waitMs);
      this.listeners.add(finish);
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) abort();
        else if (revision !== null) {
          // Other sessions commit to the same store but cannot notify this instance's listeners.
          poll = setInterval(changed, 250);
          changed();
        } else if (this.events(after).status !== 'timeout') finish();
      } catch (error) { fail(error); }
    });
  }

  subscribe(input: JobSubscription): AsyncIterable<EventV3>;
  subscribe(input: JobSubscription, page: true): AsyncIterable<EventV3 | JobProgressLineV3>;
  async *subscribe(input: JobSubscription, page = false): AsyncIterable<EventV3 | JobProgressLineV3> {
    if (input.jobId !== this.jobId) throw new JobError('JOB_UNKNOWN');
    let after = input.after;
    let delivered: JobProgressV3 | null | undefined;
    const line = (progress: JobProgressV3 | null): JobProgressLineV3 => ({
      type: 'progress', jobId: this.jobId, progress, now: new Date().toISOString(),
    });
    while (!input.signal.aborted) {
      // Read the scalar revision first so a commit between this snapshot and waiting is observed.
      const revision = this.store.revision(this.jobId);
      const current = this.current(), value = this.events(after, current);
      const progress = current.data.progress ?? null;
      const displayed = delivered;
      if (page && displayed === undefined) {
        delivered = progress;
        yield line(delivered);
      } else if (page && displayed && (!progress || value.events.some(event =>
        event.type !== 'act' && event.generation > displayed.generation))) {
        delivered = null;
        yield line(null);
      }
      for (const event of value.events) { after = event.cursor; yield event; }
      if (value.status === 'closed') return;
      if (value.events.length) continue;
      let waitMs = jobWaitLimitMs;
      if (page && progress && delivered?.seq !== progress.seq) {
        // Share the cadence across pages. Keep waiting for the trailing slot even when writes stop.
        const when = performance.now();
        const previous = this.progressBroadcast;
        if (!previous || previous.seq === progress.seq || when - previous.when >= progressIntervalMs) {
          if (previous?.seq !== progress.seq) this.progressBroadcast = { seq: progress.seq, when };
          delivered = progress;
          yield line(delivered);
          continue;
        }
        waitMs = Math.ceil(progressIntervalMs - (when - previous.when));
      }
      try { await this.waitForChange(after, waitMs, input.signal, { revision, mode: 'revision' }); }
      catch (error) {
        if (input.signal.aborted && error instanceof JobError && error.code === 'JOB_REQUEST_INVALID') return;
        throw error;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.notify();
    this.disposed = true;
    if (!this.busy) this.store.close();
  }
}
