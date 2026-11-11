import {expect, test} from 'bun:test';
import {mountJobHub, JOB_HUB_READY, JOB_HUB_VISIBILITY} from '../web/job-hub.ts';
import {mountOwnerWorkspace} from '../web/owner-workspace.ts';
import {WORKSPACE_READY_SCHEMA, WORKSPACE_SCHEMA, WORKSPACE_VISIBILITY_SCHEMA, WORKSPACE_TARGET_DOMAIN} from '../src/open-workspace-contract.ts';
import {getLanguagePreference, getLinkLanguage, setLanguagePreference, setLinkLanguage, t} from '../web/i18n.ts';
import {statusDom} from './helpers/workspace-status-dom.ts';

const origin = 'http://127.0.0.1:4318', incarnation = '12345678-1234-1234-1234-123456789abc', capability = 'c'.repeat(64);
const tick = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
class Events extends EventTarget {
  handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type)!.add(listener);}
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.handlers.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  count(type: string) {return this.handlers.get(type)?.size ?? 0;}
}

/** Real mounts and existing test DOM; no browser or alternate product renderer. */
async function host(kind: 'hub' | 'owner', savedCapability?: string) {
  const {doc, root} = await statusDom(), events = new Events(), documentEvents = new Events();
  const language = getLanguagePreference(), linkLanguage = getLinkLanguage();
  setLinkLanguage(null); setLanguagePreference('en');
  const frames: any[] = [], messages: {frame: any; data: any; origin: string; hidden: boolean; inert: boolean}[] = [];
  const originalCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const element = originalCreate(tag);
    if (tag === 'select') Object.defineProperty(element, 'options', {get: () => element.children});
    if (tag === 'iframe') {
      element.contentWindow = {postMessage(data: unknown, origin: string) {messages.push({frame: element, data, origin, hidden: element.hidden, inert: element.inert});}};
      frames.push(element);
    }
    return element;
  };
  doc.addEventListener = documentEvents.addEventListener.bind(documentEvents);
  doc.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
  const location = new URL(origin + (kind === 'hub' ? '/hub/?workspace=' + incarnation : '/?workspace=' + incarnation) + '#cap=' + capability);
  const values = new Map<string, string>(), requests: {path: string; init?: RequestInit}[] = [];
  if (savedCapability !== undefined) {location.hash = ''; values.set('rig-review-owner-workspace/1:' + origin, savedCapability);}
  const targets = ['a', 'b'].map(key => ({key, contentHash: key.repeat(64), title: key.toUpperCase(), mode: 'single', animation: null,
    viewOnly: false, unavailable: null, entry: '/instances/' + key.repeat(64) + '/?workspace=' + incarnation}));
  const jobs = ['a', 'b'].map(jobId => ({jobId, generation: 0, status: 'active', pendingCount: 0, publication: null}));
  const timers = new Map<number, {callback: () => void; delay: number}>(), sockets: {closed: boolean}[] = [];
  let timerId = 0, delayOpen: Promise<void> | undefined;
  const globals = {
    document: doc, window: events, location,
    history: {state: {}, replaceState(_state: unknown, _title: string, href: string) {location.href = href;}},
    sessionStorage: {getItem: (slot: string) => values.get(slot) ?? null, setItem: (slot: string, value: string) => {values.set(slot, value);}},
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setTimeout: (callback: () => void, delay: number) => {timers.set(++timerId, {callback, delay}); return timerId;},
    clearTimeout: (id: number) => {timers.delete(id);},
    WebSocket: class {
      static CLOSED = 3; static CLOSING = 2; readyState = 1; closed = false;
      constructor(_url: string) {sockets.push(this);}
      close() {this.closed = true;}
    },
    fetch: async (path: string, init?: RequestInit) => {
      requests.push({path, init});
      if (path.endsWith('/open')) {await delayOpen; return Response.json({schema: 'rig-review-job-hub/1', incarnation,
        jobId: path.split('/')[4], entry: '/jobs/' + path.split('/')[4] + '/?hub=' + incarnation, capability});}
      return Response.json(kind === 'hub' ? {schema: 'rig-review-job-hub/1', incarnation, limit: 32, jobs} : {schema: WORKSPACE_SCHEMA, incarnation, targets});
    },
  };
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});}
  let stop: (() => void) | undefined;
  return {root, frames, messages, requests, targets, jobs, values, location, timers, events, documentEvents, sockets,
    async mount() {stop = kind === 'hub' ? await mountJobHub(root) : mountOwnerWorkspace(root); await tick();},
    async settle() {await tick();},
    async waitForFrame() {for (let i = 0; !frames.length && i < 100; i++) await Bun.sleep(1); await tick();},
    openSocket() {for (const [id, timer] of timers) if (timer.delay === 0) {timers.delete(id); timer.callback();}},
    delayOpen(value: Promise<void>) {delayOpen = value;},
    stop() {stop!();},
    close() {
      stop?.();
      for (const [key, descriptor] of old) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
      setLinkLanguage(linkLanguage); setLanguagePreference(language);
    },
  };
}

for (const kind of ['hub', 'owner'] as const) {
  test(kind + ' mount retains exact host markup, handoff and language/visibility behavior', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame();
      expect(h.root.children.map((node: any) => [node.tagName, node.className])).toEqual([
        ['HEADER', kind === 'hub' ? 'hub-header' : 'owner-header'],
        ['NAV', kind === 'hub' ? 'hub-list' : 'owner-list'],
        ['MAIN', kind === 'hub' ? 'hub-stage' : 'owner-stage'],
        ['FOOTER', 'status-bar'],
      ]);
      expect(h.location.hash).toBe(''); expect(h.frames).toHaveLength(1);
      expect(h.requests[0]!.init?.headers).toEqual({'X-Review-Capability': capability});
      const frame = h.frames[0], first = h.messages[0]!;
      expect(frame.hidden).toBe(false); expect(frame.inert).toBe(false); expect(frame.getAttribute('aria-hidden')).toBe('false');
      expect(first.hidden).toBe(kind === 'owner'); expect(first.origin).toBe(origin);
      expect(Object.keys(first.data)).toEqual(kind === 'hub' ? ['incarnation', 'jobId', 'publicationId', 'sourceHash', 'schema', 'visible', 'language'] : ['schema', 'incarnation', 'key', 'sourceHash', 'visible', 'language']);
      expect(first.data.schema).toBe(kind === 'hub' ? JOB_HUB_VISIBILITY : WORKSPACE_VISIBILITY_SCHEMA);
      if (kind === 'hub') expect(frame.src).toBe(origin + '/jobs/a/?hub=' + incarnation + '&lang=en#cap=' + capability);
      else {
        const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(capability), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
        const token = Buffer.from(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(WORKSPACE_TARGET_DOMAIN + '\0' + incarnation + '\0a'))).toString('hex');
        expect(frame.src).toBe(h.targets[0]!.entry + '&lang=en#cap=' + token);
      }
      frame.hidden = true; frame.inert = true; h.messages.length = 0;
      setLanguagePreference('ko');
      expect(frame.hidden).toBe(kind === 'owner'); expect(frame.inert).toBe(kind === 'owner');
      expect(h.messages).toHaveLength(1); expect(h.messages[0]!.data).toMatchObject({visible: true, language: 'ko'});
      const list = h.root.children[1];
      expect(list.children[0].getAttribute('aria-pressed')).toBe('true');
      expect(h.root.children[0].children[0].textContent).toBe(kind === 'hub' ? t('job.hubTitle') : '검토 작업 공간');
    } finally {h.close();}
  });

  test(kind + ' ready validates source identity and disposal removes listeners, timers and pending requests', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame(); h.openSocket();
      const frame = h.frames[0]; h.messages.length = 0;
      const data = kind === 'hub' ? {schema: JOB_HUB_READY, incarnation, jobId: 'a', publicationId: null, sourceHash: null}
        : {schema: WORKSPACE_READY_SCHEMA, incarnation, key: 'a', sourceHash: 'a'.repeat(64)};
      for (const change of [{origin: origin + '1'}, {source: {}}, {data: {...data, sourceHash: 'wrong'}}, {}]) {
        const event = new Event('message'); Object.assign(event, {origin, source: frame.contentWindow, data}, change); h.events.dispatchEvent(event);
      }
      expect(h.messages).toHaveLength(1);
      expect(h.events.count('message')).toBe(1); expect(h.events.count('pagehide')).toBe(1);
      expect(h.timers.size).toBe(1);
      h.stop(); h.stop();
      expect(h.timers.size).toBe(0); expect(h.events.count('message')).toBe(0); expect(h.events.count('pagehide')).toBe(0);
      expect(h.documentEvents.count('visibilitychange')).toBe(0);
      expect(h.requests.every(request => request.init?.signal?.aborted)).toBe(true);
      expect(h.sockets.map(socket => socket.closed)).toEqual(kind === 'owner' ? [true] : []);
      h.messages.length = 0;
      setLanguagePreference('ko'); expect(h.messages).toHaveLength(0);
      const event = new Event('message'); Object.assign(event, {origin, source: frame.contentWindow, data}); h.events.dispatchEvent(event);
      expect(h.messages).toHaveLength(0); expect(h.frames).toHaveLength(1);
    } finally {h.close();}
  });
}

test('owner mount preserves malformed stored capability transmission rather than silently adopting hub validation', async () => {
  const h = await host('owner', 'historical malformed value');
  try {await h.mount(); await h.waitForFrame(); expect(h.requests[0]!.init?.headers).toEqual({'X-Review-Capability': 'historical malformed value'});}
  finally {h.close();}
});

test('hub ignores a delayed grant after disposal and owns no live socket', async () => {
  const h = await host('hub'); let finish!: () => void;
  h.delayOpen(new Promise<void>(resolve => {finish = resolve;}));
  try {await h.mount(); expect(h.frames).toHaveLength(0); h.stop(); finish(); await h.settle(); expect(h.frames).toHaveLength(0); expect(h.timers.size).toBe(0); expect(h.sockets).toHaveLength(0);}
  finally {h.close();}
});

for (const kind of ['hub', 'owner'] as const) {
  test(kind + ' switching retains each original frame and preserves closed versus unavailable selection behavior', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame(); const first = h.frames[0];
      h.root.children[1].children[1].onclick();
      for (let i = 0; h.frames.length < 2 && i < 100; i++) await Bun.sleep(1);
      await h.settle(); expect(h.frames).toHaveLength(2);
      const second = h.frames[1];
      expect(first.hidden).toBe(true); expect(first.inert).toBe(true); expect(second.hidden).toBe(false);
      h.root.children[1].children[0].onclick(); await h.settle();
      expect(h.frames).toEqual([first, second]); expect(first.hidden).toBe(false); expect(second.hidden).toBe(true);
    } finally {h.close();}
    const refused = await host(kind);
    if (kind === 'hub') for (const job of refused.jobs) job.status = 'closed';
    else refused.targets[0]!.unavailable = 'WORKSPACE_REQUEST_REFUSED' as never;
    try {
      await refused.mount(); expect(refused.frames).toHaveLength(0);
      if (kind === 'hub') {
        const group = refused.root.children[1].children[0];
        expect(group.tagName).toBe('DETAILS');
        expect(group.open).toBe(false);
        expect(group.children[1].getAttribute('aria-pressed')).toBe('true');
      } else {
        expect(refused.root.children[1].children[0].getAttribute('aria-pressed')).toBe('false');
      }
    } finally {refused.close();}
  });
}

test('hub and owner rows render kind, label and 8-char hash while the C11 status bar holds the full 64-char hash and answered items collapse', async () => {
  const hashA = 'a1b2c3d4' + 'e'.repeat(56), hashB = 'f0e1d2c3' + '9'.repeat(56), hashC = '11223344' + '8'.repeat(56);
  const hubHost = await host('hub');
  hubHost.jobs.splice(0, hubHost.jobs.length,
    {jobId: 'job_internal_answered', generation: 3, status: 'active', pendingCount: 0, subjectKind: 'parts', answered: true,
      publication: {publicationId: 'pub-a', instanceKey: '1'.repeat(64), sourceHash: hashA, label: 'Soldier parts draft'}} as any,
    {jobId: 'job_internal_waiting', generation: 2, status: 'active', pendingCount: 1, subjectKind: 'rig', answered: false,
      publication: {publicationId: 'pub-b', instanceKey: '2'.repeat(64), sourceHash: hashB, label: 'Soldier rig v15'}} as any,
    {jobId: 'job_internal_closed', generation: 4, status: 'closed', pendingCount: 0, subjectKind: 'checkpoint', answered: false,
      publication: {publicationId: 'pub-c', instanceKey: '3'.repeat(64), sourceHash: hashC, label: 'Step 3 gate'}} as any,
  );
  try {
    await hubHost.mount(); await hubHost.waitForFrame();
    const list = hubHost.root.children[1], footer = hubHost.root.children[3];
    // Waiting subject comes first and is auto-selected; answered + closed subjects sit in one collapsed <details> group at the end.
    expect(list.children.map((node: any) => node.tagName)).toEqual(['BUTTON', 'DETAILS']);
    const waitingRow = list.children[0], details = list.children[1];
    expect(waitingRow.getAttribute('aria-pressed')).toBe('true');
    expect(waitingRow.children.map((node: any) => node.textContent)).toEqual(['Rig', 'f0e1d2c3', 'Soldier rig v15']);
    expect(waitingRow.textContent).not.toContain('job_internal');
    expect(waitingRow.textContent).not.toContain(hashB);
    expect(footer.children[2].textContent).toBe(hashB);
    expect(details.open).toBe(false);
    expect(details.getAttribute('open')).toBeNull();
    expect(details.children[0].tagName).toBe('SUMMARY');
    expect(details.children[0].textContent).toBe('Answered (2)');
    expect(details.children[1].children.map((node: any) => node.textContent)).toEqual(['Parts', 'a1b2c3d4', 'Soldier parts draft']);
    expect(details.children[2].children.map((node: any) => node.textContent)).toEqual(['Checkpoint', '11223344', 'Step 3 gate']);
    setLanguagePreference('ko');
    const koDetails = list.children[1];
    expect(list.children[0].children.map((node: any) => node.textContent)).toEqual(['리그', 'f0e1d2c3', 'Soldier rig v15']);
    expect(koDetails.children[0].textContent).toBe('완료됨 (2)');
    expect(koDetails.children[1].children[0].textContent).toBe('파츠');
    expect(koDetails.children[2].children[0].textContent).toBe('체크포인트');
    expect(footer.children[2].textContent).toBe(hashB);
  } finally {hubHost.close();}

  const ownerHost = await host('owner');
  ownerHost.targets[0]!.contentHash = hashA;
  ownerHost.targets[0]!.title = 'Hero package';
  try {
    await ownerHost.mount(); await ownerHost.waitForFrame();
    const row = ownerHost.root.children[1].children[0], footer = ownerHost.root.children[3];
    expect(row.children.map((node: any) => node.textContent)).toEqual(['Review target', 'a1b2c3d4', 'Hero package']);
    expect(footer.children[2].textContent).toBe(hashA);
  } finally {ownerHost.close();}
});
