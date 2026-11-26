import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {afterEach, expect, test} from 'bun:test';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {seedHistoricalCheckpointAct, seedHistoricalCheckpointAsk} from './helpers/historical-checkpoint-act.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {jobRigScreenDecisions, jobRigScreenRoute, jobRigScreenSubject, jobRigScreenAsk, jobRigScreenRefusal} from '../web/job-rig-screen.ts';
import {checkpointNoteComments, feedbackItemComments} from '../src/stage-comment.ts';
import {assertPartsIssueBinding, parsePartsIssue, snapImageRegion} from '../src/parts-comment.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {tr} from '../web/i18n.ts';
// The projector Create applies to act@6 comments: the public job-host export (Create c8382ba5 pins @rig-c/review 2.12.0).
import {parseCommentsAct, projectComments} from '../src/job-host.ts';
import legacy from './fixtures/comments-contract-legacy.json';
import type {DisplayPublicationV3, JobUISubmission, PendingAskV3} from '../src/job-contract.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }
const feedback: Feedback = {id: 'one', frameStart: 3, frameEnd: 5, target: {kind: 'slot', name: 'sleeve'}, category: 'defect',
  summary: 'Sleeve tears at the elbow\nduring the swing'};
function session(value: Partial<Pick<ReviewSession, 'status' | 'checkpoints' | 'feedback'>>) {
  return {status: 'pending' as const, checkpoints: {}, feedback: [], ...value};
}
/** What the act carries apart from its own identity and time: the bytes a consumer reads. */
function actBytes(act: {actId: string; askId: string; at: string}): string {
  const {actId: _actId, askId: _askId, at: _at, ...rest} = act;
  return JSON.stringify(rest);
}

test('#715 and #1229 mixed rig verdict, supported modal asks and legacy pending checkpoint asks stay on the shared screen without mounting a checkpoint form', async () => {
  const f = await fixture(), publication = await f.publish();
  const display = {publication} as unknown as DisplayPublicationV3, ids = new Set(['step-one']);
  expect(jobRigScreenSubject(publication.source as DisplayPublicationV3['publication']['source'])).toBe(true);
  const verdict = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const checkpoint = seedHistoricalCheckpointAsk(f.session, publication.publicationId, {kind: 'checkpoint', checkpointId: 'step-one'});
  const asks = [verdict, checkpoint] as unknown as PendingAskV3[];
  expect(jobRigScreenRoute(display, asks, ids)).toBe(true);
  expect(jobRigScreenRoute(display, asks, new Set())).toBe(true);
  expect(jobRigScreenAsk(display, checkpoint as unknown as PendingAskV3, ids)).toBe(false);
  const signoff = {...verdict, askId: 'signoff', subject: {kind: 'signoff', stage: 'rig-review'}} as unknown as PendingAskV3;
  expect(jobRigScreenRoute(display, [...asks, signoff], ids)).toBe(false);
  expect(jobRigScreenRefusal(display, [...asks, signoff], ids)).toBe('JOB_ASK_UNSUPPORTED');
  expect(jobRigScreenRoute(display, [...asks, {...signoff, status: 'answered'}], ids)).toBe(true);
  expect(jobRigScreenRoute(display, [...asks, {...signoff, publicationId: 'other'}], ids)).toBe(true);
  const interview = {...signoff, subject: {kind: 'interview-picks', questionId: 'q', setId: 's'}} as unknown as PendingAskV3;
  expect(jobRigScreenRoute(display, [interview], ids)).toBe(false);
  expect(jobRigScreenRefusal(display, [interview], ids)).toBe('JOB_ASK_UNSUPPORTED');
  for (const subject of [{kind: 'parts-verdict', draftId: 'd'}, {kind: 'reopen', stage: 'rig-review'},
    {kind: 'review-verdict', stage: 'direction-review'}, {kind: 'review-verdict', stage: 'image-review'},
    {kind: 'checkpoint', checkpointId: 'undeclared'}]) {
    expect(jobRigScreenRoute(display, [...asks, {...signoff, subject} as PendingAskV3], ids)).toBe(false);
  }
  const recordSource = {record: {path: 'project.json', sha256: 'a'.repeat(64)}, subject: 'plan', plan: {steps: [{id: 'step-one', hash: '1'.repeat(64)}]},
    subjects: [{kind: 'checkpoint', checkpointId: 'step-one'}, {kind: 'signoff', stage: 'plan-approved'}, {kind: 'reopen', stage: 'plan-approved'}]};
  const recordDisplay = {publication: {...publication, source: recordSource}} as unknown as DisplayPublicationV3;
  // #1229: checkpoint asks no longer mount a record form, while interview-picks still does.
  expect(jobRigScreenAsk(recordDisplay, {...checkpoint, source: recordSource as never} as unknown as PendingAskV3, ids)).toBe(false);
  expect(jobRigScreenAsk(recordDisplay, {...signoff, source: recordSource as never} as unknown as PendingAskV3, ids)).toBe(false);
  expect(jobRigScreenAsk(recordDisplay, {...interview, source: recordSource as never} as unknown as PendingAskV3, ids)).toBe(false);
  expect(jobRigScreenAsk(recordDisplay, {...signoff, source: recordSource as never, subject: {kind: 'reopen', stage: 'plan-approved'}} as unknown as PendingAskV3, ids)).toBe(false);
  const draft = {...publication, source: {...publication.source, selector: {kind: 'draft', id: 'd'}}};
  expect(jobRigScreenRoute({publication: draft} as unknown as DisplayPublicationV3, [], ids)).toBe(false);
});

test('#709 and #1229 pending decisions and retired checkpoint outcomes are never sent; only the verdict decision is emitted', async () => {
  const f = await fixture(), publication = await f.publish();
  const verdict = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const checkpoint = seedHistoricalCheckpointAsk(f.session, publication.publicationId, {kind: 'checkpoint', checkpointId: 'step-one'});
  const asks = [verdict, checkpoint] as unknown as PendingAskV3[];
  expect(jobRigScreenDecisions(session({}), asks, publication.publicationId)).toEqual([]);
  expect(jobRigScreenDecisions(session({checkpoints: {'step-one': {outcome: 'pending', note: 'x'}}}), asks, publication.publicationId)).toEqual([]);
  expect(jobRigScreenDecisions(session({checkpoints: {'step-one': {outcome: 'fail', note: 'x'}}}), asks, publication.publicationId)).toEqual([]);
  const decided = jobRigScreenDecisions(session({status: 'changes-requested', feedback: [feedback],
    checkpoints: {'step-one': {outcome: 'fail', note: ' '}}}), asks, publication.publicationId);
  expect(decided.map(item => item.kind)).toEqual(['review-verdict']);
  expect(decided[0]!.value).toEqual({stage: 'rig-review', verdict: 'changes-requested',
    words: '[["slot","sleeve",3,5,null]]\nSleeve tears at the elbow\nduring the swing', feedback: [feedback]});
  expect(jobRigScreenDecisions(session({status: 'approved'}), asks, 'other-publication')).toEqual([]);
});

test('#746 the rig screen keeps act@6 and structured feedback instead of a general words projection', async () => {
  const f = await fixture(), publication = await f.publish();
  const rows = [{...feedback, summary: 'Sleeve tears at the elbow'}];
  const note = projectComments(feedbackItemComments(rows));
  async function commit(askId: string, value: unknown, submissionId: string) {
    const ask = f.session.status().pending.find(item => item.askId === askId)!, page = await f.display(publication);
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId, expectedGeneration: f.session.status().generation,
      submissionId, kind: 'review-verdict', value, capture: rigStillCapture(publication, ask as never, page).capture}));
    if (!result.ok) throw new Error(result.error.code);
    return result.value as unknown as {actId: string; askId: string; at: string};
  }
  const today = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  // The job window's value shape `{stage, verdict, words}`, carrying the same words.
  const before = await commit(today.askId, {stage: 'rig-review', verdict: 'approved', words: note}, 'today');
  const after = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const [decision] = jobRigScreenDecisions(session({status: 'approved', feedback: rows}),
    f.session.status().pending as unknown as PendingAskV3[], publication.publicationId);
  expect(decision!.ask.askId).toBe(after.askId);
  expect(decision!.value.words).toBe(note);
  const screen = await commit(after.askId, decision!.value, 'screen');
  expect(parseCommentsAct(screen)).toMatchObject({schema: 'rig-review/act@6', kind: 'review-verdict',
    value: {comments: feedbackItemComments(rows)}});
  expect(projectComments(parseCommentsAct(screen).value.comments)).toBe(note);
  expect(parseCommentsAct(before).value.comments).toEqual([{text: note}]);
  expect(actBytes(screen)).not.toBe(actBytes(before));
});

// #1229: checkpoint decisions are retired from jobRigScreenDecisions; historical act@6 checkpoint acts still preserve projected words.
test('#709 and #1229 historical act@6 checkpoint acts preserve projected words while fresh submissions refuse', async () => {
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  const note = projectComments(checkpointNoteComments({checkpointId: 'step-one', planStepId: 'step-one', note: 'Elbow seam opens'}));
  expect(note).toBe('[["checkpoint","step-one"]]\nElbow seam opens');
  const stored = seedHistoricalCheckpointAct(f.session, {...page, expectedGeneration: f.session.status().generation,
    submissionId: 'historical-709', checkpointId: 'step-one', value: {checkpointId: 'step-one', outcome: 'pass', words: note}});
  expect(parseCommentsAct(stored)).toMatchObject({schema: 'rig-review/act@6', kind: 'checkpoint',
    value: {checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass'}});
});

test('#709 for the same comments[], words equal the job-host projectComments byte for byte; zero comments write empty words', () => {
  const ask = (askId: string, subject: unknown) => ({askId, publicationId: 'p', status: 'pending', subject, source: {}}) as unknown as PendingAskV3;
  const item = (id: string, summary: string): Feedback => ({...feedback, id, summary});
  for (const rows of [[], [item('a', 'one line')], [item('a', '  lead and trail  \n'), item('b', '원문 그대로\t둘째 줄')]]) {
    const [decision] = jobRigScreenDecisions(session({status: 'approved', feedback: rows}), [ask('v', {kind: 'review-verdict', stage: 'rig-review'})], 'p');
    expect(decision!.value.words).toBe(projectComments(feedbackItemComments(rows)));
  }
  for (const note of ['', ' \n\t', 'Elbow seam opens', '  keep\nspacing  ']) {
    const comments = note.trim() ? checkpointNoteComments({checkpointId: 'step-one', planStepId: 'step-one', note}) : [];
    expect(projectComments(comments)).toBe(note.trim() ? `[["checkpoint","step-one"]]\n${note}` : '');
  }
  expect(projectComments([])).toBe('');
});

test('#709 act@6 accepts comments [] for a rig verdict and a checkpoint, and refuses a whitespace-only comment as JOB_ACT_INVALID', () => {
  const at3 = JSON.parse(legacy.records['@3'].raw), at2 = JSON.parse(legacy.records['@2'].raw);
  const acts = [{...at3, schema: 'rig-review/act@6', value: {stage: 'rig-review', verdict: 'approved', comments: []}},
    {...at2, schema: 'rig-review/act@6', value: {checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass', comments: []}}];
  for (const act of acts) {
    expect(projectComments(parseCommentsAct(act).value.comments)).toBe('');
    expect(() => parseCommentsAct({...act, value: {...act.value, comments: [{text: ' '}]}})).toThrow('JOB_ACT_INVALID');
  }
});

test('#709 the rig screen still does not depend on the mesh or bone overlay toggles', async () => {
  // The still is rendered from the posed model with tool overlays excluded (docs/REVIEW_PACKAGE.md, "Rig verdict
  // still backend"); mesh edges and bone points are overlays, so they no longer make the whole rig ineligible.
  const main = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const stage = main.slice(main.indexOf('function hostStage():RigHostStage|null {'), main.indexOf('/** Old feedback bookmarks keep'));
  expect(stage).toContain('wholeRig:!rigDifference&&!parts?.value()&&player.slots===null&&layers.images,');
  expect(stage).not.toContain('layers.mesh');
  expect(stage).not.toContain('layers.bones');
});

// Model verdicts belong to the shared screen; the job window owns neither form.
test('#709 job-window rig verdict mount and capture path are deleted, not hidden by a test override', async () => {
  const source = await Bun.file(new URL('../web/job-session.ts', import.meta.url)).text();
  const form = source.slice(source.indexOf('    function formFor('), source.indexOf('    function updateForms('));
  expect(form).not.toContain("else if (subject.kind === 'review-verdict' && subject.stage === 'direction-review')");
  expect(source).not.toContain('data-job-direction');
  expect(source).not.toContain('direction.dataset.jobDirection');
  expect(form).not.toContain("else if (subject.kind === 'review-verdict')");
  expect(form).not.toContain('rigSubmission');
  expect(form).not.toContain('image-note-');
  expect(source).not.toContain('copyRigVerdict');
  expect(source).not.toContain('createJobRigSubmission');
  expect(source).not.toContain('freezeJobRigCapture');
  expect(source).not.toContain('copyJobRigViewport');
  const controls = await Bun.file(new URL('./job-window.test.ts', import.meta.url)).text();
  expect(controls).not.toContain('legacy' + 'RigForm');
  expect(form).not.toContain("subject.kind === 'reopen'");
  expect(source).not.toContain('job.reopen');
  const rigScreenSource = await Bun.file(new URL('../web/job-rig-screen.ts', import.meta.url)).text();
  expect(rigScreenSource).not.toContain('reopen');
  const mainSource = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  expect(mainSource).not.toContain('Review the reopened stage.');
  const actSource = await Bun.file(new URL('../src/job-act.ts', import.meta.url)).text();
  expect(actSource.match(/reopen/g)).toEqual(['reopen']);
  expect(form).not.toContain("subject.kind === 'signoff'");
  expect(source).not.toContain('data-direction-signoff');
  expect(source).not.toContain('job.signoff');
  expect(rigScreenSource).not.toContain('signoff');
  expect(mainSource).not.toContain('Approve this stage.');
  expect(mainSource).not.toContain('Approve…');
  expect(mainSource).not.toContain('Approve\\u2026');
  expect(form).not.toContain("subject.kind === 'interview-picks'");
  expect(source).not.toContain('interview.' + 'save');
  expect(source).not.toContain('interview.' + 'submitAnswered');
  expect(source).not.toContain('joined' + 'InterviewForms');
  expect(rigScreenSource).not.toContain('interview-picks');
  expect(mainSource).not.toContain('Answer' + ' these questions.');
  expect(mainSource).not.toContain('Answer' + '\u2026');
  expect(mainSource).not.toContain('Answer' + '\\u2026');
  expect(mainSource).not.toContain('Answer' + ' saved');
  for (const key of ['Approve\u2026', 'Approve this stage.', 'Sign-off', 'Checkpoint · Sign-off', 'job.signoff',
    'job.signoff.postVersion', 'job.signoff.postVersionAbsent', 'job.signoff.directionVerdict',
    'job.signoff.directionVerdictAbsent', 'job.signoff.directionSummaryAbsent',
    'Review\u2026', 'Review this checkpoint.', 'job.commentsFromWorkspace', 'Checkpoint outcome',
    'Needs changes', 'Pass', '↗ Needs changes', '○ Pending', '✓ Pass', 'job.fail', 'job.saveCheckpoint',
    'Answer' + '\u2026', 'Answer' + ' saved', 'Answer' + ' these questions.', 'interview.' + 'save',
    'interview.' + 'submitAnswered', 'interview.' + 'answered', 'interview.' + 'noteLabel', 'interview.' + 'notePlaceholder']) {
    expect(key in enCatalog).toBe(false);
    expect(key in koCatalog).toBe(false);
  }
  expect(form).not.toContain("subject.kind === 'checkpoint'");
  expect(source).not.toContain('jobCheckpointContext');
  expect(mainSource).not.toContain('Review this checkpoint.');
  expect(mainSource).not.toContain('Review…');
  expect(mainSource).not.toContain('checkpointEntry');
  expect(mainSource).not.toContain('job-record-asks');
  expect(mainSource).not.toContain('workspace-pending-record-ask');
});

test('#756 and #1229 package legacy checkpoint ask requires the same-source plan mapping to stay on the rig route',async()=>{
 const f=await fixture(),publication=await f.publish(),checkpoint=seedHistoricalCheckpointAsk(f.session,publication.publicationId,{kind:'checkpoint',checkpointId:'step-one'});
 const display={publication} as unknown as DisplayPublicationV3,ask=checkpoint as unknown as PendingAskV3;
 expect(jobRigScreenRoute(display,[ask],new Set())).toBe(true);
 const alias={...ask,subject:{kind:'checkpoint' as const,checkpointId:'not-a-manifest-checkpoint',planStepId:'step-one'}};
 expect(jobRigScreenRoute(display,[alias],new Set())).toBe(true);
 expect(jobRigScreenRoute(display,[{...alias,subject:{...alias.subject,planStepId:'missing'}}],new Set())).toBe(false);
 expect(jobRigScreenRoute(display,[{...alias,source:{...alias.source,sourceHash:'f'.repeat(64)}}],new Set())).toBe(false);
 expect(jobRigScreenRoute(display,[{...alias,source:{...alias.source,plan:null} as PendingAskV3['source']}],new Set())).toBe(false);
});


test('#773 direction publications use the shared rig screen and act bar with ordered comment projection', async () => {
  const f = await fixture(), publication = await f.publish();
  const source = {...publication.source, selector: {kind: 'post', version: 2, rigVersion: 1},
    direction: {path: 'direction.json', sha256: 'd'.repeat(64)}};
  const display = {publication: {...publication, source}} as unknown as DisplayPublicationV3;
  const ask = {askId: 'direction', publicationId: publication.publicationId, status: 'pending', source,
    subject: {kind: 'review-verdict', stage: 'direction-review'}} as unknown as PendingAskV3;
  expect(jobRigScreenSubject(display.publication.source)).toBe(true);
  expect(jobRigScreenSubject({...source,selector:{kind:'rig',version:1}} as unknown as DisplayPublicationV3['publication']['source'])).toBe(false);
  expect(jobRigScreenSubject({...source,direction:null} as unknown as DisplayPublicationV3['publication']['source'])).toBe(false);
  expect(jobRigScreenRoute(display, [ask], new Set())).toBe(true);
  expect(jobRigScreenRoute(display, [{...ask, subject: {kind:'review-verdict',stage:'rig-review'}}], new Set())).toBe(false);
  const rows = [feedback, {...feedback, id: 'two', summary: 'Keep original framing'}];
  expect(jobRigScreenDecisions(session({status:'changes-requested',feedback:rows}), [ask], publication.publicationId)[0]?.value)
    .toEqual({stage:'direction-review',verdict:'changes-requested',words:projectComments(feedbackItemComments(rows))});
  expect(jobRigScreenDecisions(session({status:'approved'}), [ask], publication.publicationId)[0]?.value)
    .toEqual({stage:'direction-review',verdict:'approved',words:''});
  expect(jobRigScreenDecisions(session({}), [ask], publication.publicationId)).toEqual([]);
  const main = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  expect(main).toContain('directionPanel.show(!!data.direction)');
});

// #1229: model-less package publications still open with no ask, while checkpoint asks no longer mount a form.
test('#784 and #1229 model-less package opens cleanly without asks while checkpoint asks mount no form',async()=>{
 const f=await fixture(),publication=await f.publish();
 const source={...publication.source,model:null,selector:null},display={publication:{...publication,source}} as unknown as DisplayPublicationV3;
 const ask={askId:'reference-check',publicationId:publication.publicationId,status:'pending',source,subject:{kind:'checkpoint',checkpointId:'photo-check',planStepId:'step-one'}} as PendingAskV3;
 expect(jobRigScreenAsk(display,ask,new Set(['photo-check']))).toBe(false);
 expect(jobRigScreenRoute(display,[ask],new Set(['photo-check']))).toBe(false);
 expect(jobRigScreenRefusal(display,[ask],new Set(['photo-check']),true)).toBe('JOB_ASK_UNSUPPORTED');
 expect(jobRigScreenRefusal(display,[],new Set(),true)).toBeNull();
 const invalid={...ask,subject:{...ask.subject,planStepId:'missing'}} as PendingAskV3;
 expect(jobRigScreenAsk(display,invalid,new Set(['photo-check']))).toBe(false);
 expect(jobRigScreenRoute(display,[invalid],new Set(['photo-check']))).toBe(false);
 expect(jobRigScreenRoute(display,[{...ask,subject:{kind:'review-verdict',stage:'rig-review'}} as PendingAskV3],new Set())).toBe(false);
});

test('#1136 direction save hands the host ordered native comments from the shared draft', async () => {
  const main = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const rows = [feedback, {id: 'general', summary: '  전체 timing '}, {...feedback, id: 'two', summary: 'Later pose'}];
  const start = main.indexOf("  button('save').onclick = async () => {");
  const end = main.indexOf('    try { const saved = await api<ReviewSession>', start);
  const mapStart = main.indexOf('function recordJobComments('), mapEnd = main.indexOf('function projectRecordComments(', mapStart);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(mapStart).toBeGreaterThanOrEqual(0);
  expect(mapEnd).toBeGreaterThan(mapStart);
  const source = main.slice(mapStart, mapEnd) + main.slice(start, end) + '};';
  const code = new Bun.Transpiler({loader: 'ts'}).transformSync(source);
  const args: unknown[][] = [], save = {onclick: async () => {}};
  const scope = {button: () => save, readOnly: false, draftConflict: false, saving: false,
    session: {...session({status: 'changes-requested'}), feedbackWarnings: []},
    updateSavedState() {}, recordComments: rows, feedbackItemComments,
    recordCommentWords: () => 'legacy scalar', host: {direction: {}, submit: async (...input: unknown[]) => {args.push(input); return '';}}};
  new Function('scope', `with(scope){${code}}`)(scope);
  await save.onclick();
  expect(args).toHaveLength(1);
  expect(args[0]![2]).toEqual([...feedbackItemComments([feedback]), {text: '  전체 timing '},
    ...feedbackItemComments([rows[2] as Feedback])]);
});

test('#1136 transport sends direction comments in order and retains the omitted-argument words path', async () => {
  const source = await Bun.file(new URL('../web/job-rig-screen.ts', import.meta.url)).text();
  const start = source.indexOf('  async function submit(session:'), end = source.indexOf('  const partsAttempts=', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const code = new Bun.Transpiler({loader: 'ts'}).transformSync(source.slice(start, end));
  const ask = {askId: 'direction-ask', publicationId: 'publication', status: 'pending',
    subject: {kind: 'review-verdict', stage: 'direction-review'}};
  const sent: JobUISubmission[] = [];
  const scope = {mounted: {display: {publication: {publicationId: ask.publicationId}}}, attempts: new Map(),
    jobRigScreenRefusal: () => null, jobRigScreenDecisions, createJobRigSubmission: () => ({}),
    options: {access: {capability: 'owner'}, pageId: 'page', translate: (key: string) => key,
      window: {state: () => ({receipt: {displayedNonce: 'nonce'}, pending: [ask], generation: 2}),
        submit: async (input: JobUISubmission) => {sent.push(input); return {ok: true, value: {kind: input.kind, at: 'time'}};}}}};
  const submit = new Function('scope', `with(scope){${code};return submit;}`)(scope);
  const review = session({status: 'changes-requested', feedback: [feedback]});
  const comments = [{text: 'First general'}, ...feedbackItemComments([feedback]), {text: 'Final general'}];
  await submit(review, () => {}, comments);
  await submit(review, () => {}, []);
  await submit(review, () => {});
  const decision = {stage: 'direction-review', verdict: 'changes-requested'} as const;
  expect(sent.map(input => input.value)).toEqual([
    {...decision, comments}, {...decision, comments: []}, {...decision, words: projectComments(feedbackItemComments([feedback]))},
  ]);
});

test('#798 direction comments restore cannot override the inspection draft verdict', async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const start=main.indexOf('function restoreRecordComments('),end=main.indexOf('/** Comments remain native rows',start);
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(start,end));
 const selector={value:'changes-requested'},saved={publicationId:'publication',sourceHash:'source',status:'approved',comments:[{id:'general',summary:'Inspect the timing'}]};
 const scope={host:{direction:{publicationId:'publication',sourceHash:'source'}},recordCommentKey:'',recordComments:[] as {id:string;summary:string}[],session:{status:'changes-requested'},localStorage:{getItem:()=>JSON.stringify(saved)},select:()=>selector,projectComments};
 new Function('scope',`with(scope){${code};restoreRecordComments();}`)(scope);
 expect(scope.recordComments).toEqual(saved.comments);
 expect(selector.value).toBe('changes-requested');expect(scope.session.status).toBe('changes-requested');
 const restore=main.slice(main.indexOf('async function setupPersistence(')).match(/restoreSession:\(value,isDirty\)=>\{([\s\S]*?)\},bookmark:/)![1]!;
 const applyScope={session:{status:'pending'},dirty:false,select:()=>selector,renderProposals(){},renderCheckpoint(){},renderCheckpoints(){},renderProvenance(){},updateSavedState(){}};
 new Function('scope','value','isDirty',`with(scope){${restore}}`)(applyScope,{status:'changes-requested'},true);
 expect(applyScope.session.status).toBe('changes-requested');expect(selector.value).toBe(applyScope.session.status);
});

test('#798 and #1143 direction keep Comments and gate the angle tool while preserving the rig inspector',async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const start=main.indexOf('function showRecordComments('),end=main.indexOf('/** Publications without a picture',start);
 expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(start,end));
 for(const [preserveInspector,axisDisabled] of [[true,true],[true,false],[false,true]]){
  const correction={id:'correction-controls',hidden:false},evidence={id:'proposal-list',hidden:false},comments={id:'comments-list-host',hidden:false};
  const panel={children:[] as {hidden:boolean;classList:{contains(value:string):boolean}}[],style:{display:'none'}},collapse={disabled:true};
  const angle={hidden:false,disabled:false,title:'','aria-description':''};
  const axisState={textContent:axisDisabled?'No inspection axes supplied':'1 axes'};
  const elements={
   'axis-state':axisState,'proposal-panel':{children:[correction,evidence,comments]},
   'motion-tools':{querySelector:(selector:string)=>{expect(selector).toBe('[data-proposal="angle"]');return angle;}},
  };
  const scope={el:(id:keyof typeof elements)=>elements[id],
   rigInspector:{comments:{panel},collapse},input:(id:string)=>{expect(id).toBe('axis-value');return {disabled:axisDisabled};},
   sourceTextContent:(node:typeof axisState)=>node.textContent,
   setSourceAttribute(node:typeof angle,attribute:'title'|'aria-description',value:string){node[attribute]=value;}};
  new Function('scope','preserveInspector',`with(scope){${code};showRecordComments(preserveInspector);}`)(scope,preserveInspector);
  expect(correction.hidden).toBe(true);expect(evidence.hidden).toBe(true);expect(comments.hidden).toBe(false);
  expect(angle.hidden).toBe(false);expect(angle.disabled).toBe(preserveInspector&&axisDisabled);
  const reason=preserveInspector&&axisDisabled?axisState.textContent:'';
  expect(angle.title).toBe(reason);expect(angle['aria-description']).toBe(reason);
  expect(panel.style.display).toBe(preserveInspector?'none':'block');expect(collapse.disabled).toBe(preserveInspector);
 }
 expect(main).toContain('if(host?.direction)showRecordComments(true);else if(host?.record&&!data.manifest.model)showRecordComments();');
});

test('#1143 the angle tool follows current axis availability and opens Playback',async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const bindStart=main.indexOf('  const angleTool = ',main.indexOf('function bind()'));
 const bindEnd=main.indexOf("  select('reference-select').onchange",bindStart);
 expect(bindStart).toBeGreaterThanOrEqual(0);expect(bindEnd).toBeGreaterThan(bindStart);
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(bindStart,bindEnd));
 const calls:string[]=[],axis={disabled:true},angle={onclick:()=>{throw Error('missing angle binding');}};
 const scope={
  el:(id:string)=>{expect(id).toBe('motion-tools');return {querySelector:(selector:string)=>{expect(selector).toBe('[data-proposal="angle"]');return angle;}};},
  input:(id:string)=>{expect(id).toBe('axis-value');return axis;},
  showInspector:(mode:string)=>calls.push(mode),chooseAxis:()=>calls.push('axis'),
 };
 new Function('scope',`with(scope){${code}}`)(scope);
 angle.onclick();expect(calls).toEqual([]);
 axis.disabled=false;angle.onclick();expect(calls.splice(0)).toEqual(['playback','axis']);
 axis.disabled=true;angle.onclick();expect(calls).toEqual([]);
});

test('#992 record and verdict comment drafts survive reload, same-source republish, two-tab merge/delete, legacy fallback, and report changed-source drops',async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const start=main.indexOf('function restoreRecordComments('),end=main.indexOf('function recordCommentsChanged(',start);
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(start,end));
 const store=new Map<string,string>();
 const listeners=new Set<(event:{key:string|null;newValue:string|null})=>void>();
 const storage={
  get length(){return store.size;},
  key:(index:number)=>[...store.keys()][index]??null,
  getItem:(key:string)=>store.get(key)??null,
  setItem:(key:string,value:string,sender?:unknown)=>{
   store.set(key,value);
   for(const fn of listeners)if((fn as {owner?:unknown}).owner!==sender)fn({key,newValue:value});
  },
  removeItem:(key:string,sender?:unknown)=>{
   store.delete(key);
   for(const fn of listeners)if((fn as {owner?:unknown}).owner!==sender)fn({key,newValue:null});
  },
 };
 const makeTab=(binding:{jobId?:string;draftId?:string;publicationId:string;previousPublicationId?:string;sourceHash:string},verdict=false)=>{
  const rows:{id:string;summary:string}[]=[],notices:{text:string;error:boolean}[]=[];
  let storageHandler:((event:{key:string|null;newValue:string|null})=>void)|null=null;
  const tabWindow={
   addEventListener:(type:string,fn:(event:{key:string|null;newValue:string|null})=>void)=>{
    if(type==='storage'){(fn as {owner?:unknown}).owner=tabWindow;storageHandler=fn;listeners.add(fn);}
   },
  };
  const tabStorage={
   get length(){return storage.length;},
   key:storage.key,
   getItem:storage.getItem,
   setItem:(k:string,v:string)=>storage.setItem(k,v,tabWindow),
   removeItem:(k:string)=>storage.removeItem(k,tabWindow),
  };
  const scope={
   host:verdict?{verdictComments:{...binding,rows,available:()=>true}}:{record:{...binding,label:'Draft d1',hasPicture:false}},
   access:{base:`/jobs/${binding.jobId??'job-1'}/publications/${binding.publicationId}/instances/${'a'.repeat(64)}/`},
   recordCommentKey:'',
   recordComments:rows,
   draftStatus:null as string|null,
   localStorage:tabStorage,
   window:tabWindow,
   select:()=>({value:'pending'}),
   projectComments,
   renderDraftState(){},
   message:(text:string,error=false)=>{notices.push({text,error});},
   comments:{refresh(){}},
   partsSubject:null,
   rigInspector:{comments:{button:{}}},
   recordPanel:{querySelector:()=>null},
   setSourceText(){},
   renderAnswerControls(){},
   renderProposals(){},
  };
  const api=new Function('scope',`with(scope){${code};return {restore:()=>restoreRecordComments(),persist:()=>persistRecordComments()};}`)(scope) as {restore():void;persist():void};
  api.restore();
  return {scope,rows,notices,persist:api.persist,deliverStorage:(event:{key:string|null;newValue:string|null})=>storageHandler?.(event)};
 };

 // Bar 1 (Reload) & Bar 2 (Republish, same job, draft and source hash)
 const tab1=makeTab({jobId:'job-1',draftId:'d1',publicationId:'pub-1',sourceHash:'a'.repeat(64)});
 tab1.rows.push({id:'c1',summary:'First judgment'},{id:'c2',summary:'Second judgment'});
 tab1.persist();
 const reloaded=makeTab({jobId:'job-1',draftId:'d1',publicationId:'pub-1',sourceHash:'a'.repeat(64)});
 expect(reloaded.rows.map(r=>r.id)).toEqual(['c1','c2']);
 const republished=makeTab({jobId:'job-1',draftId:'d1',publicationId:'pub-2',sourceHash:'a'.repeat(64)});
 expect(republished.rows.map(r=>r.id)).toEqual(['c1','c2']);

 // Bar 3 (Republish with a changed source hash: not shown as current, old rows stay in storage, notice path hit)
 const changedSource=makeTab({jobId:'job-1',draftId:'d1',publicationId:'pub-3',sourceHash:'b'.repeat(64)});
 expect(changedSource.rows).toEqual([]);
 expect([...store.values()].some(raw=>raw.includes('First judgment')&&raw.includes('Second judgment'))).toBe(true);
 const carryKey='The source changed, so {0} unsent comment(s) could not be carried over. Please add them again.';
 const expectedEn=enCatalog[carryKey]!.replace('{0}','2');
 const expectedKo=koCatalog[carryKey]!.replace('{0}','2');
 expect(changedSource.scope.draftStatus).toBe(expectedEn);
 expect(tr(changedSource.scope.draftStatus!,'en')).toBe(expectedEn);
 expect(tr(changedSource.scope.draftStatus!,'ko')).toBe(expectedKo);
 expect(changedSource.scope.draftStatus).not.toContain('Saved local draft was not restored');

 // Bar 4 (Two tabs: tab A adds c1, tab B adds c2, both survive in both tabs and after reload; removal in A does not come back from B)
 const tabA=makeTab({jobId:'job-1',draftId:'d2',publicationId:'pub-4',sourceHash:'c'.repeat(64)});
 const tabB=makeTab({jobId:'job-1',draftId:'d2',publicationId:'pub-4',sourceHash:'c'.repeat(64)});
 tabA.rows.push({id:'c1',summary:'From tab A'});
 tabA.persist();
 tabB.rows.push({id:'c2',summary:'From tab B'});
 tabB.persist();
 expect(tabA.rows.map(r=>r.id)).toEqual(['c1','c2']);
 expect(tabB.rows.map(r=>r.id)).toEqual(['c1','c2']);
 const reloadBoth=makeTab({jobId:'job-1',draftId:'d2',publicationId:'pub-4',sourceHash:'c'.repeat(64)});
 expect(reloadBoth.rows.map(r=>r.id)).toEqual(['c1','c2']);
 // Remove c1 in tab A; it must not come back from tab B
 tabA.rows.splice(0,1);
 tabA.persist();
 expect(tabA.rows.map(r=>r.id)).toEqual(['c2']);
 expect(tabB.rows.map(r=>r.id)).toEqual(['c2']);
 tabB.persist();
 const reloadAfterDelete=makeTab({jobId:'job-1',draftId:'d2',publicationId:'pub-4',sourceHash:'c'.repeat(64)});
 expect(reloadAfterDelete.rows.map(r=>r.id)).toEqual(['c2']);

 // Bar 4b (Late/stale storage event from Tab A arrives after Tab B writes c2: both c1 and c2 survive)
 const lateA=makeTab({jobId:'job-1',draftId:'d2-late',publicationId:'pub-4b',sourceHash:'c'.repeat(64)});
 const lateB=makeTab({jobId:'job-1',draftId:'d2-late',publicationId:'pub-4b',sourceHash:'c'.repeat(64)});
 lateA.rows.push({id:'c1',summary:'From tab A'});
 const stalePayload=JSON.stringify({status:'pending',publicationId:'pub-4b',sourceHash:'c'.repeat(64),comments:[{id:'c1',summary:'From tab A'}]});
 store.set(lateA.scope.recordCommentKey,stalePayload);
 lateB.rows.push({id:'c2',summary:'From tab B'});
 lateB.persist();
 expect(lateB.rows.map(r=>r.id)).toEqual(['c1','c2']);
 // Control (c9e6a46): parsing event.newValue directly replaced B's [c1,c2] with [c1]
 expect(JSON.parse(stalePayload).comments.map((r:{id:string})=>r.id)).toEqual(['c1']);
 lateB.deliverStorage({key:lateB.scope.recordCommentKey,newValue:stalePayload});
 expect(lateB.rows.map(r=>r.id)).toEqual(['c1','c2']);

 // Bar 5 & 5b (Existing per-publication drafts restore via fallback/previousPublicationId, retire legacy key, and deleting all + reload stays 0 rows)
 for(const [verdict,usePrevious]of [[false,false],[true,false],[false,true],[true,true]] as const){
  const prefix=verdict?'rig-review-verdict-comments/1:':'rig-review-record-comments/1:';
  const hash=(verdict?'e':'d').repeat(64);
  const legacyPub=usePrevious?'pub-prev-legacy':'pub-legacy';
  const legacyKey=`${prefix}${legacyPub}:${hash}`;
  const draftId=`d3-${verdict?'verdict':'record'}-${usePrevious?'prev':'cur'}`;
  // Control (c9e6a46): if legacyKey was not retired and primary was removed when empty, reload resurrected legacy-1
  store.set(legacyKey,JSON.stringify({
   status:'pending',publicationId:legacyPub,sourceHash:hash,comments:[{id:'legacy-1',summary:'Legacy per-publication comment'}],
  }));
  const fallbackTab=makeTab({jobId:'job-1',draftId,publicationId:'pub-legacy',...(usePrevious?{previousPublicationId:legacyPub}:{}),sourceHash:hash},verdict);
  expect(fallbackTab.rows).toEqual([{id:'legacy-1',summary:'Legacy per-publication comment'}]);
  expect(store.has(legacyKey)).toBe(false);
  fallbackTab.rows.splice(0,fallbackTab.rows.length);
  fallbackTab.persist();
  const reloadedAfterDelete=makeTab({jobId:'job-1',draftId,publicationId:'pub-legacy',...(usePrevious?{previousPublicationId:legacyPub}:{}),sourceHash:hash},verdict);
  expect(reloadedAfterDelete.rows).toEqual([]);
 }
});

test('#999 assembled box-pin comments clamp to intersecting bound parts, commit pending composer drafts on Request changes, and fail on da67304 control',()=>{
 const items=new Map([
  ['handwear_l',{name:'handwear_l',x:1165,y:292,w:755,h:274,imageHash:'a'.repeat(64)}],
  ['objects',{name:'objects',x:1274,y:353,w:646,h:727,imageHash:'b'.repeat(64)}],
 ]);
 const sourceHash='c'.repeat(64);
 // Reviewer draws a box over the sword grip (objects, y:353..1080) starting slightly above y=353 in empty canvas margin (y=315..520, x=1700..1920)
 const rawDrag=snapImageRegion({x:1700,y:315,width:220,height:205});
 const baseIssue={
  schema:'rig-review-parts-comment/2' as const,
  id:'box-pin-1',
  summary:'Sword grip must go behind the left hand',
  sourceHash,
  parts:[{name:'objects',imageHash:'b'.repeat(64)}],
  imageRegion:null,
  view:{
   mode:'assembled' as const,
   camera:{zoom:1,center:{x:960,y:540},viewport:{width:1200,height:800}},
   cameraSync:true,
   referenceCamera:null,
   background:'checker',
   alpha:false,
   footprints:false,
   mesh:false,
   comparison:{mode:'part' as const,opacity:0.5},
   visibleLayers:[
    {name:'handwear_l',imageHash:'a'.repeat(64)},
    {name:'objects',imageHash:'b'.repeat(64)},
   ],
  },
  crop:{path:`comment-crops/${'d'.repeat(64)}.png`,sha256:'d'.repeat(64),width:220,height:205},
  nativeCrop:null,
 };
 // Control (da67304 / a41db7f): unclipped assembled drag region exceeds objects bounding box (y=315 < 353) and refuses save
 expect(()=>{
  const unclipped=parsePartsIssue({...baseIssue,rigRegion:rawDrag},false,false,false);
  assertPartsIssueBinding(unclipped,items,sourceHash);
 }).toThrow('PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds union of issue parts');

 // Fixed path: intersecting union bounds of selected parts clamp the drag region to [1700..1920, 353..520]
 const target=items.get('objects')!;
 const clamped=snapImageRegion({
  x:Math.max(target.x,rawDrag.x),
  y:Math.max(target.y,rawDrag.y),
  width:Math.min(target.x+target.w,rawDrag.x+rawDrag.width)-Math.max(target.x,rawDrag.x),
  height:Math.min(target.y+target.h,rawDrag.y+rawDrag.height)-Math.max(target.y,rawDrag.y),
 });
 expect(clamped).toEqual({x:1700,y:353,width:220,height:167});
 const bound=parsePartsIssue({...baseIssue,rigRegion:clamped},false,false,false);
 expect(()=>assertPartsIssueBinding(bound,items,sourceHash)).not.toThrow();

 // Refusal copy maps to existing catalog sentences in EN and KO
 expect(tr('PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds original image','en')).toBe(enCatalog['PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds original image']);
 expect(tr('PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds original image','ko')).toBe(koCatalog['PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds original image']);
 expect(tr('Select at least one part.','en')).toBe(enCatalog['Select at least one part.']);
 expect(tr('Select at least one part.','ko')).toBe(koCatalog['Select at least one part.']);
});
