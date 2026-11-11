import {CanvasRenderer, type ModelAssets, type PosedFrame, type RigPlayer} from '@rig-c/play';
import {jobStillByteLimit, type JobRigCapture, type JobUISubmission} from '../src/job-contract.ts';
import type {ControlNumericCamera} from '../src/control.ts';
import {presentJobRigViewport, type JobRigPresentation} from './viewport-capture.ts';

type DrawSource = Pick<JobRigCapture['binding'], 'publicationId' | 'instanceKey' | 'sourceHash' | 'pageId'>;
export interface JobRigDrawState {
  player: Pick<RigPlayer, 'generation' | 'current' | 'time' | 'slots' | 'entry'> & {readonly renderer: object};
  frameGeneration: number | undefined;
  presentation: JobRigPresentation | undefined;
  source: DrawSource;
  layout: string;
  defaultCamera: boolean;
  wholeRig: boolean;
  playing: boolean;
}
export interface JobRigDraw {
  readonly player: JobRigDrawState['player'];
  readonly renderer: object;
  readonly presentation: JobRigPresentation;
  readonly playerGeneration: number;
  readonly drawGeneration: number;
  readonly animation: string | null;
  readonly time: number;
  readonly trackTime: number;
  readonly loop: boolean;
  readonly playing: boolean;
  readonly source: DrawSource;
  readonly layout: string;
}
export interface JobRigPixels {
  readonly width: number;
  readonly height: number;
  encode(): Promise<string>;
}
export interface FrozenJobRigCapture {
  encode(): Promise<JobRigCapture>;
}

const sourceKey = (source: DrawSource) => JSON.stringify([
  source.publicationId, source.instanceKey, source.sourceHash, source.pageId,
]);

/** Bind local placement and physical-pixel phase while allowing whole-pixel page movement. */
export function jobRigPixelPlacement(pane: Pick<DOMRect, 'left' | 'top'>,
  canvas: Pick<DOMRect, 'left' | 'top'>, ratio: number) {
  function phase(coordinate: number): number {
    const deviceCoordinate = coordinate * ratio;
    return deviceCoordinate - Math.floor(deviceCoordinate);
  }
  return {
    offsetX: canvas.left - pane.left,
    offsetY: canvas.top - pane.top,
    panePhaseX: phase(pane.left),
    panePhaseY: phase(pane.top),
    canvasPhaseX: phase(canvas.left),
    canvasPhaseY: phase(canvas.top),
  };
}

function readPlayerTiming(state: JobRigDrawState): {animation: string | null; time: number; trackTime: number; loop: boolean} {
  if (!Number.isFinite(state.player.time) || state.player.time < 0 || typeof state.playing !== 'boolean' ||
      typeof state.player.entry !== 'function') {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  const entry = state.player.entry(0);
  if (state.player.current === null) {
    if (state.playing || state.player.time !== 0 ||
        (entry !== null && (entry.animation !== null || entry.trackTime !== 0 || entry.animationTime !== 0))) {
      throw new Error('JOB_STILL_CAPTURE_FAILED');
    }
    return {animation: null, time: 0, trackTime: 0, loop: false};
  }
  if (typeof state.player.current !== 'string' || !state.player.current || !entry ||
      typeof entry.animation !== 'string' || entry.animation !== state.player.current ||
      typeof entry.loop !== 'boolean' || !Number.isFinite(entry.trackTime) || entry.trackTime < 0 ||
      entry.trackTime !== state.player.time || !Number.isFinite(entry.duration) || entry.duration < 0 ||
      !Number.isFinite(entry.animationTime) || entry.animationTime < 0 || entry.animationTime > entry.duration) {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  return {animation: entry.animation, time: entry.animationTime, trackTime: entry.trackTime, loop: entry.loop};
}

function matchesDrawState(draw: JobRigDraw, state: JobRigDrawState): boolean {
  if (draw.presentation !== state.presentation || draw.player !== state.player || draw.renderer !== state.player.renderer ||
      draw.playerGeneration !== state.player.generation || state.frameGeneration !== draw.playerGeneration ||
      draw.animation !== state.player.current || draw.trackTime !== state.player.time ||
      draw.playing !== state.playing || draw.layout !== state.layout || sourceKey(draw.source) !== sourceKey(state.source)) {
    return false;
  }
  const entry = state.player.entry(0);
  if (draw.animation === null) {
    return !draw.playing && !state.playing && draw.time === 0 && draw.trackTime === 0 && draw.loop === false && state.player.time === 0 &&
      (entry === null || (entry.animation === null && entry.trackTime === 0 && entry.animationTime === 0));
  }
  return entry !== null && entry.animation === draw.animation && entry.loop === draw.loop &&
    entry.trackTime === draw.trackTime && entry.animationTime === draw.time &&
    Number.isFinite(entry.duration) && entry.duration >= 0 && draw.time >= 0 && draw.time <= entry.duration;
}

/** Called after the public draw/present and viewport-render boundaries succeed. */
export function recordJobRigDraw(state: JobRigDrawState, drawGeneration: number): JobRigDraw {
  if (!state.presentation || state.frameGeneration !== state.player.generation || !Number.isSafeInteger(drawGeneration) || drawGeneration < 1 ||
      !Number.isSafeInteger(state.player.generation) || state.player.generation < 0) {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  const timing = readPlayerTiming(state);
  return Object.freeze({
    player: state.player,
    renderer: state.player.renderer,
    presentation: state.presentation,
    playerGeneration: state.player.generation,
    drawGeneration,
    animation: timing.animation,
    time: timing.time,
    trackTime: timing.trackTime,
    loop: timing.loop,
    playing: state.playing,
    source: Object.freeze({...state.source}),
    layout: state.layout,
  });
}

/** copy() runs synchronously. The returned encoder owns an already copied bitmap. */
export function freezeJobRigCapture(draw: JobRigDraw | undefined, state: JobRigDrawState, askId: string,
  copy: () => JobRigPixels): FrozenJobRigCapture {
  if (!state.defaultCamera) throw new Error('JOB_STILL_CAMERA_NOT_FIXED');
  if (!state.wholeRig || state.player.slots !== null) throw new Error('JOB_STILL_VIEW_UNSUPPORTED');
  if (!draw || typeof state.player.entry !== 'function') throw new Error('JOB_STILL_CAPTURE_FAILED');
  if (draw.animation !== null && !draw.animation) throw new Error('JOB_STILL_CAPTURE_FAILED');
  if (!matchesDrawState(draw, state)) {
    throw new Error('JOB_STILL_BINDING_MISMATCH');
  }
  const pixels = copy();
  if (!matchesDrawState(draw, state)) {
    throw new Error('JOB_STILL_BINDING_MISMATCH');
  }
  if (!Number.isSafeInteger(pixels.width) || !Number.isSafeInteger(pixels.height) || pixels.width < 1 || pixels.height < 1 ||
      pixels.width > 16384 || pixels.height > 16384 || pixels.width * pixels.height > 16777216) {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  const metadata: Omit<JobRigCapture, 'png'> = {
    width: pixels.width, height: pixels.height, camera: 'fixed', framing: 'default', view: 'whole-rig',
    frame: draw.animation === null ? 'setup' : draw.time,
    ...(draw.animation === null ? {} : {animation: draw.animation}), playing: draw.playing,
    binding: {...draw.source, askId, drawGeneration: draw.drawGeneration, playerGeneration: draw.playerGeneration},
  };
  return {async encode() {
    const png = await pixels.encode();
    if (!png.startsWith('data:image/png;base64,') || png.length > 22 + Math.ceil(jobStillByteLimit / 3) * 4) {
      throw new Error('JOB_STILL_CAPTURE_FAILED');
    }
    return {...metadata, png};
  }};
}

/** Copy the committed display bitmap synchronously, before asynchronous PNG encoding. */
export function copyJobRigViewport(presentation: JobRigPresentation): JobRigPixels {
  const {canvas: displayed, width, height, ratio} = presentation;
  if (!displayed.isConnected || displayed.width !== width || displayed.height !== height ||
      ratio !== (globalThis.devicePixelRatio || 1) || width < 1 || height < 1 ||
      width > 16384 || height > 16384 || width * height > 16777216) {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const source = displayed.getContext('2d');
    const context = canvas.getContext('2d');
    if (!source || !context) throw new Error('JOB_STILL_CAPTURE_FAILED');
    context.putImageData(source.getImageData(0, 0, width, height), 0, 0);
  } catch { throw new Error('JOB_STILL_CAPTURE_FAILED'); }
  return {width, height, encode: () => new Promise<string>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob || blob.size > jobStillByteLimit) {reject(new Error('JOB_STILL_CAPTURE_FAILED')); return;}
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('JOB_STILL_CAPTURE_FAILED'));
      reader.onerror = () => reject(new Error('JOB_STILL_CAPTURE_FAILED'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  }).catch(() => {throw new Error('JOB_STILL_CAPTURE_FAILED');})};
}

/** Per-form first attempt, including human words and observed generation, survives a lost reply. */
export function createJobRigSubmission() {
  let frozen: {identity: string; base: Extract<JobUISubmission, {kind: 'review-verdict'}>; copy?: FrozenJobRigCapture;
    pending?: Promise<JobUISubmission>; request?: JobUISubmission} | undefined;
  return {
    reset() {frozen = undefined;},
    prepare(input: JobUISubmission, copy: () => FrozenJobRigCapture): Promise<JobUISubmission> {
      if (input.kind !== 'review-verdict' || input.value.stage !== 'rig-review') throw new Error('JOB_ACT_INVALID');
      const identity = JSON.stringify([input.publicationId, input.pageId, input.displayedNonce, input.askId, input.submissionId, input.kind]);
      if (frozen && frozen.identity !== identity) throw new Error('JOB_STILL_BINDING_MISMATCH');
      if (!frozen) {
        const base = structuredClone(input);
        frozen = {identity, base, copy: copy()};
      }
      const saved = frozen;
      if (saved.request) return Promise.resolve(saved.request);
      if (!saved.pending) saved.pending = saved.copy!.encode().then(capture => {
        Object.freeze(capture.binding);
        Object.freeze(capture);
        Object.freeze(saved.base.value);
        saved.request = Object.freeze({...saved.base, capture});
        saved.copy = undefined;
        return saved.request;
      }).finally(() => {saved.pending = undefined;});
      return saved.pending;
    },
  };
}

/** One screen's rig pane as the still reads it: the job window's and the one review screen's share this. */
export interface JobRigStage {
  readonly pane: HTMLElement;
  readonly paneHidden: boolean;
  readonly root: HTMLElement;
  readonly player: RigPlayer;
  readonly presentation: JobRigPresentation | undefined;
  readonly frameGeneration: number | undefined;
  readonly camera: ControlNumericCamera | null | undefined;
  readonly frame: {readonly center: {readonly x: number; readonly y: number}} | null;
  readonly source: DrawSource;
  /** No part selected or solo, images only, no mesh, bones or background sentinel. */
  readonly wholeRig: boolean;
  readonly playing: boolean;
}

/** The draw state a still is bound to: pane geometry, camera, canonical pixels and the posed frame. */
export function jobRigDrawState(stage: JobRigStage): JobRigDrawState {
  const {pane, root, player, presentation, frame, camera} = stage;
  const rect = pane.getBoundingClientRect(), ratio = globalThis.devicePixelRatio || 1;
  if (!frame || !camera || !pane.isConnected || !root.isConnected || stage.paneHidden ||
      rect.width <= 0 || rect.height <= 0) throw new Error('JOB_STILL_CAPTURE_FAILED');
  const style = getComputedStyle(root), paneStyle = getComputedStyle(pane);
  const plain = style.filter === 'none' && style.perspective === 'none' && style.opacity === '1' &&
    paneStyle.filter === 'none' && paneStyle.transform === 'none' && paneStyle.perspective === 'none' && paneStyle.opacity === '1';
  const canvas = presentation?.canvas;
  const pixels = canvas?.getBoundingClientRect();
  const canvasStyle = canvas ? getComputedStyle(canvas) : null;
  if (canvas && (!canvas.isConnected || canvasStyle?.visibility !== 'visible' ||
      canvasStyle.display === 'none' || canvasStyle.opacity !== '1' || canvasStyle.filter !== 'none' ||
      canvasStyle.transform !== 'none')) throw new Error('JOB_STILL_CAPTURE_FAILED');
  return {player, presentation, frameGeneration: stage.frameGeneration, source: stage.source,
    layout: JSON.stringify([
      pane.clientWidth, pane.clientHeight, rect.width, rect.height, ratio,
      root.getAttribute('style'), style.transform, camera, presentation?.area, presentation?.ratio,
      pixels ? jobRigPixelPlacement(rect, pixels, ratio) : null,
      pixels?.width, pixels?.height, canvas?.width, canvas?.height, canvas?.getAttribute('style'),
    ]),
    defaultCamera: plain && camera.zoom === 1 && camera.center.x === frame.center.x && camera.center.y === frame.center.y,
    wholeRig: stage.wholeRig, playing: stage.playing};
}

/** Paint the pane's actual pixels into one canonical canvas and put it on the pane. */
export function presentJobRigStage(stage: Pick<JobRigStage, 'pane' | 'root' | 'player' | 'camera'> &
  {readonly posed: PosedFrame | undefined; readonly assets: ModelAssets | null}): JobRigPresentation {
  const renderer = stage.player.renderer;
  if (!stage.posed || !stage.assets || !stage.camera) throw new Error('JOB_STILL_CAPTURE_FAILED');
  const presentation = presentJobRigViewport({pane: stage.pane, root: stage.root, images: true,
    canvas: renderer instanceof CanvasRenderer ? renderer.canvas : undefined,
    backend: renderer instanceof CanvasRenderer ? renderer.backendActive : renderer.meshBackendActive},
  {camera: stage.camera, posed: stage.posed, assets: stage.assets});
  stage.pane.append(presentation.canvas);
  return presentation;
}
