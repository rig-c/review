import {afterEach, expect, test} from 'bun:test';
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {jobHash} from '../src/job-api.ts';
import type {JobPreviousBuild} from '../src/job-contract.ts';

const demo = join(import.meta.dir, '../examples/demo');
const stateDirs: string[] = [];
const roots: string[] = [];
const modelPath = 'skeleton.model.json';
const atlasPath = 'lantern.atlas';
const cli = join(import.meta.dir, '../src/entry.ts');
const invalid = 'JOB_PREVIOUS_BUILD_INVALID';

async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function entries(path: string) {
  return readdir(path, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

afterEach(async () => {
  for (const state of stateDirs.splice(0)) {
    const records = (await entries(join(state, 'open'))).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry.name))
      .map(entry => join(state, 'open', entry.name));
    records.push(...(await entries(join(state, 'owner-workspace'))).filter(entry => entry.name === 'host.json')
      .map(entry => join(state, 'owner-workspace', entry.name)));
    for (const record of records) {
      const {pid, origin, nonce, registrationCapability} = await json(record);
      const response = await fetch(origin + (nonce ? '/api/open-status' : '/workspace/api/status'), {
        headers: {Authorization: 'Bearer ' + (nonce ?? registrationCapability)}, signal: AbortSignal.timeout(1000),
      });
      expect(nonce ? [200, 409].includes(response.status) : response.ok).toBe(true);
      expect(await response.json()).toMatchObject(nonce ? {nonce} : {pid});
      process.kill(pid, 'SIGTERM');
      const deadline = performance.now() + 3000;
      while ((await entries(dirname(record))).some(entry => join(dirname(record), entry.name) === record) &&
        performance.now() < deadline) await Bun.sleep(25);
      expect((await entries(dirname(record))).some(entry => join(dirname(record), entry.name) === record)).toBe(false);
    }
  }
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-previous-cli-')));
  roots.push(root);
  const current = join(root, 'current build'), previous = join(root, 'previous build'), state = join(root, 'state');
  stateDirs.push(state);
  await cp(demo, current, {recursive: true});
  await cp(demo, previous, {recursive: true});
  await rm(join(current, 'review.json'));
  // Use the public compiled lantern with additional clip names and a local atlas.
  const atlas = 'lantern.png\nsize: 20,20\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nlantern\n  rotate: false\n  xy: 0,0\n  size: 20,20\n  orig: 20,20\n  offset: 0,0\n  index: -1\n';
  for (const [dir, names] of [[current, ['walk', 'unmapped']], [previous, ['old-walk', 'old-idle']]] as const) {
    await writeFile(join(dir, atlasPath), atlas);
    const model = await json(join(dir, modelPath));
    for (const name of names) {
      model.animations.push({...model.animations[0], name});
      model.editorOrder.animations.push(name);
    }
    await writeFile(join(dir, modelPath), JSON.stringify(model));
  }
  return {root, current, previous, state};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function runCli(state: string, args: string[], managedPort?: number) {
  if (!stateDirs.includes(state)) stateDirs.push(state);
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: {...process.env, RIG_REVIEW_STATE_DIR: state,
      ...(managedPort === undefined ? {} : {RIG_REVIEW_FRONT_PORT: String(managedPort)})},
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return {stdout, stderr, exit};
}

function launch(f: Fixture, flags: string[] = [], options: {
  managedPort?: number; viewOnly?: boolean; state?: string; current?: string; previous?: string;
} = {}) {
  return runCli(options.state ?? f.state, [
    'open', options.current ?? f.current, '--previous', options.previous ?? f.previous,
    ...(options.viewOnly === false ? [] : ['--view-only']), '--animation', 'idle',
    ...(options.managedPort === undefined ? ['--direct'] : []), ...flags,
  ], options.managedPort);
}

async function opened(result: Awaited<ReturnType<typeof launch>>, managed = false) {
  expect(result).toEqual({exit: 0, stderr: expect.any(String), stdout: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[^\n]*\n$/)});
  const state = result.stderr.match(/^Previous pair state: (.+)$/m)?.[1];
  const manifest = result.stderr.match(/^Previous pair manifest: (.+)$/m)?.[1];
  expect(state).toBeDefined();
  expect(manifest?.startsWith(state + '/')).toBe(true);
  const url = new URL(result.stdout.trim());
  const page = await fetch(url);
  expect(page.status).toBe(200);
  await page.body?.cancel();
  let api = url.origin + '/api/review';
  if (managed) {
    const response = await fetch(url.origin + '/workspace/api/targets', {headers: {'X-Review-Capability': url.hash.slice(5)}});
    expect(response.ok).toBe(true);
    const {targets} = await response.json();
    expect(targets).toHaveLength(1);
    const entry = new URL(targets[0].entry, url.origin);
    const frame = await fetch(entry);
    expect(frame.status).toBe(200);
    await frame.body?.cancel();
    api = new URL('api/review', entry).href;
  }
  const response = await fetch(api);
  expect(response.status).toBe(200);
  const metadata = await response.json();
  expect(metadata.manifest.previousBuild.schema).toBe('rig-review-previous-build/1');
  return {url, state: state!, manifest: manifest!, metadata, build: metadata.manifest.previousBuild as JobPreviousBuild, api};
}

async function tree(root: string) {
  const files: Record<string, {ino: number; mtimeMs: number; ctimeMs: number; contents: string}> = {};
  async function visit(dir: string, prefix = '') {
    const {ino, mtimeMs, ctimeMs} = await lstat(dir);
    files[prefix] = {ino, mtimeMs, ctimeMs, contents: 'directory'};
    for (const entry of await entries(dir)) {
      const path = join(dir, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path, name + '/');
      else {
        const {ino, mtimeMs, ctimeMs} = await lstat(path);
        const contents = entry.isSymbolicLink() ? 'link ' + await readlink(path) : jobHash(await readFile(path));
        files[name] = {ino, mtimeMs, ctimeMs, contents};
      }
    }
  }
  await visit(root);
  return files;
}

async function refused(f: Fixture, code: string, detail?: string, flags?: string[], options?: Parameters<typeof launch>[2]) {
  const result = await launch(f, flags, options);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(new RegExp('^' + code + '[:\\s]'));
  if (detail !== undefined) expect(result.stderr).toContain(detail);
  expect(result.stderr).not.toContain('Previous pair state:');
  return result.stderr;
}

test('opens a bare current and manifest predecessor, keeps both inputs and serves the admitted previous-view assets', async () => {
  const f = await fixture();
  const before = await Promise.all([tree(f.current), tree(f.previous)]);
  const result = await launch(f, [], {previous: join(f.previous, 'review.json')});
  const pair = await opened(result);
  expect(pair.build).toMatchObject({currentLabel: 'current build', label: 'previous build', clipMap: {idle: 'idle'}});
  expect(pair.metadata.manifest.id).toBe('current-build');
  expect(pair.metadata.initialAnimation).toBe('idle');
  expect(result.stderr).toContain('Previous clip map: {"idle":"idle"}');
  expect(result.stderr).toContain('Unmapped current clips: ["walk","unmapped"]');
  for (const name of [modelPath, atlasPath, 'lantern.png']) {
    expect(await readFile(join(dirname(pair.manifest), name))).toEqual(await readFile(join(f.current, name)));
  }
  for (const file of [pair.build.model, pair.build.atlas, ...pair.build.pages]) {
    const name = file.path.split('/').at(-1)!;
    const bytes = await readFile(join(f.previous, name));
    const path = file.path.split('/').map(encodeURIComponent).join('/');
    const asset = await fetch(new URL(pair.metadata.assetsBase + path, pair.api));
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(bytes);
    expect(await readFile(join(dirname(pair.manifest), file.path))).toEqual(bytes);
    expect(file.sha256).toBe(jobHash(bytes));
  }
  const retainedRoot = dirname(join(dirname(pair.manifest), pair.build.model.path));
  for (const name of ['review.json', 'SOURCE.md', 'lantern.svg', 'pose.json', 'chime.wav']) {
    expect(await readFile(join(retainedRoot, name))).toEqual(await readFile(join(f.previous, name)));
  }
  expect(await Promise.all([tree(f.current), tree(f.previous)])).toEqual(before);
}, 30000);

test('the same demo pair requires explicit --view-only when no producer handoff exists', async () => {
  const f = await fixture();
  const writable = await launch(f, [], {viewOnly: false});
  expect(writable.exit).toBe(1);
  expect(writable.stdout).toBe('');
  expect(writable.stderr).toMatch(/^OPEN_MODEL_UNAVAILABLE:/m);
  expect(await entries(join(f.state, 'open'))).toEqual([]);
  expect((await opened(await launch(f))).metadata.capabilities.playback).toBe(true);
}, 30000);

test('a producer config beside a bare out folder stays available after pairing and reopening', async () => {
  const f = await fixture();
  const producer = join(f.root, 'producer');
  const current = join(producer, 'out');
  await mkdir(join(current, 'rig'), {recursive: true});
  await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(current, 'build'), {recursive: true});
  await writeFile(join(producer, 'config.json'), JSON.stringify({
    key: 'synthetic',
    meshes: {topwear: {
      contour: {tolerance: 2, margin: 2, spacing: 28, maxEdge: 45, stray: 300, bridges: true, regions: []},
      r: 15, segments: [['rigid', [416, 230], [416, 600]]],
    }},
  }));
  await writeFile(join(current, 'parts.json'), '{}');
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) await writeFile(join(current, 'rig', file), '{}');
  const before = await tree(producer);
  const pair = await opened(await runCli(f.state,
    ['open', current, '--previous', f.previous, '--animation', 'inspect', '--direct']));
  const rebuild = await fetch(new URL('api/rebuild', pair.url));
  expect(rebuild.ok).toBe(true);
  expect(await rebuild.json()).toMatchObject({available: true});
  const reopen = await runCli(f.state, ['open', pair.manifest, '--animation', 'inspect', '--direct']);
  expect(reopen.exit).toBe(0);
  expect(reopen.stdout.trim()).toBe(pair.url.href);
  const feedback = await runCli(f.state, ['feedback', pair.manifest, '--animation', 'inspect']);
  expect(feedback.exit).toBe(0);
  expect(JSON.parse(feedback.stdout)).toMatchObject({
    sourceHash: pair.metadata.sourceHash, reviewedSource: pair.metadata.reviewedSource,
  });
  expect(await tree(producer)).toEqual(before);
}, 30000);

test('paired open keeps a selected local reference and control on the exact admitted manifest', async () => {
  const f = await fixture();
  const reference = join(import.meta.dir, 'fixtures/strip-probe/reference.mov');
  const pair = await opened(await launch(f, ['--reference', reference, '--control']));
  const sha256 = jobHash(await readFile(reference));
  expect(pair.metadata.explicitReference).toMatchObject({name: 'reference.mov', sha256});
  const control = await runCli(f.state, ['control', pair.manifest, '--reference', reference, '--animation', 'idle']);
  expect(control.exit).toBe(0);
  expect(JSON.parse(control.stdout)).toMatchObject({sourceHash: pair.metadata.sourceHash, pages: []});
}, 30000);

test('opens the explicit current manifest through the managed target and preserves manifest fields and labels', async () => {
  const f = await fixture();
  const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response()});
  const managedPort = probe.port!;
  await probe.stop(true);
  const original = join(f.current, 'declared.json');
  const raw = {...await json(join(f.previous, 'review.json')), descriptiveExtension: {retain: true}};
  await writeFile(original, JSON.stringify(raw, null, 2));
  await rm(join(f.previous, 'review.json'));
  const before = await Promise.all([tree(f.current), tree(f.previous)]);
  const pair = await opened(await launch(f, ['--current-label', ' 현재 ', '--previous-label', ' 이전 '],
    {managedPort, current: original}), true);
  expect(pair.build).toMatchObject({currentLabel: ' 현재 ', label: ' 이전 '});
  expect(pair.metadata.manifest).toMatchObject({id: raw.id, revision: raw.revision, references: raw.references});
  expect(await json(pair.manifest)).toMatchObject(raw);
  expect(await readFile(join(dirname(pair.manifest), 'declared.json'))).toEqual(await readFile(original));
  const feedback = await runCli(f.state, ['feedback', pair.manifest]);
  expect(feedback.exit).toBe(0);
  expect(JSON.parse(feedback.stdout)).toMatchObject({sourceHash: pair.metadata.sourceHash, status: 'pending'});
  expect(await Promise.all([tree(f.current), tree(f.previous)])).toEqual(before);
}, 30000);

test('repeat and concurrent open reuse validated pair state; a different predecessor uses another path', async () => {
  const f = await fixture();
  const [first, concurrent] = await Promise.all([launch(f), launch(f)]);
  const a = await opened(first);
  const b = await opened(concurrent);
  expect([b.state, b.url.href]).toEqual([a.state, a.url.href]);
  const retained = await lstat(a.manifest);
  const repeat = await opened(await launch(f));
  expect([repeat.state, repeat.url.href]).toEqual([a.state, a.url.href]);
  expect(await lstat(repeat.manifest)).toMatchObject({ino: retained.ino, mtimeMs: retained.mtimeMs, ctimeMs: retained.ctimeMs});
  const other = join(f.root, 'other previous');
  await cp(f.previous, other, {recursive: true});
  const c = await opened(await launch(f, ['--previous-label', a.build.label], {previous: other}));
  expect(c.build).toEqual(a.build);
  expect(c.state).not.toBe(a.state);
}, 30000);

test('explicit maps override and add; no-clip-map keeps all current clips unmapped', async () => {
  const f = await fixture();
  const explicit = await launch(f, ['--map-clip', 'idle', 'old-idle', '--map-clip', 'walk', 'old-walk']);
  expect((await opened(explicit)).build.clipMap).toEqual({idle: 'old-idle', walk: 'old-walk'});
  expect(explicit.stderr).toContain('Previous clip map: {"idle":"old-idle","walk":"old-walk"}');
  expect(explicit.stderr).toContain('Unmapped current clips: ["unmapped"]');
  const empty = await launch(f, ['--no-clip-map']);
  expect((await opened(empty)).build.clipMap).toEqual({});
  expect(empty.stderr).toContain('Previous clip map: {}');
  expect(empty.stderr).toContain('Unmapped current clips: ["idle","walk","unmapped"]');
  await refused(f, 'OPEN_OPTION_INVALID', '--no-clip-map', ['--no-clip-map', '--map-clip', 'idle', 'idle']);
}, 30000);

test.each(['current', 'previous'] as const)('atlas selection lists zero/many candidates and honors the %s override', async side => {
  const f = await fixture();
  const dir = f[side];
  await rm(join(dir, atlasPath));
  const flag = '--' + side + '-atlas';
  const missing = await refused(f, 'OPEN_PREVIOUS_ATLAS_AMBIGUOUS', 'candidates=[]');
  expect(missing).toContain(flag);
  await writeFile(join(dir, 'b.atlas'), 'b');
  await writeFile(join(dir, 'a.atlas'), 'a');
  const ambiguous = await refused(f, 'OPEN_PREVIOUS_ATLAS_AMBIGUOUS', 'candidates=["a.atlas","b.atlas"]');
  expect(ambiguous).toContain(flag);
  const pair = await opened(await launch(f, [flag, 'b.atlas']));
  const atlas = side === 'current' ? 'b.atlas' : pair.build.atlas.path;
  expect(await readFile(join(dirname(pair.manifest), atlas), 'utf8')).toBe('b');
}, 30000);

test('an adjacent directory ending in .atlas is outside the file candidates', async () => {
  const f = await fixture();
  await mkdir(join(f.current, 'directory.atlas'));
  await mkdir(join(f.previous, 'directory.atlas'));
  const pair = await opened(await launch(f));
  expect(pair.build.atlas.path.split('/').at(-1)).toBe(atlasPath);
}, 30000);

test.each(['current', 'previous'] as const)('refuses a tampered %s clone on reuse without replacing it', async side => {
  const f = await fixture();
  const pair = await opened(await launch(f));
  const asset = join(dirname(pair.manifest), side === 'current' ? atlasPath : pair.build.atlas.path);
  await writeFile(asset, 'tampered retained bytes');
  await refused(f, invalid, 'hash mismatch');
  expect(await readFile(asset, 'utf8')).toBe('tampered retained bytes');
}, 30000);

test('refuses a new implicitly discoverable asset in the retained current closure', async () => {
  const f = await fixture();
  const pair = await opened(await launch(f));
  const added = join(dirname(pair.manifest), 'motion.json');
  await writeFile(added, '{}');
  await refused(f, invalid, 'motion.json');
  expect(await readFile(added, 'utf8')).toBe('{}');
}, 30000);

test.each(['current', 'previous'] as const)('refuses missing or mismatched %s pages, contained symlinks and traversal', async side => {
  const f = await fixture(), dir = f[side], modelFile = join(dir, modelPath);
  const original = await readFile(modelFile);
  const model = JSON.parse(original.toString());
  const page = model.pages[0];
  model.pages = [page, page];
  await writeFile(modelFile, JSON.stringify(model));
  await refused(f, invalid, 'runtime pages differ');
  model.pages = [{...page, name: 'missing.png'}];
  await writeFile(modelFile, JSON.stringify(model));
  await refused(f, invalid, 'missing.png');
  model.pages = [{...page, name: '../lantern.png'}];
  await writeFile(modelFile, JSON.stringify(model));
  await refused(f, invalid, 'runtime page');
  await writeFile(modelFile, original);
  await cp(join(dir, 'lantern.png'), join(dir, 'physical.png'));
  await rm(join(dir, 'lantern.png'));
  await symlink('physical.png', join(dir, 'lantern.png'));
  await refused(f, invalid, 'lantern.png');
  await refused(f, invalid, 'path', ['--' + side + '-atlas', '../' + atlasPath]);
}, 30000);

test.each(['current', 'previous'] as const)('a %s review.json symlink cannot select a different manifest or fall back to bare mode', async side => {
  const f = await fixture(), dir = f[side], manifest = join(dir, 'review.json');
  const borrowed = join(dir, 'other.json');
  await cp(join(demo, 'review.json'), borrowed);
  await rm(manifest, {force: true});
  await symlink('other.json', manifest);
  await refused(f, invalid, 'symlink');
  await rm(borrowed);
  await refused(f, invalid, 'symlink');
}, 30000);

test.each(['current', 'previous'] as const)('refuses a traversing path in the %s explicit manifest', async side => {
  const f = await fixture(), path = join(f[side], 'review.json');
  const manifest = await json(join(demo, 'review.json'));
  manifest.model = 'build/../' + modelPath;
  await writeFile(path, JSON.stringify(manifest));
  await refused(f, invalid, 'literal package-relative path');
}, 30000);

test('refuses both roots as state ancestors, the same canonical package and an uncompiled input', async () => {
  const f = await fixture();
  const alias = join(f.root, 'alias');
  await symlink(f.current, alias, 'dir');
  await refused(f, 'OPEN_PREVIOUS_SAME_ROOT', undefined, [], {previous: alias});
  for (const path of [alias, f.previous]) {
    const state = join(path, 'forbidden-state');
    await refused(f, 'OPEN_STATE_INSIDE_PACKAGE', undefined, [], {state});
    expect(await entries(state)).toEqual([]);
  }
  const uncompiled = join(f.root, 'uncompiled');
  await mkdir(uncompiled);
  await writeFile(join(uncompiled, 'motion.json'), '{}');
  await refused(f, 'OPEN_PREVIOUS_MODEL_MISSING', 'current', [], {current: uncompiled});
  await refused(f, 'OPEN_PREVIOUS_MODEL_MISSING', 'previous', [], {previous: uncompiled});
  await cp(join(demo, 'review.json'), join(uncompiled, 'review.json'));
  await refused(f, 'OPEN_PREVIOUS_MODEL_MISSING', 'current', [], {current: uncompiled});
  await refused(f, 'OPEN_PREVIOUS_MODEL_MISSING', 'previous', [], {previous: uncompiled});
}, 30000);

test('reports signed text, path, map-entry and declaration bounds with values', async () => {
  const f = await fixture();
  const long = '한'.repeat(43);
  for (const [flag, field] of [['--previous-label', 'label'], ['--current-label', 'currentLabel']]) {
    await refused(f, invalid, field + ' UTF-8 bytes found=129 limit=128', [flag!, long]);
  }
  await refused(f, invalid, 'clipMap key UTF-8 bytes found=129 limit=128', ['--map-clip', long, 'idle']);
  await refused(f, invalid, 'clipMap value UTF-8 bytes found=129 limit=128', ['--map-clip', 'idle', long]);
  for (const flag of ['--current-atlas', '--previous-atlas']) {
    await refused(f, invalid, 'path code units found=4097 limit=4096', [flag, 'a'.repeat(4091) + '.atlas']);
  }
  await refused(f, invalid, 'clipMap entries found=257 limit=256',
    Array.from({length: 256}, (_, i) => ['--map-clip', 'new-' + i, 'idle']).flat());
  const declaration = await refused(f, invalid, undefined, Array.from({length: 255}, (_, i) =>
    ['--map-clip', String(i).padStart(3, '0') + 'a'.repeat(125), 'b'.repeat(128)]).flat());
  expect(declaration).toMatch(/declaration bytes found=\d+ limit=65536/);
}, 30000);

test.each(['current', 'previous'] as const)('reports signed page-count and closure-byte caps on the %s build', async side => {
  const f = await fixture(), path = join(f[side], modelPath), original = await readFile(path);
  const model = JSON.parse(original.toString());
  model.pages = Array.from({length: 65}, (_, i) => ({...model.pages[0], name: i + '.png'}));
  await writeFile(path, JSON.stringify(model));
  await refused(f, invalid, 'model pages count found=65 limit=64');
  await writeFile(path, original);
  const bytes = 64 * 1024 * 1024;
  await truncate(join(f[side], atlasPath), bytes);
  await refused(f, invalid, `closure bytes through asset found=${bytes + original.length} limit=${bytes}`);
}, 30000);
