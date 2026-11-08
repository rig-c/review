import type {RigPlayer} from '@rig-c/play';
import {jobStillByteLimit, type JobRigCapture, type JobUISubmission} from '../src/job-contract.ts';
import type {JobRigPresentation} from './viewport-capture.ts';

type DrawSource = Pick<JobRigCapture['binding'], 'publicationId' | 'instanceKey' | 'sourceHash' | 'pageId'>;
export interface JobRigDrawState {
  player: Pick<RigPlayer, 'generation' | 'current' | 'time' | 'slots'> & {readonly renderer: object};
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

/** Called after the public draw/present and viewport-render boundaries succeed. */
export function recordJobRigDraw(state: JobRigDrawState, drawGeneration: number): JobRigDraw {
  if (!state.presentation || state.frameGeneration !== state.player.generation || !Number.isSafeInteger(drawGeneration) || drawGeneration < 1 ||
      !Number.isSafeInteger(state.player.generation) || state.player.generation < 0 || !Number.isFinite(state.player.time) || state.player.time < 0) {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  return Object.freeze({
    player: state.player,
    renderer: state.player.renderer,
    presentation: state.presentation,
    playerGeneration: state.player.generation,
    drawGeneration,
    animation: state.player.current,
    time: state.player.time,
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
  if (!draw) throw new Error('JOB_STILL_CAPTURE_FAILED');
  if (draw.presentation !== state.presentation || draw.player !== state.player || draw.renderer !== state.player.renderer || draw.playerGeneration !== state.player.generation ||
      state.frameGeneration !== draw.playerGeneration || draw.animation !== state.player.current ||
      draw.time !== state.player.time || draw.layout !== state.layout || sourceKey(draw.source) !== sourceKey(state.source)) {
    throw new Error('JOB_STILL_BINDING_MISMATCH');
  }
  if (draw.animation !== null && !draw.animation) throw new Error('JOB_STILL_CAPTURE_FAILED');
  const pixels = copy();
  if (state.presentation !== draw.presentation || state.player.renderer !== draw.renderer || state.player.generation !== draw.playerGeneration || state.player.current !== draw.animation ||
      state.player.time !== draw.time || draw.layout !== state.layout || sourceKey(draw.source) !== sourceKey(state.source)) {
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
