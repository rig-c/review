import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createPartsViewport } from '../web/parts-viewport-provider.ts';
import { t } from '../web/i18n.ts';

interface BoxRecord {
  clearRects: [number, number, number, number][];
  fillRects: [number, number, number, number][];
  drawImages: number;
}

function makeCanvas(initialWidth = 20, initialHeight = 16): HTMLCanvasElement & { record: BoxRecord } {
  const record: BoxRecord = { clearRects: [], fillRects: [], drawImages: 0 };
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save() {},
    restore() {},
    setLineDash() {},
    clearRect(x: number, y: number, w: number, h: number) {
      record.clearRects.push([x, y, w, h]);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      record.fillRects.push([x, y, w, h]);
    },
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    drawImage() {
      record.drawImages++;
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
    },
    putImageData() {},
  };
  return {
    width: initialWidth,
    height: initialHeight,
    style: {},
    record,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement & { record: BoxRecord };
}

function makeHarness(options?: { painting?: boolean; mode?: 'parts' | 'atlas' }) {
  const src = readFileSync(new URL('../web/parts.ts', import.meta.url), 'utf8');
  const paintSlice = src.slice(src.indexOf('const itemImage ='), src.indexOf('\nfunction renderComparison('));
  const selectSlice = src.slice(src.indexOf('function select(index: number): void {'), src.indexOf('\nfunction updateEntry('));
  const bootStart = src.indexOf('frameSize:target=>{');
  const bootEnd = src.indexOf('});viewport.bindControls();');
  const frameSizeSlice = src.slice(bootStart, bootEnd);

  const canvas = makeCanvas(20, 16);
  const reference = makeCanvas(20, 16);
  const saveStatus = { textContent: '', dataset: {} as Record<string, string> };
  const caption = { textContent: '' };
  const overlay = { replaceChildren() {} };
  const rigRoot = { style: { left: '', top: '', transform: '' } };
  const referenceContent = { style: { left: '', top: '', transform: '' } };
  const zoomValue = { textContent: '1:1' };
  const nativeOne = {
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
  };
  const cameraSyncInput = { checked: Boolean(options?.painting) };
  const fitButton = { textContent: 'Fit' };
  const rigLabel = { textContent: 'Selected part' };
  const rigViewport = { clientWidth: 220, clientHeight: 160, tabIndex: 0 };
  const referenceViewport = { clientWidth: 220, clientHeight: 160, tabIndex: 0 };
  const rigPane = { hidden: false };
  const referencePane = { hidden: !options?.painting };

  const nodes: Record<string, unknown> = {
    'pv-canvas': canvas,
    'pv-reference': reference,
    'pv-save-status': saveStatus,
    'pv-caption': caption,
    'pv-overlay': overlay,
    'rig-root': rigRoot,
    'reference-content': referenceContent,
    'rig-viewport': rigViewport,
    'reference-viewport': referenceViewport,
    'rig-pane': rigPane,
    'reference-pane': referencePane,
    'zoom-value': zoomValue,
    'native-one': nativeOne,
    'camera-sync': cameraSyncInput,
    fit: fitButton,
    'rig-label': rigLabel,
  };
  const $ = <T = HTMLElement>(id: string): T => nodes[id] as T;

  const loaders = new Map<string, () => Promise<HTMLImageElement>>();
  const state = {
    data: {
      mode: options?.mode ?? ('parts' as const),
      title: 'fixture',
      sourceHash: '0'.repeat(64),
      verdictFile: 'parts-review.json',
      rigSize: [64, 64] as [number, number],
      painting: options?.painting ? { sha256: 'a'.repeat(64), width: 64, height: 64 } : null,
      differenceAvailable: false,
      pages: [
        { index: 0, name: 'page0.png', width: 64, height: 64 },
        { index: 1, name: 'page1.png', width: 32, height: 40 },
      ],
      items: [
        { index: 0, name: 'part-a', x: 0, y: 0, w: 20, h: 16, trimmed: false, flags: [], page: 'page0.png' },
        { index: 1, name: 'part-b', x: 4, y: 6, w: 8, h: 10, trimmed: false, flags: [], page: 'page1.png' },
        { index: 2, name: 'part-c', x: 2, y: 2, w: 12, h: 14, trimmed: false, flags: [], page: 'page0.png' },
      ],
      flags: [],
      verdict: null,
      verdictStale: null,
    },
    selected: 0,
    zoom: 1,
    view: 'item' as 'item' | 'page' | 'assembled',
    page: 0,
    bg: 'checker',
    alpha: false,
    footprints: false,
    comparison: { mode: 'part' as const, opacity: 0.65 },
    differenceThreshold: 8,
    meshShown: new Set<string>(),
    hidden: new Set<string>(),
    verdict: new Map(),
  };

  let commentActive = false;
  let commentRefreshCount = 0;
  const commentUi = {
    active: () => commentActive,
    refresh: () => {
      commentRefreshCount++;
    },
  };

  const documentStub = {
    createElement: () => ({ className: '', style: {}, dataset: {}, setAttribute() {}, append() {} }),
    querySelectorAll: () => [],
  };

  const code = ts.transpileModule(
    `const REGION_MARGIN = 4;\nlet painting = false;\n${paintSlice}\n${selectSlice}\nconst hostConfig = { ${frameSizeSlice} };\nconst navEnabled = () => !commentUi?.active() && !paintFailure;\nreturn { partFrame, rasterFrame, pageImage, paint, paintRaster, paintReference, select: (idx: number) => { select(idx); }, setView, hostConfig, navEnabled, getState: () => ({ paintToken, painting, paintFailure, paintReset }) };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;

  let viewport!: ReturnType<typeof createPartsViewport>;
  const api = new Function(
    'state',
    '$',
    't',
    'load',
    'partsApi',
    'getViewport',
    'commentUi',
    'renderCorrections',
    'renderList',
    'renderFlags',
    'renderVerdict',
    'renderMesh',
    'renderComparison',
    'queueMicrotask',
    'document',
    'paintPart',
    'paintBackground',
    'paintAlphaOnly',
    'paintPaintingCrop',
    'paintingRectangle',
    'frontParts',
    'paintOverlay',
    'paintFootprints',
    'paintAssembly',
    'paintAssemblyOutline',
    'paintMesh',
    `const viewport = new Proxy({}, { get(_t, prop) { const v = getViewport(); return v ? v[prop] : undefined; }, set(_t, prop, val) { const v = getViewport(); if (v) v[prop] = val; return true; } });\n${code}`,
  )(
    state,
    $,
    t,
    (url: string) => {
      const fn = loaders.get(url);
      if (!fn) return Promise.reject(new Error(`unexpected URL ${url}`));
      return fn();
    },
    '/api/parts',
    () => viewport,
    commentUi,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    (cb: () => void) => cb(),
    documentStub,
    (ctx: CanvasRenderingContext2D, item: { w: number; h: number }) => {
      ctx.fillRect(0, 0, item.w, item.h);
    },
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.fillRect(0, 0, w, h);
    },
    (ctx: CanvasRenderingContext2D, _img: unknown, _x: number, _y: number, w: number, h: number) => {
      ctx.fillRect(0, 0, w, h);
    },
    (ctx: CanvasRenderingContext2D, _img: unknown, _rect: unknown, w: number, h: number) => {
      ctx.fillRect(0, 0, w, h);
    },
    (box: { x: number; y: number; w: number; h: number }) => box,
    () => [],
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
  );

  viewport = createPartsViewport({
    el: $,
    canvas,
    message: msg => {
      saveStatus.textContent = t(msg);
    },
    reference: () => (state.data.painting ? reference : null),
    frameSize: api.hostConfig.frameSize,
  });
  if (state.data.painting) viewport.state.cameraSync = true;

  return {
    state,
    canvas,
    reference,
    saveStatus,
    rigRoot,
    referenceContent,
    zoomValue,
    nativeOne,
    loaders,
    viewport,
    api,
    setCommentActive(v: boolean) {
      commentActive = v;
    },
    getCommentRefreshCount() {
      return commentRefreshCount;
    },
  };
}

describe('parts failed paint camera and frame safety (#474)', () => {
  test('paintRaster failure clears canvas, resets camera to 1:1 on existing canvas, and refuses zoom/pan without resolving unpainted item frame', async () => {
    const h = makeHarness();
    h.loaders.set('/api/parts/image/0', () => Promise.resolve({ width: 20, height: 16 } as HTMLImageElement));
    h.loaders.set('/api/parts/image/1', () => Promise.reject(new Error('PARTS_PAINT_FAILED: image decode failed')));

    // Initial successful paint of item A (20x16)
    h.state.selected = 0;
    await h.api.paint();
    expect(h.canvas.width).toBe(20);
    expect(h.canvas.height).toBe(16);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 10, y: 8 });
    expect(h.rigRoot.style).toEqual({ left: '100px', top: '72px', transform: 'scale(1)' });

    // Select item B (8x10) whose image fails to load
    h.state.selected = 1;
    await h.api.paint();

    expect(h.api.getState().paintFailure).toBe('PARTS_PAINT_FAILED: view could not be rendered; select the part to retry');
    expect(h.saveStatus.textContent).toBe('PARTS_PAINT_FAILED: view could not be rendered; select the part to retry');

    // Canvas keeps its 20x16 buffer size (>0) and was cleared across 20x16
    expect(h.canvas.width).toBe(20);
    expect(h.canvas.height).toBe(16);
    expect(h.canvas.record.clearRects.at(-1)).toEqual([0, 0, 20, 16]);

    // Camera is pinned to 1:1 centered on the actual 20x16 canvas (center 10,8), NOT unpainted B (4,5)
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 10, y: 8 });
    expect(h.rigRoot.style).toEqual({ left: '100px', top: '72px', transform: 'scale(1)' });
    expect(h.zoomValue.textContent).toBe('1:1');

    // While paintFailure is active, paneFrame is null and navigation is disabled; zoom/pan/fit are refused
    expect(h.viewport.paneFrame('rig')).toBeNull();
    expect(h.viewport.availableCamera()).toBeNull();
    expect(h.api.navEnabled()).toBe(false);

    h.viewport.zoomCamera(1.25);
    h.viewport.panCamera('rig', 14, -9);
    h.viewport.fitActiveCamera();
    h.viewport.updateCamera('rig', { zoom: 2, pan: { x: 8, y: 6 } });
    h.viewport.zoomViewport('rig', -100, { x: 40, y: 30 });

    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 10, y: 8 });
    expect(h.rigRoot.style).toEqual({ left: '100px', top: '72px', transform: 'scale(1)' });
    expect(h.zoomValue.textContent).toBe('1:1');
  });

  test('in-flight zoom during held paint is reset back to 1:1 on the actual canvas when the held paint fails', async () => {
    const h = makeHarness();
    h.loaders.set('/api/parts/image/0', () => Promise.resolve({ width: 20, height: 16 } as HTMLImageElement));
    let rejectB!: (err: Error) => void;
    h.loaders.set(
      '/api/parts/image/1',
      () =>
        new Promise<HTMLImageElement>((_resolve, reject) => {
          rejectB = reject;
        }),
    );

    h.state.selected = 0;
    await h.api.paint();

    // Start selecting B (8x10); while B is in flight (paintFailure === null), user zooms (#464)
    h.state.selected = 1;
    const pendingPaint = h.api.paint();
    expect(h.api.getState().painting).toBe(true);
    expect(h.api.getState().paintFailure).toBeNull();

    h.viewport.zoomCamera(1.25);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1.25, center: { x: 4, y: 5 } });

    // Now B fails: camera must reset to 1:1 on the 20x16 canvas and lock against further zoom/pan
    rejectB(new Error('decode error'));
    await pendingPaint;

    expect(h.api.getState().painting).toBe(false);
    expect(h.api.getState().paintFailure).toBe('PARTS_PAINT_FAILED: view could not be rendered; select the part to retry');
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 10, y: 8 });
    expect(h.rigRoot.style).toEqual({ left: '100px', top: '72px', transform: 'scale(1)' });
    expect(h.zoomValue.textContent).toBe('1:1');

    h.viewport.zoomCamera(1.25);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 10, y: 8 });
  });

  test('paintReference failure clears both canvases, aligns reference size, resets both cameras to 1:1, and refuses zoom/pan until recovery', async () => {
    const h = makeHarness({ painting: true });
    h.loaders.set('/api/parts/image/0', () => Promise.resolve({ width: 20, height: 16 } as HTMLImageElement));
    h.loaders.set('/api/parts/image/1', () => Promise.resolve({ width: 8, height: 10 } as HTMLImageElement));
    let failPainting = false;
    h.loaders.set('/api/parts/painting', () =>
      failPainting
        ? Promise.reject(new Error('painting unavailable'))
        : Promise.resolve({ width: 64, height: 64 } as HTMLImageElement),
    );

    h.state.selected = 0;
    await h.api.paint();
    expect(h.canvas.width).toBe(20);
    expect(h.reference.width).toBe(20);

    // Switch to B (8x10): paintRaster succeeds and resizes pv-canvas to 8x10, then paintReference fails
    failPainting = true;
    h.state.selected = 1;
    await h.api.paint();

    expect(h.api.getState().paintFailure).toBe('PARTS_PAINT_FAILED: view could not be rendered; select the part to retry');
    expect(h.canvas.width).toBe(8);
    expect(h.canvas.height).toBe(10);
    expect(h.reference.width).toBe(8);
    expect(h.reference.height).toBe(10);
    expect(h.canvas.record.clearRects.at(-1)).toEqual([0, 0, 8, 10]);
    expect(h.reference.record.clearRects.at(-1)).toEqual([0, 0, 8, 10]);

    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.paneCamera('reference')).toEqual({ zoom: 1, center: { x: 4, y: 5 } });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 4, y: 5 });
    expect(h.rigRoot.style).toEqual({ left: '106px', top: '75px', transform: 'scale(1)' });
    expect(h.referenceContent.style).toEqual({ left: '106px', top: '75px', transform: 'scale(1)' });

    // Refuses zoom/pan on both rig and reference while paintFailure is active
    expect(h.viewport.paneFrame('rig')).toBeNull();
    expect(h.viewport.paneFrame('reference')).toBeNull();
    h.viewport.zoomCamera(1.25, 'rig');
    h.viewport.zoomCamera(1.25, 'reference');
    h.viewport.panCamera('reference', 10, 10);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.paneCamera('reference')).toEqual({ zoom: 1, center: { x: 4, y: 5 } });

    // Recover by retrying B when painting succeeds
    failPainting = false;
    h.state.selected = 1;
    await h.api.paint();
    expect(h.api.getState().paintFailure).toBeNull();
    expect(h.saveStatus.textContent).toBe('');

    h.viewport.zoomCamera(1.25);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1.25, center: { x: 4, y: 5 } });
    expect(h.viewport.paneCamera('reference')).toEqual({ zoom: 1.25, center: { x: 4, y: 5 } });
  });

  test('rasterFrame returns null instead of throwing for missing atlas page in both page view and item view', async () => {
    const h = makeHarness({ mode: 'atlas' });
    h.loaders.set('/api/parts/page/0', () => Promise.resolve({ width: 64, height: 64 } as HTMLImageElement));

    h.state.selected = 0;
    await h.api.paint();
    expect(h.canvas.width).toBe(24);
    expect(h.canvas.height).toBe(20);

    // Control 1: page view with out-of-range state.page
    h.state.view = 'page';
    h.state.page = 99;
    expect(h.api.rasterFrame(h.state.data, h.state.data.items[0])).toBeNull();
    expect(h.api.hostConfig.frameSize('rig')).toEqual({ w: 0, h: 0 });
    await h.api.paint();
    expect(h.api.getState().paintFailure).toBe('PARTS_PAINT_FAILED: view could not be rendered; select the part to retry');
    expect(h.viewport.paneFrame('rig')).toBeNull();
    expect(h.viewport.state.displayedCenter).toEqual({ x: 12, y: 10 });

    // Control 2: item view in atlas mode where item.page is missing from data.pages
    h.state.view = 'item';
    const orphanItem = {
      index: 3,
      name: 'orphan-region',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      trimmed: false,
      flags: [],
      page: 'missing-page.png',
    };
    h.state.data.items.push(orphanItem as typeof h.state.data.items[0]);
    expect(h.api.rasterFrame(h.state.data, orphanItem)).toBeNull();
    await expect(h.api.pageImage(orphanItem.page)).rejects.toThrow('PARTS_PAINT_FAILED');

    h.state.selected = 3;
    await h.api.paint();
    expect(h.api.getState().paintFailure).toBe('PARTS_PAINT_FAILED: view could not be rendered; select the part to retry');
    expect(h.viewport.paneFrame('rig')).toBeNull();
    h.viewport.zoomCamera(1.25);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1, center: null });
    expect(h.viewport.state.displayedCenter).toEqual({ x: 12, y: 10 });
  });

  test('stale failed paint token cannot clobber or lock a newer successful paint', async () => {
    const h = makeHarness();
    h.loaders.set('/api/parts/image/0', () => Promise.resolve({ width: 20, height: 16 } as HTMLImageElement));
    let rejectB!: (err: Error) => void;
    h.loaders.set(
      '/api/parts/image/1',
      () =>
        new Promise<HTMLImageElement>((_resolve, reject) => {
          rejectB = reject;
        }),
    );
    h.loaders.set('/api/parts/image/2', () => Promise.resolve({ width: 12, height: 14 } as HTMLImageElement));

    h.state.selected = 0;
    await h.api.paint();

    // Select B (held), then immediately select C (12x14) which succeeds before B rejects
    h.state.selected = 1;
    const paintB = h.api.paint();
    h.state.selected = 2;
    await h.api.paint();

    expect(h.canvas.width).toBe(12);
    expect(h.canvas.height).toBe(14);
    expect(h.api.getState().paintFailure).toBeNull();

    rejectB(new Error('late failure on B'));
    await paintB;

    expect(h.api.getState().paintFailure).toBeNull();
    expect(h.canvas.width).toBe(12);
    expect(h.canvas.height).toBe(14);
    expect(h.viewport.state.displayedCenter).toEqual({ x: 6, y: 7 });

    h.viewport.zoomCamera(1.25);
    expect(h.viewport.paneCamera('rig')).toEqual({ zoom: 1.25, center: { x: 6, y: 7 } });
  });
});
