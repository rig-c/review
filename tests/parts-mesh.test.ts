import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, unlink, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadPartsView, readPartMeshes, buildVerdict, verdictSource, saveVerdict, readVerdict, readPartsVerdictForCli, assertPartsUnchanged } from '../src/parts-view.ts';
import { meshCoverage, paintMesh } from '../web/parts-render.ts';
import { writeMeshPackage } from './helpers/parts-mesh-package.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'parts-mesh-')); roots.push(root); await writeMeshPackage(root); return root; }
test('UV-derived lattice union equals independent rectangular oracle, including all 256 gap pixels', async () => {
  const root = await fixture(), pkg = await loadPartsView(root);
  for (const item of pkg.items) {
    const mask = meshCoverage(64, 64, item.mesh!);
    let gap = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const missing = item.name === 'gap' && x >= 16 && x < 32 && y >= 16 && y < 32;
      expect(mask[y * 64 + x]).toBe(missing ? 0 : 1); if (missing) gap++;
    }
    expect(gap).toBe(item.name === 'gap' ? 256 : 0);
    const report = JSON.parse(await readFile(join(root, 'mesh_report.json'), 'utf8')).find((r: { part: string }) => r.part === item.name);
    const { part: _part, ...figures } = report;
    expect(item.mesh!.figures).toEqual(figures);
  }
});
test('coverage tint uses art alpha and the exact mask before diagnostic edges', async () => {
  const root = await fixture(), pkg = await loadPartsView(root), item = pkg.items[0]!;
  const image = await loadImage(join(root, 'parts/gap.png')), canvas = createCanvas(64, 64), ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  // Suppress only geometry strokes so every tint pixel is observable, including the triangle boundary.
  const proxy = new Proxy(ctx, { get(target, key) { if (['stroke', 'fill'].includes(String(key))) return () => {}; const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v; }, set(target, key, value) { return Reflect.set(target, key, value); } });
  paintMesh(proxy as never, image as never, 64, 64, item.mesh!, (w, h) => createCanvas(w, h) as never);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  let tinted = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const changed = data[(y * 64 + x) * 4] !== 136; expect(changed).toBe(x >= 16 && x < 32 && y >= 16 && y < 32); if (changed) tinted++; }
  expect(tinted).toBe(256);
});
test('named planted malformed inputs reject unknown part, invalid UV, triangle, size and ambiguous mesh', () => {
  const item = () => [{ name: 'a', index: 0, x: 0, y: 0, w: 10, h: 10 }];
  const mesh = { type: 'mesh', image: 'a.png', width: 10, height: 10, uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2] };
  const doc = (a: unknown, name = 'a') => ({ skins: { default: { [name]: { [name]: a } } } });
  expect(() => readPartMeshes(doc(mesh, 'unknown'), item(), [])).toThrow('PARTS_MESH_UNKNOWN_PART');
  for (const value of [-.01, 1.01, NaN, Infinity, '0']) expect(() => readPartMeshes(doc({ ...mesh, uvs: [value, 0] }), item(), [])).toThrow('PARTS_MESH_UV');
  for (const value of [-1, 3, 1.5, NaN]) expect(() => readPartMeshes(doc({ ...mesh, triangles: [0, 1, value] }), item(), [])).toThrow('PARTS_MESH_TRIANGLE');
  expect(() => readPartMeshes(doc({ ...mesh, width: 0 }), item(), [])).toThrow('PARTS_MESH_SIZE');
  expect(() => readPartMeshes({ skins: { a: { a: { a: mesh } }, b: { a: { a: mesh } } } }, item(), [])).toThrow('PARTS_MESH_AMBIGUOUS');
});
test('mesh sign-off is source-bound; legacy mesh outcomes retain their validation and absent-mesh controls', async () => {
  const root = await fixture(), pkg = await loadPartsView(root);
  const parts = Object.fromEntries(pkg.items.map(i => [i.name, { outcome: 'clean', mesh: { outcome: 'clean' } }]));
  const v = await saveVerdict(pkg, { status: 'approved', issues: [] });
  expect(v.schema).toBe('rig-review-parts-verdict/4');
  expect(v.issues).toEqual([]);
  expect(() => buildVerdict(pkg, {status: 'approved', parts}, '0')).toThrow('PARTS_VERDICT_INVALID');
  expect(verdictSource(pkg).files.map(f => f.path)).toContain('rig.json');
  expect(verdictSource(pkg).files.map(f => f.path)).toContain('mesh_report.json');
  expect(verdictSource(pkg).flags.map(f => f.path)).toContain('mesh_report.json');
  expect((await readVerdict(pkg)).verdict).not.toBeNull();
  const {issues: _issues, ...core} = v;
  const legacy = {...core, schema: 'rig-review-parts-verdict/2', parts, comments: []};
  await writeFile(pkg.verdictPath, JSON.stringify(legacy));
  const decoded = await readPartsVerdictForCli(pkg);
  expect(decoded?.schema).toBe('rig-review-parts-verdict/4');
  await writeFile(pkg.verdictPath, JSON.stringify({...legacy, status: 'pending'}));
  const pendingMesh = await readPartsVerdictForCli(pkg);
  if (!pendingMesh || !('parts' in pendingMesh)) throw new Error('Expected legacy pending mesh record');
  expect(pendingMesh.parts.gap!.mesh).toMatchObject({outcome: 'clean', note: ''});
  parts.gap!.mesh.outcome = 'pending';
  await writeFile(pkg.verdictPath, JSON.stringify(legacy));
  await expect(readVerdict(pkg)).rejects.toThrow('PARTS_VERDICT_NOT_CLEAN');
  parts.gap!.mesh.outcome = 'flagged';
  await writeFile(pkg.verdictPath, JSON.stringify({...legacy, status: 'pending'}));
  await expect(readVerdict(pkg)).rejects.toThrow('PARTS_VERDICT_NOTE_REQUIRED');
  await writeFile(join(root, 'rig.json'), '{}'); await expect(assertPartsUnchanged(pkg)).rejects.toThrow('PARTS_VIEW_SOURCE_CHANGED');
  await unlink(join(root, 'rig.json'));
  const noMesh = await loadPartsView(root); expect(noMesh.items.every(i => !Object.hasOwn(i, 'mesh'))).toBe(true);
  await writeFile(noMesh.verdictPath, JSON.stringify({...legacy, source: verdictSource(noMesh), status: 'pending'}));
  await expect(readVerdict(noMesh)).rejects.toThrow('PARTS_MESH_OUTCOME_UNAVAILABLE');
  await writeFile(noMesh.verdictPath, JSON.stringify({...legacy, source: verdictSource(noMesh), status: 'pending', parts: {gap: {outcome: 'pending'}, covered: {outcome: 'pending'}}}));
  const plain = await readPartsVerdictForCli(noMesh);
  if (!plain || !('parts' in plain)) throw new Error('Expected legacy pending mesh-free record');
  expect(Object.values(plain.parts).every(p => !Object.hasOwn(p, 'mesh'))).toBe(true);
});
test('discovered rig cannot escape; explicit rig is the user-designated input', async () => {
  const root = await fixture(), other = await fixture(); await unlink(join(root, 'rig.json')); await symlink(join(other, 'rig.json'), join(root, 'rig.json'));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_MESH_OUTSIDE');
  expect((await loadPartsView(root, { rig: join(other, 'rig.json') })).items[0]!.mesh).toBeDefined();
});

test('pixel-proven asymmetric-sized padding maps UVs; changed pixel, nontransparent border and wrong image size refuse', async () => {
  const { PNG } = await import('pngjs');
  const root = await fixture();
  const rig = JSON.parse(await readFile(join(root, 'rig.json'), 'utf8'));
  const a = rig.skins.default.gap.gap; a.width = 70; a.height = 74;
  a.uvs = a.uvs.map((v: number, i: number) => (v * 64 + (i % 2 ? 5 : 3)) / (i % 2 ? 74 : 70));
  await writeFile(join(root, 'rig.json'), JSON.stringify(rig));
  const original = PNG.sync.read(await readFile(join(root, 'parts/gap.png'))), padded = new PNG({ width: 70, height: 74 });
  padded.data.fill(0);
  for (let y = 0; y < 64; y++) original.data.copy(padded.data, ((y + 5) * 70 + 3) * 4, y * 64 * 4, (y + 1) * 64 * 4);
  const path = join(root, 'images/gap.png'); await writeFile(path, PNG.sync.write(padded));
  const pkg = await loadPartsView(root); expect(pkg.items[0]!.mesh!.vertices[0]).toBe(0); expect(pkg.items[0]!.mesh!.vertices[1]).toBe(0);
  padded.data[(5 * 70 + 3) * 4] ^= 1; await writeFile(path, PNG.sync.write(padded));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_MESH_IMAGE_MISMATCH: gap: first differing rig pixel (3,5)');
  padded.data[(5 * 70 + 3) * 4] ^= 1; padded.data[3] = 1; await writeFile(path, PNG.sync.write(padded));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_MESH_IMAGE_MISMATCH: gap: first differing rig pixel (0,0)');
  await writeFile(path, await readFile(join(root, 'parts/gap.png')));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_MESH_IMAGE_SIZE');
});

test('RGBA proof preserves hidden RGB in fully transparent pixels', async () => {
  const { PNG } = await import('pngjs'); const root = await fixture();
  const p = PNG.sync.read(await readFile(join(root, 'parts/gap.png'))); p.data[3] = 0;
  await writeFile(join(root, 'parts/gap.png'), PNG.sync.write(p)); p.data[0] ^= 1;
  await writeFile(join(root, 'images/gap.png'), PNG.sync.write(p));
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_MESH_IMAGE_MISMATCH');
});

test('16-bit raster comparison refuses a one-sample difference hidden by 8-bit downsampling', async () => {
  const { PNG } = await import('pngjs'); const root = await fixture();
  const pixels = new Uint16Array(64 * 64 * 4); for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 30000; pixels[i + 1] = 20000; pixels[i + 2] = 10000; pixels[i + 3] = 65535; }
  const png = new PNG({ width: 64, height: 64 }); png.data = pixels as never;
  const pack = () => PNG.sync.write(png, { bitDepth: 16, colorType: 6, inputColorType: 6, inputHasAlpha: true });
  await writeFile(join(root, 'parts/gap.png'), pack()); pixels[0] = pixels[0]! + 1;
  await writeFile(join(root, 'images/gap.png'), pack());
  await expect(loadPartsView(root)).rejects.toThrow('PARTS_MESH_IMAGE_MISMATCH');
});

test('rig snapshot race: bind parsed A; reject B at approval, and planted late-hash mutant approves unseen B', async () => {
  const root = await fixture(), rigPath = join(await realpath(root), 'rig.json'), a = await readFile(rigPath);
  const b = JSON.parse(a.toString('utf8')); b.skins.default.gap.gap.uvs[0] = .125;
  const bytesB = Buffer.from(JSON.stringify(b));
  const sourcePath = new URL('../src/parts-view.ts', import.meta.url).pathname;
  const binding = "files.push({ abs: rigPath, bytes: rigBytes.length, sha256: createHash('sha256').update(rigBytes).digest('hex') });";
  // The read hook swaps the generated input immediately after returning A's bytes: no sleeps or scheduling guesses.
  for (const mutant of [false, true]) {
    await writeFile(rigPath, a);
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs/promises';
      const originalRead = fs.readFile, originalWrite = fs.writeFile;
      const path = ${JSON.stringify(rigPath)}, replacement = Buffer.from(${JSON.stringify(bytesB.toString('base64'))}, 'base64');
      let swapped = false, reads = 0;
      mock.module('node:fs/promises', () => ({ ...fs, readFile: async (file, ...args) => {
        const data = await originalRead(file, ...args);
        if (String(file) === path) { reads++; if (!swapped) { swapped = true; await originalWrite(path, replacement); } }
        return data;
      }}));
      if (${mutant}) Bun.plugin({ name: 'planted-late-rig-hash', setup(build) {
        build.onLoad({ filter: /parts-view\\.ts$/ }, async ({path}) => {
          const source = await originalRead(path, 'utf8'), needle = ${JSON.stringify(binding)};
          if (source.split(needle).length !== 2) throw new Error('mutant binding target is not unique');
          return { contents: source.replace(needle, 'files.push(await hashFile(rigPath));'), loader: 'ts' };
        });
      }});
      const { loadPartsView, saveVerdict } = await import(${JSON.stringify(sourcePath)});
      const pkg = await loadPartsView(${JSON.stringify(root)});
      const hash = pkg.files.find(f => f.abs === path).sha256;
      let refused = false;
      try { await saveVerdict(pkg, {status:'approved', issues:[]}); }
      catch(e) { if (!String(e).includes('PARTS_VIEW_SOURCE_CHANGED')) throw e; refused = true; }
      console.log(JSON.stringify({swapped, reads, firstX:pkg.items[0].mesh.vertices[0],hash,refused}));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const out = JSON.parse(stdout.trim());
    expect(out.swapped).toBe(true); expect(out.firstX).toBe(0);
    const hashA = new Bun.CryptoHasher('sha256').update(a).digest('hex'), hashB = new Bun.CryptoHasher('sha256').update(bytesB).digest('hex');
    expect(out.hash).toBe(mutant ? hashB : hashA); expect(out.refused).toBe(!mutant);
    console.log(`RIG_RACE ${mutant ? 'PLANTED_LATE_HASH_UNSEEN_B_APPROVED' : 'PARSED_A_BOUND_REPLACED_B_REFUSED'}`);
  }
});

async function runMeshReportSwapProbe(
  label: string,
  root: string,
  meshReportPath: string,
  triggerPath: string,
  bytesA: Buffer,
  bytesB: Buffer,
) {
  const timeoutMs = 4000;
  const hashA = new Bun.CryptoHasher('sha256').update(bytesA).digest('hex');
  const sourcePath = new URL('../src/parts-view.ts', import.meta.url).pathname;
  console.log(`FIXTURE_MUTATION_BEGIN ${label} ${meshReportPath} sha256=${hashA}`);
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
      const meshPath = ${JSON.stringify(meshReportPath)}, trigger = ${JSON.stringify(triggerPath)};
      const replacement = Buffer.from(${JSON.stringify(bytesB.toString('base64'))}, 'base64');
      let swapped = false, reads = 0, meshReadsAfterSwap = 0;
      mock.module('node:fs/promises', () => ({ ...fs, readFile: async (file, ...args) => {
        const data = await originalRead(file, ...args);
        if (String(file) === meshPath) { reads++; if (swapped) meshReadsAfterSwap++; }
        if (String(file) === trigger && !swapped) { swapped = true; await originalWrite(meshPath, replacement); }
        return data;
      }}));
      const { loadPartsView, saveVerdict } = await import(${JSON.stringify(sourcePath)});
      const pkg = await loadPartsView(${JSON.stringify(root)});
      const loadReads = reads, loadMeshReadsAfterSwap = meshReadsAfterSwap;
      const flagEntry = pkg.flagFiles.find(f => f.abs === meshPath);
      const fileEntry = pkg.files.find(f => f.abs === meshPath);
      const faintCount = pkg.flags.filter(f => f.kind === 'faint').length;
      const gapFigures = pkg.items.find(i => i.name === 'gap')?.mesh?.figures ?? null;
      let refused = false;
      try { await saveVerdict(pkg, { status: 'approved', issues: [] }); }
      catch (e) { if (!String(e).includes('PARTS_VIEW_SOURCE_CHANGED')) throw e; refused = true; }
      console.log(JSON.stringify({
        swapped, reads: loadReads, meshReadsAfterSwap: loadMeshReadsAfterSwap, faintCount,
        gapTriangles: gapFigures?.triangles ?? null,
        flagHash: flagEntry?.sha256 ?? null,
        fileHash: fileEntry?.sha256 ?? null,
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
    await writeFile(meshReportPath, bytesA);
    const restoredHash = new Bun.CryptoHasher('sha256').update(await readFile(meshReportPath)).digest('hex');
    console.log(`FIXTURE_RESTORED ${label} ${meshReportPath} childExited=${childExited} sha256=${restoredHash}`);
    expect(childExited).toBe(true);
    expect(restoredHash).toBe(hashA);
  }
}

test('#546: mesh_report.json is read once across producerFlags and readPartMeshes', async () => {
  const root = await fixture(), realRoot = await realpath(root), meshReportPath = join(realRoot, 'mesh_report.json');
  const bytesA = await readFile(meshReportPath);
  const reportB = JSON.parse(bytesA.toString('utf8'));
  reportB[0] = { ...reportB[0], triangles: 88, art_coverage: 0.5, contour: { bridges: { faint: [{ art: 44, maxAlpha: 55, box: [1, 1, 2, 2] }] } } };
  const bytesB = Buffer.from(JSON.stringify(reportB));
  const { hashA, out } = await runMeshReportSwapProbe('mesh_report-first-read', root, meshReportPath, meshReportPath, bytesA, bytesB);
  expect(out).toEqual({
    swapped: true, reads: 1, meshReadsAfterSwap: 0, faintCount: 0, gapTriangles: 30, flagHash: hashA, fileHash: hashA, refused: true,
  });
});

test('#546: readPartMeshes reuses the producerFlags mesh_report buffer instead of re-reading after rig.json', async () => {
  const root = await fixture(), realRoot = await realpath(root), meshReportPath = join(realRoot, 'mesh_report.json'), rigPath = join(realRoot, 'rig.json');
  const bytesA = await readFile(meshReportPath);
  const reportB = JSON.parse(bytesA.toString('utf8'));
  reportB[0] = { ...reportB[0], triangles: 88, art_coverage: 0.5, contour: { bridges: { faint: [{ art: 44, maxAlpha: 55, box: [1, 1, 2, 2] }] } } };
  const bytesB = Buffer.from(JSON.stringify(reportB));
  const { hashA, out } = await runMeshReportSwapProbe('mesh_report-after-rig-read', root, meshReportPath, rigPath, bytesA, bytesB);
  expect(out).toEqual({
    swapped: true, reads: 1, meshReadsAfterSwap: 0, faintCount: 0, gapTriangles: 30, flagHash: hashA, fileHash: hashA, refused: true,
  });
});
