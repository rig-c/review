import { readSync, writeSync } from 'node:fs';
import type { JobAskRequest, JobPublishRequest, JobUISubmission } from '../../src/job-contract.ts';
import { JobSession, type JobSessionOptions } from '../../src/job-session.ts';
import type { JobPublishedContext } from '../../src/job-source.ts';
import { JobError, JobStore } from '../../src/job-store.ts';

export type ReplayRaceInput = {
  options: Pick<JobSessionOptions, 'root' | 'stateDir' | 'fingerprint' | 'reviewer'>;
  context: JobPublishedContext;
  gated: boolean;
} & ({ kind: 'agent'; request: JobPublishRequest | JobAskRequest } | { kind: 'ui'; request: JobUISubmission });

export interface ReplayRaceMessage {
  event: 'ready' | 'enter' | 'result';
  pid: number;
  expectedRevision?: number | null;
  observedRevision?: number;
  replayProvided?: boolean;
  outcome?: { value?: unknown; code?: string };
  updateCalls?: number;
  readPublishedCalls?: number;
  snapshotCalls?: number;
}

if (import.meta.main) {
  const input: ReplayRaceInput = JSON.parse(process.env.REVIEW540_RACE_INPUT!);
  let updateCalls = 0, readPublishedCalls = 0, snapshotCalls = 0;
  const session = new JobSession({
    ...input.options,
    readPublished: async () => { readPublishedCalls++; return structuredClone(input.context); },
    afterSnapshot: () => { snapshotCalls++; },
  });
  const update = JobStore.prototype.update;
  const emit = (message: Omit<ReplayRaceMessage, 'pid'>) => {
    writeSync(1, JSON.stringify({ ...message, pid: process.pid }) + '\n');
  };
  // This process-local wrapper pauses before the real update can begin IMMEDIATE.
  // Agent CAS captures a revision. UI delegates freshness to locked predicates.
  JobStore.prototype.update = function (...args) {
    const [jobId, expectedRevision, , replay] = args;
    updateCalls++;
    if (input.gated) {
      emit({ event: 'ready', expectedRevision, observedRevision: this.get(jobId).revision,
        replayProvided: typeof replay === 'function' });
      const byte = Buffer.alloc(1);
      if (readSync(0, byte, 0, 1, null) !== 1 || byte[0] !== 120) {
        throw new Error('REPLAY_RACE_GATE_CLOSED');
      }
    }
    emit({ event: 'enter', expectedRevision, replayProvided: typeof replay === 'function' });
    return update.apply(this, args);
  };
  try {
    const value = await (input.kind === 'agent'
      ? session.execute(input.request, new AbortController().signal)
      : session.commitUIAct(input.request));
    emit({ event: 'result', outcome: { value }, updateCalls, readPublishedCalls, snapshotCalls });
  } catch (error) {
    if (!(error instanceof JobError)) throw error;
    emit({ event: 'result', outcome: { code: error.code }, updateCalls, readPublishedCalls, snapshotCalls });
  } finally {
    JobStore.prototype.update = update;
    session.dispose();
  }
}
