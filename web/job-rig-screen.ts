import {formFor, jobCheckpointContext, jobPublicationRoutes, prepareJobForms, prepareJobInspection, type JobForm, type JobFormDependencies, type JobPreparedInspection} from './job-session.ts';
import {commentPartsIssues,type PartsIssue} from '../src/parts-comment.ts';
import type {PartsSubjectData} from './parts-viewport-provider.ts';
/** Card I (#709): a rig publication of a live job opens the one review screen (`main.ts`) instead of the job
 * window. The job stays the transport: same asks, act kinds, still, displayed-ack and submission idempotency.
 * Rig verdicts use the act bar; supported approval and interview asks use the shared ask dialog. */
import type {ActV3, DisplayPublicationV3, JobResult, JobUISubmission, PendingAskV3, SourceV3, UISubmissionV3} from '../src/job-contract.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';
import type {ReviewManifest, ReviewedSource} from '../src/manifest.ts';
import {checkpointNoteComments, feedbackItemComments, projectComments} from '../src/stage-comment.ts';
import {copyJobRigViewport, createJobRigSubmission, freezeJobRigCapture, jobRigDrawState, presentJobRigStage, recordJobRigDraw} from './job-rig-capture.ts';
import {setRigHost, type RigHost, type RigHostScreen, type RigHostCommit} from './rig-host.ts';
import type {InstanceAccess} from './instance-access.ts';

/** A model publication of a rig version or a package: not a draft, direction, image set or record. */
export function jobRigScreenSubject(source: SourceV3): boolean {
  if ('record' in source || source.subject === 'image-set') return false;
  if(source.selector?.kind==='draft'&&source.parts)return true;
  return !!source.model && !source.direction && (source.selector === null || source.selector.kind === 'rig');
}
/** The asks the rig screen's act bar answers: the rig verdict and checkpoints the package declares. */
export function jobRigScreenAnswers(ask: Pick<PendingAskV3, 'subject'>, checkpoints: ReadonlySet<string>): boolean {
  const subject = ask.subject;
  return subject.kind === 'review-verdict' ? subject.stage === 'rig-review' :
    subject.kind === 'checkpoint' && checkpoints.has(subject.checkpointId);
}
export function jobRigScreenRoute(display: DisplayPublicationV3, pending: readonly PendingAskV3[],
  checkpoints: ReadonlySet<string>): boolean {
  const id = display.publication.publicationId;
  if('selector' in display.publication.source&&display.publication.source.selector?.kind==='draft'&&display.publication.source.parts)return true;
  return jobRigScreenSubject(display.publication.source) && pending.every(ask => {
    if (ask.publicationId !== id || ask.status !== 'pending') return true;
    if (ask.subject.kind === 'checkpoint') {
      try {
        prepareJobForms(display, [ask], () => jobCheckpointContext(ask, []));
        return true;
      } catch {return false;}
    }
    return jobRigScreenAnswers(ask, checkpoints) || ask.subject.kind === 'signoff' || ask.subject.kind === 'interview-picks';
  });
}

export type JobRigScreenDecision =
  | {readonly ask: PendingAskV3; readonly kind: 'checkpoint'; readonly value: Extract<JobUISubmission, {kind: 'checkpoint'}>['value']}
  | {readonly ask: PendingAskV3; readonly kind: 'review-verdict'; readonly value: {stage: 'rig-review'; verdict: 'approved' | 'changes-requested'; words: string; feedback?: readonly Feedback[]}};
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
      words: session.feedback.length ? projectComments(feedbackItemComments(session.feedback)) : '',
      ...(session.feedback.length ? {feedback: structuredClone(session.feedback)} : {})}});
  }
  return decisions;
}

interface ReviewJson {manifest: ReviewManifest; reviewedSource: ReviewedSource; sourceHash: string}
export interface JobRigScreenPrepared {readonly jobRigScreen: true; readonly display: DisplayPublicationV3; readonly entry: string;
  readonly modals?: {inspection:JobPreparedInspection;forms:Map<string,JobForm>}; readonly review?: ReviewJson; readonly record?: {inspection:JobPreparedInspection;forms:Map<string,JobForm>;picture:JobRigScreenPrepared|null}; readonly parts?:PartsSubjectData; readonly checkpoints: ReadonlySet<string>}
export function isJobRigScreen(value: unknown): value is JobRigScreenPrepared {
  return !!value && typeof value === 'object' && (value as {jobRigScreen?: unknown}).jobRigScreen === true;
}

export function createJobRigScreen(options: {
  host: HTMLElement;
  pageId: string;
  access: {readonly capability: string | null; headers(init?: HeadersInit): Headers};
  window: {state(): {readonly pending: readonly (PendingAskV3 & {readonly act?:ActV3})[]; readonly receipt: {readonly displayedNonce: string} | null;
    readonly generation: number; readonly preparing: boolean; readonly closed: boolean}; submit(input: UISubmissionV3): Promise<JobResult<ActV3>>};
  routes(display: DisplayPublicationV3): {entry: string; api(path: string): string};
  readPublication?(publicationId:string,signal:AbortSignal):Promise<JobResult<DisplayPublicationV3>>;
  formDependencies?:JobFormDependencies;
  refusal(error: unknown, fallback?: string): string;
  translate(key: string): string;
  /** Imports the rig composition once the host is set. */
  load(): Promise<unknown>;
}) {
  let mounted: JobRigScreenPrepared | null = null, screen: RigHostScreen | null = null, drawGeneration = 0;
  const attempts = new Map<string, {key: string; submissionId: string; rig: ReturnType<typeof createJobRigSubmission>; commit: Omit<RigHostCommit, 'at'>}>();
  async function prepare(display: DisplayPublicationV3, signal: AbortSignal, backdropOnly=false): Promise<JobRigScreenPrepared | null> {
    if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
    const source = display.publication.source;
    if ('record' in source) {
      if (!options.formDependencies) throw new Error('JOB_PANEL_UNAVAILABLE');
      const inspection = await prepareJobInspection(display, signal);
      try {
        const forms = prepareJobForms(display, options.window.state().pending, ask => formFor(ask, inspection, options.formDependencies!));
        let previous = display.publication.previousPublicationId, picture:JobRigScreenPrepared|null = null;
        const jobId=jobPublicationRoutes(display,location.origin).jobId;
        const seen = new Set([display.publication.publicationId]);
        let generation = display.publication.generation;
        while (previous) {
          if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
          if (seen.has(previous) || !options.readPublication) throw new Error('JOB_DISPLAY_MISMATCH');
          seen.add(previous);
          const result = await options.readPublication(previous, signal);
          if (!result.ok) throw new Error(result.error.code);
          if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
          const candidate = result.value;
          if(jobPublicationRoutes(candidate,location.origin).jobId!==jobId)throw new Error('JOB_DISPLAY_MISMATCH');
          if (candidate.publication.publicationId !== previous || candidate.publication.generation >= generation) throw new Error('JOB_DISPLAY_MISMATCH');
          generation = candidate.publication.generation;
          if (jobRigScreenSubject(candidate.publication.source)) {picture = await prepare(candidate, signal, true);break;}
          previous = candidate.publication.previousPublicationId;
        }
        if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
        return {jobRigScreen:true,display,entry:options.routes(display).entry,checkpoints:new Set(),record:{inspection,forms,picture}};
      } catch(error) {inspection.dispose();throw error;}
    }
    if (!jobRigScreenSubject(source) || source.subject === 'image-set') return null;
    const routes = options.routes(display);
    const response = await fetch(routes.api('review'), {signal});
    if (!response.ok) throw new Error('JOB_VISUAL_UNAVAILABLE');
    const review = await response.json() as ReviewJson;
    if (!review.manifest || !review.reviewedSource || review.sourceHash !== source.sourceHash ||
        review.manifest.id !== source.package.id || review.manifest.revision !== source.package.revision ||
        (review.reviewedSource.rig?.sha256 ?? null) !== (source.model?.sha256 ?? null)) throw new Error('JOB_DISPLAY_MISMATCH');
    const checkpoints = new Set(review.manifest.checkpoints.map(item => item.id));
    if (!backdropOnly && !jobRigScreenRoute(display, options.window.state().pending, checkpoints)) return null;
    let parts:PartsSubjectData|undefined;
    if(source.selector?.kind==='draft'&&source.parts){
      const response=await fetch(routes.api('stage-parts'),{signal});if(!response.ok)throw new Error('JOB_VISUAL_UNAVAILABLE');
      parts=await response.json() as PartsSubjectData;
      if(parts.sourceHash!==source.sourceHash||parts.mode!=='parts')throw new Error('JOB_DISPLAY_MISMATCH');
    }
    let modals:JobRigScreenPrepared['modals'];
    const asks=options.window.state().pending.filter(ask=>ask.publicationId===display.publication.publicationId&&ask.subject.kind!=='parts-verdict'&&!(ask.subject.kind==='review-verdict'&&ask.subject.stage==='rig-review'));
    if(!backdropOnly&&options.formDependencies){
      const inspection=await prepareJobInspection(display,signal,true);
      try{modals={inspection,forms:prepareJobForms(display,asks,ask=>formFor(ask,inspection,options.formDependencies!))};}
      catch(error){inspection.dispose();throw error;}
    }
    return {jobRigScreen: true, display, entry: routes.entry, review, checkpoints,...parts?{parts}:{},...modals?{modals}:{}};
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
  async function submit(session: ReviewSession, committed: (commit: RigHostCommit) => void | Promise<void>): Promise<string> {
    const prepared = mounted, state = options.window.state();
    if (!prepared || !state.receipt || state.preparing) throw new Error('JOB_ACT_SOURCE_STALE');
    if (state.closed) throw new Error('JOB_CLOSED');
    if (!options.access.capability) throw new Error('JOB_CAPABILITY_REQUIRED');
    const decisions = jobRigScreenDecisions(session, state.pending.filter(ask=>!prepared.modals?.forms.has(ask.askId)), prepared.display.publication.publicationId);
    if (!decisions.length) throw new Error('JOB_ACT_NOTHING_TO_SUBMIT');
    for (const decision of decisions) {
      const key = JSON.stringify(decision.value);
      let attempt = attempts.get(decision.ask.askId);
      if (!attempt || attempt.key !== key) attempts.set(decision.ask.askId, attempt = {key, submissionId: crypto.randomUUID(), rig: createJobRigSubmission(),
        commit: decision.kind === 'checkpoint' ? {checkpoints: {[decision.value.checkpointId]: structuredClone(session.checkpoints[decision.value.checkpointId]!)}} :
          {review: {status: decision.value.verdict, feedback: structuredClone(session.feedback)}}});
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
      await committed({...current.commit, at: result.value.at});
    }
    return options.translate('job.saved');
  }
  const partsAttempts=new Map<string,{key:string;submissionId:string}>();
  /** One parts verdict act. A pending signoff remains independent and is never synthesized here. */
  async function submitParts(issues:readonly PartsIssue[]):Promise<string>{
    const prepared=mounted,state=options.window.state();
    if(!prepared?.parts||!state.receipt||state.preparing)throw new Error('JOB_ACT_SOURCE_STALE');
    if(state.closed)throw new Error('JOB_CLOSED');
    const ask=state.pending.find(ask=>ask.publicationId===prepared.display.publication.publicationId&&ask.status==='pending'&&ask.subject.kind==='parts-verdict');
    if(!ask)throw new Error('JOB_ACT_NOTHING_TO_SUBMIT');
    const value={verdict:issues.length?'changes-requested' as const:'approved' as const,issues:structuredClone(issues),words:''},key=JSON.stringify(value);
    let attempt=partsAttempts.get(ask.askId);if(!attempt||attempt.key!==key){attempt={key,submissionId:crypto.randomUUID()};partsAttempts.set(ask.askId,attempt);}
    const result=await options.window.submit({kind:'parts-verdict',publicationId:ask.publicationId,askId:ask.askId,pageId:options.pageId,displayedNonce:state.receipt.displayedNonce,expectedGeneration:state.generation,submissionId:attempt.submissionId,value});
    if(!result.ok)throw new Error(result.error.code);
    partsAttempts.delete(ask.askId);return options.translate('job.saved');
  }
  const pendingSubjects=()=>options.window.state().pending.filter(ask=>ask.publicationId===mounted?.display.publication.publicationId&&ask.status==='pending').map(ask=>ask.subject);
  function host(prepared: JobRigScreenPrepared, ready: {resolve(): void; reject(error: unknown): void}): RigHost {
    const base = new URL(prepared.entry).pathname;
    const access: InstanceAccess = {base, key: prepared.display.publication.instanceKey, capability: options.access.capability,
      route: path => {if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Instance route must be app-absolute'); return base + path.slice(1);},
      headers: init => options.access.headers(init)};
    const review = prepared.review;
    if(prepared.record){
      const record=prepared.record,backdrop=record.picture?host(record.picture,ready):null;
      return {...(backdrop?.subject?{subject:backdrop.subject}:{}),access:{...(backdrop?.access??access),capability:null,
        headers:init=>{const headers=options.access.headers(init);headers.delete('X-Review-Capability');return headers;}},
        ownerActAccess:{capability:options.access.capability},
        record:{label:prepared.display.publication.label,sourceHash:prepared.display.publication.source.sourceHash,hasPicture:!!record.picture},pendingSubjects,
        read:(path,method)=>method==='GET'&&backdrop?backdrop.read(path,method):Promise.reject(new Error('JOB_REVIEW_READ_ONLY')),
        submit:async()=>{throw new Error('JOB_REVIEW_READ_ONLY');},
        submitParts:async()=>{throw new Error('JOB_REVIEW_READ_ONLY');},
        attach:value=>{screen=value;screen.pendingSubjects?.(pendingSubjects());refreshRecordForms();},
        displayed:()=>ready.resolve(),failed:error=>ready.reject(error)};
    }
    if(!review)throw new Error('JOB_DISPLAY_MISMATCH');
    return {access,pendingSubjects,...prepared.parts?{subject:'parts' as const,submitParts}: {},
      read(path, method) {
        if (method !== 'GET') return prepared.parts?undefined:Promise.reject(new Error('JOB_REVIEW_READ_ONLY'));
        if(prepared.parts){
          if(path==='/api/review')return Promise.resolve({subject:'parts',parts:structuredClone(prepared.parts)});
          if(path==='/api/access')return Promise.resolve({capabilityRequired:true,control:false});
          if(path==='/api/session'){const act=options.window.state().pending.filter(ask=>ask.publicationId===prepared.display.publication.publicationId&&ask.subject.kind==='parts-verdict').at(-1)?.act;return Promise.resolve({subject:'parts',issues:act?.kind==='parts-verdict'&&act.schema==='rig-review/act@6'?commentPartsIssues(act.value.comments):act?.kind==='parts-verdict'&&act.schema==='rig-review/act@5'?act.value.issues:[]});}
          return undefined;
        }
        if (path === '/api/review') return Promise.resolve(structuredClone(review));
        if (path === '/api/access') return Promise.resolve({capabilityRequired: true, control: false});
        if (path === '/api/session') return Promise.resolve({schema: 'rig-review-session/1', id: review.manifest.id, revision: review.manifest.revision,
          sourceHash: review.sourceHash, reviewedSource: structuredClone(review.reviewedSource), status: 'pending', checkpoints: {}, feedback: [],
          feedbackWarnings: [], updatedAt: null} satisfies ReviewSession);
        return Promise.reject(new Error('JOB_REVIEW_READ_ONLY'));
      },
      submit: (session, committed) => submit(session, committed).catch(error => {throw new Error(options.refusal(error, 'JOB_ACT_INVALID'));}),
      attach: value => {screen = value;screen.pendingSubjects?.(pendingSubjects());refreshRecordForms();},
      displayed: () => ready.resolve(),
      failed: error => ready.reject(error)};
  }
  /** Pending and completed forms keep the same source-bound builder and receipt gates. */
  function refreshRecordForms():void {
    const record=mounted?.record??mounted?.modals,deps=options.formDependencies;if(!record||!deps)return;
    const state=options.window.state(),display=record.inspection.display;
    const next=prepareJobForms(display,state.pending.filter(ask=>ask.subject.kind!=='parts-verdict'&&!(ask.subject.kind==='review-verdict'&&ask.subject.stage==='rig-review')),ask=>record.forms.get(ask.askId)??formFor(ask,record.inspection,deps));
    for(const [id,entry]of next)record.forms.set(id,entry);
    for(const [id,entry]of record.forms){const ask=state.pending.find(ask=>ask.askId===id);entry.fieldset.disabled=entry.submitting||ask?.status!=='pending'||state.preparing||state.closed||!state.receipt||!options.access.capability;}
    screen?.recordForms?.([...record.forms.values()].map(entry=>entry.form));
  }
  return {
    prepare,
    mounted: () => mounted,
    report:(error:unknown,fallback?:string)=>screen?.message(options.refusal(error,fallback),true),
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
      if(mounted.record){refreshRecordForms();if(state.closed)screen?.message(options.translate('job.closed'),true);return;}
      if (!jobRigScreenRoute(mounted.display, state.pending, mounted.checkpoints)) {location.reload(); return;}
      screen?.pendingSubjects?.(pendingSubjects());
      refreshRecordForms();
      if (state.closed) screen?.message(options.translate('job.closed'), true);
    },
  };
}
