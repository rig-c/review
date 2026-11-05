/** Generated two-part lattice fixture; the first mesh leaves one 16×16 art cell uncovered. */
import { createCanvas } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function writeMeshPackage(root: string): Promise<void> {
  await mkdir(join(root, 'parts'), { recursive: true });
  await mkdir(join(root, 'images'), { recursive: true });
  const parts = ['gap', 'covered'].map((name, index) => ({ name, x: index * 64, y: 0, w: 64, h: 64 }));
  await writeFile(join(root, 'parts.json'), JSON.stringify({ rig_size: [128, 64], parts }));
  const skin: Record<string, unknown> = {};
  for (const p of parts) {
    const canvas = createCanvas(64, 64), ctx = canvas.getContext('2d'); ctx.fillStyle = '#887744'; ctx.fillRect(0, 0, 64, 64);
    await writeFile(join(root, 'parts', p.name + '.png'), canvas.toBuffer('image/png'));
    await writeFile(join(root, 'images', p.name + '.png'), canvas.toBuffer('image/png'));
    const uvs: number[] = [], triangles: number[] = [];
    for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) uvs.push(x / 4, y / 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      if (p.name === 'gap' && x === 1 && y === 1) continue;
      const a = y * 5 + x; triangles.push(a, a + 1, a + 6, a, a + 6, a + 5);
    }
    skin[p.name] = { [p.name]: { type: 'mesh', image: `${p.name}.png`, width: 64, height: 64, uvs, triangles } };
  }
  await writeFile(join(root, 'rig.json'), JSON.stringify({ images: 'images', skins: { default: skin } }));
  await writeFile(join(root, 'mesh_report.json'), JSON.stringify(parts.map(p => ({ part: p.name, mode: 'lattice', vertices: 25, triangles: p.name === 'gap' ? 30 : 32, art_coverage: p.name === 'gap' ? .9375 : 1, stray_cleared: 0 }))));
}
