import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_RECORD_FIXTURE_MARKER } from './helpers/job-record-fixture.ts';

const childPath = fileURLToPath(new URL('./helpers/job-record-source-aggregate-child.ts', import.meta.url));
const sourcePath = fileURLToPath(new URL('../src/job-source.ts', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('[SYNTHETIC] record aggregate cap control catches the planted bypass mutant and refuses over-limit closure with JOB_SOURCE_UNRETAINABLE', async () => {
  const original = hash(await readFile(sourcePath));
  for (const variant of ['bypass', 'guarded'] as const) {
    const child = Bun.spawn([process.execPath, childPath, variant], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const artifactDir = process.env.REVIEW_RECORD_AGGREGATE_ARTIFACTS;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      const name = join(artifactDir, `record-retained-${variant}`);
      await writeFile(name + '.stdout', stdout);
      await writeFile(name + '.stderr', stderr);
      await writeFile(name + '.exit', String(exit) + '\n');
    }
    expect(hash(await readFile(sourcePath))).toBe(original);
    const lines = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      stage: 'target-loaded',
      variant,
      originalSha256: original,
      loweredLimit: 128 * 1024,
    });
    const result = lines.find(line => line.stage === 'result');
    expect(result).toBeDefined();
    expect(result.marker).toBe(SYNTHETIC_RECORD_FIXTURE_MARKER);
    expect(result.loads).toBe(1);
    expect(result.baselineBytes).toBeLessThan(128 * 1024);
    expect(result.retainedBytes).toBeGreaterThan(128 * 1024);
    expect(lines.at(-1)).toEqual({
      stage: 'source-unchanged',
      originalSha256: original,
      restoredSha256: original,
    });
    if (variant === 'bypass') {
      expect(exit).toBe(1);
      expect(stderr).toContain('RECORD_AGGREGATE_REFUSAL_REQUIRED');
      expect(result.result.ok).toBe(true);
      expect(result.readerPhases).toEqual(['inventory', 'retained']);
      expect(result.snapshotsUnchanged).toBe(false);
    } else {
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      expect(result.result).toEqual({
        ok: false,
        error: { code: 'JOB_SOURCE_UNRETAINABLE', message: 'JOB_SOURCE_UNRETAINABLE' },
      });
      expect(result.readerPhases).toEqual(['inventory']);
      expect(result.snapshotsUnchanged).toBe(true);
    }
    console.log(
      JSON.stringify({
        mode: 'record-retained',
        marker: result.marker,
        variant,
        exit,
        originalSha256: original,
        transformedSha256: result.transformedSha256,
        result: result.result,
        readerPhases: result.readerPhases,
        snapshotsUnchanged: result.snapshotsUnchanged,
      }),
    );
  }
}, 30_000);
