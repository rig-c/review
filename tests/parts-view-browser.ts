/**
 * Browser verification for #348 (run by hand: `bun tests/parts-view-browser.ts [--shots <dir>] [--parts <dir>]`).
 *
 * - Bar 1 in a real browser: on the planted package, the footprint toggle tints exactly the planted hole in the back
 *   part (read back from the page's own canvas), and the control part shows no tint on the bare sentinel.
 * - Bar 2: the planted faint island is listed on its part.
 * - Atlas bar: on the public demo, the page view draws one box per region in the atlas file, at the file's box.
 * - Screenshots, en and ko, in parts mode (the planted package, or `--parts <dir>`) and atlas mode (the demo).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPartsView } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { FOOTPRINT_ALPHA } from '../web/parts-render.ts';
import { BACK_DEFECT, frontHolds, writePartsPackage } from './helpers/parts-package.ts';
import { launchCdpSession, type CdpSession } from './parts-explorer-browser.ts';

const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i > 0 ? Bun.argv[i + 1] : undefined; };

async function open(page: CdpSession, input: string, lang: 'en' | 'ko', shotDir: string | undefined, shot: string, before?: string) {
  const pkg = await loadPartsView(input), capability = 'd'.repeat(64);
  const server = await startPartsServer(pkg, { port: 0, capability });
  try {
    const url = `http://127.0.0.1:${server.port}/?lang=${lang}#cap=${capability}`;
    await page.goto(url);
    for (let i = 0; i < 200 && !(await page.evaluate<boolean>('document.body.dataset.ready === "true"')); i++) await Bun.sleep(25);
    if (before) await page.evaluate(before);
    await Bun.sleep(250);
    if (shotDir) await writeFile(join(shotDir, `${shot}-${lang}.png`), await page.screenshot());
    return { pkg, server };
  } catch (e) { server.stop(true); throw e; }
}

const select = (name: string) => `document.querySelector('[data-pv-item=${JSON.stringify(name)}]').click()`;
const toggle = (id: string) => `(()=>{const c=document.getElementById(${JSON.stringify(id)});c.checked=true;c.dispatchEvent(new Event('change'))})()`;
const tint = `(()=>{const c=document.getElementById('pv-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,o=[];for(let i=0;i<d.length;i+=4)if(d[i]===0&&d[i+1]===255&&Math.abs(d[i+2]-${255 * FOOTPRINT_ALPHA})<=1)o.push((i/4)%c.width+','+Math.floor(i/4/c.width));return {w:c.width,h:c.height,tint:o}})()`;

export async function runPartsViewBrowser(shotDir?: string, partsDir?: string) {
  const root = await mkdtemp(join(tmpdir(), 'parts-view-browser-'));
  const profile = await mkdtemp(join(tmpdir(), 'parts-view-profile-'));
  if (shotDir) await mkdir(shotDir, { recursive: true });
  await writePartsPackage(root);
  const page = await launchCdpSession(profile);
  const report: Record<string, unknown> = {};
  try {
    await page.setViewport(1280, 800);
    // Bar 1 and Bar 2 on the planted package.
    {
      const { server } = await open(page, root, 'en', undefined, 'planted');
      await page.evaluate(select('back_defect')); await page.evaluate(toggle('pv-footprints')); await Bun.sleep(300);
      const defect = await page.evaluate<{ w: number; h: number; tint: string[] }>(tint);
      const hole: string[] = [];
      for (let y = 0; y < BACK_DEFECT.h; y++) for (let x = 0; x < BACK_DEFECT.w; x++) if (frontHolds(BACK_DEFECT.x + x, BACK_DEFECT.y + y)) hole.push(`${x},${y}`);
      const flags = await page.evaluate<string[]>(`[...document.querySelectorAll('#pv-flags li[data-flag-id]')].map(l=>l.dataset.flagId)`);
      await page.evaluate(select('back_control')); await Bun.sleep(300);
      const control = await page.evaluate<{ tint: string[] }>(tint);
      const caption = await page.evaluate<string>(`document.getElementById('pv-caption').textContent`);
      report.bar1 = { canvas: [defect.w, defect.h], holePx: hole.length, tintPx: defect.tint.length, coincide: JSON.stringify([...defect.tint].sort()) === JSON.stringify([...hole].sort()), controlTintPx: control.tint.length, controlCaption: caption };
      report.bar2 = { backDefectFlags: flags };
      server.stop(true);
    }
    // Atlas bar on the public demo.
    {
      const { server } = await open(page, 'examples/demo', 'en', undefined, 'atlas');
      await page.evaluate(`document.querySelector('[data-pv-view="page"]').click()`); await Bun.sleep(300);
      const boxes = await page.evaluate<string[][]>(`[...document.querySelectorAll('.pv-box[data-region]')].map(b=>[b.dataset.region,b.dataset.x,b.dataset.y,b.dataset.w,b.dataset.h])`);
      const model = JSON.parse(await readFile('examples/demo/skeleton.model.json', 'utf8')) as { pages: { regions: { name: string; x: number; y: number; width: number; height: number }[] }[] };
      const expected = model.pages.flatMap(p => p.regions.map(r => [r.name, String(r.x), String(r.y), String(r.width), String(r.height)]));
      report.atlas = { boxes, expected, equal: JSON.stringify(boxes) === JSON.stringify(expected) };
      server.stop(true);
    }
    // Screenshots, en and ko.
    if (shotDir) for (const lang of ['en', 'ko'] as const) {
      const parts = partsDir ?? root;
      const a = await open(page, parts, lang, shotDir, 'parts-mode', `${toggle('pv-footprints')};document.querySelector('[data-pv-zoom="2"]').click()`); a.server.stop(true);
      const b = await open(page, 'examples/demo', lang, shotDir, 'atlas-mode', `document.querySelector('[data-pv-zoom="4"]').click();document.querySelector('[data-pv-view="page"]').click()`); b.server.stop(true);
    }
  } finally {
    await page.close();
    await rm(root, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
  return report;
}

if (import.meta.main) {
  const report = await runPartsViewBrowser(arg('--shots'), arg('--parts'));
  console.log(JSON.stringify(report, null, 1));
  const r = report as { bar1: { coincide: boolean; controlTintPx: number; tintPx: number }; bar2: { backDefectFlags: string[] }; atlas: { equal: boolean } };
  const ok = r.bar1.coincide && r.bar1.tintPx > 0 && r.bar1.controlTintPx === 0 && r.bar2.backDefectFlags.includes('faint:0') && r.atlas.equal;
  console.log(ok ? 'PARTS VIEW BROWSER: PASS' : 'PARTS VIEW BROWSER: FAIL');
  process.exit(ok ? 0 : 1);
}
