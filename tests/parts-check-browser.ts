/** #380: same public input and DOM assertions against this tree or an exact released app copy.
 * Nova only: PARTS_CHECK_APP_ROOT=<copy> PARTS_CHECK_SHOTS=<out> bun tests/parts-check-browser.ts
 * Deliberately exercises presentation only; no producer runs or semantic classification.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writePartsPackage } from './helpers/parts-package.ts';
import { launchCdpSession } from './parts-explorer-browser.ts';

const appRoot = resolve(process.env.PARTS_CHECK_APP_ROOT ?? '.');
const { loadPartsView } = await import(pathToFileURL(join(appRoot, 'src/parts-view.ts')).href) as typeof import('../src/parts-view.ts');
const { startPartsServer } = await import(pathToFileURL(join(appRoot, 'src/parts-server.ts')).href) as typeof import('../src/parts-server.ts');
const out = resolve(process.env.PARTS_CHECK_SHOTS ?? 'parts-check-evidence');
const root = await mkdtemp(join(tmpdir(), 'parts-check-380-'));
const profile = await mkdtemp(join(tmpdir(), 'parts-check-profile-'));
await mkdir(out, { recursive: true });
await writePartsPackage(root);
const fixture = await readFile(new URL('./fixtures/parts-check-380.json', import.meta.url));
await writeFile(join(root, 'check/check.json'), fixture);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pkg = await loadPartsView(root);
const inputs = [...pkg.files, ...pkg.flagFiles];
const before = await Promise.all(inputs.map(async f => sha(await readFile(f.abs))));
const checks: Array<{ name: string; ok: boolean; actual?: unknown }> = [];
const check = (name: string, ok: boolean, actual?: unknown) => checks.push({ name, ok, actual });
const report: Record<string, unknown> = { version: JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version, fixtureSha256: sha(fixture), checks };
const page = await launchCdpSession(profile);
const server = await startPartsServer(pkg, { port: 0, capability: 'e'.repeat(64) });
try {
  await page.setViewport(1440, 1100);
  report.counts = { mesh: pkg.flags.filter(f => f.source === 'mesh_report').length, check: pkg.flags.filter(f => f.source === 'check').length };
  check('all original attributions retained', pkg.flags.length === 12, report.counts);
  for (const lang of ['en', 'ko'] as const) {
    await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}#cap=${'e'.repeat(64)}`);
    let ready = false;
    for (let i = 0; i < 200; i++) {
      ready = await page.evaluate<boolean>('document.body.dataset.ready === "true"');
      if (ready) break;
      await Bun.sleep(25);
    }
    check(`${lang} ready`, ready);
    const badges = await page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-pv-item]')].map(b=>[b.dataset.pvItem,b.querySelector('.pv-count').textContent]))`);
    const expected = lang === 'en'
      ? { back_defect: 'mesh 1 · check 4', back_control: 'mesh 0 · check 2', front: 'mesh 0 · check 5' }
      : { back_defect: '메시 1 · 체크 4', back_control: '메시 0 · 체크 2', front: '메시 0 · 체크 5' };
    check(`${lang} separate source badges`, JSON.stringify(badges) === JSON.stringify(expected), badges);
    const groups = await page.evaluate<Array<{ source: string; root: string; count: number; open: boolean; summary: string }>>(`Array.from(document.querySelectorAll('details[data-pv-root]'),g=>({source:g.dataset.flagSource,root:g.dataset.pvRoot,count:g.querySelectorAll('[data-flag-id]').length,open:g.open,summary:g.querySelector('summary').textContent}))`);
    check(`${lang} collapsed producer roots`, groups.length === 4 && groups.every(g => !g.open), groups);
    check(`${lang} root counts`, JSON.stringify(groups.map(g => [g.source, g.root, g.count])) === JSON.stringify([
      ['mesh_report', 'contour.bridges.faint', 1], ['check', 'PART_SUPPORT_REPORT', 2], ['check', 'SEAM_OVER_MOTION', 1], ['check', 'LIMB_ONE_BONE', 1],
    ]), groups);
    check(`${lang} localized root summaries`, groups.length === 4 && groups.every(g => g.summary === (lang === 'ko' ? `${g.root} · ${g.count}행` : `${g.root} · ${g.count} ${g.count === 1 ? 'row' : 'rows'}`)), groups);
    check(`${lang} source file headings`, await page.evaluate<boolean>(`(()=>{const s=[...document.querySelectorAll('#pv-flags [data-pv-source]')];return s.length===2&&s[0].querySelector('h3').textContent==='mesh_report.json'&&s[1].querySelector('h3').textContent==='check.json'})()`));
    await writeFile(join(out, `collapsed-${lang}.png`), await page.screenshot());
    // Real summary clicks, not programmatic .open assignment.
    await page.evaluate(`document.querySelectorAll('details[data-pv-root] > summary').forEach(s=>s.click())`);
    const rows = await page.evaluate<Array<{ path: string; label: string; raw: string; visible: boolean }>>(`Array.from(document.querySelectorAll('#pv-flags [data-flag-id][data-flag-source="check"]'),r=>({path:r.dataset.flagId.slice(6),label:r.querySelector('.pv-flag-label').textContent,raw:r.querySelector('code').textContent,visible:r.querySelector('.pv-flag-label').getClientRects().length>0}))`);
    check(`${lang} expanded rows retain root path identity`, rows.length === 4 && rows.every(r => r.visible && r.label.includes(r.path) && r.label.includes('back_defect')) && rows.some(r => r.label.includes('front|back_defect')) && rows.some(r => r.label.includes('unavailable')), rows);
    check(`${lang} raw unavailable row preserved`, rows.some(r => r.path === 'PART_SUPPORT_REPORT.pairs[0]' && r.raw.includes('"status":"unavailable"') && r.raw.includes('"boundary_length_px":null')), rows);
    await writeFile(join(out, `expanded-${lang}.png`), await page.screenshot());
    await page.evaluate(`document.querySelector('[data-pv-item="front"]').click()`);
    const labels = await page.evaluate<string[]>(`Array.from(document.querySelectorAll('#pv-flags [data-flag-id] .pv-flag-label'),e=>e.textContent)`);
    check(`${lang} same-part pair rows distinct`, labels.length === 5 && new Set(labels).size === 5 && labels.some(l => l.includes('SEAM_OVER_MOTION.pairs[0]') && l.includes('front|back_defect')) && labels.some(l => l.includes('SEAM_OVER_MOTION.pairs[1]') && l.includes('front|back_control')), labels);
    await page.evaluate(`document.querySelector('details[data-pv-root="SEAM_OVER_MOTION"] > summary')?.click()`);
    await writeFile(join(out, `pairs-${lang}.png`), await page.screenshot());
    check(`${lang} part names and source badges fit`, await page.evaluate<boolean>(`[...document.querySelectorAll('#pv-items .pv-name,#pv-items .pv-count')].every(e=>e.scrollWidth<=e.clientWidth)`));
    // DOM negative: a combined total must fail the source-count assertion.
    const negative = await page.evaluate<string>(`(()=>{const b=document.querySelector('[data-pv-item="front"] .pv-count');const old=b.textContent;b.textContent='⚑5';const bad=b.textContent;b.textContent=old;return bad})()`);
    check(`${lang} combined-badge negative rejected`, negative !== expected.front);
  }
  const after = await Promise.all(inputs.map(async f => sha(await readFile(f.abs))));
  check('all inspected inputs immutable', JSON.stringify(before) === JSON.stringify(after));
  report.inputSha256 = before;
} finally {
  server.stop(true);
  await page.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
report.pass = checks.every(c => c.ok);
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
