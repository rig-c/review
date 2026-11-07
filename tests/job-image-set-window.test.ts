/** Decode and lifecycle controls use fake image decoders, without launching a browser. */
import {afterEach, expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {jobHash} from '../src/job-api.ts';
import {prepareJobImageSet} from '../src/job-image-set.ts';
import {parseManifest} from '../src/manifest.ts';
import {createJobWindow, prepareJobInspection, type JobInspectionMetadata} from '../web/job-session.ts';
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
  const {model, selector, ...common} = display.publication.source;
  const source: JobImageSourceBinding = {...common, subject: 'image-set', ...bound};
  display.publication = {...display.publication, source};
  const metadata: JobInspectionMetadata = {
    manifest: parseManifest({schema: 'rig-review/1', ...source.package, title: 'Synthetic image comparison'}),
    sourceHash: source.sourceHash,
    reviewedSource: {packageRevision: source.package.revision, viewerVersion: 'synthetic', runtimeVersion: 'synthetic', rig: null, motion: null},
    capabilities: {playback: false}, feedbackCatalog: {slots: []},
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
