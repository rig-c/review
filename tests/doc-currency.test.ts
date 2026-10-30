import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {COMPILER_PACKAGE, REMESH_DELTA_SINCE, versionAtLeast} from '../src/producer.ts';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('#221: published package guidance distinguishes canonical, convenience and compiler names', () => {
  const readme = read('README.md'), contract = read('docs/REVIEW_PACKAGE.md'), panels = read('docs/PANELS.md');
  expect(readme).toContain('The package is 0.x:');
  expect(readme).toContain('npm i -D rig-review');
  for (const name of ['@rig-c/pixi', '@rig-c/phaser', '@rig-c/three']) expect(readme).toContain(name);
  expect(readme).not.toContain('unreleased adapter API');
  expect(contract).toContain(`this checkout consumes pinned ${manifest.dependencies['@rig-c/play']}.`);
  for (const text of [panels, contract]) { expect(text).toContain(COMPILER_PACKAGE); expect(text).toContain('legacy `rig-c` only when'); }
});

test('#221: the guide pins scoped producers and names the released Review limitation', () => {
  const guide = read('docs/LIVE_FIXTURE.md');
  const line = guide.split('\n').find(line => line.startsWith('npm i -D '))!;
  expect(line).toContain('@rig-c/core@'); expect(line).not.toMatch(/(?:^| )rig-c@/);
  const parts = /@rig-c\/parts@([\d.]+)/.exec(line)![1]!;
  expect(versionAtLeast(parts, REMESH_DELTA_SINCE)).toBe(true);
  expect(guide).toContain('Published Review 0.13.0 still resolves');
  expect(guide).toContain('bun /absolute/path/to/review/src/cli.ts open');
  expect(guide).toContain('have not been re-measured for the current producer pins');
});

test('#221: the alias bootstrap is recorded as completed without an install deferral', () => {
  const release = read('RELEASING.md');
  expect(release).toContain('completed 2026-10-29');
  expect(release).toContain('**0.13.0**');
  expect(release).not.toContain('This change publishes nothing');
  expect(release).not.toContain('README install recommendations wait');
});
