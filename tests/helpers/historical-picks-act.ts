import { parseUISubmission } from '../../src/job-act.ts';
import { isRecordSource, parseCommentsAct, parseRecordSource, recordActSource, requestDigest } from '../../src/job-api.ts';
import type { JobCommentsAct, PendingAskV3 } from '../../src/job-contract.ts';
import type { JobSession } from '../../src/job-session.ts';

type PicksAct = Extract<JobCommentsAct, { kind: 'interview-picks' }>;

/** #1230: Review no longer asks or writes `interview-picks`. A job state written before the refusal can still hold an
 * answered picks ask, its finalized act@6 and the page submission's replay row. This stores those three exactly as the
 * removed writer committed them, so tests read, export and replay a historical picks act through the real host. */
export function seedHistoricalPicksAct(session: JobSession, input: {
  readonly publicationId: string; readonly pageId: string; readonly displayedNonce: string; readonly expectedGeneration: number;
  readonly submissionId: string;
  readonly value: { readonly questionId: string; readonly selections: readonly unknown[]; readonly note: string; readonly comments?: readonly unknown[] };
  readonly questionId: string; readonly setId: string; readonly optionSetSha256: string;
}): PicksAct {
  const internal = session as unknown as {
    store: { update(jobId: string, revision: null, operation: (current: { data: any }) => { data: any }): void };
    event(data: unknown, value: unknown): void; notify(): void;
  };
  let act!: PicksAct;
  internal.store.update(session.jobId, null, current => {
    const data = current.data, retained = data.publications[input.publicationId].retained;
    const subject = { kind: 'interview-picks' as const, questionId: input.questionId, setId: input.setId };
    const record = isRecordSource(retained.source);
    // The removed binders: a record ask keeps the record source; a package ask adds the displayed set's identity.
    const ask = { askId: crypto.randomUUID(), publicationId: input.publicationId, subject, status: 'pending' as const,
      source: record ? parseRecordSource(retained.source)
        : { ...structuredClone(retained.source), optionSet: { id: input.setId, sha256: input.optionSetSha256 } } };
    const submission = parseUISubmission({ publicationId: input.publicationId, askId: ask.askId, pageId: input.pageId,
      displayedNonce: input.displayedNonce, expectedGeneration: input.expectedGeneration, submissionId: input.submissionId,
      kind: 'interview-picks', value: input.value }, session.publicationMode);
    const authority = { actor: 'human', channel: 'review-ui', reviewer: structuredClone(data.reviewer) };
    const value = { questionId: input.value.questionId, selections: input.value.selections, note: input.value.note,
      comments: input.value.comments ?? [] };
    const ids = { schema: 'rig-review/act@6', actId: crypto.randomUUID(), jobId: session.jobId, askId: ask.askId,
      publicationId: input.publicationId };
    const at = new Date().toISOString();
    // Each removed writer's key order: the record writer puts `kind` before `authority`.
    act = (record
      ? { ...ids, kind: 'interview-picks', authority, at, source: recordActSource(ask.source as never, subject), value }
      : { ...ids, authority, at, kind: 'interview-picks', source: ask.source, value }) as unknown as PicksAct;
    parseCommentsAct(act); // the removed writer's emission check: its bytes, not the decoder's, are stored
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

/** #1230: a pending picks ask stored by Review 4.21.0 or earlier, bound as the removed binder did (a record ask keeps
 * the record source). The page can still show it; a fresh submission against it refuses JOB_ACT_KIND_DISABLED. */
export function seedHistoricalPicksAsks(session: JobSession, publicationId: string,
  subjects: readonly { readonly kind: string; readonly questionId?: string; readonly setId?: string }[]): PendingAskV3[] {
  const internal = session as unknown as {
    store: { update(jobId: string, revision: null, operation: (current: { data: any }) => { data: any }): void };
    event(data: unknown, value: unknown): void; notify(): void;
  };
  const asks: PendingAskV3[] = [];
  internal.store.update(session.jobId, null, current => {
    const data = current.data, retained = data.publications[publicationId].retained;
    data.generation++;
    for (const subject of subjects) {
      if (subject.kind !== 'interview-picks') throw new Error('SYNTHETIC_1230_PICKS_SUBJECT_REQUIRED');
      const ask = { askId: crypto.randomUUID(), publicationId, status: 'pending',
        subject: { kind: 'interview-picks', questionId: subject.questionId!, setId: subject.setId! },
        source: parseRecordSource(retained.source) } as PendingAskV3;
      data.asks[ask.askId] = ask;
      internal.event(data, { type: 'pending', ask });
      asks.push(ask);
    }
    return { data };
  });
  internal.notify();
  return asks;
}
