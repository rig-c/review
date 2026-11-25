import {checkpointEvidencePair} from '../src/checkpoint-evidence-packet.ts';
import {formFor, isPendingOwnerAsk, jobCheckpointContext, jobJson, jobPublicationRoutes, jobSourceDraftId, matchesJobRecordAct, prepareJobForms, prepareJobInspection, jobSubmissionRefusal, type JobForm, type JobFormDependencies, type JobPreparedInspection, type JobWindowAsk} from './job-session.ts';
import {commentPartsIssues,partsIssueComments,type PartsIssue} from '../src/parts-comment.ts';
import type {PartsSubjectData} from './parts-viewport-provider.ts';
/** Card I (#709): a rig publication of a live job opens the one review screen (`main.ts`) instead of the job
 * window. The job stays the transport: same asks, act kinds, still, displayed-ack and submission idempotency.
 * Rig verdicts use the act bar, interviews use the Question tab, and text approvals use the shared ask dialog. */
import {JOB_COMMENT_ONLY_ACT_SCHEMA,type ActV3,type DisplayPublicationV3,type JobComment,type JobCommentCarrier,type JobContextComment,type JobProgressV3,type JobPublishedChestLandmark,type JobResult,type JobUISubmission,type PendingAskV3,type SourceV3,type UISubmissionV3} from '../src/job-contract.ts';
import {canonicalJson} from '../src/canonical-json.ts';
import {draftKey} from '../src/mesh-edit.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';
import type {ReviewManifest, ReviewedSource} from '../src/manifest.ts';
import {checkpointNoteComments, feedbackContextComments, feedbackItemComments, projectComments} from '../src/stage-comment.ts';
import {createJobRigSubmission, freezeJobRigStage} from './job-rig-capture.ts';
import {sha256Hex,type JobMeshDraftSubmission} from './mesh-editor.ts';
import type {JobChestDraftSubmission} from './chest-editor.ts';
import {setRigHost, rigHost, type RigHost, type RigHostScreen, type RigHostCommit, type RigHostNavigation, type CheckpointPairView} from './rig-host.ts';
import {setSourceAttribute, setSourceText, sourceAttribute, sourceTextContent} from './i18n.ts';
import type {InstanceAccess} from './instance-access.ts';

/** The shared screen hosts model packages and parts drafts; records have their own shared host seam. */
export function jobRigScreenSubject(source: SourceV3, rigDraftVerdict = false): boolean {
  if ('record' in source) return false;
  if(source.selector?.kind==='draft'&&source.parts)return true;
  return !!source.model && (source.direction ? source.selector?.kind === 'post' : source.selector === null || source.selector.kind === 'rig' || (source.selector.kind === 'draft' && rigDraftVerdict));
}
/** The asks the rig screen's act bar answers: the rig verdict and checkpoints the package declares. */
export function jobRigScreenAnswers(ask: Pick<PendingAskV3, 'subject'>, checkpoints: ReadonlySet<string>): boolean {
  const subject = ask.subject;
  return subject.kind === 'review-verdict' ? (subject.stage === 'rig-review' || subject.stage === 'direction-review') :
    subject.kind === 'checkpoint' && checkpoints.has(subject.checkpointId);
}
/** #1048: the sealed identities the server attached to the record's question images (none elsewhere). */
function questionPictures(questions:readonly {readonly images:readonly {readonly name:string;readonly path?:string;readonly sha256?:string}[]}[]|undefined):{questionPictures?:{name:string;path:string;sha256:string}[]} {
  const rows=(questions??[]).flatMap(question=>question.images.flatMap(image=>image.path&&image.sha256?[{name:image.name,path:image.path,sha256:image.sha256}]:[]));
  return rows.length?{questionPictures:rows}:{};
}
/** One ask-availability check for both the route and its retained modal forms. */
export function jobRigScreenAsk(display:DisplayPublicationV3,ask:PendingAskV3,checkpoints:ReadonlySet<string>):boolean {
  const source=display.publication.source;
  if(ask.subject.kind==='checkpoint'){
    try {prepareJobForms(display,[ask],()=>jobCheckpointContext(ask,[]));return true;}catch{return false;}
  }
  if(ask.subject.kind==='signoff'||ask.subject.kind==='interview-picks')return true;
  return !!source.model&&jobRigScreenAnswers(ask,checkpoints)&&
    (ask.subject.kind!=='review-verdict'||ask.subject.stage===(source.direction?'direction-review':'rig-review'));
}
export function jobRigScreenRoute(display: DisplayPublicationV3, pending: readonly PendingAskV3[],
  checkpoints: ReadonlySet<string>): boolean {
  const source=display.publication.source,id=display.publication.publicationId;
  if('record' in source)return false;
  if(source.selector?.kind==='draft'&&source.parts&&!display.rigDraftVerdict)return true;
  return (jobRigScreenSubject(source, display.rigDraftVerdict)||!source.model&&!source.parts)&&pending.every(ask=>
    ask.publicationId!==id||ask.status!=='pending'||jobRigScreenAsk(display,ask,checkpoints));
}

/** Refusals describe missing producer inputs without granting a new act authority. */
export function jobRigScreenRefusal(display:DisplayPublicationV3,pending:readonly PendingAskV3[],checkpoints:ReadonlySet<string>,hasPicture=false):string|null {
  const source=display.publication.source;
  if('record' in source)return null;
  {
    if(source.selector?.kind==='post'&&!source.direction)return 'JOB_DIRECTION_MISSING';
    if(source.selector?.kind==='draft'&&!source.parts&&!display.rigDraftVerdict)return 'JOB_PARTS_MISSING';
    if(!source.model&&!source.parts&&!hasPicture&&!pending.some(ask=>ask.publicationId===display.publication.publicationId&&ask.status==='pending'&&ask.subject.kind!=='review-verdict'&&jobRigScreenAsk(display,ask,checkpoints)))return 'JOB_MODEL_MISSING';
  }
  return jobRigScreenRoute(display,pending,checkpoints)?null:'JOB_ASK_UNSUPPORTED';
}

export type JobRigScreenDecision =
  | {readonly ask: PendingAskV3; readonly kind: 'checkpoint'; readonly value: Extract<JobUISubmission, {kind: 'checkpoint'}>['value']}
  | {readonly ask: PendingAskV3; readonly kind: 'review-verdict'; readonly value: {stage: 'rig-review' | 'direction-review'; verdict: 'approved' | 'changes-requested'; words: string; feedback?: readonly Feedback[]; general?: readonly string[]}};
/** The act bar's decisions as the pending asks' values. `words` is the comments' projection (act@6's), or empty;
 * a decision still pending is not sent, so a pending ask is never answered with "pending". Checkpoints go first. */
export function jobRigScreenDecisions(session: Pick<ReviewSession, 'status' | 'checkpoints' | 'feedback'>,
  pending: readonly PendingAskV3[], publicationId: string, general?: readonly string[]): JobRigScreenDecision[] {
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
  if (session.status === 'pending') return decisions;
  for (const verdict of open) {
    if (verdict.subject.kind !== 'review-verdict') continue;
    const {stage} = verdict.subject;
    if (stage !== 'rig-review' && stage !== 'direction-review') continue;
    decisions.push({ask: verdict, kind: 'review-verdict', value: {stage, verdict: session.status,
      words: session.feedback.length ? projectComments(feedbackItemComments(session.feedback)) : '',
      ...(stage === 'rig-review' && session.feedback.length ? {feedback: structuredClone(session.feedback)} : {}),
      ...(stage === 'rig-review' && general?.length ? {general: [...general]} : {})}});
    break;
  }
  return decisions;
}

interface ReviewJson {manifest: ReviewManifest; reviewedSource: ReviewedSource; sourceHash: string}
export interface JobRigMeshScreen extends RigHostScreen {
  hasMeshEdits?(): boolean;
  meshEdits?(): Promise<JobMeshDraftSubmission|null>;
  chestLandmarks?(): JobChestDraftSubmission|null;
}
export interface JobRigMeshHost extends RigHost {
  canSubmitMeshEdits?(): boolean;
  jobClosed?(): boolean;
  recordSubmission?(): 'sending' | 'submitted' | null;
  readonly chestLandmarks?: readonly JobPublishedChestLandmark[];
}
export interface JobRigScreenPrepared {readonly jobRigScreen: true; readonly display: DisplayPublicationV3; readonly entry: string;
  readonly refusal?:string; readonly modals?: {inspection:JobPreparedInspection;forms:Map<string,JobForm>}; readonly review?: ReviewJson; readonly evidence?:JobPreparedInspection; readonly record?: {inspection:JobPreparedInspection;forms:Map<string,JobForm>;picture:JobRigScreenPrepared|null}; readonly parts?:PartsSubjectData; readonly checkpoints: ReadonlySet<string>}
export function isJobRigScreen(value: unknown): value is JobRigScreenPrepared {
  return !!value && typeof value === 'object' && (value as {jobRigScreen?: unknown}).jobRigScreen === true;
}

export function createJobRigScreen(options: {
  host: HTMLElement;
  pageId: string;
  access: {readonly capability: string | null; headers(init?: HeadersInit): Headers};
  window: {state(): {readonly pending: readonly (PendingAskV3 & {readonly act?:ActV3})[]; readonly receipt: {readonly displayedNonce: string} | null;
    readonly generation: number; readonly preparing: boolean; readonly closed: boolean; readonly recordReceiptAskId?:string}; submit(input: UISubmissionV3): Promise<JobResult<ActV3>>};
  routes(display: DisplayPublicationV3): {entry: string; api(path: string): string};
  readPublication?(publicationId:string,signal:AbortSignal):Promise<JobResult<DisplayPublicationV3>>;
  formDependencies?:JobFormDependencies;
  refusal(error: unknown, fallback?: string): string;
  translate(key: string,values?:readonly (string|number)[]): string;
  confirm?(text: string): boolean;
  /** Imports the rig composition once the host is set. */
  load(): Promise<unknown>;
}) {
  let mounted: JobRigScreenPrepared | null = null, screen: JobRigMeshScreen | null = null, drawGeneration = 0;
  let latestProgress: JobProgressV3 | null = null;
  const showProgress=()=>{
    if(!screen?.progress)return;
    const awaitingAsk=screen.publish&&options.window.state().pending.some(ask=>ask.status==='pending');
    screen.progress(awaitingAsk?null:latestProgress);
  };
  let lastMessage: [text: string, error?: boolean, diagnostic?: string] = ['', false];
  let streamReport: {message: typeof lastMessage; notice: HTMLElement | null; applied: string; title: string} | null = null;
  let transition:{rollback():Promise<void>;finalize():void}|null=null;
  const say=(text:string,error?:boolean,diagnostic?:string,title?:string)=>{
    streamReport=null;lastMessage=[text,error,title??diagnostic];screen?.message(...lastMessage);
  };
  const attempts = new Map<string, {key: string; submissionId: string; rig: ReturnType<typeof createJobRigSubmission>; commit: Omit<RigHostCommit, 'at'>}>();
  async function prepare(display: DisplayPublicationV3, signal: AbortSignal, backdropOnly=false): Promise<JobRigScreenPrepared | null> {
    if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
    const source = display.publication.source;
    if ('record' in source) {
      if (!options.formDependencies) throw new Error('JOB_ACT_KIND_DISABLED');
      const inspection = await prepareJobInspection(display, signal);
      try {
        const {entry} = options.routes(display);
        const {manifest, reviewedSource} = inspection.metadata;
        // #983: a declared plan picture ranks first; the walk below runs only without it.
        const checkpoint = options.window.state().pending.find(ask=>ask.publicationId===display.publication.publicationId&&ask.status==='pending'&&ask.subject.kind==='checkpoint')?.subject;
        const paired = checkpoint?.kind==='checkpoint'&&inspection.checkpointEvidence?.some(({packet})=>packet.checkpointId===checkpoint.checkpointId&&!!packet.pair);
        let picture: JobRigScreenPrepared | null = !paired && !inspection.planPicture && manifest?.model && reviewedSource?.rig
          ? {jobRigScreen:true, display, entry, checkpoints:new Set(), review:{...inspection.metadata, manifest, reviewedSource}}
          : null;
        const missingBoundPicture = inspection.interview?.questions.some(question => question.missingPicture);
        let previous = paired || missingBoundPicture || inspection.planPicture ? null : display.publication.previousPublicationId;
        const jobId=jobPublicationRoutes(display,location.origin).jobId;
        const seen = new Set([display.publication.publicationId]);
        let generation = display.publication.generation;
        while (!picture && previous) {
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
          if (jobRigScreenSubject(candidate.publication.source, candidate.rigDraftVerdict)) {picture = await prepare(candidate, signal, true);break;}
          previous = candidate.publication.previousPublicationId;
        }
        if (!picture && !missingBoundPicture && !inspection.planPicture && inspection.interview?.questions.some(question => question.hasParts)) {
          const response = await fetch(options.routes(display).api('stage-parts'), {signal});
          if (!response.ok) throw new Error('JOB_VISUAL_UNAVAILABLE');
          const parts = await response.json() as PartsSubjectData;
          if (parts.sourceHash !== source.sourceHash || parts.mode !== 'parts') throw new Error('JOB_DISPLAY_MISMATCH');
          picture = {jobRigScreen:true,display,entry,checkpoints:new Set(),parts};
        }
        if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');
        const checkpoints = new Set<string>();
        const forms = prepareJobForms(display, options.window.state().pending.filter(ask => jobRigScreenAsk(display, ask, checkpoints)), ask => formFor(ask, inspection, options.formDependencies!),true);
        return {jobRigScreen:true,display,entry,checkpoints,record:{inspection,forms,picture}};
      } catch(error) {inspection.dispose();throw error;}
    }
    if (!jobRigScreenSubject(source, display.rigDraftVerdict)) {
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
    // #1050: the modal inspection below reads the same metadata; jobJson hands it this request.
    const review = await jobJson<ReviewJson>(routes.api('review'), signal).catch((error: unknown) => {
      throw error instanceof Error && error.message === 'JOB_PRELOAD_FAILED' ? new Error('JOB_VISUAL_UNAVAILABLE') : error;
    });
    if (!review.manifest || !review.reviewedSource || review.sourceHash !== source.sourceHash ||
        review.manifest.id !== source.package.id || review.manifest.revision !== source.package.revision ||
        (review.reviewedSource.rig?.sha256 ?? null) !== (source.model?.sha256 ?? null)) throw new Error('JOB_DISPLAY_MISMATCH');
    const checkpoints = new Set(review.manifest.checkpoints.map(item => item.id));
    const refusal=backdropOnly?null:jobRigScreenRefusal(display,options.window.state().pending,checkpoints);
    let parts:PartsSubjectData|undefined;
    if(source.selector?.kind==='draft'&&source.parts&&!display.rigDraftVerdict){
      const response=await fetch(routes.api('stage-parts'),{signal});if(!response.ok)throw new Error('JOB_VISUAL_UNAVAILABLE');
      parts=await response.json() as PartsSubjectData;
      if(parts.sourceHash!==source.sourceHash||parts.mode!=='parts')throw new Error('JOB_DISPLAY_MISMATCH');
    }
    let modals:JobRigScreenPrepared['modals'], evidence:JobPreparedInspection|undefined;
    const asks=options.window.state().pending.filter(ask=>ask.publicationId===display.publication.publicationId&&ask.subject.kind!=='review-verdict'&&ask.subject.kind!=='parts-verdict'&&jobRigScreenAsk(display,ask,checkpoints));
    if(!backdropOnly&&options.formDependencies){
      // The shared main workspace loads visuals; modal forms keep data and checkpoint evidence.
      const inspection=await prepareJobInspection(display,signal,true,false);
      try{modals={inspection,forms:prepareJobForms(display,asks,ask=>formFor(ask,inspection,options.formDependencies!))};}
      catch(error){inspection.dispose();throw error;}
    }
    if(!backdropOnly&&!modals&&source.checkpointEvidence?.some(packet=>Object.hasOwn(packet,'pair')))evidence=await prepareJobInspection(display,signal,true,false);
    return {jobRigScreen: true, display, entry: routes.entry, review, checkpoints,...evidence?{evidence}:{},...refusal?{refusal}:{},...parts?{parts}:{},...modals?{modals}:{}};
  }
  function still(ask: PendingAskV3, prepared: JobRigScreenPrepared) {
    const stage = screen?.stage();
    if (!stage) throw new Error('JOB_STILL_CAPTURE_FAILED');
    const publication = prepared.display.publication;
    const source = {pageId: options.pageId, publicationId: publication.publicationId, instanceKey: publication.instanceKey,
      sourceHash: publication.source.sourceHash};
    return freezeJobRigStage({...stage,source},ask.askId,++drawGeneration);
  }

  async function submit(session: ReviewSession, committed: (commit: RigHostCommit) => void | Promise<void>, directionComments?: readonly JobComment[], general?:readonly string[], alreadySent?:(row:Feedback)=>boolean): Promise<string> {
    const prepared = mounted, state = options.window.state();
    if (!prepared || !state.receipt || state.preparing) throw new Error('JOB_ACT_SOURCE_STALE');
    if (state.closed) throw new Error('JOB_CLOSED');
    const refusal=jobRigScreenRefusal(prepared.display,state.pending,prepared.checkpoints);if(refusal)throw new Error(options.translate('job.refusal.'+refusal));
    if (!options.access.capability) throw new Error('JOB_CAPABILITY_REQUIRED');
    // #1226: the verdict carries only rows not already sent on their own; the committed baseline keeps every row.
    const sendable=alreadySent?{...session,feedback:session.feedback.filter(row=>!alreadySent(row))}:session;
    const decisions=jobRigScreenDecisions(sendable, state.pending.filter(ask=>!prepared.modals?.forms.has(ask.askId)), prepared.display.publication.publicationId, general);
    if (!decisions.length) throw new Error('JOB_ACT_NOTHING_TO_SUBMIT');
    const rigChanges=decisions.find(decision=>decision.kind==='review-verdict'&&decision.value.stage==='rig-review'&&decision.value.verdict==='changes-requested');
    // #1231: Edit Mesh and chest drafts no longer ride the verdict. Request changes sends them first as an act@10.
    const drafts=rigChanges?await draftCarriers(prepared):null;
    if(drafts?.carriers.length){
      const latest=options.window.state();
      if(mounted!==prepared||latest.preparing||latest.receipt?.displayedNonce!==state.receipt.displayedNonce)throw new Error('JOB_ACT_SOURCE_STALE');
      const meshEdits=drafts.carriers.find(carrier=>carrier.kind==='mesh-edits')?.meshEdits.length;
      if(meshEdits&&options.confirm&&!options.confirm(options.translate('Send this Request changes with {0} mesh edit(s) to the producer?',[meshEdits])))return '';
      await sendCommentAct(prepared,state.receipt.displayedNonce,[],drafts);
    }
    for (const decision of decisions) {
      const value = directionComments !== undefined && decision.kind === 'review-verdict' && decision.value.stage === 'direction-review'
        ? {stage: decision.value.stage, verdict: decision.value.verdict, comments: directionComments}
        : decision.value;
      const key = JSON.stringify(value);
      let attempt = attempts.get(decision.ask.askId);
      if (!attempt || attempt.key !== key) attempts.set(decision.ask.askId, attempt = {key, submissionId: crypto.randomUUID(), rig: createJobRigSubmission(),
        commit: decision.kind === 'checkpoint' ? {checkpoints: {[decision.value.checkpointId]: structuredClone(session.checkpoints[decision.value.checkpointId]!)}} :
          {review: {status: decision.value.verdict, feedback: structuredClone(session.feedback)}}});
      const latest = options.window.state();
      if (!latest.receipt) throw new Error('JOB_ACT_SOURCE_STALE');
      const input = {kind: decision.kind, publicationId: decision.ask.publicationId, askId: decision.ask.askId, pageId: options.pageId,
        displayedNonce: latest.receipt.displayedNonce, expectedGeneration: latest.generation, submissionId: attempt.submissionId,
        value} as JobUISubmission;
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
  async function submitParts(issues:readonly PartsIssue[], general?:readonly string[]):Promise<string>{
    const prepared=mounted,state=options.window.state();
    if(!prepared?.parts||!state.receipt||state.preparing)throw new Error('JOB_ACT_SOURCE_STALE');
    if(state.closed)throw new Error('JOB_CLOSED');
    const ask=state.pending.find(ask=>ask.publicationId===prepared.display.publication.publicationId&&ask.status==='pending'&&ask.subject.kind==='parts-verdict');
    if(!ask)throw new Error('JOB_ACT_NOTHING_TO_SUBMIT');
    const value={verdict:issues.length?'changes-requested' as const:'approved' as const,issues:structuredClone(issues),words:'',
      ...(general?.length?{general:[...general]}:{})},key=JSON.stringify(value);
    let attempt=partsAttempts.get(ask.askId);if(!attempt||attempt.key!==key){attempt={key,submissionId:crypto.randomUUID()};partsAttempts.set(ask.askId,attempt);}
    const result=await options.window.submit({kind:'parts-verdict',publicationId:ask.publicationId,askId:ask.askId,pageId:options.pageId,displayedNonce:state.receipt.displayedNonce,expectedGeneration:state.generation,submissionId:attempt.submissionId,value});
    if(!result.ok)throw new Error(result.error.code,{cause:(result.error as {cause?:unknown}).cause});
    partsAttempts.delete(ask.askId);return options.translate('job.saved');
  }
  // The daemon's idempotency digest covers the whole submission, so a retry after a lost response replays the cached request unchanged.
  let commentAttempt:{key:string;request:Extract<UISubmissionV3,{kind:'comments'}>}|null=null;
  type DraftCarriers={carriers:JobCommentCarrier[];mesh:JobMeshDraftSubmission|null;chest:JobChestDraftSubmission|null};
  /** #1231: the pending Edit Mesh and chest drafts as act@10 carriers on the displayed model; rows as act@8/@9 sent them. */
  async function draftCarriers(prepared:JobRigScreenPrepared):Promise<DraftCarriers>{
    const {source}=prepared.display.publication,model='model' in source?source.model:null;
    const file=model?{path:model.path,sha256:model.sha256}:null,carriers:JobCommentCarrier[]=[];
    const chest=file?screen?.chestLandmarks?.()??null:null,mesh=file?await screen?.meshEdits?.()??null:null;
    const bind=<T,>(edit:T)=>sha256Hex(canonicalJson(edit)).then(sha256=>({edit,sha256}));
    if(file&&mesh?.edits.length){
      const edits=mesh.edits.map(edit=>({key:draftKey(edit),edit})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
      carriers.push({kind:'mesh-edits',file,meshEdits:await Promise.all(edits.map(({edit})=>bind(edit)))});
    }
    if(file&&chest?.edits.length)carriers.push({kind:'chest-landmarks',file,chestLandmarks:await Promise.all(chest.edits.map(bind))});
    return {carriers,mesh,chest};
  }
  /** #1226: one comment-only act (act@10) bound by the page receipt; it answers no ask and leaves a pending one pending.
   * #1231: the drafts it carried, as the daemon accepted them, are cleared. */
  async function sendCommentAct(prepared:JobRigScreenPrepared,displayedNonce:string,comments:readonly JobContextComment[],drafts:DraftCarriers):Promise<void>{
    const state=options.window.state();
    if(mounted!==prepared||state.preparing||state.receipt?.displayedNonce!==displayedNonce)throw new Error('JOB_ACT_SOURCE_STALE');
    const value={comments,...drafts.carriers.length?{carriers:drafts.carriers}:{}},publicationId=prepared.display.publication.publicationId;
    const key=JSON.stringify([publicationId,displayedNonce,value]);
    if(commentAttempt?.key!==key)commentAttempt={key,request:{kind:'comments',publicationId,pageId:options.pageId,
      displayedNonce,expectedGeneration:state.generation,submissionId:crypto.randomUUID(),value}};
    const result=await options.window.submit(commentAttempt.request);
    if(!result.ok)throw new Error(result.error.code,{cause:(result.error as {cause?:unknown}).cause});
    commentAttempt=null;
    const act=result.value;
    if(act.schema!==JOB_COMMENT_ONLY_ACT_SCHEMA)return;
    for(const carrier of act.value.carriers??[]){
      const sent=drafts.carriers.find(row=>row.kind===carrier.kind);
      if(carrier.kind==='mesh-edits'&&sent?.kind==='mesh-edits'){
        const accepted=new Set(carrier.meshEdits.map(row=>row.sha256));
        drafts.mesh?.clear(sent.meshEdits.filter(row=>accepted.has(row.sha256)).map(row=>row.edit));
      }
      if(carrier.kind==='chest-landmarks'&&sent?.kind==='chest-landmarks'){
        const accepted=new Set(carrier.chestLandmarks.map(row=>row.sha256));
        drafts.chest?.clear(sent.chestLandmarks.filter(row=>accepted.has(row.sha256)).map(row=>row.edit));
      }
    }
  }
  /** Send comments: the person's comments, with any pending Edit Mesh and chest drafts as carriers (#1231).
   * #1242: the same act from the direction, parts and record screens; parts pins keep their source-bound anchor. */
  async function submitComments(feedback:readonly Feedback[], general:readonly string[], issues:readonly PartsIssue[]=[]):Promise<string>{
    const prepared=mounted,state=options.window.state();
    if(!prepared||!state.receipt||state.preparing)throw new Error('JOB_ACT_SOURCE_STALE');
    if(state.closed)throw new Error('JOB_CLOSED');
    if(!options.access.capability)throw new Error('JOB_CAPABILITY_REQUIRED');
    const comments=[...feedbackContextComments(feedback),...partsIssueComments(issues),...general.map(text=>({text}))];
    const drafts=await draftCarriers(prepared);
    if(!comments.length&&!drafts.carriers.length)throw new Error('JOB_ACT_NOTHING_TO_SUBMIT');
    await sendCommentAct(prepared,state.receipt.displayedNonce,comments,drafts);
    return options.translate('job.saved');
  }
  const activeAsks=(pending:readonly JobWindowAsk[],publicationId:string|undefined)=>
    pending.filter(ask=>ask.publicationId===publicationId&&isPendingOwnerAsk(ask));
  const pendingSubjects=()=>activeAsks(options.window.state().pending,mounted?.display.publication.publicationId).map(ask=>ask.subject);
  function host(prepared: JobRigScreenPrepared, ready: {resolve(): void; reject(error: unknown): void}, navigation?:RigHostNavigation): JobRigMeshHost {
    const base = new URL(prepared.entry).pathname;
    const jobId = /^\/jobs\/([^/]+)\//.exec(base)?.[1];
    const record = prepared.record ?? prepared.modals;
    const recordSubmission = () => {
      if (prepared !== mounted) return null;
      const {pending, closed, recordReceiptAskId} = options.window.state();
      const active = activeAsks(pending, prepared.display.publication.publicationId);
      if (!closed && active.some(ask => record?.forms.get(ask.askId)?.submitting &&
          (ask.subject.kind === 'signoff' || ask.subject.kind === 'checkpoint'))) return 'sending' as const;
      return !active.length && recordReceiptAskId !== undefined ? 'submitted' as const : null;
    };
    const draftId = jobSourceDraftId(prepared.display.publication.source);
    const previousPublicationId = prepared.display.publication.previousPublicationId;
    const access: InstanceAccess = {base, key: prepared.display.publication.instanceKey, capability: options.access.capability,
      route: path => {if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Instance route must be app-absolute'); return base + path.slice(1);},
      headers: init => options.access.headers(init)};
    const review = prepared.review;
    const inspection=prepared.record?.inspection??prepared.modals?.inspection??prepared.evidence;
    const pairs=new Map<string,CheckpointPairView>();
    for(const {packet,images} of prepared.parts?[]:inspection?.checkpointEvidence??[]){
      const pair=checkpointEvidencePair(packet);
      if(!pair)continue;
      const imageFor=(tile:typeof pair.before)=>{
        const image=images[packet.tiles.findIndex(item=>item.id===tile.id&&item.sha256===tile.sha256)];
        if(!image)throw new Error('CHECKPOINT_EVIDENCE_PAIR_INVALID');
        return {id:tile.id,path:tile.path,sha256:tile.sha256,image};
      };
      pairs.set(packet.checkpointId,{checkpointId:packet.checkpointId,before:imageFor(pair.before),after:imageFor(pair.after),
        differenceUrl:options.routes(prepared.display).api(`checkpoint-evidence/${packet.checkpointId}/difference`)});
    }
    const evidencePair=pairs.size?{checkpointPairs:pairs,checkpointPair:()=>{
      const ask=pendingSubjects().find(subject=>subject.kind==='checkpoint');
      return ask?.kind==='checkpoint'?pairs.get(ask.checkpointId):undefined;
    }}:{};
    if(prepared.record){
      const record=prepared.record,backdrop=record.picture?host(record.picture,ready):null;
      const question=record.inspection.interview?.questions[0];
      return {...evidencePair,...(backdrop?.subject?{subject:backdrop.subject}:{}),access:{...(backdrop?.access??access),capability:null,
        headers:init=>{const headers=options.access.headers(init);headers.delete('X-Review-Capability');return headers;}},
        ownerActAccess:{capability:options.access.capability},recordSubmission,
        record:{...(jobId?{jobId}:{}),draftId,publicationId:prepared.display.publication.publicationId,previousPublicationId,label:prepared.display.publication.label,sourceHash:prepared.display.publication.source.sourceHash,hasPicture:!!record.picture,...record.inspection.planPicture?{planPicture:record.inspection.planPicture}:{},...questionPictures(record.inspection.interview?.questions),missingPicture:question?.missingPicture,questionPicture:question?.scenePicture || (question?.missingPicture && question.images.length ? true : undefined)},...prepared.refusal?{unavailable:prepared.refusal}:{},pendingSubjects,
        read:(path,method)=>method==='GET'&&backdrop?backdrop.read(path,method):Promise.reject(new Error('JOB_REVIEW_READ_ONLY')),
        submit:async()=>{throw new Error('JOB_REVIEW_READ_ONLY');},
        submitParts:async()=>{throw new Error('JOB_REVIEW_READ_ONLY');},
        // #1242: the record's comments go out as the rig screen's comment-only act.
        submitComments,jobClosed:()=>options.window.state().closed,
        attach:value=>{screen=value;lastMessage=['',false];streamReport=null;screen.pendingSubjects?.(pendingSubjects());screen.progress?.(latestProgress);refreshRecordForms();},
        displayed:()=>ready.resolve(),failed:error=>ready.reject(error)};
    }
    if(!review&&!prepared.parts)throw new Error('JOB_DISPLAY_MISMATCH');
    const {publicationId,source,answeredDirectionFeedback}=prepared.display.publication;
    const binding={...(jobId?{jobId}:{}),draftId,publicationId,previousPublicationId,sourceHash:source.sourceHash};
    /** The verdict this page's latest rig/direction or parts verdict ask was answered with, or null. */
    const answeredVerdict=()=>{
      const kind=prepared.parts?'parts-verdict':'review-verdict';
      const ask=options.window.state().pending.filter(ask=>ask.publicationId===prepared.display.publication.publicationId&&
        ask.subject.kind===kind&&(ask.subject.kind!=='review-verdict'||(ask.subject.stage==='rig-review'||ask.subject.stage==='direction-review'))).at(-1);
      const act=ask?.status==='answered'?ask.act:undefined;
      return act?.kind===kind&&(act.kind==='parts-verdict'||act.kind==='review-verdict')?act.value.verdict:null;
    };
    return {...evidencePair,access,pendingSubjects,recordSubmission,navigation,jobClosed:()=>options.window.state().closed,...prepared.refusal?{unavailable:prepared.refusal}:{},
      chestLandmarks:prepared.display.publication.chestLandmarks,
      ...(source.direction?{direction:{...binding,answeredDirectionFeedback}}:jobRigScreenSubject(source, prepared.display.rigDraftVerdict)?{verdictComments:{...binding,rows:[],available:()=>{const subjects=pendingSubjects();
        // #1226/#1242: with no ask pending, a rig or parts general comment goes out as a comment-only act.
        return !subjects.length||subjects.some(subject=>
        prepared.parts?subject.kind==='parts-verdict':subject.kind==='review-verdict'&&subject.stage==='rig-review');}}}:{}),
      reviewState(issues,sending) {
        if(sending)return options.translate('job.parts.sending');
        const verdict=answeredVerdict();
        return verdict==='changes-requested'?options.translate('job.parts.sent'):verdict==='approved'?options.translate('job.review.approved'):
          options.translate('job.parts.reviewing',[issues]);
      },
      verdictAnswered:()=>answeredVerdict()!==null,...prepared.parts?{subject:'parts' as const,submitParts}: {},
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
      submit,submitComments,
      canSubmitMeshEdits:()=>!!(screen?.hasMeshEdits?.()||screen?.chestLandmarks?.()?.edits.length),
      attach: value => {screen = value;lastMessage=['',false];streamReport=null;screen.pendingSubjects?.(pendingSubjects());screen.progress?.(latestProgress);refreshRecordForms();},
      displayed: () => ready.resolve(),
      failed: error => ready.reject(error)};
  }
  /** Pending and completed forms keep the same source-bound builder and receipt gates. */
  function refreshRecordForms():void {
    const record=mounted?.record??mounted?.modals,deps=options.formDependencies;if(!record||!deps)return;
    const state=options.window.state(),display=record.inspection.display;
    const next=prepareJobForms(display,state.pending.filter(ask=>ask.subject.kind!=='parts-verdict'&&ask.subject.kind!=='review-verdict'&&jobRigScreenAsk(display,ask,mounted!.checkpoints)),ask=>{const previous=record.forms.get(ask.askId),saved=state.pending.find(item=>item.askId===ask.askId);if(previous&&saved?.act?.kind==='interview-picks'&&ask.status==='answered'&&!previous.submitting&&previous.form.dataset.interviewAnswered!=='true'){previous.dispose?.();return formFor(saved,record.inspection,deps);}return previous??formFor(saved??ask,record.inspection,deps);},true);
    const jobId = jobPublicationRoutes(display, location.origin).jobId;
    let removedAnswer = false;
    for(const [id,entry]of record.forms)if(!next.has(id)){
      const ask=state.pending.find(item=>item.askId===id);
      if(ask?.status==='answered'&&matchesJobRecordAct(ask,ask.act,jobId))removedAnswer=true;
      entry.dispose?.();record.forms.delete(id);
    }
    for(const [id,entry]of next)record.forms.set(id,entry);
    for(const [id,entry]of record.forms){const ask=state.pending.find(ask=>ask.askId===id);entry.fieldset.disabled=entry.submitting||ask?.status!=='pending'||state.preparing||state.closed||!state.receipt||!options.access.capability;}
    if(removedAnswer)deps.saveDraft();
    screen?.recordForms?.([...record.forms.values()].map(entry=>entry.form));
  }
  /** Mount the shared composition before source data exists; the first paint resumes it. */
  async function waiting():Promise<void> {
      let attached!:()=>void,failed!:(error:unknown)=>void;
      const ready=new Promise<void>((resolve,reject)=>{attached=resolve;failed=reject;});
      setRigHost({waiting:true,access:{base:location.pathname,key:options.pageId,capability:options.access.capability,
        route:()=>{throw new Error('JOB_DISPLAY_MISMATCH');},headers:init=>options.access.headers(init)},
        read:()=>Promise.reject(new Error('JOB_DISPLAY_MISMATCH')),
        submit:async()=>{throw new Error('JOB_ACT_SOURCE_STALE');},
        attach:value=>{screen=value;showProgress();attached();},displayed:()=>{},failed});
      await options.load();await ready;
  }
  return {
    prepare,waiting,
    mounted: () => mounted,
    progress(value: JobProgressV3 | null): void {
      latestProgress = value;
      showProgress();
    },
    report(error:unknown,fallback?:string):void {
      const text=options.refusal(error,fallback),title=jobSubmissionRefusal(error).title;
      if(fallback!=='JOB_STREAM_FAILED'){say(text,true,title);return;}
      const notice=typeof document!=='undefined'?document.getElementById?.('review-message'):null;
      if(!streamReport||streamReport.notice!==notice||
        (notice&&(notice.textContent!==streamReport.applied||notice.title!==streamReport.title))){
        const previous=notice?[sourceTextContent(notice),notice.classList.contains('error'),sourceAttribute(notice,'title')??notice.title] as const:lastMessage;
        streamReport={message:[...previous],notice,applied:'',title:''};
      }
      screen?.message(text,true,title);
      streamReport.applied=notice?.textContent??text;
      streamReport.title=notice?.title??title;
    },
    clearReport():void {
      if(!streamReport)return;
      const {message,notice,applied,title}=streamReport;
      streamReport=null;
      if(!notice){screen?.message(...message);return;}
      if(notice!==document.getElementById?.('review-message')||notice.textContent!==applied||notice.title!==title)return;
      setSourceText(notice,message[0]);setSourceAttribute(notice,'title',message[2]??'');notice.classList.toggle('error',!!message[1]);
      screen?.syncActRow?.();
    },
    commit(prepared: JobRigScreenPrepared) {
      const previous=mounted;mounted=prepared;
      return {async rollback(){try{await transition?.rollback();}finally{transition=null;mounted=previous;}},finalize(){try{transition?.finalize();}finally{transition=null;if(previous!==prepared){const modal=previous?.record??previous?.modals;for(const entry of modal?.forms.values()??[])entry.dispose?.();modal?.inspection.dispose();previous?.evidence?.dispose();}}}};
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
        if(filling)screen?.dispose?.();else if(candidate?.dispose)candidate.dispose();else if(screen!==previous)screen?.dispose?.();screen=previous;
        options.host.replaceChildren(...previousNodes);setRigHost(previousHost);document.title=previousTitle;
        if(previousUrl)history.replaceState(null,'',previousUrl);
        if(document.body){if(previousReady===null)document.body.removeAttribute('data-ready');else document.body.setAttribute('data-ready',previousReady);document.body.inert=previousInert??false;}
        // Filling consumes the waiting screen's one-shot continuation. Recreate that same shared
        // composition after disposing its mutated candidate, so the next transaction can fill it again.
        if(filling){screen=null;recovery=waiting();}
        else {previous?.progress?.(latestProgress);recovery=Promise.resolve(previous?.resume?.());}
        return recovery;
      };
      const filling=!!previousHost?.waiting&&!!previous?.publish;
      transition={rollback,finalize(){if(finished)return;finished=true;if(!filling)previous?.dispose?.();}};
      try {
        const nextHost=host(prepared,ready,navigation);setRigHost(nextHost);
        if(filling){previous!.publish!(nextHost);await shown;if(signal.aborted)throw new Error('JOB_PRELOAD_CANCELLED');return;}
        const app = document.createElement('div');app.id = 'app';
        options.host.replaceChildren(app);document.body?.removeAttribute('data-ready');
        const loaded=await options.load();
        if(loaded&&typeof loaded==='object')candidate=loaded as {dispose?():void};
        await shown;
        if (signal.aborted) throw new Error('JOB_PRELOAD_CANCELLED');
      }catch(error){await rollback();throw error;}
    },
    /** Unsupported asks stay on the shared screen with a named explanation. */
    changed(state: {readonly pending: readonly PendingAskV3[]; readonly closed: boolean; readonly preparing?:boolean; readonly error?:string|null; readonly errorOrigin?:string; readonly failure?:unknown; readonly previousLabel?:string|null; readonly displayed?:DisplayPublicationV3|null}): void {
      if (!mounted) return;
      if(mounted.record){screen?.pendingSubjects?.(pendingSubjects());refreshRecordForms();if(mounted.refusal)say(options.translate('job.refusal.'+mounted.refusal),true,undefined,mounted.refusal);if(state.closed)say(options.translate('job.closed'),true);return;}
      const refusal=jobRigScreenRefusal(mounted.display,state.pending,mounted.checkpoints);
      if(refusal){say(options.translate('job.refusal.'+refusal),true,undefined,refusal);return;}
      screen?.pendingSubjects?.(pendingSubjects());
      refreshRecordForms();
      if(state.error)say(options.translate('job.failed')+' · '+options.refusal(state.failure??state.error),true,jobSubmissionRefusal(new Error(state.error,{cause:state.errorOrigin})).title);
      else if (state.closed) say(options.translate('job.closed'), true);
      else if(!state.preparing&&state.displayed?.publication.publicationId===mounted.display.publication.publicationId){
        const label=state.previousLabel?options.translate('job.updated',[state.previousLabel,mounted.display.publication.label]):mounted.display.publication.label;
        say(label+(screen?.incompatible?.()?' · '+options.translate('job.incompatible'):''));
      }
    },
  };
}
