import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME_START_TIMEOUT_MS, launchChrome } from './helpers/software-capture.ts';

const endpoint = 'ws://127.0.0.1:43210/devtools/browser/unit-test';
const announce = `process.stderr.write(${JSON.stringify('DevTools listening on ' + endpoint + '\n')});`;
const keepAlive = 'setInterval(() => {}, 1000);';
const children: Awaited<ReturnType<typeof launchChrome>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => child.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test('default startup accepts a cold process beyond the former 15s deadline', async () => {
  expect(CHROME_START_TIMEOUT_MS).toBe(60_000);
  const child = await launchChrome([process.execPath, '-e', `await Bun.sleep(15_100); ${announce} ${keepAlive}`]);
  children.push(child);
  expect(child.endpoint).toBe(endpoint);
  expect(child.proc.exitCode).toBeNull();
}, 20_000);

test('passes caller flags/environment verbatim and owns the debugging switch and blank page', async () => {
  const script = `process.stderr.write(JSON.stringify({args:process.argv.slice(1),env:process.env.LAUNCH_UNIT})+${JSON.stringify('\n')}); ${announce} ${keepAlive}`;
  const args = ['--disable-gpu', '--force-color-profile=srgb', '--user-data-dir=profile with spaces'];
  const child = await launchChrome([process.execPath, '-e', script, '--', ...args], {
    env: { ...process.env, LAUNCH_UNIT: 'caller-value' },
  });
  children.push(child);
  const recorded = JSON.parse(child.stderrTail.split('\n')[0]!);
  expect(recorded).toEqual({ args: [...args, ['--remote', 'debugging-port=0'].join('-'), 'about:blank'], env: 'caller-value' });
});

test('reassembles an endpoint split across stderr chunks without accepting a partial URL', async () => {
  const prefix = 'DevTools listening on ws://127.0.0.1:43210/devtools/';
  const child = await launchChrome([process.execPath, '-e',
    `process.stderr.write(${JSON.stringify(prefix)}); await Bun.sleep(50); process.stderr.write(${JSON.stringify('browser/unit-test\n')}); ${keepAlive}`]);
  children.push(child);
  expect(child.endpoint).toBe(endpoint);
});

test('drains stderr after startup and bounds diagnostics while the child keeps running', async () => {
  const child = await launchChrome([process.execPath, '-e',
    `${announce} await Bun.sleep(50); await Bun.write(Bun.stderr, 'x'.repeat(512*1024)+${JSON.stringify('DRAINED\n')}); ${keepAlive}`]);
  children.push(child);
  for (let i = 0; i < 100 && !child.stderrTail.includes('DRAINED'); i++) await Bun.sleep(10);
  expect(child.stderrTail).toEndWith('DRAINED\n');
  expect(child.stderrTail.length).toBeLessThanOrEqual(4000);
  expect(child.proc.exitCode).toBeNull();
});

test('a silent live child times out, is killed and reaped before rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-start-unit-')); roots.push(root);
  const pidFile = join(root, 'pid');
  const script = `await Bun.write(${JSON.stringify(pidFile)},String(process.pid)); ${keepAlive}`;
  await expect(launchChrome([process.execPath, '-e', script], { startTimeoutMs: 400 }))
    .rejects.toThrow('Timed out waiting');
  const pid = Number(await readFile(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});

test('timeout preserves the bounded diagnostic tail', async () => {
  await expect(launchChrome([process.execPath, '-e', `process.stderr.write('x'.repeat(8000)+'STARTUP_FAILURE'); ${keepAlive}`],
    { startTimeoutMs: 400 })).rejects.toThrow('STARTUP_FAILURE');
});

test('an early exit refuses immediately with diagnostics instead of waiting for the deadline', async () => {
  const started = performance.now();
  await expect(launchChrome([process.execPath, '-e', "process.stderr.write('EARLY_EXIT');process.exit(7)"])).rejects.toThrow('EARLY_EXIT');
  expect(performance.now() - started).toBeLessThan(2000);
});

test('successful close is idempotent and waits for process exit', async () => {
  const child = await launchChrome([process.execPath, '-e', `${announce} ${keepAlive}`]);
  children.push(child);
  await Promise.all([child.close(), child.close()]);
  expect(await child.proc.exited).not.toBe(0);
  expect(() => process.kill(child.proc.pid, 0)).toThrow();
});

test('invalid startup deadlines refuse before spawning', async () => {
  for (const startTimeoutMs of [0, -1, Infinity, NaN]) {
    await expect(launchChrome(['invalid-command'], { startTimeoutMs })).rejects.toThrow('Invalid Chrome start timeout');
  }
});
