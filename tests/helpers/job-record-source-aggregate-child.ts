/** Disposable child. Register the source loader before importing any Review module. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const variant = Bun.argv[2];
assert.ok(variant === 'guarded' || variant === 'bypass');
const sourcePath = fileURLToPath(new URL('../../src/job-source.ts', import.meta.url));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(sourcePath, 'utf8');
const originalSha256 = hash(original);
const limit = 128 * 1024;
let loads = 0;
let transformedSha256 = '';

Bun.plugin({
  name: 'record-aggregate-limit-child-only',
  setup(builder) {
    builder.onLoad({ filter: /\/src\/job-source\.ts$/ }, ({ path }) => {
      assert.equal(path, sourcePath);
      loads++;
      const declaration = 'const maxSourceBytes = 256 * 1024 * 1024;';
      assert.equal(original.split(declaration).length, 2);
      let contents = original.replace(declaration, `const maxSourceBytes = ${limit};`);
      for (const legacyPredicate of ['total > maxSourceBytes', 'size > maxSourceBytes']) {
        assert.equal(contents.split(legacyPredicate).length, 2);
      }
      const recordPredicate = 'retainedBytes > maxSourceBytes';
      assert.equal(contents.split(recordPredicate).length, 2);
      if (variant === 'bypass') {
        contents = contents.replace(recordPredicate, 'false');
        assert.equal(contents.split(recordPredicate).length, 1);
        for (const legacyPredicate of ['total > maxSourceBytes', 'size > maxSourceBytes']) {
          assert.equal(contents.split(legacyPredicate).length, 2);
        }
      }
      assert.ok(contents.includes('const maxFileBytes = 64 * 1024 * 1024;'));
      assert.ok(contents.includes('width > Math.floor(maxFileBytes / 4 / height)'));
      assert.ok(contents.includes('inventory.files.length > maxSourceFiles'));
      transformedSha256 = hash(contents);
      console.log(
        JSON.stringify({
          stage: 'target-loaded',
          variant,
          sourcePath,
          originalSha256,
          transformedSha256,
          loweredLimit: limit,
        }),
      );
      return { contents, loader: 'ts' };
    });
  },
});

// Dynamic import is deliberately after registration so prepareJobRecordSource loads through the plugin.
const { captureJobRoot, prepareJobRecordSource } = await import('../../src/job-source.ts');
const { JobError } = await import('../../src/job-store.ts');
const {
  createSyntheticOptionRecordWorkspace,
  createSyntheticRecordReader,
  SYNTHETIC_RECORD_FIXTURE_MARKER,
  writeWorkspaceFile,
} = await import('./job-record-fixture.ts');
assert.equal(loads, 1, 'RECORD_AGGREGATE_TARGET_NOT_LOADED');

const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'review-561-rec-agg-work-')));
const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'review-561-rec-agg-state-')));
try {
  const fixture = createSyntheticOptionRecordWorkspace(workRoot, {
    questionId: 'rig_type',
    setId: 'set_rig_type_01',
    stage: 'interview',
  });
  assert.equal(fixture.marker, SYNTHETIC_RECORD_FIXTURE_MARKER);

  let baselineBytes = 0;
  for (const row of fixture.files) {
    baselineBytes += (await readFile(join(workRoot, row.path))).length;
  }
  assert.ok(baselineBytes < limit, 'RECORD_AGGREGATE_BASELINE_MUST_FIT');

  let activeFiles = [...fixture.files];
  const { reader, calls } = createSyntheticRecordReader({
    onOption: () => ({
      ...structuredClone(fixture.context),
      files: structuredClone(activeFiles),
    }),
  });

  const root = captureJobRoot(workRoot);
  const fingerprint = 'daemon-fp-record-aggregate\u0007-' + 'r'.repeat(160);
  const baselineRetained = await prepareJobRecordSource({
    root,
    stateRoot,
    fingerprint,
    request: {
      freeze: { kind: 'producer-held', holdId: 'hold_rec_agg_base', record: fixture.record },
      result: fixture.result,
    },
    readRecordPublished: reader,
  });
  assert.equal(baselineRetained.seals.length, fixture.files.length);
  assert.deepEqual(calls.map(c => c.phase), ['inventory', 'retained']);

  const extra = Buffer.alloc(limit, 42);
  assert.ok(extra.length < 64 * 1024 * 1024);
  const extraIdentity = writeWorkspaceFile(workRoot, 'inputs/retained-extra.bin', extra);
  activeFiles = [...fixture.files, extraIdentity].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const retainedBytes = baselineBytes + extra.length;
  assert.ok(retainedBytes > limit, 'RECORD_AGGREGATE_OVERLIMIT_MUST_EXCEED');

  const inputDigestBefore = await Promise.all(
    activeFiles.map(async row => ({ path: row.path, sha256: hash(await readFile(join(workRoot, row.path))) })),
  );
  const snapshotsDir = join(stateRoot, 'snapshots');
  const beforeSnapshots = readdirSync(snapshotsDir).sort();
  calls.length = 0;

  let outcome:
    | { ok: true; seals: number; sourceHash: string }
    | { ok: false; error: { code: string; message: string } };
  try {
    const overLimitRetained = await prepareJobRecordSource({
      root,
      stateRoot,
      fingerprint,
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_rec_agg_over', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });
    outcome = {
      ok: true,
      seals: overLimitRetained.seals.length,
      sourceHash: overLimitRetained.source.sourceHash,
    };
  } catch (err) {
    if (err instanceof JobError) {
      outcome = { ok: false, error: { code: err.code, message: err.message } };
    } else {
      throw err;
    }
  }

  const afterSnapshots = readdirSync(snapshotsDir).sort();
  const snapshotsUnchanged = JSON.stringify(afterSnapshots) === JSON.stringify(beforeSnapshots);
  const inputDigestAfter = await Promise.all(
    activeFiles.map(async row => ({ path: row.path, sha256: hash(await readFile(join(workRoot, row.path))) })),
  );
  assert.deepEqual(inputDigestAfter, inputDigestBefore, 'RECORD_AGGREGATE_INPUT_BYTES_CHANGED');

  const readerPhases = calls.map(c => c.phase);
  console.log(
    JSON.stringify({
      stage: 'result',
      marker: fixture.marker,
      variant,
      result: outcome,
      baselineBytes,
      extraBytes: extra.length,
      retainedBytes,
      readerPhases,
      snapshotsUnchanged,
      originalSha256,
      transformedSha256,
      loads,
    }),
  );

  assert.equal(outcome.ok, false, 'RECORD_AGGREGATE_REFUSAL_REQUIRED');
  assert.deepEqual(outcome.error, {
    code: 'JOB_SOURCE_UNRETAINABLE',
    message: 'JOB_SOURCE_UNRETAINABLE',
  });
  assert.deepEqual(readerPhases, ['inventory']);
  assert.equal(snapshotsUnchanged, true, 'RECORD_AGGREGATE_SNAPSHOT_LEAKED');
} finally {
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
  const restoredSha256 = hash(await readFile(sourcePath));
  console.log(JSON.stringify({ stage: 'source-unchanged', originalSha256, restoredSha256 }));
  assert.equal(restoredSha256, originalSha256);
}
