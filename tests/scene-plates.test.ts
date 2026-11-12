import { expect, test } from 'bun:test';
import { renderScenePlates } from '../web/scene-plates.ts';

type Frame = Parameters<typeof renderScenePlates>[1];
type Matrix = Frame['rigTransform'];
type Clip = readonly number[];
type State = {
  transform: Matrix;
  globalAlpha: number;
  globalCompositeOperation: string;
  filter: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  clips: Clip[];
};

class StubPath {
  rectangles: number[][] = [];
  rect(...coordinates: number[]) { this.rectangles.push(coordinates); }
}

function recordingCanvas() {
  const initial: State = {
    transform: [3, 0, 0, 3, 7, 11], globalAlpha: .4,
    globalCompositeOperation: 'multiply', filter: 'blur(2px)',
    shadowColor: 'red', shadowBlur: 4, shadowOffsetX: 2, shadowOffsetY: 3,
    clips: [[0, 0, 400, 300]],
  };
  const events: unknown[][] = [];
  const draws: { image: unknown; coordinates: number[]; state: State }[] = [];
  const stack: State[] = [];
  const context = {
    ...structuredClone(initial), currentPath: 'caller path',
    save() {
      stack.push(snapshot());
      events.push(['save']);
    },
    restore() {
      const saved = stack.pop();
      if (!saved) throw new Error('stub save/restore imbalance');
      Object.assign(context, saved);
      events.push(['restore']);
    },
    setTransform(...transform: number[]) {
      context.transform = transform as unknown as Matrix;
      events.push(['transform', ...transform]);
    },
    clip(path: StubPath) {
      context.clips.push(...path.rectangles);
      events.push(['clip', ...path.rectangles]);
    },
    clearRect(...rect: number[]) { events.push(['clear', ...rect]); },
    drawImage(image: unknown, ...coordinates: number[]) {
      draws.push({ image, coordinates, state: snapshot() });
      events.push(['image', image]);
    },
  };
  function snapshot(): State {
    return structuredClone({
      transform: context.transform, globalAlpha: context.globalAlpha,
      globalCompositeOperation: context.globalCompositeOperation, filter: context.filter,
      shadowColor: context.shadowColor, shadowBlur: context.shadowBlur,
      shadowOffsetX: context.shadowOffsetX, shadowOffsetY: context.shadowOffsetY,
      clips: context.clips,
    });
  }
  const ctx = context as unknown as CanvasRenderingContext2D;
  function render(frame: Frame) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Path2D');
    Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: StubPath });
    try { renderScenePlates(ctx, frame); }
    finally {
      if (descriptor) Object.defineProperty(globalThis, 'Path2D', descriptor);
      else Reflect.deleteProperty(globalThis, 'Path2D');
    }
  }
  return { ctx, context, initial, snapshot, events, draws, stack, render };
}

function image(width: number, height: number): HTMLImageElement {
  return { complete: true, naturalWidth: width, naturalHeight: height } as HTMLImageElement;
}

function frame(drawRig: Frame['drawRig'] = () => {}): Frame {
  return {
    clip: { x: 10.25, y: 20.5, width: 200, height: 100 },
    background: {
      image: image(64, 48), width: 64, height: 48,
      rect: { x: -8.25, y: 12.5, width: 256, height: 192 },
    },
    foreground: {
      image: image(16, 32), width: 16, height: 32,
      rect: { x: 30.75, y: 40.25, width: 24, height: 48 },
    },
    rigTransform: [2, .25, -.5, -3, 100.125, 80.75],
    drawRig,
  };
}

test('#482 uses the explicit plate rectangles and rig matrix in background / rig / foreground order', () => {
  const canvas = recordingCanvas();
  const rig = {} as CanvasImageSource;
  const input = frame(ctx => ctx.drawImage(rig, 1, 2));
  const before = JSON.stringify(input);
  canvas.render(input);

  expect(canvas.events).toEqual([
    ['save'], ['transform', 1, 0, 0, 1, 0, 0],
    ['clip', [10.25, 20.5, 200, 100]], ['clear', 10.25, 20.5, 200, 100],
    ['image', input.background!.image], ['save'],
    ['transform', 2, .25, -.5, -3, 100.125, 80.75], ['image', rig], ['restore'],
    ['image', input.foreground!.image], ['restore'],
  ]);
  expect(canvas.draws.map(draw => draw.coordinates)).toEqual([
    [0, 0, 64, 48, -8.25, 12.5, 256, 192], [1, 2],
    [0, 0, 16, 32, 30.75, 40.25, 24, 48],
  ]);
  expect(canvas.draws.map(draw => draw.state.transform)).toEqual([
    [1, 0, 0, 1, 0, 0], input.rigTransform, [1, 0, 0, 1, 0, 0],
  ]);
  for (const draw of canvas.draws) {
    expect(draw.state.globalAlpha).toBe(1);
    expect(draw.state.globalCompositeOperation).toBe('source-over');
    expect(draw.state.filter).toBe('none');
    expect(draw.state.shadowColor).toBe('transparent');
    expect(draw.state.shadowBlur).toBe(0);
    expect(draw.state.shadowOffsetX).toBe(0);
    expect(draw.state.shadowOffsetY).toBe(0);
    expect(draw.state.clips).toEqual([[0, 0, 400, 300], [10.25, 20.5, 200, 100]]);
  }
  expect(canvas.snapshot()).toEqual(canvas.initial);
  expect(canvas.context.currentPath).toBe('caller path');
  expect(canvas.stack).toHaveLength(0);
  expect(JSON.stringify(input)).toBe(before);
});

test('#482 isolates rig state and additional clipping from the foreground and caller', () => {
  const canvas = recordingCanvas();
  canvas.render(frame(ctx => {
    ctx.globalAlpha = .1;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.filter = 'blur(8px)';
    ctx.shadowBlur = 9;
    ctx.setTransform(4, 0, 0, 4, 1, 1);
    const path = new Path2D();
    path.rect(1, 2, 3, 4);
    ctx.clip(path);
  }));
  expect(canvas.draws[1]!.state).toEqual({
    ...canvas.initial, transform: [1, 0, 0, 1, 0, 0], globalAlpha: 1,
    globalCompositeOperation: 'source-over', filter: 'none', shadowColor: 'transparent',
    shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    clips: [[0, 0, 400, 300], [10.25, 20.5, 200, 100]],
  });
  expect(canvas.snapshot()).toEqual(canvas.initial);
  expect(canvas.stack).toHaveLength(0);
});

const invalidInputs: [string, (input: Frame) => Frame, string][] = [
  ['missing background',
    input => ({ ...input, background: null }),
    'SCENE_PLATE_REQUIRED: background'],
  ['missing foreground',
    input => ({ ...input, foreground: null }),
    'SCENE_PLATE_REQUIRED: foreground'],
  ['empty foreground',
    input => ({ ...input, foreground: { ...input.foreground!, image: null } }),
    'SCENE_PLATE_REQUIRED: foreground'],
  ['undecoded image',
    input => ({ ...input, foreground: {
      ...input.foreground!, image: { ...input.foreground!.image!, complete: false } as HTMLImageElement,
    } }),
    'SCENE_PLATE_NOT_READY: foreground'],
  ['zero image',
    input => ({ ...input, foreground: { ...input.foreground!, image: image(0, 32) } }),
    'SCENE_PLATE_NOT_READY: foreground'],
  ['mismatched width',
    input => ({ ...input, background: { ...input.background!, width: 63 } }),
    'SCENE_PLATE_DIMENSIONS: background'],
  ['mismatched height',
    input => ({ ...input, foreground: { ...input.foreground!, height: 31 } }),
    'SCENE_PLATE_DIMENSIONS: foreground'],
  ['fractional dimensions',
    input => ({ ...input, foreground: { ...input.foreground!, width: 16.5 } }),
    'SCENE_PLATE_DIMENSIONS: foreground'],
  ['zero dimensions',
    input => ({ ...input, foreground: { ...input.foreground!, height: 0 } }),
    'SCENE_PLATE_DIMENSIONS: foreground'],
  ['nonfinite dimensions',
    input => ({ ...input, foreground: { ...input.foreground!, width: Infinity } }),
    'SCENE_PLATE_DIMENSIONS: foreground'],
  ['zero clip',
    input => ({ ...input, clip: { ...input.clip, width: 0 } }),
    'SCENE_RECT_INVALID: clip'],
  ['zero height clip',
    input => ({ ...input, clip: { ...input.clip, height: 0 } }),
    'SCENE_RECT_INVALID: clip'],
  ['negative height clip',
    input => ({ ...input, clip: { ...input.clip, height: -1 } }),
    'SCENE_RECT_INVALID: clip'],
  ['nonfinite clip',
    input => ({ ...input, clip: { ...input.clip, x: NaN } }),
    'SCENE_RECT_INVALID: clip'],
  ['overflowing clip',
    input => ({ ...input, clip: { ...input.clip, x: Number.MAX_VALUE, width: Number.MAX_VALUE } }),
    'SCENE_RECT_INVALID: clip'],
  ['negative background rectangle',
    input => ({ ...input, background: {
      ...input.background!, rect: { ...input.background!.rect, width: -1 },
    } }),
    'SCENE_RECT_INVALID: background'],
  ['nonfinite foreground rectangle',
    input => ({ ...input, foreground: {
      ...input.foreground!, rect: { ...input.foreground!.rect, y: Infinity },
    } }),
    'SCENE_RECT_INVALID: foreground'],
  ['nonfinite matrix',
    input => ({ ...input, rigTransform: [1, 0, 0, 1, NaN, 0] }),
    'SCENE_TRANSFORM_INVALID'],
  ['short matrix',
    input => ({ ...input, rigTransform: [1, 0, 0, 1, 0] as unknown as Matrix }),
    'SCENE_TRANSFORM_INVALID'],
  ['sparse matrix',
    input => ({ ...input, rigTransform: [1, 0, 0, 1, , 0] as unknown as Matrix }),
    'SCENE_TRANSFORM_INVALID'],
  ['singular matrix',
    input => ({ ...input, rigTransform: [1, 1, 1, 1, 0, 0] }),
    'SCENE_TRANSFORM_INVALID'],
  ['overflowing determinant',
    input => ({ ...input, rigTransform: [1e300, 0, 0, 1e300, 0, 0] }),
    'SCENE_TRANSFORM_INVALID'],
  ['missing rig callback',
    input => ({ ...input, drawRig: null as unknown as Frame['drawRig'] }),
    'SCENE_DRAW_RIG_REQUIRED'],
];

for (const [name, invalidate, code] of invalidInputs) {
  test(`#482 ${name} refuses before touching the held frame`, () => {
    const canvas = recordingCanvas();
    let rigCalls = 0;
    const input = invalidate(frame(() => { rigCalls++; }));
    expect(() => canvas.render(input)).toThrow(code);
    expect(canvas.events).toEqual([]);
    expect(canvas.draws).toEqual([]);
    expect(rigCalls).toBe(0);
    expect(canvas.snapshot()).toEqual(canvas.initial);
    expect(canvas.context.currentPath).toBe('caller path');
    expect(canvas.stack).toHaveLength(0);
  });
}

test('#482 restores drawing state after a rig failure and propagates the original error', () => {
  const canvas = recordingCanvas();
  const failure = new Error('rig draw failed');
  const input = frame(ctx => {
    ctx.globalAlpha = .2;
    ctx.setTransform(8, 0, 0, 8, 0, 0);
    throw failure;
  });
  let caught: unknown;
  try { canvas.render(input); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(canvas.draws.map(draw => draw.image)).toEqual([input.background!.image]);
  expect(canvas.snapshot()).toEqual(canvas.initial);
  expect(canvas.stack).toHaveLength(0);
});

for (const side of ['background', 'foreground'] as const) {
  test(`#482 restores drawing state when the ${side} draw fails`, () => {
    const canvas = recordingCanvas();
    const failure = new Error('plate draw failed');
    let rigCalls = 0;
    const input = frame(() => { rigCalls++; });
    const drawImage = canvas.ctx.drawImage.bind(canvas.ctx);
    canvas.ctx.drawImage = (image, ...coordinates: number[]) => {
      if (image === input[side]!.image) throw failure;
      drawImage(image, coordinates[0]!, coordinates[1]!);
    };
    let caught: unknown;
    try { canvas.render(input); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(rigCalls).toBe(side === 'background' ? 0 : 1);
    expect(canvas.snapshot()).toEqual(canvas.initial);
    expect(canvas.stack).toHaveLength(0);
  });
}


test('#797 an explicitly absent foreground draws background and rig while null still refuses a required plate',()=>{
 const h=recordingCanvas(),input=frame();h.render({...input,foreground:undefined});
 expect(h.draws.length).toBe(1);
 expect(()=>h.render({...input,foreground:null})).toThrow('SCENE_PLATE_REQUIRED: foreground');
});
