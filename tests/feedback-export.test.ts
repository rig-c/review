import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview, type ReviewPackage } from '../src/manifest.ts';
import { loadReferencedReview, referenceBinding } from '../src/reference.ts';
import { loadCompare, type ComparePackage } from '../src/compare.ts';
import { freshSession, sessionFile, type Feedback, type ReviewSession } from '../src/session.ts';
import { freshCompareSession, compareSessionFile, type CompareSession } from '../src/compare-session.ts';
import { readFeedbackSession, readFeedbackCompareSession, type FeedbackHistory } from '../src/session-history.ts';
import { formatFeedbackIssues, groupFeedbackIssues, feedbackMarkdownText } from '../src/feedback-export.ts';
import { feedbackFormat } from '../src/cli.ts';

const dirs: string[] = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await realpath(await mkdtemp(join(tmpdir(), 'review-feedback-export-'))); dirs.push(path); return path; }
// Metadata-only transport fixtures: this suite makes no compile/raster claim.
async function fixture(id = 'probe') {
  const root = await directory(), path = join(root, 'review.json');
  await writeFile(path, JSON.stringify({ schema: 'rig-review/1', id, title: id, revision: 'one', model: 'skeleton.model.json', motion: 'motion.json' }));
  await writeFile(join(root, 'motion.json'), 'unchanged motion');
  await writeFile(join(root, 'skeleton.model.json'), JSON.stringify({ spec: 'rigc-compiled/3', pages: [], bones: ['root', 'same', 'constructor', '__proto__'].map(name => ({ name })), slots: [{ name: 'same' }], animations: [{ name: 'inspect', duration: 2 }] }));
  return { root, path, p: await loadReview(path) };
}
const note = (id: string, category: Feedback['category'] = 'defect', kind: Feedback['target']['kind'] = 'bone', name = 'same'): Feedback => ({ id, frameStart: 10, frameEnd: 18, target: { kind, name }, category, summary: 'Inspect this interval', context: { animation: 'inspect', time: 0.5, frame: null, interval: { frameStart: 10, frameEnd: 18, inclusive: true } } });
const items = (model: ReturnType<typeof groupFeedbackIssues>) => model.categories.flatMap(category => category.targets.flatMap(target => target.items));
const decode = (value: string) => value.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
const headingIds = (text: string) => [...text.matchAll(/^#### Feedback (.*)$/gm)].map(match => decode(match[1]!));
async function inventory(root: string) {
  const result: [string, string][] = [];
  async function walk(path: string) { for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) { const full = join(path, entry.name); if (entry.isDirectory()) await walk(full); else result.push([full.slice(root.length + 1), createHash('sha256').update(await readFile(full)).digest('hex')]); } }
  await walk(root); return result;
}
async function artifact(name: string, value: string) { const folder = process.env.RIG_REVIEW_FEEDBACK_ARTIFACT; if (folder) { await mkdir(folder, { recursive: true }); await writeFile(join(folder, name), value); } }
async function cli(args: string[], state: string) {
  const proc = Bun.spawn([process.execPath, 'src/cli.ts', 'feedback', ...args], { env: { ...process.env, RIG_REVIEW_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit };
}
async function pair() {
  const a = await fixture('a'), b = await fixture('b'), reference = join(await directory(), 'original.mp4');
  await writeFile(reference, 'immutable explicit reference');
  const p = await loadCompare({ a: a.path, b: b.path, reference, animation: 'inspect' });
  return { a, b, reference, p };
}
function older(p: ReviewPackage): ReviewPackage { return { ...p, reviewedSource: { ...p.reviewedSource, viewerVersion: '0.0.0', runtimeVersion: '1.0.0' } }; }
function olderPair(p: ComparePackage): ComparePackage {
  const a = older(p.a), b = older(p.b), binding = { a: { sourceHash: a.sourceHash, reviewedSource: a.reviewedSource }, b: { sourceHash: b.sourceHash, reviewedSource: b.reviewedSource }, reference: p.response.binding.reference, animation: p.response.animation };
  const sourceHash = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return { ...p, a, b, response: { ...p.response, id: 'compare-' + sourceHash.slice(0, 16), sourceHash, binding } };
}

test('mixed categories count records once, preserve intervals and distinguish target kind/name safely', async () => {
  const { p } = await fixture();
  const input: ReviewSession = { ...freshSession(p), feedback: [note('first'), note('second', 'quality'), note('third', 'defect', 'slot'), note('fourth', 'quality', 'bone', '__proto__'), note('fifth', 'defect', 'bone', 'constructor')] };
  const before = JSON.stringify(input), model = groupFeedbackIssues(input), text = formatFeedbackIssues(input);
  expect(model.counts).toEqual({ defect: 3, quality: 2, total: 5 });
  expect(model.builds.map(build => build.counts)).toEqual([{ defect: 3, quality: 2, total: 5 }]);
  expect(model.categories.map(category => category.count)).toEqual([3, 2]);
  expect(items(model).map(item => item.id).sort()).toEqual(input.feedback.map(item => item.id).sort());
  expect(headingIds(text).sort()).toEqual(input.feedback.map(item => item.id).sort());
  expect(model.categories[0]!.targets.map(group => group.target)).toEqual([{ kind: 'bone', name: 'constructor' }, { kind: 'bone', name: 'same' }, { kind: 'slot', name: 'same' }]);
  expect(items(model).map(item => [item.frameStart, item.frameEnd])).toEqual(Array.from({ length: 5 }, () => [10, 18]));
  expect(text).toContain('Items: 5 · defect: 3 · quality: 2');
  expect(JSON.stringify(input)).toBe(before);
  items(model)[0]!.target.name = 'changed result';
  expect(JSON.stringify(input)).toBe(before);
});

test('compare counts A/B separately even for equal build hashes and keeps full selected/paired identities', async () => {
  const { p } = await pair();
  const binding = { ...p.response.binding, b: p.response.binding.a };
  const input: CompareSession = { ...freshCompareSession(p), binding, feedback: [{ ...note('alpha'), side: 'a' }, { ...note('beta', 'quality'), side: 'b' }, { ...note('gamma'), side: 'b' }] };
  const model = groupFeedbackIssues(input), text = formatFeedbackIssues(input);
  expect(model.counts).toEqual({ defect: 2, quality: 1, total: 3 });
  expect(model.builds.map(build => [build.side, build.counts])).toEqual([['a', { defect: 1, quality: 0, total: 1 }], ['b', { defect: 1, quality: 1, total: 2 }]]);
  expect(model.builds[0]!.sourceHash).toBe(model.builds[1]!.sourceHash);
  expect(model.pairedBinding).toEqual(binding);
  for (const item of items(model)) expect(item.selectedSource).toEqual(binding[item.side as 'a' | 'b']);
  expect(headingIds(text).sort()).toEqual(['alpha', 'beta', 'gamma']);
  for (const block of text.split(/^#### Feedback /m).slice(1)) {
    expect(block).toContain('Paired comparison binding:');
    expect(block).toContain(binding.reference.sha256);
    expect(block).toContain(binding.a.reviewedSource.rig!.sha256);
    expect(block).toContain(binding.b.reviewedSource.motion!.sha256);
  }
  expect(formatFeedbackIssues({ ...input, feedback: [...input.feedback].reverse() })).toBe(text);
});

test('empty categories/builds stay zero and absent artifact identity is never a fabricated hash', async () => {
  const { p } = await fixture();
  const input = { ...freshSession(p), reviewedSource: { ...p.reviewedSource, rig: null, motion: null } };
  const model = groupFeedbackIssues(input), text = formatFeedbackIssues(input);
  expect(model.counts).toEqual({ defect: 0, quality: 0, total: 0 });
  expect(model.categories).toEqual([{ category: 'defect', count: 0, targets: [] }, { category: 'quality', count: 0, targets: [] }]);
  expect(headingIds(text)).toEqual([]);
  expect(text).toContain('pending · saved: not submitted');
  expect(text).toContain('"rig": null'); expect(text).toContain('"motion": null');
  const { p: compared } = await pair();
  const emptyB = groupFeedbackIssues({ ...freshCompareSession(compared), feedback: [{ ...note('one', 'quality'), side: 'a' }] });
  expect(emptyB.builds[1]!.counts).toEqual({ defect: 0, quality: 0, total: 0 });
});

test('Markdown syntax is escaped, ids remain exact and context cannot close its JSON fence', async () => {
  const { p } = await fixture(), id = 'id\n## forged | <tag>', name = 'target\n#### Feedback fake', summary = '<img src=x> [link](javascript:bad) | *bold* `code` & plain';
  const input = { ...freshSession(p), feedback: [{ ...note(id, 'quality', 'bone', name), summary, context: { original: '````\n# nested', __proto__: null, chosen: [10, 18] } }] };
  const text = formatFeedbackIssues(input);
  expect(headingIds(text)).toEqual([id]);
  expect(items(groupFeedbackIssues(input))[0]!.target.name).toBe(name);
  expect(text).not.toContain('<img'); expect(text).not.toContain('\n## forged'); expect(text).not.toContain('\n#### Feedback fake');
  expect(text).toContain(feedbackMarkdownText(summary));
  expect(text).toContain('`````json\n'); expect(text).toContain('"original": "````\\n# nested"');
});

test('historical legacy evidence retains warnings, original timestamps/tools and contradictory context without mutation', async () => {
  const { p } = await fixture(), state = await directory(), old = older(p), updatedAt = '2025-01-02T03:04:05.000Z';
  const value = { ...freshSession(old), status: 'approved', updatedAt, feedbackWarnings: [], feedback: [{ ...note('legacy'), frameStart: 9007199254740992, frameEnd: 9007199254740992, target: { kind: 'slot', name: 'missing' }, context: { interval: { frameStart: 1, frameEnd: 2, inclusive: true }, time: .25 } }] };
  const file = sessionFile(old, state), bytes = JSON.stringify(value); await writeFile(file, bytes);
  const read = await readFeedbackSession(p, state), model = groupFeedbackIssues(read), text = formatFeedbackIssues(read);
  expect(model.counts.total).toBe(1); expect(model.feedbackWarnings).toHaveLength(1); expect(items(model)[0]!.warnings).toHaveLength(1);
  expect(model.session.updatedAt).toBe(updatedAt); expect(model.builds[0]!.reviewedSource.runtimeVersion).toBe('1.0.0');
  expect(items(model)[0]!.frameStart).toBe(9007199254740992); expect(items(model)[0]!.context).toEqual(value.feedback[0]!.context);
  expect(text).toContain('prior-tools record'); expect(text).toContain('not a current-tools approval'); expect(text).toContain('Validation warnings (record retained)');
  expect(await readFile(file, 'utf8')).toBe(bytes); expect(await Bun.file(sessionFile(p, state)).exists()).toBe(false);
});

test('single explicit-reference identity and comparison historical warning metadata survive formatting', async () => {
  const f = await fixture(), reference = join(await directory(), 'original.mp4'); await writeFile(reference, 'video bytes');
  const p = await loadReferencedReview(f.path, reference), session = { ...freshSession(p), feedback: [note('selected')] }, model = groupFeedbackIssues(session);
  expect(referenceBinding(p)).toBeDefined(); expect(model.referenceBinding).toEqual(referenceBinding(p)!); expect(items(model)[0]!.selectedSource.referenceBinding).toEqual(referenceBinding(p));
  expect(formatFeedbackIssues(session)).toContain(referenceBinding(p)!.reference.sha256);
  const { p: compared } = await pair(), old = olderPair(compared), state = await directory();
  const raw = { ...freshCompareSession(old), updatedAt: '2025-01-01T00:00:00.000Z', status: 'changes-requested', feedback: [{ ...note('oldpair', 'quality', 'slot', 'unknown'), side: 'b' }] };
  const file = compareSessionFile(old, state); await writeFile(file, JSON.stringify(raw));
  const historical = await readFeedbackCompareSession(compared, state);
  const withWarning: FeedbackHistory<CompareSession> = { ...historical, historyWarnings: [{ file: '<old>.json', error: 'unreadable' }] };
  const grouped = groupFeedbackIssues(withWarning), text = formatFeedbackIssues(withWarning);
  expect(grouped.pairedBinding).toEqual(old.response.binding); expect(grouped.builds.map(build => build.reviewedSource.runtimeVersion)).toEqual(['1.0.0', '1.0.0']);
  expect(grouped.feedbackWarnings).toHaveLength(1); expect(grouped.historyWarnings).toEqual(withWarning.historyWarnings!);
  expect(text).toContain('History read warnings'); expect(text).toContain('"file": "<old>.json"'); expect(text).toContain(old.response.binding.reference.sha256);
});

test('format parser accepts only issue/json once and does not reinterpret other command options', () => {
  expect(feedbackFormat(['--format', 'issue', 'input', '--reference', 'video'])).toEqual({ args: ['input', '--reference', 'video'], format: 'issue' });
  expect(feedbackFormat(['input'])).toEqual({ args: ['input'], format: 'json' });
  for (const args of [['input', '--format'], ['input', '--format', 'yaml'], ['input', '--format', 'issue', '--format', 'json']]) expect(() => feedbackFormat(args)).toThrow('feedback --format');
});

test('actual single CLI emits grouped mixed items once and preserves default JSON/reference/state/source bytes', async () => {
  const f = await fixture(), state = await directory(), reference = join(await directory(), 'original.mp4'); await writeFile(reference, 'selected source bytes');
  const p = await loadReferencedReview(f.path, reference), value = { ...freshSession(p), updatedAt: '2025-01-01T00:00:00.000Z', status: 'changes-requested', feedback: [note('first'), note('second', 'quality', 'slot')] };
  await writeFile(sessionFile(p, state), JSON.stringify(value)); const before = { source: await inventory(f.root), state: await inventory(state), reference: await readFile(reference, 'utf8') };
  const args = [f.path, '--reference', reference], json = await cli(args, state), explicit = await cli([...args, '--format', 'json'], state), issue = await cli(['--format', 'issue', ...args], state);
  expect(json.exit).toBe(0); expect(explicit.exit).toBe(0); expect(explicit.stdout).toBe(json.stdout); expect(JSON.parse(json.stdout).referenceBinding).toEqual(referenceBinding(p));
  expect(issue.exit).toBe(0); expect(headingIds(issue.stdout).sort()).toEqual(['first', 'second']); expect(issue.stdout).toContain('Items: 2 · defect: 1 · quality: 1'); expect(issue.stdout).toContain(referenceBinding(p)!.reference.sha256);
  const unrelated = await cli([f.path, '--format', 'csv'], state); expect(unrelated.exit).toBe(1); expect(unrelated.stderr).toContain('expected json | issue');
  expect({ source: await inventory(f.root), state: await inventory(state), reference: await readFile(reference, 'utf8') }).toEqual(before);
  await artifact('single.issue.md', issue.stdout); await artifact('single.session.json', json.stdout);
});

test('both actual compare CLI syntaxes preserve grouped ids, side counts and all paired hashes read-only', async () => {
  const f = await pair(), state = await directory(), value: CompareSession = { ...freshCompareSession(f.p), status: 'changes-requested', updatedAt: '2025-01-01T00:00:00.000Z', feedback: [{ ...note('alpha'), side: 'a' }, { ...note('beta', 'quality'), side: 'b' }, { ...note('gamma'), side: 'b' }] };
  await writeFile(compareSessionFile(f.p, state), JSON.stringify(value)); const before = { a: await inventory(f.a.root), b: await inventory(f.b.root), state: await inventory(state) };
  const oldArgs = ['compare', f.a.path, f.b.path, '--reference', f.reference, '--animation', 'inspect'], newArgs = [f.a.path, '--compare', f.b.path, '--reference', f.reference, '--animation', 'inspect'];
  const output = await cli([...oldArgs, '--format', 'issue'], state), alias = await cli([...newArgs, '--format', 'issue'], state), json = await cli(oldArgs, state);
  expect(output.exit).toBe(0); expect(alias.exit).toBe(0); expect(alias.stdout).toBe(output.stdout); expect(headingIds(output.stdout).sort()).toEqual(['alpha', 'beta', 'gamma']);
  expect(output.stdout).toContain('| a | one | 1 | 0 | 1 |'); expect(output.stdout).toContain('| b | one | 1 | 1 | 2 |'); expect(output.stdout).toContain(f.p.response.binding.reference.sha256);
  expect(JSON.parse(json.stdout).binding).toEqual(f.p.response.binding);
  expect({ a: await inventory(f.a.root), b: await inventory(f.b.root), state: await inventory(state) }).toEqual(before);
  await artifact('compare.issue.md', output.stdout); await artifact('compare.session.json', json.stdout);
});

test('actual CLI preserves historical warnings but rejects format on unrelated commands', async () => {
  const f = await fixture(), state = await directory(), old = older(f.p), value = { ...freshSession(old), status: 'approved', updatedAt: '2024-01-01T00:00:00.000Z', feedback: [note('old', 'defect', 'slot', 'unknown')] };
  await writeFile(sessionFile(old, state), JSON.stringify(value)); const output = await cli([f.path, '--format', 'issue'], state);
  expect(output.exit).toBe(0); expect(headingIds(output.stdout)).toEqual(['old']); expect(output.stdout).toContain('prior-tools record'); expect(output.stdout).toContain('Validation warnings (record retained)');
  await artifact('historical.issue.md', output.stdout);
  for (const command of ['check', 'open']) {
    const proc = Bun.spawn([process.execPath, 'src/cli.ts', command, f.path, '--format', 'issue'], { env: { ...process.env, RIG_REVIEW_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(1); expect(await new Response(proc.stderr).text()).toContain('Unknown');
  }
  const emptyState = await directory(), fresh = await cli([f.path, '--format', 'issue'], emptyState); expect(fresh.exit).toBe(0); expect(fresh.stdout).toContain('Items: 0 · defect: 0 · quality: 0'); expect(await readdir(emptyState)).toEqual([]);
});
