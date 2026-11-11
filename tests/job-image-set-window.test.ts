/** Decode and lifecycle controls use fake image decoders, without launching a browser. */
import {afterEach, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {mountViewportPair} from '../web/viewport-pair.ts';
import {layerShortcuts, describeLayerToggles, createViewControls} from '../web/view-controls.ts';
import {SENTINELS} from '../web/parts-render.ts';
import {RigOverlays} from '../web/rig-overlays.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {jobHash} from '../src/job-api.ts';
import {prepareJobImageSet} from '../src/job-image-set.ts';
import {parseManifest} from '../src/manifest.ts';
import {createJobWindow, prepareJobInspection, type JobInspectionMetadata, type JobPreparedInspection} from '../web/job-session.ts';
import {fixturePublication} from './helpers/job-window-fixture.ts';
import type {JobImageSourceBinding} from '../src/job-contract.ts';

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(key: string, value: unknown) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
}
afterEach(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  savedGlobals.clear();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await Bun.sleep(1);
  expect(check()).toBe(true);
}
function setup() {
  const bytes = new Uint8Array([1, 2, 3]);
  const bound = prepareJobImageSet({purpose: 'plate-adoption', images: [
    {role: 'source', name: 'Source', path: 'source.png'},
    {role: 'candidate', name: 'Candidate', path: 'candidate.png'}]}, () => bytes);
  const display = {...fixturePublication()};
  const fixtureSource = display.publication.source;
  if (fixtureSource.subject === 'image-set' || !fixtureSource.model) throw new Error('Expected model fixture source');
  const {model, selector, checkpointEvidence, ...common} = fixtureSource;
  expect(checkpointEvidence).toBeUndefined();
  const source: JobImageSourceBinding = {...common, subject: 'image-set', ...bound};
  display.publication = {...display.publication, source};
  const metadata: JobInspectionMetadata = {
    manifest: parseManifest({schema: 'rig-review/1', ...source.package, title: 'Synthetic image comparison'}),
    sourceHash: source.sourceHash,
    reviewedSource: {packageRevision: source.package.revision, viewerVersion: 'synthetic', runtimeVersion: 'synthetic', rig: null, motion: null},
    capabilities: {playback: false}, feedbackCatalog: {slots: null},
  };
  const images: FakeImage[] = [];
  class FakeImage {
    src = '';
    alt = '';
    naturalWidth = 32;
    naturalHeight = 32;
    resolve!: () => void;
    reject!: (error: Error) => void;
    constructor() {images.push(this);}
    decode() {return new Promise<void>((resolve, reject) => {this.resolve = resolve; this.reject = reject;});}
  }
  const requests: string[] = [];
  replaceGlobal('location', {origin: 'http://127.0.0.1:19484'});
  replaceGlobal('document', {createElement: () => ({id: ''})});
  replaceGlobal('Image', FakeImage);
  replaceGlobal('fetch', async (input: string) => {
    requests.push(input);
    if (input.endsWith('/api/review')) return Response.json(metadata);
    if (/\/api\/image-set\/[01]$/.test(input)) return new Response(bytes);
    throw new Error('Unexpected synthetic request');
  });
  return {display, source, metadata, images, bytes, requests};
}

test('522 every image decodes before prepare returns and array order survives reversed completion', async () => {
  const f = setup();
  let returned = false;
  const preparing = prepareJobInspection(f.display, new AbortController().signal).then(result => {returned = true; return result;});
  await until(() => f.images.length === 2);
  expect(returned).toBe(false);
  f.images[1].resolve(); await Bun.sleep(1);
  expect(returned).toBe(false);
  f.images[0].resolve();
  const prepared = await preparing;
  expect(prepared.imageSetImages?.map(image => image.alt)).toEqual(['Source', 'Candidate']);
  expect(f.requests.filter(path => path.includes('/image-set/'))).toEqual([
    'http://127.0.0.1:19484' + f.display.routes.apiBase + 'image-set/0',
    'http://127.0.0.1:19484' + f.display.routes.apiBase + 'image-set/1']);
  prepared.dispose();
});

test('522 display acknowledgment waits for all decoded images and the painted lifecycle boundary', async () => {
  const f = setup(); let acknowledged = false, painting = false;
  let finishPaint!: () => void;
  const painted = new Promise<void>(resolve => {finishPaint = resolve;});
  const window = createJobWindow({jobId: 'window-fixture', pageId: 'synthetic-page', transport: {
    async readPublication() {return {ok: true, value: f.display};},
    async acknowledge() {acknowledged = true; return {ok: true, value: {
      publicationId: f.display.publication.publicationId, pageId: 'synthetic-page', displayedNonce: 'synthetic-nonce'}};},
    async submit() {return {ok: false, error: {code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID'}};},
  }, adapter: {
    prepare: prepareJobInspection, captureDraft: () => null,
    commit: () => ({rollback() {}, finalize() {}}),
    async painted() {painting = true; await painted;},
    discard: prepared => prepared.dispose(), changed() {},
  }});
  try {
    window.event({type: 'published', cursor: 'synthetic-cursor', jobId: 'window-fixture', generation: 1,
      publication: f.display.publication});
    await until(() => f.images.length === 2);
    expect(acknowledged).toBe(false); expect(window.state().receipt).toBe(null);
    for (const image of f.images) image.resolve();
    await until(() => painting);
    expect(acknowledged).toBe(false); expect(window.state().receipt).toBe(null);
    finishPaint(); await window.settled();
    expect(acknowledged).toBe(true); expect(window.state().receipt?.displayedNonce).toBe('synthetic-nonce');
  } finally {window.stop();}
});

test('522 an invalid set digest or image byte hash refuses before a decoded display is available', async () => {
  const f = setup();
  f.display.publication = {...f.display.publication, source: {...f.source, imageSetDigest: '0'.repeat(64)}};
  await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('JOB_SOURCE_MISMATCH');
  const imageSet = {...f.source.imageSet, images: f.source.imageSet.images.map(image => ({...image, sha256: '0'.repeat(64)}))};
  const imageSetDigest = jobHash(JSON.stringify(imageSet.images.map(({role, name, sha256}) => ({role, name, sha256}))));
  f.display.publication = {...f.display.publication, source: {...f.source, imageSet, imageSetDigest}};
  await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('JOB_SOURCE_MISMATCH');
  expect(f.images).toHaveLength(0);
});

test('522 the frozen old parser body matches its recorded original-function provenance', async () => {
  const fixture = await readFile(new URL('./fixtures/job-image-set/old-subject-parser.ts', import.meta.url), 'utf8');
  const provenance = await Bun.file(new URL('./fixtures/job-image-set/old-parser-provenance.json', import.meta.url)).json();
  const body = fixture.slice(fixture.indexOf('export function parseJobSubject(')).replace(/\n+$/, '') + '\n';
  expect(Buffer.byteLength(body)).toBe(provenance.functionBytes);
  expect(jobHash(body)).toBe(provenance.originalFunctionSha256);
  expect(provenance.originalFunctionSha256).toBe(provenance.fixtureFunctionSha256);
  expect(provenance.byteIdentical).toBe(true);
});

/** DOM double for the production build body and its real shared viewport-pair mount. */
class MountElement extends EventTarget {
  id = '';
  className = '';
  hidden = false;
  disabled = false;
  checked = false;
  title = '';
  value = '';
  type = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: MountElement[] = [];
  parentElement: MountElement | null = null;
  private text = '';
  constructor(readonly tagName: string) {super();}
  closest(selector: string): MountElement | null {
    return this.tagName === selector ? this : this.parentElement?.closest(selector) ?? null;
  }
  // There is no drawing surface in this DOM-only build fixture.
  getContext(): null {return null;}
  get textContent(): string {return this.text + this.children.map(child => child.textContent).join('');}
  set textContent(value: string) {this.text = value; this.children = [];}
  append(...nodes: MountElement[]) {
    for (const node of nodes) {node.parentElement = this; this.children.push(node);}
  }
  prepend(...nodes: MountElement[]) {
    for (const node of nodes) node.parentElement = this;
    this.children.unshift(...nodes);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  replaceWith(node: MountElement) {
    const parent = this.parentElement;
    if (!parent) throw new Error('Missing mount parent');
    parent.children.splice(parent.children.indexOf(this), 1, node);
    node.parentElement = parent; this.parentElement = null;
  }
  setAttribute(name: string, value: string) {
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
  }
  querySelector(selector: string): MountElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): MountElement[] {
    const result: MountElement[] = [];
    for (const child of this.children) {
      if (selector.startsWith('#') ? child.id === selector.slice(1) :
          selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  set innerHTML(markup: string) {
    this.children = []; this.text = '';
    const stack: MountElement[] = [this];
    for (const token of markup.matchAll(/<\/?([a-z][a-z0-9]*)([^>]*)>|([^<]+)/g)) {
      if (token[3]) {const text = new MountElement('#text'); text.textContent = token[3]; stack.at(-1)!.append(text);}
      else if (token[0].startsWith('</')) stack.pop();
      else {
        const node = new MountElement(token[1]!);
        for (const attribute of token[2]!.matchAll(/([a-z-]+)="([^"]*)"/g)) node.setAttribute(attribute[1]!, attribute[2]!);
        node.hidden = /\bhidden\b/.test(token[2]!);
        stack.at(-1)!.append(node); stack.push(node);
      }
    }
  }
}

async function actualBuildBody() {
  const source = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('job-session.ts', source, ts.ScriptTarget.Latest, true);
  let body: string | undefined;
  let gallery: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'build') body = node.getText(parsed);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'imageGallery') gallery = node.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!body || !gallery) throw new Error('Production build/gallery body missing');
  return gallery + '\n' + body;
}

function mountActualBuild(body: string, prepared: JobPreparedInspection): MountElement {
  const translate = (key: string) => enCatalog[key] ?? key;
  const node = (tag: string, key?: string) => {
    const element = new MountElement(tag);
    if (key) {element.dataset.jobText = key; element.textContent = translate(key);}
    return element;
  };
  const inputLabel = (key: string, input: MountElement) => {const label = node('label'); label.append(node('span', key), input); return label;};
  const selectValues = (values: string[], keys: string[]) => {
    const select = node('select');
    for (const [index, value] of values.entries()) {const option = node('option', keys[index]); option.value = value; select.append(option);}
    return select;
  };
  replaceGlobal('HTMLElement', MountElement);
  replaceGlobal('document', {createElement: node, createTextNode: (text: string) => {const node = new MountElement('#text'); node.textContent = text; return node;}});
  // Execute the actual nested production build body, without adding a product test seam.
  const javascript = new Bun.Transpiler({loader: 'ts'}).transformSync(body);
  const build = new Function('deps', `
    const {node, inputLabel, selectValues, mountViewportPair, t, layerShortcuts, createViewControls,
      describeLayerToggles, SENTINELS, RigOverlays} = deps;
    let loop = true, stageBackground = '';
    const layers = {images: true, mesh: false, bones: false, meshOpacity: 0.65};
    const i18n = {tr: t}, overlays = new WeakMap();
    ${javascript}
    return build;
  `)({node, inputLabel, selectValues, mountViewportPair, t: translate, layerShortcuts, createViewControls,
    describeLayerToggles, SENTINELS, RigOverlays}) as (prepared: JobPreparedInspection) => MountElement;
  const host = node('main'); host.append(build(prepared));
  return host;
}

function buildFixture(f: ReturnType<typeof setup>): JobPreparedInspection {
  const rigRoot = new MountElement('div'); rigRoot.id = 'rig-root';
  return {display: f.display, metadata: f.metadata, interview: null, parts: null,
    partImages: new Map(), interviewImages: new Map(), references: [], assets: null, player: null,
    rigRoot: rigRoot as unknown as HTMLElement,
    imageSetImages: f.source.imageSet.images.map(() => new MountElement('img') as unknown as HTMLImageElement),
    inspection: null, setupPose() {}, dispose() {}};
}

test('522 production build mounts a real-null image catalog and its viewport pair; the original unguarded loop fails', async () => {
  const f = setup(), body = await actualBuildBody();
  expect(f.metadata.feedbackCatalog.slots).toBe(null);
  const prepared = buildFixture(f);
  let disposed = 0;
  prepared.dispose = () => {disposed++;};
  const mounted = mountActualBuild(body, prepared);
  expect(mounted.querySelector('.job-inspection')).not.toBe(null);
  expect(mounted.querySelector('#reference-pane')).not.toBe(null);
  expect(mounted.querySelector('#rig-root')).not.toBe(null);
  expect(mounted.querySelector('#stage-layout')?.hidden).toBe(true);
  expect(mounted.querySelector('#job-part')?.disabled).toBe(true);
  expect(mounted.querySelectorAll('figure').map(figure => figure.dataset.imageName)).toEqual(['Source', 'Candidate']);
  expect(mounted.querySelector('#job-part')?.children.map(option => option.value)).toEqual(['']);
  for (const item of layerShortcuts) {
    const box = mounted.querySelector('#' + item.id);
    expect(box?.disabled).toBe(true);
    expect(box?.checked).toBe(item.id === 'layer-images');
    expect(box?.closest('label')?.title).toBe(enCatalog['No rig supplied']);
  }
  expect(mounted.querySelector('#job-background')?.children.map(option => option.value)).toEqual(['', ...Object.keys(SENTINELS)]);
  expect(mounted.querySelector('#rig-overlay')?.style.pointerEvents).toBe('none');
  prepared.dispose();
  expect(disposed).toBe(1);
  expect(mounted.querySelector('#rig-overlay')?.style.pointerEvents).toBeUndefined();
  const guarded = 'for (const slot of prepared.metadata.feedbackCatalog.slots ?? [])';
  expect(body).toContain(guarded);
  const originalLoop = body.replace(guarded, 'for (const slot of prepared.metadata.feedbackCatalog.slots)');
  expect(() => mountActualBuild(originalLoop, buildFixture(f))).toThrow(TypeError);
});

test('522 production build preserves populated and known-empty model slot arrays', async () => {
  const f = setup(), body = await actualBuildBody();
  for (const slots of [['body', 'arm'], []]) {
    const prepared = buildFixture(f);
    prepared.display = fixturePublication();
    prepared.metadata = {...f.metadata, manifest: {...f.metadata.manifest, model: 'skeleton.model.json'}, feedbackCatalog: {slots}};
    const mounted = mountActualBuild(body, prepared), parts = mounted.querySelector('#job-part');
    expect(parts?.disabled).toBe(false);
    expect(parts?.children.map(option => option.value)).toEqual(['', ...slots]);
    expect(mounted.querySelectorAll('figure')).toHaveLength(0);
    expect(mounted.querySelector('#stage-layout')?.hidden).toBe(false);
    prepared.dispose();
  }
});
