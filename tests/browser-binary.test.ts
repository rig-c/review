import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('browser finder prefers the macOS cache shell to full Chromium, with CHROME_BIN first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'review-browser-home-'));
  const cache = join(home, 'Library', 'Caches', 'ms-playwright');
  const shell = join(cache, 'chromium_headless_shell-1248', `chrome-headless-shell-mac-${process.arch}`, 'chrome-headless-shell');
  const chromium = join(cache, 'chromium-1248', `chrome-mac-${process.arch}`, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');

  function find(override: string): string {
    const result = Bun.spawnSync([
      process.execPath, '-e', `
        import { findBrowserBinary } from './tests/parts-explorer-browser.ts';
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        console.log(findBrowserBinary());
      `,
    ], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, HOME: home, USERPROFILE: home, CHROME_BIN: override },
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  }

  try {
    for (const binary of [chromium, shell]) {
      await mkdir(dirname(binary), { recursive: true });
      await writeFile(binary, '', { mode: 0o755 });
    }
    expect(find('')).toBe(shell);
    expect(find(chromium)).toBe(chromium);
    await rm(shell);
    expect(find('')).toBe(chromium);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
