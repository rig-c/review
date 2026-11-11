import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {readFile} from 'node:fs/promises';
import { sourceSha256 } from '../src/parts-view.ts';
import type { InputCdpSession } from './parts-explorer-browser.ts';
import {
  assertPartsViewAtlasFrame,
  assertPartsViewShotState,
  assertPartsViewSourceBinding,
  centerPartsViewShot,
  clickPartsViewControl,
  measurePartsViewShot,
  preparePartsViewShot,
  type PartsViewAtlasFrame,
  type PartsViewRect,
  type PartsViewShotState,
  type PartsViewShotTarget,
  type PartsViewSourceBinding,
} from './helpers/parts-view-shots.ts';

const parts: PartsViewShotTarget = { mode: 'parts', view: 'item', zoom: 2, language: 'en' };
const atlas: PartsViewShotTarget = { mode: 'atlas', view: 'page', zoom: 4, language: 'ko' };
const targets = [parts, { ...parts, language: 'ko' as const }, atlas, { ...atlas, language: 'en' as const }];

function boxRect(left: number, top: number, width: number, height: number): PartsViewRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function demoSourceBinding(): PartsViewSourceBinding {
  const files = [
    { path: 'skeleton.model.json', bytes: 3120, sha256: '9f6cd2c70757962d3b1e229d28812b2db120013b085d8ef845b81ac7bb8401ae' },
    { path: 'lantern.png', bytes: 285, sha256: '908c7c81a8c72617fbe4d8f3b97b39a9e800b61d001c10a67d77a5adbaf165c9' },
  ];
  const sha = sourceSha256(files);
  return {
    sourceHash: sha,
    beforeSourceHash: sha,
    afterSourceHash: sha,
    files,
    page: { name: 'lantern.png', width: 20, height: 20 },
    regions: [{ name: 'lantern', x: 0, y: 0, w: 20, h: 20 }],
  };
}

function measuredAtlasFrame(zoom = 4, offsetX = 0, offsetY = 0, canvasW = 20, canvasH = 20): PartsViewAtlasFrame {
  const viewportRect = boxRect(100, 100, 400, 200);
  const documentViewportRect = boxRect(0, 0, 1280, 800);
  const headingRect = boxRect(106, 104, 80, 18);
  const usablePaneRect = boxRect(100, 122, 400, 178);
  const rootLeft = 160 + offsetX;
  const rootTop = 60 + offsetY;
  const canvasRect = boxRect(viewportRect.left + rootLeft, viewportRect.top + rootTop, canvasW * zoom, canvasH * zoom);
  const regionBox = boxRect(canvasRect.left, canvasRect.top, canvasW * zoom, canvasH * zoom);
  const outlineWidth = 1;
  const outlineOffset = 0;
  const scaledOutlineX = outlineWidth * zoom;
  const scaledOutlineY = outlineWidth * zoom;
  const outlinedBoxRect = boxRect(
    regionBox.left - scaledOutlineX,
    regionBox.top - scaledOutlineY,
    regionBox.width + 2 * scaledOutlineX,
    regionBox.height + 2 * scaledOutlineY,
  );
  const labelRect = boxRect(regionBox.left, regionBox.top - 6 * zoom, 14 * zoom, 4 * zoom);
  const envLeft = Math.min(canvasRect.left, outlinedBoxRect.left, labelRect.left);
  const envTop = Math.min(canvasRect.top, outlinedBoxRect.top, labelRect.top);
  const envRight = Math.max(canvasRect.right, outlinedBoxRect.right, labelRect.right);
  const envBottom = Math.max(canvasRect.bottom, outlinedBoxRect.bottom, labelRect.bottom);
  return {
    viewportRect,
    documentViewportRect,
    clippingAncestors: [{ id: 'rig-pane', tag: 'section', className: 'stage-pane', rect: viewportRect }],
    visibleViewportRect: viewportRect,
    headingRect,
    usablePaneRect,
    canvasRect,
    rigRoot: {
      left: rootLeft,
      top: rootTop,
      rect: canvasRect,
      matrix: { a: zoom, b: 0, c: 0, d: zoom, e: 0, f: 0 },
    },
    camera: {
      center: { x: (viewportRect.width / 2 - rootLeft) / zoom, y: (viewportRect.height / 2 - rootTop) / zoom },
      visible: {
        x: (viewportRect.width / 2 - rootLeft) / zoom - viewportRect.width / zoom / 2,
        y: (viewportRect.height / 2 - rootTop) / zoom - viewportRect.height / zoom / 2,
        width: viewportRect.width / zoom,
        height: viewportRect.height / zoom,
      },
    },
    regions: [{
      name: 'lantern',
      source: { x: 0, y: 0, w: canvasW, h: canvasH },
      boxRect: regionBox,
      outlineWidth,
      outlineOffset,
      scaledOutlineX,
      scaledOutlineY,
      outlinedBoxRect,
      labelText: 'lantern',
      labelRect,
    }],
    envelope: boxRect(envLeft, envTop, envRight - envLeft, envBottom - envTop),
    source: demoSourceBinding(),
  };
}

function measured(target: PartsViewShotTarget): PartsViewShotState {
  const isAtlas = target.mode === 'atlas';
  const canvas = isAtlas ? { width: 20, height: 20 } : { width: 30, height: 32 };
  return {
    mode: target.mode, view: target.view, language: target.language,
    zoomX: target.zoom, zoomY: target.zoom, canvasZoomX: target.zoom, canvasZoomY: target.zoom,
    zoomLabel: `${target.zoom * 100}.0%`, nativeOne: false, footprints: true,
    canvas,
    ...(isAtlas ? { atlasFrame: measuredAtlasFrame(target.zoom) } : {}),
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

describe('atlas decorated frame and source binding oracle', () => {
  test('exact edge containment passes while 1px beyond any usable pane edge refuses PARTS_SHOT_FRAME_CLIPPED', () => {
    for (const lang of ['en', 'ko'] as const) {
      const target: PartsViewShotTarget = { ...atlas, language: lang };
      // At offsetX = -156, outlinedBoxRect.left === 100 === usablePaneRect.left (exact left edge containment).
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, -156, 0) }, target))
        .not.toThrow();
      // 1px further left clips the left edge.
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, -157, 0) }, target))
        .toThrow('PARTS_SHOT_FRAME_CLIPPED');
      // 1px past right edge (usablePaneRect.right = 500; at offsetX = 156, outlinedBoxRect.right = 500).
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, 156, 0) }, target))
        .not.toThrow();
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, 157, 0) }, target))
        .toThrow('PARTS_SHOT_FRAME_CLIPPED');
      // Top edge (usablePaneRect.top = 122; labelRect.top = 136 + offsetY -> exact at offsetY = -14, clipped at -15).
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, 0, -14) }, target))
        .not.toThrow();
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, 0, -15) }, target))
        .toThrow('PARTS_SHOT_FRAME_CLIPPED');
      // Bottom edge (usablePaneRect.bottom = 300; outlinedBoxRect.bottom = 244 + offsetY -> exact at +56, clipped at +57).
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, 0, 56) }, target))
        .not.toThrow();
      expect(() => assertPartsViewShotState({ ...measured(target), atlasFrame: measuredAtlasFrame(4, 0, 57) }, target))
        .toThrow('PARTS_SHOT_FRAME_CLIPPED');
    }
  });

  test('canvas fits usable pane but clipped region outline, clipped label, or heading overlap refuses PARTS_SHOT_FRAME_CLIPPED', () => {
    // 1. Canvas [102..182] is inside usablePane [100..500], but 4px scaled outline reaches left=98 < 100.
    const outlineClipped = measuredAtlasFrame(4, -158, 0);
    expect(outlineClipped.canvasRect.left).toBeGreaterThanOrEqual(outlineClipped.usablePaneRect.left);
    expect(outlineClipped.regions[0]!.outlinedBoxRect.left).toBeLessThan(outlineClipped.usablePaneRect.left);
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: outlineClipped }, atlas))
      .toThrow('PARTS_SHOT_FRAME_CLIPPED');

    // 2. Canvas [126..206] and outlinedBox [122..210] fit inside usablePane top=122, but label reaches top=102 < 122.
    const labelClipped = measuredAtlasFrame(4, 0, -34);
    expect(labelClipped.canvasRect.top).toBeGreaterThanOrEqual(labelClipped.usablePaneRect.top);
    expect(labelClipped.regions[0]!.outlinedBoxRect.top).toBeGreaterThanOrEqual(labelClipped.usablePaneRect.top);
    expect(labelClipped.regions[0]!.labelRect.top).toBeLessThan(labelClipped.usablePaneRect.top);
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: labelClipped }, atlas))
      .toThrow('PARTS_SHOT_FRAME_CLIPPED');

    // 3. Heading overlap: even if usablePaneRect were starting at 100, overlapping headingRect fails.
    const headingOverlap = measuredAtlasFrame(4, -140, -20);
    headingOverlap.usablePaneRect = boxRect(100, 100, 400, 200);
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: headingOverlap }, atlas))
      .toThrow('PARTS_SHOT_FRAME_CLIPPED');
  });

  test('decorated envelope wider or taller than usable pane refuses PARTS_SHOT_FRAME_OVERSIZED', () => {
    const tooWideFrame = measuredAtlasFrame(4, 0, 0, 100, 20);
    tooWideFrame.source = {
      ...demoSourceBinding(),
      page: { name: 'lantern.png', width: 100, height: 20 },
      regions: [{ name: 'lantern', x: 0, y: 0, w: 100, h: 20 }],
    };
    expect(() => assertPartsViewShotState({
      ...measured(atlas),
      canvas: { width: 100, height: 20 },
      atlasFrame: tooWideFrame,
    }, atlas)).toThrow('PARTS_SHOT_FRAME_OVERSIZED');

    const tooTallFrame = measuredAtlasFrame(4, 0, 0, 20, 45);
    tooTallFrame.source = {
      ...demoSourceBinding(),
      page: { name: 'lantern.png', width: 20, height: 45 },
      regions: [{ name: 'lantern', x: 0, y: 0, w: 20, h: 45 }],
    };
    expect(() => assertPartsViewShotState({
      ...measured(atlas),
      canvas: { width: 20, height: 45 },
      atlasFrame: tooTallFrame,
    }, atlas)).toThrow('PARTS_SHOT_FRAME_OVERSIZED');
  });

  test('missing, zero, nonfinite or non-axis-aligned geometry and mismatched source/region/label refuse explicitly', () => {
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: undefined }, atlas))
      .toThrow('PARTS_SHOT_GEOMETRY_INVALID');

    const nonAxis = measuredAtlasFrame(4);
    nonAxis.rigRoot.matrix.b = 0.01;
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: nonAxis }, atlas))
      .toThrow('PARTS_SHOT_GEOMETRY_INVALID');

    const zeroPane = measuredAtlasFrame(4);
    zeroPane.usablePaneRect = boxRect(100, 122, 0, 178);
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: zeroPane }, atlas))
      .toThrow('PARTS_SHOT_GEOMETRY_INVALID');

    const nanLabel = measuredAtlasFrame(4);
    nanLabel.regions[0]!.labelRect = boxRect(NaN, 136, 56, 16);
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: nanLabel }, atlas))
      .toThrow('PARTS_SHOT_GEOMETRY_INVALID');

    const noRegions = measuredAtlasFrame(4);
    noRegions.regions = [];
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: noRegions }, atlas))
      .toThrow('PARTS_SHOT_GEOMETRY_INVALID');

    const wrongLabel = measuredAtlasFrame(4);
    wrongLabel.regions[0]!.labelText = 'wrong_name';
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: wrongLabel }, atlas))
      .toThrow('PARTS_SHOT_SOURCE_MISMATCH');

    const wrongRegionTuple = measuredAtlasFrame(4);
    wrongRegionTuple.source = {
      ...demoSourceBinding(),
      regions: [{ name: 'lantern', x: 0, y: 0, w: 19, h: 20 }],
    };
    expect(() => assertPartsViewAtlasFrame({ ...measured(atlas), atlasFrame: wrongRegionTuple }, atlas))
      .toThrow('PARTS_SHOT_SOURCE_MISMATCH');

    const changedDigest: PartsViewSourceBinding = {
      ...demoSourceBinding(),
      afterSourceHash: 'a'.repeat(64),
    };
    expect(() => assertPartsViewSourceBinding(changedDigest, measured(atlas), atlas))
      .toThrow('PARTS_SHOT_SOURCE_MISMATCH');
  });
});

// Disposable DOM/CDP test double. It creates no owner act or persisted Review state.
function pageFixture(target: PartsViewShotTarget, pinchScale = 1, options?: {
  offsetX?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  panScale?: number;
  failPanMove?: boolean;
  panZoomScale?: number;
  panView?: string;
}) {
  let zoom = 1;
  let view = 'item';
  let footprints = false;
  const canvasWidth = options?.canvasWidth ?? (target.mode === 'atlas' ? 20 : 30);
  const canvasHeight = options?.canvasHeight ?? (target.mode === 'atlas' ? 20 : 32);
  let offsetX = options?.offsetX ?? 0;
  let offsetY = 0;
  let held: { x: number; y: number } | undefined;
  const mouseEvents: { type: string; x: number; y: number }[] = [];
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
  const stageLayoutNode: Record<string, any> = {
    id: 'stage-layout',
    tagName: 'DIV',
    className: 'pv-canvas-wrap',
    parentElement: null,
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
  };
  const rigPaneNode: Record<string, any> = {
    id: 'rig-pane',
    tagName: 'SECTION',
    className: 'stage-pane',
    parentElement: stageLayoutNode,
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
  };
  const labelSpanNode = {
    textContent: 'lantern',
    getBoundingClientRect: () => ({
      left: 260 + offsetX,
      top: 160 + offsetY - 6 * zoom,
      width: 14 * zoom,
      height: 4 * zoom,
    }),
  };
  const regionBoxNode = {
    dataset: { region: 'lantern', x: '0', y: '0', w: String(canvasWidth), h: String(canvasHeight) },
    getBoundingClientRect: () => ({
      left: 260 + offsetX,
      top: 160 + offsetY,
      width: canvasWidth * zoom,
      height: canvasHeight * zoom,
    }),
    querySelector: (sel: string) => sel === 'span' ? labelSpanNode : null,
  };
  Object.assign(nodes, {
    'pv-atlas-switch': { hidden: target.mode === 'parts' },
    'pv-assemble': { getAttribute: () => 'false' },
    'rig-label': {
      getBoundingClientRect: () => ({ left: 106, top: 104, width: 80, height: 18 }),
    },
    'rig-root': {
      style: {
        get left() { return `${160 + offsetX}px`; },
        get top() { return `${60 + offsetY}px`; },
      },
      getBoundingClientRect: () => ({
        left: 260 + offsetX,
        top: 160 + offsetY,
        width: canvasWidth * zoom,
        height: canvasHeight * zoom,
      }),
    },
    'rig-viewport': {
      parentElement: rigPaneNode,
      clientLeft: 0,
      clientTop: 0,
      clientWidth: 400,
      clientHeight: 200,
      contains: (node: unknown) => node === nodes['rig-viewport'],
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 200 }),
    },
    'pv-canvas': {
      width: canvasWidth,
      height: canvasHeight,
      getBoundingClientRect: () => ({
        left: 260 + offsetX,
        top: 160 + offsetY,
        width: canvasWidth * zoom,
        height: canvasHeight * zoom,
      }),
    },
  });
  nodes['native-one'].getAttribute = () => String(zoom === 1);
  Object.defineProperty(nodes['pv-footprints'], 'checked', { get: () => footprints });
  Object.defineProperty(nodes, 'zoom-value', { get: () => ({ textContent: zoom === 1 ? '1:1' : `${(zoom * 100).toFixed(1)}%` }) });
  const document = {
    documentElement: { lang: target.language, clientWidth: 1280, clientHeight: 800 },
    body: {},
    getElementById: (id: string) => nodes[id],
    querySelector: (selector: string) => {
      if (selector === '[data-view][aria-pressed="true"]') return { dataset: { view } };
      if (selector === '[data-view=item]') return nodes['pv-atlas-switch'];
      if (selector === '[data-view=assembled]') return nodes['pv-assemble'];
      if (selector === '[data-view="page"]') return nodes.page;
      if (selector === '.pv-box[data-region]') return view === 'page' ? regionBoxNode : null;
      return nodes[selector.slice(1)];
    },
    querySelectorAll: (selector: string) => {
      if (selector === '.pv-box[data-region]') return view === 'page' ? [regionBoxNode] : [];
      return [];
    },
    elementFromPoint: (x: number, y: number) => y === 5
      ? Object.values(nodes).find(node => node.getBoundingClientRect?.().left === x - 5)
      : nodes['rig-viewport'].panBlocked ? null : nodes['rig-viewport'].hitTarget ?? nodes['rig-viewport'],
  };
  const page: InputCdpSession = {
    async evaluate(expression) {
      return runInNewContext(expression, {
        document,
        getComputedStyle: (node: unknown) => node === regionBoxNode
          ? { outlineStyle: 'solid', outlineWidth: '1px', outlineOffset: '0px' }
          : { transform: String(zoom), overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' },
        DOMMatrix: class {
          a: number;
          b = 0;
          c = 0;
          d: number;
          e = 0;
          f = 0;
          constructor(value: string) {
            this.a = Number(value);
            this.d = Number(value);
          }
        },
      });
    },
    async mouse(type, x, y) {
      mouseEvents.push({ type, x, y });
      if (type === 'mousePressed' && y !== 5) held = { x, y };
      if (type === 'mouseMoved' && held) {
        if (options?.failPanMove) throw new Error('PLANTED_PAN_MOVE_FAILURE');
        offsetX += (x - held.x) * (options?.panScale ?? 1);
        offsetY += (y - held.y) * (options?.panScale ?? 1);
        held = { x, y };
        zoom *= options?.panZoomScale ?? 1;
        view = options?.panView ?? view;
      }
      if (type === 'mouseReleased' && held) {
        held = undefined;
        return;
      }
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
        zoom *= ((points[1]!.x - points[0]!.x) / (start[1]!.x - start[0]!.x)) * pinchScale;
      }
    },
    async setViewport() {},
    async goto() {},
    async close() {},
    async screenshot() { return Buffer.alloc(0); },
  };
  return { page, actions, touches, nodes, mouseEvents, get pointerHeld() { return held !== undefined; } };
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
  test('measurePartsViewShot refuses a wrong-pinch fixture with PARTS_SHOT_ZOOM_MISMATCH', async () => {
    for (const target of targets) {
      const fixture = pageFixture(target, 0.75);
      await preparePartsViewShot(fixture.page, target);
      await expect(measurePartsViewShot(fixture.page, target)).rejects.toThrow('PARTS_SHOT_ZOOM_MISMATCH');
    }
  });
  test('measurePartsViewShot persists raw geometry to callback before throwing PARTS_SHOT_FRAME_CLIPPED', async () => {
    const fixture = pageFixture(atlas, 1, { offsetX: 192 });
    await preparePartsViewShot(fixture.page, atlas);
    let persisted: PartsViewShotState | undefined;
    await expect(measurePartsViewShot(fixture.page, { ...atlas, source: demoSourceBinding() }, raw => {
      persisted = raw;
    })).rejects.toThrow('PARTS_SHOT_FRAME_CLIPPED');
    expect(persisted).toBeDefined();
    expect(persisted?.atlasFrame?.envelope.right).toBeGreaterThan(persisted?.atlasFrame?.usablePaneRect.right ?? 0);
    expect(persisted?.atlasFrame?.source?.sourceHash).toBe(demoSourceBinding().sourceHash);
  });
  test('missing and disabled controls refuse before input', async () => {
    const fixture = pageFixture(parts);
    await expect(clickPartsViewControl(fixture.page, '#absent')).rejects.toThrow('PARTS_SHOT_CONTROL_MISSING');
    fixture.nodes['native-one'].disabled = true;
    await expect(clickPartsViewControl(fixture.page, '#native-one')).rejects.toThrow('PARTS_SHOT_CONTROL_UNAVAILABLE');
    expect(fixture.actions).toEqual([]);
    expect(fixture.mouseEvents).toEqual([]);
    fixture.nodes['native-one'].disabled = false;
    await clickPartsViewControl(fixture.page, '#native-one');
    expect(fixture.mouseEvents.map(event => event.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(fixture.actions).toEqual(['native']);
  });
});

test('#614 actual comment mark refuses old pins and controls before press and accepts one empty-pane start',async()=>{
  const source=await readFile('tests/parts-comments-browser.ts','utf8');
  const begin=source.indexOf('const camera='),end=source.indexOf('const commentState=',begin);
  const camera=new Function(source.slice(begin,end)+';return camera;')() as string;
  const markBegin=source.indexOf('async function mark('),markEnd=source.indexOf('\nasync function atlasClick',markBegin);
  const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(markBegin,markEnd));
  const mark=new Function('camera','assert','wait',code+';return mark;')(camera,
    (value:unknown,message:string)=>{if(!value)throw Error(message);},()=>{throw Error('UNEXPECTED_COMPOSER_WAIT');}) as
    (page:InputCdpSession,from:{x:number;y:number},to:{x:number;y:number},summary:string,onStart:(state:any)=>void)=>Promise<void>;
  for(const blockedClass of ['stage-comment-pin stage-comment-ui','control','outside']){
    const fixture=pageFixture(parts);fixture.nodes['rig-root'].style.transform='1';
    const target={tagName:'BUTTON',id:'old-target',className:blockedClass,closest:()=>target};
    fixture.nodes['rig-viewport'].contains=(node:unknown)=>node===fixture.nodes['rig-viewport']||node===target;
    if(blockedClass==='outside')fixture.nodes['rig-viewport'].panBlocked=true;
    else fixture.nodes['rig-viewport'].hitTarget=target;
    let observed:any;
    await expect(mark(fixture.page,{x:12,y:12},{x:25,y:24},'guard',state=>{observed=state;})).rejects.toThrow('PARTS_COMMENT_DRAG_START_BLOCKED');
    expect(observed.hit.allowed).toBe(false);
    expect(fixture.mouseEvents.map(event=>event.type)).toEqual(['mouseMoved']);
    expect(fixture.actions).toEqual([]);
  }
  const fixture=pageFixture(parts);fixture.nodes['rig-root'].style.transform='1';
  const originalMouse=fixture.page.mouse.bind(fixture.page);
  fixture.page.mouse=async(type,x,y,delta)=>{await originalMouse(type,x,y,delta);if(type==='mousePressed')throw Error('CONTROLLED_ALLOWED_PRESS');};
  let observed:any;
  await expect(mark(fixture.page,{x:25,y:24},{x:12,y:12},'guard',state=>{observed=state;})).rejects.toThrow('CONTROLLED_ALLOWED_PRESS');
  expect(observed.hit.allowed).toBe(true);
  expect(observed.from).toEqual({x:25,y:24});expect(observed.to).toEqual({x:12,y:12});
  expect(fixture.mouseEvents.map(event=>event.type)).toEqual(['mouseMoved','mousePressed']);
});

describe('atlas screenshot supported pointer pan', () => {
  for (const language of ['en', 'ko'] as const) {
    test(`${language} centers the complete frame with one clear held-pointer drag and preserves exact controls/source`, async () => {
      const target = { ...atlas, language, source: demoSourceBinding() };
      const fixture = pageFixture(target, 1, { offsetX: 192 });
      await preparePartsViewShot(fixture.page, target);
      const stages: string[] = [];
      const pan = await centerPartsViewShot(fixture.page, target, (_state, stage) => { stages.push(stage); });
      expect(stages).toEqual(['before-pan', 'after-pan']);
      expect(() => assertPartsViewShotState(pan.before, target)).toThrow('PARTS_SHOT_FRAME_CLIPPED');
      const final = await measurePartsViewShot(fixture.page, target);
      expect(final).toEqual(pan.after);
      const frame = final.atlasFrame!;
      expect(frame.envelope.left + frame.envelope.width / 2).toBe(frame.usablePaneRect.left + frame.usablePaneRect.width / 2);
      expect(frame.envelope.top + frame.envelope.height / 2).toBe(frame.usablePaneRect.top + frame.usablePaneRect.height / 2);
      expect([final.zoomX, final.zoomY, final.canvasZoomX, final.canvasZoomY, final.zoomLabel, final.nativeOne])
        .toEqual([4, 4, 4, 4, '400.0%', false]);
      expect([final.mode, final.view, final.language]).toEqual(['atlas', 'page', language]);
      expect(frame.source).toEqual(target.source);
      expect(frame.regions.map(r => [r.name, r.source, r.labelText]))
        .toEqual(pan.before.atlasFrame!.regions.map(r => [r.name, r.source, r.labelText]));
      expect(fixture.mouseEvents.slice(-4)).toEqual([
        { type: 'mouseMoved', ...pan.start },
        { type: 'mousePressed', ...pan.start },
        { type: 'mouseMoved', ...pan.end },
        { type: 'mouseReleased', ...pan.end },
      ]);
      expect(fixture.actions).toEqual(['page', 'native', 'touchStart', 'touchMove', 'touchEnd']);
      expect(fixture.pointerHeld).toBe(false);
    });
  }

  test('oversized width or height refuses by name before pan input', async () => {
    for (const dimensions of [{ canvasWidth: 100 }, { canvasHeight: 45 }]) {
      const fixture = pageFixture(atlas, 1, dimensions);
      await preparePartsViewShot(fixture.page, atlas);
      const inputsBefore = fixture.mouseEvents.length;
      await expect(centerPartsViewShot(fixture.page, atlas)).rejects.toThrow('PARTS_SHOT_FRAME_OVERSIZED');
      expect(fixture.mouseEvents.length).toBe(inputsBefore);
    }
  });

  test('wrong pinch refuses before pan without changing the existing zoom guard', async () => {
    const fixture = pageFixture(atlas, 0.75, { offsetX: 192 });
    await preparePartsViewShot(fixture.page, atlas);
    const inputsBefore = fixture.mouseEvents.length;
    await expect(centerPartsViewShot(fixture.page, atlas)).rejects.toThrow('PARTS_SHOT_ZOOM_MISMATCH');
    expect(fixture.mouseEvents.length).toBe(inputsBefore);
  });

  test('no-op and wrong-direction drags still fail strict final framing and persist after-pan geometry', async () => {
    for (const panScale of [0, -1]) {
      const fixture = pageFixture(atlas, 1, { offsetX: 192, panScale });
      await preparePartsViewShot(fixture.page, atlas);
      const stages: string[] = [];
      await expect(centerPartsViewShot(fixture.page, atlas, (_state, stage) => { stages.push(stage); }))
        .rejects.toThrow('PARTS_SHOT_FRAME_CLIPPED');
      expect(stages).toEqual(['before-pan', 'after-pan']);
      expect(fixture.pointerHeld).toBe(false);
    }
  });

  test('pan cannot hide a changed zoom or Pages selection', async () => {
    for (const change of [
      { options: { panZoomScale: 0.75 }, code: 'PARTS_SHOT_ZOOM_MISMATCH' },
      { options: { panView: 'item' }, code: 'PARTS_SHOT_VIEW_MISMATCH' },
    ]) {
      const fixture = pageFixture(atlas, 1, { offsetX: 192, ...change.options });
      await preparePartsViewShot(fixture.page, atlas);
      await expect(centerPartsViewShot(fixture.page, atlas)).rejects.toThrow(change.code);
      expect(fixture.pointerHeld).toBe(false);
    }
  });

  test('blocked hit targets and a translation without a safe span refuse before input', async () => {
    for (const offsetX of [192, 1000]) {
      const fixture = pageFixture(atlas, 1, { offsetX });
      await preparePartsViewShot(fixture.page, atlas);
      fixture.nodes['rig-viewport'].panBlocked = offsetX === 192;
      const inputsBefore = fixture.mouseEvents.length;
      await expect(centerPartsViewShot(fixture.page, atlas)).rejects.toThrow('PARTS_SHOT_PAN_UNAVAILABLE');
      expect(fixture.mouseEvents.length).toBe(inputsBefore);
    }
  });

  test('a move failure releases the held pointer', async () => {
    const fixture = pageFixture(atlas, 1, { offsetX: 192, failPanMove: true });
    await preparePartsViewShot(fixture.page, atlas);
    await expect(centerPartsViewShot(fixture.page, atlas)).rejects.toThrow('PLANTED_PAN_MOVE_FAILURE');
    expect(fixture.mouseEvents.at(-1)?.type).toBe('mouseReleased');
    expect(fixture.pointerHeld).toBe(false);
  });
});
