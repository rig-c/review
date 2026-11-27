import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_COMMENTS_ROUTE } from '../src/local-comments.ts';
import { loadPartsView, readVerdict, verdictSource, type PartsViewPackage } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { writePartsPackage } from './helpers/parts-package.ts';
import { seedPartsVerdictFixture } from './helpers/parts-verdict-fixture.ts';

const roots: string[] = [];
const LIMIT = 4 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const input = { status: 'approved', issues: [] };
const localSend = (pkg: PartsViewPackage) => ({
  sendId: crypto.randomUUID(), sourceHash: verdictSource(pkg).sha256, value: {comments: [{text: 'Inspect the edge'}]},
});
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
  test(`#372: verdict reads refuse a path to generated input ${relative}`, async () => {
    const root = await fixture(), target = join(root, relative);
    await unchangedAfterRefusal(target, () => loadPartsView(root, { verdict: target }));
    expect((await readdir(join(root, relative.startsWith('check/') ? 'check' : relative.includes('/parts/') ? 'rig/parts' : 'rig'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
}

for (const mode of ['parts', 'atlas'] as const) {
  test(`${mode} verdict preserves the leaf under a physical parent and names invalid parents`, async () => {
    const root = await realpath(await fixture());
    const pkg = mode === 'parts' ? root : join(root, 'atlas');
    if (mode === 'atlas') {
      await mkdir(pkg);
      await writeFile(join(pkg, 'skeleton.model.json'), '{"spec":"rigc-compiled/3","pages":[]}');
    }
    const physical = join(root, 'verdict-output'), alias = join(root, 'verdict-alias');
    await mkdir(physical);
    await symlink(physical, alias, 'dir');
    await writeFile(join(physical, 'file'), 'sentinel');
    await symlink('loop', join(physical, 'loop'), 'dir');
    for (const prefix of ['file', 'loop']) {
      await expect(loadPartsView(pkg, { verdict: join(alias, prefix, 'missing', 'verdict.json') }))
        .rejects.toThrow('PARTS_VERDICT_DESTINATION_INVALID:');
    }
    expect((await readdir(physical)).sort()).toEqual(['file', 'loop']);
    const output = join(alias, 'missing', 'verdict.json');
    const view = await loadPartsView(pkg, { verdict: output });
    expect(view.mode).toBe(mode);
    expect(view.verdictPath).toBe(join(physical, 'missing', 'verdict.json'));
    await mkdir(join(physical, 'missing'));
    const saved = await seedPartsVerdictFixture(view, input);
    const reopened = await loadPartsView(pkg, { verdict: output });
    expect(await readVerdict(reopened)).toEqual({ verdict: saved, stale: null });
    expect(await readFile(join(physical, 'file'), 'utf8')).toBe('sentinel');
  });
}

test('#372: multibyte local comment JSON is bounded by UTF-8 bytes', async () => {
  const pkg = await loadPartsView(await fixture());
  const server = await startPartsServer(pkg, { port: 0 });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const body = JSON.stringify({...localSend(pkg), padding: '한'.repeat(Math.ceil(LIMIT / 3))});
    expect(body.length).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(body)).toBeGreaterThan(LIMIT);
    const response = await fetch(origin + LOCAL_COMMENTS_ROUTE, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
    console.log(JSON.stringify({ case: 'multibyte', characters: body.length, bytes: Buffer.byteLength(body), status: response.status }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: 'LOCAL_COMMENTS_BODY_LIMIT'});
    expect(await Bun.file(join(pkg.root, 'review-comments.json')).exists()).toBe(false);
  } finally { server.stop(true); }
});

test('#372: an oversized chunked local comment request refuses before reading its remainder', async () => {
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
  const chunks = [new Uint8Array(LIMIT).fill(32), new Uint8Array([32]), new TextEncoder().encode(JSON.stringify(localSend(pkg)))];
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
    const response = await dispatch!(new Request(origin + LOCAL_COMMENTS_ROUTE, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body }), { port: server.port!, upgrade: () => false });
    console.log(JSON.stringify({ case: 'chunked-remainder', pulled, cancelled, status: response.status }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: 'LOCAL_COMMENTS_BODY_LIMIT'});
    expect(pulled).toBe(2);
    expect(cancelled).toBe(true);
    expect(await Bun.file(join(pkg.root, 'review-comments.json')).exists()).toBe(false);
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

test('#372: reopening refuses a verdict path that has become an input hardlink', async () => {
  const root = await fixture(), verdict = join(root, 'late.json'), target = join(root, 'rig', 'parts.json');
  await loadPartsView(root, { verdict });
  await link(target, verdict);
  await unchangedAfterRefusal(target, () => loadPartsView(root, { verdict }));
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

test('#372: local comment sends at the exact byte cap still enforce origin, JSON type and capability', async () => {
  const pkg = await loadPartsView(await fixture()), capability = 'd'.repeat(64);
  const before = await Promise.all(pkg.files.map(async file => digest(await readFile(file.abs))));
  const server = await startPartsServer(pkg, { port: 0, capability });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Review-Capability': capability };
    const send = localSend(pkg), payload = JSON.stringify(send);
    const commentsFile = join(pkg.root, 'review-comments.json');
    const request = (body: string, values = headers) => fetch(origin + LOCAL_COMMENTS_ROUTE, { method: 'POST', headers: values, body });
    expect((await request(payload, { ...headers, Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await request(payload, { ...headers, 'X-Review-Capability': 'wrong' })).status).toBe(403);
    expect((await request(payload, { ...headers, 'Content-Type': 'text/plain' })).status).toBe(400);
    expect(await Bun.file(commentsFile).exists()).toBe(false);
    // Legal JSON whitespace makes the precise byte boundary valid without relaxing note limits.
    const body = payload + ' '.repeat(LIMIT - Buffer.byteLength(payload));
    expect(Buffer.byteLength(body)).toBe(LIMIT);
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({sendId: send.sendId, at: expect.any(String)});
    expect(JSON.parse(await readFile(commentsFile, 'utf8')).sends).toMatchObject([{sendId: send.sendId, value: send.value}]);
    expect(await Bun.file(pkg.verdictPath).exists()).toBe(false);
    expect(await Promise.all(pkg.files.map(async file => digest(await readFile(file.abs))))).toEqual(before);
  } finally { server.stop(true); }
});
