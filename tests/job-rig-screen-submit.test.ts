import {expect, test, spyOn} from 'bun:test';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {fixturePublication} from './helpers/job-window-fixture.ts';
import {createJobRigScreen, type JobRigScreenPrepared} from '../web/job-rig-screen.ts';
import {rigHost, setRigHost, type RigHost, type RigHostCommit} from '../web/rig-host.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';
import type {ActV3, DisplayPublicationV3, PendingAskV3, UISubmissionV3} from '../src/job-contract.ts';
import {parseManifest} from '../src/manifest.ts';
import {setLanguagePreference} from '../web/i18n.ts';
import {createJobFront} from '../src/job-front.ts';
import {jobBodyLimit} from '../src/job-api.ts';
import {jobSubmissionRefusal,createJobWindowTransport,jobWindowAccess,jobWindowEvents} from '../web/job-session.ts';

useTemporaryReviewState();
const at = '2026-11-12T00:00:00.000Z';
const comment: Feedback = {id: 'draft', frameStart: 0, frameEnd: 0,
  target: {kind: 'rig', name: 'fixture'}, category: 'defect', summary: 'unsent comment'};
function baseline(): ReviewSession {
  const {source} = fixturePublication().publication;
  return {schema: 'rig-review-session/1', ...source.package, sourceHash: source.sourceHash,
    reviewedSource: {packageRevision: source.package.revision, viewerVersion: 'synthetic', runtimeVersion: 'synthetic', rig: null, motion: null},
    status: 'pending', checkpoints: {}, feedback: [], feedbackWarnings: [], updatedAt: null};
}

/** Execute the actual save handler, submitted-row predicate and saved-state renderer without a browser. */
async function mainSave(session: ReviewSession, submittedBaseline: ReviewSession, host: Pick<RigHost, 'submit'>) {
  const source = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const start = source.indexOf("  button('save').onclick = ");
  const end = source.indexOf('  // Saved browser defaults', start);
  const save = source.slice(start + "  button('save').onclick = ".length, end).trim();
  const stateStart = source.indexOf('function updateSavedState(): void {');
  const stateEnd = source.indexOf('/** C10:', stateStart);
  const lockStart = source.indexOf('function isSubmittedFeedback(');
  const lockEnd = source.indexOf('function renderProposals()', lockStart);
  // Before the fix, the old id-only lock predicate is the one the actual comments host receives.
  const oldLockStart = source.indexOf('locked:', source.indexOf('function setupComments()')) + 'locked:'.length;
  const lock = lockStart < 0 ? 'const isSubmittedFeedback = ' + source.slice(oldLockStart, source.indexOf(',add:', oldLockStart)) + ';' :
    source.slice(lockStart, lockEnd);
  const javascript = new Bun.Transpiler({loader: 'ts'}).transformSync(source.slice(stateStart, stateEnd) + lock + '\nconst save = ' + save);
  return new Function('deps', `
    let {session, submittedBaseline, host, jobSubmissionRefusal} = deps;
    let dirty = true, saving = false, draftConflict = false, readOnly = null, actReadOnly = null;
    const readouts = {}, messages = [], saved = [], saveStates = [];
    const rigInspector = {actBar: {setSaveState: value => saveStates.push(value)}};
    const node = {classList: {toggle() {}}, disabled: false, title: ''};
    const el = () => node, button = el, text = (id, value) => {readouts[id] = value;};
    const errorText = error => error.message, message = value => messages.push(value);
    const comments = {refresh() {}}, persistence = {async submitted(value) {saved.push(structuredClone(value));}};
    function renderProposals() {} function renderDraftState() {} function renderAnswerControls() {}
    ${javascript}
    return {save, locked: isSubmittedFeedback, state: () => ({dirty, saving, session, submittedBaseline, readouts, messages, saved, saveStates, title: node.title})};
  `)({session, submittedBaseline, host, jobSubmissionRefusal}) as {
    save(): Promise<void>; locked(id: string): boolean;
    state(): {dirty: boolean; saving: boolean; session: ReviewSession; submittedBaseline: ReviewSession;
      readouts: Record<string, string>; messages: string[]; saved: ReviewSession[]; title: string; saveStates: {kind: string; text: string; title?: string}[]};
  };
}

for (const code of ['JOB_ACT_NOTHING_TO_SUBMIT', 'JOB_STILL_CAPTURE_FAILED', 'JOB_STILL_BINDING_MISMATCH', 'JOB_BODY_LIMIT'])
for (const language of ['en', 'ko'] as const) test(`#785 ${code} says NOT submitted and preserves unsent state (${language})`, async () => {
  const f = await jobFixture();
  const front = createJobFront({origin: f.origin, ports: f.ports, resource: async () => ''});
  setLanguagePreference(language);
  try {
    const publication = await f.publish(), ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
    const page = await f.display(publication), current = baseline(), original = structuredClone(current);
    current.status = 'approved';
    const app = await mainSave(current, original, {async submit() {
      if (code !== 'JOB_BODY_LIMIT') throw new Error(code);
      const access = jobWindowAccess(f.origin + '/jobs/' + f.session.jobId + '/#cap=' + f.credentials.ui, null, () => {});
      const transport = createJobWindowTransport(access, (async (url, init) => front.fetch(new Request(new URL(String(url), f.origin), {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), Origin: f.origin}}))) as typeof fetch);
      const result = await transport.submit({...page, askId: ask.askId,
        expectedGeneration: f.session.status().generation, submissionId: 'oversized', kind: 'checkpoint',
        value: {checkpointId: 'step-one', outcome: 'pass', words: 'x'.repeat(jobBodyLimit)}});
      expect(result.ok).toBe(false);
      if (result.ok) throw Error('EXPECTED_REFUSAL');
      expect(result.error.code).toBe('JOB_BODY_LIMIT');
      throw new Error(result.error.code, {cause: (result.error as {cause?: unknown}).cause});
    }});
    await app.save();
    const sentence = jobSubmissionRefusal(new Error(code)).text;
    expect(sentence).toContain(language === 'en' ? 'NOT submitted' : '제출되지 않았어요');
    expect(sentence).toContain('—');
    expect(sentence).not.toContain('JOB_');
    expect(app.state().title).toStartWith(code);
    if (code === 'JOB_BODY_LIMIT') {
      expect(app.state().title).toContain('POST /jobs/' + f.session.jobId + '/ui/acts');
      expect(app.state().title).toMatch(/ · \d+ bytes · HTTP 413$/);
    }
    expect(app.state().saveStates.at(-1)).toEqual({kind: 'failed', text: sentence, title: app.state().title});
    expect(app.state().messages.at(-1)).toBe(sentence);
    expect(app.state().readouts.dirty).toBe('Unsubmitted changes');
    expect(app.state().submittedBaseline.updatedAt).toBeNull();
    expect(app.state().saved).toEqual([]);
    expect(f.session.status().pending.map(item => item.askId)).toEqual([ask.askId]);
  } finally {setLanguagePreference('en'); front.stop(); await f.close();}
});

for (const language of ['en', 'ko'] as const) test(`#785 stream refusal retains its client origin (${language})`, async () => {
  setLanguagePreference(language);
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const access = jobWindowAccess('http://127.0.0.1:19484/jobs/stream-fixture/', null, () => {});
    const events = jobWindowEvents(access, null, new AbortController().signal,
      (async () => new Response('x'.repeat(1024 * 1024 + 1))) as unknown as typeof fetch);
    let refusal: unknown;
    try {await events.next();} catch (error) {refusal = error;}
    expect(refusal).toBeInstanceOf(Error);
    const current = baseline(); current.status = 'approved';
    const app = await mainSave(current, baseline(), {async submit() {throw refusal;}});
    await app.save();
    expect(app.state().title).toBe('JOB_BODY_LIMIT · client: event stream');
    expect(app.state().saveStates.at(-1)?.text).toContain(language === 'en' ? 'NOT submitted' : '제출되지 않았어요');
    expect(app.state().saveStates.at(-1)?.text).not.toContain('JOB_');
    expect(app.state().readouts.dirty).toBe('Unsubmitted changes');
    expect(warning).toHaveBeenCalledWith(app.state().title);
  } finally {warning.mockRestore();setLanguagePreference('en');}
});

for (const rigPending of [false, true]) test(`#721 checkpoint commit leaves comments editable (${rigPending ? 'rig pending' : 'checkpoint only'})`, async () => {
  const f = await jobFixture(), originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    const publication = await f.publish();
    await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
    if (rigPending) await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    const page = await f.display(publication), requests: UISubmissionV3[] = [], acts: ActV3[] = [];
    const initial = baseline();
    initial.id = publication.source.package.id; initial.revision = publication.source.package.revision;
    initial.sourceHash = publication.source.sourceHash;
    const display = {publication} as unknown as DisplayPublicationV3;
    const prepared: JobRigScreenPrepared = {jobRigScreen: true, display, entry: 'http://127.0.0.1:4318/retained/',
      review: {manifest: parseManifest({schema: 'rig-review/1', id: initial.id, revision: initial.revision, title: 'Synthetic submission'}),
        reviewedSource: initial.reviewedSource, sourceHash: initial.sourceHash}, checkpoints: new Set(['step-one'])};
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => ({id: ''})}});
    const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
      pageId: page.pageId, access: {capability: 'synthetic-ui', headers: () => new Headers()},
      window: {
        state: () => ({pending: f.session.status().pending as unknown as PendingAskV3[], receipt: page,
          generation: f.session.status().generation, preparing: false, closed: false}),
        async submit(input) {
          requests.push(input);
          const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
          if (result.ok) acts.push(result.value as ActV3);
          return result;
        },
      }, routes: () => ({entry: prepared.entry, api: path => path}), refusal: error => String(error), translate: key => key,
      async load() {rigHost()!.displayed();}});
    screen.commit(prepared);
    await screen.painted(prepared, new AbortController().signal);
    await expect(rigHost()!.read('/api/session','PUT')).rejects.toThrow('JOB_REVIEW_READ_ONLY');
    await expect(rigHost()!.read('/api/unknown','GET')).rejects.toThrow('JOB_REVIEW_READ_ONLY');
    expect(rigHost()!.pendingSubjects?.()).toEqual(f.session.status().pending.filter(ask=>ask.status==='pending').map(ask=>ask.subject));
    const current = structuredClone(initial);
    current.checkpoints['step-one'] = {outcome: 'pass', note: 'checkpoint words'};
    current.feedback.push(structuredClone(comment));
    const app = await mainSave(current, initial, rigHost()!);
    await app.save();
    expect(requests.map(input => input.kind)).toEqual(['checkpoint']);
    expect(app.state().submittedBaseline.checkpoints).toEqual(current.checkpoints);
    expect(app.state().submittedBaseline.feedback).toEqual([]);
    expect(app.state().submittedBaseline.status).toBe('pending');
    expect(app.state().session.updatedAt).toBe(acts[0]!.at);
    expect(app.state().dirty).toBe(true);
    expect(app.state().readouts.dirty).toBe('Unsubmitted changes');
    expect(app.locked(comment.id)).toBe(false);
    expect(app.state().saved.at(-1)?.feedback).toEqual([]);
    current.feedback[0]!.summary = 'still editable';
    expect(app.locked(comment.id)).toBe(false);
  } finally {
    setRigHost(null);
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    await f.close();
  }
});

test('#721 checkpoint-only save is clean when it commits all changed content, ignoring untouched pending rows', async () => {
  const current = baseline(), original = structuredClone(current);
  current.checkpoints = {untouched: {outcome: 'pending', note: ''}, done: {outcome: 'pass', note: 'saved'}};
  const app = await mainSave(current, original, {async submit(snapshot, committed) {
    await committed({at, checkpoints: {done: snapshot.checkpoints.done!}}); return 'job.saved';
  }});
  await app.save();
  expect(app.state().dirty).toBe(false);
  expect(app.state().readouts.dirty).toBe('Submitted');
  expect(app.state().submittedBaseline.checkpoints).toEqual({done: {outcome: 'pass', note: 'saved'}});
});

test('#721 checkpoint save must not submit comments without a verdict or unlock prior committed comments', async () => {
  const original = baseline();
  original.updatedAt = at; original.feedback.push({...comment, id: 'prior', summary: 'already committed'});
  const current = structuredClone(original);
  current.feedback.push(structuredClone(comment)); current.checkpoints.done = {outcome: 'pass', note: 'checkpoint'};
  const app = await mainSave(current, original, {async submit(snapshot, committed) {
    await committed({at, checkpoints: {done: snapshot.checkpoints.done!}}); return 'job.saved';
  }});
  await app.save();
  expect(app.state().submittedBaseline.feedback).toEqual(original.feedback);
  expect(app.state().dirty).toBe(true);
  expect(app.state().readouts.dirty).toBe('Unsubmitted changes');
  expect(app.locked(comment.id)).toBe(false); expect(app.locked('prior')).toBe(true);
});

test('#721 checkpoint edits during submission remain dirty against the actual committed value', async () => {
  const current = baseline(), original = structuredClone(current);
  current.checkpoints.done = {outcome: 'pass', note: 'sent'};
  const app = await mainSave(current, original, {async submit(snapshot, committed) {
    current.checkpoints.done!.note = 'edited while submitting';
    await committed({at, checkpoints: {done: snapshot.checkpoints.done!}}); return 'job.saved';
  }});
  await app.save();
  expect(app.state().submittedBaseline.checkpoints.done!.note).toBe('sent');
  expect(app.state().session.checkpoints.done!.note).toBe('edited while submitting');
  expect(app.state().dirty).toBe(true);
});

test('#721 a later rig failure preserves the checkpoint receipt without submitting or locking comments', async () => {
  const current = baseline(), original = structuredClone(current);
  current.status = 'approved'; current.feedback.push(structuredClone(comment));
  current.checkpoints.done = {outcome: 'pass', note: 'committed checkpoint'};
  const app = await mainSave(current, original, {async submit(snapshot, committed) {
    await committed({at, checkpoints: {done: snapshot.checkpoints.done!}});
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }});
  await app.save();
  expect(app.state().submittedBaseline.checkpoints).toEqual(current.checkpoints);
  expect(app.state().submittedBaseline.status).toBe('pending');
  expect(app.state().submittedBaseline.feedback).toEqual([]);
  expect(app.state().dirty).toBe(true); expect(app.state().saving).toBe(false);
  expect(app.locked(comment.id)).toBe(false);
  expect(app.state().messages.at(-1)).toBe(jobSubmissionRefusal(new Error('JOB_STILL_CAPTURE_FAILED')).text);
});

test('#721 a committed verdict locks only the submitted snapshot, preserving edits and new comments made during submission', async () => {
  const current = baseline(), original = structuredClone(current);
  current.status = 'approved'; current.feedback.push(structuredClone(comment));
  const app = await mainSave(current, original, {async submit(snapshot, committed) {
    current.feedback[0]!.summary = 'edited during submit';
    current.feedback.push({...comment, id: 'new', summary: 'added during submit'});
    await committed({at, review: {status: snapshot.status, feedback: snapshot.feedback}}); return 'job.saved';
  }});
  await app.save();
  expect(app.state().submittedBaseline.feedback).toEqual([comment]);
  expect(app.state().session.feedback.map(row => row.summary)).toEqual(['edited during submit', 'added during submit']);
  expect(app.state().dirty).toBe(true);
  expect(app.locked(comment.id)).toBe(false); expect(app.locked('new')).toBe(false);
});

test('#721 a full committed verdict marks its exact comments submitted while an unasked checkpoint stays dirty', async () => {
  for (const unasked of [false, true]) {
    const current = baseline(), original = structuredClone(current);
    current.status = 'approved'; current.feedback.push(structuredClone(comment));
    if (unasked) current.checkpoints.other = {outcome: 'fail', note: 'not asked'};
    const app = await mainSave(current, original, {async submit(snapshot, committed) {
      const commit: RigHostCommit = {at, review: {status: snapshot.status, feedback: snapshot.feedback}};
      await committed(commit); return 'job.saved';
    }});
    await app.save();
    expect(app.state().dirty).toBe(unasked);
    expect(app.locked(comment.id)).toBe(true);
    expect(app.state().submittedBaseline.checkpoints).toEqual({});
  }
});

for(const failure of ['abort','source-mismatch']as const)test(`#737 parts host preparation preserves active host on ${failure}`,async()=>{
 const originalFetch=globalThis.fetch,activeHost=rigHost(),display=fixturePublication() as unknown as import('../src/job-contract.ts').DisplayPublicationV3;
 const source=display.publication.source;
 Object.assign(source,{selector:{kind:'draft',id:'synthetic-parts'},parts:{manifest:{path:'parts.json',sha256:'a'.repeat(64)},images:[]}});
 const controller=new AbortController();let entered!:()=>void;const requested=new Promise<void>(resolve=>{entered=resolve;}),signals:AbortSignal[]=[];
 const host=createJobRigScreen({host:{}as HTMLElement,pageId:'synthetic-page',access:{capability:null,headers:init=>new Headers(init)},
  window:{state:()=>({pending:[],receipt:null,generation:1,preparing:false,closed:false}),submit:async()=>{throw Error('PREPARE_MUST_NOT_SUBMIT');}},
  routes:()=>({entry:'http://127.0.0.1/synthetic/',api:path=>'http://127.0.0.1/synthetic/'+path}),refusal:String,translate:key=>key,load:async()=>{throw Error('PREPARE_MUST_NOT_MOUNT');}});
 try{
  globalThis.fetch=(async(url,init)=>{
   expect(init?.signal).toBe(controller.signal);signals.push(init!.signal!);
   if(String(url).endsWith('/review'))return Response.json({manifest:{...source.package,checkpoints:[]},reviewedSource:{rig:source.model},sourceHash:source.sourceHash});
   expect(String(url)).toEndWith('/stage-parts');entered();
   if(failure==='source-mismatch')return Response.json({mode:'parts',sourceHash:'f'.repeat(64)});
   return await new Promise<Response>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
  })as typeof fetch;
  const preparation=host.prepare(display,controller.signal);await requested;if(failure==='abort')controller.abort();
  await expect(preparation).rejects.toThrow(failure==='abort'?'aborted':'JOB_DISPLAY_MISMATCH');expect(signals.length).toBe(2);expect(rigHost()).toBe(activeHost);
 }finally{globalThis.fetch=originalFetch;}
});
