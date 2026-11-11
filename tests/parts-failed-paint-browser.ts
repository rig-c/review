import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startPartsServer } from '../src/parts-server.ts';
import { loadPartsView } from '../src/parts-view.ts';
import { writeComparisonPackage } from './helpers/parts-comparison-package.ts';
import { launchCdpSession, type InputCdpSession as Page } from './parts-explorer-browser.ts';

const assert = (v: unknown, m: string) => {
  if (!v) throw new Error(m);
};
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function wait(p: Page, s: string) {
  for (let i = 0; i < 200; i++) {
    if (await p.evaluate(s)) return;
    await Bun.sleep(25);
  }
  throw new Error('BROWSER_WAIT ' + s);
}

async function click(p: Page, s: string) {
  const r = await p.evaluate<{ x: number; y: number }>(`(() => {
    const n = document.querySelector(${JSON.stringify(s)});
    n?.scrollIntoView({ block: 'nearest' });
    const r = n?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) throw new Error('Hidden target: ' + ${JSON.stringify(s)});
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await p.mouse('mouseMoved', r.x, r.y);
  await p.mouse('mousePressed', r.x, r.y);
  await p.mouse('mouseReleased', r.x, r.y);
}

async function dragViewport(p: Page) {
  const r = await p.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => {
    const c = document.getElementById('rig-viewport').getBoundingClientRect();
    return { x: c.left, y: c.top, w: c.width, h: c.height };
  })()`);
  await p.mouse('mouseMoved', r.x + r.w * 0.4, r.y + r.h * 0.4);
  await p.mouse('mousePressed', r.x + r.w * 0.4, r.y + r.h * 0.4);
  await p.mouse('mouseMoved', r.x + r.w * 0.6, r.y + r.h * 0.6);
  await p.mouse('mouseReleased', r.x + r.w * 0.6, r.y + r.h * 0.6);
}

async function sample(p: Page) {
  return p.evaluate<{
    canvas: { w: number; h: number; cleared: boolean; pixel: number[] };
    reference: { w: number; h: number; cleared: boolean; pixel: number[] };
    zoomLabel: string;
    scale: number;
    left: string;
    top: string;
    transform: string;
    nativeRoot: { left: string; top: string; transform: string };
    center: { x: number; y: number };
    status: string;
    caption: string;
    refusal: string;
  }>(`(() => {
    const c = document.getElementById('pv-canvas');
    const ref = document.getElementById('pv-reference');
    const vp = document.getElementById('rig-viewport');
    const root = document.getElementById('rig-root');
    const cData = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const refData = ref.getContext('2d').getImageData(0, 0, ref.width, ref.height).data;
    const cCleared = Array.from(cData).every((n, i) => i % 4 !== 3 || n === 0);
    const refCleared = Array.from(refData).every((n, i) => i % 4 !== 3 || n === 0);
    const scale = new DOMMatrix(root.style.transform).a;
    const leftNum = parseFloat(root.style.left || '0');
    const topNum = parseFloat(root.style.top || '0');
    const nativeStyle = document.createElement('div').style;
    nativeStyle.left = (vp.clientWidth / 2 - c.width / 2) + 'px';
    nativeStyle.top = (vp.clientHeight / 2 - c.height / 2) + 'px';
    nativeStyle.transform = 'scale(1)';
    const pixel = canvas => Array.from(canvas.getContext('2d').getImageData(3, 3, 1, 1).data);
    return {
      canvas: { w: c.width, h: c.height, cleared: cCleared, pixel: pixel(c) },
      reference: { w: ref.width, h: ref.height, cleared: refCleared, pixel: pixel(ref) },
      zoomLabel: document.getElementById('zoom-value').textContent || '',
      scale,
      left: root.style.left,
      top: root.style.top,
      transform: root.style.transform,
      nativeRoot: { left: nativeStyle.left, top: nativeStyle.top, transform: nativeStyle.transform },
      center: {
        x: Number(((vp.clientWidth / 2 - leftNum) / scale).toFixed(4)),
        y: Number(((vp.clientHeight / 2 - topNum) / scale).toFixed(4)),
      },
      status: document.getElementById('parts-save-status').textContent || '',
      caption: document.getElementById('pv-caption').textContent || '',
      refusal: document.getElementById('stage-comment-refusal')?.textContent || '',
    };
  })()`);
}

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const outDir = resolve(
    outFlag >= 0 && process.argv[outFlag + 1]
      ? process.argv[outFlag + 1]!
      : (process.env.RIG_REVIEW_FAILED_PAINT_EVIDENCE ?? 'cache/parts-failed-paint-browser'),
  );
  await mkdir(outDir, { recursive: true });
  const root = await mkdtemp(join(process.env.RIG_REVIEW_BROWSER_CACHE ?? tmpdir(), 'failed-paint-474-'));
  const oldState = process.env.RIG_REVIEW_STATE_DIR;
  process.env.RIG_REVIEW_STATE_DIR = join(outDir, 'state');

  let page: Page | null = null;
  let server: Awaited<ReturnType<typeof startPartsServer>> | null = null;
  const report: Record<string, unknown> = {};

  try {
    const fixture = await writeComparisonPackage(root);
    const pixelAt = (image: { width: number; data: Uint8Array }, x: number, y: number) =>
      Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
    const samePixel = (actual: number[], expected: number[]) => JSON.stringify(actual) === JSON.stringify(expected);
    const pkg = await loadPartsView(root, { painting: join(root, 'painting.png') });
    const beforeHashes = await Promise.all(pkg.files.map(async f => hash(await readFile(f.abs))));
    const cap = 'f'.repeat(64);
    server = await startPartsServer(pkg, {
      port: 0,
      capability: cap,
      exitOnClose: false,
      graceMs: 3_600_000,
      unopenedTimeoutMs: 3_600_000,
    });
    page = await launchCdpSession(join(root, 'profile'));
    await page.setViewport(1440, 1000);
    const base = `http://127.0.0.1:${server.port}/`;

    for (const [docIdx, lang, expectedRefusalSubstr] of [
      [1, 'en', 'PARTS_PAINT_FAILED: view could not be rendered; select the part to retry'],
      [2, 'ko', 'PARTS_PAINT_FAILED:'],
    ] as const) {
      await page.goto(`${base}?lang=${lang}&document=${docIdx}#cap=${cap}`);
      await wait(page, `document.body.dataset.ready==='true' && location.search.includes('document=${docIdx}')`);
      await page.evaluate(`(() => {
        window.__failB = false;
        const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (!window.__patched474 && descriptor) {
          window.__patched474 = true;
          Object.defineProperty(HTMLImageElement.prototype, 'src', {
            ...descriptor,
            set(value) {
              const fail = window.__failB && String(value).endsWith('/api/parts/image/1');
              descriptor.set.call(this, fail ? '/planted-missing-image-474.png' : value);
            },
          });
        }
      })()`);

      await wait(page, `!document.getElementById('stage-comment-refusal').textContent`);
      const initial = await sample(page);
      const progress: Record<string, unknown> = { initial };
      report[lang] = progress;
      assert(initial.canvas.w === 20 && initial.canvas.h === 16 && !initial.canvas.cleared, `${lang}: initial A 20x16 painted`);
      assert(initial.center.x === 10 && initial.center.y === 8 && initial.scale === 1, `${lang}: initial A centered at (10,8) 1:1`);

      assert(initial.reference.w === 20 && initial.reference.h === 16 && !initial.reference.cleared,
        `${lang}: reference buffer painted before planted failure`);
      assert(samePixel(initial.reference.pixel, pixelAt(fixture.painting, fixture.body.x + 3, fixture.body.y + 3)),
        `${lang}: initial reference pixel matches original painting crop`);

      // Switch to B (8x10) with planted image failure
      await page.evaluate(`window.__failB = true`);
      await click(page, '[data-pv-item="front"]');
      await wait(page, `document.getElementById('stage-comment-refusal').textContent.includes('PARTS_PAINT_FAILED')`);

      const failed = await sample(page);
      progress.failed = failed;
      assert(failed.canvas.w === 20 && failed.canvas.h === 16 && failed.canvas.cleared, `${lang}: failed B cleared 20x16 canvas`);
      assert(failed.reference.w === 20 && failed.reference.h === 16 && failed.reference.cleared, `${lang}: failed B cleared 20x16 reference`);
      assert(failed.status.includes(expectedRefusalSubstr), `${lang}: expected refusal in status`);
      assert(failed.scale === 1 && failed.zoomLabel === '1:1', `${lang}: camera reset to 1:1 on failure`);
      assert(failed.center.x === 10 && failed.center.y === 8, `${lang}: camera centered on actual 20x16 canvas (10,8), not unpainted B (4,5)`);

      // Attempt zoom-in, zoom-out, fit, native-one, and drag-pan while paintFailure is active
      await click(page, '#zoom-in');
      await click(page, '#zoom-out');
      await click(page, '#fit');
      await click(page, '#native-one');
      await dragViewport(page);
      const afterRefusedInputs = await sample(page);
      progress.afterRefusedInputs = afterRefusedInputs;
      assert(
        afterRefusedInputs.scale === 1 &&
          afterRefusedInputs.zoomLabel === '1:1' &&
          afterRefusedInputs.center.x === 10 &&
          afterRefusedInputs.center.y === 8 &&
          afterRefusedInputs.left === failed.left &&
          afterRefusedInputs.top === failed.top,
        `${lang}: zoom/pan/fit refused while paintFailure is active`,
      );

      await writeFile(join(outDir, `failed-paint-${lang}.png`), await page.screenshot());

      // Verify recovered framing before a zoom action could repair it.
      await page.evaluate(`window.__failB = false`);
      await click(page, '[data-pv-item="front"]');
      await wait(page, `!document.getElementById('stage-comment-refusal').textContent`);
      const beforeZoom = await sample(page);
      progress.beforeZoom = beforeZoom;
      assert(beforeZoom.canvas.w === 8 && beforeZoom.canvas.h === 10 && !beforeZoom.canvas.cleared &&
        beforeZoom.reference.w === 8 && beforeZoom.reference.h === 10 && !beforeZoom.reference.cleared,
        `${lang}: both recovered B buffers painted before zoom`);
      assert(beforeZoom.scale === 1 && beforeZoom.zoomLabel === '1:1' &&
        beforeZoom.center.x === 4 && beforeZoom.center.y === 5,
        `${lang}: RECOVERY_BEFORE_ZOOM_CENTER`);
      assert(beforeZoom.left === beforeZoom.nativeRoot.left && beforeZoom.top === beforeZoom.nativeRoot.top &&
        beforeZoom.transform === beforeZoom.nativeRoot.transform,
        `${lang}: RECOVERY_BEFORE_ZOOM_ROOT`);
      assert(samePixel(beforeZoom.canvas.pixel, pixelAt(fixture.cover, 3, 3)),
        `${lang}: recovered B pixel matches original part`);
      assert(samePixel(beforeZoom.reference.pixel, pixelAt(fixture.painting, fixture.front.x + 3, fixture.front.y + 3)),
        `${lang}: recovered reference pixel matches original painting crop`);
      await writeFile(join(outDir, `recovered-before-zoom-${lang}.png`), await page.screenshot());
      await click(page, '#zoom-in');
      const recovered = await sample(page);
      assert(
        recovered.canvas.w === 8 &&
          recovered.canvas.h === 10 &&
          !recovered.canvas.cleared &&
          recovered.scale === 1.25 &&
          recovered.center.x === 4 &&
          recovered.center.y === 5,
        `${lang}: recovered B (8x10) paints and zooms to 1.25 at (4,5)`,
      );
      await writeFile(join(outDir, `recovered-paint-${lang}.png`), await page.screenshot());

      progress.recovered = recovered;
    }

    const afterHashes = await Promise.all(pkg.files.map(async f => hash(await readFile(f.abs))));
    report.sourceUnchanged = afterHashes.every((h, i) => h === beforeHashes[i]);
    assert(report.sourceUnchanged, 'source files unchanged');
    report.status = 'passed';
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('PARTS_FAILED_PAINT_BROWSER ' + JSON.stringify(report));
  } catch (error) {
    await writeFile(join(outDir, 'failure.json'), JSON.stringify({ error: String(error), report }, null, 2) + '\n');
    if (page) await writeFile(join(outDir, 'failure.png'), await page.screenshot());
    throw error;
  } finally {
    await page?.close();
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
    if (oldState === undefined) delete process.env.RIG_REVIEW_STATE_DIR;
    else process.env.RIG_REVIEW_STATE_DIR = oldState;
  }
}

if (import.meta.main) await main();
