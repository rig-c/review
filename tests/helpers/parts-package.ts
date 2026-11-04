/**
 * A planted build root (#348), laid out as rig-parts writes one: assemble's `rig/parts.json` in draw order (back
 * first) beside `rig/parts/<name>.png`, rig's `rig/mesh_report.json` beside them, and check's `check/check.json`. All alpha is 0 or 255, so the bars count
 * exact pixels.
 *
 * - `back_defect` (red): a back part with a hole the exact shape of `front`'s footprint, the material never painted;
 * - `back_control` (blue): the same kind of back part, filled under `front` (the control);
 * - `front` (yellow): an ellipse drawn in front of both.
 * - `mesh_report.json` names one faint island on `back_defect`; `check.json` names `front` and `back_control`.
 */
import { createCanvas } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RIG = { w: 64, h: 64 };
export const BACK_DEFECT = { name: 'back_defect', x: 0, y: 8, w: 30, h: 32 };
export const BACK_CONTROL = { name: 'back_control', x: 30, y: 8, w: 30, h: 32 };
export const FRONT = { name: 'front', x: 14, y: 14, w: 26, h: 20 };
export const FAINT = { art: 12, maxAlpha: 15, box: [2, 2, 4, 3] as [number, number, number, number] };

/** Whether `front` holds rig pixel (x, y): an axis-aligned ellipse filling its box. */
export function frontHolds(x: number, y: number): boolean {
  const cx = FRONT.x + FRONT.w / 2, cy = FRONT.y + FRONT.h / 2, rx = FRONT.w / 2, ry = FRONT.h / 2;
  const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function png(box: { x: number; y: number; w: number; h: number }, rgb: [number, number, number], holds: (x: number, y: number) => boolean): Buffer {
  const canvas = createCanvas(box.w, box.h), ctx = canvas.getContext('2d'), data = ctx.createImageData(box.w, box.h);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    if (!holds(box.x + x, box.y + y)) continue;
    const i = (y * box.w + x) * 4;
    data.data[i] = rgb[0]; data.data[i + 1] = rgb[1]; data.data[i + 2] = rgb[2]; data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toBuffer('image/png');
}

export async function writePartsPackage(root: string): Promise<void> {
  const rig = join(root, 'rig');
  await mkdir(join(rig, 'parts'), { recursive: true });
  await mkdir(join(root, 'check'), { recursive: true });
  const parts = [BACK_DEFECT, BACK_CONTROL, FRONT];
  await writeFile(join(rig, 'parts.json'), JSON.stringify({ rig_size: [RIG.w, RIG.h], scale_rig_per_source: 1, parts: parts.map(p => ({ name: p.name, from: `full:${p.name}`, x: p.x, y: p.y, w: p.w, h: p.h })) }, null, 1) + '\n');
  await writeFile(join(rig, 'parts', 'back_defect.png'), png(BACK_DEFECT, [255, 0, 0], (x, y) => !frontHolds(x, y)));
  await writeFile(join(rig, 'parts', 'back_control.png'), png(BACK_CONTROL, [0, 0, 255], () => true));
  await writeFile(join(rig, 'parts', 'front.png'), png(FRONT, [255, 255, 0], frontHolds));
  await writeFile(join(rig, 'mesh_report.json'), JSON.stringify([
    { part: 'back_defect', vertices: 10, triangles: 8, mode: 'contour', contour: { bridges: { islands: [900, 12], units: [[900]], joins: [], faint: [FAINT] } } },
    { part: 'back_control', vertices: 10, triangles: 8, mode: 'contour', contour: {} },
  ]) + '\n');
  await writeFile(join(root, 'check', 'check.json'), JSON.stringify({ gate_spine_html_green: true, seam_pairs: [{ parts: ['front', 'back_control'], px_over_40: 3, px_over_80: 1, frame_box: [30, 14, 6, 4], rig_box: [30, 14, 6, 4] }] }) + '\n');
}
