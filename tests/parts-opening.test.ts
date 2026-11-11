import {afterEach, expect, test} from 'bun:test';
import {copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {isBuildRoot} from '../src/handoff.ts';
import {loadReview} from '../src/manifest.ts';
import {assertPartsCanOpen, loadPartsAtlas, loadPartsView, verdictSource} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {stagePartsRoutes} from '../src/stage-parts.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {t} from '../web/i18n.ts';
import {writePartsPackage} from './helpers/parts-package.ts';

const refusal = 'PARTS_ATLAS_NOT_CARRIED: atlas inspection is not available in the parts workspace; open the rig review instead.';
const roots: string[] = [];
afterEach(async () => {
  const parent = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    if (dirname(root) !== parent || !basename(root).startsWith('parts-opening-') ||
        !(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error('PARTS_OPENING_CLEANUP_REFUSED');
    await rm(root, {recursive: true});
  }
});

async function scratchRoot() {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'parts-opening-'));
  roots.push(base);
  return base;
}

async function partsBuildRoot() {
  const root = await scratchRoot();
  await writePartsPackage(root);
  await copyFile(join(root, 'rig/parts.json'), join(root, 'parts.json'));
  await cp(join(root, 'rig/parts'), join(root, 'parts'), {recursive: true});
  await writeFile(join(root, 'rig/rig.json'), '{}\n');
  await mkdir(join(root, 'check/build'), {recursive: true});
  await copyFile('examples/demo/skeleton.model.json', join(root, 'check/build/skeleton.model.json'));
  await copyFile('examples/demo/lantern.png', join(root, 'check/build/lantern.png'));
  expect(await isBuildRoot(root)).toBe(true);
  expect((await loadReview(root)).buildRoot).toBe(root);
  return root;
}

async function atlasInput(kind: 'compiled output folder' | 'check folder' | 'review package' = 'compiled output folder') {
  if (kind === 'check folder') return join(await partsBuildRoot(), 'check');
  const root = await scratchRoot();
  await mkdir(join(root, 'build'), {recursive: true});
  await copyFile('examples/demo/skeleton.model.json', join(root, 'build/skeleton.model.json'));
  await copyFile('examples/demo/lantern.png', join(root, 'build/lantern.png'));
  if (kind === 'review package') await writeFile(join(root, 'review.json'), JSON.stringify({
    schema: 'rig-review/1', id: 'atlas-opening', title: 'Atlas opening', revision: '1', model: 'build/skeleton.model.json',
  }));
  return root;
}

async function child(args: string[]) {
  const proc = Bun.spawn([process.execPath, ...args], {stdout: 'pipe', stderr: 'pipe'});
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return {stdout, stderr, exit};
  } finally { clearTimeout(timer); }
}

for (const kind of ['compiled output folder', 'check folder', 'review package'] as const) {
  test(`#748: real parts CLI refuses atlas ${kind} before opening, even on an occupied port`, async () => {
    const root = await atlasInput(kind);
    expect((await loadPartsView(root)).mode).toBe('atlas');
    const occupied = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied')});
    try {
      const result = await child(['src/entry.ts', 'parts', root, '--port', String(occupied.port)]);
      expect(result).toEqual({exit: 1, stdout: '', stderr: refusal + '\n'});
    } finally { await occupied.stop(true); }
  });
}

test('#748: a recognized #149 rig-parts build root retains parts mode and opens the existing server', async () => {
  const root = await partsBuildRoot(), pkg = await loadPartsView(root);
  expect(pkg.root).toBe(root);
  expect(pkg.mode).toBe('parts');
  expect(pkg.items.map(item => item.name)).toEqual(['back_defect', 'back_control', 'front']);
  expect(() => assertPartsCanOpen(pkg)).not.toThrow();
  const server = await startPartsServer(pkg, {port: 0});
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/parts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({mode: 'parts'});
  } finally { await server.shutdown(); }
});

test('#748: CLI opening boundary refuses before calling startPartsServer', async () => {
  const root = await atlasInput();
  const result = await child(['-e', `
    import {mock} from 'bun:test';
    let calls = 0;
    mock.module(${JSON.stringify(resolve('src/parts-server.ts'))}, () => ({
      startPartsServer: async () => { calls++; throw new Error('UNEXPECTED_PARTS_SERVER'); },
    }));
    const {main} = await import(${JSON.stringify(resolve('src/entry.ts'))});
    try { await main(['parts', ${JSON.stringify(root)}]); }
    catch (error) { console.log(JSON.stringify({message: error.message, calls})); }
  `]);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({message: refusal, calls: 0});
});

test('#748: real server startup refuses atlas before bundle, entry HTML, or listener creation', async () => {
  const root = await atlasInput();
  const result = await child(['-e', `
    import {mock, spyOn} from 'bun:test';
    const calls = {bundle: 0, entry: 0, listener: 0};
    mock.module(${JSON.stringify(resolve('src/build.ts'))}, () => ({
      appRoot: ${JSON.stringify(resolve('.') + '/')},
      PLAY_SOURCE_CONDITION: '@rig-c/source', playBuildConditions: () => [],
      buildWeb: async () => { calls.bundle++; throw new Error('UNEXPECTED_BUNDLE'); },
      setupEntryHtml: async () => { calls.entry++; throw new Error('UNEXPECTED_ENTRY'); },
    }));
    const listener = spyOn(Bun, 'serve').mockImplementation(() => {
      calls.listener++; throw new Error('UNEXPECTED_LISTENER');
    });
    const {loadPartsView} = await import(${JSON.stringify(resolve('src/parts-view.ts'))});
    const {startPartsServer} = await import(${JSON.stringify(resolve('src/parts-server.ts'))});
    try { await startPartsServer(await loadPartsView(${JSON.stringify(root)}), {port: 0}); }
    catch (error) { console.log(JSON.stringify({message: error.message, calls})); }
    finally { listener.mockRestore(); }
  `]);
  expect(result.stderr).toBe('');
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({message: refusal, calls: {bundle: 0, entry: 0, listener: 0}});
});

test('#748: atlas verdict/2 remains readable through real CLI JSON and issue exports without changing saved bytes', async () => {
  const root = await atlasInput(), pkg = await loadPartsView(root);
  const historical = {schema: 'rig-review-parts-verdict/2', mode: 'atlas', tool: {name: '@rig-c/review', version: '2.8.0'},
    source: verdictSource(pkg), status: 'approved', issues: [],
    parts: Object.fromEntries(pkg.items.map(item => [item.name, {outcome: 'clean', note: '', flags: []}])),
    updatedAt: '2026-11-01T00:00:00.000Z'};
  const bytes = JSON.stringify(historical, null, 2) + '\n';
  await writeFile(pkg.verdictPath, bytes);
  const json = await child(['src/entry.ts', 'parts', root, '--format', 'json']);
  expect(json.stderr).toBe('');
  expect(json.exit).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({mode: 'atlas', source: historical.source, status: 'approved'});
  const issue = await child(['src/entry.ts', 'parts', root, '--format', 'issue']);
  expect(issue.exit).toBe(0);
  expect(issue.stderr).toBe('');
  expect(issue.stdout).toContain(historical.source.sha256);
  expect(issue.stdout).toContain('approved');
  expect(await readFile(pkg.verdictPath, 'utf8')).toBe(bytes);
});

test('#748: inspected atlas still loads through loadPartsAtlas and the read-only stage-parts route', async () => {
  const root = await atlasInput('review package'), review = await loadReview(root);
  const embedded = await loadPartsAtlas(review), standaloneRead = await loadPartsView(root);
  expect(embedded.mode).toBe('atlas');
  expect(embedded.items.length).toBeGreaterThan(0);
  expect(verdictSource(embedded)).toEqual(verdictSource(standaloneRead));
  const response = await stagePartsRoutes({single: review})(new Request('http://127.0.0.1/api/stage-parts'));
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({mode: 'atlas', readOnly: true});
  expect(await Bun.file(embedded.verdictPath).exists()).toBe(false);
});

test('#748: named opening refusal has paired English and Korean catalog output', () => {
  expect(enCatalog[refusal]).toBe(refusal);
  expect(koCatalog[refusal]).toBe('PARTS_ATLAS_NOT_CARRIED: 파츠 작업 공간에서는 아틀라스를 검사할 수 없어요. 리그 리뷰를 열어 주세요.');
  expect(t(refusal, undefined, 'en')).toBe(enCatalog[refusal]);
  expect(t(refusal, undefined, 'ko')).toBe(koCatalog[refusal]);
});

test('#748: parts help names the refusal and keeps read-only atlas verdict export guidance', async () => {
  const result = await child(['src/entry.ts', 'parts', '--help']);
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('Atlas-only inputs refuse PARTS_ATLAS_NOT_CARRIED');
  expect(result.stdout).toContain('--format json|issue still reads saved parts or atlas verdicts');
  expect(result.stdout).not.toContain('opens its atlas');
});
