/** Focused browser receipt; --baseline names the base commit's web/parts.ts, placed beside web dependencies.
 * Run with --baseline web/parts365-baseline.ts [--public <copied public build>]. The baseline is an external
 * receipt input, generated with git show before submission, and is never a shipped fixture.
 */
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadPartsView } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { writeMeshPackage } from './helpers/parts-mesh-package.ts';
import { provePartsEquivalence } from './helpers/parts-equivalence.ts';
import { launchSoftwareCapture } from './helpers/software-capture.ts';
import { launchCdpSession } from './parts-explorer-browser.ts';
const baselineArg = Bun.argv.indexOf('--baseline');
if (baselineArg < 0 || !Bun.argv[baselineArg + 1]) throw new Error('Required: --baseline <base parts.ts entrypoint beside web dependencies>');
const root = await mkdtemp(join(tmpdir(), 'mesh-browser-')), profile = await mkdtemp(join(tmpdir(), 'mesh-profile-'));
const shots = 'mesh-evidence'; await mkdir(shots, { recursive: true });
await writeMeshPackage(root);
const configured = Bun.argv.includes('--capture-config') ? await launchSoftwareCapture(profile) : null;
const page = configured?.page ?? await launchCdpSession(profile); await page.setViewport(1280, 800);
const report: Record<string, unknown> = configured ? { browser: configured.browser } : {};
if (configured) await writeFile(join(shots, 'capture-browser.json'), JSON.stringify(configured.browser, null, 2));
const capability = 'e'.repeat(64);
async function ready(url: string) { await page.goto('about:blank'); await page.goto(url); for (let i = 0; i < 200; i++) { if (await page.evaluate<boolean>(`document.body.dataset.ready === 'true' && document.getElementById('pv-canvas').width>1`)) { await Bun.sleep(250); return; } await Bun.sleep(25); } throw new Error('page not ready'); }
async function saved(): Promise<{ result: string; text: string }> {
  await page.evaluate(`document.getElementById('pv-save-status').dataset.result='';document.getElementById('pv-save').click()`);
  for (let i = 0; i < 200; i++) {
    const result = await page.evaluate<{ result: string; text: string }>(`(()=>{const e=document.getElementById('pv-save-status');return {result:e.dataset.result||'',text:e.textContent}})()`);
    if (result.result) return result; await Bun.sleep(25);
  }
  throw new Error('save result timeout');
}
const choose = (name: string) => page.evaluate(`document.querySelector('[data-pv-item=${JSON.stringify(name)}]').click()`);
async function meshOutcome(value: string, note = '') {
  await page.evaluate(`(()=>{const p=document.getElementById('pv-mesh-panel'),s=p.querySelector('select'),n=p.querySelector('textarea');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change'));n.value=${JSON.stringify(note)};n.dispatchEvent(new Event('input'))})()`);
}
async function observation() {
  return page.evaluate(`({url:location.href,loadStatus:document.getElementById('pv-load')?.textContent,active:document.activeElement?.id,hover:[...document.querySelectorAll(':hover')].map(e=>e.id||e.tagName),elements:[...document.querySelectorAll('button,input,select,textarea')].map(e=>{const r=e.getBoundingClientRect();return {id:e.id,tag:e.tagName,x:r.x,y:r.y,w:r.width,h:r.height}})})`);
}
try {
  const loaded = await loadPartsView(root);
  const sources = [...loaded.files, ...loaded.flagFiles];
  const hashSources = async () => Promise.all(sources.map(async f => ({ file: f.abs.slice(root.length + 1), sha256: new Bun.CryptoHasher('sha256').update(await readFile(f.abs)).digest('hex') })));
  const sourceBefore = await hashSources();
  if (!Bun.argv.includes('--no-rig-only')) {
  const server = await startPartsServer(loaded, { port: 0, capability, graceMs: 60000 });
  try {
    for (const lang of ['en', 'ko']) {
      await ready(`http://127.0.0.1:${server.port}/?lang=${lang}#cap=${capability}`);
      const before = await page.evaluate<boolean>(`!document.querySelector('#pv-mesh-control input').checked`); if (!before) throw new Error('mesh not hidden by default');
      const figures = await page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-mesh-figure]')].map(e=>[e.dataset.meshFigure,e.textContent]))`);
      const rows = JSON.parse(await readFile(join(root, 'mesh_report.json'), 'utf8')), expected = { ...rows[0] }; delete expected.part;
      for (const [key, value] of Object.entries(expected)) if (figures[key] !== JSON.stringify(value)) throw new Error(`figure ${key}`);
      await page.evaluate(`document.querySelector('[data-pv-zoom="4"]').click();document.querySelector('#pv-mesh-control input').click()`); await Bun.sleep(250);
      const gapCentre = await page.evaluate<number[]>(`[...document.getElementById('pv-canvas').getContext('2d').getImageData(24,25,1,1).data]`);
      if (gapCentre[0]! <= 136) throw new Error('gap pixel not tinted');
      await writeFile(join(shots, `mesh-overlay-${lang}.png`), await page.screenshot());
      report[lang] = { figures, differences: 0, hiddenByDefault: before, gapCentre };
    }
    await ready(`http://127.0.0.1:${server.port}/?lang=en#cap=${capability}`);
    for (const name of ['gap', 'covered']) {
      await choose(name);
      await page.evaluate(`document.querySelector('[data-pv-outcome][value="clean"]').click()`);
      if (name === 'covered') await meshOutcome('clean');
    }
    await page.evaluate(`document.getElementById('pv-overall').value='approved'`);
    const pending = await saved();
    if (pending.result !== 'refused' || !pending.text.includes('PARTS_VERDICT_NOT_CLEAN')) throw new Error('pending mesh approved');
    await choose('gap');
    const note = 'Mesh gap at cell (1,1).'; await meshOutcome('flagged', note);
    await page.evaluate(`document.getElementById('pv-overall').value='changes-requested'`);
    const flagged = await saved(); if (flagged.result !== 'saved') throw new Error(`flagged save: ${flagged.text}`);
    for (const lang of ['en', 'ko']) {
      await ready(`http://127.0.0.1:${server.port}/?lang=${lang}#cap=${capability}`);
      const reopened = await page.evaluate<{ outcome: string; note: string; status: string; restored: boolean }>(`({outcome:document.querySelector('#pv-mesh-panel select').value,note:document.querySelector('#pv-mesh-panel textarea').value,status:document.getElementById('pv-overall').value,restored:document.getElementById('pv-load').textContent===${JSON.stringify(lang === 'en' ? 'Saved sign-off loaded.' : '저장된 승인을 불러왔습니다.')}})`);
      if (reopened.outcome !== 'flagged' || reopened.note !== note || reopened.status !== 'changes-requested' || !reopened.restored) throw new Error('flagged mesh not restored');
      await writeFile(join(shots, `mesh-reopened-${lang}.png`), await page.screenshot());
    }
    const sourceAfter = await hashSources();
    report.saveReopen = { pending, flagged, reopenedInBothLanguages: true, sourceBytesUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), sources: sourceAfter };
    if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) throw new Error('source bytes changed by sign-off');
  } finally { server.stop(true); }
  }
  // The independent no-rig fixture phase starts after the source-invariance proof.
  await unlink(join(root, 'rig.json'));
  if (!Bun.argv.includes('--no-rig-only')) await unlink(join(root, 'parts-review.json'));
  const pkg = await loadPartsView(root), server2 = await startPartsServer(pkg, { port: 0, capability, graceMs: 60000 });
  try {
    await ready(`http://127.0.0.1:${server2.port}/?lang=en#cap=${capability}`);
    const currentObservation = await observation();
    const current = await page.screenshot();
    await writeFile(join(shots, 'no-rig-current.png'), current);
    const noControls = await page.evaluate<boolean>(`!document.getElementById('pv-mesh-panel')&&!document.getElementById('pv-mesh-control')`);
    if (!noControls) throw new Error('mesh controls without rig');
    // The HQ base entrypoint, built against unchanged shared view dependencies, supplied by the receipt adapter.
    const base = await Bun.build({ entrypoints: [Bun.argv[baselineArg + 1]!], target: 'browser' }); if (!base.success) throw new Error('baseline bundle failed');
    const baseScript = await base.outputs[0]!.text();
    let serveBaseline = true;
    const headScript = Bun.argv.includes('--instruments') ? await (await fetch(`http://127.0.0.1:${server2.port}/parts.js`)).text() : '';
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) { const u = new URL(req.url); if (u.pathname === '/api/live') return new Response(null, { status: 204 }); if (u.pathname === '/parts.js') return new Response(serveBaseline ? baseScript : headScript, { headers: { 'Content-Type': 'text/javascript' } }); return fetch(`http://127.0.0.1:${server2.port}${u.pathname}${u.search}`); } });
    try {
      if (Bun.argv.includes('--instruments')) {
        const equivalence = await provePartsEquivalence(page, async (baseline, language) => {
          serveBaseline = baseline;
          await ready(`http://127.0.0.1:${proxy.port}/?lang=${language}#cap=${capability}`);
        }, shots);
        report.instruments = equivalence;
        report.noRig = { rgbaByteDifferences: equivalence.languages[0]!.canvasBytes, replacementInstruments: true, noControls };
        await writeFile(join(shots, 'browser.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(equivalence));
        if (!equivalence.passed) throw new Error('replacement exact equivalence instruments failed');
      } else if (Bun.argv.includes('--capture-config')) {
        const capture = async (port: number, name: string) => {
          await ready(`http://127.0.0.1:${port}/?lang=en#cap=${capability}`);
          await page.evaluate(`document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
          const png = await page.screenshot({ x: 0, y: 0, width: 1280, height: 800 });
          await writeFile(join(shots, name + '.png'), png); return png;
        };
        const compare = async (left: Buffer, right: Buffer, name: string) => {
          const a = await loadImage(left), b = await loadImage(right), canvas = createCanvas(1280, 800), ctx = canvas.getContext('2d');
          ctx.drawImage(a, 0, 0); const ap = ctx.getImageData(0, 0, 1280, 800).data; ctx.clearRect(0, 0, 1280, 800); ctx.drawImage(b, 0, 0); const bp = ctx.getImageData(0, 0, 1280, 800).data;
          const pixels = []; let rgbaBytes = 0; const heat = ctx.createImageData(1280, 800);
          for (let i = 0; i < ap.length; i += 4) {
            heat.data[i + 3] = 255; const channels = [0, 1, 2, 3].filter(c => ap[i + c] !== bp[i + c]);
            if (channels.length) { rgbaBytes += channels.length; heat.data[i] = 255; pixels.push({ x: (i / 4) % 1280, y: Math.floor(i / 4 / 1280), channels, left: [...ap.slice(i, i + 4)], right: [...bp.slice(i, i + 4)] }); }
          }
          const result = { rgbaBytes, changedPixels: pixels.length, pixels };
          ctx.putImageData(heat, 0, 0); await writeFile(join(shots, name + '.png'), canvas.toBuffer('image/png'));
          await writeFile(join(shots, name + '.json'), JSON.stringify(result, null, 2)); return result;
        };
        const controls = [];
        for (let i = 1; i <= 3; i++) controls.push(await compare(await capture(proxy.port!, `config-baseline-${i}a`), await capture(proxy.port!, `config-baseline-${i}b`), `config-baseline-diff-${i}`));
        const controlPass = controls.every(c => c.rgbaBytes === 0);
        const mainHead = controlPass ? await compare(await capture(proxy.port!, 'config-main'), await capture(server2.port!, 'config-head'), 'config-main-head-diff') : null;
        report.captureConfig = { controls, mainHead, passed: controlPass && mainHead?.rgbaBytes === 0, wording: 'the native form-control corners are not deterministic under this capture; the lower-level cause is unproved' };
        await writeFile(join(shots, 'capture-config.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report.captureConfig));
        if (!(report.captureConfig as { passed: boolean }).passed) throw new Error('capture config did not establish the deterministic gate');
        report.noRig = { rgbaByteDifferences: mainHead!.rgbaBytes, noControls };
      } else {
      await ready(`http://127.0.0.1:${proxy.port}/?lang=en#cap=${capability}`);
      const baselineObservation = await observation();
      const baseline = await page.screenshot();
      await writeFile(join(shots, 'no-rig-baseline.png'), baseline);
      const a = await loadImage(current), b = await loadImage(baseline), c = createCanvas(a.width, a.height), ctx = c.getContext('2d');
      ctx.drawImage(a, 0, 0); const ap = ctx.getImageData(0, 0, a.width, a.height).data; ctx.drawImage(b, 0, 0); const bp = ctx.getImageData(0, 0, b.width, b.height).data;
      const diff = createCanvas(a.width, a.height), dx = diff.getContext('2d'), dp = dx.createImageData(a.width, a.height);
      let differences = 0;
      const pixels: { x: number; y: number; current: number[]; baseline: number[]; channels: number[] }[] = [];
      for (let i = 0; i < ap.length; i += 4) {
        const channels = [0, 1, 2, 3].filter(k => ap[i + k] !== bp[i + k]);
        dp.data[i + 3] = 255;
        if (channels.length) {
          differences += channels.length; dp.data[i] = 255;
          pixels.push({ x: (i / 4) % a.width, y: Math.floor(i / 4 / a.width), current: [...ap.slice(i, i + 4)], baseline: [...bp.slice(i, i + 4)], channels });
        }
      }
      dx.putImageData(dp, 0, 0); await writeFile(join(shots, 'no-rig-diff.png'), diff.toBuffer('image/png'));
      report.noRig = { rgbaByteDifferences: differences, changedPixels: pixels.length, noControls, pixels, currentObservation, baselineObservation };
      await writeFile(join(shots, 'no-rig-diff.json'), JSON.stringify(report.noRig, null, 2));
      if (Bun.argv.includes('--repeat-no-rig')) {
        const samples = [];
        for (let sample = 1; sample <= 5; sample++) {
          await ready(`http://127.0.0.1:${server2.port}/?lang=en#cap=${capability}`);
          const co = await observation(), cur = await page.screenshot();
          await ready(`http://127.0.0.1:${proxy.port}/?lang=en#cap=${capability}`);
          const bo = await observation(), bas = await page.screenshot();
          await writeFile(join(shots, `no-rig-current-${sample}.png`), cur);
          await writeFile(join(shots, `no-rig-baseline-${sample}.png`), bas);
          const ci = await loadImage(cur), bi = await loadImage(bas);
          ctx.clearRect(0, 0, a.width, a.height); ctx.drawImage(ci, 0, 0);
          const cp = ctx.getImageData(0, 0, a.width, a.height).data;
          ctx.clearRect(0, 0, a.width, a.height); ctx.drawImage(bi, 0, 0);
          const bp2 = ctx.getImageData(0, 0, a.width, a.height).data;
          const changed = [];
          let bytes = 0;
          const heat = dx.createImageData(a.width, a.height);
          for (let i = 0; i < cp.length; i += 4) {
            heat.data[i + 3] = 255;
            const channels = [0, 1, 2, 3].filter(k => cp[i + k] !== bp2[i + k]);
            if (channels.length) {
              bytes += channels.length; heat.data[i] = 255;
              changed.push({ x: (i / 4) % a.width, y: Math.floor(i / 4 / a.width), current: [...cp.slice(i, i + 4)], baseline: [...bp2.slice(i, i + 4)], channels });
            }
          }
          dx.putImageData(heat, 0, 0); await writeFile(join(shots, `no-rig-diff-${sample}.png`), diff.toBuffer('image/png'));
          const entry = { sample, rgbaByteDifferences: bytes, changedPixels: changed.length, pixels: changed, currentObservation: co, baselineObservation: bo };
          await writeFile(join(shots, `no-rig-diff-${sample}.json`), JSON.stringify(entry, null, 2));
          samples.push(entry);
        }
        report.noRigSamples = samples;
      }

      }
    } finally { proxy.stop(true); }
  } finally { server2.stop(true); }
  const publicArg = Bun.argv.indexOf('--public');
  if (publicArg >= 0) {
    const input = Bun.argv[publicArg + 1]!;
    const pkg = await loadPartsView(input, { rig: join(input, 'rig/rig.json'), meshReport: join(input, 'rig/mesh_report.json') });
    const server = await startPartsServer(pkg, { port: 0, capability, graceMs: 60000 });
    const rows = JSON.parse(await readFile(join(input, 'rig/mesh_report.json'), 'utf8'));
    let meshes = 0;
    try {
      await ready(`http://127.0.0.1:${server.port}/?lang=en#cap=${capability}`);
      for (const item of pkg.items.filter(i => i.mesh)) {
        await page.evaluate(`document.querySelector('[data-pv-item=${JSON.stringify(item.name)}]').click()`);
        const shown = await page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-mesh-figure]')].map(e=>[e.dataset.meshFigure,e.textContent]))`);
        const row = rows.find((r: { part: string }) => r.part === item.name) ?? {};
        for (const field of ['mode', 'vertices', 'triangles', 'art_coverage', 'stray_cleared']) {
          const expected = Object.hasOwn(row, field) ? JSON.stringify(row[field]) : 'not reported';
          if (shown[field] !== expected) throw new Error(`public figure mismatch ${item.name}.${field}`);
        }
        meshes++;
      }
      report.publicExample = { meshes, fieldsPerMesh: 5, differences: 0 }; if (meshes !== 9) throw new Error(`public mesh count ${meshes}`);
    } finally { server.stop(true); }
  }
  await writeFile(join(shots, 'browser.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (Array.isArray(report.noRigSamples) && report.noRigSamples.some(s => s.rgbaByteDifferences !== 0)) throw new Error('repeated no-rig comparison differs; see captured pixel coordinates');
  if ((report.noRig as { rgbaByteDifferences: number }).rgbaByteDifferences) throw new Error(`no-rig baseline differs: ${(report.noRig as { rgbaByteDifferences: number }).rgbaByteDifferences}`);
} finally { await page.close(); await rm(root, { recursive: true, force: true }); await rm(profile, { recursive: true, force: true }); }
