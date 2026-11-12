import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkScreenCopies, countRow, readSources, ROWS, type CopyRow} from '../scripts/screen-copies.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = readSources(root);
const failuresOf = (map: ReadonlyMap<string, string>) => checkScreenCopies(map).flatMap(result => result.failure ? [result.failure] : []);

/** Remove every hit of a row: delete its files and strip its matches. */
function zeroed(row: CopyRow): Map<string, string> {
  const map = new Map(sources);
  if (row.exactSet) for (const [path, text] of map) {
    if (!row.exactSet.paths.test(path)) continue;
    if (row.exactSet.pattern) map.set(path, text.replace(row.exactSet.pattern, ''));
    else map.delete(path);
  }
  for (const file of row.files ?? []) map.delete(file);
  if (row.fileGlob) for (const path of [...map.keys()]) if (row.fileGlob.pattern.test(path) && !row.fileGlob.except.includes(path)) map.delete(path);
  for (const matcher of row.matchers ?? []) for (const [path, text] of map) {
    if (matcher.files && !matcher.files.includes(path)) continue;
    if (matcher.except?.includes(path)) continue;
    map.set(path, text.replace(matcher.pattern, ''));
  }
  return map;
}

test('#686: every row is at its ceiling on this tree and the script exits 0', () => {
  expect(failuresOf(sources)).toEqual([]);
  for (const row of ROWS) expect({row: row.name, count: countRow(row, sources)}).toEqual({row: row.name, count: row.ceiling});
  expect(new Set(ROWS.map(row => row.name)).size).toBe(ROWS.length);
  const result = Bun.spawnSync([process.execPath, 'scripts/screen-copies.ts'], {cwd: root});
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('SCREEN_COPIES_OK');
});

for (const row of ROWS) {
  if (row.exactSet) test(`#801 planted extra entry refuses by name: ${row.name}`, () => {
    const map = new Map(sources), {plantIn, plant} = row.exactSet!;
    map.set(plantIn, (map.get(plantIn) ?? '') + '\n' + plant);
    expect(countRow(row, map)).toBe(row.ceiling + 1);
    const failures = checkScreenCopies(map, [row]);
    expect(failures[0]!.failure).toStartWith(`SCREEN_ENTRY_SET_CHANGED: ${row.name}:`);
    expect(failures[0]!.failure).toContain(plantIn === 'src/build.ts' ? 'web/planted.ts' : plantIn);
  });
  if (row.exactSet) test(`#801 same-count replacement refuses by name: ${row.name}`, () => {
    const map = new Map(sources), set = row.exactSet!;
    if (!set.pattern) map.delete(set.expected[0]!);
    else if (row.name === 'buildWeb entries exact set') {
      map.set('src/build.ts', map.get('src/build.ts')!.replace(set.expected[0]!, 'web/planted.ts'));
    } else map.set(set.expected[0]!, map.get(set.expected[0]!)!.replace(set.pattern, ''));
    if (row.name !== 'buildWeb entries exact set') map.set(set.plantIn, (map.get(set.plantIn) ?? '') + '\n' + set.plant);
    expect(countRow(row, map)).toBe(row.ceiling);
    expect(checkScreenCopies(map, [row])[0]!.failure).toStartWith(`SCREEN_ENTRY_SET_CHANGED: ${row.name}:`);
  });
  for (const [i, matcher] of (row.matchers ?? []).entries()) test(`#686 planted extra hit refuses: ${row.name} [${i}]`, () => {
    const map = new Map(sources);
    expect(map.has(matcher.plantIn)).toBe(true);
    map.set(matcher.plantIn, map.get(matcher.plantIn)! + matcher.plant);
    expect(countRow(row, map)).toBe(row.ceiling + 1);
    expect(checkScreenCopies(map, [row])[0]!.failure).toBe(`SCREEN_COPY_ROSE: ${row.name}: ${row.ceiling + 1} > ceiling ${row.ceiling} (step ${row.step})`);
    expect(failuresOf(map).filter(failure => !failure.startsWith('SCREEN_ENTRY_SET_CHANGED:'))).toEqual([`SCREEN_COPY_ROSE: ${row.name}: ${row.ceiling + 1} > ceiling ${row.ceiling} (step ${row.step})`]);
  });
  if (row.fileGlob) test(`#686 planted extra file refuses: ${row.name}`, () => {
    const map = new Map(sources);
    const planted = row.fileGlob!.pattern.source.includes('html') ? 'web/planted.html' : 'web/planted.css';
    map.set(planted, '');
    expect(countRow(row, map)).toBe(row.ceiling + 1);
    expect(checkScreenCopies(map, [row])[0]!.failure).toBe(`SCREEN_COPY_ROSE: ${row.name}: ${row.ceiling + 1} > ceiling ${row.ceiling} (step ${row.step})`);
    expect(failuresOf(map).filter(failure => !failure.startsWith('SCREEN_ENTRY_SET_CHANGED:'))).toEqual([`SCREEN_COPY_ROSE: ${row.name}: ${row.ceiling + 1} > ceiling ${row.ceiling} (step ${row.step})`]);
  });
  test(`#686 reaching 0 without lowering the ceiling refuses: ${row.name}`, () => {
    const map = zeroed(row);
    expect(countRow(row, map)).toBe(0);
    // A synthetic positive ceiling stands for the row before its step lowered it, so this still holds once the row is 0.
    const stale = {...row, exactSet: undefined, ceiling: Math.max(row.ceiling, 1)};
    expect(checkScreenCopies(map, [stale])[0]!.failure).toBe(`SCREEN_COPY_CEILING_STALE: ${row.name}: 0 hits, lower its ceiling from ${stale.ceiling} to 0 (step ${row.step})`);
    // The same tree passes that row once its ceiling is 0.
    expect(checkScreenCopies(map, [{...row, exactSet: undefined, ceiling: 0}])[0]!.failure).toBeNull();
  });
}

test('#704 a ceiling above the current count refuses, and the unmodified tree passes', () => {
  expect(failuresOf(sources)).toEqual([]);
  const real = ROWS.find(row => countRow(row, sources) > 0)!;
  const current = countRow(real, sources);
  const raised = ROWS.map(row => row === real ? {...row, ceiling: row.ceiling + 1} : row);
  const failures = checkScreenCopies(sources, raised).flatMap(result => result.failure ? [result.failure] : []);
  expect(failures).toEqual([`SCREEN_COPY_CEILING_STALE: ${real.name}: ${current} hits, lower its ceiling from ${current + 1} to ${current} (step ${real.step})`]);
});

test('#686 a row at 0 with ceiling 0 passes, and one hit on it refuses', () => {
  const row: CopyRow = {name: 'planted zero row', step: 'x', ceiling: 0, matchers: [{pattern: /plantedCopy/gu, plant: 'plantedCopy', plantIn: 'web/main.ts'}]};
  expect(checkScreenCopies(new Map([['web/main.ts', '']]), [row])[0]).toMatchObject({current: 0, failure: null});
  expect(checkScreenCopies(new Map([['web/main.ts', 'plantedCopy']]), [row])[0]!.failure).toBe('SCREEN_COPY_ROSE: planted zero row: 1 > ceiling 0 (step x)');
  const lowered = ROWS.filter(real => real.ceiling === 0);
  expect(lowered.length).toBeGreaterThan(0);
  for (const real of lowered) expect(checkScreenCopies(sources, [real])[0]).toMatchObject({current: 0, failure: null});
});

test('#686 CLI exits non-zero on a planted tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-screen-copies-'));
  try {
    for (const [path, text] of sources) {
      mkdirSync(dirname(join(dir, path)), {recursive: true});
      writeFileSync(join(dir, path), path === 'web/compare.ts' ? text + '\nfunction zoomCamera(): void {}\n' : text);
    }
    const result = Bun.spawnSync([process.execPath, 'scripts/screen-copies.ts', dir], {cwd: root});
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString().trim()).toStartWith('SCREEN_COPY_ROSE: compare camera stack definitions in web/compare.ts:');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('#686 matchers count the copy, not shared code', () => {
  const only = (name: string) => ROWS.find(row => row.name === name)!;
  // The shared viewport's own definitions and the rig provider's referenceFit are not compare copies.
  const shared = new Map([['web/viewport-controller.ts', 'function zoomCamera(){}\nfunction alignCameras(){}'], ['web/rig-viewport-provider.ts', 'function referenceFit(){}']]);
  expect(countRow(only('compare camera stack definitions in web/compare.ts'), shared)).toBe(0);
  // Calls into the compare stack are not definitions.
  expect(countRow(only('compare camera stack definitions in web/compare.ts'), new Map([['web/compare.ts', 'zoomCamera(1.25);alignCameras();']]))).toBe(0);
  // The shared layerShortcuts loop in view-controls is the original.
  expect(countRow(only('job inline layer toggles (layerShortcuts loop)'), new Map([['web/view-controls.ts', 'for(const item of layerShortcuts){}']]))).toBe(0);
  // The 250px row counts only inside .job-inspection rules.
  expect(countRow(only('job fixed row grid-template-rows:250px in .job-inspection'), new Map([['web/styles.css', '.other{grid-template-rows:250px}@media(x){.job-window .job-inspection{grid-template-rows:250px}}']]))).toBe(1);
  // The shell compatibility kind of the same name is not a view-controls layout.
  expect(countRow(only('createViewControls layout legacyCompareStep3'), new Map([['web/workspace-ui.ts', "compatibility:'legacyCompareStep3'"]]))).toBe(0);
});
