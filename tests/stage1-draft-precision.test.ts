import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { observerEnv, type ObserverScope } from '../.review-562-sol-input/observe-tool-stderr.ts';

test('owned stderr observer preserves native stream bytes, stdout, exit and unmatched spawn', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-562-stderr-control-')));
  try {
    const control = join(root, 'open');
    const receiptDir = join(root, 'receipts');
    await mkdir(control);
    await mkdir(receiptDir);
    const worker = join(root, 'probe-worker.ts');
    const matching = join(root, 'matched.ts');
    const unmatched = join(root, 'unmatched.ts');
    const request = join(control, 'probe.local.request.json');
    const childSource = `
      if (process.env.REVIEW_562_STDERR_OBSERVER || process.env.BUN_OPTIONS) process.exit(71);
      process.stdout.write(Buffer.from([111, 0, 255]));
      process.stderr.write(Buffer.from([255, 10, 226]));
      await Bun.sleep(100);
      process.stderr.write(Buffer.from([130, 172, 0, 13]));
      process.exit(29);
    `;
    await writeFile(matching, childSource);
    await writeFile(unmatched, childSource);
    await writeFile(request, JSON.stringify({
      schema: 'rig-review-open-request/1', request, stateDir: root, cwd: root,
      inputs: { input: root, project: { root } }, identity: { key: 'probe', nonce: 'local' },
    }));
    await writeFile(worker, `
      for (const bin of ${JSON.stringify([matching, unmatched])}) {
        const argv = [process.execPath, bin, '--probe'];
        const options = { cwd: ${JSON.stringify(root)}, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' };
        const child = Bun.spawn(argv, options);
        const read = async (stream) => {
          const chunks = [];
          for await (const chunk of stream) chunks.push([...chunk]);
          return chunks;
        };
        const [stdout, stderr, exitCode] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
        console.log(JSON.stringify({ argv, cwd: options.cwd, pid: child.pid, stdout: stdout.flat(), stderr, exitCode }));
      }
    `);
    const scope: ObserverScope = {
      worker, stateDir: root, toolchainRoot: root, projectRoot: root, input: root, receiptDir,
      bins: [matching], originalBunOptions: undefined,
    };
    const child = Bun.spawn([process.execPath, worker, request], {
      cwd: control, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, [observerEnv]: JSON.stringify(scope),
        BUN_OPTIONS: `--preload=${resolve(import.meta.dir, '../.review-562-sol-input/observe-tool-stderr.ts')}` },
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const [matched, controlRun] = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect((await readdir(receiptDir)).sort()).toEqual(['process-1', 'worker.json']);
    const receipt = join(receiptDir, 'process-1');
    const result = JSON.parse(await readFile(join(receipt, 'result.json'), 'utf8'));
    const expected = [255, 10, 226, 130, 172, 0, 13];
    expect(matched.stderr.length).toBeGreaterThanOrEqual(2);
    expect(matched.stderr.flat()).toEqual(expected);
    expect(controlRun.stderr.flat()).toEqual(expected);
    expect([...await readFile(join(receipt, 'stderr.bin'))]).toEqual(matched.stderr.flat());
    expect(matched.stdout).toEqual([111, 0, 255]);
    expect(controlRun.stdout).toEqual(matched.stdout);
    expect(matched.exitCode).toBe(29);
    expect(controlRun.exitCode).toBe(29);
    expect(matched.pid).toBeGreaterThan(0);
    expect(controlRun.pid).toBeGreaterThan(0);
    expect(result).toEqual({ argv: matched.argv, cwd: root, pid: matched.pid, reads: matched.stderr.length,
      exitCode: 29, stderr: 'stderr.bin' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
