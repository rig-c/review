import {formFor, jobCheckpointContext, jobPublicationRoutes, prepareJobForms, prepareJobInspection, jobSubmissionRefusal, type JobForm, type JobFormDependencies, type JobPreparedInspection} from './job-session.ts';
import {commentPartsIssues,type PartsIssue} from '../src/parts-comment.ts';
import type {PartsSubjectData} from './parts-viewport-provider.ts';
/** Card I (#709): a rig publication of a live job opens the one review screen (`main.ts`) instead of the job
 * window. The job stays the transport: same asks, act kinds, still, displayed-ack and submission idempotency.
 * Rig verdicts use the act bar; supported approval and interview asks use the shared ask dialog. */
import type {ActV3, DisplayPublicationV3, JobResult, JobUISubmission, PendingAskV3, SourceV3, UISubmissionV3} from '../src/job-contract.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';
import type {ReviewManifest, ReviewedSource} from '../src/manifest.ts';
import {checkpointNoteComments, feedbackItemComments, projectComments} from '../src/stage-comment.ts';
import {createJobRigSubmission, freezeJobRigStage} from './job-rig-capture.ts';
import {setRigHost, rigHost, type RigHost, type RigHostScreen, type RigHostCommit, type RigHostNavigation} from './rig-host.ts';
import type {InstanceAccess} from './instance-access.ts';

/** The shared screen hosts model packages and parts drafts; records have their own shared host seam. */
export function jobRigScreenSubject(source: SourceV3): boolean {
  if ('record' in source) return false;
  if(source.selector?.kind==='draft'&&source.parts)return true;
  return !!source.model && (source.direction ? source.selector?.kind === 'post' : source.selector === null || source.selector.kind === 'rig');
}
/** The asks the rig screen's act bar answers: the rig verdict and checkpoints the package declares. */
export function jobRigScreenAnswers(ask: Pick<PendingAskV3, 'subject'>, checkpoints: ReadonlySet<string>): boolean {
  const subject = ask.subject;
  return subject.kind === 'review-verdict' ? (subject.stage === 'rig-review' || subject.stage === 'direction-review') :
    subject.kind === 'checkpoint' && checkpoints.has(subject.checkpointId);
}
/** One ask-availability check for both the route and its retained modal forms. */
export function jobRigScreenAsk(display:DisplayPublicationV3,ask:PendingAskV3,checkpoints:ReadonlySet<string>):boolean {
  const source=display.publication.source;
  if(ask.subject.kind==='checkpoint'){
    try {prepareJobForms(display,[ask],()=>jobCheckpointContext(ask,[]));return true;}catch{return false;}
  }
  if(ask.subject.kind==='signoff'||ask.subject.kind==='interview-picks')return true;
  if('record' in source)return ask.subject.kind==='reopen';
  return !!source.model&&jobRigScreenAnswers(ask,checkpoints)&&
    (ask.subject.kind!=='review-verdict'||ask.subject.stage===(source.direction?'direction-review':'rig-review'));
}
export function jobRigScreenRoute(display: DisplayPublicationV3, pending: readonly PendingAskV3[],
  checkpoints: ReadonlySet<string>): boolean {
  const source=display.publication.source,id=display.publication.publicationId;
  if('record' in source)return false;
  if(source.selector?.kind==='draft'&&source.parts)return true;
  return (jobRigScreenSubject(source)||!source.model&&!source.parts)&&pending.every(ask=>
    ask.publicationId!==id||ask.status!=='pending'||jobRigScreenAsk(display,ask,checkpoints));
}

/** Refusals describe missing producer inputs without granting a new act authority. */
export function jobRigScreenRefusal(display:DisplayPublicationV3,pending:readonly PendingAskV3[],checkpoints:ReadonlySet<string>,hasPicture=false):string|null {
  const source=display.publication.source;
  if('record' in source)return null;
  {
    if(source.selector?.kind==='post'&&!source.direction)return 'JOB_DIRECTION_MISSING';
    if(source.selector?.kind==='draft'&&!source.parts)return 'JOB_PARTS_MISSING';
    if(!source.model&&!source.parts&&!hasPicture&&!pending.some(ask=>ask.publicationId===display.publication.publicationId&&ask.status==='pending'&&ask.subject.kind!=='review-verdict'&&jobRigScreenAsk(display,ask,checkpoints)))return 'JOB_MODEL_MISSING';
  }
  return jobRigScreenRoute(display,pending,checkpoints)?null:'JOB_ASK_UNSUPPORTED';
}

export type JobRigScreenDecision =
  | {readonly ask: PendingAskV3; readonly kind: 'checkpoint'; readonly value: Extract<JobUISubmission, {kind: 'checkpoint'}>['value']}
  | {readonly ask: PendingAskV3; readonly kind: 'review-verdict'; readonly value: {stage: 'rig-review' | 'direction-review'; verdict: 'approved' | 'changes-requested'; words: string; feedback?: readonly Feedback[]}};
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
  const verdict = open.find(ask => ask.subject.kind === 'review-verdict' && (ask.subject.stage === 'rig-review' || ask.subject.stage === 'direction-review'));
  if (verdict?.subject.kind === 'review-verdict' && verdict.subject.stage !== 'image-review' && session.status !== 'pending') {
    decisions.push({ask: verdict, kind: 'review-verdict', value: {stage: verdict.subject.stage, verdict: session.status,
      words: session.feedback.length ? projectComments(feedbackItemComments(session.feedback)) : '',
      ...(verdict.subject.kind === 'review-verdict' && verdict.subject.stage === 'rig-review' && session.feedback.length ? {feedback: structuredClone(session.feedback)} : {})}});
  }
  return decisions;
}

interface ReviewJson {manifest: ReviewManifest; reviewedSource: ReviewedSource; sourceHash: string}
export interface JobRigScreenPrepared {readonly jobRigScreen: true; readonly display: DisplayPublicationV3; readonly entry: string;
  readonly refusal?:string; readonly modals?: {inspection:JobPreparedInspection;forms:Map<string,JobForm>}; readonly review?: ReviewJson; readonly record?: {inspection:JobPreparedInspection;forms:Map<string,JobForm>;picture:JobRigScreenPrepared|null}; readonly parts?:PartsSubjectData; readonly checkpoints: ReadonlySet<string>}
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
  translate(key: string,values?:readonly (string|number)[]): string;
  /** Imports the rig composition once the host is set. */
  load(): Promise<unknown>;
}) {
  let mounted: JobRigScreenPrepared | null = null, screen: RigHostScreen | null = null, drawGeneration = 0;
  let transition:{rollback():Promise<void>;finalize():void}|null=null;
  const attempts = new Map<string, {key: string; submissionId: string; rig: ReturnType<typeof createJobRigSubmission>; commit: Omit<RigHostCommit, 'at'>}>();
  async function prepare(display: DisplayPublicationV3, signal: AbortSignal, backdropOnly=false): Promise<JobRigScreenPrepared | null> {
    if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
    const source = display.publication.source;
    if ('record' in source) {
      if (!options.formDependencies) throw new Error('JOB_ACT_KIND_DISABLED');
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
        if (!picture && inspection.interview?.questions.some(question => question.hasParts)) {
          const response = await fetch(options.routes(display).api('stage-parts'), {signal});
          if (!response.ok) throw new Error('JOB_VISUAL_UNAVAILABLE');
          const parts = await response.json() as PartsSubjectData;
          if (parts.sourceHash !== source.sourceHash || parts.mode !== 'parts') throw new Error('JOB_DISPLAY_MISMATCH');
          picture = {jobRigScreen:true,display,entry:options.routes(display).entry,checkpoints:new Set(),parts};
        }
        if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
        return {jobRigScreen:true,display,entry:options.routes(display).entry,checkpoints:new Set(),record:{inspection,forms,picture}};
      } catch(error) {inspection.dispose();throw error;}
    }
    if (!jobRigScreenSubject(source)) {
      if(!options.formDependencies)throw new Error('JOB_ACT_KIND_DISABLED');
      const inspection=await prepareJobInspection(display,signal,true);
      try {
        const pending=options.window.state().pending,checkpoints=new Set(inspection.metadata.manifest?.checkpoints.map(item=>item.id)??[]);
        const forms=prepareJobForms(display,pending.filter(ask=>ask.subject.kind!=='review-verdict'&&jobRigScreenAsk(display,ask,checkpoints)),ask=>formFor(ask,inspection,options.formDependencies!));
        const picture:JobRigScreenPrepared|null=!source.model&&inspection.references.length?{jobRigScreen:true,display,entry:options.routes(display).entry,checkpoints,review:inspection.metadata as ReviewJson}:null;
        return {jobRigScreen:true,display,entry:options.routes(display).entry,checkpoints,record:{inspection,forms,picture},refusal:jobRigScreenRefusal(display,pending,checkpoints,!!picture)??undefined};
      }catch(error){inspection.dispose();throw error;}
    }
    const routes = options.routes(display);
    const response = await fetch(routes.api('review'), {signal});
    if (!response.ok) throw new Error('JOB_VISUAL_UNAVAILABLE');
    const review = await response.json() as ReviewJson;
    if (!review.manifest || !review.reviewedSource || review.sourceHash !== source.sourceHash ||
        review.manifest.id !== source.package.id || review.manifest.revision !== source.package.revision ||
        (review.reviewedSource.rig?.sha256 ?? null) !== (source.model?.sha256 ?? null)) throw new Error('JOB_DISPLAY_MISMATCH');
    const checkpoints = new Set(review.manifest.checkpoints.map(item => item.id));
    const refusal=backdropOnly?null:jobRigScreenRefusal(display,options.window.state().pending,checkpoints);
    let parts:PartsSubjectData|undefined;
    if(source.selector?.kind==='draft'&&source.parts){
      const response=await fetch(routes.api('stage-parts'),{signal});if(!response.ok)throw new Error('JOB_VISUAL_UNAVAILABLE');
      parts=await response.json() as PartsSubjectData;
      if(parts.sourceHash!==source.sourceHash||parts.mode!=='parts')throw new Error('JOB_DISPLAY_MISMATCH');
    }
    let modals:JobRigScreenPrepared['modals'];
    const asks=options.window.state().pending.filter(ask=>ask.publicationId===display.publication.publicationId&&ask.subject.kind!=='review-verdict'&&ask.subject.kind!=='parts-verdict'&&jobRigScreenAsk(display,ask,checkpoints));
    if(!backdropOnly&&options.formDependencies){
      const inspection=await prepareJobInspection(display,signal,true);
      try{modals={inspection,forms:prepareJobForms(display,asks,ask=>formFor(ask,inspection,options.formDependencies!))};}
      catch(error){inspection.dispose();throw error;}
    }
    return {jobRigScreen: true, display, entry: routes.entry, review, checkpoints,...refusal?{refusal}:{},...parts?{parts}:{},...modals?{modals}:{}};
  }
  function still(ask: PendingAskV3, prepared: JobRigScreenPrepared) {
    const stage = screen?.stage();
    if (!stage) throw new Error('JOB_STILL_CAPTURE_FAILED');
    const publication = prepared.display.publication;
    const source = {pageId: options.pageId, publicationId: publication.publicationId, instanceKey: publication.instanceKey,
      sourceHash: publication.source.sourceHash};
    return freezeJobRigStage({...stage,source},ask.askId,++drawGeneration);
  }

  async function submit(session: ReviewSession, committed: (commit: RigHostCommit) => void | Promise<void>, directionWords?:string): Promise<string> {
    const prepared = mounted, state = options.window.state();
    if (!prepared || !state.receipt || state.preparing) throw new Error('JOB_ACT_SOURCE_STALE');
    if (state.closed) throw new Error('JOB_CLOSED');
    const refusal=jobRigScreenRefusal(prepared.display,state.pending,prepared.checkpoints);if(refusal)throw new Error(options.translate('job.refusal.'+refusal));
    if (!options.access.capability) throw new Error('JOB_CAPABILITY_REQUIRED');
    const decisions=jobRigScreenDecisions(session, state.pending.filter(ask=>!prepared.modals?.forms.has(ask.askId)), prepared.display.publication.publicationId);
    if(directionWords!==undefined)for(const decision of decisions)if(decision.kind==='review-verdict'&&decision.value.stage==='direction-review')decision.value.words=directionWords;
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
      const frozen = decision.kind === 'review-verdict' && decision.value.stage === 'rig-review' ? await current.rig.prepare(input, () => still(ask, prepared)) : input;
      const result = await options.window.submit(frozen);
      if (!result.ok) throw new Error(result.error.code, {cause: (result.error as {cause?: unknown}).cause});
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
  function host(prepared: JobRigScreenPrepared, ready: {resolve(): void; reject(error: unknown): void}, navigation?:RigHostNavigation): RigHost {
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
        record:{publicationId:prepared.display.publication.publicationId,label:prepared.display.publication.label,sourceHash:prepared.display.publication.source.sourceHash,hasPicture:!!record.picture},...prepared.refusal?{unavailable:prepared.refusal}:{},pendingSubjects,
        read:(path,method)=>method==='GET'&&backdrop?backdrop.read(path,method):Promise.reject(new Error('JOB_REVIEW_READ_ONLY')),
        submit:async()=>{throw new Error('JOB_REVIEW_READ_ONLY');},
        submitParts:async()=>{throw new Error('JOB_REVIEW_READ_ONLY');},
        attach:value=>{screen=value;screen.pendingSubjects?.(pendingSubjects());refreshRecordForms();},
        displayed:()=>ready.resolve(),failed:error=>ready.reject(error)};
    }
    if(!review&&!prepared.parts)throw new Error('JOB_DISPLAY_MISMATCH');
    return {access,pendingSubjects,navigation,...prepared.refusal?{unavailable:prepared.refusal}:{},...prepared.display.publication.source.direction?{direction:{publicationId:prepared.display.publication.publicationId,sourceHash:prepared.display.publication.source.sourceHash}}:{},
      reviewState(issues,sending) {
        if(sending)return options.translate('job.parts.sending');
        const kind=prepared.parts?'parts-verdict':'review-verdict';
        const ask=options.window.state().pending.filter(ask=>ask.publicationId===prepared.display.publication.publicationId&&
          ask.subject.kind===kind&&(ask.subject.kind!=='review-verdict'||(ask.subject.stage==='rig-review'||ask.subject.stage==='direction-review'))).at(-1);
        const act=ask?.status==='answered'?ask.act:undefined;
        const verdict=act?.kind===kind&&(act.kind==='parts-verdict'||act.kind==='review-verdict')?act.value.verdict:null;
        return verdict==='changes-requested'?options.translate('job.parts.sent'):verdict==='approved'?options.translate('job.review.approved'):
          options.translate('job.parts.reviewing',[issues]);
      },...prepared.parts?{subject:'parts' as const,submitParts}: {},
      read(path, method) {
        if (method !== 'GET') return prepared.parts?undefined:Promise.reject(new Error('JOB_REVIEW_READ_ONLY'));
        if(prepared.parts){
          if(path==='/api/review')return Promise.resolve({subject:'parts',parts:structuredClone(prepared.parts)});
          if(path==='/api/access')return Promise.resolve({capabilityRequired:true,control:false});
          if(path==='/api/session'){const act=options.window.state().pending.filter(ask=>ask.publicationId===prepared.display.publication.publicationId&&ask.subject.kind==='parts-verdict').at(-1)?.act;return Promise.resolve({subject:'parts',issues:act?.kind==='parts-verdict'&&act.schema==='rig-review/act@6'?commentPartsIssues(act.value.comments):act?.kind==='parts-verdict'&&act.schema==='rig-review/act@5'?act.value.issues:[]});}
          return undefined;
        }
        if (path === '/api/review') return Promise.resolve(structuredClone(review!));
        if (path === '/api/access') return Promise.resolve({capabilityRequired: true, control: false});
        if (path === '/api/session') return Promise.resolve({schema: 'rig-review-session/1', id: review!.manifest.id, revision: review!.manifest.revision,
          sourceHash: review!.sourceHash, reviewedSource: structuredClone(review!.reviewedSource), status: 'pending', checkpoints: {}, feedback: [],
          feedbackWarnings: [], updatedAt: null} satisfies ReviewSession);
        return Promise.reject(new Error('JOB_REVIEW_READ_ONLY'));
      },
      submit,
      attach: value => {screen = value;screen.pendingSubjects?.(pendingSubjects());refreshRecordForms();},
      displayed: () => ready.resolve(),
      failed: error => ready.reject(error)};
  }
  /** Pending and completed forms keep the same source-bound builder and receipt gates. */
  function refreshRecordForms():void {
    const record=mounted?.record??mounted?.modals,deps=options.formDependencies;if(!record||!deps)return;
    const state=options.window.state(),display=record.inspection.display;
    const next=prepareJobForms(display,state.pending.filter(ask=>ask.subject.kind!=='parts-verdict'&&ask.subject.kind!=='review-verdict'&&jobRigScreenAsk(display,ask,mounted!.checkpoints)),ask=>record.forms.get(ask.askId)??formFor(ask,record.inspection,deps));
    for(const [id,entry]of next)record.forms.set(id,entry);
    for(const [id,entry]of record.forms){const ask=state.pending.find(ask=>ask.askId===id);entry.fieldset.disabled=entry.submitting||ask?.status!=='pending'||state.preparing||state.closed||!state.receipt||!options.access.capability;}
    screen?.recordForms?.([...record.forms.values()].map(entry=>entry.form));
  }
  return {
    prepare,
    mounted: () => mounted,
    report:(error:unknown,fallback?:string)=>screen?.message(options.refusal(error,fallback),true,jobSubmissionRefusal(error).title),
    commit(prepared: JobRigScreenPrepared) {
      const previous=mounted;mounted=prepared;
      return {async rollback(){try{await transition?.rollback();}finally{transition=null;mounted=previous;}},finalize(){try{transition?.finalize();}finally{transition=null;if(previous!==prepared){const modal=previous?.record??previous?.modals;for(const entry of modal?.forms.values()??[])entry.dispose?.();modal?.inspection.dispose();}}}};
    },
    /** The rig composition draws first; the job acknowledges the display after. */
    async painted(prepared: JobRigScreenPrepared, signal: AbortSignal): Promise<void> {
      let ready!: {resolve(): void; reject(error: unknown): void};
      const shown = new Promise<void>((resolve, reject) => {ready = {resolve, reject};});
      const previous=screen,previousNodes=[...options.host.childNodes??[]],previousHost=rigHost();
      const navigation=previousHost?.record||prepared.record?undefined:previous?.navigation?.();previous?.suspend?.();
      const previousTitle=document.title,previousUrl=typeof location==='undefined'?null:location.href;
      const previousReady=document.body?.getAttribute('data-ready')??null,previousInert=document.body?.inert;
      let candidate:{dispose?():void}|undefined,finished=false,recovery:Promise<void>|null=null;
      const rollback=():Promise<void>=>{
        if(finished)return recovery??Promise.resolve();finished=true;
        if(candidate?.dispose)candidate.dispose();else if(screen!==previous)screen?.dispose?.();screen=previous;
        options.host.replaceChildren(...previousNodes);setRigHost(previousHost);document.title=previousTitle;
        if(previousUrl)history.replaceState(null,'',previousUrl);
        if(document.body){if(previousReady===null)document.body.removeAttribute('data-ready');else document.body.setAttribute('data-ready',previousReady);document.body.inert=previousInert??false;}
        recovery=Promise.resolve(previous?.resume?.());return recovery;
      };
      transition={rollback,finalize(){if(finished)return;finished=true;previous?.dispose?.();}};
      try {
        setRigHost(host(prepared, ready,navigation));
        const app = document.createElement('div');app.id = 'app';
        options.host.replaceChildren(app);document.body?.removeAttribute('data-ready');
        const loaded=await options.load();
        if(loaded&&typeof loaded==='object')candidate=loaded as {dispose?():void};
        await shown;
        if (signal.aborted) throw new Error('JOB_PRELOAD_CANCELLED');
      }catch(error){await rollback();throw error;}
    },
    /** Unsupported asks stay on the shared screen with a named explanation. */
    changed(state: {readonly pending: readonly PendingAskV3[]; readonly closed: boolean; readonly preparing?:boolean; readonly error?:string|null; readonly errorOrigin?:string; readonly previousLabel?:string|null; readonly displayed?:DisplayPublicationV3|null}): void {
      if (!mounted) return;
      if(mounted.record){refreshRecordForms();if(mounted.refusal){screen?.message(options.translate('job.refusal.'+mounted.refusal),true);const notice=document.getElementById('message');if(notice)notice.title=mounted.refusal;}if(state.closed)screen?.message(options.translate('job.closed'),true);return;}
      const refusal=jobRigScreenRefusal(mounted.display,state.pending,mounted.checkpoints);
      if(refusal){screen?.message(options.translate('job.refusal.'+refusal),true);const notice=document.getElementById('message');if(notice)notice.title=refusal;return;}
      screen?.pendingSubjects?.(pendingSubjects());
      refreshRecordForms();
      if(state.error)screen?.message(options.translate('job.failed')+' · '+options.refusal(state.error),true,jobSubmissionRefusal(new Error(state.error,{cause:state.errorOrigin})).title);
      else if (state.closed) screen?.message(options.translate('job.closed'), true);
      else if(!state.preparing&&state.displayed?.publication.publicationId===mounted.display.publication.publicationId){
        const label=state.previousLabel?options.translate('job.updated',[state.previousLabel,mounted.display.publication.label]):mounted.display.publication.label;
        screen?.message(label+(screen.incompatible?.()?' · '+options.translate('job.incompatible'):''));
      }
    },
  };
}
