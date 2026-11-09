import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {partsIssueSubmission} from './helpers/parts-comments-package.ts';
import {afterEach, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadPartsView, readVerdict, saveVerdict, verdictSource, type PartsViewPackage} from '../src/parts-view.ts';
import {writePartsPackage} from './helpers/parts-package.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function fixture() {
  // Canonical setup plus an explicit link on EVERY OS, including Linux CI.
  const arena = await realpath(await mkdtemp(join(tmpdir(), 'parts-alias-')));
  roots.push(arena);
  const physical = join(arena, 'physical'), alias = join(arena, 'alias');
  await mkdir(physical);
  await symlink(physical, alias, 'dir');
  expect(await realpath(alias)).toBe(physical);
  expect(alias).not.toBe(physical);
  const painting = join(physical, 'painting'), build = join(physical, 'build'), out = join(physical, 'out');
  await writeComparisonPackage(painting);
  await writePartsPackage(build);
  await mkdir(out);
  return {arena, physical, alias, painting, build, out};
}
const submission = async (pkg: PartsViewPackage, summary?: string) => summary ? partsIssueSubmission(pkg, summary) : {status: 'approved', issues: []};
const hashes = (pkg: PartsViewPackage) => Promise.all([...pkg.files, ...pkg.flagFiles].map(async f => ({abs: f.abs, sha256: createHash('sha256').update(await readFile(f.abs)).digest('hex')})));
const expectedPaths = {
  files: ['../build/rig/parts.json', '../build/rig/parts/back_defect.png', '../build/rig/parts/back_control.png', '../build/rig/parts/front.png'],
  flags: ['../build/rig/mesh_report.json', '../build/check/check.json'],
};

test('#472: painting aliases, including a lexical outside path to an inside file, preserve the physical portable verdict binding', async () => {
  const f = await fixture(), entry = join(f.arena, 'outside-entry.png');
  await symlink(join(f.painting, 'painting.png'), entry);
  const canonical = await loadPartsView(f.painting, {painting: join(f.painting, 'painting.png')});
  const before = await hashes(canonical), source = verdictSource(canonical);
  expect(source.files.map(file => file.path)).toEqual(['parts.json', 'parts/body.png', 'parts/front.png', 'painting.png']);
  for (const [root, painting] of [
    [join(f.alias, 'painting'), join(f.alias, 'painting/painting.png')],
    [f.painting, entry],
    [join(f.alias, 'painting'), entry],
  ]) {
    const pkg = await loadPartsView(root!, {painting});
    expect(pkg.painting).toEqual(canonical.painting);
    expect(pkg.painting!.abs).toBe(join(f.painting, 'painting.png'));
    expect(pkg.verdictPath).toBe(join(f.painting, 'parts-review.json'));
    expect(verdictSource(pkg)).toEqual(source); // Includes paths, sizes, hashes and aggregate hash.
    const saved = await saveVerdict(pkg, await submission(pkg));
    expect(saved.source).toEqual(source);
    expect(saved.source.files.at(-1)!.path).toBe('painting.png');
    expect((await readVerdict(canonical)).verdict).toEqual(saved);
    expect((await readVerdict(await loadPartsView(root!, {painting}))).verdict).toEqual(saved);
    expect(await hashes(pkg)).toEqual(before);
  }
});

test('#472: canonical and alias destinations/explicit flags serialize exactly the same files, flag paths and source hash', async () => {
  const f = await fixture(), destination = join(f.out, 'v.json');
  const canonical = await loadPartsView(f.build, {verdict: destination}), source = verdictSource(canonical), before = await hashes(canonical);
  expect(source.files.map(file => file.path)).toEqual(expectedPaths.files);
  expect(source.flags.map(file => file.path)).toEqual(expectedPaths.flags);
  for (const root of [f.build, join(f.alias, 'build')]) {
    for (const verdict of [destination, join(f.alias, 'out/v.json')]) {
      for (const flagsRoot of [f.build, join(f.alias, 'build')]) {
        const pkg = await loadPartsView(root, {verdict, meshReport: join(flagsRoot, 'rig/mesh_report.json'), check: join(flagsRoot, 'check/check.json')});
        expect(pkg.verdictPath).toBe(destination);
        expect(pkg.flagFiles).toEqual(canonical.flagFiles);
        expect(verdictSource(pkg)).toEqual(source);
        const saved = await saveVerdict(pkg, await submission(pkg));
        expect((await readVerdict(await loadPartsView(f.build, {verdict: destination}))).verdict).toEqual(saved);
        expect(await hashes(pkg)).toEqual(before);
      }
    }
  }
});

test('#472: missing nested destination parents retain their suffix behind an alias and save/reload unchanged inputs', async () => {
  const f = await fixture(), destination = join(f.out, 'not-yet/deep/v.json');
  const canonical = await loadPartsView(f.build, {verdict: destination}), before = await hashes(canonical);
  const pkg = await loadPartsView(join(f.alias, 'build'), {verdict: join(f.alias, 'out/not-yet/deep/v.json')});
  expect(pkg.verdictPath).toBe(destination);
  expect(verdictSource(pkg)).toEqual(verdictSource(canonical));
  expect(verdictSource(pkg).files.map(file => file.path)).toEqual(expectedPaths.files.map(path => '../../' + path));
  const saved = await saveVerdict(pkg, await submission(pkg));
  expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual(saved);
  expect((await readVerdict(await loadPartsView(f.build, {verdict: destination}))).verdict).toEqual(saved);
  expect((await readVerdict(await loadPartsView(join(f.alias, 'build'), {verdict: join(f.alias, 'out/not-yet/deep/v.json')}))).verdict).toEqual(saved);
  expect(await hashes(pkg)).toEqual(before);
});

test('#472: genuine outside painting and inside-to-outside links refuse by name before PNG decoding', async () => {
  const f = await fixture(), outside = join(f.arena, 'outside.png');
  await writeFile(outside, 'deliberately not a PNG');
  await symlink(outside, join(f.painting, 'escape.png'));
  const canonical = await loadPartsView(f.painting), before = await hashes(canonical);
  for (const root of [f.painting, join(f.alias, 'painting')]) {
    for (const painting of [outside, join(root, 'escape.png')]) {
      await expect(loadPartsView(root, {painting})).rejects.toThrow('PARTS_PAINTING_OUTSIDE:');
    }
  }
  expect(await readFile(outside, 'utf8')).toBe('deliberately not a PNG');
  expect(await hashes(canonical)).toEqual(before);
});

test('#472: alias input destinations and output leaf links to inputs preserve the collision refusal and input bytes', async () => {
  const f = await fixture(), pkg = await loadPartsView(f.build), before = await hashes(pkg);
  const leaf = join(f.out, 'input-link.json');
  await symlink(join(f.build, 'rig/parts.json'), leaf);
  for (const verdict of [join(f.alias, 'build/rig/parts.json'), join(f.alias, 'out/input-link.json')]) {
    await expect(loadPartsView(f.build, {verdict})).rejects.toThrow('PARTS_VERDICT_INPUT_COLLISION:');
  }
  expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
  expect(await hashes(pkg)).toEqual(before);
});

test('#472: a verdict leaf link to ordinary output keeps its basename and never overwrites the link target', async () => {
  const f = await fixture(), target = join(f.out, 'target.json'), leaf = join(f.out, 'leaf.json');
  const targetPkg = await loadPartsView(f.build, {verdict: target});
  await saveVerdict(targetPkg, await submission(targetPkg, 'original target'));
  const original = await readFile(target), before = await hashes(targetPkg);
  await symlink(target, leaf);
  const pkg = await loadPartsView(join(f.alias, 'build'), {verdict: join(f.alias, 'out/leaf.json')});
  expect(pkg.verdictPath).toBe(leaf); // Must NOT become target.json.
  expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
  expect(verdictSource(pkg)).toEqual(verdictSource(targetPkg));
  const saved = await saveVerdict(pkg, await submission(pkg, 'new leaf verdict'));
  expect((await lstat(leaf)).isSymbolicLink()).toBe(false);
  expect(await readFile(target)).toEqual(original);
  expect(JSON.parse(await readFile(leaf, 'utf8'))).toEqual(saved);
  expect((await readVerdict(await loadPartsView(f.build, {verdict: leaf}))).verdict).toEqual(saved);
  expect(await hashes(pkg)).toEqual(before);
});

test('#472: atlas verdict destinations and explicit flags also use physical paths', async () => {
  const f = await fixture(), atlas = join(f.physical, 'atlas');
  await cp('examples/demo', atlas, {recursive: true});
  const canonical = await loadPartsView(atlas, {verdict: join(f.out, 'atlas.json'), check: join(f.build, 'check/check.json')});
  const pkg = await loadPartsView(join(f.alias, 'atlas'), {verdict: join(f.alias, 'out/atlas.json'), check: join(f.alias, 'build/check/check.json')});
  expect(pkg.mode).toBe('atlas');
  expect(pkg.verdictPath).toBe(canonical.verdictPath);
  expect(verdictSource(pkg)).toEqual(verdictSource(canonical));
  const before = await hashes(pkg), saved = await saveVerdict(pkg, await submission(pkg));
  expect((await readVerdict(canonical)).verdict).toEqual(saved);
  expect(await hashes(pkg)).toEqual(before);
});

test('#472: an explicitly designated rig alias remains a physical verdict input', async () => {
  const f = await fixture();
  await writeComparisonPackage(f.painting, true);
  const canonical = await loadPartsView(f.painting, {rig: join(f.painting, 'rig.json')});
  const pkg = await loadPartsView(join(f.alias, 'painting'), {rig: join(f.alias, 'painting/rig.json')});
  expect(pkg.items[0]!.mesh).toBeDefined();
  expect(pkg.files).toEqual(canonical.files);
  expect(verdictSource(pkg)).toEqual(verdictSource(canonical));
  expect(verdictSource(pkg).files.some(file => file.path === 'rig.json')).toBe(true);
  const before = await hashes(pkg), saved = await saveVerdict(pkg, await submission(pkg));
  expect((await readVerdict(canonical)).verdict).toEqual(saved);
  expect(await hashes(pkg)).toEqual(before);
});
