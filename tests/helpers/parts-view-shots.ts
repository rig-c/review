import { sourceSha256 } from '../../src/parts-view.ts';
import type { InputCdpSession } from '../parts-explorer-browser.ts';

export interface PartsViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PartsViewRegionSource {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PartsViewRegionFrame {
  name: string;
  source: { x: number; y: number; w: number; h: number };
  boxRect: PartsViewRect;
  outlineWidth: number;
  outlineOffset: number;
  scaledOutlineX: number;
  scaledOutlineY: number;
  outlinedBoxRect: PartsViewRect;
  labelText: string;
  labelRect: PartsViewRect;
}

export interface PartsViewSourceBinding {
  sourceHash: string;
  beforeSourceHash?: string;
  afterSourceHash?: string;
  files?: { path: string; bytes: number; sha256: string }[];
  page?: { name: string; width: number; height: number };
  regions?: PartsViewRegionSource[];
}

export interface PartsViewAtlasFrame {
  viewportRect: PartsViewRect;
  documentViewportRect: PartsViewRect;
  clippingAncestors: { id: string; tag: string; className: string; rect: PartsViewRect }[];
  visibleViewportRect: PartsViewRect;
  headingRect: PartsViewRect;
  usablePaneRect: PartsViewRect;
  canvasRect: PartsViewRect;
  rigRoot: {
    left: number;
    top: number;
    rect: PartsViewRect;
    matrix: { a: number; b: number; c: number; d: number; e: number; f: number };
  };
  camera: {
    center: { x: number; y: number };
    visible: { x: number; y: number; width: number; height: number };
  };
  regions: PartsViewRegionFrame[];
  envelope: PartsViewRect;
  source?: PartsViewSourceBinding;
}

export interface PartsViewShotTarget {
  mode: 'parts' | 'atlas';
  view: 'item' | 'page';
  zoom: number;
  language: 'en' | 'ko';
  source?: PartsViewSourceBinding;
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
  atlasFrame?: PartsViewAtlasFrame;
}

export const partsViewShotStateExpression = `(() => {
  const required = id => {
    const node = document.getElementById(id);
    if (!node) throw new Error('PARTS_SHOT_CONTROL_MISSING: #' + id);
    return node;
  };
  const toRect = r => {
    const left = Number(r?.left);
    const top = Number(r?.top);
    const width = Number(r?.width);
    const height = Number(r?.height);
    const right = Number.isFinite(Number(r?.right)) ? Number(r.right) : left + width;
    const bottom = Number.isFinite(Number(r?.bottom)) ? Number(r.bottom) : top + height;
    return { left, top, right, bottom, width, height };
  };
  const clientRect = node => {
    const r = toRect(node.getBoundingClientRect());
    const left = r.left + (typeof node.clientLeft === 'number' ? node.clientLeft : 0);
    const top = r.top + (typeof node.clientTop === 'number' ? node.clientTop : 0);
    const width = typeof node.clientWidth === 'number' ? node.clientWidth : r.width;
    const height = typeof node.clientHeight === 'number' ? node.clientHeight : r.height;
    return { left, top, right: left + width, bottom: top + height, width, height };
  };
  const intersectRect = (a, b) => {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const unionRects = list => {
    const left = Math.min(...list.map(r => r.left));
    const top = Math.min(...list.map(r => r.top));
    const right = Math.max(...list.map(r => r.right));
    const bottom = Math.max(...list.map(r => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const canvas = required('pv-canvas');
  const canvasRect = toRect(canvas.getBoundingClientRect());
  const rigRootNode = required('rig-root');
  const rigViewportNode = required('rig-viewport');
  const matrix = new DOMMatrix(getComputedStyle(rigRootNode).transform);
  const matrixRecord = {
    a: matrix.a,
    b: typeof matrix.b === 'number' ? matrix.b : 0,
    c: typeof matrix.c === 'number' ? matrix.c : 0,
    d: matrix.d,
    e: typeof matrix.e === 'number' ? matrix.e : 0,
    f: typeof matrix.f === 'number' ? matrix.f : 0,
  };
  const viewportRect = clientRect(rigViewportNode);
  const docEl = document.documentElement;
  const docWidth = typeof docEl.clientWidth === 'number' ? docEl.clientWidth : viewportRect.right;
  const docHeight = typeof docEl.clientHeight === 'number' ? docEl.clientHeight : viewportRect.bottom;
  const documentViewportRect = { left: 0, top: 0, right: docWidth, bottom: docHeight, width: docWidth, height: docHeight };
  const clippingAncestors = [];
  for (let cur = rigViewportNode.parentElement; cur && cur !== document.body && cur !== docEl; cur = cur.parentElement) {
    const style = getComputedStyle(cur);
    const ox = style.overflowX || style.overflow || 'visible';
    const oy = style.overflowY || style.overflow || 'visible';
    if (ox !== 'visible' || oy !== 'visible' || cur.id === 'rig-pane' || cur.id === 'stage-layout') {
      clippingAncestors.push({
        id: cur.id || '',
        tag: (cur.tagName || '').toLowerCase(),
        className: typeof cur.className === 'string' ? cur.className : '',
        rect: clientRect(cur),
      });
    }
  }
  let visibleViewportRect = intersectRect(viewportRect, documentViewportRect);
  for (const ancestor of clippingAncestors) {
    visibleViewportRect = intersectRect(visibleViewportRect, ancestor.rect);
  }
  const headingNode = required('rig-label');
  const headingRect = toRect(headingNode.getBoundingClientRect());
  const usableTop = Number.isFinite(headingRect.bottom) ? Math.max(visibleViewportRect.top, headingRect.bottom) : visibleViewportRect.top;
  const usablePaneRect = {
    left: visibleViewportRect.left,
    top: usableTop,
    right: visibleViewportRect.right,
    bottom: visibleViewportRect.bottom,
    width: Math.max(0, visibleViewportRect.right - visibleViewportRect.left),
    height: Math.max(0, visibleViewportRect.bottom - usableTop),
  };
  const rigRootRect = toRect(rigRootNode.getBoundingClientRect ? rigRootNode.getBoundingClientRect() : canvasRect);
  const styleLeft = parseFloat(rigRootNode.style?.left ?? '');
  const styleTop = parseFloat(rigRootNode.style?.top ?? '');
  const rootLeft = (Number.isFinite(styleLeft) ? styleLeft : rigRootRect.left - viewportRect.left) + matrixRecord.e;
  const rootTop = (Number.isFinite(styleTop) ? styleTop : rigRootRect.top - viewportRect.top) + matrixRecord.f;
  const centerX = (viewportRect.width / 2 - rootLeft) / matrixRecord.a;
  const centerY = (viewportRect.height / 2 - rootTop) / matrixRecord.d;
  const visibleWidth = viewportRect.width / matrixRecord.a;
  const visibleHeight = viewportRect.height / matrixRecord.d;
  const regionNodes = Array.from(document.querySelectorAll ? document.querySelectorAll('.pv-box[data-region]') : []);
  const regions = regionNodes.map(box => {
    const boxRect = toRect(box.getBoundingClientRect());
    const boxStyle = getComputedStyle(box);
    const outlineStyle = boxStyle.outlineStyle ?? 'solid';
    const outlineWidth = outlineStyle === 'none' ? 0 : parseFloat(boxStyle.outlineWidth ?? '1');
    const outlineOffset = outlineStyle === 'none' ? 0 : parseFloat(boxStyle.outlineOffset ?? '0');
    const scaledOutlineX = outlineStyle === 'none' ? 0 : Math.max(0, outlineWidth + outlineOffset) * matrixRecord.a;
    const scaledOutlineY = outlineStyle === 'none' ? 0 : Math.max(0, outlineWidth + outlineOffset) * matrixRecord.d;
    const outlinedBoxRect = {
      left: boxRect.left - scaledOutlineX,
      top: boxRect.top - scaledOutlineY,
      right: boxRect.right + scaledOutlineX,
      bottom: boxRect.bottom + scaledOutlineY,
      width: boxRect.width + 2 * scaledOutlineX,
      height: boxRect.height + 2 * scaledOutlineY,
    };
    const labelNode = box.querySelector ? box.querySelector('span') : null;
    const labelRect = labelNode
      ? toRect(labelNode.getBoundingClientRect())
      : { left: NaN, top: NaN, right: NaN, bottom: NaN, width: 0, height: 0 };
    return {
      name: String(box.dataset?.region ?? ''),
      source: {
        x: Number(box.dataset?.x),
        y: Number(box.dataset?.y),
        w: Number(box.dataset?.w),
        h: Number(box.dataset?.h),
      },
      boxRect,
      outlineWidth,
      outlineOffset,
      scaledOutlineX,
      scaledOutlineY,
      outlinedBoxRect,
      labelText: labelNode ? String(labelNode.textContent ?? '') : '',
      labelRect,
    };
  });
  const envelope = unionRects([canvasRect, ...regions.flatMap(r => [r.outlinedBoxRect, r.labelRect])]);
  const selected = document.querySelector('[data-pv-view][aria-pressed="true"]');
  return {
    mode: required('pv-atlas-switch').hidden ? 'parts' : 'atlas',
    view: required('pv-assemble').getAttribute('aria-pressed') === 'true'
      ? 'assembled' : selected?.dataset.pvView ?? null,
    language: document.documentElement.lang,
    zoomX: matrix.a,
    zoomY: matrix.d,
    canvasZoomX: canvasRect.width / canvas.width,
    canvasZoomY: canvasRect.height / canvas.height,
    zoomLabel: required('zoom-value').textContent,
    nativeOne: required('native-one').getAttribute('aria-pressed') === 'true',
    footprints: required('pv-footprints').checked,
    canvas: { width: canvas.width, height: canvas.height },
    atlasFrame: {
      viewportRect,
      documentViewportRect,
      clippingAncestors,
      visibleViewportRect,
      headingRect,
      usablePaneRect,
      canvasRect,
      rigRoot: {
        left: rootLeft,
        top: rootTop,
        rect: rigRootRect,
        matrix: matrixRecord,
      },
      camera: {
        center: { x: centerX, y: centerY },
        visible: {
          x: centerX - visibleWidth / 2,
          y: centerY - visibleHeight / 2,
          width: visibleWidth,
          height: visibleHeight,
        },
      },
      regions,
      envelope,
    },
  };
})()`;

const SHA256_RE = /^[a-f0-9]{64}$/;

function validRect(rect: PartsViewRect | undefined | null): rect is PartsViewRect {
  return !!rect &&
    [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    Math.abs((rect.right - rect.left) - rect.width) <= 1e-6 &&
    Math.abs((rect.bottom - rect.top) - rect.height) <= 1e-6;
}

function unionRects(rects: readonly PartsViewRect[]): PartsViewRect {
  const left = Math.min(...rects.map(r => r.left));
  const top = Math.min(...rects.map(r => r.top));
  const right = Math.max(...rects.map(r => r.right));
  const bottom = Math.max(...rects.map(r => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function sameRect(a: PartsViewRect, b: PartsViewRect): boolean {
  return [
    a.left - b.left,
    a.top - b.top,
    a.right - b.right,
    a.bottom - b.bottom,
    a.width - b.width,
    a.height - b.height,
  ].every(diff => Math.abs(diff) <= 1e-6);
}

function rectsOverlap(a: PartsViewRect, b: PartsViewRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function assertPartsViewSourceBinding(
  source: PartsViewSourceBinding,
  actual: PartsViewShotState,
  target: PartsViewShotTarget,
): void {
  if (typeof source.sourceHash !== 'string' || !SHA256_RE.test(source.sourceHash)) {
    throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: invalid sourceHash in ${JSON.stringify(actual)}`);
  }
  if (source.beforeSourceHash !== undefined && source.beforeSourceHash !== source.sourceHash) {
    throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: beforeSourceHash ${source.beforeSourceHash} !== ${source.sourceHash} in ${JSON.stringify(actual)}`);
  }
  if (source.afterSourceHash !== undefined && source.afterSourceHash !== source.sourceHash) {
    throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: afterSourceHash ${source.afterSourceHash} !== ${source.sourceHash} in ${JSON.stringify(actual)}`);
  }
  if (source.files !== undefined) {
    if (!Array.isArray(source.files) || source.files.length === 0 ||
        source.files.some(f => !f || typeof f.path !== 'string' || !f.path || !SHA256_RE.test(f.sha256) || !Number.isFinite(f.bytes) || f.bytes <= 0) ||
        sourceSha256(source.files) !== source.sourceHash) {
      throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: file hashes do not match sourceHash in ${JSON.stringify(actual)}`);
    }
  }
  if (target.mode === 'atlas' && target.view === 'page') {
    if (source.page !== undefined) {
      if (!source.page.name || source.page.width !== actual.canvas.width || source.page.height !== actual.canvas.height) {
        throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: canvas ${JSON.stringify(actual.canvas)} does not match source page ${JSON.stringify(source.page)} in ${JSON.stringify(actual)}`);
      }
    }
    if (source.regions !== undefined) {
      const measured = actual.atlasFrame?.regions ?? [];
      if (!Array.isArray(source.regions) || source.regions.length === 0 || source.regions.length !== measured.length) {
        throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: expected ${source.regions?.length ?? 0} source regions, measured ${measured.length} in ${JSON.stringify(actual)}`);
      }
      for (let i = 0; i < source.regions.length; i++) {
        const expected = source.regions[i]!;
        const region = measured[i]!;
        if (!region || expected.name !== region.name ||
            expected.x !== region.source.x || expected.y !== region.source.y ||
            expected.w !== region.source.w || expected.h !== region.source.h) {
          throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: region[${i}] expected ${JSON.stringify(expected)}, measured ${JSON.stringify(region)} in ${JSON.stringify(actual)}`);
        }
      }
    }
  }
}

function assertPartsViewAtlasGeometry(actual: PartsViewShotState, target: PartsViewShotTarget): PartsViewAtlasFrame {
  const frame = actual.atlasFrame;
  if (!frame || !Number.isFinite(actual.canvas?.width) || !Number.isFinite(actual.canvas?.height) ||
      actual.canvas.width <= 0 || actual.canvas.height <= 0) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: missing atlas frame or nonpositive canvas in ${JSON.stringify(actual)}`);
  }
  const m = frame.rigRoot?.matrix;
  if (!m || ![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite) ||
      m.b !== 0 || m.c !== 0 || m.a <= 0 || m.d <= 0 || m.a !== m.d ||
      m.a !== actual.zoomX || m.d !== actual.zoomY ||
      actual.canvasZoomX !== m.a || actual.canvasZoomY !== m.d) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: non-axis-aligned or inconsistent transform in ${JSON.stringify(actual)}`);
  }
  if (![frame.rigRoot.left, frame.rigRoot.top, frame.camera?.center?.x, frame.camera?.center?.y,
        frame.camera?.visible?.x, frame.camera?.visible?.y, frame.camera?.visible?.width, frame.camera?.visible?.height].every(Number.isFinite) ||
      frame.camera.visible.width <= 0 || frame.camera.visible.height <= 0) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: invalid root placement or camera geometry in ${JSON.stringify(actual)}`);
  }
  if (!validRect(frame.viewportRect) || !validRect(frame.documentViewportRect) ||
      !validRect(frame.visibleViewportRect) || !validRect(frame.headingRect) ||
      !validRect(frame.usablePaneRect) || !validRect(frame.canvasRect) ||
      !validRect(frame.rigRoot.rect) || !validRect(frame.envelope) ||
      !Array.isArray(frame.clippingAncestors) || frame.clippingAncestors.some(a => !a || !validRect(a.rect))) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: missing, zero or nonfinite frame rectangle in ${JSON.stringify(actual)}`);
  }
  if (Math.abs(frame.canvasRect.width - actual.canvas.width * actual.zoomX) > 1e-6 ||
      Math.abs(frame.canvasRect.height - actual.canvas.height * actual.zoomY) > 1e-6) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: canvasRect does not match scaled canvas dimensions in ${JSON.stringify(actual)}`);
  }
  if (!Array.isArray(frame.regions) || frame.regions.length === 0) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: atlas page has no measured regions in ${JSON.stringify(actual)}`);
  }
  for (const region of frame.regions) {
    if (!region || typeof region.name !== 'string' || region.name.trim().length === 0 ||
        !region.source || ![region.source.x, region.source.y, region.source.w, region.source.h].every(Number.isFinite) ||
        region.source.x < 0 || region.source.y < 0 || region.source.w <= 0 || region.source.h <= 0 ||
        !validRect(region.boxRect) || !validRect(region.outlinedBoxRect) || !validRect(region.labelRect) ||
        ![region.outlineWidth, region.outlineOffset, region.scaledOutlineX, region.scaledOutlineY].every(Number.isFinite) ||
        region.outlineWidth < 0 || region.scaledOutlineX < 0 || region.scaledOutlineY < 0) {
      throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: invalid region geometry ${JSON.stringify(region)} in ${JSON.stringify(actual)}`);
    }
    const expectedOutlineX = Math.max(0, region.outlineWidth + region.outlineOffset) * actual.zoomX;
    const expectedOutlineY = Math.max(0, region.outlineWidth + region.outlineOffset) * actual.zoomY;
    const expectedOutlined: PartsViewRect = {
      left: region.boxRect.left - expectedOutlineX,
      top: region.boxRect.top - expectedOutlineY,
      right: region.boxRect.right + expectedOutlineX,
      bottom: region.boxRect.bottom + expectedOutlineY,
      width: region.boxRect.width + 2 * expectedOutlineX,
      height: region.boxRect.height + 2 * expectedOutlineY,
    };
    if (Math.abs(region.scaledOutlineX - expectedOutlineX) > 1e-6 ||
        Math.abs(region.scaledOutlineY - expectedOutlineY) > 1e-6 ||
        !sameRect(region.outlinedBoxRect, expectedOutlined)) {
      throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: inconsistent region outline extent ${JSON.stringify(region)} in ${JSON.stringify(actual)}`);
    }
    if (typeof region.labelText !== 'string' || region.labelText !== region.name) {
      throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: region label ${JSON.stringify(region.labelText)} does not match region ${JSON.stringify(region.name)} in ${JSON.stringify(actual)}`);
    }
    if (region.source.x + region.source.w > actual.canvas.width ||
        region.source.y + region.source.h > actual.canvas.height) {
      throw new Error(`PARTS_SHOT_SOURCE_MISMATCH: region ${region.name} source box ${JSON.stringify(region.source)} exceeds canvas ${JSON.stringify(actual.canvas)} in ${JSON.stringify(actual)}`);
    }
  }
  const source = target.source ?? frame.source;
  if (source) assertPartsViewSourceBinding(source, actual, target);

  const envelope = unionRects([
    frame.canvasRect,
    ...frame.regions.flatMap(r => [r.outlinedBoxRect, r.labelRect]),
  ]);
  if (!sameRect(envelope, frame.envelope)) {
    throw new Error(`PARTS_SHOT_GEOMETRY_INVALID: envelope ${JSON.stringify(frame.envelope)} does not equal union ${JSON.stringify(envelope)} in ${JSON.stringify(actual)}`);
  }
  if (envelope.width > frame.usablePaneRect.width || envelope.height > frame.usablePaneRect.height) {
    throw new Error(`PARTS_SHOT_FRAME_OVERSIZED: decorated envelope ${JSON.stringify(envelope)} exceeds usable pane ${JSON.stringify(frame.usablePaneRect)} in ${JSON.stringify(actual)}`);
  }
  return frame;
}

export function assertPartsViewAtlasFrame(actual: PartsViewShotState, target: PartsViewShotTarget): void {
  const frame = assertPartsViewAtlasGeometry(actual, target);
  const envelope = frame.envelope;
  const clippedToUsable =
    envelope.left < frame.usablePaneRect.left ||
    envelope.top < frame.usablePaneRect.top ||
    envelope.right > frame.usablePaneRect.right ||
    envelope.bottom > frame.usablePaneRect.bottom;
  const clippedToVisible =
    envelope.left < frame.visibleViewportRect.left ||
    envelope.top < frame.visibleViewportRect.top ||
    envelope.right > frame.visibleViewportRect.right ||
    envelope.bottom > frame.visibleViewportRect.bottom;
  const overlapsHeading = rectsOverlap(envelope, frame.headingRect);
  if (clippedToUsable || clippedToVisible || overlapsHeading) {
    throw new Error(`PARTS_SHOT_FRAME_CLIPPED: decorated envelope ${JSON.stringify(envelope)} is clipped by usable pane ${JSON.stringify(frame.usablePaneRect)} (visible ${JSON.stringify(frame.visibleViewportRect)}, heading ${JSON.stringify(frame.headingRect)}) in ${JSON.stringify(actual)}`);
  }
}

function assertPartsViewShotControls(actual: PartsViewShotState, target: PartsViewShotTarget): void {
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
  const source = target.source ?? actual.atlasFrame?.source;
  if (source) assertPartsViewSourceBinding(source, actual, target);
}

export function assertPartsViewShotState(actual: PartsViewShotState, target: PartsViewShotTarget): void {
  assertPartsViewShotControls(actual, target);
  if (target.mode === 'atlas' && target.view === 'page' && target.zoom === 4) {
    assertPartsViewAtlasFrame(actual, target);
  }
}

async function readPartsViewShot(
  page: InputCdpSession,
  target: PartsViewShotTarget,
  onMeasured?: (actual: PartsViewShotState) => void | Promise<void>,
): Promise<PartsViewShotState> {
  const raw = await page.evaluate<PartsViewShotState>(partsViewShotStateExpression);
  const actual: PartsViewShotState = target.source && raw.atlasFrame
    ? { ...raw, atlasFrame: { ...raw.atlasFrame, source: target.source } }
    : raw;
  await onMeasured?.(actual);
  return actual;
}

export async function measurePartsViewShot(
  page: InputCdpSession,
  target: PartsViewShotTarget,
  onMeasured?: (actual: PartsViewShotState) => void | Promise<void>,
): Promise<PartsViewShotState> {
  const actual = await readPartsViewShot(page, target, onMeasured);
  assertPartsViewShotState(actual, target);
  return actual;
}

export async function centerPartsViewShot(
  page: InputCdpSession,
  target: PartsViewShotTarget,
  onMeasured?: (actual: PartsViewShotState, stage: 'before-pan' | 'after-pan') => void | Promise<void>,
) {
  if (target.mode !== 'atlas' || target.view !== 'page' || target.zoom !== 4) {
    throw new Error('PARTS_SHOT_PAN_UNSUPPORTED: expected atlas Pages at exact 4x');
  }
  const before = await readPartsViewShot(page, target);
  await onMeasured?.(before, 'before-pan');
  assertPartsViewShotControls(before, target);
  const frame = assertPartsViewAtlasGeometry(before, target);
  const pane = frame.usablePaneRect;
  const envelope = frame.envelope;
  const dx = pane.left + pane.width / 2 - envelope.left - envelope.width / 2;
  const dy = pane.top + pane.height / 2 - envelope.top - envelope.height / 2;
  const gesture = await page.evaluate<{ start: { x: number; y: number }; end: { x: number; y: number } }>(`(() => {
    const pane = document.getElementById('rig-viewport');
    const bounds = ${JSON.stringify(pane)};
    const dx = ${JSON.stringify(dx)}, dy = ${JSON.stringify(dy)};
    // Leave room for hit testing on both ends of the single held-pointer drag.
    const left = Math.max(bounds.left + 8, bounds.left + 8 - dx);
    const right = Math.min(bounds.right - 8, bounds.right - 8 - dx);
    const top = Math.max(bounds.top + 8, bounds.top + 8 - dy);
    const bottom = Math.min(bounds.bottom - 8, bounds.bottom - 8 - dy);
    if (left <= right && top <= bottom) {
      for (const fy of [0, 0.5, 1]) for (const fx of [0, 0.5, 1]) {
        const start = { x: left + (right - left) * fx, y: top + (bottom - top) * fy };
        const end = { x: start.x + dx, y: start.y + dy };
        if (document.elementFromPoint(start.x, start.y) === pane &&
            document.elementFromPoint(end.x, end.y) === pane) return { start, end };
      }
    }
    throw new Error('PARTS_SHOT_PAN_UNAVAILABLE: no clear hit-tested span inside usable pane');
  })()`);
  await page.mouse('mouseMoved', gesture.start.x, gesture.start.y);
  try {
    await page.mouse('mousePressed', gesture.start.x, gesture.start.y);
    await page.mouse('mouseMoved', gesture.end.x, gesture.end.y);
  } finally {
    await page.mouse('mouseReleased', gesture.end.x, gesture.end.y);
  }
  let previous = await readPartsViewShot(page, target);
  for (let attempt = 0; attempt < 20; attempt++) {
    await Bun.sleep(25);
    const after = await readPartsViewShot(page, target);
    if (previous.atlasFrame && after.atlasFrame &&
        sameRect(previous.atlasFrame.envelope, after.atlasFrame.envelope)) {
      await onMeasured?.(after, 'after-pan');
      assertPartsViewShotState(after, target);
      return { before, after, ...gesture, translation: { x: dx, y: dy } };
    }
    previous = after;
  }
  await onMeasured?.(previous, 'after-pan');
  throw new Error(`PARTS_SHOT_PAN_NOT_SETTLED: geometry did not settle after 20 observations in ${JSON.stringify(previous)}`);
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
