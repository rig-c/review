import {seedHistoricalVerdictAsk} from './helpers/historical-verdict-ask.ts';
import {expect, test, spyOn} from 'bun:test';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {seedHistoricalCheckpointAsk} from './helpers/historical-checkpoint-act.ts';
import {fixtureAct, fixturePublication} from './helpers/job-window-fixture.ts';
import {createJobRigScreen, type JobRigMeshScreen, type JobRigScreenPrepared} from '../web/job-rig-screen.ts';
import {rigHost, setRigHost, type RigHost} from '../web/rig-host.ts';
import type {ReviewSession} from '../src/session.ts';
import type {ActV3, DisplayPublicationV3, JobChestLandmarkValue, JobMeshEditValue, PendingAskV3, UISubmissionV3} from '../src/job-contract.ts';
import {jobBodyLimit, jobHash, parseCommentOnlyAct} from '../src/job-api.ts';
import {canonicalJson} from '../src/canonical-json.ts';
import {attachmentHashText} from '../src/mesh-edit.ts';
import {parseManifest} from '../src/manifest.ts';
import {setLanguagePreference} from '../web/i18n.ts';
import {createJobFront} from '../src/job-front.ts';
import {jobSubmissionRefusal,createJobWindowTransport,jobWindowAccess,jobWindowEvents,type JobWindowAsk} from '../web/job-session.ts';

useTemporaryReviewState();
function baseline(): ReviewSession {
  const {source} = fixturePublication().publication;
  return {schema: 'rig-review-session/1', ...source.package, sourceHash: source.sourceHash,
    reviewedSource: {packageRevision: source.package.revision, viewerVersion: 'synthetic', runtimeVersion: 'synthetic', rig: null, motion: null},
    status: 'pending', checkpoints: {}, feedback: [], feedbackWarnings: [], updatedAt: null};
}

/** Execute the shared Send comments click and observe the act row without mounting a browser. */
async function mainSend(host: Pick<RigHost, 'submitComments'>) {
  const source = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const start = source.indexOf('sendComments.onclick=async()=>{'), end = source.indexOf('async function saveLocalComments(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const click = new Bun.Transpiler({loader: 'ts'}).transformSync(source.slice(start, end));
  return new Function('host', 'jobSubmissionRefusal', `
    const session = {}, sendComments = {disabled: false}, general = [{id: 'draft', summary: 'unsent comment'}];
    let dirty = true, saving = false, commentSending = false, commentSendState = null;
    const sent = [], messages = [], saveStates = [];
    const rigInspector = {actBar: {setSaveState: value => saveStates.push(value)}};
    const commentHost = () => true, comments = null;
    const unsentComments = () => ({feedback: [], general, issues: []});
    const hasUnsentContent = () => sent.length === 0;
    const markSentAlone = rows => sent.push(...rows);
    const message = (text, error) => messages.push({text, error});
    function updateSavedState() {} function renderProposals() {}
    ${click}
    return {send: sendComments.onclick, state: () => ({dirty, saving, sent, messages, saveStates})};
  `)(host, jobSubmissionRefusal) as {
    send(): Promise<void>;
    state(): {dirty: boolean; saving: boolean; sent: unknown[];
      messages: {text: string; error?: boolean}[]; saveStates: {kind: string; text: string; title?: string}[]};
  };
}

for (const language of ['en', 'ko'] as const) test(`#785 oversized Send comments shows the refusal and keeps its draft (${language})`, async () => {
  const f = await jobFixture();
  const front = createJobFront({origin: f.origin, ports: f.ports, resource: async () => ''});
  setLanguagePreference(language);
  try {
    const publication = await f.publish();
    const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'rig-review'});
    const page = await f.display(publication);
    const app = await mainSend({async submitComments() {
      const access = jobWindowAccess(f.origin + '/jobs/' + f.session.jobId + '/#cap=' + f.credentials.ui, null, () => {});
      const transport = createJobWindowTransport(access, (async (url, init) => front.fetch(new Request(new URL(String(url), f.origin), {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), Origin: f.origin}}))) as typeof fetch);
      const result = await transport.submit({...page, expectedGeneration: f.session.status().generation,
        submissionId: 'oversized', kind: 'comments', value: {comments: [{text: 'x'.repeat(jobBodyLimit)}]}});
      if (result.ok) throw Error('EXPECTED_REFUSAL');
      expect(result.error.code).toBe('JOB_BODY_LIMIT');
      throw new Error(result.error.code, {cause: (result.error as {cause?: unknown}).cause});
    }});
    await app.send();
    const {dirty, saving, sent, messages, saveStates} = app.state();
    const state = saveStates.at(-1);
    if (!state) throw new Error('Expected the Send comments refusal state');
    expect(state.text).toContain(language === 'en' ? 'NOT submitted' : '제출되지 않았어요');
    expect(state.text).not.toContain('JOB_');
    expect(state.kind).toBe('failed');
    expect(state.title).toStartWith('JOB_BODY_LIMIT');
    expect(state.title).toContain('POST /jobs/' + f.session.jobId + '/ui/acts');
    expect(state.title).toMatch(/ · \d+ bytes · HTTP 413$/);
    expect(messages.at(-1)).toEqual({text: state.text, error: true});
    expect({dirty, saving, sent}).toEqual({dirty: true, saving: false, sent: []});
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
    const diagnostic = jobSubmissionRefusal(refusal);
    expect(diagnostic.title).toBe('JOB_BODY_LIMIT · client: event stream');
    expect(diagnostic.text).toContain(language === 'en' ? 'NOT submitted' : '제출되지 않았어요');
    expect(diagnostic.text).not.toContain('JOB_');
    expect(warning).toHaveBeenCalledWith(diagnostic.title);
  } finally {warning.mockRestore();setLanguagePreference('en');}
});

test('#1233 historical checkpoint and rig asks stay pending after Send comments', async () => {
  const f = await jobFixture(), originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => ({id: ''})}});
  try {
    const publication = await f.publish(), page = await f.display(publication);
    const checkpoint = seedHistoricalCheckpointAsk(f.session, publication.publicationId, {kind: 'checkpoint', checkpointId: 'step-one'});
    const verdict = seedHistoricalVerdictAsk(f.session, publication.publicationId, {kind: 'review-verdict', stage: 'rig-review'});
    const requests: UISubmissionV3[] = [], initial = baseline();
    const prepared: JobRigScreenPrepared = {jobRigScreen: true, display: {publication} as unknown as DisplayPublicationV3,
      entry: 'http://127.0.0.1:4318/retained/',
      review: {manifest: parseManifest({schema: 'rig-review/1', ...publication.source.package, title: 'Synthetic comments'}),
        reviewedSource: initial.reviewedSource, sourceHash: publication.source.sourceHash}, checkpoints: new Set(['step-one'])};
    const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
      pageId: page.pageId, access: {capability: 'synthetic-ui', headers: () => new Headers()},
      window: {
        state: () => ({pending: f.session.status().pending as unknown as PendingAskV3[], receipt: page,
          generation: f.session.status().generation, preparing: false, closed: false}),
        async submit(input) {requests.push(input); return f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));},
      }, routes: () => ({entry: prepared.entry, api: path => path}), refusal: String, translate: key => key,
      async load() {rigHost()!.displayed();}});
    screen.commit(prepared);
    await screen.painted(prepared, new AbortController().signal);
    const host = rigHost()!;
    await expect(host.read('/api/session','PUT')).rejects.toThrow('JOB_REVIEW_READ_ONLY');
    await expect(host.read('/api/unknown','GET')).rejects.toThrow('JOB_REVIEW_READ_ONLY');
    expect(host).not.toHaveProperty('submit');
    expect(host).not.toHaveProperty('submitParts');
    expect(await host.submitComments!([], ['Inspect the elbow seam.'])).toBe('job.saved');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({kind: 'comments', value: {comments: [{text: 'Inspect the elbow seam.'}]}});
    expect(requests[0]).not.toHaveProperty('askId');
    expect(f.session.status().pending.map(ask => [ask.askId, ask.status]))
      .toEqual([[checkpoint.askId, 'pending'], [verdict.askId, 'pending']]);
  } finally {
    setRigHost(null);
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    await f.close();
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
    async function send(model: typeof publication.source.model, general = ['The chest sits low.']) {
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
      return rigHost()!.submitComments!([], general);
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
    // Edits alone, with no comment, are a valid Send comments act.
    setRigHost(null);
    expect(await send(file, [])).toBe('job.saved');
    expect(requests.at(-1)).toMatchObject({kind: 'comments', value: {comments: [],
      carriers: [{kind: 'mesh-edits', file, meshEdits}, {kind: 'chest-landmarks', file, chestLandmarks}]}});
  } finally {
    setRigHost(null);
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    await f.close();
  }
});

test('#1242 the parts and record screens send act@10: parts pins keep their anchor, a record host exposes Send comments', async () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true,
    value: {title: '', body: null, getElementById: () => null, querySelector: () => null, createElement: () => ({style: {}, dataset: {}})}});
  try {
    const issue = {schema: 'rig-review-parts-issue/1', id: 'pin-1', summary: 'The left sleeve edge is ragged.'};
    for (const kind of ['parts', 'record'] as const) {
      const {publication} = fixturePublication(), requests: UISubmissionV3[] = [];
      const receipt = {displayedNonce: 'nonce-1242'};
      const pending: JobWindowAsk[] = [];
      const prepared = {jobRigScreen: true, display: {publication} as unknown as DisplayPublicationV3,
        entry: 'http://127.0.0.1:4318/jobs/window-fixture/', checkpoints: new Set<string>(),
        ...kind === 'parts' ? {parts: {mode: 'parts', sourceHash: publication.source.sourceHash}} :
          {record: {inspection: {checkpointEvidence: []}, forms: new Map(), picture: null}}} as unknown as JobRigScreenPrepared;
      const screen = createJobRigScreen({host: {classList: {remove() {}}, replaceChildren() {}} as unknown as HTMLElement,
        pageId: 'page-1242', access: {capability: 'synthetic-ui', headers: () => new Headers()},
        window: {
          state: () => ({pending, receipt, generation: 3, preparing: false, closed: false}),
          async submit(input) {requests.push(structuredClone(input)); return {ok: true, value: {schema: 'rig-review/act@10', value: {comments: []}}} as never;},
        }, routes: () => ({entry: prepared.entry, api: path => path}), refusal: error => String(error), translate: key => key,
        async load() {rigHost()!.attach({message() {}} as unknown as JobRigMeshScreen); rigHost()!.displayed();}});
      screen.commit(prepared);
      await screen.painted(prepared, new AbortController().signal);
      const host = rigHost()!;
      expect(typeof host.submitComments).toBe('function');
      // A parts host with no ask takes general comments; the record binds its own publication.
      if (kind === 'parts') {
        expect(host.verdictComments!.available()).toBe(true);
        expect(await host.read('/api/session', 'GET')).toEqual({subject: 'parts', issues: []});
        const historical = fixtureAct('parts-verdict');
        const {summary, ...anchor} = issue;
        for (const saved of [
          {schema: 'rig-review/act@5', value: {verdict: 'changes-requested', words: '', issues: [issue]}},
          {schema: 'rig-review/act@6', value: {verdict: 'changes-requested', comments: [{text: 'General.'}, {text: summary, anchor}]}},
        ]) {
          pending.splice(0, pending.length, {askId: historical.askId, publicationId: publication.publicationId,
            status: 'answered', subject: {kind: 'parts-verdict', draftId: 'draft-one'},
            source: historical.source, act: {...historical, ...saved} as ActV3});
          expect(await host.read('/api/session', 'GET')).toEqual({subject: 'parts', issues: [issue]});
        }
      } else expect(host.record?.publicationId).toBe(publication.publicationId);
      expect(await host.submitComments!([], ['General note.'], kind === 'parts' ? [issue as never] : [])).toBe('job.saved');
      expect(requests).toHaveLength(1);
      const request = requests[0] as Extract<UISubmissionV3, {kind: 'comments'}>;
      expect(request.kind).toBe('comments');
      expect('askId' in request).toBe(false);
      expect(request.publicationId).toBe(publication.publicationId);
      expect(request.displayedNonce).toBe('nonce-1242');
      expect(request.value.comments as unknown).toEqual(kind === 'parts' ?
        [{text: issue.summary, anchor: {schema: issue.schema, id: issue.id}}, {text: 'General note.'}] : [{text: 'General note.'}]);
      setRigHost(null);
    }
  } finally {
    setRigHost(null);
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
