import {randomUUID} from 'node:crypto';
import {bindJobAsk} from '../../src/job-act.ts';
import {parseJobSubject, requestDigest} from '../../src/job-api.ts';
import type {JobEventV3, JobPendingAsk, JobSubject} from '../../src/job-contract.ts';
import type {JobSession} from '../../src/job-session.ts';
import {isRetainedRecordSource, type JobRetainedSourceV3} from '../../src/job-source.ts';
import type {JobStore} from '../../src/job-store.ts';
import pendingAsks from '../fixtures/job-verdict-1232/pending-asks.json';

type VerdictSubject = Extract<JobSubject, {kind: 'review-verdict' | 'parts-verdict'}>;
type PendingEvent = Extract<JobEventV3, {type: 'pending'}>;

type JobWithHistoricalVerdict = {
  head: string | null;
  generation: number;
  publications: Record<string, {retained: JobRetainedSourceV3}>;
  asks: Record<string, JobPendingAsk>;
  events: JobEventV3[];
  replays: Record<string, {digest: string; value: unknown}>;
  progress?: unknown;
};

/** Relocate a pending verdict saved by c7a7d3ec into a disposable test job.
 * The retained source and receipt digest must bind to that test's own publication and request.
 */
export function seedHistoricalVerdictAsk(session: JobSession, publicationId: string, subject: VerdictSubject,
  idempotencyKey = 'historical-verdict-' + randomUUID()): JobPendingAsk {
  const name = subject.kind === 'parts-verdict' ? subject.kind : subject.stage;
  const template = pendingAsks[name];
  const {status} = template.ask, {type} = template.event;
  if (status !== 'pending' || type !== 'pending') throw new Error('Expected a pending verdict fixture');
  const recordedSubject = parseJobSubject(template.ask.subject);
  const boundSubject = subject.kind === 'parts-verdict' ? {...recordedSubject, draftId: subject.draftId} : recordedSubject;
  const internal = session as unknown as {store: JobStore<JobWithHistoricalVerdict>; notify(): void};
  let ask!: JobPendingAsk;
  internal.store.update(session.jobId, null, ({data, active}) => {
    if (!active || data.head !== publicationId) throw new Error('Historical verdict setup requires the active head');
    const retained = data.publications[publicationId].retained;
    if (isRetainedRecordSource(retained)) throw new Error('Historical verdict setup requires a package publication');
    const source = bindJobAsk(boundSubject, retained);
    ask = {...template.ask, askId: randomUUID(), publicationId, subject: boundSubject, source, status};
    const expectedGeneration = data.generation++;
    const digest = requestDigest({schema: session.apiSchema, jobId: session.jobId, verb: 'ask',
      expectedGeneration, idempotencyKey, publicationId, subject: boundSubject});
    const event: PendingEvent = {...template.event, type, ask,
      jobId: session.jobId, generation: data.generation, cursor: randomUUID()};
    data.asks[ask.askId] = ask;
    data.events.push(event);
    data.replays['agent:' + idempotencyKey] = {...template.receipt, digest, value: ask};
    delete data.progress;
    return {data};
  });
  internal.notify();
  return ask;
}
