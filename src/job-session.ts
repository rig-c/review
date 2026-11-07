import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import {
  JOB_API_SCHEMA, JOB_ACT_SCHEMA, JOB_ENABLED_ACT_KINDS, type JobPartsEnumerator, type JobAct, type JobAgentRequest, type JobDisplayAcknowledgment,
  type JobDisplayPublication, type JobDisplayReceipt, type JobEvent, type JobFetchActRequest,
  type JobNextValue, type JobPendingAsk, type JobPublication, type JobReviewerBinding, type JobStatus,
} from './job-contract.ts';
import { bindJobAsk, finalizeJobAct, parseUISubmission } from './job-act.ts';
import { jobHash, jobPartsEnumeratorVersion, jobWaitLimitMs, requestDigest, sameCapability } from './job-api.ts';
import {
  assertJobRoot, assertJobSourceCurrent, captureJobRoot, prepareJobSource,
  type JobPublicationReader, type JobRetainedSource, type JobRootIdentity,
} from './job-source.ts';
import { JobError, JobStore, type StoredJob } from './job-store.ts';
import { canonicalStatePath } from './state-dir.ts';

interface StoredPublication {
  publication: JobPublication;
  retained: JobRetainedSource;
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
  asks: Record<string, JobPendingAsk>;
  acts: Record<string, JobAct>;
  events: JobEvent[];
  replays: Record<string, Replay>;
  pages: Record<string, JobDisplayReceipt>;
}

const maximumEventBytes = 512 * 1024;

export interface JobSessionOptions {
  readonly root: string;
  readonly stateDir: string;
  readonly fingerprint: string;
  readonly reviewer: JobReviewerBinding;
  readonly readPublished?: JobPublicationReader;
  readonly partsEnumerator?: JobPartsEnumerator;
  /** Deterministic boundary hook for disposable concurrency controls only. */
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}

function assertStoredSchemas(data: JobData): void {
  if (data.apiSchema !== JOB_API_SCHEMA || data.actSchema !== JOB_ACT_SCHEMA) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'JOB_STORED_SCHEMA_MISMATCH');
  }
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
  private readonly store: JobStore<JobData>;
  private readonly listeners = new Set<() => void>();
  private operations = 0;

  constructor(private readonly options: JobSessionOptions) {
    const root = captureJobRoot(options.root), state = canonicalStatePath(options.stateDir);
    if (within(root.path, state)) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Job state must be outside the designated work root');
    if (!options.reviewer.id || !['owner', 'delegate'].includes(options.reviewer.role)) throw new JobError('JOB_AUTHORITY_REFUSED');
    if (options.partsEnumerator) jobPartsEnumeratorVersion(options.partsEnumerator.version);
    this.store = new JobStore(state);
    try {
      const row = this.store.open(jobHash(JSON.stringify([root.path, options.fingerprint])), () => ({
        apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
        root, fingerprint: options.fingerprint, reviewer: structuredClone(options.reviewer),
        agentCapability: randomBytes(32).toString('hex'), uiCapability: randomBytes(32).toString('hex'),
        fetchCapability: randomBytes(32).toString('hex'), generation: 0, head: null,
        publications: {}, asks: {}, acts: {}, events: [], replays: {}, pages: {},
      }), root.path);
      this.jobId = row.jobId;
      assertStoredSchemas(row.data);
      assertJobRoot(row.data.root);
      if (requestDigest(row.data.reviewer) !== requestDigest(options.reviewer)) {
        throw new JobError('JOB_AUTHORITY_REFUSED', 'Active window reviewer binding differs');
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

  status(): JobStatus {
    const current = this.current(), data = current.data;
    return {
      jobId: this.jobId, generation: data.generation, status: current.active ? 'active' : 'closed',
      publication: data.head ? data.publications[data.head].publication : null,
      pending: Object.values(data.asks).filter(ask => ask.status === 'pending'),
      cursor: data.events.at(-1)?.cursor ?? null,
      enabledActKinds: JOB_ENABLED_ACT_KINDS,
    };
  }

  retainedSource(publicationId: string): JobRetainedSource {
    const stored = this.current().data.publications[publicationId];
    if (!stored) throw new JobError('JOB_PUBLICATION_UNKNOWN');
    return stored.retained;
  }

  displayPublication(publicationId: string): JobDisplayPublication {
    const stored = this.current().data.publications[publicationId];
    if (!stored) throw new JobError('JOB_PUBLICATION_UNKNOWN');
    const base = `/jobs/${this.jobId}/publications/${publicationId}/instances/${stored.publication.instanceKey}/`;
    return { publication: stored.publication, routes: { entry: base, apiBase: base + 'api/', assetsBase: base + 'assets/' } };
  }

  private replay(data: JobData, key: string, digest: string): Replay | null {
    const previous = data.replays[key];
    if (previous && previous.digest !== digest) throw new JobError('JOB_IDEMPOTENCY_CONFLICT');
    return previous ?? null;
  }

  private active(current: StoredJob<JobData>, generation: number): void {
    if (!current.active) throw new JobError('JOB_CLOSED');
    if (current.data.generation !== generation) throw new JobError('JOB_GENERATION_STALE');
    assertJobRoot(current.data.root);
  }

  private event(data: JobData, value: Omit<JobEvent, 'cursor' | 'jobId' | 'generation'>): void {
    const event = { ...value, cursor: randomUUID(), jobId: this.jobId, generation: data.generation } as JobEvent;
    if (Buffer.byteLength(JSON.stringify(event)) > maximumEventBytes) {
      throw new JobError('JOB_BODY_LIMIT', 'Job event exceeds its delivery bound');
    }
    data.events.push(event);
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  async execute(input: JobAgentRequest | JobFetchActRequest, signal: AbortSignal): Promise<unknown> {
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
    if (previous) return previous.value;
    this.active(current, input.expectedGeneration);
    if (signal.aborted) throw new JobError('JOB_REQUEST_INVALID', 'Request cancelled');
    let candidate: JobRetainedSource | null = null;
    let committed = false;
    this.operations++;
    try {
      if (input.verb === 'publish') {
        candidate = await prepareJobSource({ root: current.data.root, stateRoot: this.store.root,
          fingerprint: current.data.fingerprint, request: input,
          readPublished: this.options.readPublished, partsEnumerator: this.options.partsEnumerator, afterSnapshot: this.options.afterSnapshot,
          afterDirectorySync: this.options.afterDirectorySync });
      }
      if (signal.aborted) throw new JobError('JOB_REQUEST_INVALID', 'Request cancelled');
      current = this.current();
      let result: unknown;
      this.store.update(this.jobId, current.revision, fresh => {
        const raced = this.replay(fresh.data, key, digest);
        if (raced) { result = raced.value; return { data: fresh.data }; }
        this.active(fresh, input.expectedGeneration);
        const data = fresh.data;
        data.generation++;
        switch (input.verb) {
          case 'publish': {
            assertJobSourceCurrent(candidate!);
            const publication: JobPublication = {
              publicationId: randomUUID(), instanceKey: candidate!.instanceKey, generation: data.generation,
              source: candidate!.source, label: candidate!.label, previousPublicationId: data.head, visual: candidate!.visual,
            };
            for (const ask of Object.values(data.asks)) {
              if (ask.status === 'pending') data.asks[ask.askId] = { ...ask, status: 'superseded' };
            }
            data.publications[publication.publicationId] = { publication, retained: candidate! };
            data.head = publication.publicationId;
            this.event(data, { type: 'published', publication } as Omit<JobEvent, 'cursor' | 'jobId' | 'generation'>);
            result = publication;
            break;
          }
          case 'ask': {
            if (data.head !== input.publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
            const retained = data.publications[input.publicationId].retained;
            assertJobSourceCurrent(retained);
            const ask: JobPendingAsk = { askId: randomUUID(), publicationId: input.publicationId,
              subject: input.subject, source: bindJobAsk(input.subject, retained), status: 'pending' };
            data.asks[ask.askId] = ask;
            this.event(data, { type: 'pending', ask } as Omit<JobEvent, 'cursor' | 'jobId' | 'generation'>);
            result = ask;
            break;
          }
          case 'close':
            data.fetchCapability = null;
            data.pages = {};
            this.event(data, { type: 'closed', reason: input.reason } as Omit<JobEvent, 'cursor' | 'jobId' | 'generation'>);
            result = { status: 'closed', cursor: data.events.at(-1)!.cursor };
            break;
        }
        data.replays[key] = { digest, value: result };
        return { data, active: input.verb !== 'close' };
      });
      committed = candidate === null || Object.values(this.current().data.publications)
        .some(stored => stored.retained.snapshotRoot === candidate!.snapshotRoot);
      this.notify();
      return result;
    } finally {
      this.operations--;
      if (candidate && !committed) await rm(candidate.snapshotRoot, { recursive: true, force: true });
    }
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

  async commitUIAct(raw: unknown): Promise<JobAct> {
    const input = parseUISubmission(raw), digest = requestDigest(input), key = `ui:${input.pageId}:${input.submissionId}`;
    const current = this.current();
    const previous = this.replay(current.data, key, digest);
    if (previous) return previous.value as JobAct;
    let act: JobAct;
    this.store.update(this.jobId, current.revision, fresh => {
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
      act = finalizeJobAct({ jobId: this.jobId, submission: input, ask, retained, reviewer: fresh.data.reviewer });
      fresh.data.generation++;
      fresh.data.acts[act.actId] = act;
      fresh.data.asks[ask.askId] = { ...ask, status: 'answered' };
      fresh.data.replays[key] = { digest, value: act };
      this.event(fresh.data, { type: 'act', act } as Omit<JobEvent, 'cursor' | 'jobId' | 'generation'>);
      return { data: fresh.data };
    });
    this.notify();
    return act!;
  }

  private events(after: string | null): JobNextValue {
    const current = this.current(), events = current.data.events;
    const index = after === null ? -1 : events.findIndex(event => event.cursor === after);
    if (after !== null && index < 0) throw new JobError('JOB_CURSOR_INVALID');
    const batch: JobEvent[] = [];
    let size = 0;
    for (const event of events.slice(index + 1, index + 65)) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (bytes > maximumEventBytes) throw new JobError('JOB_BODY_LIMIT', 'Stored job event exceeds its delivery bound');
      if (size + bytes > maximumEventBytes) break;
      size += bytes;
      batch.push(event);
    }
    return { events: batch, cursor: batch.at(-1)?.cursor ?? after,
      status: batch.length ? 'events' : current.active ? 'timeout' : 'closed' };
  }

  private async next(after: string | null, waitMs: number, signal: AbortSignal): Promise<JobNextValue> {
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

  async *subscribe(input: { readonly jobId: string; readonly after: string | null; readonly signal: AbortSignal }): AsyncIterable<JobEvent> {
    if (input.jobId !== this.jobId) throw new JobError('JOB_UNKNOWN');
    let after = input.after;
    while (!input.signal.aborted) {
      let value: JobNextValue;
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
    this.notify();
    this.store.close();
  }
}
