import {expect, test} from 'bun:test';
import type {RigPlayer} from '@rig-c/play';
import {createCanvas} from '@napi-rs/canvas';
import {PNG} from 'pngjs';
import {readFileSync} from 'node:fs';
import {restoreStillOracle} from './helpers/job-still-observation.ts';
import type {JobRigPresentation} from '../web/viewport-capture.ts';
import {recordJobRigDraw, freezeJobRigCapture, createJobRigSubmission, copyJobRigViewport, jobRigPixelPlacement, jobRigDrawState, type JobRigDrawState} from '../web/job-rig-capture.ts';

const firstPng = 'data:image/png;base64,Zmlyc3Q=';
const laterPng = 'data:image/png;base64,bGF0ZXI=';

/** Synthetic public-player state and pixel-copy boundaries, not browser pixel evidence. */
function view() {
  let pauses = 0;
  let loop = true;
  let duration = 1;
  let customEntry: (() => ReturnType<RigPlayer['entry']>) | undefined;
  const player: {
    generation: number;
    current: string | null;
    time: number;
    slots: RigPlayer['slots'];
    renderer: object;
    pause(): void;
    entry(track?: number): ReturnType<RigPlayer['entry']>;
  } = {
    generation: 7,
    current: 'inspect',
    time: 0,
    slots: null,
    renderer: {},
    pause() {pauses++;},
    entry(track = 0) {
      if (track !== 0) return null;
      if (customEntry) return customEntry();
      if (player.current === null) return null;
      const trackTime = player.time;
      const animationTime = duration > 0 ? (loop ? trackTime % duration : Math.min(trackTime, duration)) : 0;
      return {animation: player.current, loop, trackTime, animationTime, duration, alpha: 1, additive: false};
    },
  };
  const presentation: JobRigPresentation = {canvas: {} as HTMLCanvasElement, width: 2, height: 2, ratio: 1,
    area: {x: 0, y: 0, width: 2, height: 2}};
  const state: JobRigDrawState = {player, presentation, frameGeneration: 7,
    source: {publicationId: 'publication-1', instanceKey: 'instance-1', sourceHash: 'a'.repeat(64), pageId: 'page-1'},
    layout: 'layout-1', defaultCamera: true, wholeRig: true, playing: true};
  return {
    state,
    player,
    pauses: () => pauses,
    setClip(options: {loop?: boolean; duration?: number}) {
      if (options.loop !== undefined) loop = options.loop;
      if (options.duration !== undefined) duration = options.duration;
    },
    setEntry(fn: (() => ReturnType<RigPlayer['entry']>) | undefined) {
      customEntry = fn;
    },
  };
}

function submission() {
  return {publicationId: 'publication-1', askId: 'ask-1', pageId: 'page-1', displayedNonce: 'nonce-1',
    expectedGeneration: 4, submissionId: 'submission-1', kind: 'review-verdict' as const,
    value: {stage: 'rig-review' as const, verdict: 'approved' as const, words: ' \n원문 그대로\t '}};
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => {resolve = done;});
  return {promise, resolve};
}

test('#557 UI freezes numeric zero and named playing frame before async encoding without pause', async () => {
  const v = view(), gate = deferred<string>();
  const draw = recordJobRigDraw(v.state, 1);
  let copied = 0, encoded = 0;
  const frozen = freezeJobRigCapture(draw, v.state, 'ask-1', () => {
    copied++;
    return {width: 2, height: 2, encode() {encoded++; return gate.promise;}};
  });
  expect(copied).toBe(1);
  expect(encoded).toBe(0);
  const pending = frozen.encode();
  expect(encoded).toBe(1);
  v.player.generation = 8;
  v.player.time = 0.375;
  v.player.current = 'later';
  v.state.layout = 'layout-2';
  gate.resolve(firstPng);
  const capture = await pending;
  expect(capture).toMatchObject({png: firstPng, frame: 0, animation: 'inspect', playing: true,
    width: 2, height: 2, camera: 'fixed', framing: 'default', view: 'whole-rig',
    binding: {publicationId: 'publication-1', instanceKey: 'instance-1', sourceHash: 'a'.repeat(64),
      pageId: 'page-1', askId: 'ask-1', drawGeneration: 1, playerGeneration: 7}});
  expect(v.pauses()).toBe(0);
});

test('#557 UI setup remains distinct from animation zero', async () => {
  const v = view();
  v.player.current = null;
  v.state.playing = false;
  const frozen = freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, 'ask-1',
    () => ({width: 2, height: 2, encode: async () => firstPng}));
  const capture = await frozen.encode();
  expect(capture.frame).toBe('setup');
  expect(capture).not.toHaveProperty('animation');
});

for (const mismatch of ['player', 'renderer', 'generation', 'held-frame', 'animation', 'time', 'layout',
  'presentation', 'publicationId', 'instanceKey', 'sourceHash', 'pageId'] as const) {
  test(`#557 UI ${mismatch} mismatch refuses before pixel copy`, () => {
    const v = view(), draw = recordJobRigDraw(v.state, 1);
    if (mismatch === 'player') v.state.player = {...v.player};
    else if (mismatch === 'renderer') v.player.renderer = {};
    else if (mismatch === 'generation') v.player.generation++;
    else if (mismatch === 'held-frame') v.state.frameGeneration = 6;
    else if (mismatch === 'animation') v.player.current = 'other';
    else if (mismatch === 'time') v.player.time = 0.5;
    else if (mismatch === 'layout') v.state.layout = 'changed-layout';
    else if (mismatch === 'presentation') v.state.presentation = {...v.state.presentation!};
    else v.state.source = {...v.state.source, [mismatch]: 'changed-source'};
    let copies = 0;
    expect(() => freezeJobRigCapture(draw, v.state, 'ask-1', () => {
      copies++;
      return {width: 2, height: 2, encode: async () => firstPng};
    })).toThrow('JOB_STILL_BINDING_MISMATCH');
    expect(copies).toBe(0);
  });
}

for (const mode of ['pan', 'zoom', 'solo', 'highlight', 'comparison'] as const) {
  test(`#557 UI ${mode} refuses by camera or view name`, () => {
    const v = view(), draw = recordJobRigDraw(v.state, 1);
    const camera = mode === 'pan' || mode === 'zoom';
    if (camera) v.state.defaultCamera = false;
    else v.state.wholeRig = false;
    expect(() => freezeJobRigCapture(draw, v.state, 'ask-1', () => {
      throw new Error('must not copy');
    })).toThrow(camera ? 'JOB_STILL_CAMERA_NOT_FIXED' : 'JOB_STILL_VIEW_UNSUPPORTED');
  });
}

test('#557 UI missing successful draw, unseen pose and active slot filter refuse', () => {
  const v = view();
  const pixels = () => ({width: 2, height: 2, encode: async () => firstPng});
  expect(() => freezeJobRigCapture(undefined, v.state, 'ask-1', pixels)).toThrow('JOB_STILL_CAPTURE_FAILED');
  v.state.frameGeneration = undefined;
  expect(() => recordJobRigDraw(v.state, 1)).toThrow('JOB_STILL_CAPTURE_FAILED');
  v.state.frameGeneration = 7;
  const draw = recordJobRigDraw(v.state, 1);
  v.player.slots = ['body'];
  expect(() => freezeJobRigCapture(draw, v.state, 'ask-1', pixels)).toThrow('JOB_STILL_VIEW_UNSUPPORTED');
});

test('#557 UI draw mutation during synchronous copy refuses', () => {
  const v = view(), draw = recordJobRigDraw(v.state, 1);
  expect(() => freezeJobRigCapture(draw, v.state, 'ask-1', () => {
    v.player.generation++;
    return {width: 2, height: 2, encode: async () => firstPng};
  })).toThrow('JOB_STILL_BINDING_MISMATCH');
});

for (const [width, height] of [[16385, 1], [4097, 4097], [0, 2]]) {
  test(`#557 UI ${width}x${height} refuses instead of downscaling`, () => {
    const v = view();
    expect(() => freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, 'ask-1',
      () => ({width, height, encode: async () => firstPng}))).toThrow('JOB_STILL_CAPTURE_FAILED');
  });
}

test('#557 UI oversized PNG encoding refuses', async () => {
  const v = view();
  const frozen = freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, 'ask-1',
    () => ({width: 2, height: 2, encode: async () => 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024)}));
  await expect(frozen.encode()).rejects.toThrow('JOB_STILL_CAPTURE_FAILED');
});

test('#557 UI reply-loss retry reuses full first request after human, clock and view changes', async () => {
  const v = view(), cache = createJobRigSubmission(), gate = deferred<string>(), input = submission();
  let copies = 0;
  const first = cache.prepare(input, () => {
    copies++;
    return freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, input.askId,
      () => ({width: 2, height: 2, encode: () => gate.promise}));
  });
  input.value.words = 'changed after submit';
  input.expectedGeneration = 9;
  v.player.time = 0.75;
  v.state.layout = 'later-view';
  gate.resolve(firstPng);
  const saved = await first;
  const replay = await cache.prepare(input, () => {throw new Error('must reuse first capture');});
  expect(replay).toBe(saved);
  expect(replay.value).toHaveProperty('words', ' \n원문 그대로\t ');
  expect(replay.expectedGeneration).toBe(4);
  expect(replay.capture).toMatchObject({png: firstPng, frame: 0, animation: 'inspect'});
  expect(Object.isFrozen(replay)).toBe(true);
  expect(Object.isFrozen(replay.value)).toBe(true);
  expect(Object.isFrozen(replay.capture?.binding)).toBe(true);
  expect(copies).toBe(1);
  expect(v.pauses()).toBe(0);
});

for (const field of ['publicationId', 'askId', 'pageId', 'displayedNonce', 'submissionId'] as const) {
  test(`#557 UI cached ${field} change requires a new explicit attempt`, async () => {
    const cache = createJobRigSubmission(), input = submission(), v = view();
    await cache.prepare(input, () => freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, input.askId,
      () => ({width: 2, height: 2, encode: async () => firstPng})));
    expect(() => cache.prepare({...input, [field]: 'new-identity'}, () => {throw new Error('must not copy');}))
      .toThrow('JOB_STILL_BINDING_MISMATCH');
    cache.reset();
    const freshInput = {...input, [field]: 'new-identity'};
    v.state.source = {...v.state.source, publicationId: freshInput.publicationId, pageId: freshInput.pageId};
    const fresh = await cache.prepare(freshInput, () => freezeJobRigCapture(recordJobRigDraw(v.state, 2), v.state,
      freshInput.askId, () => ({width: 2, height: 2, encode: async () => laterPng})));
    expect(fresh.capture?.png).toBe(laterPng);
  });
}

test('#557 UI failed encoding retries the copied pixels without taking a later frame', async () => {
  const cache = createJobRigSubmission(), input = submission(), v = view();
  let copies = 0, encodes = 0;
  const copy = () => {
    copies++;
    return freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, input.askId,
      () => ({width: 2, height: 2, async encode() {
        encodes++;
        if (encodes === 1) throw new Error('JOB_STILL_CAPTURE_FAILED');
        return firstPng;
      }}));
  };
  await expect(cache.prepare(input, copy)).rejects.toThrow('JOB_STILL_CAPTURE_FAILED');
  v.player.time = 0.5;
  const replay = await cache.prepare(input, copy);
  expect(replay.capture?.png).toBe(firstPng);
  expect(replay.capture?.frame).toBe(0);
  expect(copies).toBe(1);
  expect(encodes).toBe(2);
});


test('#557 canonical presentation is required and replacement during copy refuses', () => {
  const v = view();
  v.state.presentation = undefined;
  expect(() => recordJobRigDraw(v.state, 1)).toThrow('JOB_STILL_CAPTURE_FAILED');
  const ready = view();
  const draw = recordJobRigDraw(ready.state, 1);
  expect(() => freezeJobRigCapture(draw, ready.state, 'ask-1', () => {
    ready.state.presentation = {...ready.state.presentation!};
    return {width: 2, height: 2, encode: async () => firstPng};
  })).toThrow('JOB_STILL_BINDING_MISMATCH');
});

test('#557 actual canonical bitmap copy stays immutable and calls no renderer or background', async () => {
  const keys = ['document', 'FileReader', 'devicePixelRatio'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const source = createCanvas(2, 2);
  const context = source.getContext('2d');
  context.fillStyle = 'rgb(32,220,48)';
  context.fillRect(0, 0, 2, 2);
  Object.assign(source, {isConnected: true});
  const presentation: JobRigPresentation = {canvas: source as unknown as HTMLCanvasElement,
    width: 2, height: 2, ratio: 1, area: {x: 0, y: 0, width: 2, height: 2}};
  class TestReader {
    result: string | null = null;
    onload?: () => void;
    readAsDataURL(blob: {png: string}) {this.result = blob.png; this.onload?.();}
  }
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement() {
    const canvas = createCanvas(1, 1);
    Object.assign(canvas, {toBlob(done: (blob: unknown) => void) {
      const png = canvas.toDataURL('image/png');
      done({size: Buffer.from(png.split(',')[1]!, 'base64').length, png});
    }});
    return canvas;
  }}});
  Object.defineProperty(globalThis, 'FileReader', {configurable: true, value: TestReader});
  Object.defineProperty(globalThis, 'devicePixelRatio', {configurable: true, value: 1});
  try {
    const copied = copyJobRigViewport(presentation);
    context.fillStyle = 'rgb(240,20,10)';
    context.fillRect(0, 0, 2, 2);
    const encoded = await copied.encode();
    const pixels = PNG.sync.read(Buffer.from(encoded.split(',')[1]!, 'base64'));
    expect([...pixels.data.subarray(0, 4)]).toEqual([32, 220, 48, 255]);
    expect([copied.width, copied.height]).toEqual([2, 2]);
    expect(() => copyJobRigViewport({...presentation, width: 3})).toThrow('JOB_STILL_CAPTURE_FAILED');
    Object.assign(source, {isConnected: false});
    expect(() => copyJobRigViewport(presentation)).toThrow('JOB_STILL_CAPTURE_FAILED');
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('#557 oracle restores null and empty attributes with one operation before audit reads', async () => {
  const savedGlobal = Object.getOwnPropertyDescriptor(globalThis, '__jobStillObservation');
  const savedCanvas = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement');
  let cssWrites = 0;
  const events: string[] = [];
  const saved = new Map();
  for (const expectedAttribute of [null, '', 'visibility: visible;']) {
    let attribute: string | null = 'visibility: hidden;';
    const style = {get cssText() {events.push('css-read'); return attribute ?? '';},
      set cssText(_value: string) {cssWrites++; attribute = '';}};
    const node = {isConnected: true, style,
      getAttribute() {events.push('attribute-read'); return attribute;},
      removeAttribute() {events.push('restore'); attribute = null;},
      setAttribute(_name: string, value: string) {events.push('restore'); attribute = value;}};
    saved.set(node, {expectedAttribute, expectedCssText: expectedAttribute ?? ''});
  }
  const original = () => {};
  Object.defineProperty(globalThis, 'HTMLCanvasElement', {configurable: true, value: {prototype: {toBlob: () => {}}}});
  Object.defineProperty(globalThis, '__jobStillObservation', {configurable: true, writable: true, value: {saved, original}});
  try {
    const page = {evaluate: async (script: string) => new Function('return ' + script)()};
    const result = await restoreStillOracle(page as Parameters<typeof restoreStillOracle>[0]);
    expect(result.restored).toBe(true);
    expect(cssWrites).toBe(0);
    expect(events.slice(0, 3)).toEqual(['restore', 'restore', 'restore']);
    expect(events.slice(3, 6)).toEqual(['attribute-read', 'css-read', 'attribute-read']);
  } finally {
    for (const [key, descriptor] of [['__jobStillObservation', savedGlobal], ['HTMLCanvasElement', savedCanvas]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});


/** Execute the actual window state reader over synthetic DOM geometry. */
function canonicalLayout(ratio: number, run: (fixture: {
  read(): JobRigDrawState;
  move(x: number, y: number): void;
  pane: {left: number; top: number; width: number; height: number};
  pixels: {left: number; top: number; width: number; height: number};
  canvas: {width: number; height: number};
  publication: {source: {sourceHash: string}};
  player: ReturnType<typeof view>['player'];
  changeRatio(value: number): void;
  setPlaying(value: boolean): void;
  layers: {images: boolean; mesh: boolean; bones: boolean; meshOpacity: number};
  setBackground(value: string): void;
}) => void) {
  const source = readFileSync(new URL('../web/job-session.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    function rigDrawState(): JobRigDrawState {');
  const end = source.indexOf('    function rememberDraw(): void {', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end).replace('rigDrawState(): JobRigDrawState', 'rigDrawState()');
  const keys = ['getComputedStyle', 'devicePixelRatio'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const v = view();
  const pane = {left: 839.5, top: 151, width: 591.5, height: 162};
  const pixels = {left: 840, top: 151, width: 591, height: 162};
  const canvas = {isConnected: true, width: 591 * ratio, height: 162 * ratio,
    getBoundingClientRect: () => pixels,
    getAttribute: () => 'left: 0.5px; top: 0px; width: 591px; height: 162px;'};
  const viewportPane = {isConnected: true, clientWidth: 592, clientHeight: 162, getBoundingClientRect: () => pane};
  const rigRoot = {isConnected: true, getAttribute: () => 'left: 239.784px; top: 118.946px; transform: scale(1.40541);'};
  const center = {x: 40, y: 27};
  const camera = {center, zoom: 1, viewport: {width: 592, height: 162}};
  const publication = {publicationId: v.state.source.publicationId, instanceKey: v.state.source.instanceKey,
    source: {sourceHash: v.state.source.sourceHash}};
  const presentation: JobRigPresentation = {canvas: canvas as unknown as HTMLCanvasElement,
    width: canvas.width, height: canvas.height, ratio, area: {x: 0.5, y: 0, width: 591, height: 162}};
  const owner = {player: v.player, rigRoot, rigPresentation: presentation, display: {publication},
    inspection: {frame: () => ({generation: v.player.generation}), value: () => null}};
  const context = {current: owner, hubVisible: true, selectedPart: '', pageId: v.state.source.pageId,
    playing: false, layers: {images: true, mesh: false, bones: false, meshOpacity: 0.65}, stageBackground: '',
    viewport: {paneFrame: () => ({center}), numericView: () => ({cameras: {rig: camera}})},
    el: (id: string) => id === 'rig-viewport' ? viewportPane : {hidden: false}, jobRigPixelPlacement, jobRigDrawState};
  const read: () => JobRigDrawState = new Function('scope', `with(scope){${body};return rigDrawState;}`)(context);
  const changeRatio = (value: number) => Object.defineProperty(globalThis, 'devicePixelRatio', {configurable: true, value});
  Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: (node: unknown) => ({
    visibility: 'visible', display: 'block', opacity: '1', filter: 'none', perspective: 'none',
    transform: node === rigRoot ? 'matrix(1.40541, 0, 0, 1.40541, 0, 0)' : 'none',
  })});
  changeRatio(ratio);
  try {
    run({read, pane, pixels, canvas, publication, player: v.player, changeRatio,
      setPlaying(value) {context.playing = value;},
      layers: context.layers, setBackground(value) {context.stageBackground = value;},
      move(x, y) {pane.left += x; pane.top += y; pixels.left += x; pixels.top += y;}});
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

for (const ratio of [1, 2]) {
  test(`#557 actual layout allows three-pixel global translations at DPR ${ratio}`, () => {
    canonicalLayout(ratio, fixture => {
      const initial = fixture.read();
      const draw = recordJobRigDraw(initial, 1);
      let copies = 0;
      for (const displacement of [3, 3 / ratio]) {
        fixture.move(displacement, -displacement);
        const translated = fixture.read();
        expect(translated.layout).toBe(initial.layout);
        expect(translated.presentation).toBe(initial.presentation);
        freezeJobRigCapture(draw, translated, 'ask-1', () => {
          copies++;
          return {width: 2, height: 2, encode: async () => firstPng};
        });
      }
      expect(copies).toBe(2);
    });
  });

  for (const mismatch of ['fractional-phase', 'pane-width', 'pane-height', 'css-width', 'css-height',
    'native-width', 'native-height', 'relative-placement', 'DPR', 'source', 'renderer'] as const) {
    test(`#557 actual layout rejects ${mismatch} after translation at DPR ${ratio}`, () => {
      canonicalLayout(ratio, fixture => {
        const initial = fixture.read();
        const draw = recordJobRigDraw(initial, 1);
        fixture.move(3, -3);
        if (mismatch === 'fractional-phase') fixture.move(0.25 / ratio, -0.25 / ratio);
        else if (mismatch === 'pane-width') fixture.pane.width += 0.25;
        else if (mismatch === 'pane-height') fixture.pane.height += 0.25;
        else if (mismatch === 'css-width') fixture.pixels.width += 0.25;
        else if (mismatch === 'css-height') fixture.pixels.height += 0.25;
        else if (mismatch === 'native-width') fixture.canvas.width++;
        else if (mismatch === 'native-height') fixture.canvas.height++;
        else if (mismatch === 'relative-placement') fixture.pixels.left += 1 / ratio;
        else if (mismatch === 'DPR') fixture.changeRatio(ratio + 1);
        else if (mismatch === 'source') fixture.publication.source.sourceHash = 'b'.repeat(64);
        else fixture.player.renderer = {};
        let copies = 0;
        expect(() => freezeJobRigCapture(draw, fixture.read(), 'ask-1', () => {
          copies++;
          return {width: 2, height: 2, encode: async () => firstPng};
        })).toThrow('JOB_STILL_BINDING_MISMATCH');
        expect(copies).toBe(0);
      });
    });
  }
}

test('#557 device phase remains normalized for negative whole-pixel translations', () => {
  const pane = {left: -0.5, top: -1.25};
  const canvas = {left: 0, top: -1};
  expect(jobRigPixelPlacement(pane, canvas, 2)).toEqual(jobRigPixelPlacement(
    {left: pane.left - 3, top: pane.top + 3}, {left: canvas.left - 3, top: canvas.top + 3}, 2));
});

test('#559 UI binds wrapped animationTime from required public entry(0) while preserving physical trackTime without pause', async () => {
  const v = view();
  v.setClip({loop: true, duration: 1});
  v.player.time = 1.375;
  v.state.playing = true;
  const draw = recordJobRigDraw(v.state, 1);
  expect(draw.time).toBeCloseTo(0.375, 12);
  expect(draw.playing).toBe(true);
  let copies = 0;
  const frozen = freezeJobRigCapture(draw, v.state, 'ask-1', () => {
    copies++;
    return {width: 2, height: 2, encode: async () => firstPng};
  });
  expect(copies).toBe(1);
  const capture = await frozen.encode();
  expect(capture.frame).toBeCloseTo(0.375, 12);
  expect(capture.animation).toBe('inspect');
  expect(capture.playing).toBe(true);
  expect(v.pauses()).toBe(0);

  v.setClip({loop: false, duration: 0.5});
  v.player.time = 0.5;
  v.state.playing = false;
  const endedDraw = recordJobRigDraw(v.state, 2);
  const endedCapture = await freezeJobRigCapture(endedDraw, v.state, 'ask-1',
    () => ({width: 2, height: 2, encode: async () => laterPng})).encode();
  expect(endedCapture.frame).toBe(0.5);
  expect(endedCapture.playing).toBe(false);
  expect(v.pauses()).toBe(0);
});

test('#559 UI setup and active clip validate required entry(0) nullable animation and reject fabricated setup time', async () => {
  const v = view();
  v.player.current = null;
  v.player.time = 0;
  v.state.playing = false;
  v.setEntry(() => null);
  const nullSetup = await freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, 'ask-1',
    () => ({width: 2, height: 2, encode: async () => firstPng})).encode();
  expect(nullSetup.frame).toBe('setup');
  expect(nullSetup.playing).toBe(false);

  // clear(0, {mix: 0}) on composed tracks leaves an empty entry with animation: null at 0s.
  v.setEntry(() => ({animation: null, loop: false, trackTime: 0, animationTime: 0, duration: 0, alpha: 1, additive: false}));
  const clearedSetup = await freezeJobRigCapture(recordJobRigDraw(v.state, 2), v.state, 'ask-1',
    () => ({width: 2, height: 2, encode: async () => firstPng})).encode();
  expect(clearedSetup.frame).toBe('setup');

  // Fabricated setup time, playing: true in setup, or active animation in setup entry must refuse.
  v.state.playing = true;
  expect(() => recordJobRigDraw(v.state, 3)).toThrow('JOB_STILL_CAPTURE_FAILED');
  v.state.playing = false;
  v.player.time = 0.125;
  expect(() => recordJobRigDraw(v.state, 3)).toThrow('JOB_STILL_CAPTURE_FAILED');
  v.player.time = 0;
  v.setEntry(() => ({animation: 'inspect', loop: false, trackTime: 0, animationTime: 0, duration: 1, alpha: 1, additive: false}));
  expect(() => recordJobRigDraw(v.state, 3)).toThrow('JOB_STILL_CAPTURE_FAILED');
  v.setEntry(() => ({animation: null, loop: false, trackTime: 0.125, animationTime: 0, duration: 0, alpha: 1, additive: false}));
  expect(() => recordJobRigDraw(v.state, 3)).toThrow('JOB_STILL_CAPTURE_FAILED');

  // Active clip must have a valid matching non-null entry(0).
  v.player.current = 'inspect';
  v.player.time = 0.25;
  for (const invalid of [
    null,
    {animation: null, loop: true, trackTime: 0.25, animationTime: 0.25, duration: 1, alpha: 1, additive: false},
    {animation: '', loop: true, trackTime: 0.25, animationTime: 0.25, duration: 1, alpha: 1, additive: false},
    {animation: 'other', loop: true, trackTime: 0.25, animationTime: 0.25, duration: 1, alpha: 1, additive: false},
    {animation: 'inspect', loop: true, trackTime: 0.5, animationTime: 0.25, duration: 1, alpha: 1, additive: false},
    {animation: 'inspect', loop: true, trackTime: 0.25, animationTime: 1.25, duration: 1, alpha: 1, additive: false},
    {animation: 'inspect', loop: true, trackTime: 0.25, animationTime: -0.01, duration: 1, alpha: 1, additive: false},
  ]) {
    v.setEntry(() => invalid);
    expect(() => recordJobRigDraw(v.state, 4)).toThrow('JOB_STILL_CAPTURE_FAILED');
  }
});

test('#559 UI refuses capture before and after synchronous pixel copy when playing, loop, or unwrapped trackTime drifts', () => {
  for (const phase of ['before-copy', 'during-copy'] as const) {
    for (const drift of ['playing', 'loop', 'wrapped-trackTime'] as const) {
      const v = view();
      v.setClip({loop: true, duration: 1});
      v.player.time = 0.25;
      v.state.playing = true;
      const draw = recordJobRigDraw(v.state, 1);
      const mutate = () => {
        if (drift === 'playing') v.state.playing = false;
        else if (drift === 'loop') v.setClip({loop: false});
        else v.player.time = 1.25; // visible animationTime stays 0.25, but physical trackTime advanced a full loop
      };
      if (phase === 'before-copy') mutate();
      let copies = 0;
      expect(() => freezeJobRigCapture(draw, v.state, 'ask-1', () => {
        copies++;
        if (phase === 'during-copy') mutate();
        return {width: 2, height: 2, encode: async () => firstPng};
      })).toThrow('JOB_STILL_BINDING_MISMATCH');
      expect(copies).toBe(phase === 'before-copy' ? 0 : 1);
    }
  }
});

test('#630 actual rigDrawState refuses noncanonical layers and background before pixel copy', () => {
  canonicalLayout(1, fixture => {
    const draw = recordJobRigDraw(fixture.read(), 1);
    const refuse = () => {
      expect(fixture.read().wholeRig).toBe(false);
      expect(() => freezeJobRigCapture(draw, fixture.read(), 'ask-1', () => {
        throw new Error('noncanonical view must refuse before pixel copy');
      })).toThrow('JOB_STILL_VIEW_UNSUPPORTED');
    };
    for (const key of ['images', 'mesh', 'bones'] as const) {
      fixture.layers[key] = key !== 'images';
      refuse();
      fixture.layers[key] = key === 'images';
      expect(fixture.read().wholeRig).toBe(true);
    }
    fixture.setBackground('green');
    refuse();
    fixture.setBackground('');
    expect(fixture.read().wholeRig).toBe(true);
  });
});

test('#559 UI canonical rigDrawState binds live playing state instead of hardcoded false', () => {
  canonicalLayout(1, fixture => {
    expect(fixture.read().playing).toBe(false);
    fixture.setPlaying(true);
    expect(fixture.read().playing).toBe(true);
  });
});

test('#559 UI reply-loss retry preserves byte-exact first submission across motion advance, seek, play/pause, loop, camera, and part selection', async () => {
  const v = view(), cache = createJobRigSubmission(), input = submission();
  v.setClip({loop: true, duration: 1});
  v.player.time = 0.25;
  v.state.playing = true;
  let copies = 0;
  const saved = await cache.prepare(input, () => {
    copies++;
    return freezeJobRigCapture(recordJobRigDraw(v.state, 1), v.state, input.askId,
      () => ({width: 2, height: 2, encode: async () => firstPng}));
  });
  expect(saved.capture).toMatchObject({png: firstPng, frame: 0.25, animation: 'inspect', playing: true});
  const savedBytes = JSON.stringify(saved);

  // Advance continuous motion across a loop wrap, manual seek, pause, toggle loop, pan/zoom camera, and select part:
  v.player.generation = 19;
  v.player.time = 1.75;
  v.player.time = 0.5;
  v.state.playing = false;
  v.setClip({loop: false});
  v.state.defaultCamera = false;
  v.state.wholeRig = false;
  v.player.slots = ['head'];
  v.state.layout = 'layout-after-motion-and-controls';

  const replay = await cache.prepare(input, () => {
    throw new Error('must reuse first frozen submission across motion and view controls');
  });
  expect(replay).toBe(saved);
  expect(JSON.stringify(replay)).toBe(savedBytes);
  expect(copies).toBe(1);
  expect(v.pauses()).toBe(0);

  // Only after form input resets the submission controller and creates a new submissionId does a wrapped mid-play retry re-capture:
  cache.reset();
  v.setClip({loop: true, duration: 1});
  v.state.frameGeneration = 19;
  v.player.time = 1.375;
  v.state.playing = true;
  v.state.defaultCamera = true;
  v.state.wholeRig = true;
  v.player.slots = null;
  const fresh = await cache.prepare({...input, submissionId: 'submission-2'}, () => {
    copies++;
    return freezeJobRigCapture(recordJobRigDraw(v.state, 2), v.state, input.askId,
      () => ({width: 2, height: 2, encode: async () => laterPng}));
  });
  expect(copies).toBe(2);
  expect(fresh.capture).toMatchObject({png: laterPng, frame: 0.375, animation: 'inspect', playing: true});
});
