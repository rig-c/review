import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import type { InputCdpSession } from './parts-explorer-browser.ts';
import {
  assertPartsViewShotState,
  clickPartsViewControl,
  measurePartsViewShot,
  preparePartsViewShot,
  type PartsViewShotState,
  type PartsViewShotTarget,
} from './helpers/parts-view-shots.ts';

const parts: PartsViewShotTarget = { mode: 'parts', view: 'item', zoom: 2, language: 'en' };
const atlas: PartsViewShotTarget = { mode: 'atlas', view: 'page', zoom: 4, language: 'ko' };
const targets = [parts, { ...parts, language: 'ko' as const }, atlas, { ...atlas, language: 'en' as const }];

function measured(target: PartsViewShotTarget): PartsViewShotState {
  return {
    mode: target.mode, view: target.view, language: target.language,
    zoomX: target.zoom, zoomY: target.zoom, canvasZoomX: target.zoom, canvasZoomY: target.zoom,
    zoomLabel: `${target.zoom * 100}.0%`, nativeOne: false, footprints: true,
    canvas: { width: 30, height: 32 },
  };
}

describe('parts screenshot exact state guard', () => {
  for (const target of targets) {
    test(`${target.mode}/${target.language} accepts its exact zoom, view and language`, () => {
      expect(() => assertPartsViewShotState(measured(target), target)).not.toThrow();
    });
  }
  for (const key of ['zoomX', 'zoomY', 'canvasZoomX', 'canvasZoomY'] as const) {
    test(`${key} refuses adjacent floating point zoom without tolerance`, () => {
      expect(() => assertPartsViewShotState({ ...measured(parts), [key]: 2 + Number.EPSILON * 2 }, parts))
        .toThrow('PARTS_SHOT_ZOOM_MISMATCH');
    });
  }
  test('a correct label cannot hide the wrong rendered zoom', () => {
    expect(() => assertPartsViewShotState({ ...measured(atlas), canvasZoomX: 1 }, atlas))
      .toThrow('PARTS_SHOT_ZOOM_MISMATCH');
  });
  test('stale zoom label and native-one state refuse by name', () => {
    for (const change of [{ zoomLabel: '1:1' }, { nativeOne: true }]) {
      expect(() => assertPartsViewShotState({ ...measured(parts), ...change }, parts))
        .toThrow('PARTS_SHOT_ZOOM_MISMATCH');
    }
  });
  test('wrong package mode, region view, assembly and language refuse by name', () => {
    for (const change of [{ mode: 'parts' as const }, { view: 'item' }, { view: 'assembled' }, { language: 'en' }]) {
      expect(() => assertPartsViewShotState({ ...measured(atlas), ...change }, atlas))
        .toThrow('PARTS_SHOT_VIEW_MISMATCH');
    }
  });
  test('parts screenshots require footprints', () => {
    expect(() => assertPartsViewShotState({ ...measured(parts), footprints: false }, parts))
      .toThrow('PARTS_SHOT_FOOTPRINTS_MISSING');
  });
});

// Disposable DOM/CDP test double. It creates no owner act or persisted Review state.
function pageFixture(target: PartsViewShotTarget) {
  let zoom = 1;
  let view = 'item';
  let footprints = false;
  const actions: string[] = [];
  const touches: { x: number; y: number; id: number }[][] = [];
  const nodes: Record<string, any> = {};
  for (const [id, left] of [['pv-footprints', 0], ['native-one', 20], ['page', 40]] as const) {
    nodes[id] = {
      disabled: false,
      contains: (node: unknown) => node === nodes[id],
      getBoundingClientRect: () => ({ left, top: 0, width: 10, height: 10 }),
    };
  }
  Object.assign(nodes, {
    'pv-atlas-switch': { hidden: target.mode === 'parts' },
    'pv-assemble': { getAttribute: () => 'false' },
    'rig-root': {},
    'rig-viewport': {
      contains: (node: unknown) => node === nodes['rig-viewport'],
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
    },
    'pv-canvas': {
      width: 30, height: 32,
      getBoundingClientRect: () => ({ width: 30 * zoom, height: 32 * zoom }),
    },
  });
  nodes['native-one'].getAttribute = () => String(zoom === 1);
  Object.defineProperty(nodes['pv-footprints'], 'checked', { get: () => footprints });
  Object.defineProperty(nodes, 'zoom-value', { get: () => ({ textContent: zoom === 1 ? '1:1' : `${(zoom * 100).toFixed(1)}%` }) });
  const document = {
    documentElement: { lang: target.language },
    getElementById: (id: string) => nodes[id],
    querySelector: (selector: string) => {
      if (selector === '[data-pv-view][aria-pressed="true"]') return { dataset: { pvView: view } };
      if (selector === '[data-pv-view="page"]') return nodes.page;
      if (selector === '.pv-box[data-region]') return view === 'page' ? {} : null;
      return nodes[selector.slice(1)];
    },
    elementFromPoint: (x: number, y: number) => y === 5
      ? Object.values(nodes).find(node => node.getBoundingClientRect?.().left === x - 5)
      : nodes['rig-viewport'],
  };
  const page: InputCdpSession = {
    async evaluate(expression) {
      return runInNewContext(expression, {
        document,
        getComputedStyle: () => ({ transform: String(zoom) }),
        DOMMatrix: class {
          a: number;
          d: number;
          constructor(value: string) {
            this.a = Number(value);
            this.d = Number(value);
          }
        },
      });
    },
    async mouse(type, x) {
      if (type === 'mouseReleased') {
        const pressed = x === 5 ? 'footprints' : x === 25 ? 'native' : 'page';
        actions.push(pressed);
        if (pressed === 'footprints') footprints = !footprints;
        if (pressed === 'native') zoom = 1;
        if (pressed === 'page') {
          view = 'page';
          zoom = 1;
        }
      }
    },
    async touch(type, points) {
      actions.push(type);
      touches.push(points);
      if (type === 'touchMove') {
        const start = touches[0]!;
        zoom *= (points[1]!.x - points[0]!.x) / (start[1]!.x - start[0]!.x);
      }
    },
    async setViewport() {},
    async goto() {},
    async close() {},
    async screenshot() { return Buffer.alloc(0); },
  };
  return { page, actions, touches, nodes };
}

describe('parts screenshot normal controls', () => {
  for (const target of targets) {
    test(`${target.mode}/${target.language} uses native reset then an exact one-pointer pinch`, async () => {
      const fixture = pageFixture(target);
      await preparePartsViewShot(fixture.page, target);
      const state = await measurePartsViewShot(fixture.page, target);
      expect(state.zoomX).toBe(target.zoom);
      expect(fixture.actions).toEqual([
        target.mode === 'parts' ? 'footprints' : 'page', 'native', 'touchStart', 'touchMove', 'touchEnd',
      ]);
      expect(fixture.touches[1]![0]).toEqual(fixture.touches[0]![0]);
      expect(fixture.touches[1]![1]!.x - fixture.touches[1]![0]!.x).toBe(32 * target.zoom);
    });
  }
  test('missing and disabled controls refuse before input', async () => {
    const fixture = pageFixture(parts);
    await expect(clickPartsViewControl(fixture.page, '#absent')).rejects.toThrow('PARTS_SHOT_CONTROL_MISSING');
    fixture.nodes['native-one'].disabled = true;
    await expect(clickPartsViewControl(fixture.page, '#native-one')).rejects.toThrow('PARTS_SHOT_CONTROL_UNAVAILABLE');
    expect(fixture.actions).toEqual([]);
  });
});
