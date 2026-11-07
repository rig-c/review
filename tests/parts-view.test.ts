import { afterEach, expect, test } from 'bun:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVerdict, checkFlags, loadPartsView, meshReportFlags, partsViewJson, readVerdict, saveVerdict, sourceSha256, verdictSource } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { FOOTPRINT_ALPHA, frontParts, paintPart } from '../web/parts-render.ts';
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
  const names = ['back_defect', 'back_control', 'front'];
  expect(() => buildVerdict(pkg, { status: 'approved', parts: { ...clean(names), back_defect: { outcome: 'flagged', note: 'hole under front' } } }, '0')).toThrow('PARTS_VERDICT_NOT_CLEAN');
  expect(() => buildVerdict(pkg, { status: 'changes-requested', parts: { ...clean(names), back_defect: { outcome: 'flagged' } } }, '0')).toThrow('PARTS_VERDICT_NOTE_REQUIRED');
  expect(() => buildVerdict(pkg, { status: 'changes-requested', parts: clean(names) }, '0')).toThrow('PARTS_VERDICT_NOTHING_FLAGGED');
  expect(() => buildVerdict(pkg, { status: 'pending', parts: { back_defect: { outcome: 'clean' } } }, '0')).toThrow('PARTS_VERDICT_MISSING_PART');
  expect(() => buildVerdict(pkg, { status: 'pending', parts: { ...clean(names), ghost: { outcome: 'clean' } } }, '0')).toThrow('PARTS_VERDICT_UNKNOWN_PART');
  // A note is optional on clean, and kept.
  const ok = buildVerdict(pkg, { status: 'approved', parts: { ...clean(names), front: { outcome: 'clean', note: 'edge checked at 4x' } } }, '9.9.9');
  expect(ok.parts.front).toEqual({ outcome: 'clean', note: 'edge checked at 4x', flags: ['check:seam_pairs[0]'] });
  expect(ok.parts.back_defect!.flags).toEqual(['faint:0']);
  expect(ok.schema).toBe('rig-review-parts-verdict/2');
  expect(ok.mode).toBe('parts');
});

test('#348: the sign-off is saved beside parts.json, reloads while the files hold, and is not offered once a part changes', async () => {
  const root = await planted(), pkg = await loadPartsView(root), names = ['back_defect', 'back_control', 'front'];
  // A build root opens on its rig/ (assemble's output); the sign-off lands beside parts.json there.
  expect(pkg.verdictPath).toBe(join(await realpath(root), 'rig', 'parts-review.json'));
  expect((await loadPartsView(join(root, 'rig'))).verdictPath).toBe(pkg.verdictPath);
  const saved = await saveVerdict(pkg, { status: 'changes-requested', parts: { ...clean(names), back_defect: { outcome: 'flagged', note: 'no material under front' } } });
  const disk = JSON.parse(await readFile(join(root, 'rig', 'parts-review.json'), 'utf8'));
  expect(disk).toEqual(JSON.parse(JSON.stringify(saved)));
  expect(disk.source.files[0]).toMatchObject({ path: 'parts.json' });
  expect((await readVerdict(await loadPartsView(root))).verdict?.status).toBe('changes-requested');
  await writeFile(join(root, 'rig', 'parts', 'front.png'), Buffer.from('changed'));
  await expect(saveVerdict(pkg, { status: 'pending', parts: clean(names) })).rejects.toThrow('PARTS_VIEW_SOURCE_CHANGED');
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
    const body = JSON.stringify({ status: 'approved', parts: clean(['back_defect', 'back_control', 'front']) });
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
  const root = await planted(), names = ['back_defect', 'back_control', 'front'];
  await saveVerdict(await loadPartsView(root), { status: 'approved', parts: clean(names) });
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
