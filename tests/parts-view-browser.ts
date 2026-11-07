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
import { assertPartsUnchanged, loadPartsView, verdictSource, type PartsViewPackage } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { FOOTPRINT_ALPHA } from '../web/parts-render.ts';
import { BACK_DEFECT, frontHolds, writePartsPackage } from './helpers/parts-package.ts';
import { launchCdpSession, type InputCdpSession } from './parts-explorer-browser.ts';
import {
  centerPartsViewShot,
  measurePartsViewShot,
  preparePartsViewShot,
  selectPartsViewPage,
  type PartsViewShotState,
  type PartsViewShotTarget,
  type PartsViewSourceBinding,
} from './helpers/parts-view-shots.ts';

const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i > 0 ? Bun.argv[i + 1] : undefined; };

function bindPackageSource(pkg: PartsViewPackage, beforeSha256: string, afterSha256: string): PartsViewSourceBinding {
  const current = verdictSource(pkg);
  const page = pkg.pages[0];
  return {
    sourceHash: beforeSha256,
    beforeSourceHash: beforeSha256,
    afterSourceHash: afterSha256,
    files: current.files,
    ...(page ? {
      page: { name: page.name, width: page.width, height: page.height },
      regions: pkg.items.filter(i => i.page === page.name).map(i => ({ name: i.name, x: i.x, y: i.y, w: i.w, h: i.h })),
    } : {}),
  };
}

async function open(
  page: InputCdpSession,
  input: string,
  lang: 'en' | 'ko',
  shotDir: string | undefined,
  shot: string,
  target?: PartsViewShotTarget,
  onRawShot?: (raw: { name: string } & PartsViewShotState) => void | Promise<void>,
) {
  const pkg = await loadPartsView(input), beforeSource = verdictSource(pkg), capability = 'd'.repeat(64);
  const server = await startPartsServer(pkg, { port: 0, capability });
  try {
    const url = `http://127.0.0.1:${server.port}/?lang=${lang}#cap=${capability}`;
    await page.goto(url);
    for (let i = 0; i < 200 && !(await page.evaluate<boolean>('document.body.dataset.ready === "true"')); i++) await Bun.sleep(25);
    if (!(await page.evaluate<boolean>('document.body.dataset.ready === "true"'))) throw new Error('PARTS_VIEW_NOT_READY: page did not finish booting');
    if (target) await preparePartsViewShot(page, target);
    await Bun.sleep(250);
    let state: PartsViewShotState | undefined;
    if (target) {
      await assertPartsUnchanged(pkg);
      const afterSource = verdictSource(await loadPartsView(input));
      const boundTarget: PartsViewShotTarget = {
        ...target,
        source: bindPackageSource(pkg, beforeSource.sha256, afterSource.sha256),
      };
      if (target.mode === 'atlas' && target.view === 'page' && target.zoom === 4) {
        const pan = await centerPartsViewShot(page, boundTarget, async (raw, stage) => {
          await onRawShot?.({ name: `${shot}-${stage}`, ...raw });
          if (shotDir) {
            await writeFile(join(shotDir, `${shot}-${lang}.${stage}.geometry.json`), JSON.stringify(raw, null, 2) + '\n');
          }
        });
        if (shotDir) await writeFile(join(shotDir, `${shot}-${lang}.pan.json`), JSON.stringify(pan, null, 2) + '\n');
        await assertPartsUnchanged(pkg);
        const afterPanSource = verdictSource(await loadPartsView(input));
        boundTarget.source = bindPackageSource(pkg, beforeSource.sha256, afterPanSource.sha256);
      }
      state = await measurePartsViewShot(page, boundTarget, async raw => {
        await onRawShot?.({ name: shot, ...raw });
        if (shotDir) {
          await writeFile(join(shotDir, `${shot}-${lang}.geometry.json`), JSON.stringify(raw, null, 2) + '\n');
        }
      });
    }
    if (shotDir) await writeFile(join(shotDir, `${shot}-${lang}.png`), await page.screenshot());
    return { pkg, server, state, beforeSource };
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
  const rawShots: ({ name: string } & PartsViewShotState)[] = [];
  const report: Record<string, unknown> = { rawShots };
  const persistRaw = async (entry: { name: string } & PartsViewShotState) => {
    rawShots.push(entry);
    if (shotDir) await writeFile(join(shotDir, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n');
  };
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
      const { pkg, server, beforeSource } = await open(page, 'examples/demo', 'en', undefined, 'atlas');
      await selectPartsViewPage(page);
      await assertPartsUnchanged(pkg);
      const afterSource = verdictSource(await loadPartsView('examples/demo'));
      const state = await measurePartsViewShot(page, {
        mode: 'atlas',
        view: 'page',
        zoom: 1,
        language: 'en',
        source: bindPackageSource(pkg, beforeSource.sha256, afterSource.sha256),
      });
      const boxes = await page.evaluate<string[][]>(`[...document.querySelectorAll('.pv-box[data-region]')].map(b=>[b.dataset.region,b.dataset.x,b.dataset.y,b.dataset.w,b.dataset.h])`);
      const model = JSON.parse(await readFile('examples/demo/skeleton.model.json', 'utf8')) as { pages: { regions: { name: string; x: number; y: number; width: number; height: number }[] }[] };
      const expected = model.pages.flatMap(p => p.regions.map(r => [r.name, String(r.x), String(r.y), String(r.width), String(r.height)]));
      report.atlas = { boxes, expected, equal: JSON.stringify(boxes) === JSON.stringify(expected), state };
      server.stop(true);
    }
    // Screenshots, en and ko.
    const shots = [];
    if (shotDir) for (const lang of ['en', 'ko'] as const) {
      const parts = partsDir ?? root;
      const a = await open(page, parts, lang, shotDir, 'parts-mode', { mode: 'parts', view: 'item', zoom: 2, language: lang }, persistRaw);
      a.server.stop(true);
      shots.push({ name: 'parts-mode', ...a.state });
      const b = await open(page, 'examples/demo', lang, shotDir, 'atlas-mode', { mode: 'atlas', view: 'page', zoom: 4, language: lang }, persistRaw);
      b.server.stop(true);
      shots.push({ name: 'atlas-mode', ...b.state });
    }
    report.shots = shots;
    if (shotDir) await writeFile(join(shotDir, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    if (shotDir) await writeFile(join(shotDir, 'raw-report.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
    console.error(JSON.stringify(report, null, 1));
    throw error;
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
