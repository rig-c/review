import { useTemporaryReviewState } from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import { afterEach, expect, test } from 'bun:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVerdict, checkFlags, loadPartsAtlas, loadPartsView, meshReportFlags, partsDifference, partsViewJson, readVerdict, saveVerdict, sourceSha256, verdictSource } from '../src/parts-view.ts';
import { preparePartsComment } from '../src/parts-comment-crops.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { FOOTPRINT_ALPHA, frontParts, paintPart } from '../web/parts-render.ts';
import { candidate } from './helpers/parts-comments-package.ts';
import { BACK_CONTROL, BACK_DEFECT, FAINT, FRONT, frontHolds, writePartsPackage } from './helpers/parts-package.ts';

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function planted(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'parts-view-'));
  roots.push(root);
  await writePartsPackage(root);
  return root;
}
const clean = (names: string[]) => Object.fromEntries(names.map(n => [n, { outcome: 'clean' }]));

test('#348: a parts package opens in parts mode, in draw order, with every producer flag on the part it names', async () => {
  const root = await planted(), pkg = await loadPartsView(root);
  expect(pkg.mode).toBe('parts');
  expect(pkg.items.map(i => [i.name, i.index, i.x, i.y, i.w, i.h])).toEqual([BACK_DEFECT, BACK_CONTROL, FRONT].map((p, i) => [p.name, i, p.x, p.y, p.w, p.h]));
  // Bar 2: the planted faint island from mesh_report is listed on its part, as the producer wrote it.
  const faint = pkg.flags.filter(f => f.kind === 'faint');
  expect(faint).toEqual([{ id: 'faint:0', item: 'back_defect', source: 'mesh_report', kind: 'faint', art: FAINT.art, maxAlpha: FAINT.maxAlpha, box: FAINT.box }]);
  expect(pkg.flags.filter(f => f.kind === 'check').map(f => [f.id, f.item]).sort()).toEqual([['check:seam_pairs[0]', 'back_control'], ['check:seam_pairs[0]', 'front']]);
  // The page sees no local path.
  expect(JSON.stringify(partsViewJson(pkg, { verdict: null, stale: null }))).not.toContain(root);
});

test('#348: flag readers keep only parts the view holds, and skip malformed rows rather than repair them', () => {
  const names = new Set(['a']);
  expect(meshReportFlags([{ part: 'a', contour: { bridges: { faint: [{ art: 3, maxAlpha: 9, box: [0, 0, 1, 1] }, { art: 'x' }] } } }, { part: 'b', contour: { bridges: { faint: [{ art: 3, maxAlpha: 9, box: [0, 0, 1, 1] }] } } }], names).map(f => f.id)).toEqual(['faint:0']);
  expect(() => meshReportFlags({}, names)).toThrow('PARTS_FLAGS_MALFORMED');
  // A passing gate, a population figure and a bone that shares the part's name are not flags; a failing gate is.
  // CLEAR, SKIP and REPORTED are rig-parts statuses that report no problem; WARN does.
  const doc = { OK_GATE: { status: 'PASS', parts: ['a'] }, CLEAR_GATE: { status: 'CLEAR', parts: ['a'] }, SKIP_GATE: { status: 'SKIP', parts: ['a'] }, REPORTED_GATE: { status: 'REPORTED', parts: ['a'] }, WARN_GATE: { status: 'WARN', parts: ['a'] }, BAD_GATE: { status: 'FAIL', rows: [{ part: 'a' }, { bone: 'a' }] }, seam_scope: { population: { pairs: [{ parts: ['a'] }] } }, loop_physics: [{ name: 'a_phys', bone: 'a' }], seam_pairs: [{ parts: ['a', 'z'], px_over_40: 3 }] };
  const read = checkFlags(doc, names);
  expect(read.map(f => f.id)).toEqual(['check:WARN_GATE', 'check:BAD_GATE.rows[0]', 'check:seam_pairs[0]']);
  expect(read.map(f => f.kind === 'check' ? [f.root, f.status] : null)).toEqual([['WARN_GATE', 'WARN'], ['BAD_GATE', 'FAIL'], ['seam_pairs', null]]);
});

/** Pixels of a painted part view that are the footprint tint over the bare sentinel: (0, 255, ~128). */
function tintOnSentinel(data: Uint8ClampedArray, w: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < data.length; i += 4) if (data[i] === 0 && data[i + 1] === 255 && Math.abs(data[i + 2]! - 255 * FOOTPRINT_ALPHA) <= 1) out.add(`${(i / 4) % w},${Math.floor(i / 4 / w)}`);
  return out;
}

test('#348 Bar 1: with footprints on, the planted hole and the occluder footprint coincide pixel for pixel; the control part shows no such region', async () => {
  const root = await planted(), pkg = await loadPartsView(root);
  const image = async (name: string) => loadImage(await readFile(join(root, 'rig', 'parts', name + '.png')));
  const view = async (name: string, footprints: boolean) => {
    const item = pkg.items.find(i => i.name === name)!, canvas = createCanvas(item.w, item.h), ctx = canvas.getContext('2d');
    const fronts = footprints ? await Promise.all(frontParts(pkg.items, item).map(async box => ({ box, image: await image(box.name) }))) : [];
    paintPart(ctx as never, item, await image(name) as never, { bg: 'green', alpha: false, fronts: fronts as never, makeCanvas: (w, h) => createCanvas(w, h) as never });
    return { item, tint: tintOnSentinel(ctx.getImageData(0, 0, item.w, item.h).data, item.w), fronts: fronts.map(f => f.box.name) };
  };
  const defect = await view('back_defect', true);
  expect(defect.fronts).toEqual(['front']);
  const hole = new Set<string>();
  for (let y = 0; y < BACK_DEFECT.h; y++) for (let x = 0; x < BACK_DEFECT.w; x++) if (frontHolds(BACK_DEFECT.x + x, BACK_DEFECT.y + y)) hole.add(`${x},${y}`);
  expect(hole.size).toBeGreaterThan(200);
  expect([...defect.tint].sort()).toEqual([...hole].sort());
  // Without the toggle the hole is plain sentinel and no tint is drawn.
  expect((await view('back_defect', false)).tint.size).toBe(0);
  // Control: filled under the same occluder; the footprint lands on art, never on the bare sentinel.
  const control = await view('back_control', true);
  expect(control.fronts).toEqual(['front']);
  expect(control.tint.size).toBe(0);
  // The front part has nothing in front of it.
  expect((await view('front', true)).fronts).toEqual([]);
});

test('#348: source.sha256 is sha256 over "<path>\\t<sha256>\\n" lines sorted by path bytewise (pinned)', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  expect(sourceSha256([{ path: 'parts/a.png', sha256: b }, { path: 'parts.json', sha256: a }])).toBe('a09d7097efe0d87e9043b441fa9e9312fac7c7249e250f1b77be9275ec41571f');
  // Bytewise, not locale order: "B" (0x42) sorts before "a" (0x61).
  expect(sourceSha256([{ path: 'a', sha256: a }, { path: 'B', sha256: b }])).toBe(sourceSha256([{ path: 'B', sha256: b }, { path: 'a', sha256: a }]));
});

test('#348: the verdict records parts.json and every PNG relative to the verdict file, and the writer refuses by name', async () => {
  const root = await planted(), elsewhere = await mkdtemp(join(tmpdir(), 'parts-verdict-'));
  roots.push(elsewhere);
  const pkg = await loadPartsView(root, { verdict: join(elsewhere, 'v.json') });
  const source = verdictSource(pkg), base = root.split('/').pop()!;
  expect(source.files.map(f => f.path)).toEqual([`../${base}/rig/parts.json`, `../${base}/rig/parts/back_defect.png`, `../${base}/rig/parts/back_control.png`, `../${base}/rig/parts/front.png`]);
  expect(source.flags.map(f => f.path)).toEqual([`../${base}/rig/mesh_report.json`, `../${base}/check/check.json`]);
  expect(source.sha256).toBe(sourceSha256(source.files));
  const raw = candidate(pkg);
  raw.rigRegion = { x: pkg.items[0]!.x + raw.imageRegion!.x, y: pkg.items[0]!.y + raw.imageRegion!.y, width: raw.imageRegion!.width, height: raw.imageRegion!.height };
  const issue = await preparePartsComment(pkg, raw);
  expect(() => buildVerdict(pkg, { status: 'approved', issues: [issue] }, '0')).toThrow('PARTS_VERDICT_NOT_CLEAN');
  expect(() => buildVerdict(pkg, { status: 'changes-requested', issues: [] }, '0')).toThrow('PARTS_VERDICT_NOTHING_FLAGGED');
  expect(() => buildVerdict(pkg, { status: 'pending' as never, issues: [] }, '0')).toThrow('PARTS_VERDICT_INVALID');
  expect(() => buildVerdict(pkg, { status: 'changes-requested', issues: [{ ...issue, parts: [{ name: 'ghost', imageHash: issue.parts[0]!.imageHash }] }] }, '0')).toThrow('PARTS_COMMENT_PART_MISMATCH');
  const ok = buildVerdict(pkg, { status: 'approved', issues: [] }, '9.9.9');
  expect(ok.issues).toEqual([]);
  expect(ok.schema).toBe('rig-review-parts-verdict/4');
  expect(ok.mode).toBe('parts');
});

test('#348: the sign-off is saved beside parts.json, reloads while the files hold, and is not offered once a part changes', async () => {
  const root = await planted(), pkg = await loadPartsView(root);
  // A build root opens on its rig/ (assemble's output); the sign-off lands beside parts.json there.
  expect(pkg.verdictPath).toBe(join(await realpath(root), 'rig', 'parts-review.json'));
  expect((await loadPartsView(join(root, 'rig'))).verdictPath).toBe(pkg.verdictPath);
  const raw = candidate(pkg);
  raw.rigRegion = { x: pkg.items[0]!.x + raw.imageRegion!.x, y: pkg.items[0]!.y + raw.imageRegion!.y, width: raw.imageRegion!.width, height: raw.imageRegion!.height };
  const issue = await preparePartsComment(pkg, raw);
  const saved = await saveVerdict(pkg, { status: 'changes-requested', issues: [issue] });
  const disk = JSON.parse(await readFile(join(root, 'rig', 'parts-review.json'), 'utf8'));
  expect(disk).toEqual(JSON.parse(JSON.stringify(saved)));
  expect(disk.source.files[0]).toMatchObject({ path: 'parts.json' });
  expect((await readVerdict(await loadPartsView(root))).verdict?.status).toBe('changes-requested');
  await writeFile(join(root, 'rig', 'parts', 'front.png'), Buffer.from('changed'));
  await expect(saveVerdict(pkg, { status: 'approved', issues: [] })).rejects.toThrow('PARTS_VIEW_SOURCE_CHANGED');
});

test('#348 atlas bar: atlas mode on the public example shows every region named in the atlas file, with its box', async () => {
  const pkg = await loadPartsView('examples/demo');
  const model = JSON.parse(await readFile('examples/demo/skeleton.model.json', 'utf8')) as { pages: { name: string; regions: { name: string; x: number; y: number; width: number; height: number }[] }[] };
  expect(pkg.mode).toBe('atlas');
  expect(pkg.items.map(i => [i.page, i.name, i.x, i.y, i.w, i.h])).toEqual(model.pages.flatMap(p => p.regions.map(r => [p.name, r.name, r.x, r.y, r.width, r.height])));
  expect(pkg.pages.map(p => p.name)).toEqual(model.pages.map(p => p.name));
  expect(pkg.verdictPath.endsWith('examples/demo/parts-review.json')).toBe(true);
});

test('#348: the server serves the view, gates the sign-off on the capability, and saves it', async () => {
  const root = await planted(), pkg = await loadPartsView(root), capability = 'c'.repeat(64);
  const server = await startPartsServer(pkg, { port: 0, capability });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const view = await (await fetch(origin + '/api/parts')).json() as { mode: string; items: unknown[]; flags: unknown[] };
    expect([view.mode, view.items.length, view.flags.length]).toEqual(['parts', 3, 3]);
    expect((await fetch(origin + '/api/parts/image/2')).headers.get('content-type')).toContain('image/png');
    expect((await fetch(origin + '/api/parts/image/9')).status).toBe(404);
    expect((await fetch(origin + '/')).status).toBe(200);
    expect((await fetch(origin + '/parts.js')).status).toBe(200);
    const styles=await fetch(origin+'/styles.css');expect(styles.status).toBe(200);expect(styles.headers.get('content-type')).toBe('text/css');
    expect(await styles.text()).toBe(await readFile('web/styles.css','utf8'));
    const stylesHead=await fetch(origin+'/styles.css',{method:'HEAD'});expect(stylesHead.status).toBe(200);expect(stylesHead.headers.get('content-type')).toBe('text/css');expect(await stylesHead.text()).toBe('');
    const body = JSON.stringify({ status: 'approved', issues: [] });
    expect((await fetch(origin + '/api/parts/verdict', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body })).status).toBe(403);
    const saved = await fetch(origin + '/api/parts/verdict', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': capability }, body });
    expect(saved.status).toBe(200);
    expect(JSON.parse(await readFile(join(root, 'rig', 'parts-review.json'), 'utf8')).status).toBe('approved');
  } finally { server.stop(true); }
});

test('#348: known producer readings remain in en and ko headlines alongside the exact row path', async () => {
  const { flagLabel } = await import('../web/parts-flags.ts'), { t } = await import('../web/i18n.ts');
  const en = (k: string, p?: Readonly<Record<string, string | number>>) => t(k, p, 'en'), ko = (k: string, p?: Readonly<Record<string, string | number>>) => t(k, p, 'ko');
  // The opening the public demo's check.json reports, as written there.
  const opening = { kind: 'check' as const, item: 'hair_back', path: 'figure_openings.openings[0]', root: 'figure_openings', status: null, entry: { pair: 'hair_back|handwear_r', under: 'hair_back', above: 'handwear_r', animation: 'hop', frame: 5, time: 0.417, opens: [5, 6], cell: 2.517, found_cells: 40, allowed_cells: 28 } };
  expect(flagLabel(opening, en)).toContain('hair_back opens under handwear_r · hop f5 (0.417 s) · 40 cells found / 28 allowed');
  expect(flagLabel(opening, ko)).toContain('hair_back이(가) handwear_r 아래에서 벌어짐 · hop f5 (0.417초) · 셀 40개 발견 / 허용 28개');
  const seam = { kind: 'check' as const, item: 'front', path: 'seam_pairs[0]', root: 'seam_pairs', status: null, entry: { parts: ['front', 'back_control'], px_over_40: 3, px_over_80: 1, rig_box: [30, 14, 6, 4] } };
  expect(flagLabel(seam, en)).toContain('Seam front | back_control · 3 px over 40 · 1 px over 80 · rig box 30,14 6×4');
  expect(flagLabel(seam, ko)).toContain('이음매 front | back_control · 40 초과 3 px · 80 초과 1 px · 리그 상자 30,14 6×4');
  const gate = { kind: 'check' as const, item: 'handwear_l', path: 'TIP_OVER_ROOT.parts[0]', root: 'TIP_OVER_ROOT', status: 'FAIL', entry: { part: 'handwear_l', root_rig_px: 1.478, tip_rig_px: 7.034, ratio: 4.761 } };
  expect(flagLabel(gate, en)).toContain('Block TIP_OVER_ROOT: FAIL · handwear_l · root_rig_px 1.478 · tip_rig_px 7.034 · ratio 4.761');
  expect(flagLabel(gate, ko)).toContain('블록 TIP_OVER_ROOT: FAIL · handwear_l · root_rig_px 1.478 · tip_rig_px 7.034 · ratio 4.761');
  expect(flagLabel({ ...opening, entry: { under: 'hair_back' } }, en)).toContain('Check line figure_openings.openings[0]');
  expect(flagLabel({ kind: 'faint', item: 'a', art: 12, maxAlpha: 15, box: [2, 2, 4, 3] }, en)).toBe('Faint island left out of the mesh: 12 px, brightest alpha 15, at 2,2 4×3 (part-image px).');
});

test('#348 P1: a part image or a discovered producer file that symlinks outside the package is refused by name, never hashed or served', async () => {
  const root = await planted(), outside = await mkdtemp(join(tmpdir(), 'parts-outside-'));
  roots.push(outside);
  await writeFile(join(outside, 'secret.png'), 'not part of the package');
  // Control: the package as written loads.
  expect((await loadPartsView(root)).items.length).toBe(3);
  await unlink(join(root, 'rig', 'parts', 'front.png'));
  await symlink(join(outside, 'secret.png'), join(root, 'rig', 'parts', 'front.png'));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_IMAGE_OUTSIDE');
  // The same for a discovered check.json; a link that stays inside the package is fine.
  const second = await planted();
  await unlink(join(second, 'check', 'check.json'));
  await symlink(join(outside, 'secret.png'), join(second, 'check', 'check.json'));
  await expect(loadPartsView(second)).rejects.toThrow('PARTS_FLAGS_OUTSIDE');
  const third = await planted();
  await unlink(join(third, 'rig', 'parts', 'front.png'));
  await writeFile(join(third, 'rig', 'front-real.png'), 'a file inside the package');
  await symlink(join(third, 'rig', 'front-real.png'), join(third, 'rig', 'parts', 'front.png'));
  const inside = await loadPartsView(third);
  expect(inside.imagePaths[2]).toBe(join(await realpath(third), 'rig', 'front-real.png'));
});

test('#348 P1: a saved sign-off is not restored when only the producer flags changed, and the page is told why', async () => {
  const root = await planted();
  await saveVerdict(await loadPartsView(root), { status: 'approved', issues: [] });
  const same = await loadPartsView(root);
  expect(await readVerdict(same)).toMatchObject({ stale: null, verdict: { status: 'approved' } });
  // Only check.json changes: the part files, and so source.sha256 (what create gates on), are the same.
  await writeFile(join(root, 'check', 'check.json'), JSON.stringify({ seam_pairs: [{ parts: ['front', 'back_defect'], px_over_40: 9, px_over_80: 2 }] }) + '\n');
  const changed = await loadPartsView(root);
  expect(verdictSource(changed).sha256).toBe(verdictSource(same).sha256);
  const read = await readVerdict(changed);
  expect(read).toEqual({ verdict: null, stale: 'flags' });
  expect(partsViewJson(changed, read)).toMatchObject({ verdict: null, verdictStale: 'flags' });
  // A part file change reads as other files.
  await writeFile(join(root, 'rig', 'parts', 'front.png'), Buffer.from('changed'));
  expect((await readVerdict(await loadPartsView(root))).stale).toBe('files');
});

async function runPartsSwapProbe(
  label: string,
  root: string,
  targetPath: string,
  bytesA: Buffer,
  bytesB: Buffer,
  mode: 'parts' | 'atlas' = 'parts',
) {
  const timeoutMs = 4000;
  const hashA = new Bun.CryptoHasher('sha256').update(bytesA).digest('hex');
  const sourcePath = new URL('../src/parts-view.ts', import.meta.url).pathname;
  const manifestPath = new URL('../src/manifest.ts', import.meta.url).pathname;
  console.log(`FIXTURE_MUTATION_BEGIN ${label} ${targetPath} sha256=${hashA}`);
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stdoutPromise: Promise<string> | null = null;
  let stderrPromise: Promise<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs/promises';
      const originalRead = fs.readFile, originalWrite = fs.writeFile;
      const path = ${JSON.stringify(targetPath)}, replacement = Buffer.from(${JSON.stringify(bytesB.toString('base64'))}, 'base64');
      let armed = ${mode === 'parts'}, swapped = false, reads = 0;
      mock.module('node:fs/promises', () => ({ ...fs, readFile: async (file, ...args) => {
        const data = await originalRead(file, ...args);
        if (armed && String(file) === path) {
          reads++;
          if (!swapped) {
            swapped = true;
            await originalWrite(path, replacement);
          }
        }
        return data;
      }}));
      const { loadReview } = await import(${JSON.stringify(manifestPath)});
      const { loadPartsAtlas, loadPartsView, saveVerdict } = await import(${JSON.stringify(sourcePath)});
      const pkg = ${mode === 'atlas'} ? (await (async () => { const rev = await loadReview(${JSON.stringify(root)}); armed = true; return loadPartsAtlas(rev); })()) : await loadPartsView(${JSON.stringify(root)});
      const loadReads = reads;
      const entry = pkg.files.find(f => f.abs === path) ?? pkg.flagFiles.find(f => f.abs === path);
      const faint = pkg.flags.find(f => f.kind === 'faint');
      const checkFlag = pkg.flags.find(f => f.kind === 'check');
      const checkReading = pkg.readings?.find(f => f.kind === 'check');
      let refused = false;
      try { await saveVerdict(pkg, { status: 'approved', issues: [] }); }
      catch (e) { if (!String(e).includes('PARTS_VIEW_SOURCE_CHANGED')) throw e; refused = true; }
      console.log(JSON.stringify({
        swapped, reads: loadReads,
        rigWidth: pkg.rigSize?.[0] ?? null,
        regionX: pkg.items[0]?.x ?? null,
        faintArt: faint?.kind === 'faint' ? faint.art : null,
        flagPxOver40: checkFlag?.kind === 'check' ? checkFlag.entry.px_over_40 : null,
        readingPxOver40: checkReading?.kind === 'check' ? checkReading.entry.px_over_40 : null,
        hash: entry?.sha256 ?? null,
        bytes: entry?.bytes ?? null,
        refused,
      }));
    `;
    const spawned = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    child = spawned;
    timer = setTimeout(() => {
      timedOut = true;
      spawned.kill('SIGKILL');
    }, timeoutMs);
    stdoutPromise = new Response(spawned.stdout).text();
    stderrPromise = new Response(spawned.stderr).text();
    const [stdout, stderr, exit] = await Promise.all([stdoutPromise, stderrPromise, spawned.exited]);
    if (timedOut) throw new Error(`SWAP_PROBE_TIMEOUT: ${label} exceeded ${timeoutMs}ms`);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    return { hashA, out: JSON.parse(stdout.trim()) };
  } finally {
    if (timer) clearTimeout(timer);
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled([stdoutPromise, stderrPromise, child.exited]);
    }
    const childExited = child !== null && (child.exitCode !== null || child.signalCode !== null);
    await writeFile(targetPath, bytesA);
    const restoredHash = new Bun.CryptoHasher('sha256').update(await readFile(targetPath)).digest('hex');
    console.log(`FIXTURE_RESTORED ${label} ${targetPath} childExited=${childExited} sha256=${restoredHash}`);
    expect(childExited).toBe(true);
    expect(restoredHash).toBe(hashA);
  }
}

test('#546: parts.json parse and recorded hash bind to one buffer, and replaced B is refused at sign-off', async () => {
  const root = await planted(), partsPath = join(await realpath(root), 'rig', 'parts.json');
  const bytesA = await readFile(partsPath);
  const docB = JSON.parse(bytesA.toString('utf8')); docB.rig_size = [96, 64];
  const bytesB = Buffer.from(JSON.stringify(docB));
  const { hashA, out } = await runPartsSwapProbe('parts.json', root, partsPath, bytesA, bytesB);
  expect({ swapped: out.swapped, reads: out.reads, rigWidth: out.rigWidth, hash: out.hash, bytes: out.bytes, refused: out.refused }).toEqual({
    swapped: true, reads: 1, rigWidth: 64, hash: hashA, bytes: bytesA.length, refused: true,
  });
});

test('#546: mesh_report.json recorded hash and faint flags bind to one buffer', async () => {
  const root = await planted(), meshReportPath = join(await realpath(root), 'rig', 'mesh_report.json');
  const bytesA = await readFile(meshReportPath);
  const docB = JSON.parse(bytesA.toString('utf8')); docB[0].contour.bridges.faint[0].art = 99;
  const bytesB = Buffer.from(JSON.stringify(docB) + '\n');
  const { hashA, out } = await runPartsSwapProbe('mesh_report.json', root, meshReportPath, bytesA, bytesB);
  expect({ swapped: out.swapped, reads: out.reads, faintArt: out.faintArt, hash: out.hash, bytes: out.bytes, refused: out.refused }).toEqual({
    swapped: true, reads: 1, faintArt: FAINT.art, hash: hashA, bytes: bytesA.length, refused: true,
  });
});

test('#546: check.json recorded hash, flags and readings bind to one buffer', async () => {
  const root = await planted(), checkPath = join(await realpath(root), 'check', 'check.json');
  const bytesA = await readFile(checkPath);
  const docB = JSON.parse(bytesA.toString('utf8')); docB.seam_pairs[0].px_over_40 = 77;
  const bytesB = Buffer.from(JSON.stringify(docB) + '\n');
  const { hashA, out } = await runPartsSwapProbe('check.json', root, checkPath, bytesA, bytesB);
  expect({ swapped: out.swapped, reads: out.reads, flagPxOver40: out.flagPxOver40, readingPxOver40: out.readingPxOver40, hash: out.hash, bytes: out.bytes, refused: out.refused }).toEqual({
    swapped: true, reads: 1, flagPxOver40: 3, readingPxOver40: 3, hash: hashA, bytes: bytesA.length, refused: true,
  });
});

test('#546: loadPartsAtlas binds model regions and recorded hash to one buffer after loadReview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parts-atlas-'));
  roots.push(root);
  await writeFile(join(root, 'skeleton.model.json'), await readFile('examples/demo/skeleton.model.json'));
  await writeFile(join(root, 'lantern.png'), await readFile('examples/demo/lantern.png'));
  const modelPath = join(await realpath(root), 'skeleton.model.json');
  const bytesA = await readFile(modelPath);
  const docB = JSON.parse(bytesA.toString('utf8')); docB.pages[0].regions[0].x = 7;
  const bytesB = Buffer.from(JSON.stringify(docB));
  const { hashA, out } = await runPartsSwapProbe('skeleton.model.json', root, modelPath, bytesA, bytesB, 'atlas');
  expect({ swapped: out.swapped, reads: out.reads, regionX: out.regionX, hash: out.hash, bytes: out.bytes, refused: out.refused }).toEqual({
    swapped: true, reads: 1, regionX: 0, hash: hashA, bytes: bytesA.length, refused: true,
  });
});

test('#546: error mapping, explicit external flag paths and acquisition order parity', async () => {
  const root = await planted(), ext = await mkdtemp(join(tmpdir(), 'parts-ext-'));
  roots.push(ext);
  await writeFile(join(ext, 'mesh.json'), await readFile(join(root, 'rig', 'mesh_report.json')));
  await writeFile(join(ext, 'check.json'), await readFile(join(root, 'check', 'check.json')));
  const explicit = await loadPartsView(root, { meshReport: join(ext, 'mesh.json'), check: join(ext, 'check.json') });
  expect(explicit.flagFiles.map(f => f.abs)).toEqual([join(await realpath(ext), 'mesh.json'), join(await realpath(ext), 'check.json')]);
  // Producer flag raw read errors escape outside parseJson. Malformed JSON maps to PARTS_FLAGS_MALFORMED.
  await expect(loadPartsView(root, { meshReport: ext })).rejects.not.toThrow('PARTS_FLAGS_MALFORMED');
  await writeFile(join(root, 'rig', 'mesh_report.json'), '{');
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_FLAGS_MALFORMED: mesh_report.json:');
  const second = await planted();
  await writeFile(join(second, 'check', 'check.json'), '{');
  await expect(loadPartsView(second)).rejects.toThrow('PARTS_FLAGS_MALFORMED: check.json:');
  await writeFile(join(second, 'rig', 'parts.json'), '{}');
  await expect(loadPartsView(second)).rejects.toThrow('PARTS_JSON_MALFORMED: parts.json has no parts[] array');
  await writeFile(join(second, 'rig', 'parts.json'), '{');
  await expect(loadPartsView(second)).rejects.toThrow('PARTS_FLAGS_MALFORMED: parts.json:');
  // loadPartsAtlas escapes raw JSON parse errors and rejects missing pages with PARTS_VIEW_NO_ATLAS.
  const atlas = await mkdtemp(join(tmpdir(), 'parts-atlas-err-'));
  roots.push(atlas);
  await writeFile(join(atlas, 'skeleton.model.json'), await readFile('examples/demo/skeleton.model.json'));
  await writeFile(join(atlas, 'lantern.png'), await readFile('examples/demo/lantern.png'));
  const { loadReview } = await import('../src/manifest.ts');
  const rev = await loadReview(atlas);
  await writeFile(join(atlas, 'skeleton.model.json'), '{}');
  await expect(loadPartsAtlas(rev)).rejects.toThrow('PARTS_VIEW_NO_ATLAS');
  await writeFile(join(atlas, 'skeleton.model.json'), '{');
  await expect(loadPartsAtlas(rev)).rejects.toThrow(SyntaxError);
});

test('#623: standalone loadPartsView defaults painting containment to parts root, while explicit paintingRoot contains painting inside snapshot root and keeps size and Difference checks unchanged', async () => {
  const root = await planted(), ext = await mkdtemp(join(tmpdir(), 'parts-painting-ext-'));
  roots.push(ext);
  const realRoot = await realpath(root);
  const paintingCanvas = createCanvas(64, 64), pCtx = paintingCanvas.getContext('2d');
  pCtx.fillStyle = '#204060'; pCtx.fillRect(0, 0, 64, 64);
  const paintingBytes = paintingCanvas.toBuffer('image/png');
  const paintingHash = new Bun.CryptoHasher('sha256').update(paintingBytes).digest('hex');
  const paintingPath = join(realRoot, 'painting.png');
  await writeFile(paintingPath, paintingBytes);

  // Standalone defaults to parts root (<root>/rig), refusing a sibling painting outside <root>/rig.
  await expect(loadPartsView(realRoot, { painting: paintingPath })).rejects.toThrow('PARTS_PAINTING_OUTSIDE: painting resolves outside rig/');

  // Explicit paintingRoot accepts the painting inside realRoot while outside <root>/rig, and hashes it into pkg.files.
  const pkg = await loadPartsView(realRoot, { painting: paintingPath, paintingRoot: realRoot });
  const expectedPainting = { abs: paintingPath, bytes: paintingBytes.length, sha256: paintingHash, width: 64, height: 64 };
  expect(pkg.painting).toEqual(expectedPainting);
  expect(pkg.files).toContainEqual({ abs: paintingPath, bytes: paintingBytes.length, sha256: paintingHash });

  // Difference-unavailable stays unchanged when painting_in_rig is absent.
  expect(pkg.paintingInRig).toBeUndefined();
  const view = partsViewJson(pkg, { verdict: null, stale: null });
  expect(view.painting).toEqual({ sha256: paintingHash, width: 64, height: 64 });
  expect(view.differenceAvailable).toBe(false);
  const baseIssue = candidate(pkg);
  const overlayIssue = await preparePartsComment(pkg, {
    ...baseIssue,
    rigRegion: { x: 2, y: 11, width: 8, height: 9 },
    imageRegion: null,
    view: { ...baseIssue.view, mode: 'assembled', comparison: { mode: 'overlay', opacity: 0.5 } },
  });
  expect(overlayIssue.view.comparison).toEqual({ mode: 'overlay', opacity: 0.5 });
  await expect(preparePartsComment(pkg, {
    ...baseIssue,
    rigRegion: { x: 2, y: 11, width: 8, height: 9 },
    imageRegion: null,
    view: { ...baseIssue.view, mode: 'assembled', comparison: { mode: 'difference', opacity: 0.5, threshold: 8 } },
  })).rejects.toThrow('PARTS_DIFFERENCE_UNAVAILABLE');

  // Escape outside paintingRoot (direct or symlink) is still refused by insideRoot.
  const outsidePainting = join(await realpath(ext), 'outside.png');
  await writeFile(outsidePainting, paintingBytes);
  await expect(loadPartsView(realRoot, { painting: outsidePainting, paintingRoot: realRoot })).rejects.toThrow('PARTS_PAINTING_OUTSIDE:');
  const linkPainting = join(realRoot, 'escape-painting.png');
  await symlink(outsidePainting, linkPainting);
  await expect(loadPartsView(realRoot, { painting: linkPainting, paintingRoot: realRoot })).rejects.toThrow('PARTS_PAINTING_OUTSIDE:');

  // assertOriginalPaintingSize remains enforced under paintingRoot.
  const wrongSizePath = join(realRoot, 'wrong-size.png');
  await writeFile(wrongSizePath, createCanvas(32, 32).toBuffer('image/png'));
  await expect(loadPartsView(realRoot, { painting: wrongSizePath, paintingRoot: realRoot })).rejects.toThrow('PARTS_PAINTING_SIZE:');
});

test('#626: loadPartsView with nested rig.json containing mixed inline and generator meshes preserves original painting, source hashes, inline mesh overlay, and Difference boundary', async () => {
  const root = await planted();
  const realRoot = await realpath(root);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(realRoot, 'rig/images'), { recursive: true });
  await writeFile(join(realRoot, 'rig/images/back_defect.png'), await readFile(join(realRoot, 'rig/parts/back_defect.png')));
  const rigDoc = {
    images: 'images',
    skins: {
      default: {
        back_defect: {
          back_defect: {
            type: 'mesh',
            image: 'back_defect.png',
            width: BACK_DEFECT.w,
            height: BACK_DEFECT.h,
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            triangles: [0, 1, 2, 0, 2, 3],
          },
        },
        front: {
          front: {
            type: 'mesh',
            image: 'front.png',
            width: FRONT.w,
            height: FRONT.h,
            generator: { kind: 'grid', cols: 13, rows: 16, depth: { image: 'front_depth.png', near: 'white', zScale: 120 } },
          },
        },
      },
    },
  };
  await writeFile(join(realRoot, 'rig/rig.json'), JSON.stringify(rigDoc, null, 2) + '\n');

  const paintingCanvas = createCanvas(64, 64), pCtx = paintingCanvas.getContext('2d');
  pCtx.fillStyle = '#204060'; pCtx.fillRect(0, 0, 64, 64);
  const paintingBytes = paintingCanvas.toBuffer('image/png');
  const paintingHash = new Bun.CryptoHasher('sha256').update(paintingBytes).digest('hex');
  const paintingPath = join(realRoot, 'painting.png');
  await writeFile(paintingPath, paintingBytes);

  const pkg = await loadPartsView(realRoot, {
    rig: join(realRoot, 'rig/rig.json'),
    meshReport: join(realRoot, 'rig/mesh_report.json'),
    painting: paintingPath,
    paintingRoot: realRoot,
  });

  const expectedPainting = { abs: paintingPath, bytes: paintingBytes.length, sha256: paintingHash, width: 64, height: 64 };
  expect(pkg.painting).toEqual(expectedPainting);
  expect(pkg.paintingInRig).toBeUndefined();
  expect(pkg.items.map(i => ({ name: i.name, hasMesh: Boolean(i.mesh), meshUnavailable: i.meshUnavailable }))).toEqual([
    { name: 'back_defect', hasMesh: true, meshUnavailable: undefined },
    { name: 'back_control', hasMesh: false, meshUnavailable: undefined },
    { name: 'front', hasMesh: false, meshUnavailable: 'PARTS_MESH_GENERATED' },
  ]);
  const view = partsViewJson(pkg, { verdict: null, stale: null });
  expect(view.painting).toEqual({ sha256: paintingHash, width: 64, height: 64 });
  expect(view.differenceAvailable).toBe(false);
  expect(view.items.find(i => i.name === 'front')?.meshUnavailable).toBe('PARTS_MESH_GENERATED');
  await expect(partsDifference(pkg, 2, 0, false)).rejects.toThrow('PARTS_DIFFERENCE_UNAVAILABLE');
});
