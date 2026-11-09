/** Closed parts evidence. No synthetic model, frame, slot or package identity. */
import { parsePartsComparison, type PartsComparison } from './parts-comparison.ts';
import type { MarkRegion } from './stage-comment.ts';

export const PARTS_COMMENT_SCHEMA = 'rig-review-parts-comment/1' as const;
export const PARTS_ISSUE_SCHEMA = 'rig-review-parts-comment/2' as const;

export interface PartsCrop {
  path: string;
  sha256: string;
  width: number;
  height: number;
}

export interface PartsComment {
  schema: typeof PARTS_COMMENT_SCHEMA;
  id: string;
  summary: string;
  part: string;
  imageHash: string;
  sourceHash: string;
  imageRegion: MarkRegion;
  rigRegion: MarkRegion;
  view: {
    camera: { zoom: number; center: { x: number; y: number }; viewport: { width: number; height: number } };
    cameraSync: boolean;
    referenceCamera: { zoom: number; center: { x: number; y: number }; viewport: { width: number; height: number } } | null;
    background: string;
    alpha: boolean;
    footprints: boolean;
    mesh: boolean;
    comparison?: PartsComparison;
  };
  crop: PartsCrop & { png: string };
  nativeCrop: PartsCrop | null;
}

export interface PartsIssue {
  schema: typeof PARTS_ISSUE_SCHEMA;
  id: string;
  summary: string;
  parts: { name: string; imageHash: string }[];
  sourceHash: string;
  rigRegion: MarkRegion;
  imageRegion: MarkRegion | null;
  view: PartsComment['view'] & { mode: 'item' | 'assembled' };
  crop: PartsCrop & { png?: string };
  nativeCrop: PartsCrop | null;
}

const fail = (code: string, why: string): never => {
  throw new Error(code + ': ' + why);
};

const obj = (v: unknown): Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, any>)
    : fail('PARTS_COMMENT_INVALID', 'object required');

const exact = (v: Record<string, any>, keys: string[]) => {
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) {
    fail('PARTS_COMMENT_INVALID', 'unknown or missing fields');
  }
};

const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;

const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

const token = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

function parseRegion(raw: unknown, integer = false): void {
  const r = obj(raw);
  exact(r, ['x', 'y', 'width', 'height']);
  if (!Object.values(r).every(finite)) {
    fail('PARTS_COMMENT_INVALID', 'finite region required');
  }
  if (integer && !Object.values(r).every(Number.isSafeInteger)) {
    fail('PARTS_COMMENT_FRACTIONAL', 'image coordinates must be integer pixels');
  }
  if (r.width <= 0 || r.height <= 0) {
    fail('PARTS_COMMENT_EMPTY', 'positive region required');
  }
}

function parseView(raw: unknown, withMode: boolean): Record<string, any> {
  const view = obj(raw);
  exact(view, [
    ...(withMode ? ['mode'] : []),
    'camera',
    'cameraSync',
    'referenceCamera',
    'background',
    'alpha',
    'footprints',
    'mesh',
    ...(Object.hasOwn(view, 'comparison') ? ['comparison'] : []),
  ]);
  if (withMode && view.mode !== 'item' && view.mode !== 'assembled') {
    fail('PARTS_COMMENT_INVALID', 'view mode');
  }
  if (Object.hasOwn(view, 'comparison')) {
    parsePartsComparison(view.comparison);
  }
  if (
    !['green', 'magenta', 'black', 'white', 'checker'].includes(view.background) ||
    ![view.alpha, view.footprints, view.mesh, view.cameraSync].every(n => typeof n === 'boolean')
  ) {
    fail('PARTS_COMMENT_INVALID', 'view state');
  }
  for (const rawCamera of [view.camera, ...(view.referenceCamera === null ? [] : [view.referenceCamera])]) {
    const c = obj(rawCamera);
    exact(c, ['zoom', 'center', 'viewport']);
    exact(obj(c.center), ['x', 'y']);
    exact(obj(c.viewport), ['width', 'height']);
    if (
      !finite(c.zoom) ||
      c.zoom <= 0 ||
      c.zoom > 16 ||
      !Object.values(c.center).every(finite) ||
      !Object.values(c.viewport).every(n => finite(n) && n > 0 && n <= 65536)
    ) {
      fail('PARTS_CAMERA_RANGE', 'native scale or camera extent');
    }
  }
  return view;
}

function parseCrop(crop: unknown, inline: boolean, requireInline = true): void {
  const p = obj(crop);
  const hasPng = inline && Object.hasOwn(p, 'png');
  if (inline && requireInline && !hasPng) {
    fail('PARTS_COMMENT_INVALID', 'unknown or missing fields');
  }
  exact(p, ['path', 'sha256', 'width', 'height', ...(hasPng ? ['png'] : [])]);
  if (
    !hash(p.sha256) ||
    p.path !== `comment-crops/${p.sha256}.png` ||
    ![p.width, p.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384) ||
    (hasPng && (typeof p.png !== 'string' || p.png.length > 200000 || p.width > 1024 || p.height > 1024))
  ) {
    fail('PARTS_COMMENT_CROP_INVALID', 'bounded content-addressed crop');
  }
}

export function parsePartsComment(raw: unknown, prepared = true): PartsComment {
  const v = obj(raw);
  exact(v, ['schema', 'id', 'summary', 'part', 'imageHash', 'sourceHash', 'imageRegion', 'rigRegion', 'view', 'crop', 'nativeCrop']);
  if (
    v.schema !== PARTS_COMMENT_SCHEMA ||
    typeof v.id !== 'string' ||
    !v.id ||
    v.id.length > 128 ||
    typeof v.summary !== 'string' ||
    !v.summary.trim() ||
    v.summary.length > 1000 ||
    typeof v.part !== 'string' ||
    !v.part ||
    v.part.length > 512 ||
    !hash(v.imageHash) ||
    !hash(v.sourceHash)
  ) {
    fail('PARTS_COMMENT_INVALID', 'schema, text or source binding');
  }
  parseRegion(v.imageRegion, true);
  parseRegion(v.rigRegion, false);
  parseView(v.view, false);
  parseCrop(v.crop, true);
  if (v.nativeCrop !== null || prepared) {
    parseCrop(v.nativeCrop, false);
  }
  return v as PartsComment;
}

export function parsePartsIssue(raw: unknown, prepared = true, allowLegacy = false, requireInlinePng = true): PartsIssue {
  const v = obj(raw);
  if (allowLegacy && v.schema === PARTS_COMMENT_SCHEMA) {
    const c = parsePartsComment(raw, prepared);
    return {
      schema: PARTS_ISSUE_SCHEMA,
      id: c.id,
      summary: c.summary,
      parts: [{ name: c.part, imageHash: c.imageHash }],
      sourceHash: c.sourceHash,
      rigRegion: c.rigRegion,
      imageRegion: c.imageRegion,
      view: { ...c.view, mode: 'item' },
      crop: c.crop,
      nativeCrop: c.nativeCrop,
    };
  }
  exact(v, ['schema', 'id', 'summary', 'parts', 'sourceHash', 'imageRegion', 'rigRegion', 'view', 'crop', 'nativeCrop']);
  if (
    v.schema !== PARTS_ISSUE_SCHEMA ||
    !token(v.id) ||
    typeof v.summary !== 'string' ||
    !v.summary.trim() ||
    v.summary.length > 1000 ||
    !hash(v.sourceHash) ||
    !Array.isArray(v.parts) ||
    v.parts.length < 1 ||
    v.parts.length > 1000
  ) {
    fail('PARTS_COMMENT_INVALID', 'schema, text or source binding');
  }
  const seen = new Set<string>();
  for (const entry of v.parts) {
    const p = obj(entry);
    exact(p, ['name', 'imageHash']);
    if (!token(p.name) || seen.has(p.name) || !hash(p.imageHash)) {
      fail('PARTS_COMMENT_INVALID', 'part binding');
    }
    seen.add(p.name);
  }
  const view = parseView(v.view, true);
  if (view.mode === 'item') {
    if (v.parts.length !== 1 || v.imageRegion === null) {
      fail('PARTS_COMMENT_INVALID', 'item view requires a single part and imageRegion');
    }
    parseRegion(v.imageRegion, true);
    parseRegion(v.rigRegion, false);
    if (v.nativeCrop !== null || prepared) {
      parseCrop(v.nativeCrop, false);
    }
  } else {
    if (v.imageRegion !== null) {
      fail('PARTS_COMMENT_INVALID', 'assembled view requires null imageRegion');
    }
    parseRegion(v.rigRegion, true);
    if (v.nativeCrop !== null) {
      fail('PARTS_COMMENT_CROP_INVALID', 'assembled view requires null nativeCrop');
    }
  }
  parseCrop(v.crop, true, requireInlinePng);
  return v as PartsIssue;
}

/** Drag edges snap outward to whole native pixels. OOB is refused by the binding check, never clipped. */
export function snapImageRegion(r: MarkRegion): MarkRegion {
  if (r.width <= 0 || r.height <= 0) {
    return { x: Math.floor(r.x), y: Math.floor(r.y), width: 0, height: 0 };
  }
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

export function assertPartsCommentBinding(
  c: PartsComment,
  item: { name: string; x: number; y: number; w: number; h: number },
  imageHash: string,
  sourceHash: string,
): void {
  if (c.part !== item.name) {
    fail('PARTS_COMMENT_PART_MISMATCH', 'comment belongs to another part');
  }
  if (c.imageHash !== imageHash || c.sourceHash !== sourceHash) {
    fail('PARTS_COMMENT_STALE_SOURCE', 'original image or package source hash differs');
  }
  const camera = c.view.camera;
  const fit = Math.max(0.001, Math.min((camera.viewport.width - 24) / item.w, (camera.viewport.height - 24) / item.h));
  if (camera.zoom < Math.min(fit, 1)) {
    fail('PARTS_CAMERA_RANGE', 'native zoom below fit/1 minimum');
  }
  const r = c.imageRegion;
  if (r.width * r.height > 16777216) {
    fail('PARTS_COMMENT_CROP_LIMIT', 'native crop exceeds 16 million pixels');
  }
  if (r.x < 0 || r.y < 0 || r.x + r.width > item.w || r.y + r.height > item.h) {
    fail('PARTS_COMMENT_OUT_OF_BOUNDS', 'region exceeds original image');
  }
  if (c.rigRegion.x !== item.x + r.x || c.rigRegion.y !== item.y + r.y || c.rigRegion.width !== r.width || c.rigRegion.height !== r.height) {
    fail('PARTS_COMMENT_RIG_REGION', 'rig region must be exact placement plus image region');
  }
}

export function assertPartsIssueBinding(
  c: PartsIssue,
  items: ReadonlyMap<string, { name: string; x: number; y: number; w: number; h: number; imageHash: string }>,
  sourceHash: string,
): void {
  if (c.sourceHash !== sourceHash) {
    fail('PARTS_COMMENT_STALE_SOURCE', 'original image or package source hash differs');
  }
  const matchedItems: { name: string; x: number; y: number; w: number; h: number; imageHash: string }[] = [];
  for (const p of c.parts) {
    const item = items.get(p.name);
    if (!item) {
      return fail('PARTS_COMMENT_PART_MISMATCH', 'comment belongs to another part');
    }
    if (p.imageHash !== item.imageHash) {
      return fail('PARTS_COMMENT_STALE_SOURCE', 'original image or package source hash differs');
    }
    matchedItems.push(item);
  }
  if (c.view.mode === 'item') {
    const item = matchedItems[0]!;
    assertPartsCommentBinding(
      {
        ...c,
        schema: PARTS_COMMENT_SCHEMA,
        part: item.name,
        imageHash: c.parts[0]!.imageHash,
        imageRegion: c.imageRegion!,
        crop: { ...c.crop, png: c.crop.png ?? '' },
      },
      item,
      item.imageHash,
      sourceHash,
    );
    return;
  }
  const r = c.rigRegion;
  if (![r.x, r.y, r.width, r.height].every(Number.isSafeInteger)) {
    fail('PARTS_COMMENT_FRACTIONAL', 'rig coordinates must be integer pixels');
  }
  const minX = Math.min(...matchedItems.map(i => i.x));
  const minY = Math.min(...matchedItems.map(i => i.y));
  const maxX = Math.max(...matchedItems.map(i => i.x + i.w));
  const maxY = Math.max(...matchedItems.map(i => i.y + i.h));
  if (r.x < minX || r.y < minY || r.x + r.width > maxX || r.y + r.height > maxY) {
    fail('PARTS_COMMENT_OUT_OF_BOUNDS', 'region exceeds union of issue parts');
  }
}
