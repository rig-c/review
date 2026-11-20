import {randomUUID} from 'node:crypto';
import {type JobCursor, type JobErrorCode, type JobNextValue, type JobNextValueV3} from './job-contract.ts';
import {jobActWaitLimitMs, waitForActBatch} from './job-cli.ts';
import type {JobOwnerHost} from './job-front.ts';
import {JobError} from './job-store.ts';

export interface JobActWaitOptions {
  /** Start after this accepted cursor; `null` reads from the first retained event. */
  readonly after: JobCursor | null;
  /** Whole-wait bound in milliseconds, an integer from 1 to 600000 like `job next --until act --wait-ms`. */
  readonly deadlineMs: number;
  /** Caller cancellation. An abort rejects with the signal's reason and clears every timer. */
  readonly signal?: AbortSignal;
}

/**
 * The batch carrying the finalized act or the closure, and its cursor to resume from. A
 * package-only host answers `rig-review/job-api@2` batches (`JobNextValue`, package acts);
 * a record-and-package host answers `@3` batches (`JobNextValueV3`), whose act rows may be
 * `rig-review/act@4` record acts (`JobRecordAct`) as well as package acts.
 */
type JobActWaitBatch = JobNextValue | JobNextValueV3;
export type JobActWaitOutcome =
  | {readonly kind: 'act'; readonly next: JobActWaitBatch; readonly cursor: JobCursor | null}
  | {readonly kind: 'closed'; readonly next: JobActWaitBatch; readonly cursor: JobCursor | null}
  | {readonly kind: 'timeout'; readonly code: 'JOB_NEXT_TIMEOUT'; readonly next: JobActWaitBatch | null; readonly cursor: JobCursor | null};

/**
 * Wait on a started or strictly attached owner host until a finalized act, a closure or the
 * deadline. It is the `job next --until act` loop over the host's own ports with the host's
 * agent capability; a refused `next` throws its `JobError` code.
 */
export async function waitForJobAct(host: JobOwnerHost, options: JobActWaitOptions): Promise<JobActWaitOutcome> {
  const {after, deadlineMs, signal} = options;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > jobActWaitLimitMs ||
      (after !== null && typeof after !== 'string')) throw new JobError('JOB_REQUEST_INVALID');
  const jobId = host.session.jobId, endpoint = `${host.origin}/jobs/${jobId}/api`;
  const capability = host.session.hostCredentials().agent;
  // The host's own API schema: job-api@3 on a record-and-package host, as Create's agents send.
  const result = await waitForActBatch((request, requestSignal) => host.ports.handleJobApi(new Request(endpoint, {
    method: 'POST', signal: requestSignal,
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability},
    body: JSON.stringify(request),
  })), {schema: host.session.apiSchema, verb: 'next', jobId, requestId: randomUUID(), after, waitMs: 0}, deadlineMs, signal);
  switch (result.kind) {
    case 'act': case 'closed': return {kind: result.kind, next: result.batch, cursor: result.batch.cursor};
    case 'timeout': return {kind: 'timeout', code: 'JOB_NEXT_TIMEOUT', next: result.batch, cursor: result.cursor};
    case 'refused': {
      const error = (result.value as {error?: {code?: unknown; message?: unknown}}).error;
      throw new JobError((typeof error?.code === 'string' ? error.code : 'JOB_REQUEST_INVALID') as JobErrorCode,
        typeof error?.message === 'string' ? error.message : undefined);
    }
  }
}
