import { createHash, timingSafeEqual } from 'node:crypto';
import {
  JOB_API_SCHEMA, JOB_PARTS_ENUMERATOR_RANGE, JOB_ENABLED_ACT_KINDS, JOB_RESERVED_ACT_KINDS,
  type JobAgentRequest, type JobDisplayAcknowledgment, type JobFetchActRequest,
  type JobHostPorts, type JobResult, type JobSelector, type JobSubject,
  jobCaptureBodyLimit, jobRawActMediaType,
} from './job-contract.ts';
import { JobError } from './job-store.ts';
import type { JobSession } from './job-session.ts';

export const jobBodyLimit = 256 * 1024;
export const jobWaitLimitMs = 30_000;
const requestDeadlineMs = 10_000;

export function jobHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Private replay digests only. This is not a mesh payload/source hash format. */
export function requestDigest(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sorted(child)]));
    }
    return item;
  };
  return jobHash(JSON.stringify(sorted(value)));
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

export function assertJobApiSchema(value: unknown): void {
  if (value !== JOB_API_SCHEMA) {
    throw new JobError('JOB_REQUEST_INVALID', 'JOB_API_SCHEMA_MISMATCH');
  }
}

export function parseJobRequest(value: unknown): JobAgentRequest | JobFetchActRequest {
  const item = jobObject(value, [
    'schema', 'jobId', 'requestId', 'verb', 'expectedGeneration', 'idempotencyKey',
    'result', 'freeze', 'publicationId', 'subject', 'after', 'waitMs', 'reason', 'actId',
  ]);
  assertJobApiSchema(item.schema);
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

export async function jobBody(request: Request, maximum = jobBodyLimit): Promise<unknown> {
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
    if (size > jobBodyLimit && (value?.kind !== 'review-verdict' || value?.value?.stage !== 'rig-review' || !value.capture)) {
      throw new JobError('JOB_BODY_LIMIT');
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
      let input: JobAgentRequest | JobFetchActRequest | null = null;
      try {
        gate(request, base + '/api', false);
        input = parseJobRequest(await jobBody(request));
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
        return Response.json({ schema: JOB_API_SCHEMA, verb: input.verb, jobId: input.jobId, requestId: input.requestId,
          generation: session.status().generation, ok: true, value }, { headers: responseHeaders });
      } catch (error) {
        const failure = jobFailure(error);
        const status = failure.error.code.includes('CAPABILITY') || failure.error.code === 'JOB_AUTHORITY_REFUSED' ? 403 :
          failure.error.code === 'JOB_BODY_LIMIT' ? 413 : failure.error.code === 'JOB_REQUEST_INVALID' ? 400 : 409;
        return Response.json({ schema: JOB_API_SCHEMA, verb: input?.verb ?? null, jobId: session.jobId,
          requestId: input?.requestId ?? null, generation: session.status().generation, ...failure }, { status, headers: responseHeaders });
      }
    },
    subscribeJob: input => session.subscribe(input),
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
