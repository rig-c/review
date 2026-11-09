import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { parsePartsIssue, assertPartsIssueBinding, type PartsIssue } from './parts-comment.ts';
import { readPngCrop, storePngCrop, type PngCrop } from './comment-crops.ts';
import { verdictSource, type PartsViewPackage } from './parts-view.ts';

function fail(code: string, why: string): never {
  throw new Error(code + ': ' + why);
}

async function resolvePartsComment(pkg: PartsViewPackage, raw: unknown, requirePng: boolean, allowLegacy = false) {
  if (pkg.mode !== 'parts') {
    fail('PARTS_COMMENT_UNAVAILABLE', 'parts comments require pre-rig parts mode');
  }
  const c = parsePartsIssue(raw, false, allowLegacy, requirePng);
  if (c.view.comparison?.mode === 'overlay' && !pkg.painting) {
    fail('PARTS_COMPARISON_UNAVAILABLE', 'original painting required');
  }
  if (c.view.comparison?.mode === 'difference' && !pkg.paintingInRig) {
    fail('PARTS_DIFFERENCE_UNAVAILABLE', 'declared painting_in_rig required');
  }
  const itemMap = new Map<string, { name: string; x: number; y: number; w: number; h: number; imageHash: string }>();
  for (const item of pkg.items) {
    const abs = pkg.imagePaths[item.index]!;
    const bytes = await readFile(abs);
    itemMap.set(item.name, {
      ...item,
      imageHash: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  assertPartsIssueBinding(c, itemMap, verdictSource(pkg).sha256);
  if (c.view.mode !== 'item') {
    return { c, native: null, nativeSha: null, r: null };
  }
  const primary = c.parts[0]!;
  const item = pkg.items.find(i => i.name === primary.name)!;
  const src = PNG.sync.read(await readFile(pkg.imagePaths[item.index]!));
  if (src.width !== item.w || src.height !== item.h) {
    fail('PARTS_COMMENT_STALE_SOURCE', 'part image dimensions changed');
  }
  const r = c.imageRegion!;
  const dst = new PNG({ width: r.width, height: r.height });
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const si = ((r.y + y) * src.width + r.x + x) * 4;
      const di = (y * r.width + x) * 4;
      src.data.copy(dst.data, di, si, si + 4);
    }
  }
  const native = PNG.sync.write(dst);
  const nativeSha = createHash('sha256').update(native).digest('hex');
  return { c, native, nativeSha, r };
}

export async function preparePartsComment(
  pkg: PartsViewPackage,
  raw: unknown,
  requireSaved = false,
): Promise<PartsIssue> {
  const { c, native, nativeSha, r } = await resolvePartsComment(pkg, raw, !requireSaved, false);
  if (c.crop.png) {
    await storePngCrop(c.crop as PngCrop);
  } else {
    await readPngCrop(c.crop);
  }
  if (c.view.mode !== 'item') {
    return { ...c, nativeCrop: null };
  }
  const nativeCrop = c.nativeCrop ?? {
    path: `comment-crops/${nativeSha!}.png`,
    sha256: nativeSha!,
    width: r!.width,
    height: r!.height,
  };
  if (!c.nativeCrop) {
    await storePngCrop({
      ...nativeCrop,
      png: 'data:image/png;base64,' + native!.toString('base64'),
    });
  }
  const storedNative = await readPngCrop(nativeCrop);
  if (
    nativeCrop.width !== r!.width ||
    nativeCrop.height !== r!.height ||
    !PNG.sync.read(storedNative).data.equals(PNG.sync.read(native!).data)
  ) {
    fail('PARTS_COMMENT_NATIVE_CROP_TAMPERED', 'native crop RGBA differs from original subrectangle');
  }
  return { ...c, nativeCrop };
}

export async function validateStoredPartsComment(
  pkg: PartsViewPackage,
  raw: unknown,
  allowLegacy = false,
): Promise<PartsIssue> {
  const { c, native, r } = await resolvePartsComment(pkg, raw, false, allowLegacy);
  await readPngCrop(c.crop);
  if (c.view.mode !== 'item') {
    return c;
  }
  const storedNative = await readPngCrop(c.nativeCrop!);
  if (
    c.nativeCrop!.width !== r!.width ||
    c.nativeCrop!.height !== r!.height ||
    !PNG.sync.read(storedNative).data.equals(PNG.sync.read(native!).data)
  ) {
    fail('PARTS_COMMENT_NATIVE_CROP_TAMPERED', 'stored native crop RGBA differs from original subrectangle');
  }
  return c;
}
