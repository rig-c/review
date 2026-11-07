import type { InputCdpSession } from '../parts-explorer-browser.ts';

export interface PartsViewShotTarget {
  mode: 'parts' | 'atlas';
  view: 'item' | 'page';
  zoom: number;
  language: 'en' | 'ko';
}

export interface PartsViewShotState {
  mode: 'parts' | 'atlas';
  view: string | null;
  language: string;
  zoomX: number;
  zoomY: number;
  canvasZoomX: number;
  canvasZoomY: number;
  zoomLabel: string;
  nativeOne: boolean;
  footprints: boolean;
  canvas: { width: number; height: number };
}

export const partsViewShotStateExpression = `(() => {
  const required = id => {
    const node = document.getElementById(id);
    if (!node) throw new Error('PARTS_SHOT_CONTROL_MISSING: #' + id);
    return node;
  };
  const canvas = required('pv-canvas');
  const rect = canvas.getBoundingClientRect();
  const matrix = new DOMMatrix(getComputedStyle(required('rig-root')).transform);
  const selected = document.querySelector('[data-pv-view][aria-pressed="true"]');
  return {
    mode: required('pv-atlas-switch').hidden ? 'parts' : 'atlas',
    view: required('pv-assemble').getAttribute('aria-pressed') === 'true'
      ? 'assembled' : selected?.dataset.pvView ?? null,
    language: document.documentElement.lang,
    zoomX: matrix.a,
    zoomY: matrix.d,
    canvasZoomX: rect.width / canvas.width,
    canvasZoomY: rect.height / canvas.height,
    zoomLabel: required('zoom-value').textContent,
    nativeOne: required('native-one').getAttribute('aria-pressed') === 'true',
    footprints: required('pv-footprints').checked,
    canvas: { width: canvas.width, height: canvas.height }
  };
})()`;

export function assertPartsViewShotState(actual: PartsViewShotState, target: PartsViewShotTarget): void {
  if (actual.mode !== target.mode || actual.view !== target.view || actual.language !== target.language) {
    throw new Error(`PARTS_SHOT_VIEW_MISMATCH: expected ${JSON.stringify(target)}, measured ${JSON.stringify(actual)}`);
  }
  const label = target.zoom === 1 ? '1:1' : `${(target.zoom * 100).toFixed(1)}%`;
  if (actual.zoomX !== target.zoom || actual.zoomY !== target.zoom ||
      actual.canvasZoomX !== target.zoom || actual.canvasZoomY !== target.zoom ||
      actual.zoomLabel !== label || actual.nativeOne !== (target.zoom === 1)) {
    throw new Error(`PARTS_SHOT_ZOOM_MISMATCH: expected ${target.zoom}, measured ${JSON.stringify(actual)}`);
  }
  if (target.mode === 'parts' && !actual.footprints) {
    throw new Error('PARTS_SHOT_FOOTPRINTS_MISSING: parts capture requires front footprints');
  }
}

export async function measurePartsViewShot(page: InputCdpSession, target: PartsViewShotTarget): Promise<PartsViewShotState> {
  const actual = await page.evaluate<PartsViewShotState>(partsViewShotStateExpression);
  assertPartsViewShotState(actual, target);
  return actual;
}

export async function clickPartsViewControl(page: InputCdpSession, selector: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const selector = ${JSON.stringify(selector)};
    const node = document.querySelector(selector);
    if (!node) throw new Error('PARTS_SHOT_CONTROL_MISSING: ' + selector);
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (node.disabled || rect.width <= 0 || rect.height <= 0 ||
        !node.contains(document.elementFromPoint(x, y))) {
      throw new Error('PARTS_SHOT_CONTROL_UNAVAILABLE: ' + selector);
    }
    return { x, y };
  })()`);
  await page.mouse('mouseMoved', point.x, point.y);
  await page.mouse('mousePressed', point.x, point.y);
  await page.mouse('mouseReleased', point.x, point.y);
}

export async function selectPartsViewPage(page: InputCdpSession): Promise<void> {
  await clickPartsViewControl(page, '[data-pv-view="page"]');
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate<boolean>(`!!document.querySelector('.pv-box[data-region]')`)) return;
    await Bun.sleep(25);
  }
  throw new Error('PARTS_SHOT_PAGE_NOT_READY: atlas page has no rendered region boxes');
}

export async function preparePartsViewShot(page: InputCdpSession, target: PartsViewShotTarget): Promise<void> {
  if (target.zoom !== 2 && target.zoom !== 4) throw new Error('PARTS_SHOT_ZOOM_UNSUPPORTED: expected 2 or 4');
  // Page selection resets the camera, so it precedes the native reset and pinch.
  if (target.view === 'page') await selectPartsViewPage(page);
  if (target.mode === 'parts') await clickPartsViewControl(page, '#pv-footprints');
  await clickPartsViewControl(page, '#native-one');
  const native = await page.evaluate<PartsViewShotState>(partsViewShotStateExpression);
  assertPartsViewShotState(native, { ...target, zoom: 1 });
  const center = await page.evaluate<{ x: number; y: number }>(`(() => {
    const pane = document.getElementById('rig-viewport');
    const rect = pane.getBoundingClientRect();
    const x = Math.floor(rect.left + rect.width / 2), y = Math.floor(rect.top + rect.height / 2);
    if (rect.width < 160 || rect.height < 32 ||
        ![x - 64, x - 32, x + 64].every(px => pane.contains(document.elementFromPoint(px, y)))) {
      throw new Error('PARTS_SHOT_PINCH_UNAVAILABLE: rig viewport needs an unobscured gesture span');
    }
    return { x, y };
  })()`);
  // Move only one pointer. Integer distances 32 -> 64/128 yield exactly 2x/4x.
  const fixed = { x: center.x - 64, y: center.y, id: 1 };
  const moving = { x: center.x - 32, y: center.y, id: 2 };
  await page.touch('touchStart', [fixed, moving]);
  await page.touch('touchMove', [fixed, { ...moving, x: fixed.x + 32 * target.zoom }]);
  await page.touch('touchEnd', []);
}
