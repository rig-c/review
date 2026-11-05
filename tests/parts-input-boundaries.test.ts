import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPartsView, saveVerdict } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { writePartsPackage } from './helpers/parts-package.ts';

const roots: string[] = [];
const LIMIT = 4 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const input = { status: 'approved', parts: Object.fromEntries(['back_defect', 'back_control', 'front'].map(name => [name, { outcome: 'clean' }])) };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'parts-input-boundaries-'));
  roots.push(root);
  await writePartsPackage(root);
  return root;
}

async function unchangedAfterRefusal(target: string, action: () => Promise<unknown>) {
  const before = digest(await readFile(target));
  await expect(action()).rejects.toThrow('PARTS_VERDICT_INPUT_COLLISION');
  expect(digest(await readFile(target))).toBe(before);
}

for (const relative of ['rig/parts.json', 'rig/parts/front.png', 'rig/mesh_report.json', 'check/check.json']) {
  test(`#372: verdict cannot replace generated input ${relative}`, async () => {
    const root = await fixture(), target = join(root, relative);
    const before = digest(await readFile(target));
    let error: unknown;
    try { await saveVerdict(await loadPartsView(root, { verdict: target }), input); } catch (e) { error = e; }
    const after = digest(await readFile(target));
    console.log(JSON.stringify({ case: relative, before, after, refused: error instanceof Error ? error.message : null }));
    expect(after).toBe(before);
    expect(error).toBeInstanceOf(Error);
    expect((await readdir(join(root, relative.startsWith('check/') ? 'check' : relative.includes('/parts/') ? 'rig/parts' : 'rig'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
}

test('#372: ordinary verdict replacement remains supported', async () => {
  const pkg = await loadPartsView(await fixture());
  await saveVerdict(pkg, input);
  await saveVerdict(pkg, { ...input, status: 'pending' });
  expect(JSON.parse(await readFile(pkg.verdictPath, 'utf8')).status).toBe('pending');
});

test('#372: multibyte JSON is bounded by UTF-8 bytes', async () => {
  const pkg = await loadPartsView(await fixture());
  const server = await startPartsServer(pkg, { port: 0 });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const body = JSON.stringify({ ...input, padding: '한'.repeat(Math.ceil(LIMIT / 3)) });
    expect(body.length).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(body)).toBeGreaterThan(LIMIT);
    const response = await fetch(origin + '/api/parts/verdict', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
    console.log(JSON.stringify({ case: 'multibyte', characters: body.length, bytes: Buffer.byteLength(body), status: response.status }));
    expect(response.status).toBe(400);
    expect(await Bun.file(pkg.verdictPath).exists()).toBe(false);
  } finally { server.stop(true); }
});

test('#372: an oversized chunked request refuses before reading its remainder', async () => {
  const pkg = await loadPartsView(await fixture());
  type Handler = (request: Request, host: { port: number; upgrade(): boolean }) => Promise<Response>;
  let dispatch: Handler | undefined;
  const serve = Bun.serve.bind(Bun);
  const capture = spyOn(Bun, 'serve').mockImplementation(options => {
    dispatch = (options as unknown as { fetch: Handler }).fetch;
    return serve(options);
  });
  const server = await startPartsServer(pkg, { port: 0 }).finally(() => capture.mockRestore());
  let pulled = 0, cancelled = false;
  const chunks = [new Uint8Array(LIMIT).fill(32), new Uint8Array([32]), new TextEncoder().encode(JSON.stringify(input))];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    // Dispatch directly to the real server handler: network buffering must not mask reader pulls.
    const response = await dispatch!(new Request(origin + '/api/parts/verdict', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body }), { port: server.port!, upgrade: () => false });
    console.log(JSON.stringify({ case: 'chunked-remainder', pulled, cancelled, status: response.status }));
    expect(response.status).toBe(400);
    expect(pulled).toBe(2);
    expect(cancelled).toBe(true);
    expect(await Bun.file(pkg.verdictPath).exists()).toBe(false);
  } finally { server.stop(true); }
});

for (const alias of ['normalized', 'symlink-file', 'symlink-parent', 'hardlink'] as const) {
  test(`#372: input aliases refuse before output (${alias})`, async () => {
    const root = await fixture(), target = join(root, 'rig', 'parts.json');
    let verdict: string;
    if (alias === 'normalized') verdict = root + '/rig/parts/../parts.json';
    else if (alias === 'symlink-parent') {
      await symlink(join(root, 'rig'), join(root, 'alias-dir'));
      verdict = join(root, 'alias-dir', 'parts.json');
    } else {
      verdict = join(root, 'alias.json');
      if (alias === 'hardlink') await link(target, verdict); else await symlink(target, verdict);
    }
    await unchangedAfterRefusal(target, () => loadPartsView(root, { verdict }));
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
}

test('#372: a filesystem alias introduced after load is refused at save', async () => {
  const root = await fixture(), verdict = join(root, 'late.json'), target = join(root, 'rig', 'parts.json');
  const pkg = await loadPartsView(root, { verdict });
  await link(target, verdict);
  await unchangedAfterRefusal(target, () => saveVerdict(pkg, input));
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

for (const relative of ['rig/rig.json', 'rig/config.json', 'parts.json', 'config.json']) {
  test(`#372: producer input ${relative} is protected without entering verdict source identity`, async () => {
    const root = await fixture(), target = join(root, relative);
    await writeFile(target, '{}\n');
    // Opening rig/ directly also protects the build root's fixed producer inputs.
    await unchangedAfterRefusal(target, () => loadPartsView(join(root, 'rig'), { verdict: target }));
  });
}

for (const relative of ['review.json', 'rig.json', 'skeleton.model.json', 'page.png', 'reference.png']) {
  test(`#372: generated atlas/package input ${relative} is protected`, async () => {
    const root = await fixture(), atlas = join(root, 'atlas');
    await mkdir(atlas);
    await copyFile(join(root, 'rig/parts/front.png'), join(atlas, 'page.png'));
    await copyFile(join(root, 'rig/parts/front.png'), join(atlas, 'reference.png'));
    await writeFile(join(atlas, 'rig.json'), '{}\n');
    await writeFile(join(atlas, 'skeleton.model.json'), JSON.stringify({ spec: 'rigc-compiled/3', bones: [], slots: [], animations: [], pages: [{ name: 'page.png', width: 26, height: 20, regions: [{ name: 'tile', x: 0, y: 0, width: 26, height: 20 }] }] }));
    await writeFile(join(atlas, 'review.json'), JSON.stringify({ schema: 'rig-review/1', id: 'generated-atlas', title: 'Generated atlas', revision: '1', model: 'skeleton.model.json', references: [{ id: 'reference', label: 'Generated reference', type: 'image', path: 'reference.png' }], authoring: [{ label: 'Generated rig', path: 'rig.json' }] }));
    await unchangedAfterRefusal(join(atlas, relative), () => loadPartsView(atlas, { verdict: join(atlas, relative) }));
  });
}

test('#372: a failed atomic replacement cleans its temporary output', async () => {
  const root = await fixture(), verdict = join(root, 'output'), pkg = await loadPartsView(root, { verdict });
  await mkdir(verdict);
  await expect(saveVerdict(pkg, input)).rejects.toThrow();
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect(await readdir(verdict)).toEqual([]);
});

test('#372: exact byte cap saves, while origin, JSON type and capability gates remain enforced', async () => {
  const pkg = await loadPartsView(await fixture()), capability = 'd'.repeat(64);
  const before = await Promise.all(pkg.files.map(async file => digest(await readFile(file.abs))));
  const server = await startPartsServer(pkg, { port: 0, capability });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Review-Capability': capability };
    const payload = JSON.stringify(input);
    const request = (body: string, values = headers) => fetch(origin + '/api/parts/verdict', { method: 'POST', headers: values, body });
    expect((await request(payload, { ...headers, Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await request(payload, { ...headers, 'X-Review-Capability': 'wrong' })).status).toBe(403);
    expect((await request(payload, { ...headers, 'Content-Type': 'text/plain' })).status).toBe(400);
    expect(await Bun.file(pkg.verdictPath).exists()).toBe(false);
    // Legal JSON whitespace makes the precise byte boundary valid without relaxing note limits.
    const body = payload + ' '.repeat(LIMIT - Buffer.byteLength(payload));
    expect(Buffer.byteLength(body)).toBe(LIMIT);
    expect((await request(body)).status).toBe(200);
    expect(JSON.parse(await readFile(pkg.verdictPath, 'utf8')).status).toBe('approved');
    expect(await Promise.all(pkg.files.map(async file => digest(await readFile(file.abs))))).toEqual(before);
  } finally { server.stop(true); }
});
