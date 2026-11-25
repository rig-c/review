import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {JOB_API_SCHEMA, JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_RECORD_ACT_SCHEMA, type ActV3, type EventV3, type JobResult, type PendingAskV3, type UISubmissionV3} from '../src/job-contract.ts';
import {createJobHostPorts} from '../src/job-api.ts';
import {createJobFront, jobWindowResources, retainedPublicationRoutes} from '../src/job-front.ts';
import {getLanguagePreference, setLanguagePreference, setSourceAttribute, setSourceText, sourceTextContent, t} from '../web/i18n.ts';
import {mountRigInspector} from '../web/inspector-blocks.ts';
import {createJobRigScreen, type JobRigScreenPrepared} from '../web/job-rig-screen.ts';
import {createJobFormDrafts, createJobFormHelpers, createJobWindow, createJobWindowTransport, jobPublicationRoutes, jobSubmissionRefusal, jobWindowAccess, prepareJobForms, type JobFormDependencies} from '../web/job-session.ts';
import {rigHost, setRigHost} from '../web/rig-host.ts';
import {recordScreenDom, recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';

// Use the same source seam as act-bar-answers.test.ts, spanning the shared record
// comment-act and act-bar renderers. The surrounding viewport has no role here.
const main = ts.createSourceFile('main.ts', readFileSync(new URL('../web/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const mount = main.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'mountRigScreen')!;
const renderers = ['message', 'commentHost', 'sentAloneRows', 'isSentAlone', 'markSentAlone', 'unsentComments',
  'renderDraftState', 'renderRecordForms', 'renderPendingSubjects', 'syncJobActRow',
  'setJobProgress', 'stopProgressTimer', 'renderAskHeadline', 'renderAnswerControls', 'communicationPending'];
const snippets = renderers.map(name => {
  const renderer = mount.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!renderer) throw new Error(`Missing production renderer: ${name}`);
  return renderer.getText(main);
});
for (const varName of ['commentBinding', 'hasUnsentComments', 'hasUnsentContent', 'recordSaveStateShown']) {
  const variable = mount.body!.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(({name}) => ts.isIdentifier(name) && name.text === varName));
  if (variable) snippets.push(variable.getText(main));
}
const sendCommentsClick = mount.body!.statements.find(node => ts.isExpressionStatement(node) && node.getText(main).startsWith('sendComments.onclick='));
if (!sendCommentsClick) throw new Error('Missing production sendComments.onclick');
snippets.push(sendCommentsClick.getText(main));
const startRecord = mount.body!.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'startRecord')!;
const attachment = startRecord.body!.statements.find(node => ts.isIfStatement(node) && node.getText(main).includes('host!.attach('))!;
// #1228: the probe hands the production right-panel predicate and state refresh back to the test.
const mountRecord = new Function('env', `with(env) {${new Bun.Transpiler({loader: 'ts'}).transformSync(snippets.join('\n') + '\n' + attachment.getText(main) + '\nprobe.communicationPending = communicationPending;\nprobe.refresh = renderDraftState;')}}`) as (env: object) => void;

type EventPayload = {[Type in EventV3['type']]: Omit<Extract<EventV3, {type: Type}>, 'jobId' | 'generation' | 'cursor'>}[EventV3['type']];
type Post = {input: UISubmissionV3; serve(): Promise<Response>; respond(response: Response): void; fail(error: Error): void};
type ScreenReadback = {
  row: boolean;
  communication: boolean;
  headline: string;
  status: string;
  statusKind: string;
  form: boolean;
  formStatus: string;
  submitDisabled: boolean;
  actions: {id: string; disabled: boolean; opacityOverride: boolean}[];
};

// Add the DOM operations needed by the real act row to the existing record fixture host.
function mountActDom(dom: Awaited<ReturnType<typeof recordScreenDom>>) {
  const create = dom.document.createElement;
  dom.document.createElement = (tag: string) => {
    const node = create(tag) as HTMLElement;
    const classes = node.classList;
    classes.contains = token => node.className.split(/\s+/).includes(token);
    classes.remove = (...tokens) => {node.className = node.className.split(/\s+/).filter(item => !tokens.includes(item)).join(' ');};
    classes.toggle = (token, force = !classes.contains(token)) => {
      if (force) classes.add(token);
      else classes.remove(token);
      return force;
    };
    node.contains = other => {
      for (let cursor = other as HTMLElement | null; cursor; cursor = cursor.parentElement) if (cursor === node) return true;
      return false;
    };
    const query = node.querySelector.bind(node);
    node.querySelector = ((selector: string) => {
      if (!selector.endsWith(':not(:disabled)')) return query(selector);
      const item = query(selector.slice(0, -':not(:disabled)'.length)) as HTMLFieldSetElement | null;
      return item?.disabled === false ? item : null;
    }) as typeof node.querySelector;
    node.style.removeProperty = name => {Reflect.deleteProperty(node.style, name); return '';};
    node.focus = () => {};
    if (tag === 'button') node.after = (...siblings) => node.parentElement?.append(...siblings);
    return node;
  };
  const node = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, id = ''): HTMLElementTagNameMap[Tag] => {
    const element = dom.document.createElement(tag) as HTMLElementTagNameMap[Tag];
    element.id = id;
    return element;
  };
  const app = node('div');
  const root = node('div'); root.append(app);
  const document = Object.assign(dom.document, {
    getElementById: (id: string) => root.querySelector('#' + id),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  }) as unknown as Document;
  return {root, document, node, app};
}

function mountRecordAct(dom: ReturnType<typeof mountActDom>, localStore = new Map<string, string>()) {
  const {node, document} = dom;
  const root = document.getElementById('app')!;
  const host = rigHost()!;
  const row = node('div', 'workspace-act-row'), dirty = node('span', 'dirty');
  const headline = node('span', 'workspace-ask-headline'), actStatus = node('p', 'review-draft-state');
  const rigAsk = node('button', 'workspace-pending-ask');
  rigAsk.className = 'workspace-act-ask';
  const sendComments = node('button', 'send-comments'); sendComments.hidden = true; setSourceText(sendComments, 'Send comments');
  const save = node('button', 'save'), requestChanges = node('button', 'request-changes');
  const reason = node('span', 'request-changes-reason'), notice = node('p', 'review-message');
  const communicationPanel = node('aside', 'workspace-communication');
  const inspector = node('div'); inspector.className = 'inspector';
  const heading = node('div'); heading.className = 'inspector-heading';
  const body = node('div'); body.className = 'inspector-body';
  inspector.append(heading, body);
  const dialog = node('div', 'review-dialog'), dialogHeader = node('div'), dialogActions = node('div');
  dialogHeader.className = 'review-dialog-header'; dialogActions.className = 'review-dialog-actions';
  dialogActions.append(sendComments, save, reason, requestChanges, actStatus, notice); dialog.append(dialogHeader, dialogActions);
  const feedback = node('div', 'inspector-feedback'), verdict = node('select', 'review-status'), label = node('label');
  label.setAttribute('for', verdict.id); feedback.append(label, verdict);
  root.append(inspector, dialog, feedback, row, dirty, communicationPanel, node('p', 'message'), node('p', 'draft-state'), node('div', 'draft-recovery'),
    node('div', 'proposal-panel'), node('div', 'comments-list-host'), node('div', 'inspector-rig'), node('div', 'inspector-playback'));
  const rigInspector = mountRigInspector(document, row);
  rigInspector.act.prepend(headline, rigAsk);
  const el = (id: string) => document.getElementById(id)!;
  const recordComments: {id: string; summary: string}[] = [];
  const probe: {communicationPending?: () => boolean; refresh?: () => void} = {};
  mountRecord({probe, communicationPanel, host, interview: undefined, rigInspector, sendComments, rigAsk, askHeadline: headline, requestChanges, requestChangesReason: reason,
    document, el, button: el, select: el, text: (id: string, value: string) => setSourceText(el(id), value),
    t, setSourceText, setSourceAttribute, sourceTextContent, jobSubmissionRefusal,
    localStorage: {getItem: (k: string) => localStore.get(k) ?? null, setItem: (k: string, v: string) => {localStore.set(k, v);}},
    rowStoreCache: new Map(), submittedDirectionComments: new Set(), isAnswerCarried: () => false, isSubmittedFeedback: () => false,
    pendingAnswers: [], restoreRecordComments() {}, checkpointPair: null, syncQuestionImage() {}, syncCheckpointPair() {},
    commitAnswerCarried() {}, recordAnswered: false, commentSending: false, commentSendState: 'idle',
    partsSubject: null, comments: null, recordComments, firstPublicationPrompt: true, jobProgress: null, progressTimer: undefined, askSentence: '',
    draftStatus: null, dirty: false, saving: false, draftConflict: false, actReadOnly: null, session: null,
    partsOnly: false, readOnly: null, verdictSubmit: null, workspace: null, liveIssueCount: () => 0,
    disposed: false, suspended: false, hostStage: () => null, suspendScreen() {}, resumeScreen() {}, disposeScreen() {} });
  return {
    addComment(summary: string, id = `c-${recordComments.length + 1}`) {
      recordComments.push({id, summary});
      probe.refresh!();
    },
    sendComments: () => sendComments,
    read(): ScreenReadback {
      const forms = root.querySelectorAll('form[data-job-ask]');
      return {row: !row.hidden, communication: probe.communicationPending!(), headline: headline.textContent!,
        status: actStatus.textContent!, statusKind: actStatus.dataset.saveState ?? '',
        form: forms.length > 0, formStatus: notice.textContent ?? '',
        submitDisabled: sendComments.hidden || sendComments.disabled,
        actions: [rigAsk, sendComments, save, requestChanges].filter(control => !row.hidden && !control.hidden).map(control => ({
          id: control.id, disabled: control.disabled, opacityOverride: control.classList.contains('workspace-act-ask'),
        }))};
    },
    dispose() {rigInspector.actBar.dispose();},
  };
}

// #1229 / #1230: all record ask forms are retired; live record submission status transitions exercise Send comments (act@10).
async function harness(republish = false, kind: 'option-set' | 'interview-picks' | 'checkpoint' | 'signoff' = 'option-set', ask = false) {
  const picture = republish ? readFileSync(new URL('./fixtures/viewport-387/package/rigid.png', import.meta.url)) : undefined;
  const fixture = await recordScreenFixture(kind, false, undefined, 'direction-review', false, true, undefined, false, false, undefined, undefined, kind === 'interview-picks' || kind === 'option-set' ? undefined : picture, kind === 'interview-picks' || kind === 'option-set' ? picture : undefined);
  const dom = await recordScreenDom();
  const previousLanguage = getLanguagePreference();
  const previousHost = rigHost();
  setLanguagePreference('en');
  dom.set('location', {origin: fixture.origin});
  const ui = mountActDom(dom);
  const localStore = new Map<string, string>();
  const access = jobWindowAccess(fixture.ownerUrl, null, () => {});
  const pageId = 'test-record-status-page';
  const posts: Post[] = [];
  let screen: ReturnType<typeof mountRecordAct> | undefined;
  const transport = createJobWindowTransport(access, Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input !== 'string') return fetch(input, init);
    const url = new URL(input, fixture.origin);
    const headers = new Headers(init?.headers);
    if (init?.method === 'POST') headers.set('Origin', fixture.origin);
    const serve = () => fetch(url, {...init, headers});
    if (!url.pathname.endsWith('/ui/acts')) return serve();
    const response = Promise.withResolvers<Response>();
    posts.push({input: JSON.parse(String(init?.body)) as UISubmissionV3,
      serve, respond: response.resolve, fail: response.reject});
    return response.promise;
  }, {preconnect: fetch.preconnect}));
  const drafts = createJobFormDrafts({jobId: access.jobId, current: () => view.mounted()?.record?.inspection ?? null,
    forms: () => view.mounted()?.record?.forms ?? new Map(), storage: () => ({setItem() {}})});
  const formNode: JobFormDependencies['node'] = (tag, key) => {
    const element = ui.node(tag);
    if (key) {element.dataset.jobText = key; element.textContent = t(key);}
    return element;
  };
  const windowAccess = {state: () => window.state(), submit: (input: UISubmissionV3) => window.submit(input)};
  const view = createJobRigScreen({host: ui.app, access, pageId, translate: t, refusal: String, window: windowAccess, readPublication: transport.readPublication,
    routes: display => jobPublicationRoutes(display, fixture.origin),
    formDependencies: {node: formNode, translate: t, access, pageId, window: windowAccess, ...drafts, draftStorage: () => ({getItem: () => null}),
      helpers: {...createJobFormHelpers(formNode, t), assertJobAskSource: (ask, display) => {prepareJobForms(display, [ask], () => null);}}},
    async load() {screen?.dispose(); screen = mountRecordAct(ui, localStore);}});
  const window = createJobWindow<JobRigScreenPrepared | null>({jobId: access.jobId, pageId, transport, adapter: {
    prepare: view.prepare, captureDraft: () => null, commit: prepared => view.commit(prepared!),
    painted: (prepared, signal) => view.painted(prepared!, signal), discard: prepared => prepared?.record?.inspection.dispose(), changed: view.changed,
  }});
  let generation = fixture.display.publication.generation;
  function event(value: EventPayload) {
    window.event({...value, jobId: access.jobId, generation: ++generation, cursor: String(generation)});
  }
  async function close() {
    window.stop(); screen?.dispose(); view.mounted()?.record?.inspection.dispose();
    setRigHost(previousHost); dom.restore(); setLanguagePreference(previousLanguage); await fixture.close();
  }
  try {
    event({type: 'published', publication: fixture.display.publication});
    await window.settled();
    if (window.state().error) throw window.state().failure ?? new Error(window.state().error!);
    expect(window.state().receipt?.publicationId).toBe(fixture.ask.publicationId);
    if (ask) event({type: 'pending', ask: fixture.ask});
    return {fixture, window, event, close, read: () => screen!.read(),
      comment(text = 'Check the timing', id?: string) {screen!.addComment(text, id);},
      async start() {
        const button = screen!.sendComments();
        expect(screen!.read().submitDisabled).toBe(false);
        const previousPosts = posts.length;
        const submit = Promise.resolve(button.onclick?.call(button, {} as PointerEvent));
        await Promise.resolve();
        await Promise.resolve();
        if (posts.length !== previousPosts + 1) {await submit; throw new Error('Send comments did not POST exactly once');}
        return {submit, post: posts.at(-1)!};
      },
    };
  } catch (error) {await close(); throw error;}
}

async function recorded(post: Post) {
  const response = await post.serve();
  expect(response.status).toBe(200);
  const result = await response.clone().json() as JobResult<ActV3>;
  if (!result.ok) throw new Error(`Expected comment-only act, received ${result.error.code}`);
  if (result.value.schema !== JOB_COMMENT_ONLY_ACT_SCHEMA || result.value.kind !== 'comments') throw new Error('Expected a comment-only act');
  expect(result.value).toMatchObject({kind: 'comments', publicationId: post.input.publicationId});
  return {response, act: result.value};
}

const commentMode = "We're looking at the work together. Leave your thoughts as comments.";
const sendAction = (disabled: boolean) => ({id: 'send-comments', disabled, opacityOverride: false});
const idle = {row: true, headline: commentMode, status: 'Not submitted', form: false, submitDisabled: true, actions: [sendAction(true)]};
const before = {row: true, headline: commentMode, status: 'Not submitted', form: false, submitDisabled: false, actions: [sendAction(false)]};
const sending = {...before, status: 'Sending', submitDisabled: true, actions: [sendAction(true)]};
const accepted = {row: true, headline: commentMode, status: 'Submitted', form: false, submitDisabled: true, actions: [sendAction(true)]};

for (const order of ['response first', 'stream first'] as const) test(`#1205 record comment submission shows before, sending and accepted (${order})`, async () => {
  const h = await harness();
  try {
    expect(h.read()).toMatchObject(idle);
    h.comment('Check the timing', 'c1');
    const prior = h.read();
    const {post, submit} = await h.start();
    const inflight = h.read();
    expect(post.input).toMatchObject({kind: 'comments', publicationId: h.fixture.display.publication.publicationId,
      pageId: 'test-record-status-page', displayedNonce: h.window.state().receipt!.displayedNonce,
      value: {comments: [{text: 'Check the timing'}]}} );
    const {response, act} = await recorded(post);
    if (order === 'stream first') h.event({type: 'act', act});
    const afterStream = order === 'stream first' ? h.read() : null;
    post.respond(response);
    await submit;
    const afterResponse = h.read();
    if (order === 'response first') h.event({type: 'act', act});
    expect({prior, inflight, afterStream, afterResponse, afterBoth: h.read()}).toMatchObject({
      prior: before,
      inflight: sending,
      afterStream: order === 'stream first' ? sending : null,
      afterResponse: accepted,
      afterBoth: accepted,
    });
  } finally {await h.close();}
});

test('#1205 a new comment after accepted Send comments rearms Not submitted and Send comments', async () => {
  const h = await harness();
  try {
    h.comment('First batch', 'c1');
    const {post, submit} = await h.start();
    const {response, act} = await recorded(post);
    post.respond(response);
    await submit;
    h.event({type: 'act', act});
    const signedReadback = h.read();
    h.comment('Follow-up batch', 'c2');
    const nextReadback = h.read();
    expect({signedReadback, nextReadback}).toMatchObject({signedReadback: accepted, nextReadback: before});
  } finally {await h.close();}
});

for (const failure of ['refusal', 'network rejection'] as const) test(`#1205 ${failure} restores Send comments for retry`, async () => {
  const h = await harness();
  try {
    h.comment('Check the timing', 'c1');
    const first = await h.start();
    const inflight = h.read();
    if (failure === 'refusal') first.post.respond(Response.json({ok: false, error: {code: 'JOB_ACT_INVALID', message: 'fixture refusal'}}, {status: 400}));
    else first.post.fail(new TypeError('fixture connection lost'));
    await first.submit;
    const failed = h.read();
    const expectedRefusal = jobSubmissionRefusal(new Error('JOB_ACT_INVALID')).text;
    expect(failed.status).toBe(expectedRefusal);
    expect(failed.statusKind).toBe('failed');
    expect(failed.formStatus).toBe(expectedRefusal);
    expect(h.fixture.files).toHaveLength(0);
    const retry = await h.start();
    const retrying = h.read();
    expect(retry.post.input).toEqual(first.post.input);
    const {response} = await recorded(retry.post);
    retry.post.respond(response);
    await retry.submit;
    expect({inflight, failed, retrying, finished: h.read()}).toMatchObject({
      inflight: sending,
      failed: {row: true, form: false, submitDisabled: false, actions: [sendAction(false)]},
      retrying: sending,
      finished: accepted,
    });
  } finally {await h.close();}
});

test('#1205 a superseding publication without an act never reports the record screen as accepted', async () => {
  const h = await harness(true, 'interview-picks', true);
  try {
    h.comment('Check the timing', 'c1');
    const {post, submit} = await h.start();
    const inflight = h.read();
    const next = await h.fixture.republishPicture(readFileSync(new URL('./fixtures/viewport-387/package/mesh.png', import.meta.url)));
    h.event({type: 'published', publication: next.publication});
    expect(h.window.state().pending[0]).toMatchObject({askId: h.fixture.ask.askId, status: 'superseded'});
    expect(h.window.state().pending[0]?.act).toBeUndefined();
    const superseded = h.read();
    post.respond(Response.json({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE', message: 'publication superseded'}}, {status: 409}));
    await submit;
    for (const phase of [superseded, h.read()]) {
      expect(phase.status).not.toBe('Submitted');
    }
    expect(h.fixture.files).toHaveLength(0);
    await h.window.settled();
    expect(h.window.state().receipt?.publicationId).toBe(next.publication.publicationId);
    h.comment('Comment on republished picture', 'c2');
    expect({inflight, replacement: h.read()}).toMatchObject({inflight: sending, replacement: before});
  } finally {await h.close();}
});

test('#1228, #1229 and #1230 record sign-off, checkpoint and interview-picks publications and pending asks render no form, no opener and no error', async () => {
  for (const kind of ['signoff', 'checkpoint', 'interview-picks'] as const) {
    const h = await harness(false, kind, true);
    try {
      expect(h.window.state().error).toBeNull();
      const state = h.read();
      expect(state.form).toBe(false);
      expect(state.actions).toEqual([sendAction(true)]);
      expect(state.headline).toBe(commentMode);
    } finally {await h.close();}
  }
});

// #1228 / #1229 / #1230: the displayed record publication, not an ask, holds the right panel open and sets the comment-mode line.
for (const [name, kind, ask] of [['no pending ask', 'checkpoint', false], ['a pending sign-off subject', 'signoff', true], ['a pending checkpoint subject', 'checkpoint', true], ['a pending interview-picks subject', 'interview-picks', true]] as const)
  test(`#1228/#1229/#1230 a displayed record publication with ${name} keeps Comments open and never says it is waiting`, async () => {
    const h = await harness(false, kind, ask);
    try {
      expect(h.window.state().error).toBeNull();
      expect(h.window.state().receipt?.publicationId).toBe(h.fixture.ask.publicationId);
      const state = h.read();
      expect(state.headline).not.toBe(t('job.waiting', undefined, 'en'));
      expect(state).toMatchObject({row: true, communication: true, headline: commentMode, form: false, actions: [sendAction(true)]});
    } finally {await h.close();}
  });

test('#1227 fresh sign-off submissions refuse and historical sign-off acts still read', async () => {
  const f = await realJobWindowFixture();
  try {
    const publication = await f.publish();
    const displayed = await (await f.ui('displayed', {
      publicationId: publication.publicationId, pageId: 'signoff-refusal-page', sourceHash: publication.source.sourceHash,
    })).json() as JobResult<{displayedNonce: string}>;
    if (!displayed.ok) throw new Error(JSON.stringify(displayed));
    const response = await f.ui('acts', {
      submissionId: 'fresh-signoff-submission', publicationId: publication.publicationId,
      askId: 'made-up-signoff-ask', pageId: 'signoff-refusal-page',
      displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: f.host.session.status().generation,
      kind: 'signoff', value: {stage: 'plan-approved', decision: 'approved', words: ''},
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
  } finally {await f.close();}

  const h = await harness(false, 'signoff', true);
  try {
    if (h.fixture.ask.source.subject !== 'plan') throw new Error('Expected plan source');
    const {directionReview: _summary, ...binding} = h.fixture.ask.source;
    const historical: ActV3 = {
      schema: JOB_RECORD_ACT_SCHEMA, actId: 'historical-signoff-act', jobId: h.fixture.session.jobId,
      askId: h.fixture.ask.askId, publicationId: h.fixture.ask.publicationId, kind: 'signoff',
      at: '2026-11-08T12:00:00.000Z',
      authority: {actor: 'human', channel: 'review-ui', reviewer: {id: 'synthetic-owner', role: 'owner'}},
      source: binding,
      value: {stage: 'direction-review', decision: 'approved', words: '[general]\nHistorical sign-off'},
    };
    h.event({type: 'act', act: historical});
    expect(h.window.state().pending[0]).toMatchObject({askId: h.fixture.ask.askId, status: 'answered', act: historical});
    expect(h.read()).toEqual({
      row: true,
      communication: true,
      headline: commentMode,
      status: 'Submitted',
      statusKind: 'saved',
      form: false,
      formStatus: '',
      submitDisabled: true,
      actions: [sendAction(true)],
    });
  } finally {await h.close();}
});

test('#1227 viewer and comments work on a production-shaped publication when a producer omits or still sends a sign-off ask', async () => {
  const f = await realJobWindowFixture();
  try {
    expect(f.input.getContext().subjects).toContainEqual({kind: 'signoff', stage: 'plan-approved'});
    const publication = await f.publish();
    const entry = `${f.host.origin}/jobs/${f.host.session.jobId}/publications/${publication.publicationId}/instances/${publication.instanceKey}/`;
    const reviewApi = await fetch(entry + 'api/review', {headers: {'X-Review-Capability': f.credentials.ui}});
    expect(reviewApi.status).toBe(200);

    const displayed = await (await f.ui('displayed', {
      publicationId: publication.publicationId, pageId: 'prod-page', sourceHash: publication.source.sourceHash,
    })).json() as JobResult<{displayedNonce: string}>;
    if (!displayed.ok) throw new Error(JSON.stringify(displayed));

    const firstComment = await f.ui('acts', {
      submissionId: 'comment-without-signoff-ask', publicationId: publication.publicationId,
      pageId: 'prod-page', displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: f.host.session.status().generation,
      kind: 'comments', value: {comments: [{text: 'Viewer comment without sign-off ask'}]},
    });
    expect(firstComment.status).toBe(200);
    await expect(firstComment.json()).resolves.toMatchObject({
      ok: true, value: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, kind: 'comments', value: {comments: [{text: 'Viewer comment without sign-off ask'}]}},
    });

    const signoffAsk = await f.call({
      schema: JOB_API_SCHEMA, jobId: f.host.session.jobId, requestId: 'producer-signoff-ask',
      verb: 'ask', expectedGeneration: f.host.session.status().generation, idempotencyKey: 'producer-signoff-ask',
      publicationId: publication.publicationId, subject: {kind: 'signoff', stage: 'plan-approved'},
    });
    expect(signoffAsk.status).toBe(409);
    await expect(signoffAsk.json()).resolves.toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});

    const checkpointAsk = await f.call({
      schema: JOB_API_SCHEMA, jobId: f.host.session.jobId, requestId: 'producer-checkpoint-ask',
      verb: 'ask', expectedGeneration: f.host.session.status().generation, idempotencyKey: 'producer-checkpoint-ask',
      publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step-one'},
    });
    expect(checkpointAsk.status).toBe(409);
    await expect(checkpointAsk.json()).resolves.toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});

    const reviewAfterRefusal = await fetch(entry + 'api/review', {headers: {'X-Review-Capability': f.credentials.ui}});
    expect(reviewAfterRefusal.status).toBe(200);

    const secondComment = await f.ui('acts', {
      submissionId: 'comment-after-signoff-refusal', publicationId: publication.publicationId,
      pageId: 'prod-page', displayedNonce: displayed.value.displayedNonce,
      expectedGeneration: f.host.session.status().generation,
      kind: 'comments', value: {comments: [{text: 'Viewer comment after sign-off refusal'}]},
    });
    expect(secondComment.status).toBe(200);
    await expect(secondComment.json()).resolves.toMatchObject({
      ok: true, value: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, kind: 'comments', value: {comments: [{text: 'Viewer comment after sign-off refusal'}]}},
    });

    const next = await (await f.call({
      schema: JOB_API_SCHEMA, jobId: f.host.session.jobId, requestId: 'next-after-comments',
      verb: 'next', after: null, waitMs: 0,
    })).json();
    expect(next).toMatchObject({ok: true, value: {status: 'events', events: [
      {type: 'published', publication: {publicationId: publication.publicationId}},
      {type: 'act', act: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, kind: 'comments', value: {comments: [{text: 'Viewer comment without sign-off ask'}]}}},
      {type: 'act', act: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, kind: 'comments', value: {comments: [{text: 'Viewer comment after sign-off refusal'}]}}},
    ]}});
  } finally {await f.close();}
});

test('#1230 option-set publications render pictures and comments with no form across subjectless, refused-ask, and historical-subject cases', async () => {
  for (const mode of ['subjectless', 'historical-subject'] as const) {
    const fixture = await recordScreenFixture('interview-picks', false, undefined, undefined, false, true);
    const dom = await recordScreenDom();
    const previousLanguage = getLanguagePreference(), previousHost = rigHost();
    setLanguagePreference('en');
    dom.set('location', {origin: fixture.origin});
    const ui = mountActDom(dom);
    let screen: ReturnType<typeof mountRecordAct> | undefined;
    try {
      const realPorts = createJobHostPorts(fixture.session, fixture.origin);
      const realFront = createJobFront({
        origin: fixture.origin,
        ports: realPorts,
        publication: retainedPublicationRoutes(fixture.session),
        resource: jobWindowResources(),
      });
      let display = fixture.display;
      if (mode === 'subjectless') {
        // Publish a genuine subjectless option-set record on the real session, alongside the historical picks-subject record.
        (fixture.workspace as {context: object}).context = {...fixture.workspace.context, subjects: []};
        const publishRes = await realPorts.handleJobApi(new Request(`${fixture.origin}/jobs/${fixture.session.jobId}/api`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.session.hostCredentials().agent},
          body: JSON.stringify({
            schema: 'rig-review/job-api@3', jobId: fixture.session.jobId, requestId: 'publish-subjectless-1230',
            verb: 'publish', expectedGeneration: fixture.session.status().generation, idempotencyKey: 'publish-subjectless-1230',
            result: fixture.workspace.result,
            freeze: {kind: 'producer-held', holdId: 'subjectless-1230', record: fixture.workspace.record},
          }),
        }));
        const published = await publishRes.json() as {ok: boolean; value: {publicationId: string}};
        expect(published.ok).toBe(true);
        display = fixture.session.displayPublication(published.value.publicationId);
      }
      const access = jobWindowAccess(fixture.ownerUrl, null, () => {});
      const pageId = `test-1230-${mode}`;
      const routeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, fixture.origin);
        const headers = new Headers(init?.headers);
        if (init?.method === 'POST') headers.set('Origin', fixture.origin);
        return (await realFront.fetch(new Request(url, {...init, headers}))) ?? new Response(null, {status: 404});
      };
      const transport = createJobWindowTransport(access, Object.assign(routeFetch, {preconnect: fetch.preconnect}));
      const formNode: JobFormDependencies['node'] = (tag, key) => {
        const element = ui.node(tag);
        if (key) {element.dataset.jobText = key; element.textContent = t(key);}
        return element;
      };
      const drafts = createJobFormDrafts({jobId: access.jobId, current: () => view.mounted()?.record?.inspection ?? null,
        forms: () => view.mounted()?.record?.forms ?? new Map(), storage: () => ({setItem() {}})});
      const windowAccess = {state: () => window.state(), submit: (input: UISubmissionV3) => window.submit(input)};
      const view = createJobRigScreen({host: ui.app, access, pageId, translate: t, refusal: String, window: windowAccess,
        readPublication: transport.readPublication, routes: d => jobPublicationRoutes(d, fixture.origin),
        formDependencies: {node: formNode, translate: t, access, pageId, window: windowAccess, ...drafts, draftStorage: () => ({getItem: () => null}),
          helpers: {...createJobFormHelpers(formNode, t), assertJobAskSource: () => {}}},
        async load() {screen?.dispose(); screen = mountRecordAct(ui);}});
      const window = createJobWindow<JobRigScreenPrepared | null>({jobId: access.jobId, pageId, transport, adapter: {
        prepare: view.prepare, captureDraft: () => null, commit: prepared => view.commit(prepared!),
        painted: (prepared, signal) => view.painted(prepared!, signal), discard: prepared => prepared?.record?.inspection.dispose(), changed: view.changed,
      }});
      try {
        const generation = display.publication.generation;
        window.event({type: 'published', publication: display.publication, jobId: access.jobId, generation, cursor: String(generation)});
        await window.settled();
        expect(window.state().error).toBeNull();
        if (mode === 'historical-subject') {
          window.event({type: 'pending', ask: fixture.ask, jobId: access.jobId, generation: generation + 1, cursor: String(generation + 1)});
        }
        const readback = screen!.read();
        expect(readback).toMatchObject({
          row: true,
          headline: "We're looking at the work together. Leave your thoughts as comments.",
          form: false,
          actions: [sendAction(true)],
        });
        const host = rigHost()!;
        expect(host.record?.questionPictures).toHaveLength(1);
        expect(host.record?.questionPictures?.[0]?.src).toContain('/api/interview/image/');
        const imageResponse = await routeFetch(host.record!.questionPictures![0]!.src!);
        expect(imageResponse.status).toBe(200);

        // Old producer still sending a picks ask gets a named refusal (409 JOB_ASK_INVALID); comments still commit cleanly.
        const legacyAsk = await realPorts.handleJobApi(new Request(`${fixture.origin}/jobs/${fixture.session.jobId}/api`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.session.hostCredentials().agent},
          body: JSON.stringify({
            schema: 'rig-review/job-api@3', jobId: fixture.session.jobId, requestId: `legacy-picks-${mode}`,
            verb: 'ask', expectedGeneration: fixture.session.status().generation, idempotencyKey: `legacy-picks-${mode}`,
            publicationId: display.publication.publicationId,
            subject: {kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01'},
          }),
        }));
        expect(legacyAsk.status).toBe(409);
        await expect(legacyAsk.json()).resolves.toMatchObject({ok: false, error: {code: 'JOB_ASK_INVALID'}});

        const commentResult = await window.submit({
          kind: 'comments', publicationId: display.publication.publicationId, pageId,
          displayedNonce: window.state().receipt!.displayedNonce,
          expectedGeneration: generation,
          submissionId: `comment-${mode}`, value: {comments: [{text: `Option comment (${mode})`}]},
        });
        expect(commentResult).toMatchObject({
          ok: true, value: {schema: JOB_COMMENT_ONLY_ACT_SCHEMA, kind: 'comments', value: {comments: [{text: `Option comment (${mode})`}]}},
        });
      } finally {
        window.stop(); screen?.dispose(); view.mounted()?.record?.inspection.dispose();
      }
    } finally {
      setRigHost(previousHost); dom.restore(); setLanguagePreference(previousLanguage); await fixture.close();
    }
  }
});
