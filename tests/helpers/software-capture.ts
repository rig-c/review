/** Test-only CDP launcher: explicit capture configuration, with actual browser command line retained. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CdpSession } from '../parts-explorer-browser.ts';

// Hosted runners can take longer than 15s to start Chrome before any page exists.
export const CHROME_START_TIMEOUT_MS = 60_000;
const CHROME_DEBUGGING_FLAG = '--remote-debugging-port=0';

/** Shared process startup only: callers retain their renderer flags and CDP checks. */
export async function launchChrome(command: readonly string[], options: {
  env?: Record<string, string | undefined>;
  startTimeoutMs?: number;
} = {}) {
  const timeoutMs = options.startTimeoutMs ?? CHROME_START_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Chrome start timeout');
  const proc = Bun.spawn([...command, CHROME_DEBUGGING_FLAG, 'about:blank'], {
    stdout: 'ignore', stderr: 'pipe', env: options.env,
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let stderrTail = '';
  let ready = false;
  let resolveEndpoint!: (endpoint: string) => void;
  let rejectEndpoint!: (error: unknown) => void;
  const endpointPromise = new Promise<string>((resolve, reject) => {
    resolveEndpoint = resolve; rejectEndpoint = reject;
  });
  const timer = setTimeout(() => rejectEndpoint(new Error(
    `Timed out waiting for DevTools listening URL (${timeoutMs}ms): ${stderrTail}`,
  )), timeoutMs);
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        stderrTail = (stderrTail + decoder.decode(value, { stream: !done })).slice(-4000);
        // Wait for a complete line so a URL split between stderr chunks stays intact.
        const match = /^DevTools listening on (ws:\/\/[^\s]+)(?:\s|$)/m.exec(
          done ? stderrTail : stderrTail.slice(0, stderrTail.lastIndexOf('\n') + 1),
        );
        if (!ready && match) {
          ready = true;
          clearTimeout(timer);
          resolveEndpoint(match[1]!);
        }
        if (done) {
          if (!ready) rejectEndpoint(new Error(`Browser exited before printing DevTools URL: ${stderrTail}`));
          return;
        }
      }
    } catch (error) {
      if (!ready) rejectEndpoint(error);
    } finally {
      reader.releaseLock();
    }
  })();
  void proc.exited.then(code => {
    if (!ready) rejectEndpoint(new Error(`Browser exited (${code}) before printing DevTools URL: ${stderrTail}`));
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clearTimeout(timer);
    try { proc.kill(9); } catch {}
    await proc.exited;
    try { await reader.cancel(); } catch {}
    await pump;
  })();
  try {
    const endpoint = await endpointPromise;
    return { proc, endpoint, get stderrTail() { return stderrTail; }, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function launchSoftwareCapture(profile: string): Promise<{ page: CdpSession; browser: unknown }> {
  const cache = join(homedir(), '.cache/ms-playwright');
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  if (existsSync(cache)) for (const entry of readdirSync(cache).sort()) for (const suffix of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) candidates.push(join(cache, entry, suffix));
  const bin = candidates.find((p): p is string => !!p && existsSync(p)); if (!bin) throw new Error('No installed Chrome for capture config');
  const flags = ['--headless=new', '--ozone-platform=headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-rasterization', '--force-color-profile=srgb', '--disable-lcd-text', '--disable-partial-raster', '--force-device-scale-factor=1', '--enable-automation', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio'];
  const env: Record<string, string | undefined> = { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null', DBUS_SYSTEM_BUS_ADDRESS: '/dev/null' }; delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  const chrome = await launchChrome([bin, ...flags], { env });
  const { endpoint, close } = chrome;
  try {
    const ws = new WebSocket(endpoint); await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    let next = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    ws.onmessage = event => { const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const version = await send('Browser.getVersion'), commandLine = await send('Browser.getBrowserCommandLine');
    for (const flag of [...flags, CHROME_DEBUGGING_FLAG]) if (!commandLine.arguments.includes(flag)) throw new Error(`Browser command line missing ${flag}`);
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
    const evaluate = async <T>(expression: string): Promise<T> => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value as T; };
    const page: CdpSession = {
      setViewport: async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId); },
      goto: async url => { await send('Page.navigate', { url }, sessionId); for (let i = 0; i < 200; i++) { try { if (await evaluate(`document.readyState==='complete'&&location.href===${JSON.stringify(url.split('#cap=')[0])}`)) return; } catch {} await Bun.sleep(25); } throw new Error(`Navigation timeout: ${url}`); },
      evaluate,
      screenshot: async clip => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId); return Buffer.from(r.data, 'base64'); },
      close: async () => { ws.close(); await close(); },
    };
    await page.goto('chrome://gpu/'); await Bun.sleep(500);
    const gpu = await page.evaluate<string>('document.body.innerText');
    return { page, browser: { binary: bin, version, commandLine, requestedFlags: [...flags, CHROME_DEBUGGING_FLAG], gpuStatus: gpu, deviceScaleFactor: 1 } };
  } catch (error) {
    await close();
    throw error;
  }
}
