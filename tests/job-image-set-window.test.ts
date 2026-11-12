/** Decode and lifecycle controls use fake image decoders, without launching a browser. */
import {afterEach, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {createJobRigScreen,jobRigScreenRoute,jobRigScreenRefusal} from '../web/job-rig-screen.ts';
import {mountViewportPair} from '../web/viewport-pair.ts';
import {layerShortcuts, describeLayerToggles, inspectionViewSwitch, createViewControls, createRigLayerControls} from '../web/view-controls.ts';
import {SENTINELS} from '../web/parts-render.ts';
import {RigOverlays} from '../web/rig-overlays.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
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
  append(...nodes: (MountElement|string)[]) {
    for (const value of nodes) {const node=typeof value==='string'?new MountElement('#text'):value;if(typeof value==='string')node.textContent=value;node.parentElement=this;this.children.push(node);}
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
    if (selector.includes(',')) return selector.split(',').flatMap(part => this.querySelectorAll(part.trim()));
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
                    if (node.tagName === 'input') { node.type = token[2]!.match(/type="([^"]*)"/)?.[1] ?? ''; node.checked = /\bchecked\b/.test(token[2]!); node.disabled = /\bdisabled\b/.test(token[2]!); }
        stack.at(-1)!.append(node); if (node.tagName !== 'input') stack.push(node);
      }
    }
  }
}

test('#688 shared rig layer constructor preserves structure and job language bindings in EN and KO', async () => {
  setup();
  replaceGlobal('document',{createElement:(tag:string)=>new MountElement(tag)});
  const rig = createRigLayerControls();
  expect(rig.id).toBe('layer-controls');
  expect(rig.className).toBe('layer-toggles');
  expect(Array.from(rig.children).map(child => child.tagName.toLowerCase())).toEqual(['legend', 'label', 'label', 'label']);
  expect(Array.from(rig.querySelectorAll('input')).map(input => [input.id, input.type, input.checked, input.disabled]))
    .toEqual([['layer-images', 'checkbox', true, true], ['layer-mesh', 'checkbox', false, true], ['layer-bones', 'checkbox', false, true]]);
  for (const catalog of [enCatalog, koCatalog]) {
    const job = createRigLayerControls({jobText: true, translate: key => catalog[key] ?? key});
    expect(job.querySelector('legend')!.textContent).toBe(catalog['Rig layers']);
    for (const [index, item] of layerShortcuts.entries()) {
      const label = job.querySelectorAll('label')[index]!;
      expect(Array.from(label.children).map(child => child.tagName.toLowerCase())).toEqual(['input', 'span', 'kbd']);
      expect(label.querySelector('span')!.textContent).toBe(catalog[item.label]);
      expect((label.querySelector('span') as HTMLElement).dataset.jobText).toBe(item.label);
      expect(label.querySelector('kbd')!.textContent).toBe(item.key.toUpperCase());
    }
  }
});

test('#774 the shared source host names a missing direction instead of rebuilding a part selector',()=>{
 const f=setup(),display=fixturePublication(),source=display.publication.source;
 if(source.subject==='image-set')throw new Error('Expected model fixture');
 for(const slots of [['body','arm'],[]]){
  const before=structuredClone(slots);
  const post={...display,publication:{...display.publication,source:{...source,selector:{kind:'post' as const,version:1,rigVersion:1},direction:null}}};
  expect(jobRigScreenRefusal(post,[],new Set())).toBe('JOB_DIRECTION_MISSING');
  expect(slots).toEqual(before);expect(f.metadata.feedbackCatalog.slots).toBeNull();
 }
});

test('#772 shared image preparation waits for every sealed member and routes image verdicts only',async()=>{
 const f=setup(),ask={askId:'image',publicationId:f.display.publication.publicationId,source:f.source,status:'pending' as const,subject:{kind:'review-verdict' as const,stage:'image-review' as const}};
 expect(jobRigScreenRoute(f.display,[ask],new Set())).toBe(true);
 expect(jobRigScreenRoute(f.display,[{...ask,subject:{kind:'review-verdict',stage:'rig-review'}}],new Set())).toBe(false);
 const screen=createJobRigScreen({host:{} as HTMLElement,pageId:'image-page',access:{capability:'synthetic',headers:()=>new Headers()},
  window:{state:()=>({pending:[ask],receipt:null,generation:1,preparing:true,closed:false}),submit:async()=>({ok:false,error:{code:'JOB_ACT_INVALID',message:'JOB_ACT_INVALID'}})},
  routes:()=>({entry:'http://127.0.0.1:19484/',api:path=>path}),refusal:()=>'',translate:key=>key,load:async()=>{}});
 let returned=false;const preparing=screen.prepare(f.display,new AbortController().signal).then(result=>{returned=true;return result;});
 await until(()=>f.images.length===2);f.images[0]!.resolve();await Bun.sleep(1);expect(returned).toBe(false);f.images[1]!.resolve();
 const result=await preparing;expect(result?.images?.imageSetImages?.map(image=>image.alt)).toEqual(['Source','Candidate']);expect(result?.record).toBeUndefined();expect(result?.modals).toBeUndefined();result!.images!.dispose();
});

for(const kind of ['model','parts','direction'] as const)test('#774 missing '+kind+' prepares the existing empty host without preloading a picture',async()=>{
 const f=setup(),display=fixturePublication(),source=display.publication.source;
 if(source.subject==='image-set')throw new Error('Expected model fixture');
 const input={...display,publication:{...display.publication,source:{...source,model:kind==='direction'?source.model:null,selector:kind==='parts'?{kind:'draft' as const,id:'missing'}:kind==='direction'?{kind:'post' as const,version:2,rigVersion:1}:null}}};
 f.metadata.sourceHash=input.publication.source.sourceHash;
 if(kind==='direction')f.metadata.reviewedSource={...f.metadata.reviewedSource,rig:{path:source.model!.path,sha256:source.model!.sha256} as never};
 f.metadata.capabilities={playback:kind==='direction',preRig:kind==='parts'} as never;
 const screen=createJobRigScreen({host:{} as HTMLElement,pageId:'empty',access:{capability:'fixture',headers:init=>new Headers(init)},window:{state:()=>({pending:[],receipt:null,generation:1,preparing:false,closed:false}),submit:async()=>{throw Error('No authority invented');}},routes:d=>({entry:d.routes.entry,api:path=>d.routes.apiBase+path}),translate:key=>key,refusal:String,formDependencies:{} as never,load:async()=>{}});
 const prepared=await screen.prepare(input,new AbortController().signal);
 expect(prepared!.record!.picture).toBeNull();expect(prepared!.record!.forms.size).toBe(0);
 expect(prepared!.refusal).toBe(kind==='model'?'JOB_MODEL_MISSING':kind==='parts'?'JOB_PARTS_MISSING':'JOB_DIRECTION_MISSING');
 expect(f.requests).toHaveLength(1);expect(f.requests[0]).toEndWith('/api/review');prepared!.record!.inspection.dispose();
});
