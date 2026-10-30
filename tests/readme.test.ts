import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkReadme, README_HEADINGS, README_WORD_CAP, readmeWords} from '../scripts/check-readme.ts';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const readme = read('README.md');
const root = fileURLToPath(new URL('../', import.meta.url));

test('#224: orientation stays within its fixed word cap and heading/date rules', () => {
  expect(checkReadme(readme)).toEqual([]);
  expect(README_WORD_CAP).toBeLessThanOrEqual(2500);
  expect(readmeWords(' \n ')).toBe(0);
  expect(readmeWords('one\ntwo\tthree')).toBe(3);
});

const mutants = [
  {name: 'word-cap', code: 'README_WORD_CAP', text: 'word '.repeat(README_WORD_CAP + 1)},
  {name: 'heading', code: 'README_HEADING', text: '## Feature implementation diary\n'},
  {name: 'measured-on', code: 'README_DATED_MEASUREMENT', text: 'Measured on 2026-10-30: 7 ms.'},
  {name: 'read-on', code: 'README_DATED_MEASUREMENT', text: 'READ\non 2026-10-30: 7 ms.'},
  {name: 'table-date', code: 'README_TABLE_DATE', text: '| Host | Date |\n| --- | --- |\n| sample | 2026-10-30 |'},
  {name: 'table-date-no-edge-pipes', code: 'README_TABLE_DATE', text: 'Date | Value\n--- | ---\n2026-10-30 | 7'},
  {name: 'table-header-date', code: 'README_TABLE_DATE', text: '| 2026-10-30 | Value |\n| --- | --- |\n| sample | 7 |'},
] as const;

for (const mutant of mutants) test(`#224 planted ${mutant.name} refuses by name`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-readme-'));
  try {
    const file = join(dir, mutant.name + '.md');
    writeFileSync(file, mutant.text);
    const result = Bun.spawnSync([process.execPath, 'scripts/check-readme.ts', file], {cwd: root});
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(stderr).toStartWith(mutant.code + ':');
    expect(checkReadme(mutant.text).every(line => line.startsWith(mutant.code + ':'))).toBe(true);
    console.log(`PLANT ${mutant.name} REFUSED ${stderr.trim()}`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('#224: exact cap, allowed headings and code examples remain usable', () => {
  expect(checkReadme('word '.repeat(README_WORD_CAP))).toEqual([]);
  expect(checkReadme(README_HEADINGS.map(heading => '## ' + heading).join('\n'))).toEqual([]);
  expect(checkReadme('## Start ##\n\n```sh\n## example comment\n```\n\n~~~~text\n## example heading\n~~~\n~~~~')).toEqual([]);
  expect(checkReadme('~~~text\n## example\n~~~\n## Unlisted after fence')).toEqual(['README_HEADING: line 4: Unlisted after fence']);
  expect(checkReadme('Release 2026-10-30 has a separate reference.\n\n| Name | Value |\n| :--- | ---: |\n| sample | 7 |')).toEqual([]);
});

// GitHub preserves the two spaces around a removed arrow as two hyphens.
// Bun.markdown collapses them; the pinned GitHub-rendered fixture is the oracle.
const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-');
function headings(text: string): Set<string> {
  const ids = new Set<string>();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    const heading = !fenced && /^#{1,6} (.+)$/u.exec(line)?.[1];
    if (heading) ids.add(slug(heading));
  }
  return ids;
}

test('#224: inbound README headings and their reference destinations still resolve', () => {
  const fixture = JSON.parse(read('tests/fixtures/readme-headings.json')) as {headings: {text: string; id: string}[]};
  for (const heading of fixture.headings) {
    expect(slug(heading.text)).toBe(heading.id);
    expect(headings(readme).has(heading.id)).toBe(true);
  }
  // Site content/docs/review.md links these six README fragments; REVIEW_PACKAGE links launcher-contract.
  const inbound = ['place-in-the-toolchain', 'existing-output-handoff', 'compare-two-outputs',
    'feedback-ownership', 'chest-regions-designate-rebuild-watch', 'one-command-owner-handoff', 'launcher-contract'];
  for (const anchor of inbound) expect(headings(readme).has(anchor)).toBe(true);
  for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]!;
    if (target.startsWith('#')) { expect(headings(readme).has(target.slice(1))).toBe(true); continue; }
    const local = target.replace('https://github.com/rig-c/review/blob/main/', '');
    if (/^https?:/u.test(local)) continue;
    const [path, anchor] = local.split('#');
    const text = read(path!);
    if (anchor) expect(headings(text).has(anchor)).toBe(true);
  }
});

test('#224: installed README reference links ship, unshipped contributor links are absolute', () => {
  const files = JSON.parse(read('package.json')).files as string[];
  for (const document of ['README.md', 'docs/WORKFLOWS.md', 'docs/PANELS.md', 'docs/REVIEW_PACKAGE.md',
    'docs/DESIGN.md', 'docs/ANIMATION_INSPECTION.md', 'docs/LIVE_FIXTURE.md', 'LICENSE']) expect(files).toContain(document);
  expect(readme).toContain('https://github.com/rig-c/review/blob/main/CONTRIBUTING.md#development');
  for (const document of ['docs/WORKFLOWS.md', 'docs/PANELS.md']) {
    for (const match of read(document).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|#)/u.test(target)) continue;
      const resolved = new URL(target, 'https://package.invalid/' + document);
      const path = resolved.pathname.slice(1);
      expect(files).toContain(path);
      if (resolved.hash) expect(headings(read(path)).has(resolved.hash.slice(1))).toBe(true);
    }
  }
});
