/** #380 P1: actual no--check CLI launch, custom input names and read-but-empty reports.
 * Nova only: PARTS_CHECK_APP_ROOT=<exact app> PARTS_SOURCE_SHOTS=<out> bun tests/parts-source-count-browser.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writePartsPackage } from './helpers/parts-package.ts';
import { launchCdpSession } from './parts-explorer-browser.ts';

const appRoot = resolve(process.env.PARTS_CHECK_APP_ROOT ?? '.');
const { loadPartsView, partsViewJson } = await import(pathToFileURL(join(appRoot, 'src/parts-view.ts')).href) as typeof import('../src/parts-view.ts');
const { startPartsServer } = await import(pathToFileURL(join(appRoot, 'src/parts-server.ts')).href) as typeof import('../src/parts-server.ts');
const out = resolve(process.env.PARTS_SOURCE_SHOTS ?? 'parts-source-evidence');
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'parts-sources-380-'));
const profile = await mkdtemp(join(tmpdir(), 'parts-sources-profile-'));
const fixture = await readFile(new URL('./fixtures/parts-check-380.json', import.meta.url));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const checks: Array<{ name: string; ok: boolean; actual?: unknown }> = [];
const check = (name: string, ok: boolean, actual?: unknown) => checks.push({ name, ok, actual });
const report: Record<string, unknown> = { fixtureSha256: sha(fixture), checks };
const page = await launchCdpSession(profile);

// Static, concrete expectations. Both custom single-source reports deliberately have the SAME basename.
const cases = [
  { name: 'no-check-cli', sources: ['mesh_report.json'], missing: ['check.json'], en: { back_defect: 'mesh 1', back_control: '', front: '' }, ko: { back_defect: '메시 1', back_control: '', front: '' } },
  { name: 'custom-check-only', sources: ['custom.json'], missing: ['mesh_report.json'], en: { back_defect: 'check 4', back_control: 'check 2', front: 'check 5' }, ko: { back_defect: '체크 4', back_control: '체크 2', front: '체크 5' } },
  { name: 'custom-mesh-only', sources: ['custom.json'], missing: ['check.json'], en: { back_defect: 'mesh 1', back_control: '', front: '' }, ko: null },
  { name: 'both-read-empty', sources: ['mesh_report.json', 'check.json'], missing: [], en: { back_defect: '', back_control: '', front: '' }, ko: null },
] as const;

try {
  await page.setViewport(1440, 1100);
  for (const c of cases) {
    const input = join(root, c.name);
    await writePartsPackage(input);
    await writeFile(join(input, 'check/check.json'), fixture);
    const options: { check?: string; meshReport?: string } = {};
    if (c.name === 'no-check-cli' || c.name === 'custom-mesh-only') await unlink(join(input, 'check/check.json'));
    if (c.name === 'custom-check-only') {
      await unlink(join(input, 'rig/mesh_report.json'));
      options.check = join(input, 'check/custom.json');
      await rename(join(input, 'check/check.json'), options.check);
    }
    if (c.name === 'custom-mesh-only') {
      options.meshReport = join(input, 'rig/custom.json');
      await rename(join(input, 'rig/mesh_report.json'), options.meshReport);
    }
    if (c.name === 'both-read-empty') {
      await writeFile(join(input, 'rig/mesh_report.json'), '[]\n');
      await writeFile(join(input, 'check/check.json'), '{}\n');
    }
    const pkg = await loadPartsView(input, options);
    const view = partsViewJson(pkg, { verdict: null, stale: null });
    const inputs = [...pkg.files, ...pkg.flagFiles];
    const before = await Promise.all(inputs.map(async f => sha(await readFile(f.abs))));
    let cli: ReturnType<typeof Bun.spawn> | undefined;
    let server: Awaited<ReturnType<typeof startPartsServer>> | undefined;
    try {
      let url: URL;
      if (c.name === 'no-check-cli') {
        // The owner's actual form: no --check and no synthetic response substitution.
        const argv = [process.execPath, join(appRoot, 'src/cli.ts'), 'parts', join(input, 'rig'), '--port', '0'];
        check('real CLI argv omits --check', !argv.includes('--check'));
        const child = Bun.spawn(argv, { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' });
        cli = child;
        const reader = child.stdout.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          url = new URL(await Promise.race([
            (async () => {
              let text = '';
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) throw new Error('CLI ended before ready');
                text += new TextDecoder().decode(chunk.value);
                const match = /Parts view ready: (http:\/\/127\.0\.0\.1:\d+\/\#cap=[a-f0-9]+)/.exec(text);
                if (match) return match[1]!;
              }
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CLI startup timeout')), 15000); }),
          ]));
        } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
      } else {
        server = await startPartsServer(pkg, { port: 0 });
        url = new URL(`http://127.0.0.1:${server.port}/`);
      }
      const response = await fetch(new URL('/api/parts', url));
      const served = await response.json() as typeof view;
      check(`${c.name} actual API source contract`, response.ok && JSON.stringify(served.flagSources) === JSON.stringify(c.sources) && JSON.stringify(served.flagMissing) === JSON.stringify(c.missing), { sources: served.flagSources, missing: served.flagMissing });
      const flagsBefore = sha(JSON.stringify(served.flags));
      check(`${c.name} actual flags unchanged`, flagsBefore === sha(JSON.stringify(view.flags)), { flags: served.flags.length, sha256: flagsBefore });
      for (const lang of ['en', 'ko'] as const) {
        const expected = c[lang];
        if (!expected) continue;
        url.searchParams.set('lang', lang);
        await page.goto(url.href);
        // The printed capability has already been consumed by the first page; subsequent navigation uses storage.
        url.hash = '';
        let ready = false;
        for (let i = 0; i < 200; i++) {
          ready = await page.evaluate<boolean>('document.body.dataset.ready === "true"');
          if (ready) break;
          await Bun.sleep(25);
        }
        check(`${c.name} ${lang} ready`, ready);
        const badges = await page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-pv-item]')].map(b=>[b.dataset.pvItem,b.querySelector('.pv-count')?.textContent??'']))`);
        check(`${c.name} ${lang} badges match read sources`, JSON.stringify(badges) === JSON.stringify(expected), badges);
        check(`${c.name} ${lang} no unreported zero counts`, Object.values(badges).every(text => !text.includes('0')), badges);
        if (c.name === 'no-check-cli' || c.name === 'custom-check-only') await writeFile(join(out, `${c.name}-${lang}.png`), await page.screenshot());
      }
      const servedAfter = await (await fetch(new URL('/api/parts', url))).json() as typeof view;
      check(`${c.name} API payload and flag ids unchanged`, JSON.stringify(servedAfter) === JSON.stringify(served));
      const after = await Promise.all(inputs.map(async f => sha(await readFile(f.abs))));
      check(`${c.name} source and report bytes unchanged`, JSON.stringify(before) === JSON.stringify(after));
    } finally {
      server?.stop(true);
      if (cli) { cli.kill('SIGTERM'); await cli.exited; }
    }
  }
} finally {
  await page.close();
  await rm(root, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
report.pass = checks.every(c => c.ok);
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
