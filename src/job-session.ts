import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_ACT_SCHEMA, JOB_PARTS_VERDICT_ACT_SCHEMA, JOB_RIG_REVIEW_ACT_SCHEMA, JOB_RECORD_READER_ID, jobStillByteLimit, JOB_CAPABILITIES, JOB_CAPABILITIES_V3, JOB_ENABLED_ACT_KINDS,
  type ActV3, type AgentRequestV3, type EventV3, type JobPartsEnumerator, type JobAct, type JobAgentRequest, type JobDisplayAcknowledgment,
  type JobDisplayPublication, type JobDisplayPublicationV3, type JobDisplayReceipt, type JobEvent, type JobFetchActRequest, type JobFetchActRequestV3,
  type JobNextValue, type JobPendingAsk, type JobPublication, type JobPublicationMode, type JobReviewerBinding,
  type NextValueV3, type PendingAskV3, type PublicationV3, type RecordPublicationReader, type RecordSubject, type StatusV3,
} from './job-contract.ts';
import { bindJobAsk, bindJobRecordAsk, finalizeJobAct, parseUISubmission, prepareJobRecordAct, prepareJobStill } from './job-act.ts';
import { isRecordSource, parseRecordSource, jobApiSchemaForMode, jobHash, jobPartsEnumeratorVersion, jobWaitLimitMs, requestDigest, sameCapability } from './job-api.ts';
import {
  assertStoredCheckpointEvidence, assertJobRoot, assertJobSourceCurrent, assertRetainedSnapshotIntact, captureJobRoot, isRetainedRecordSource, prepareJobSource, jobSnapshotHash, removeOwnedJobSnapshot, verifyJobRecordSourceFresh,
  type JobPublicationReader, type JobRetainedSource, type JobRetainedSourceV3, type JobRootIdentity,
} from './job-source.ts';
import { JobError, JobStore, type JobSnapshotOwner, type StoredJob } from './job-store.ts';
import { canonicalStatePath } from './state-dir.ts';
import { loadReview } from './manifest.ts';
import { loadPartsView } from './parts-view.ts';
import { validateStoredPartsComment } from './parts-comment-crops.ts';

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
}

const maximumEventBytes = 512 * 1024;

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

function assertStoredSchemas(data: JobData): void {
  if (data.apiSchema !== JOB_API_SCHEMA || data.actSchema !== JOB_ACT_SCHEMA) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'JOB_STORED_SCHEMA_MISMATCH');
  }
  assertStoredEvidence(data);
}

/** Check only the new extension and its durable copies, including committed replay values. */
function assertStoredEvidence(data: JobData): void {
  for (const stored of Object.values(data.publications)) {
    assertStoredCheckpointEvidence(stored.retained);
    assertStoredEvidenceCopy(stored.publication, data);
  }
  for (const ask of Object.values(data.asks)) assertStoredEvidenceCopy(ask, data);
  for (const act of Object.values(data.acts)) assertStoredEvidenceCopy(act, data);
  for (const event of data.events) {
    if (event.type === 'published') assertStoredEvidenceCopy(event.publication, data);
    if (event.type === 'pending') assertStoredEvidenceCopy(event.ask, data);
    if (event.type === 'act') assertStoredEvidenceCopy(event.act, data);
  }
  for (const replay of Object.values(data.replays)) assertStoredEvidenceCopy(replay.value, data);
}

function assertStoredEvidenceCopy(value: unknown, data: JobData): void {
  if (!value || typeof value !== 'object') return;
  const copy = value as {publicationId: string; source: JobPublication['source'] | PublicationV3['source']};
  const stored = data.publications[copy.publicationId];
  const bound = stored?.retained.source;
  if (!('source' in value) && !(bound && 'checkpointEvidence' in bound)) return;
  if (!copy.source || typeof copy.source !== 'object' || Array.isArray(copy.source)) throw new JobError('JOB_SOURCE_MISMATCH');
  if (!('checkpointEvidence' in copy.source) && !(bound && 'checkpointEvidence' in bound)) return;
  if (!bound || copy.source.sourceHash !== bound.sourceHash ||
      requestDigest(copy.source.checkpointEvidence ?? null) !== requestDigest(bound.checkpointEvidence ?? null) ||
      requestDigest(copy.source.plan) !== requestDigest(bound.plan)) throw new JobError('JOB_SOURCE_MISMATCH');
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
  private operations = 0;
  private disposed = false;
  private observedGeneration: number;

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
      assertStoredSchemas(row.data);
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
    assertStoredSchemas(row.data);
    if (!row.active) {
      row.data.fetchCapability = null;
      row.data.pages = {};
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

  authorize(role: 'agent' | 'ui' | 'consumer', given: string | null): void {
    const current = this.current();
    if (role === 'consumer' && !current.active) throw new JobError('JOB_CLOSED');
    const secret = role === 'agent' ? current.data.agentCapability : role === 'ui' ? current.data.uiCapability : current.data.fetchCapability;
    if (!secret || !sameCapability(given, role === 'ui' ? secret : 'Bearer ' + secret)) {
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
    return { publication: stored.publication, routes: { entry: base, apiBase: base + 'api/', assetsBase: base + 'assets/' } };
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
    assertStoredSchemas(data);
    const previous = data.replays[key];
    if (previous && previous.digest !== digest) throw new JobError('JOB_IDEMPOTENCY_CONFLICT');
    return previous ?? null;
  }

  private active(current: StoredJob<JobData>, generation: number): void {
    if (!current.active) throw new JobError('JOB_CLOSED');
    if (current.data.generation !== generation) throw new JobError('JOB_GENERATION_STALE');
    assertJobRoot(current.data.root);
  }

  private event(data: JobData, value: JobEventPayload): EventV3 {
    const event: EventV3 = { ...value, cursor: randomUUID(), jobId: this.jobId, generation: data.generation };
    if (Buffer.byteLength(JSON.stringify(event)) > maximumEventBytes) {
      throw new JobError('JOB_BODY_LIMIT', 'Job event exceeds its delivery bound');
    }
    data.events.push(event);
    return event;
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  async execute(input: JobAgentRequest | AgentRequestV3 | JobFetchActRequest | JobFetchActRequestV3, signal: AbortSignal): Promise<unknown> {
    if (input.jobId !== this.jobId) throw new JobError('JOB_UNKNOWN');
    if (input.verb === 'next') return this.next(input.after, input.waitMs, signal);
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
          if (Buffer.byteLength(JSON.stringify(event)) > maximumEventBytes) {
            throw new JobError('JOB_BODY_LIMIT', 'Job event exceeds its delivery bound');
          }
          fresh.data.events.push(event);
          const value = {status: 'closed', cursor: event.cursor};
          return {generation: fresh.data.generation, event, replayKey: key, replay: {digest, value}};
        });
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
            if (isRetainedRecordSource(candidate!) || candidate!.source.checkpointEvidence) {
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
            if (data.head !== input.publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
            const retained = data.publications[input.publicationId].retained;
            assertJobSourceCurrent(retained);
            if (isRetainedRecordSource(retained) || retained.source.checkpointEvidence) {
              assertRetainedSnapshotIntact(
                retained.snapshotRoot,
                retained.seals,
                retained.snapshotIdentity,
                'JOB_SOURCE_UNRETAINABLE',
              );
            }
            const ask: JobPendingAsk | PendingAskV3 = isRetainedRecordSource(retained)
              ? {
                  askId: randomUUID(),
                  publicationId: input.publicationId,
                  subject: input.subject,
                  source: bindJobRecordAsk(input.subject, retained),
                  status: 'pending',
                }
              : {
                  askId: randomUUID(),
                  publicationId: input.publicationId,
                  subject: input.subject,
                  source: bindJobAsk(input.subject, retained),
                  status: 'pending',
                };
            data.asks[ask.askId] = ask;
            this.event(data, { type: 'pending', ask });
            result = ask;
            break;
          }
        }
        data.replays[key] = { digest, value: result };
        return { data, ...(snapshot ? {snapshot} : {}) };
      }, fresh => {
        const raced = this.replay(fresh.data, key, digest);
        if (!raced) return false;
        result = raced.value;
        return true;
      });
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
    const act = current.data.acts[actId];
    if (!act) throw new JobError('JOB_ACT_UNKNOWN');
    if (act.schema !== JOB_RIG_REVIEW_ACT_SCHEMA) {
      if (png) throw new JobError('JOB_STILL_UNAVAILABLE');
      return Buffer.from(JSON.stringify(act));
    }
    const stored = this.store.readStill(this.jobId, actId);
    if (!stored || stored.png.byteLength > jobStillByteLimit || stored.actBytes.byteLength > maximumEventBytes ||
        stored.sha256 !== act.still.sha256 || jobHash(stored.png) !== act.still.sha256 ||
        act.still.path !== act.still.sha256 + '.png' ||
        !Buffer.from(stored.actBytes).equals(Buffer.from(JSON.stringify(act)))) {
      throw new JobError('JOB_STILL_CAPTURE_FAILED');
    }
    return Buffer.from(png ? stored.png : stored.actBytes);
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
    });
    return receipt!;
  }

  async commitUIAct(raw: unknown): Promise<ActV3> {
    const parsed = parseUISubmission(raw, this.publicationMode);
    const input = parsed.kind === 'parts-verdict' ? {...parsed, value: structuredClone(parsed.value)} : parsed;
    const digest = requestDigest(input), key = `ui:${input.pageId}:${input.submissionId}`;
    const current = this.current();
    const previous = this.replay(current.data, key, digest);
    if (previous) return previous.value as ActV3;
    if (current.active && input.expectedGeneration <= current.data.generation) {
      const page = current.data.pages[input.pageId];
      if (page && page.publicationId === input.publicationId && sameCapability(input.displayedNonce, page.displayedNonce) &&
          current.data.head === input.publicationId) {
        const ask = current.data.asks[input.askId];
        const stored = current.data.publications[input.publicationId];
        if (ask && stored && isRetainedRecordSource(stored.retained)) {
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
          if (candidate.schema === JOB_PARTS_VERDICT_ACT_SCHEMA && candidate.value.issues.length) {
            await this.readPublicationResponse(input.publicationId, async retained => {
              if (isRetainedRecordSource(retained) || !retained.source.parts) throw new JobError('JOB_ACT_SOURCE_STALE');
              assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals,
                retained.snapshotIdentity, 'JOB_ACT_SOURCE_STALE');
              try {
                const review = await loadReview(retained.manifestPath);
                const painting = review.handoff?.source;
                const sealedPainting = painting && retained.seals.some(file =>
                  file.path === relative(retained.snapshotRoot, painting).split(sep).join('/')) ? painting : undefined;
                const pkg = await loadPartsView(dirname(join(retained.snapshotRoot, retained.source.parts.manifest.path)),
                  {painting: sealedPainting, paintingRoot: retained.snapshotRoot});
                for (const issue of candidate.value.issues) {
                  await validateStoredPartsComment(pkg, issue, false, {sourceHash: retained.source.sourceHash});
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
      const ask = fresh.data.asks[input.askId];
      if (!ask) throw new JobError('JOB_ASK_INVALID');
      const retained = fresh.data.publications[input.publicationId].retained;
      assertJobSourceCurrent(retained);
      if (isRetainedRecordSource(retained) || retained.source.checkpointEvidence || input.kind === 'parts-verdict') {
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

  private events(after: string | null): JobNextValue | NextValueV3 {
    const current = this.current(), events = current.data.events;
    const index = after === null ? -1 : events.findIndex(event => event.cursor === after);
    if (after !== null && index < 0) throw new JobError('JOB_CURSOR_INVALID');
    const batch: EventV3[] = [];
    let size = 0;
    for (const event of events.slice(index + 1, index + 65)) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (bytes > maximumEventBytes) throw new JobError('JOB_BODY_LIMIT', 'Stored job event exceeds its delivery bound');
      if (size + bytes > maximumEventBytes) break;
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

  private async next(after: string | null, waitMs: number, signal: AbortSignal): Promise<JobNextValue | NextValueV3> {
    if (waitMs < 0 || waitMs > jobWaitLimitMs || !Number.isSafeInteger(waitMs)) throw new JobError('JOB_REQUEST_INVALID');
    if (signal.aborted) throw new JobError('JOB_REQUEST_INVALID', 'Request cancelled');
    const ready = this.events(after);
    if (ready.status !== 'timeout' || !waitMs) return ready;
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', abort); reject(new JobError('JOB_REQUEST_INVALID', 'Request cancelled')); };
      const timer = setTimeout(finish, waitMs);
      this.listeners.add(finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (this.events(after).status !== 'timeout') finish();
    });
    return this.events(after);
  }

  async *subscribe(input: { readonly jobId: string; readonly after: string | null; readonly signal: AbortSignal }): AsyncIterable<EventV3> {
    if (input.jobId !== this.jobId) throw new JobError('JOB_UNKNOWN');
    let after = input.after;
    while (!input.signal.aborted) {
      let value: JobNextValue | NextValueV3;
      try { value = await this.next(after, jobWaitLimitMs, input.signal); }
      catch (error) {
        if (input.signal.aborted && error instanceof JobError && error.code === 'JOB_REQUEST_INVALID') return;
        throw error;
      }
      for (const event of value.events) { after = event.cursor; yield event; }
      if (value.status === 'closed') return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.notify();
    this.disposed = true;
    if (!this.busy) this.store.close();
  }
}
