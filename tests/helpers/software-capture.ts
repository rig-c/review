/** Test-only CDP launcher: explicit capture configuration, with actual browser command line retained. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CdpSession } from '../parts-explorer-browser.ts';
export async function launchSoftwareCapture(profile: string): Promise<{ page: CdpSession; browser: unknown }> {
  const cache = join(homedir(), '.cache/ms-playwright');
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  if (existsSync(cache)) for (const entry of readdirSync(cache).sort()) for (const suffix of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) candidates.push(join(cache, entry, suffix));
  const bin = candidates.find((p): p is string => !!p && existsSync(p)); if (!bin) throw new Error('No installed Chrome for capture config');
  const flags = ['--headless=new', '--ozone-platform=headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-rasterization', '--force-color-profile=srgb', '--disable-lcd-text', '--disable-partial-raster', '--force-device-scale-factor=1', '--enable-automation', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio'];
  const env: Record<string, string | undefined> = { ...process.env, DBUS_SESSION_BUS_ADDRESS: '/dev/null', DBUS_SYSTEM_BUS_ADDRESS: '/dev/null' }; delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  const proc = Bun.spawn([bin, ...flags, 'about:blank'], { stdout: 'ignore', stderr: 'pipe', env });
  let stderr = '', endpoint = '';
  const reader = proc.stderr.getReader();
  const pump = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; stderr += new TextDecoder().decode(r.value); endpoint ||= /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1] ?? ''; } })();
  for (let i = 0; i < 400 && !endpoint; i++) { if (proc.exitCode !== null) throw new Error(`Chrome exited: ${stderr}`); await Bun.sleep(25); }
  if (!endpoint) { proc.kill(); throw new Error(`Chrome CDP timeout: ${stderr}`); }
  const ws = new WebSocket(endpoint); await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = event => { const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const version = await send('Browser.getVersion'), commandLine = await send('Browser.getBrowserCommandLine');
  for (const flag of flags) if (!commandLine.arguments.includes(flag)) throw new Error(`Browser command line missing ${flag}`);
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  const evaluate = async <T>(expression: string): Promise<T> => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value as T; };
  const page: CdpSession = {
    setViewport: async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId); },
    goto: async url => { await send('Page.navigate', { url }, sessionId); for (let i = 0; i < 200; i++) { try { if (await evaluate(`document.readyState==='complete'&&location.href===${JSON.stringify(url.split('#cap=')[0])}`)) return; } catch {} await Bun.sleep(25); } throw new Error(`Navigation timeout: ${url}`); },
    evaluate,
    screenshot: async clip => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId); return Buffer.from(r.data, 'base64'); },
    close: async () => { ws.close(); proc.kill(); await proc.exited; await pump; },
  };
  await page.goto('chrome://gpu/'); await Bun.sleep(500);
  const gpu = await page.evaluate<string>('document.body.innerText');
  return { page, browser: { binary: bin, version, commandLine, requestedFlags: flags, gpuStatus: gpu, deviceScaleFactor: 1 } };
}
