import { afterEach, expect, test } from 'bun:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  expect(JSON.stringify(partsViewJson(pkg, { verdict: null, stale: false }))).not.toContain(root);
});

test('#348: flag readers keep only parts the view holds, and skip malformed rows rather than repair them', () => {
  const names = new Set(['a']);
  expect(meshReportFlags([{ part: 'a', contour: { bridges: { faint: [{ art: 3, maxAlpha: 9, box: [0, 0, 1, 1] }, { art: 'x' }] } } }, { part: 'b', contour: { bridges: { faint: [{ art: 3, maxAlpha: 9, box: [0, 0, 1, 1] }] } } }], names).map(f => f.id)).toEqual(['faint:0']);
  expect(() => meshReportFlags({}, names)).toThrow('PARTS_FLAGS_MALFORMED');
  // A passing gate, a population figure and a bone that shares the part's name are not flags; a failing gate is.
  const doc = { OK_GATE: { status: 'PASS', parts: ['a'] }, BAD_GATE: { status: 'FAIL', rows: [{ part: 'a' }, { bone: 'a' }] }, seam_scope: { population: { pairs: [{ parts: ['a'] }] } }, loop_physics: [{ name: 'a_phys', bone: 'a' }], seam_pairs: [{ a: 'a', b: 'z' }] };
  expect(checkFlags(doc, names).map(f => f.id)).toEqual(['check:BAD_GATE.rows[0]', 'check:seam_pairs[0]']);
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
  expect(ok.schema).toBe('rig-review-parts-verdict/1');
  expect(ok.mode).toBe('parts');
});

test('#348: the sign-off is saved beside parts.json, reloads while the files hold, and is not offered once a part changes', async () => {
  const root = await planted(), pkg = await loadPartsView(root), names = ['back_defect', 'back_control', 'front'];
  // A build root opens on its rig/ (assemble's output); the sign-off lands beside parts.json there.
  expect(pkg.verdictPath).toBe(join(root, 'rig', 'parts-review.json'));
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
