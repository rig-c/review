import {expect, test} from 'bun:test';
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
async function host(kind: 'owner', savedCapability?: string) {
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
  const location = new URL(origin + ('/?workspace=' + incarnation) + '#cap=' + capability);
  const values = new Map<string, string>(), requests: {path: string; init?: RequestInit}[] = [];
  if (savedCapability !== undefined) {location.hash = ''; values.set('rig-review-owner-workspace/1:' + origin, savedCapability);}
  const targets = ['a', 'b'].map(key => ({key, contentHash: key.repeat(64), title: key.toUpperCase(), mode: 'single', animation: null,
    viewOnly: false, unavailable: null, entry: '/instances/' + key.repeat(64) + '/?workspace=' + incarnation}));
  const timers = new Map<number, {callback: () => void; delay: number}>(), sockets: {closed: boolean}[] = [];
  let timerId = 0;
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
      return Response.json({schema: WORKSPACE_SCHEMA, incarnation, targets});
    },
  };
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {old.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});}
  let stop: (() => void) | undefined;
  return {root, frames, messages, requests, targets, values, location, timers, events, documentEvents, sockets,
    async mount() {stop = mountOwnerWorkspace(root); await tick();},
    async settle() {await tick();},
    async waitForFrame() {for (let i = 0; !frames.length && i < 100; i++) await Bun.sleep(1); await tick();},
    openSocket() {for (const [id, timer] of timers) if (timer.delay === 0) {timers.delete(id); timer.callback();}},
    stop() {stop!();},
    close() {
      stop?.();
      for (const [key, descriptor] of old) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
      setLinkLanguage(linkLanguage); setLanguagePreference(language);
    },
  };
}

for (const kind of ['owner'] as const) {
  test(kind + ' mount retains exact host markup, handoff and language/visibility behavior', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame();
      expect(h.root.children.map((node: any) => [node.tagName, node.className])).toEqual([
        ['HEADER', 'owner-header'], ['NAV', 'owner-list'], ['MAIN', 'owner-stage'],
      ]);
      const status = h.root.children[0].children[1];
      expect(status.className).toBe('owner-status');
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(h.location.hash).toBe(''); expect(h.frames).toHaveLength(1);
      expect(h.requests[0]!.init?.headers).toEqual({'X-Review-Capability': capability});
      const frame = h.frames[0], first = h.messages[0]!;
      expect(frame.hidden).toBe(false); expect(frame.inert).toBe(false); expect(frame.getAttribute('aria-hidden')).toBe('false');
      expect(first.hidden).toBe(true); expect(first.origin).toBe(origin);
      expect(Object.keys(first.data)).toEqual(['schema', 'incarnation', 'key', 'sourceHash', 'visible', 'language']);
      expect(first.data.schema).toBe(WORKSPACE_VISIBILITY_SCHEMA);
      {
        const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(capability), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
        const token = Buffer.from(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(WORKSPACE_TARGET_DOMAIN + '\0' + incarnation + '\0a'))).toString('hex');
        expect(frame.src).toBe(h.targets[0]!.entry + '&lang=en#cap=' + token);
      }
      frame.hidden = true; frame.inert = true; h.messages.length = 0;
      setLanguagePreference('ko');
      expect(frame.hidden).toBe(true); expect(frame.inert).toBe(true);
      expect(h.messages).toHaveLength(1); expect(h.messages[0]!.data).toMatchObject({visible: true, language: 'ko'});
      const list = h.root.children[1];
      expect(list.children[0].getAttribute('aria-pressed')).toBe('true');
      expect(h.root.children[0].children[0].textContent).toBe('검토 작업 공간');
    } finally {h.close();}
  });

  test(kind + ' ready validates source identity and disposal removes listeners, timers and pending requests', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame(); h.openSocket();
      const frame = h.frames[0]; h.messages.length = 0;
      const data = {schema: WORKSPACE_READY_SCHEMA, incarnation, key: 'a', sourceHash: 'a'.repeat(64)};
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
      expect(h.sockets.map(socket => socket.closed)).toEqual([true]);
      h.messages.length = 0;
      setLanguagePreference('ko'); expect(h.messages).toHaveLength(0);
      const event = new Event('message'); Object.assign(event, {origin, source: frame.contentWindow, data}); h.events.dispatchEvent(event);
      expect(h.messages).toHaveLength(0); expect(h.frames).toHaveLength(1);
    } finally {h.close();}
  });
}


test('owner keeps the original title, inspection state and animation rather than substituting source metadata', async () => {
  const h = await host('owner');
  h.targets[0]!.title = 'Existing target'; h.targets[0]!.animation = 'idle' as never;
  h.targets[0]!.viewOnly = true; h.targets[0]!.mode = 'compare';
  try {
    await h.mount(); await h.waitForFrame();
    const list = h.root.children[1];
    expect(list.children[0].children.map((node: any) => node.textContent)).toEqual(['Existing target', 'Inspection only', 'idle']);
    setLanguagePreference('ko');
    expect(list.children[0].children.map((node: any) => node.textContent)).toEqual(['Existing target', t('Inspection only'), 'idle']);
  } finally {h.close();}
});

test('owner mount preserves malformed stored capability transmission', async () => {
  const h = await host('owner', 'historical malformed value');
  try {await h.mount(); await h.waitForFrame(); expect(h.requests[0]!.init?.headers).toEqual({'X-Review-Capability': 'historical malformed value'});}
  finally {h.close();}
});


for (const kind of ['owner'] as const) {
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
    refused.targets[0]!.unavailable = 'WORKSPACE_REQUEST_REFUSED' as never;
    try {
      await refused.mount(); expect(refused.frames).toHaveLength(0);
      expect(refused.root.children[1].children[0].getAttribute('aria-pressed')).toBe('false');
    } finally {refused.close();}
  });
}
