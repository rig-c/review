import {expect, test, spyOn} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {RigPlayer} from '@rig-c/play';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {loadSetupAssets, setupRoot} from './helpers/setup-mesh.ts';
import {fixturePublication} from './helpers/job-window-fixture.ts';
import {createJobRigScreen, type JobRigMeshScreen, type JobRigScreenPrepared} from '../web/job-rig-screen.ts';
import {rigHost, setRigHost, type RigHost, type RigHostCommit} from '../web/rig-host.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';
import type {ActV3, DisplayPublicationV3, JobMeshEditValue, PendingAskV3, UISubmissionV3} from '../src/job-contract.ts';
import {jobHash, parseCommentOnlyAct, parseCommentsAct, parseContextCommentsAct, parseMeshEditsAct} from '../src/job-api.ts';
import {canonicalJson} from '../src/canonical-json.ts';
import {writeFile} from 'node:fs/promises';
import type {JobChestLandmarkValue} from '../src/job-contract.ts';
import {attachmentHashText, MeshEditSession, meshEditActValue} from '../src/mesh-edit.ts';
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
    // #1235: the pending sample ask is the rig verdict; the oversized sample is the comment-only act@10.
    const publication = await f.publish(), ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    const page = await f.display(publication), current = baseline(), original = structuredClone(current);
    current.status = 'approved';
    const app = await mainSave(current, original, {async submit() {
      if (code !== 'JOB_BODY_LIMIT') throw new Error(code);
      const access = jobWindowAccess(f.origin + '/jobs/' + f.session.jobId + '/#cap=' + f.credentials.ui, null, () => {});
      const transport = createJobWindowTransport(access, (async (url, init) => front.fetch(new Request(new URL(String(url), f.origin), {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), Origin: f.origin}}))) as typeof fetch);
      const result = await transport.submit({...page,
        expectedGeneration: f.session.status().generation, submissionId: 'oversized', kind: 'comments',
        value: {comments: [{text: 'x'.repeat(jobBodyLimit)}]}} as never);
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
    const actStatus = app.state().saveStates.at(-1);
    expect(actStatus?.title).toStartWith(code);
    expect(app.state().title).toBe('');
    if (code === 'JOB_BODY_LIMIT') {
      expect(actStatus?.title).toContain('POST /jobs/' + f.session.jobId + '/ui/acts');
      expect(actStatus?.title).toMatch(/ · \d+ bytes · HTTP 413$/);
    }
    expect(actStatus).toMatchObject({kind: 'failed', text: sentence});
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
    const actTitle = app.state().saveStates.at(-1)?.title;
    expect(actTitle).toBe('JOB_BODY_LIMIT · client: event stream');
    expect(app.state().title).toBe('');
    expect(app.state().saveStates.at(-1)?.text).toContain(language === 'en' ? 'NOT submitted' : '제출되지 않았어요');
    expect(app.state().saveStates.at(-1)?.text).not.toContain('JOB_');
    expect(app.state().readouts.dirty).toBe('Unsubmitted changes');
    expect(warning).toHaveBeenCalledWith(actTitle);
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

test('#966 #1231 mesh-carrying Request changes asks confirm once; Cancel sends nothing; OK sends the edits as act@10, then the verdict without them', async () => {
  const f = await jobFixture(), originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  let loaded: Awaited<ReturnType<typeof loadSetupAssets>> | undefined;
  let player: RigPlayer | undefined;
  try {
    const publication = await f.publish();
    const ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    const page = await f.display(publication);
    const retained = f.session.retainedSource(publication.publicationId);
    const model = JSON.parse(await readFile(join(retained.snapshotRoot, ask.source.model!.path), 'utf8'));
    loaded = await loadSetupAssets(model);
    player = new RigPlayer(setupRoot(), loaded.assets, {mode: 'canvas'});
    const doc = globalThis.document, create = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => {
      if (tag === 'div') return setupRoot();
      const canvas = create(tag) as HTMLCanvasElement & {toBuffer(format: string): Buffer};
      if (tag === 'canvas') canvas.toBlob = callback => callback(new Blob([new Uint8Array(canvas.toBuffer('image/png'))]));
      return canvas;
    }) as typeof doc.createElement;
    class Reader {result: string | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {void blob.arrayBuffer().then(bytes => {this.result = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'); this.onload?.();}, () => this.onerror?.());}}
    Object.defineProperty(globalThis, 'FileReader', {configurable: true, value: Reader});

    const entry = model.skins.find((skin: {name: string}) => skin.name === 'default').attachments.mesh.mesh;
    const editor = new MeshEditSession({slot: 'mesh', attachment: 'mesh', skin: 'default',
      vertices: entry.vertices.xy.reduce((rows: [number, number][], value: number, i: number, xy: number[]) =>
        (i % 2 === 0 ? [...rows, [value, xy[i + 1]!]] : rows), []),
      triangles: entry.triangles, hull: entry.hull, hash: jobHash(attachmentHashText(entry))});
    expect(editor.addVertex([60, 30])).toMatchObject({ok: true, changed: true});
    const edit = meshEditActValue(editor, {width: model.stage.width, height: model.stage.height});
    const requests: UISubmissionV3[] = [], acts: ActV3[] = [], prompts: string[] = [], cleared: JobMeshEditValue[][] = [];
    let accept = false;
    const initial = baseline();
    initial.id = publication.source.package.id; initial.revision = publication.source.package.revision;
    initial.sourceHash = publication.source.sourceHash;
    const display = {publication} as unknown as DisplayPublicationV3;
    const prepared: JobRigScreenPrepared = {jobRigScreen: true, display, entry: 'http://127.0.0.1:4318/retained/',
      review: {manifest: parseManifest({schema: 'rig-review/1', id: initial.id, revision: initial.revision, title: 'Synthetic submission'}),
        reviewedSource: initial.reviewedSource, sourceHash: initial.sourceHash}, checkpoints: new Set()};
    const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
      pageId: page.pageId, access: {capability: 'synthetic-ui', headers: () => new Headers()},
      confirm: text => {prompts.push(text); return accept;},
      window: {
        state: () => ({pending: f.session.status().pending as unknown as PendingAskV3[], receipt: page,
          generation: f.session.status().generation, preparing: false, closed: false}),
        async submit(input) {
          requests.push(input);
          const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
          if (result.ok) acts.push(result.value as ActV3);
          return result;
        },
      }, routes: () => ({entry: prepared.entry, api: path => path}), refusal: error => String(error),
      translate: (key, values) => values ? `${key}:${values.join(',')}` : key,
      async load() {
        rigHost()!.attach({
          stage: () => ({pane: {clientWidth: 160, clientHeight: 128} as HTMLElement, paneHidden: false, root: setupRoot(),
            player: player!, presentation: undefined, frameGeneration: player!.generation, camera: null, frame: null,
            wholeRig: true, playing: false, posed: player!.posedFrame(null), assets: loaded!.assets}),
          redraw() {}, message() {},
          hasMeshEdits: () => cleared.length === 0,
          meshEdits: async () => ({edits: [edit], stale: 0, clear: (items: readonly JobMeshEditValue[]) => {cleared.push([...items]);}}),
        } as JobRigMeshScreen);
        rigHost()!.displayed();
      }});
    screen.commit(prepared);
    await screen.painted(prepared, new AbortController().signal);
    const current = structuredClone(initial);
    current.status = 'changes-requested';
    current.feedback.push(structuredClone(comment));
    const app = await mainSave(current, initial, rigHost()!);
    await app.save();
    expect(prompts).toEqual(['Send this Request changes with {0} mesh edit(s) to the producer?:1']);
    expect(requests).toEqual([]);
    expect(acts).toEqual([]);
    expect(cleared).toEqual([]);
    expect(app.state().dirty).toBe(true);
    expect(app.state().readouts.dirty).toBe('Unsubmitted changes');
    expect(app.state().saveStates).toEqual([]);
    expect(app.state().messages).toEqual([]);
    expect(app.locked(comment.id)).toBe(false);

    accept = true;
    await app.save();
    expect(prompts).toHaveLength(2);
    expect(requests.map(request => request.kind)).toEqual(['comments', 'review-verdict']);
    expect(acts).toHaveLength(2);
    const carried = parseCommentOnlyAct(acts[0]!);
    expect(carried.value.comments).toEqual([]);
    expect(carried.value.carriers).toEqual([{kind: 'mesh-edits', file: publication.source.model!,
      meshEdits: [{edit, sha256: jobHash(canonicalJson(edit))}]}]);
    // #1231: the verdict no longer carries the ops; it is an ordinary comments verdict (@6 or @7).
    expect('meshEdits' in (requests[1]!.value as object)).toBe(false);
    expect(['rig-review/act@6', 'rig-review/act@7']).toContain(acts[1]!.schema);
    const verdict = acts[1]!.schema === 'rig-review/act@7' ? parseContextCommentsAct(acts[1]!) : parseCommentsAct(acts[1]!);
    expect(verdict.kind === 'review-verdict' && verdict.value.verdict).toBe('changes-requested');
    expect('meshEdits' in verdict.value).toBe(false);
    expect(() => parseMeshEditsAct(acts[1]!)).toThrow('JOB_ACT_INVALID');
    expect(cleared).toEqual([[edit]]);
    expect(app.state().dirty).toBe(false);
    expect(app.state().messages.at(-1)).toBe('job.saved');
    expect(app.locked(comment.id)).toBe(true);
  } finally {
    setRigHost(null);
    player?.dispose();
    loaded?.dispose();
    if (originalReader) Object.defineProperty(globalThis, 'FileReader', originalReader);
    else Reflect.deleteProperty(globalThis, 'FileReader');
    await f.close();
  }
});

for (const verdict of ['approved', 'changes-requested'] as const) test(`#966 ${verdict} without mesh edits never calls confirm and submits on one press`, async () => {
  const f = await jobFixture(), originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  let loaded: Awaited<ReturnType<typeof loadSetupAssets>> | undefined;
  let player: RigPlayer | undefined;
  try {
    const publication = await f.publish();
    const ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    const page = await f.display(publication), requests: UISubmissionV3[] = [], acts: ActV3[] = [], prompts: string[] = [];
    const retained = f.session.retainedSource(publication.publicationId);
    const model = JSON.parse(await readFile(join(retained.snapshotRoot, ask.source.model!.path), 'utf8'));
    loaded = await loadSetupAssets(model);
    player = new RigPlayer(setupRoot(), loaded.assets, {mode: 'canvas'});
    const doc = globalThis.document, create = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => {
      if (tag === 'div') return setupRoot();
      const canvas = create(tag) as HTMLCanvasElement & {toBuffer(format: string): Buffer};
      if (tag === 'canvas') canvas.toBlob = callback => callback(new Blob([new Uint8Array(canvas.toBuffer('image/png'))]));
      return canvas;
    }) as typeof doc.createElement;
    class Reader {result: string | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      readAsDataURL(blob: Blob) {void blob.arrayBuffer().then(bytes => {this.result = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'); this.onload?.();}, () => this.onerror?.());}}
    Object.defineProperty(globalThis, 'FileReader', {configurable: true, value: Reader});

    const initial = baseline();
    initial.id = publication.source.package.id; initial.revision = publication.source.package.revision;
    initial.sourceHash = publication.source.sourceHash;
    const display = {publication} as unknown as DisplayPublicationV3;
    const prepared: JobRigScreenPrepared = {jobRigScreen: true, display, entry: 'http://127.0.0.1:4318/retained/',
      review: {manifest: parseManifest({schema: 'rig-review/1', id: initial.id, revision: initial.revision, title: 'Synthetic submission'}),
        reviewedSource: initial.reviewedSource, sourceHash: initial.sourceHash}, checkpoints: new Set()};
    const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
      pageId: page.pageId, access: {capability: 'synthetic-ui', headers: () => new Headers()},
      confirm: text => {prompts.push(text); return false;},
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
      async load() {
        rigHost()!.attach({
          stage: () => ({pane: {clientWidth: 160, clientHeight: 128} as HTMLElement, paneHidden: false, root: setupRoot(),
            player: player!, presentation: undefined, frameGeneration: player!.generation, camera: null, frame: null,
            wholeRig: true, playing: false, posed: player!.posedFrame(null), assets: loaded!.assets}),
          redraw() {}, message() {},
          hasMeshEdits: () => false,
          meshEdits: async () => ({edits: [], stale: 0, clear() {}}),
        } as JobRigMeshScreen);
        rigHost()!.displayed();
      }});
    screen.commit(prepared);
    await screen.painted(prepared, new AbortController().signal);
    const current = structuredClone(initial);
    current.status = verdict;
    if (verdict === 'changes-requested') current.feedback.push(structuredClone(comment));
    const app = await mainSave(current, initial, rigHost()!);
    await app.save();
    expect(prompts).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(acts).toHaveLength(1);
    const committed = parseCommentsAct(acts[0]!);
    expect(committed.kind === 'review-verdict' && committed.value.verdict).toBe(verdict);
    expect(app.state().dirty).toBe(false);
    expect(app.state().messages.at(-1)).toBe('job.saved');
  } finally {
    setRigHost(null);
    player?.dispose();
    loaded?.dispose();
    if (originalReader) Object.defineProperty(globalThis, 'FileReader', originalReader);
    else Reflect.deleteProperty(globalThis, 'FileReader');
    await f.close();
  }
});

test('#966 mountJobScreen passes translated confirm callback to createJobRigScreen', async () => {
  const sessionSource = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
  const transpiler = new Bun.Transpiler({loader: 'ts'});
  const live = sessionSource.indexOf('export async function mountJobScreen(');
  const start = sessionSource.indexOf('    const rigScreen=createJobRigScreen(', live);
  const end = sessionSource.indexOf('    let bootstrapNotice:', start);
  const i18n = await import('../web/i18n.ts');
  const prompts: string[] = [];
  const options = new Function('createJobRigScreen', 'host', 'pageId', 'access', 'i18n', 't', 'jobWindowRefusal', 'dependencies',
    'window', 'transport', 'jobPublicationRoutes', 'location', 'globalThis',
    transpiler.transformSync(sessionSource.slice(start, end)) + ';return rigScreen;')(
    (opts: {translate: typeof i18n.t; confirm: (text: string) => boolean}) => opts,
    {}, 'page', {}, i18n, i18n.t, String, {}, {state() {}, submit() {}}, {readPublication() {}}, () => ({}), {origin: 'http://127.0.0.1'},
    {confirm: (text: string) => {prompts.push(text); return false;}});
  const english = options.translate('Send this Request changes with {0} mesh edit(s) to the producer?', [2]);
  expect(english).toBe('Send this Request changes with 2 mesh edit(s) to the producer?');
  try {
    setLanguagePreference('en');
    expect(options.confirm(english)).toBe(false);
    setLanguagePreference('ko');
    expect(options.confirm(english)).toBe(false);
    expect(prompts).toEqual([
      'Send this Request changes with 2 mesh edit(s) to the producer?',
      '메시 편집 2개를 담은 수정 요청을 보낼까요?',
    ]);
  } finally {
    setLanguagePreference('en');
  }
});

test('#1226 a comment send retried after a lost response replays the same request and settles', async () => {
  const f = await jobFixture(), savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true,
    value: {title: '', body: null, getElementById: () => null, querySelector: () => null, createElement: () => ({style: {}, dataset: {}})}});
  try {
    const publication = await f.publish();
    const page = await f.display(publication), requests: UISubmissionV3[] = [], results: unknown[] = [];
    const initial = baseline();
    initial.id = publication.source.package.id; initial.revision = publication.source.package.revision;
    initial.sourceHash = publication.source.sourceHash;
    const prepared: JobRigScreenPrepared = {jobRigScreen: true, display: {publication} as unknown as DisplayPublicationV3, entry: 'http://127.0.0.1:4318/retained/',
      review: {manifest: parseManifest({schema: 'rig-review/1', id: initial.id, revision: initial.revision, title: 'Synthetic comments'}),
        reviewedSource: initial.reviewedSource, sourceHash: initial.sourceHash}, checkpoints: new Set()};
    let lose = true;
    const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
      pageId: page.pageId, access: {capability: 'synthetic-ui', headers: () => new Headers()},
      window: {
        state: () => ({pending: f.session.status().pending as unknown as PendingAskV3[], receipt: page,
          generation: f.session.status().generation, preparing: false, closed: false}),
        async submit(input) {
          requests.push(structuredClone(input));
          const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
          results.push(result);
          // The daemon committed the act (and moved the generation), but the page never hears back.
          if (lose) {lose = false; throw new Error('JOB_TRANSPORT_LOST');}
          return result;
        },
      }, routes: () => ({entry: prepared.entry, api: path => path}), refusal: error => String(error),
      translate: key => key,
      async load() {rigHost()!.attach({message() {}} as unknown as JobRigMeshScreen); rigHost()!.displayed();}});
    screen.commit(prepared);
    await screen.painted(prepared, new AbortController().signal);
    const generation = f.session.status().generation;
    await expect(rigHost()!.submitComments!([], ['The motion reads a little fast.'])).rejects.toThrow('JOB_TRANSPORT_LOST');
    expect(f.session.status().generation).toBeGreaterThan(generation);
    expect(await rigHost()!.submitComments!([], ['The motion reads a little fast.'])).toBe('job.saved');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]!);
    expect(results[1]).toEqual(results[0]);
  } finally {
    setRigHost(null);
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    await f.close();
  }
});

test('#1231 Send comments carries pending Edit Mesh and chest drafts as act@10 carriers; a stale model refuses and keeps them', async () => {
  const f = await jobFixture(), savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true,
    value: {title: '', body: null, getElementById: () => null, querySelector: () => null, createElement: () => ({style: {}, dataset: {}})}});
  try {
    const shown = JSON.parse(await readFile(join(f.root, 'out/skeleton.model.json'), 'utf8'));
    const entry = shown.skins.find((skin: {name: string}) => skin.name === 'default').attachments.mesh.mesh;
    const frame = {width: shown.stage.width, height: shown.stage.height}, hash = jobHash(attachmentHashText(entry));
    const meshEdit: JobMeshEditValue = {skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
      source: {hash, frame, vertexCount: 4, triangleCount: 2, hullLength: 4, positions: [[48, 42], [48, 22], [68, 22], [68, 42]]},
      ops: [{op: 'add', at: [60.12, 29.57]}]};
    const chestEdit: JobChestLandmarkValue = {skin: 'default', slot: 'mesh', attachment: 'mesh', basis: 'setup',
      source: {hash, frame}, bust: {apex_r: [16 + 1 / 256, 20], apex_l: [56, 20], alpha: 0.22}};
    const path = 'producer-config.json', bytes = JSON.stringify({meshes: {mesh: {contour: {bust: chestEdit.bust}}}});
    await writeFile(join(f.root, path), bytes);
    const config = {path, sha256: jobHash(bytes)};
    f.setContext({...f.getContext(), files: [config], chestLandmarks: [{...chestEdit, source: {...chestEdit.source, configHash: config.sha256}}]});
    const publication = await f.publish();
    const page = await f.display(publication), requests: UISubmissionV3[] = [];
    const cleared: {mesh: unknown[][]; chest: unknown[][]} = {mesh: [], chest: []};
    async function send(model: typeof publication.source.model) {
      const display = {publication: {...publication, source: {...publication.source, model}}} as unknown as DisplayPublicationV3;
      const initial = baseline();
      const prepared: JobRigScreenPrepared = {jobRigScreen: true, display, entry: 'http://127.0.0.1:4318/retained/',
        review: {manifest: parseManifest({schema: 'rig-review/1', id: initial.id, revision: initial.revision, title: 'Synthetic carriers'}),
          reviewedSource: initial.reviewedSource, sourceHash: publication.source.sourceHash}, checkpoints: new Set()};
      const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
        pageId: page.pageId, access: {capability: 'synthetic-ui', headers: () => new Headers()},
        window: {
          state: () => ({pending: f.session.status().pending as unknown as PendingAskV3[], receipt: page,
            generation: f.session.status().generation, preparing: false, closed: false}),
          async submit(input) {requests.push(structuredClone(input)); return f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));},
        }, routes: () => ({entry: prepared.entry, api: path => path}), refusal: error => String(error), translate: key => key,
        async load() {
          rigHost()!.attach({message() {},
            meshEdits: async () => ({edits: [meshEdit], stale: 0, clear: (items: readonly unknown[]) => {cleared.mesh.push([...items]);}}),
            chestLandmarks: () => ({edits: [chestEdit], clear: (items: readonly unknown[]) => {cleared.chest.push([...items]);}}),
          } as unknown as JobRigMeshScreen);
          rigHost()!.displayed();
        }});
      screen.commit(prepared);
      await screen.painted(prepared, new AbortController().signal);
      return rigHost()!.submitComments!([], ['The chest sits low.']);
    }
    const file = publication.source.model!;
    // A carrier bound to a model the daemon did not retain is a stale view; nothing is cleared.
    await expect(send({...file, sha256: '1'.repeat(64)})).rejects.toThrow('JOB_ACT_SOURCE_STALE');
    expect(cleared).toEqual({mesh: [], chest: []});
    setRigHost(null);
    expect(await send(file)).toBe('job.saved');
    const meshEdits = [{edit: meshEdit, sha256: jobHash(canonicalJson(meshEdit))}];
    const chestLandmarks = [{edit: chestEdit, sha256: jobHash(canonicalJson(chestEdit))}];
    expect(requests.at(-1)).toMatchObject({kind: 'comments', value: {comments: [{text: 'The chest sits low.'}],
      carriers: [{kind: 'mesh-edits', file, meshEdits}, {kind: 'chest-landmarks', file, chestLandmarks}]}});
    expect('askId' in requests.at(-1)!).toBe(false);
    const acts = (await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json()).value.events
      .flatMap((event: {type: string; act?: ActV3}) => event.type === 'act' ? [event.act!] : []);
    expect(acts).toHaveLength(1);
    const act = parseCommentOnlyAct(acts[0]);
    expect(act.value.carriers).toEqual([{kind: 'mesh-edits', file, meshEdits}, {kind: 'chest-landmarks', file, chestLandmarks}]);
    // Written and read back: the stored bytes are the act the decoder returns.
    expect(f.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
    expect(JSON.stringify(parseCommentOnlyAct(JSON.parse(f.session.readActExport(act.actId, false).toString())))).toBe(JSON.stringify(act));
    expect(cleared).toEqual({mesh: [[meshEdit]], chest: [[chestEdit]]});
  } finally {
    setRigHost(null);
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    await f.close();
  }
});
