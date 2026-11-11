/** Card I (#709): a rig publication of a live job opens the one review screen (`main.ts`) instead of the job
 * window. The job stays the transport: same asks, act kinds, still, displayed-ack and submission idempotency.
 * Only review-verdict (rig-review) and checkpoint asks are answered here; a publication that also waits on
 * any other ask keeps the job window, and a later such ask reloads the page into it. */
import type {ActV3, DisplayPublicationV3, JobResult, JobUISubmission, PendingAskV3, SourceV3, UISubmissionV3} from '../src/job-contract.ts';
import type {ReviewSession} from '../src/session.ts';
import type {ReviewManifest, ReviewedSource} from '../src/manifest.ts';
import {checkpointNoteComments, feedbackItemComments, projectComments} from '../src/stage-comment.ts';
import {copyJobRigViewport, createJobRigSubmission, freezeJobRigCapture, jobRigDrawState, presentJobRigStage, recordJobRigDraw} from './job-rig-capture.ts';
import {setRigHost, type RigHost, type RigHostScreen} from './rig-host.ts';
import type {InstanceAccess} from './instance-access.ts';

/** A model publication of a rig version or a package: not a draft, direction, image set or record. */
export function jobRigScreenSubject(source: SourceV3): boolean {
  if ('record' in source || source.subject === 'image-set') return false;
  return !!source.model && !source.direction && (source.selector === null || source.selector.kind === 'rig');
}
/** The asks the rig screen's act bar answers: the rig verdict and checkpoints the package declares. */
export function jobRigScreenAnswers(ask: Pick<PendingAskV3, 'subject'>, checkpoints: ReadonlySet<string>): boolean {
  const subject = ask.subject;
  return subject.kind === 'review-verdict' ? subject.stage === 'rig-review' :
    subject.kind === 'checkpoint' && checkpoints.has(subject.checkpointId);
}
export function jobRigScreenRoute(display: DisplayPublicationV3, pending: readonly Pick<PendingAskV3, 'publicationId' | 'status' | 'subject'>[],
  checkpoints: ReadonlySet<string>): boolean {
  const id = display.publication.publicationId;
  return jobRigScreenSubject(display.publication.source) &&
    pending.every(ask => ask.publicationId !== id || ask.status !== 'pending' || jobRigScreenAnswers(ask, checkpoints));
}

export type JobRigScreenDecision =
  | {readonly ask: PendingAskV3; readonly kind: 'checkpoint'; readonly value: Extract<JobUISubmission, {kind: 'checkpoint'}>['value']}
  | {readonly ask: PendingAskV3; readonly kind: 'review-verdict'; readonly value: {stage: 'rig-review'; verdict: 'approved' | 'changes-requested'; words: string}};
/** The act bar's decisions as the pending asks' values. `words` is the comments' projection (act@6's), or empty;
 * a decision still pending is not sent, so a pending ask is never answered with "pending". Checkpoints go first. */
export function jobRigScreenDecisions(session: Pick<ReviewSession, 'status' | 'checkpoints' | 'feedback'>,
  pending: readonly PendingAskV3[], publicationId: string): JobRigScreenDecision[] {
  const open = pending.filter(ask => ask.publicationId === publicationId && ask.status === 'pending');
  const decisions: JobRigScreenDecision[] = [];
  for (const ask of open) {
    if (ask.subject.kind !== 'checkpoint') continue;
    const {checkpointId} = ask.subject, entry = session.checkpoints[checkpointId];
    if (!entry || entry.outcome === 'pending') continue;
    const planStepId = ('planStepId' in ask.subject ? ask.subject.planStepId : undefined) ?? checkpointId;
    decisions.push({ask, kind: 'checkpoint', value: {checkpointId, outcome: entry.outcome,
      words: entry.note.trim() ? projectComments(checkpointNoteComments({checkpointId, planStepId, note: entry.note})) : ''}});
  }
  const verdict = open.find(ask => ask.subject.kind === 'review-verdict' && ask.subject.stage === 'rig-review');
  if (verdict && session.status !== 'pending') {
    decisions.push({ask: verdict, kind: 'review-verdict', value: {stage: 'rig-review', verdict: session.status,
      words: session.feedback.length ? projectComments(feedbackItemComments(session.feedback)) : ''}});
  }
  return decisions;
}

interface ReviewJson {manifest: ReviewManifest; reviewedSource: ReviewedSource; sourceHash: string}
export interface JobRigScreenPrepared {readonly jobRigScreen: true; readonly display: DisplayPublicationV3; readonly entry: string;
  readonly review: ReviewJson; readonly checkpoints: ReadonlySet<string>}
export function isJobRigScreen(value: unknown): value is JobRigScreenPrepared {
  return !!value && typeof value === 'object' && (value as {jobRigScreen?: unknown}).jobRigScreen === true;
}

export function createJobRigScreen(options: {
  host: HTMLElement;
  pageId: string;
  access: {readonly capability: string | null; headers(init?: HeadersInit): Headers};
  window: {state(): {readonly pending: readonly PendingAskV3[]; readonly receipt: {readonly displayedNonce: string} | null;
    readonly generation: number; readonly preparing: boolean; readonly closed: boolean}; submit(input: UISubmissionV3): Promise<JobResult<ActV3>>};
  routes(display: DisplayPublicationV3): {entry: string; api(path: string): string};
  refusal(error: unknown, fallback?: string): string;
  translate(key: string): string;
  /** Imports the rig composition once the host is set. */
  load(): Promise<unknown>;
}) {
  let mounted: JobRigScreenPrepared | null = null, screen: RigHostScreen | null = null, drawGeneration = 0;
  const attempts = new Map<string, {key: string; submissionId: string; rig: ReturnType<typeof createJobRigSubmission>}>();
  async function prepare(display: DisplayPublicationV3, signal: AbortSignal): Promise<JobRigScreenPrepared | null> {
    const source = display.publication.source;
    if (!jobRigScreenSubject(source) || 'record' in source || source.subject === 'image-set') return null;
    const routes = options.routes(display);
    const response = await fetch(routes.api('review'), {signal});
    if (!response.ok) throw new Error('JOB_VISUAL_UNAVAILABLE');
    const review = await response.json() as ReviewJson;
    if (!review.manifest || !review.reviewedSource || review.sourceHash !== source.sourceHash ||
        review.manifest.id !== source.package.id || review.manifest.revision !== source.package.revision ||
        (review.reviewedSource.rig?.sha256 ?? null) !== (source.model?.sha256 ?? null)) throw new Error('JOB_DISPLAY_MISMATCH');
    const checkpoints = new Set(review.manifest.checkpoints.map(item => item.id));
    if (!jobRigScreenRoute(display, options.window.state().pending, checkpoints)) return null;
    return {jobRigScreen: true, display, entry: routes.entry, review, checkpoints};
  }
  function still(ask: PendingAskV3, prepared: JobRigScreenPrepared) {
    screen?.redraw();
    const stage = screen?.stage();
    if (!stage) throw new Error('JOB_STILL_CAPTURE_FAILED');
    const publication = prepared.display.publication;
    const source = {pageId: options.pageId, publicationId: publication.publicationId, instanceKey: publication.instanceKey,
      sourceHash: publication.source.sourceHash};
    // The canonical pixels are on the pane only while the still is bound and copied, then the screen's own view returns.
    const presentation = presentJobRigStage(stage);
    try {
      presentation.canvas.style.position = 'absolute';
      presentation.canvas.style.pointerEvents = 'none';
      const bound = {...stage, source, presentation};
      const draw = recordJobRigDraw(jobRigDrawState(bound), ++drawGeneration);
      return freezeJobRigCapture(draw, jobRigDrawState(bound), ask.askId, () => copyJobRigViewport(presentation));
    } finally {presentation.canvas.remove();}
  }
  async function submit(session: ReviewSession): Promise<string> {
    const prepared = mounted, state = options.window.state();
    if (!prepared || !state.receipt || state.preparing) throw new Error('JOB_ACT_SOURCE_STALE');
    if (state.closed) throw new Error('JOB_CLOSED');
    if (!options.access.capability) throw new Error('JOB_CAPABILITY_REQUIRED');
    const decisions = jobRigScreenDecisions(session, state.pending, prepared.display.publication.publicationId);
    if (!decisions.length) throw new Error('JOB_ACT_NOTHING_TO_SUBMIT');
    for (const decision of decisions) {
      const key = JSON.stringify(decision.value);
      let attempt = attempts.get(decision.ask.askId);
      if (!attempt || attempt.key !== key) attempts.set(decision.ask.askId, attempt = {key, submissionId: crypto.randomUUID(), rig: createJobRigSubmission()});
      const latest = options.window.state();
      if (!latest.receipt) throw new Error('JOB_ACT_SOURCE_STALE');
      const input = {kind: decision.kind, publicationId: decision.ask.publicationId, askId: decision.ask.askId, pageId: options.pageId,
        displayedNonce: latest.receipt.displayedNonce, expectedGeneration: latest.generation, submissionId: attempt.submissionId,
        value: decision.value} as JobUISubmission;
      const ask = decision.ask, current = attempt;
      const frozen = decision.kind === 'review-verdict' ? await current.rig.prepare(input, () => still(ask, prepared)) : input;
      const result = await options.window.submit(frozen);
      if (!result.ok) throw new Error(result.error.code);
      attempts.delete(ask.askId);
    }
    return options.translate('job.saved');
  }
  function host(prepared: JobRigScreenPrepared, ready: {resolve(): void; reject(error: unknown): void}): RigHost {
    const base = new URL(prepared.entry).pathname;
    const access: InstanceAccess = {base, key: prepared.display.publication.instanceKey, capability: options.access.capability,
      route: path => {if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Instance route must be app-absolute'); return base + path.slice(1);},
      headers: init => options.access.headers(init)};
    const review = prepared.review;
    return {access,
      read(path, method) {
        if (method !== 'GET') return Promise.reject(new Error('JOB_REVIEW_READ_ONLY'));
        if (path === '/api/review') return Promise.resolve(structuredClone(review));
        if (path === '/api/access') return Promise.resolve({capabilityRequired: true, control: false});
        if (path === '/api/session') return Promise.resolve({schema: 'rig-review-session/1', id: review.manifest.id, revision: review.manifest.revision,
          sourceHash: review.sourceHash, reviewedSource: structuredClone(review.reviewedSource), status: 'pending', checkpoints: {}, feedback: [],
          feedbackWarnings: [], updatedAt: null} satisfies ReviewSession);
        return Promise.reject(new Error('JOB_REVIEW_READ_ONLY'));
      },
      submit: session => submit(session).catch(error => {throw new Error(options.refusal(error, 'JOB_ACT_INVALID'));}),
      attach: value => {screen = value;},
      displayed: () => ready.resolve(),
      failed: error => ready.reject(error)};
  }
  return {
    prepare,
    mounted: () => mounted,
    commit(prepared: JobRigScreenPrepared) {mounted = prepared; return {rollback() {}, finalize() {}};},
    /** The rig composition draws first; the job acknowledges the display after. */
    async painted(prepared: JobRigScreenPrepared, signal: AbortSignal): Promise<void> {
      let ready!: {resolve(): void; reject(error: unknown): void};
      const shown = new Promise<void>((resolve, reject) => {ready = {resolve, reject};});
      setRigHost(host(prepared, ready));
      const app = document.createElement('div');
      app.id = 'app';
      options.host.classList.remove('job-window');
      options.host.replaceChildren(app);
      await options.load();
      await shown;
      if (signal.aborted) throw new Error('JOB_PRELOAD_CANCELLED');
    },
    /** A newly pending ask the screen cannot answer, or a later publication, reloads into the job window's route. */
    changed(state: {readonly pending: readonly PendingAskV3[]; readonly closed: boolean}): void {
      if (!mounted) return;
      if (!jobRigScreenRoute(mounted.display, state.pending, mounted.checkpoints)) {location.reload(); return;}
      if (state.closed) screen?.message(options.translate('job.closed'), true);
    },
  };
}
