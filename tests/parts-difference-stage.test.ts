import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview } from '../src/manifest.ts';
import { loadPartsView, partsViewJson } from '../src/parts-view.ts';
import { stagePartsRoutes } from '../src/stage-parts.ts';
import { writeDifferencePackage } from './helpers/parts-difference-package.ts';

test('Stage advertises only served capabilities when the handoff declares a painting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-difference-'));
  try {
    const parts = join(root, 'out');
    await writeDifferencePackage(parts);
    await mkdir(join(parts, 'rig'));
    await writeFile(join(parts, 'rig/rig.json'), JSON.stringify({ images: 'parts', skins: {} }));
    await writeFile(join(parts, 'rig/motion.json'), '{}');
    await writeFile(join(parts, 'rig/mesh_report.json'), '[]');
    await writeFile(join(root, 'config.json'), '{}');
    await writeFile(join(root, 'draft.model.json'), JSON.stringify({
      spec: 'rigc-compiled/3',
      pages: [{ name: 'out/painting_in_rig.png', width: 32, height: 24, regions: [
        { name: 'body', x: 0, y: 0, width: 20, height: 16 },
      ] }],
    }));
    await writeFile(join(root, 'review.json'), JSON.stringify({
      schema: 'rig-review/1', id: 'stage-difference', title: 'Stage difference', revision: '1',
      model: 'draft.model.json', producer: { config: 'config.json', parts: 'out' },
    }));

    const standalone = await loadPartsView(parts);
    expect(partsViewJson(standalone, { verdict: null, stale: null }).differenceAvailable).toBe(true);
    const review = await loadReview(root);
    const single = stagePartsRoutes({ single: review });
    const compare = stagePartsRoutes({ a: review, b: review });
    for (const [route, path, mode] of [
      [single, '/api/stage-parts', 'parts'],
      [compare, '/api/compare/a/stage-parts', 'atlas'],
      [compare, '/api/compare/b/stage-parts', 'atlas'],
    ] as const) {
      const url = 'http://127.0.0.1' + path;
      const response = await route(new Request(url));
      expect(response?.status).toBe(200);
      expect(await response!.json()).toMatchObject({ mode, readOnly: true, differenceAvailable: false });
      expect(await route(new Request(url + '/difference/0'))).toBeNull();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
