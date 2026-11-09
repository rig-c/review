/** Native evidence is cut from the bound original PNG, never from a displayed alpha mask. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { parsePartsIssue, assertPartsIssueBinding, type PartsIssue } from './parts-comment.ts';
import { validatePngCrop, storePngCrop, readPngCrop, type PngCrop } from './comment-crops.ts';
import { assertPartsUnchanged, partsDifference, verdictSource, type PartsViewPackage } from './parts-view.ts';

export interface PartsCommentBindingOptions {
  readonly sourceHash?: string;
}

export async function preparePartsComment(
  pkg: PartsViewPackage,
  raw: unknown,
  requireNative = false,
  options?: PartsCommentBindingOptions,
): Promise<PartsIssue> {
  return resolvePartsComment(pkg, raw, requireNative, true, false, options);
}

export async function validateStoredPartsComment(
  pkg: PartsViewPackage,
  raw: unknown,
  allowLegacy = false,
  options?: PartsCommentBindingOptions,
): Promise<PartsIssue> {
  return resolvePartsComment(pkg, raw, true, false, allowLegacy, options);
}

async function resolvePartsComment(
  pkg: PartsViewPackage,
  raw: unknown,
  requireNative: boolean,
  persist: boolean,
  allowLegacy = false,
  options?: PartsCommentBindingOptions,
): Promise<PartsIssue> {
  const c = parsePartsIssue(raw, requireNative, allowLegacy, persist && !requireNative);
  if (pkg.mode !== 'parts') {
    throw new Error('PARTS_COMMENT_UNAVAILABLE: original part image required');
  }
  const itemMap = new Map<
    string,
    { name: string; index: number; x: number; y: number; w: number; h: number; imageHash: string; path: string }
  >();
  for (const item of pkg.items) {
    const path = pkg.imagePaths[item.index];
    const file = path ? pkg.files.find(f => f.abs === path) : undefined;
    if (!path || !file) {
      throw new Error('PARTS_COMMENT_UNAVAILABLE: bound original PNG required');
    }
    itemMap.set(item.name, { ...item, imageHash: file.sha256, path });
  }
  const expectedSourceHash = options?.sourceHash ?? verdictSource(pkg).sha256;
  assertPartsIssueBinding(c, itemMap, expectedSourceHash);
  if (c.view.comparison?.mode === 'overlay' && !pkg.painting) {
    throw new Error('PARTS_COMPARISON_UNAVAILABLE: original painting required');
  }
  if (c.view.comparison?.mode === 'difference') {
    for (const part of c.parts) {
      const item = itemMap.get(part.name)!;
      await partsDifference(pkg, item.index, c.view.comparison.threshold, c.view.footprints);
    }
  }
  const partBuffers = new Map<string, Buffer>();
  for (const part of c.parts) {
    const item = itemMap.get(part.name)!;
    const bytes = await readFile(item.path);
    if (createHash('sha256').update(bytes).digest('hex') !== item.imageHash) {
      throw new Error('PARTS_COMMENT_STALE_SOURCE: original PNG changed');
    }
    partBuffers.set(part.name, bytes);
  }
  await assertPartsUnchanged(pkg);
  if (c.crop.png !== undefined) {
    validatePngCrop(c.crop as PngCrop);
  }
  if (c.view.mode !== 'item') {
    if (persist && c.crop.png !== undefined) {
      await storePngCrop(c.crop as PngCrop);
    } else {
      await readPngCrop(c.crop);
    }
    await assertPartsUnchanged(pkg);
    return { ...c, nativeCrop: null };
  }
  const primary = itemMap.get(c.parts[0]!.name)!;
  const r = c.imageRegion!;
  if (r.width * r.height > 16777216) {
    throw new Error('PARTS_COMMENT_CROP_LIMIT: native crop exceeds 16 million pixels');
  }
  const bytes = partBuffers.get(primary.name)!;
  const original = PNG.sync.read(bytes);
  if (original.width !== primary.w || original.height !== primary.h) {
    throw new Error('PARTS_COMMENT_IMAGE_SIZE: original dimensions differ from placement');
  }
  const native = new PNG({ width: r.width, height: r.height });
  for (let y = 0; y < r.height; y++) {
    original.data.copy(
      native.data,
      y * r.width * 4,
      ((r.y + y) * original.width + r.x) * 4,
      ((r.y + y) * original.width + r.x + r.width) * 4,
    );
  }
  if (requireNative) {
    const stored = await readPngCrop(c.nativeCrop!);
    const decoded = PNG.sync.read(stored);
    if (decoded.width !== r.width || decoded.height !== r.height || !decoded.data.equals(native.data)) {
      throw new Error('PARTS_COMMENT_NATIVE_CROP_TAMPERED: native crop differs from bound original');
    }
    if (persist && c.crop.png !== undefined) {
      await storePngCrop(c.crop as PngCrop);
    } else {
      await readPngCrop(c.crop);
    }
    await assertPartsUnchanged(pkg);
    return c;
  }
  const png = PNG.sync.write(native);
  const sha256 = createHash('sha256').update(png).digest('hex');
  const nativeCrop = { path: `comment-crops/${sha256}.png`, sha256, width: r.width, height: r.height };
  await storePngCrop(c.crop as PngCrop);
  await storePngCrop({ ...nativeCrop, png: 'data:image/png;base64,' + png.toString('base64') });
  await assertPartsUnchanged(pkg);
  return { ...c, nativeCrop };
}
