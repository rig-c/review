import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const childPath = fileURLToPath(new URL('./helpers/job-source-aggregate-child.ts', import.meta.url));
const sourcePath = fileURLToPath(new URL('../src/job-source.ts', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

for (const mode of ['referenced', 'retained']) {
  test(`aggregate cap ${mode} control catches the bypass mutant and preserves guarded head`, async () => {
    const original = hash(await readFile(sourcePath));
    for (const variant of ['bypass', 'guarded']) {
      const child = Bun.spawn([process.execPath, childPath, mode, variant], {stdout: 'pipe', stderr: 'pipe'});
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const artifactDir = process.env.REVIEW_AGGREGATE_ARTIFACTS;
      if (artifactDir) {
        await mkdir(artifactDir, {recursive: true});
        const name = join(artifactDir, `${mode}-${variant}`);
        await writeFile(name + '.stdout', stdout);
        await writeFile(name + '.stderr', stderr);
        await writeFile(name + '.exit', String(exit) + '\n');
      }
      expect(hash(await readFile(sourcePath))).toBe(original);
      const lines = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(lines[0]).toMatchObject({stage: 'target-loaded', mode, variant, originalSha256: original,
        loweredLimit: 128 * 1024});
      const result = lines.find(line => line.stage === 'result');
      expect(result).toBeDefined();
      expect(result.loads).toBe(1);
      expect(result.retainedBytes).toBeGreaterThan(128 * 1024);
      if (mode === 'referenced') expect(result.referencedBytes).toBeGreaterThan(128 * 1024);
      else expect(result.referencedBytes).toBeLessThan(128 * 1024);
      expect(lines.at(-1)).toEqual({stage: 'source-unchanged', originalSha256: original, restoredSha256: original});
      if (variant === 'bypass') {
        expect(exit).toBe(1);
        expect(stderr).toContain('AGGREGATE_REFUSAL_REQUIRED');
        expect(result.result.ok).toBe(true);
        expect(result.headUnchanged).toBe(false);
      } else {
        expect({exit, stderr}).toEqual({exit: 0, stderr: ''});
        expect(result.result.ok).toBe(false);
        expect(result.headUnchanged).toBe(true);
      }
      console.log(JSON.stringify({mode, variant, exit, originalSha256: original,
        transformedSha256: result.transformedSha256, result: result.result, headUnchanged: result.headUnchanged}));
    }
  }, 30_000);
}
