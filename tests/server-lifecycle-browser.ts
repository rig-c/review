/**
 * Browser verification for issue #236:
 * - Single-review and compare servers exit 0 and free their port within the stated grace period + margin
 *   after the only open browser tab closes, printing one reason line.
 * - Reloading an open tab or closing one of two open tabs does not stop the server; closing the remaining
 *   tab stops it after the grace period.
 * - Killing the browser process with SIGKILL (-9, no pagehide or sendBeacon) tears down the loopback
 *   socket so the server exits 0 within the grace period + margin and frees its port.
 * - Opening 8 browser windows across 2 managed-front instances (sharing one front origin) does not exhaust
 *   the browser's 6-connection HTTP/1.1 pool: all 8 windows load promptly, feedback save in the 8th window
 *   completes, and a 9th page loads cleanly.
 * - Dropping the live socket while the only browser window remains open reconnects within the grace period
 *   so the server survives.
 * - Uses generated fixtures only; never conditionally enters external directories.
 */
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReview } from '../src/open.ts';

export interface CloseBarResult {
  pageKind: 'single' | 'compare';
  graceMs: number;
  marginMs: number;
  elapsedMs: number;
  exitCode: number | null;
  portFreed: boolean;
  exitLine: string | null;
  passed: boolean;
}

export interface ReloadAndTwoTabsResult {
  pageKind: 'single' | 'compare';
  graceMs: number;
  aliveAfterReload: boolean;
  connectionsAfterReload: number;
  uiIntactAfterReload: boolean;
  connectionsWithTwoTabs: number;
  aliveAfterFirstTabClosed: boolean;
  connectionsAfterFirstTabClosed: number;
  exitedAfterSecondTabClosed: boolean;
  elapsedAfterSecondTabCloseMs: number;
  passed: boolean;
}

export interface KilledBrowserResult {
  graceMs: number;
  marginMs: number;
  pagehideUsed: false;
  elapsedMs: number;
  exitCode: number | null;
  portFreed: boolean;
  exitLine: string | null;
  passed: boolean;
}

export interface EightManagedFrontWindowsResult {
  frontOrigin: string;
  instancesCount: number;
  windowsOpened: number;
  windowLoadTimesMs: number[];
  allEightLoadedWithin3s: boolean;
  eighthWindowSaveStatus: number;
  eighthWindowSavedReviewStatus: string | null;
  ninthPageLoaded: boolean;
  ninthPageLoadMs: number;
  workersExitedAfterAllClosed: boolean;
  passed: boolean;
}

export interface DroppedSocketReconnectResult {
  graceMs: number;
  droppedCount: number;
  reconnectedWithinGrace: boolean;
  reconnectElapsedMs: number;
  aliveAfterGrace: boolean;
  connectionsAfterGrace: number;
  uiIntactAfterGrace: boolean;
  passed: boolean;
}

export interface ServerLifecycleBrowserReport {
  browserBinary: string;
  closeBars: CloseBarResult[];
  reloadAndTwoTabs: ReloadAndTwoTabsResult[];
  killedBrowser: KilledBrowserResult;
  eightManagedFrontWindows: EightManagedFrontWindowsResult;
  droppedSocketReconnect: DroppedSocketReconnectResult;
  failures: string[];
}

function findBrowserBinary(): string {
  const pwRoot = join(homedir(), '.cache', 'ms-playwright');
  const pwCandidates: string[] = [];
  if (existsSync(pwRoot)) {
    try {
      const entries = readdirSync(pwRoot).sort();
      for (const entry of [
        ...entries.filter(e => e.startsWith('chromium-')),
        ...entries.filter(e => e.startsWith('chromium_headless_shell')),
      ]) {
        pwCandidates.push(
          join(pwRoot, entry, 'chrome-linux', 'chrome'),
          join(pwRoot, entry, 'chrome-linux64', 'chrome'),
          join(pwRoot, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
          join(pwRoot, entry, 'chrome-linux', 'headless_shell'),
        );
      }
    } catch {}
  }
  const candidates = [
    process.env.CHROME_BIN,
    ...pwCandidates,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const name of ['chrome', 'msedge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const res = Bun.spawnSync([whichCmd, name], { stdout: 'pipe', stderr: 'pipe' });
    if (res.exitCode === 0) {
      const line = new TextDecoder().decode(res.stdout).split(/\r?\n/)[0]?.trim();
      if (line) return line;
    }
  }
  throw new Error('No headless Chromium/Chrome/Edge binary found');
}

function freePort(): number {
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = srv.port!;
  srv.stop(true);
  return port;
}

interface CdpBrowser {
  bin: string;
  proc: Bun.Subprocess;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  openTab(url: string, readySelector: string, timeoutMs?: number): Promise<{ targetId: string; sessionId: string; elapsedMs: number }>;
  evaluate<T>(sessionId: string, expression: string): Promise<T>;
  closeTab(targetId: string): Promise<void>;
  killHard(): Promise<void>;
  close(): Promise<void>;
}

async function launchCdpBrowser(profileDir: string): Promise<CdpBrowser> {
  const bin = findBrowserBinary();
  const isHeadlessShell = bin.includes('headless');
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: '/dev/null',
    DBUS_SYSTEM_BUS_ADDRESS: '/dev/null',
  };
  delete childEnv.DISPLAY;
  delete childEnv.WAYLAND_DISPLAY;
  const proc = Bun.spawn(
    [
      bin,
      isHeadlessShell ? '--headless' : '--headless=new',
      '--ozone-platform=headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--in-process-gpu',
      '--use-gl=angle',
      '--use-angle=swiftshader-webgl',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    {
      stdout: 'ignore',
      stderr: 'pipe',
      env: childEnv,
    },
  );

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let stderrTail = '';
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for DevTools URL: ' + stderrTail)), 15_000);
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          stderrTail += decoder.decode(value, { stream: true });
          if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
          const match = stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]!);
            return;
          }
        }
        clearTimeout(timer);
        reject(new Error(`Browser exited before DevTools URL: ${stderrTail}`));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    })();
  });
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrTail += decoder.decode(value, { stream: true });
        if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      }
    } catch {}
  })();

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = err => reject(err);
  });

  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (val: any) => void; reject: (err: Error) => void }>();
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else entry.resolve(msg.result);
      }
    }
  };
  ws.onclose = () => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`WebSocket closed during ${entry.method}`));
    }
    pending.clear();
  };

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const evaluate = async <T>(sessionId: string, expression: string): Promise<T> => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (res?.exceptionDetails) {
      throw new Error(`Evaluate error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value as T;
  };

  const openTab = async (
    url: string,
    readySelector: string,
    timeoutMs = 6_000,
  ): Promise<{ targetId: string; sessionId: string; elapsedMs: number }> => {
    const startAt = performance.now();
    const { targetId } = await send('Target.createTarget', { url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    const deadline = startAt + timeoutMs;
    while (performance.now() < deadline) {
      const ok = await evaluate<boolean>(
        sessionId,
        `document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(readySelector)}))`,
      ).catch(() => false);
      if (ok) {
        return { targetId, sessionId, elapsedMs: r2(performance.now() - startAt) };
      }
      await Bun.sleep(25);
    }
    throw new Error(`Timed out waiting for ${readySelector} on ${url}`);
  };

  const closeTab = async (targetId: string): Promise<void> => {
    await send('Target.closeTarget', { targetId });
  };

  const killHard = async (): Promise<void> => {
    try {
      ws.close();
    } catch {}
    if (process.platform !== 'win32') {
      try {
        Bun.spawnSync(['pkill', '-9', '-P', String(proc.pid)]);
      } catch {}
    }
    try {
      proc.kill(9);
    } catch {}
    await proc.exited.catch(() => {});
  };

  return {
    bin,
    proc,
    send,
    openTab,
    evaluate,
    closeTab,
    killHard,
    close: killHard,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function isPortListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

interface SpawnedReviewServer {
  proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  port: number;
  url: string;
  getConnections(): Promise<number>;
  waitForConnections(expected: number, timeoutMs?: number): Promise<number>;
  dropSockets(): Promise<number>;
  waitForExit(timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; exitLine: string | null }>;
  kill(): Promise<void>;
}

async function spawnServerProcess(options: {
  mode: 'single' | 'compare';
  pkgA: string;
  pkgB: string;
  ref: string;
  stateDir: string;
  graceMs: number;
  unopenedTimeoutMs: number;
}): Promise<SpawnedReviewServer> {
  const bootstrap =
    options.mode === 'single'
      ? `
        import { loadReview } from './src/manifest.ts';
        import { startServer } from './src/server.ts';
        const p = await loadReview(${JSON.stringify(options.pkgA)});
        const s = await startServer(p, {
          port: 0,
          stateDir: ${JSON.stringify(options.stateDir)},
          graceMs: ${options.graceMs},
          unopenedTimeoutMs: ${options.unopenedTimeoutMs},
          exitOnClose: true,
        });
      `
      : `
        import { loadCompare } from './src/compare.ts';
        import { startCompareServer } from './src/compare-server.ts';
        const p = await loadCompare({
          a: ${JSON.stringify(options.pkgA)},
          b: ${JSON.stringify(options.pkgB)},
          reference: ${JSON.stringify(options.ref)},
          animation: 'inspect',
        });
        const s = await startCompareServer(p, {
          port: 0,
          stateDir: ${JSON.stringify(options.stateDir)},
          graceMs: ${options.graceMs},
          unopenedTimeoutMs: ${options.unopenedTimeoutMs},
          exitOnClose: true,
        });
      `;

  const script = `
    ${bootstrap}
    console.log('READY port=' + s.port);
    setInterval(() => console.log('CONN=' + s.live.connections), 25).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (String(chunk).includes('DROP')) {
        const dropped = s.live.dropSockets();
        console.log('DROPPED=' + dropped + ' CONN=' + s.live.connections);
      }
    });
  `;

  const proc = Bun.spawn([process.execPath, '-e', script], {
    cwd: join(import.meta.dir, '..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  let lastConnections = 0;
  let droppedRecords = 0;
  let lastDroppedCount = 0;
  let streamDone = false;

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
        const matches = [...stdout.matchAll(/CONN=(\d+)/g)];
        if (matches.length > 0) {
          lastConnections = Number(matches[matches.length - 1]![1]);
        }
        const dropMatches = [...stdout.matchAll(/DROPPED=(\d+)/g)];
        if (dropMatches.length > droppedRecords) {
          droppedRecords = dropMatches.length;
          lastDroppedCount = Number(dropMatches[dropMatches.length - 1]![1]);
        }
      }
    } catch {}
    streamDone = true;
  })();

  for (let i = 0; i < 300; i++) {
    const m = /READY port=(\d+)/.exec(stdout);
    if (m) {
      const port = Number(m[1]);
      return {
        proc,
        port,
        url: `http://127.0.0.1:${port}/`,
        async getConnections() {
          await Bun.sleep(40);
          return lastConnections;
        },
        async waitForConnections(expected: number, timeoutMs = 5_000) {
          const deadline = performance.now() + timeoutMs;
          while (performance.now() < deadline) {
            if (lastConnections === expected) return lastConnections;
            await Bun.sleep(20);
          }
          return lastConnections;
        },
        async dropSockets() {
          const prev = droppedRecords;
          proc.stdin.write('DROP\n');
          proc.stdin.flush();
          const deadline = performance.now() + 2_000;
          while (performance.now() < deadline) {
            if (droppedRecords > prev) return lastDroppedCount;
            await Bun.sleep(15);
          }
          return lastDroppedCount;
        },
        async waitForExit(timeoutMs: number) {
          const code = await Promise.race([
            proc.exited,
            Bun.sleep(timeoutMs).then(() => null),
          ]);
          if (code !== null) {
            await pump;
          }
          const lines = stdout
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.startsWith('review'));
          return {
            exitCode: code,
            stdout,
            exitLine: lines[lines.length - 1] ?? null,
          };
        },
        async kill() {
          if (!streamDone) {
            try {
              proc.kill('SIGTERM');
            } catch {}
            await proc.exited.catch(() => {});
          }
        },
      };
    }
    await Bun.sleep(25);
  }
  await proc.kill('SIGTERM');
  throw new Error(`Server failed to become ready: ${stdout}`);
}

export async function runServerLifecycleBrowserVerification(options?: {
  assertBars?: boolean;
}): Promise<ServerLifecycleBrowserReport> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-236-browser-')));
  const pkgA = join(root, 'pkg-a');
  const pkgB = join(root, 'pkg-b');
  const ref = join(root, 'reference.mov');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkgA, { recursive: true });
  await cp(pkgA, pkgB, { recursive: true });
  await cp(join(pkgA, 'reference.mov'), ref);

  const mainProfile = join(root, 'chrome-main');
  await mkdir(mainProfile, { recursive: true });

  const closeBars: CloseBarResult[] = [];
  const reloadAndTwoTabs: ReloadAndTwoTabsResult[] = [];
  const failures: string[] = [];
  let browser: CdpBrowser | null = null;
  let killedBrowserResult: KilledBrowserResult | null = null;
  let eightManagedFrontWindows: EightManagedFrontWindowsResult | null = null;
  let droppedSocketReconnect: DroppedSocketReconnectResult | null = null;

  try {
    browser = await launchCdpBrowser(mainProfile);

    // 1. Close-only-tab exit timing, exit code 0, freed port, and reason line (single & compare)
    for (const pageKind of ['single', 'compare'] as const) {
      const graceMs = 600;
      const marginMs = 1_000;
      const readySelector = pageKind === 'single' ? '#rig-root canvas, #rig-root img' : '#a-root canvas, #a-root img';
      const srv = await spawnServerProcess({
        mode: pageKind,
        pkgA,
        pkgB,
        ref,
        stateDir: join(root, `state-close-${pageKind}`),
        graceMs,
        unopenedTimeoutMs: 30_000,
      });
      try {
        const tab = await browser.openTab(srv.url, readySelector);
        await srv.waitForConnections(1);
        const closeAt = performance.now();
        await browser.closeTab(tab.targetId);
        const { exitCode, exitLine } = await srv.waitForExit(graceMs + marginMs);
        const elapsedMs = r2(performance.now() - closeAt);
        const portFreed = !(await isPortListening(srv.port));
        const expectedPrefix =
          pageKind === 'single'
            ? `review: exiting — last review window closed (0 live connections for ${graceMs}ms).`
            : `review compare: exiting — last review window closed (0 live connections for ${graceMs}ms).`;
        const passed =
          exitCode === 0 &&
          portFreed &&
          elapsedMs >= graceMs - 100 &&
          elapsedMs <= graceMs + marginMs &&
          exitLine === expectedPrefix;
        if (!passed) {
          failures.push(
            `Close bar (${pageKind}) failed: exitCode=${exitCode}, portFreed=${portFreed}, elapsedMs=${elapsedMs}, exitLine=${JSON.stringify(exitLine)}`,
          );
        }
        closeBars.push({
          pageKind,
          graceMs,
          marginMs,
          elapsedMs,
          exitCode,
          portFreed,
          exitLine,
          passed,
        });
      } finally {
        await srv.kill();
      }
    }

    // 2. Reload and two-tab behavior on both single and compare pages
    for (const pageKind of ['single', 'compare'] as const) {
      const graceMs = 500;
      const readySelector = pageKind === 'single' ? '#rig-root canvas, #rig-root img' : '#a-root canvas, #a-root img';
      const srv = await spawnServerProcess({
        mode: pageKind,
        pkgA,
        pkgB,
        ref,
        stateDir: join(root, `state-reload-${pageKind}`),
        graceMs,
        unopenedTimeoutMs: 30_000,
      });
      try {
        const tab1 = await browser.openTab(srv.url, readySelector);
        await srv.waitForConnections(1);

        // Reload tab 1 and wait past graceMs
        await browser.send('Page.reload', {}, tab1.sessionId);
        await Bun.sleep(graceMs + 250);
        const connectionsAfterReload = await srv.waitForConnections(1, 2_000);
        const aliveAfterReload = srv.proc.exitCode === null && (await isPortListening(srv.port));
        const uiIntactAfterReload = await browser.evaluate<boolean>(
          tab1.sessionId,
          `Boolean(document.querySelector(${JSON.stringify(readySelector)})) && Boolean(document.getElementById('scrub')) && Boolean(document.getElementById('layer-mesh'))`,
        );

        // Open tab 2 to the same URL
        const tab2 = await browser.openTab(srv.url, readySelector);
        const connectionsWithTwoTabs = await srv.waitForConnections(2, 3_000);

        // Close tab 1 and wait past graceMs: server must stay alive because tab 2 is still open
        await browser.closeTab(tab1.targetId);
        await Bun.sleep(graceMs + 250);
        const connectionsAfterFirstTabClosed = await srv.waitForConnections(1, 2_000);
        const aliveAfterFirstTabClosed = srv.proc.exitCode === null && (await isPortListening(srv.port));

        // Close tab 2: server must now exit 0 after graceMs
        const closeSecondAt = performance.now();
        await browser.closeTab(tab2.targetId);
        const { exitCode } = await srv.waitForExit(graceMs + 1_200);
        const elapsedAfterSecondTabCloseMs = r2(performance.now() - closeSecondAt);
        const exitedAfterSecondTabClosed = exitCode === 0 && !(await isPortListening(srv.port));

        const passed =
          aliveAfterReload &&
          connectionsAfterReload === 1 &&
          uiIntactAfterReload &&
          connectionsWithTwoTabs === 2 &&
          aliveAfterFirstTabClosed &&
          connectionsAfterFirstTabClosed === 1 &&
          exitedAfterSecondTabClosed;
        if (!passed) {
          failures.push(
            `Reload/2-tab bar (${pageKind}) failed: ${JSON.stringify({
              aliveAfterReload,
              connectionsAfterReload,
              uiIntactAfterReload,
              connectionsWithTwoTabs,
              aliveAfterFirstTabClosed,
              connectionsAfterFirstTabClosed,
              exitedAfterSecondTabClosed,
            })}`,
          );
        }
        reloadAndTwoTabs.push({
          pageKind,
          graceMs,
          aliveAfterReload,
          connectionsAfterReload,
          uiIntactAfterReload,
          connectionsWithTwoTabs,
          aliveAfterFirstTabClosed,
          connectionsAfterFirstTabClosed,
          exitedAfterSecondTabClosed,
          elapsedAfterSecondTabCloseMs,
          passed,
        });
      } finally {
        await srv.kill();
      }
    }

    // 3. Killed browser process (SIGKILL -9, no pagehide or sendBeacon)
    const killGraceMs = 500;
    const killMarginMs = 1_000;
    const killSrv = await spawnServerProcess({
      mode: 'single',
      pkgA,
      pkgB,
      ref,
      stateDir: join(root, 'state-kill'),
      graceMs: killGraceMs,
      unopenedTimeoutMs: 30_000,
    });
    const victimProfile = join(root, 'chrome-victim');
    await mkdir(victimProfile, { recursive: true });
    let victimBrowser: CdpBrowser | null = null;
    try {
      victimBrowser = await launchCdpBrowser(victimProfile);
      await victimBrowser.openTab(killSrv.url, '#rig-root canvas, #rig-root img');
      await killSrv.waitForConnections(1);

      const killAt = performance.now();
      await victimBrowser.killHard();
      victimBrowser = null;

      const { exitCode, exitLine } = await killSrv.waitForExit(killGraceMs + killMarginMs);
      const elapsedMs = r2(performance.now() - killAt);
      const portFreed = !(await isPortListening(killSrv.port));
      const expectedLine = `review: exiting — last review window closed (0 live connections for ${killGraceMs}ms).`;
      const passed =
        exitCode === 0 &&
        portFreed &&
        elapsedMs >= killGraceMs - 100 &&
        elapsedMs <= killGraceMs + killMarginMs &&
        exitLine === expectedLine;
      if (!passed) {
        failures.push(
          `Killed browser bar failed: exitCode=${exitCode}, portFreed=${portFreed}, elapsedMs=${elapsedMs}, exitLine=${JSON.stringify(exitLine)}`,
        );
      }
      killedBrowserResult = {
        graceMs: killGraceMs,
        marginMs: killMarginMs,
        pagehideUsed: false,
        elapsedMs,
        exitCode,
        portFreed,
        exitLine,
        passed,
      };
    } finally {
      if (victimBrowser) await victimBrowser.close();
      await killSrv.kill();
    }

    // 4. Eight windows across 2 managed-front instances (same front origin):
    //    feedback save in the 8th window completes and a 9th page loads
    const frontPkg1 = join(root, 'front-pkg-1');
    const frontPkg2 = join(root, 'front-pkg-2');
    await mkdir(frontPkg1, { recursive: true });
    await mkdir(frontPkg2, { recursive: true });
    await cp(join(pkgA, 'build'), join(frontPkg1, 'build'), { recursive: true });
    await cp(join(pkgA, 'motion.json'), join(frontPkg1, 'motion.json'));
    await cp(join(pkgA, 'build'), join(frontPkg2, 'build'), { recursive: true });
    await cp(join(pkgA, 'motion.json'), join(frontPkg2, 'motion.json'));
    await writeFile(
      join(frontPkg2, 'report.json'),
      JSON.stringify({ spec: 'rig-pose-report/1', animation: 'inspect', frameTimes: [0, 0.5, 1] }),
    );
    const frontStateDir = join(root, 'state-front-8');
    const frontPort = freePort();
    const open1 = await openReview(
      { input: frontPkg1, animation: 'inspect' },
      { stateDir: frontStateDir, frontPort, graceMs: 600, idleMs: 10_000 },
    );
    const open2 = await openReview(
      { input: frontPkg2, animation: 'inspect' },
      { stateDir: frontStateDir, frontPort, graceMs: 600, idleMs: 10_000 },
    );
    const frontOrigin = new URL(open1.url).origin;
    const cap2 = new URL(open2.url).hash.slice(5);
    const base2Path = new URL(open2.url).pathname;

    const openedTabs: { targetId: string; sessionId: string; elapsedMs: number }[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        const targetUrl = i < 4 ? open1.url : open2.url;
        const t = await browser.openTab(targetUrl, '#rig-root canvas, #rig-root img', 5_000);
        openedTabs.push(t);
      }
      const windowLoadTimesMs = openedTabs.map(t => t.elapsedMs);
      const allEightLoadedWithin3s = windowLoadTimesMs.length === 8 && windowLoadTimesMs.every(ms => ms < 3_000);

      // In the 8th window (openedTabs[7]), save feedback session through the shared front origin
      const tab8 = openedTabs[7]!;
      const saveResult = await browser.evaluate<{ status: number; reviewStatus: string | null }>(
        tab8.sessionId,
        `(async () => {
          const curRes = await fetch(${JSON.stringify(base2Path + 'api/session')});
          const cur = await curRes.json();
          const putRes = await fetch(${JSON.stringify(base2Path + 'api/session')}, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-Review-Capability': ${JSON.stringify(cap2)},
            },
            body: JSON.stringify({
              ...cur,
              status: 'approved',
              notes: 'Saved in 8th managed-front browser window',
            }),
          });
          const body = await putRes.json().catch(() => null);
          return { status: putRes.status, reviewStatus: body?.status ?? null };
        })()`,
      );

      // Open a 9th browser window while all 8 are still open
      const tab9 = await browser.openTab(open1.url, '#rig-root canvas, #rig-root img', 5_000);
      openedTabs.push(tab9);
      const ninthPageLoaded = true;
      const ninthPageLoadMs = tab9.elapsedMs;

      // Close all 9 windows and verify both workers exit cleanly
      for (const t of openedTabs.splice(0)) {
        await browser.closeTab(t.targetId);
      }
      let workersExitedAfterAllClosed = false;
      for (let i = 0; i < 80; i++) {
        const openFiles = (await readdir(join(frontStateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
        if (openFiles.length === 0) {
          workersExitedAfterAllClosed = true;
          break;
        }
        await Bun.sleep(50);
      }

      const passed =
        allEightLoadedWithin3s &&
        saveResult.status === 200 &&
        saveResult.reviewStatus === 'approved' &&
        ninthPageLoaded &&
        ninthPageLoadMs < 3_000 &&
        workersExitedAfterAllClosed;
      if (!passed) {
        failures.push(
          `Eight managed-front windows bar failed: ${JSON.stringify({
            windowLoadTimesMs,
            allEightLoadedWithin3s,
            saveResult,
            ninthPageLoaded,
            ninthPageLoadMs,
            workersExitedAfterAllClosed,
          })}`,
        );
      }
      eightManagedFrontWindows = {
        frontOrigin,
        instancesCount: 2,
        windowsOpened: 8,
        windowLoadTimesMs,
        allEightLoadedWithin3s,
        eighthWindowSaveStatus: saveResult.status,
        eighthWindowSavedReviewStatus: saveResult.reviewStatus,
        ninthPageLoaded,
        ninthPageLoadMs,
        workersExitedAfterAllClosed,
        passed,
      };
    } finally {
      for (const t of openedTabs.splice(0)) {
        await browser.closeTab(t.targetId).catch(() => {});
      }
    }

    // 5. Dropped live socket while the only browser window is open reconnects within graceMs and server survives
    const dropGraceMs = 700;
    const dropSrv = await spawnServerProcess({
      mode: 'single',
      pkgA,
      pkgB,
      ref,
      stateDir: join(root, 'state-drop'),
      graceMs: dropGraceMs,
      unopenedTimeoutMs: 30_000,
    });
    try {
      const dropTab = await browser.openTab(dropSrv.url, '#rig-root canvas, #rig-root img');
      await dropSrv.waitForConnections(1);

      const dropAt = performance.now();
      const droppedCount = await dropSrv.dropSockets();
      await dropSrv.waitForConnections(0, 200);
      const reconnectedCount = await dropSrv.waitForConnections(1, dropGraceMs - 20);
      const reconnectElapsedMs = r2(performance.now() - dropAt);
      const reconnectedWithinGrace = droppedCount === 1 && reconnectedCount === 1 && reconnectElapsedMs < dropGraceMs;

      // Wait well past graceMs after the drop to prove the server did not exit
      await Bun.sleep(dropGraceMs + 300);
      const connectionsAfterGrace = await dropSrv.getConnections();
      const aliveAfterGrace = dropSrv.proc.exitCode === null && (await isPortListening(dropSrv.port));
      const uiIntactAfterGrace = await browser.evaluate<boolean>(
        dropTab.sessionId,
        `Boolean(document.querySelector('#rig-root canvas, #rig-root img')) && Boolean(document.getElementById('scrub'))`,
      );

      await browser.closeTab(dropTab.targetId);
      await dropSrv.waitForExit(dropGraceMs + 1_000);

      const passed =
        reconnectedWithinGrace &&
        aliveAfterGrace &&
        connectionsAfterGrace === 1 &&
        uiIntactAfterGrace;
      if (!passed) {
        failures.push(
          `Dropped socket reconnect bar failed: ${JSON.stringify({
            droppedCount,
            reconnectedWithinGrace,
            reconnectElapsedMs,
            aliveAfterGrace,
            connectionsAfterGrace,
            uiIntactAfterGrace,
          })}`,
        );
      }
      droppedSocketReconnect = {
        graceMs: dropGraceMs,
        droppedCount,
        reconnectedWithinGrace,
        reconnectElapsedMs,
        aliveAfterGrace,
        connectionsAfterGrace,
        uiIntactAfterGrace,
        passed,
      };
    } finally {
      await dropSrv.kill();
    }

    return {
      browserBinary: browser.bin,
      closeBars,
      reloadAndTwoTabs,
      killedBrowser: killedBrowserResult!,
      eightManagedFrontWindows: eightManagedFrontWindows!,
      droppedSocketReconnect: droppedSocketReconnect!,
      failures,
    };
  } finally {
    if (browser) await browser.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const assertBars = process.env.NO_ASSERT !== '1';
  const outJson = process.env.OUT_JSON || undefined;
  const report = await runServerLifecycleBrowserVerification({ assertBars });
  if (outJson) {
    await writeFile(outJson, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (assertBars && report.failures.length > 0) {
    process.exit(1);
  }
}
