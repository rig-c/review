import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {entryHtml, playBuildConditions} from '../src/build.ts';
import {mountOwnerWorkspace} from '../web/owner-workspace.ts';
import {WORKSPACE_READY_SCHEMA, WORKSPACE_SCHEMA, WORKSPACE_VISIBILITY_SCHEMA, WORKSPACE_TARGET_DOMAIN} from '../src/open-workspace-contract.ts';
import {getLanguagePreference, getLinkLanguage, setLanguagePreference, setLinkLanguage, t, unbindDomI18n} from '../web/i18n.ts';
import {bindWorkspaceVisibility, WORKSPACE_LANGUAGE_CHOICE_SCHEMA, WORKSPACE_MODE_REQUEST_SCHEMA, WORKSPACE_MODE_STATE_SCHEMA} from '../web/workspace-visibility.ts';
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
  const {doc, root: html} = await statusDom(), events = new Events(), documentEvents = new Events();
  const language = getLanguagePreference(), linkLanguage = getLinkLanguage();
  setLinkLanguage(null); setLanguagePreference('en');
  const frames: any[] = [], messages: {frame: any; data: any; origin: string; hidden: boolean; inert: boolean}[] = [];
  const observers: {callback: () => void; disconnected: boolean}[] = [];
  const originalCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const element = originalCreate(tag);
    element.classList.add = (name: string) => {if (!element.classList.contains(name)) element.className = `${element.className} ${name}`.trim();};
    element.querySelector = (selector: string) => selector.startsWith('#')
      ? element.querySelectorAll('*').find((node: any) => node.id === selector.slice(1)) ?? null
      : element.querySelectorAll(selector)[0] ?? null;
    element.click = () => {if (!element.disabled) element.onclick?.();};
    if (tag === 'select') Object.defineProperty(element, 'options', {get: () => element.children});
    if (tag === 'iframe') {
      element.contentWindow = {postMessage(data: unknown, origin: string) {messages.push({frame: element, data, origin, hidden: element.hidden, inert: element.inert});}};
      frames.push(element);
    }
    return element;
  };
  const body = doc.createElement('body'), root = doc.createElement('div');
  html.append(body); body.append(root); doc.body = body;
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
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    ResizeObserver: class {observe() {} disconnect() {}},
    MutationObserver: class {
      disconnected = false;
      constructor(public callback: () => void) {observers.push(this);}
      observe() {}
      disconnect() {this.disconnected = true;}
    },
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
  return {root, frames, messages, requests, targets, values, location, timers, events, documentEvents, sockets, observers,
    list() {return root.querySelector('.owner-list');},
    modes() {return root.querySelector('.mode-switch').querySelectorAll('button');},
    receive(frame: any, data: object, change: object = {}) {
      const event = new Event('message'); Object.assign(event, {origin, source: frame.contentWindow, data}, change); events.dispatchEvent(event);
    },
    async mount() {stop = mountOwnerWorkspace(root); await tick();},
    async settle() {await tick();},
    async waitForFrame() {for (let i = 0; !frames.length && i < 100; i++) await Bun.sleep(1); await tick();},
    openSocket() {for (const [id, timer] of timers) if (timer.delay === 0) {timers.delete(id); timer.callback();}},
    stop() {stop!();},
    close() {
      stop?.();
      unbindDomI18n();
      for (const [key, descriptor] of old) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
      setLinkLanguage(linkLanguage); setLanguagePreference(language);
    },
  };
}

test('#655 slice 3: a retained rig supplies the shared owner header and its hint is in the footer', async () => {
  const h = await host('owner');
  try {
    await h.mount(); await h.waitForFrame();
    expect(h.root.children.map((node: any) => node.tagName)).toEqual(['HEADER', 'DIV', 'FOOTER']);
    const [header, layout, footer] = h.root.children;
    expect(header.className).toBe('topbar');
    expect(header.querySelectorAll('strong')[0].textContent).toBe('A');
    expect(header.querySelectorAll('select').map((node: any) => node.children.map((option: any) => option.textContent))).toEqual([['En', 'Kr']]);
    expect(layout.querySelectorAll('h2')[0].textContent).toBe('Targets · 2');
    expect(footer.querySelectorAll('.status-message')[0].textContent).toBe('Select a target. Drafts stay with their original source.');
    expect(h.frames[0].dataset.stageEmbed).toBe('owner');
    expect(h.frames[0].src.split('&lang=')[0]).toBe(h.targets[0]!.entry);
  } finally {h.close();}
});

for (const kind of ['owner'] as const) {
  test(kind + ' mount retains exact handoff and language/visibility behavior', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame();
      expect(h.root.children.map((node: any) => [node.tagName, node.className])).toEqual([
        ['HEADER', 'topbar'], ['DIV', 'layout workspace-layout'], ['FOOTER', 'status-bar'],
      ]);
      const status = h.root.children[2].children[0];
      expect(status.className).toBe('status-message');
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
      const list = h.list();
      expect(list.children[0].getAttribute('aria-pressed')).toBe('true');
      expect(h.root.children[1].querySelector('h2').textContent).toBe('대상 · 2');
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
    const list = h.list();
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

test('owner reflects modes only from the bound retained rig and directs clicks to the selected frame', async () => {
  const h = await host('owner');
  const state = (mode: number) => Array.from({length: 3}, (_, index) => ({pressed: index === mode, disabled: index === 2, title: null}));
  const data = {schema: WORKSPACE_MODE_STATE_SCHEMA, incarnation, key: 'a', sourceHash: 'a'.repeat(64), modes: state(1)};
  const active = () => h.modes().find((button: any) => button.getAttribute('aria-pressed') === 'true')?.dataset.mode;
  try {
    await h.mount(); await h.waitForFrame();
    const [a] = h.frames;
    expect(h.modes().every((button: any) => button.disabled)).toBe(true);
    for (const change of [{origin: origin + '1'}, {source: {}}, {data: {...data, incarnation: 'stale'}},
      {data: {...data, key: 'b'}}, {data: {...data, sourceHash: 'changed'}}, {data: {...data, modes: [true]}},
      {data: {...data, modes: new Array(3)}},
      {data: {...data, modes: state(1).map(mode => ({...mode, pressed: true}))}}]) h.receive(a, data, change);
    expect(active()).toBeUndefined();
    h.receive(a, data);
    expect(active()).toBe('playback');
    h.messages.length = 0;
    h.modes()[2].click();
    h.modes()[0].click();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({frame: a, origin, data: {schema: WORKSPACE_MODE_REQUEST_SCHEMA,
      incarnation, key: 'a', sourceHash: data.sourceHash, mode: 'rig'}});
    expect(active()).toBe('playback');
    h.list().children[1].click();
    for (let i = 0; h.frames.length < 2 && i < 100; i++) await Bun.sleep(1);
    const b = h.frames[1];
    h.receive(b, {...data, key: 'b', sourceHash: 'b'.repeat(64), modes: state(0)});
    h.receive(a, {...data, modes: state(1).map((mode, i) => i === 1 ? {...mode, pressed: false, disabled: true, title: 'Model unavailable'} : mode)});
    expect(active()).toBe('rig');
    h.messages.length = 0;
    const picker = h.root.children[0].querySelector('select');
    picker.value = 'ko'; picker.onchange();
    expect(h.messages.map(({frame, data, origin}) => [h.frames.indexOf(frame), data.visible, data.language, origin])).toEqual([
      [0, false, 'ko', origin], [1, true, 'ko', origin],
    ]);
    h.list().children[0].click();
    expect(h.frames).toEqual([a, b]);
    expect(active()).toBeUndefined();
    expect(h.modes()[1].disabled).toBe(true);
    expect(h.modes()[1].getAttribute('aria-description')).toBe('Model unavailable');
  } finally {h.close();}
});

test('legacy Compare retains its URL and language handoff without taking the outer mode switch', async () => {
  const h = await host('owner');
  h.targets[0]!.mode = 'compare';
  try {
    await h.mount(); await h.waitForFrame();
    const [frame] = h.frames;
    expect(frame.dataset.stageEmbed).toBeUndefined();
    expect(frame.dataset.workspaceLocale).toBe('legacy-compare');
    expect(frame.src.split('&lang=')[0]).toBe(h.targets[0]!.entry);
    expect(h.root.children[0].querySelector('strong').textContent).toBe('A');
    expect(h.root.children[0].querySelector('.mode-switch').hidden).toBe(true);
    h.receive(frame, {schema: WORKSPACE_MODE_STATE_SCHEMA, incarnation, key: 'a', sourceHash: 'a'.repeat(64),
      modes: Array.from({length: 3}, () => ({pressed: false, disabled: false, title: null}))});
    h.messages.length = 0;
    h.modes()[0].click();
    setLanguagePreference('ko');
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]!.data).toMatchObject({schema: WORKSPACE_VISIBILITY_SCHEMA, visible: true, language: 'ko'});
  } finally {h.close();}
});

test('only the selected legacy Compare can change the owner language for retained frames', async () => {
  const h = await host('owner');
  h.targets[0]!.mode = 'compare';
  try {
    await h.mount(); await h.waitForFrame();
    h.list().children[1].click();
    for (let i = 0; h.frames.length < 2 && i < 100; i++) await Bun.sleep(1);
    expect(h.frames).toHaveLength(2);
    const [compare, rig] = h.frames;
    const choice = {schema: WORKSPACE_LANGUAGE_CHOICE_SCHEMA, incarnation, key: 'a', sourceHash: 'a'.repeat(64), language: 'ko'};
    const picker = h.root.children[0].querySelector('select');
    h.messages.length = 0;
    h.receive(compare, choice);
    h.receive(rig, {...choice, key: 'b', sourceHash: 'b'.repeat(64)});
    expect(picker.value).toBe('en');
    expect(h.messages).toHaveLength(0);

    h.list().children[0].click();
    h.messages.length = 0;
    for (const change of [{origin: origin + '1'}, {source: rig.contentWindow}, {data: {...choice, incarnation: 'stale'}},
      {data: {...choice, key: 'b'}}, {data: {...choice, sourceHash: 'stale'}}, {data: {...choice, language: 'system'}}]) {
      h.receive(compare, choice, change);
    }
    expect(picker.value).toBe('en');
    expect(h.messages).toHaveLength(0);
    h.receive(compare, choice);
    expect(picker.value).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
    expect(h.messages.map(({frame, data, origin}) => [h.frames.indexOf(frame), data.visible, data.language, origin])).toEqual([
      [0, true, 'ko', origin], [1, false, 'ko', origin],
    ]);
  } finally {h.close();}
});

test('marked Compare consumes owner language, then reports only an explicit visible picker change', async () => {
  const h = await host('owner'), outgoing: {data: object; destination: string}[] = [];
  const parent = {postMessage: (data: object, destination: string) => outgoing.push({data, destination})};
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'parent');
  Object.defineProperty(globalThis, 'parent', {configurable: true, value: parent});
  let stop: (() => void) | undefined;
  try {
    const picker = document.createElement('select'), pickerEvents = new Events();
    picker.id = 'settings-language'; picker.value = 'en'; h.root.append(picker);
    picker.addEventListener = pickerEvents.addEventListener.bind(pickerEvents);
    picker.removeEventListener = pickerEvents.removeEventListener.bind(pickerEvents);
    const frame = document.createElement('div');
    frame.setAttribute('data-workspace-locale', 'legacy-compare');
    Object.assign(h.events, {frameElement: frame});
    const identity = {incarnation, key: 'a'.repeat(64), sourceHash: 'b'.repeat(64)};
    h.location.pathname = `/instances/${identity.key}/`;
    const binding = {...identity, pause() {}};
    const visibility = {schema: WORKSPACE_VISIBILITY_SCHEMA, ...identity, visible: true, language: 'ko'};
    stop = bindWorkspaceVisibility(binding);
    expect(outgoing).toEqual([{data: {schema: WORKSPACE_READY_SCHEMA, ...identity}, destination: origin}]);
    h.receive({contentWindow: parent}, visibility, {source: {}});
    expect(picker.value).toBe('en');
    h.receive({contentWindow: parent}, visibility);
    expect(picker.value).toBe('ko');
    expect(getLinkLanguage()).toBe('ko');
    setLanguagePreference('en');
    expect(document.documentElement.lang).toBe('ko');
    expect(outgoing).toHaveLength(1);

    picker.value = 'en'; pickerEvents.dispatchEvent(new Event('change'));
    expect(outgoing[1]).toEqual({data: {schema: WORKSPACE_LANGUAGE_CHOICE_SCHEMA, ...identity, language: 'en'}, destination: origin});
    h.receive({contentWindow: parent}, {...visibility, visible: false});
    expect(picker.value).toBe('ko');
    picker.value = 'en'; pickerEvents.dispatchEvent(new Event('change'));
    expect(outgoing).toHaveLength(2);
    stop!();
    expect(pickerEvents.count('change')).toBe(0);

    frame.removeAttribute('data-workspace-locale');
    stop = bindWorkspaceVisibility(binding);
    h.receive({contentWindow: parent}, visibility);
    expect(picker.value).toBe('en');
    expect(document.documentElement.lang).toBe('ko');
    expect(getLinkLanguage()).toBeNull();
    pickerEvents.dispatchEvent(new Event('change'));
    expect(outgoing).toHaveLength(3);
  } finally {
    stop?.();
    if (prior) Object.defineProperty(globalThis, 'parent', prior); else Reflect.deleteProperty(globalThis, 'parent');
    h.close();
  }
});

test('embedded rig accepts only visible, enabled mode requests from its bound parent and reports local changes', async () => {
  const h = await host('owner'), outgoing: any[] = [], selected: string[] = [];
  const parent = {postMessage: (data: object, destination: string) => outgoing.push({data, destination})};
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'parent');
  Object.defineProperty(globalThis, 'parent', {configurable: true, value: parent});
  try {
    const {document} = globalThis;
    const group = document.createElement('div');
    const buttons = ['rig', 'playback', 'compare'].map(mode => {
      const button = document.createElement('button'); button.dataset.mode = mode; button.disabled = mode === 'compare';
      button.onclick = () => {selected.push(mode);}; group.append(button); return button;
    });
    const identity = {incarnation, key: 'a', sourceHash: 'a'.repeat(64)};
    let paused = 0;
    const stop = bindWorkspaceVisibility({...identity, modeSwitch: group, pause: () => {paused++;}});
    const observer = h.observers.at(-1)!;
    expect(outgoing.map(({data, destination}) => [data.schema, destination])).toEqual([[WORKSPACE_READY_SCHEMA, origin], [WORKSPACE_MODE_STATE_SCHEMA, origin]]);
    const command = {schema: WORKSPACE_MODE_REQUEST_SCHEMA, ...identity, mode: 'playback'};
    const visibility = {schema: WORKSPACE_VISIBILITY_SCHEMA, ...identity, visible: true, language: 'ko'};
    h.receive({contentWindow: parent}, command);
    h.receive({contentWindow: parent}, visibility, {origin: 'http://other.test'});
    h.receive({contentWindow: parent}, command);
    expect(selected).toEqual([]);
    h.receive({contentWindow: parent}, visibility);
    expect(getLinkLanguage()).toBe('ko');
    for (const change of [{origin: 'http://other.test'}, {source: {}}, {data: {...command, incarnation: 'old'}},
      {data: {...command, key: 'b'}}, {data: {...command, sourceHash: 'stale'}},
      {data: {...command, mode: 'compare'}}, {data: {...command, mode: 'anything'}}]) h.receive({contentWindow: parent}, command, change);
    expect(selected).toEqual([]);
    h.receive({contentWindow: parent}, command);
    expect(selected).toEqual(['playback']);
    buttons[0]!.setAttribute('aria-pressed', 'true');
    observer.callback(); observer.callback();
    expect(outgoing).toHaveLength(3);
    expect(outgoing[2].data.modes[0].pressed).toBe(true);
    h.receive({contentWindow: parent}, {...visibility, visible: false});
    h.receive({contentWindow: parent}, command);
    expect(paused).toBe(1);
    expect(selected).toEqual(['playback']);
    stop!();
    expect(observer.disconnected).toBe(true);
    expect(h.events.count('message')).toBe(0);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'parent', prior); else Reflect.deleteProperty(globalThis, 'parent');
    h.close();
  }
});

for (const kind of ['owner'] as const) {
  test(kind + ' switching retains each original frame and preserves closed versus unavailable selection behavior', async () => {
    const h = await host(kind);
    try {
      await h.mount(); await h.waitForFrame(); const first = h.frames[0];
      h.list().children[1].onclick();
      for (let i = 0; h.frames.length < 2 && i < 100; i++) await Bun.sleep(1);
      await h.settle(); expect(h.frames).toHaveLength(2);
      const second = h.frames[1];
      expect(first.hidden).toBe(true); expect(first.inert).toBe(true); expect(second.hidden).toBe(false);
      h.list().children[0].onclick(); await h.settle();
      expect(h.frames).toEqual([first, second]); expect(first.hidden).toBe(false); expect(second.hidden).toBe(true);
    } finally {h.close();}
    const refused = await host(kind);
    refused.targets[0]!.unavailable = 'WORKSPACE_REQUEST_REFUSED' as never;
    try {
      await refused.mount(); expect(refused.frames).toHaveLength(0);
      expect(refused.list().children[0].getAttribute('aria-pressed')).toBe('false');
      expect(refused.root.children[2].children[0].textContent).toBe('WORKSPACE_REQUEST_REFUSED');
    } finally {refused.close();}
  });
}

test('#655 slice 2: main boot mounts owner workspace only with data-review-screen="workspace" and never double mounts', async () => {
  const mainPath = fileURLToPath(new URL('../web/main.ts', import.meta.url));
  const anchor = 'export function mountRigScreen():{dispose():void} {';
  const mainSource = await readFile(mainPath, 'utf8');
  expect(mainSource.split(anchor)).toHaveLength(2);
  const conditions = playBuildConditions();
  const built = await Bun.build({
    entrypoints: [mainPath], target: 'browser', format: 'esm', ...(conditions.length ? {conditions} : {}),
    plugins: [{name: 'boot-rig-probe', setup(build) {
      build.onLoad({filter: /[/\\]web[/\\]main\.ts$/}, () => ({
        loader: 'ts',
        contents: mainSource.replace(anchor, anchor + '\nif ((globalThis as any).__rigMountProbe) return (globalThis as any).__rigMountProbe();'),
      }));
    }}],
  });
  expect(built.success).toBe(true);
  const bundleCode = await built.outputs[0]!.text();
  let run = 0;

  // With the workspace marker on #app at /, main's boot mounts the owner workspace once and does not mount the rig screen.
  const markedHtml = await entryHtml('workspace');
  expect(markedHtml).toContain('<div id="app" data-review-screen="workspace"></div>');
  {
    const h = await host('owner');
    let rigMounts = 0;
    const prevProbe = Object.getOwnPropertyDescriptor(globalThis, '__rigMountProbe');
    Object.defineProperty(globalThis, '__rigMountProbe', {configurable: true, writable: true, value: () => {rigMounts++; return {dispose() {}};}});
    try {
      const app = (globalThis as any).document.createElement('div');
      app.id = 'app'; app.dataset.reviewScreen = 'workspace'; app.setAttribute('data-review-screen', 'workspace');
      h.root.append(app);
      await import('data:text/javascript;base64,' + Buffer.from(`${bundleCode}\n// boot=${++run}`).toString('base64'));
      await h.waitForFrame();
      expect(rigMounts).toBe(0);
      expect(app.children.map((node: any) => [node.tagName, node.className])).toEqual([
        ['HEADER', 'topbar'], ['DIV', 'layout workspace-layout'], ['FOOTER', 'status-bar'],
      ]);
      expect(h.frames).toHaveLength(1);
      h.events.dispatchEvent(new Event('pagehide'));
    } finally {
      if (prevProbe) Object.defineProperty(globalThis, '__rigMountProbe', prevProbe);
      else Reflect.deleteProperty(globalThis, '__rigMountProbe');
      h.close();
    }
  }

  // Without the marker at /, neither owner-workspace import nor main's boot mounts the owner workspace.
  const unmarkedHtml = await entryHtml('rig');
  expect(unmarkedHtml).toContain('<div id="app"></div>');
  {
    const h = await host('owner');
    let rigMounts = 0;
    const prevProbe = Object.getOwnPropertyDescriptor(globalThis, '__rigMountProbe');
    Object.defineProperty(globalThis, '__rigMountProbe', {configurable: true, writable: true, value: () => {rigMounts++; return {dispose() {}};}});
    try {
      const app = (globalThis as any).document.createElement('div');
      app.id = 'app';
      h.root.append(app);
      await import('data:text/javascript;base64,' + Buffer.from(`${bundleCode}\n// boot=${++run}`).toString('base64'));
      await h.settle();
      expect(app.children).toHaveLength(0);
      expect(h.requests).toHaveLength(0);
      expect(h.sockets).toHaveLength(0);
      expect(rigMounts).toBe(1);
    } finally {
      if (prevProbe) Object.defineProperty(globalThis, '__rigMountProbe', prevProbe);
      else Reflect.deleteProperty(globalThis, '__rigMountProbe');
      h.close();
    }
  }
});
