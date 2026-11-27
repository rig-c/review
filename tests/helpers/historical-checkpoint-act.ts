import { parseUISubmission } from '../../src/job-act.ts';
import { isRecordSource, parseCommentsAct, parseRecordAct, parseRecordSource, requestDigest } from '../../src/job-api.ts';
import { JOB_COMMENTS_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, type JobCommentsAct, type JobPendingAsk, type PendingAskV3, type RecordAct } from '../../src/job-contract.ts';
import { checkpointNoteComments } from '../../src/feedback-export.ts';
import type { JobSession } from '../../src/job-session.ts';

export type HistoricalPackageCheckpointAct = Extract<JobCommentsAct, { kind: 'checkpoint' }>;
export type HistoricalRecordCheckpointAct = Extract<RecordAct, { kind: 'checkpoint' }>;

/** #1229: Builds a pre-refusal checkpoint ask and finalized act (`act@6` on packages, `act@4` on records) in the
 * exact byte order emitted by Review 4.21.0 so golden and replay compatibility checks verify unchanged readback. */
export function buildHistoricalCheckpointAct(input: {
  readonly jobId: string;
  readonly publicationId: string;
  readonly retained: { readonly source: unknown };
  readonly reviewer: { readonly id: string; readonly role: 'owner' | 'delegate' };
  readonly checkpointId: string;
  readonly planStepId?: string;
  readonly value: { readonly checkpointId: string; readonly outcome: 'pass' | 'fail'; readonly words: string };
  readonly actId?: string;
  readonly askId?: string;
  readonly at?: string;
}): { readonly ask: JobPendingAsk | PendingAskV3; readonly act: HistoricalPackageCheckpointAct | HistoricalRecordCheckpointAct } {
  const record = isRecordSource(input.retained.source);
  const subject = record
    ? { kind: 'checkpoint' as const, checkpointId: input.checkpointId }
    : { kind: 'checkpoint' as const, checkpointId: input.checkpointId, ...(input.planStepId !== undefined ? { planStepId: input.planStepId } : {}) };
  const source = record ? parseRecordSource(input.retained.source) : structuredClone(input.retained.source);
  const ask = {
    askId: input.askId ?? crypto.randomUUID(),
    publicationId: input.publicationId,
    subject,
    status: 'pending' as const,
    source,
  } as JobPendingAsk | PendingAskV3;
  const authority = { actor: 'human' as const, channel: 'review-ui' as const, reviewer: structuredClone(input.reviewer) };
  const actId = input.actId ?? crypto.randomUUID();
  const at = input.at ?? new Date().toISOString();
  const planStepId = input.planStepId ?? input.checkpointId;
  if (record) {
    const { directionReview: _directionReview, ...actSource } = ask.source as Extract<typeof ask.source, { record: unknown }>;
    const act = parseRecordAct({
      schema: JOB_RECORD_ACT_SCHEMA,
      actId,
      jobId: input.jobId,
      askId: ask.askId,
      publicationId: input.publicationId,
      kind: 'checkpoint',
      authority,
      at,
      source: actSource,
      value: {
        checkpointId: input.checkpointId,
        planStepId: input.checkpointId,
        outcome: input.value.outcome,
        words: input.value.words,
      },
    }) as HistoricalRecordCheckpointAct;
    return { ask, act };
  }
  const pkgSource = ask.source as Extract<typeof ask.source, { package: unknown }>;
  const note = input.value.words;
  const act: HistoricalPackageCheckpointAct = {
    schema: JOB_COMMENTS_ACT_SCHEMA,
    actId,
    jobId: input.jobId,
    askId: ask.askId,
    publicationId: input.publicationId,
    authority,
    at,
    kind: 'checkpoint' as const,
    source: { ...pkgSource, plan: pkgSource.plan! },
    value: {
      checkpointId: input.checkpointId,
      planStepId,
      outcome: input.value.outcome,
      comments: note.trim() ? checkpointNoteComments({ checkpointId: input.checkpointId, planStepId, note }) : [],
    },
  };
  parseCommentsAct(act);
  return { ask, act };
}

/** #1229: Review no longer asks or writes `checkpoint`. A job state written before the refusal can still hold an
 * answered checkpoint ask, its finalized act (`act@6` on packages, `act@4` on records) and the page submission's replay
 * row. This stores those three in the removed writers' exact key order so tests read, export and replay a historical
 * checkpoint act through the real host. */
export function seedHistoricalCheckpointAct(session: JobSession, input: {
  readonly publicationId: string;
  readonly pageId: string;
  readonly displayedNonce: string;
  readonly expectedGeneration: number;
  readonly submissionId: string;
  readonly checkpointId: string;
  readonly planStepId?: string;
  readonly value: { readonly checkpointId: string; readonly outcome: 'pass' | 'fail'; readonly words: string };
  readonly actId?: string;
  readonly askId?: string;
  readonly at?: string;
}): HistoricalPackageCheckpointAct | HistoricalRecordCheckpointAct {
  const internal = session as unknown as {
    store: { update(jobId: string, revision: null, operation: (current: { data: any }) => { data: any }): void };
    event(data: unknown, value: unknown): void; notify(): void;
  };
  let act!: HistoricalPackageCheckpointAct | HistoricalRecordCheckpointAct;
  internal.store.update(session.jobId, null, current => {
    const data = current.data, retained = data.publications[input.publicationId].retained;
    const built = buildHistoricalCheckpointAct({
      jobId: session.jobId,
      publicationId: input.publicationId,
      retained,
      reviewer: data.reviewer,
      checkpointId: input.checkpointId,
      planStepId: input.planStepId,
      value: input.value,
      actId: input.actId,
      askId: input.askId,
      at: input.at,
    });
    const ask = built.ask;
    act = built.act;
    const submission = parseUISubmission({
      publicationId: input.publicationId,
      askId: ask.askId,
      pageId: input.pageId,
      displayedNonce: input.displayedNonce,
      expectedGeneration: input.expectedGeneration,
      submissionId: input.submissionId,
      kind: 'checkpoint',
      value: input.value,
    }, session.publicationMode);
    data.generation++;
    data.asks[ask.askId] = { ...ask, status: 'answered' };
    internal.event(data, { type: 'pending', ask });
    data.acts[act.actId] = act;
    data.replays[`ui:${input.pageId}:${input.submissionId}`] = { digest: requestDigest(submission), value: act };
    internal.event(data, { type: 'act', act });
    return { data };
  });
  internal.notify();
  return act;
}

/** #1229: a pending checkpoint ask stored by Review 4.21.0 or earlier, bound as the removed binder did.
 * A fresh submission against it refuses `JOB_ACT_KIND_DISABLED`, and the pending event remains readable. */
export function seedHistoricalCheckpointAsk(
  session: JobSession,
  publicationId: string,
  subject: { readonly kind: 'checkpoint'; readonly checkpointId: string; readonly planStepId?: string },
): PendingAskV3 | JobPendingAsk {
  const internal = session as unknown as {
    store: { update(jobId: string, revision: null, operation: (current: { data: any }) => { data: any }): void };
    event(data: unknown, value: unknown): void; notify(): void;
  };
  let ask!: PendingAskV3 | JobPendingAsk;
  internal.store.update(session.jobId, null, current => {
    const data = current.data, retained = data.publications[publicationId].retained;
    const record = isRecordSource(retained.source);
    data.generation++;
    ask = {
      askId: crypto.randomUUID(),
      publicationId,
      status: 'pending',
      subject: record
        ? { kind: 'checkpoint', checkpointId: subject.checkpointId }
        : { kind: 'checkpoint', checkpointId: subject.checkpointId, ...(subject.planStepId !== undefined ? { planStepId: subject.planStepId } : {}) },
      source: record ? parseRecordSource(retained.source) : structuredClone(retained.source),
    } as PendingAskV3 | JobPendingAsk;
    data.asks[ask.askId] = ask;
    internal.event(data, { type: 'pending', ask });
    return { data };
  });
  internal.notify();
  return ask;
}
