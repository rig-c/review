import { expect, test } from 'bun:test';
import { patchSha256, patchText, type ConfigPatch } from '../src/config-patch.ts';
import { projectPartsDescription, projectSessionCorrection } from '../src/correction-handoff.ts';
import type { AppliedAnimation, AppliedPatch } from '../src/applied-context.ts';
import type { PartsVerdict } from '../src/parts-view.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';

const hash = (digit: string) => digit.repeat(64);
const source = {
  id: 'package', revision: 'r1', sourceHash: hash('a'),
  reviewedSource: {
    packageRevision: 'r1', viewerVersion: '1.10.2', runtimeVersion: '1.23.0',
    rig: { path: 'build/skeleton.model.json', sha256: hash('b') }, motion: null,
    handoff: { schema: 'rig-review-handoff/1', how: 'declared', via: 'review.json producer', outside: false,
      config: { path: 'config.json', sha256: hash('c') }, parts: 'out', rig: 'out/rig', source: null,
      full: null, head: null, files: [{ path: 'config.json', sha256: hash('c') }], missing: [] },
  } satisfies ReviewSession['reviewedSource'],
};
const selector = { stage: 'rig-review', kind: 'rig', version: 1 } as const;
const patch: ConfigPatch = {
  schema: 'rig-review-config-patch/1', config_sha256: hash('c'),
  ops: [{ op: 'replace', path: '/note', value: 'new' }],
  producer: { name: '@rig-c/parts', version: '2.18.0' }, op: { cmd: 'rig', args: [] },
};
const check = { schema: 'rig-review-check-summary/1', pass: true, gate: true, exitCode: 0, line: 'check: PASS', bars: { BOUND: 'PASS' }, source: 'check' } as const;
const applied: AppliedPatch = {
  schema: 'rig-review-applied/2', buildId: hash('d'), patch, patchSha256: patchSha256(patch),
  configHash: hash('c'), modelHash: hash('e'), stageInputHash: hash('f'),
  producer: { package: '@rig-c/parts', version: '2.18.0' }, compiler: { package: '@rig-c/core', version: '3.2.1' },
  line: 'producer line', check, diff: { count: 1, paths: ['/note'] },
};
const settled = {
  source, applied, operationSha256: applied.patchSha256, modelSha256: applied.modelHash,
  outcome: { ...selector, version: 2 },
};

function sessionInput(value: unknown = applied) {
  const session: ReviewSession = {
    ...source, schema: 'rig-review-session/1', status: 'changes-requested', updatedAt: null,
    checkpoints: {}, feedbackWarnings: [],
    feedback: [{ id: 'item-1', frameStart: 0, frameEnd: 0, target: { kind: 'rig', name: 'package' },
      category: 'quality', summary: 'Please refine the contour.  ', context: { applied: value } as Feedback['context'] }],
  };
  return { session, sessionBytes: Buffer.from(JSON.stringify(session, null, 2) + '\n'), source, selector, itemId: 'item-1' };
}

test('projects one exact saved request and keeps its outcome open', () => {
  const input = sessionInput();
  const projected = projectSessionCorrection({ ...input, path: 'described' });
  expect(projected).toMatchObject({ kind: 'described', itemId: 'item-1', verbatim: 'Please refine the contour.  ', outcome: null, on: ['--version', '1'] });
  expect(() => projectSessionCorrection({ ...input, path: 'described', itemId: 'missing' })).toThrow('CORRECTION_ITEM_INVALID');
  expect(() => projectSessionCorrection({ ...input, path: 'described', source: { ...source, revision: 'stale' } })).toThrow('CORRECTION_SOURCE_STALE');
  expect(() => projectSessionCorrection({ ...input, path: 'described', selector: { ...selector, version: 0 } })).toThrow('CORRECTION_SELECTOR_INVALID');
});

test('pre-rig verdict note retains verbatim CRLF and uses only a parts selector', () => {
  const verdict: PartsVerdict = {
    schema: 'rig-review-parts-verdict/2', mode: 'parts', tool: { name: '@rig-c/review', version: '1.10.2' },
    source: { sha256: hash('a'), files: [], flags: [] }, status: 'changes-requested',
    parts: { torso: { outcome: 'flagged', note: 'Keep these words.  \r\n', flags: [] } },
    comments: [], updatedAt: '2026-11-06T00:00:00Z',
  };
  const result = projectPartsDescription({ verdict, source: verdict.source, selector: { kind: 'parts', stage: 'parts-review', inventory: 'evidence/parts.json' }, selection: { kind: 'note', part: 'torso', itemId: 'note-1' } });
  expect(result).toMatchObject({ verbatim: 'Keep these words.  \r\n', part: 'torso', on: ['--parts-file', 'evidence/parts.json'], outcome: null });
});

test('checked patch keeps the exact session and patch, bound to a distinct scratch result', () => {
  const input = sessionInput();
  const result = projectSessionCorrection({ ...input, path: 'made', settled });
  expect(result).toMatchObject({ kind: 'checked-patch', applied, patchBytes: patchText(patch), outcome: ['--version', '2'] });
  if (result.kind !== 'checked-patch') throw Error('expected checked patch');
  expect(result.sessionBytes).toBe(input.sessionBytes);
  expect(() => projectSessionCorrection({ ...input, path: 'made' })).toThrow('CORRECTION_APPLY_PENDING');
  expect(() => projectSessionCorrection({ ...sessionInput(null), path: 'made', settled })).toThrow('CORRECTION_APPLY_PENDING');
  expect(() => projectSessionCorrection({ ...input, path: 'made', settled: { ...settled, applied: { ...applied, buildId: hash('0') } } })).toThrow('CORRECTION_APPLY_STALE');
  expect(() => projectSessionCorrection({ ...input, path: 'made', settled: { ...settled, operationSha256: hash('0') } })).toThrow('CORRECTION_ARTIFACT_MISMATCH');
  expect(() => projectSessionCorrection({ ...input, path: 'made', settled: { ...settled, modelSha256: hash('0') } })).toThrow('CORRECTION_OUTCOME_MISMATCH');
});

test('failed or skipped checks cannot project a create checked outcome', () => {
  for (const failedCheck of [null, { ...check, gate: false }, { ...check, bars: { BOUND: 'SKIP' } }]) {
    const failed = { ...applied, check: failedCheck };
    expect(() => projectSessionCorrection({ ...sessionInput(failed), path: 'made', settled: { ...settled, applied: failed } })).toThrow('CORRECTION_CHECK_FAILED');
  }
});

test('keyed animation is explicitly unsupported with its original operation and session', () => {
  const keyed: AppliedAnimation = {
    schema: 'rig-review-applied/5', buildId: applied.buildId, configHash: applied.configHash,
    animationsFrom: { path: 'animations.json', beforeSha256: hash('1'), afterSha256: hash('2') },
    ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 }],
    opsSha256: hash('3'), args: [], producer: applied.producer, compiler: applied.compiler,
    line: applied.line, check, files: null, modelHash: applied.modelHash,
  };
  const input = sessionInput(keyed);
  const result = projectSessionCorrection({ ...input, path: 'made' });
  expect(result).toMatchObject({ kind: 'unsupported', operation: 'keyed-animation', applied: keyed, outcome: null });
  if (result.kind !== 'unsupported') throw Error('expected unsupported operation');
  expect(result.sessionBytes).toBe(input.sessionBytes);
});

test('known non-PASS producer diagnostics survive alongside PASS', () => {
  const diagnostic = { ...applied, check: { ...check, bars: { BOUND: 'PASS', OPTIONAL: 'SKIP', SUPPORT: 'UNCLASSIFIED' } } };
  const result = projectSessionCorrection({ ...sessionInput(diagnostic), path: 'made', settled: { ...settled, applied: diagnostic } });
  expect(result).toMatchObject({ kind: 'checked-patch', applied: diagnostic });
  for (const status of ['FAIL', 'UNKNOWN']) {
    const rejected = { ...diagnostic, check: { ...check, bars: { BOUND: 'PASS', OPTIONAL: status } } };
    expect(() => projectSessionCorrection({ ...sessionInput(rejected), path: 'made', settled: { ...settled, applied: rejected } })).toThrow('CORRECTION_CHECK_FAILED');
  }
});

test('checked handoff refuses missing and unknown producer check sources without changing diagnostics', () => {
  const { source: _source, ...noSource } = check;
  for (const [summary, error] of [[noSource, 'CORRECTION_CHECK_FAILED'], [{ ...check, source: 'unknown' }, 'CORRECTION_APPLY_INVALID']] as const) {
    const rejected = { ...applied, check: summary };
    const original = JSON.stringify(rejected);
    expect(() => projectSessionCorrection({ ...sessionInput(rejected), path: 'made', settled: { ...settled, applied: rejected } })).toThrow(error);
    expect(JSON.stringify(rejected)).toBe(original);
  }
});
