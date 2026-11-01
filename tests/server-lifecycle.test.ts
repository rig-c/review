import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { createLiveLifecycle, DEFAULT_CLOSE_GRACE_MS, DEFAULT_UNOPENED_TIMEOUT_MS, LIVE_PATH } from '../src/live-lifecycle.ts';
import { loadReview } from '../src/manifest.ts';
import { openFingerprint, openReview, running } from '../src/open.ts';
import { rebuildDir } from '../src/rebuild.ts';
import { startServer } from '../src/server.ts';
import { connectLiveWindow } from '../web/live-connection.ts';

const roots: string[] = [];
const subprocs: Bun.Subprocess[] = [];
const activeServers: { stop(close?: boolean): void }[] = [];
const activeSockets: WebSocket[] = [];
const ownedDaemons: { pid: number; origin: string; nonce: string; status: string }[] = [];

async function collectOpenDaemons(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  for (const rel of entries) {
    const normalized = rel.replaceAll('\\', '/');
    const base = normalized.split('/').pop() ?? '';
    const isFront = /^front-\d+\.json$/.test(base);
    const isWorker = /^[a-f0-9]{64}\.json$/.test(base);
    if ((!isFront && !isWorker) || !normalized.endsWith(`open/${base}`)) continue;
    try {
      const data = JSON.parse(await readFile(join(root, rel), 'utf8')) as { pid?: number; origin?: string; nonce?: string };
      if (typeof data.pid === 'number' && typeof data.origin === 'string' && typeof data.nonce === 'string') {
        if (!ownedDaemons.some(row => row.nonce === data.nonce)) {
          ownedDaemons.push({
            pid: data.pid,
            origin: data.origin,
            nonce: data.nonce,
            status: isFront ? '/api/front-status' : '/api/open-status',
          });
        }
      }
    } catch {}
  }
}

afterEach(async () => {
  for (const ws of activeSockets.splice(0)) {
    try { ws.close(); } catch {}
  }
  for (const s of activeServers.splice(0)) {
    try { s.stop(true); } catch {}
  }
  for (const p of subprocs.splice(0)) {
    try { p.kill('SIGTERM'); } catch {}
    await p.exited.catch(() => {});
  }
  for (const r of roots) {
    await collectOpenDaemons(r);
  }
  for (const row of ownedDaemons.splice(0)) {
    try {
      const res = await fetch(row.origin + row.status, {
        headers: { authorization: `Bearer ${row.nonce}` },
        signal: AbortSignal.timeout(500),
      });
      if (((await res.json()) as { nonce?: string }).nonce === row.nonce) {
        process.kill(row.pid, 'SIGTERM');
      }
    } catch {}
    for (let i = 0; i < 80 && running(row.pid); i++) {
      await Bun.sleep(25);
    }
  }
  for (const r of roots.splice(0)) {
    await rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function makeTempRoot(prefix = 'review-lifecycle-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function freePort(): number {
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = srv.port!;
  srv.stop(true);
  return port;
}

async function openLiveSocket(url: string, originHeader: string | null = new URL(url).origin): Promise<{ ws: WebSocket; abort: () => void; firstMessage: string }> {
  const wsUrl = url.replace(/^http/i, 'ws');
  const ws = new WebSocket(wsUrl, (originHeader !== null ? { headers: { Origin: originHeader } } : undefined) as unknown as string[]);
  activeSockets.push(ws);
  const firstMessage = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket message on ${wsUrl}`)), 5_000);
    ws.onmessage = ev => {
      clearTimeout(timer);
      resolve(String(ev.data));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error on ${wsUrl}`));
    };
    ws.onclose = ev => {
      clearTimeout(timer);
      reject(new Error(`WebSocket closed before first message on ${wsUrl} (code=${ev.code})`));
    };
  });
  return {
    ws,
    firstMessage,
    abort: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

async function waitForConnections(getActual: () => number, expected: number, timeoutMs = 2_000): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (getActual() === expected) return expected;
    await Bun.sleep(15);
  }
  return getActual();
}

test('defaults state the measured 3s close grace and 30m unopened timeout', () => {
  expect(LIVE_PATH).toBe('/api/live');
  expect(DEFAULT_CLOSE_GRACE_MS).toBe(3_000);
  expect(DEFAULT_UNOPENED_TIMEOUT_MS).toBe(30 * 60 * 1_000);
});

test('single and compare servers count live WebSocket connections, survive reload and 2->1 tab close, and exit after last window closes', async () => {
  const root = await makeTempRoot();
  const pkgA = join(root, 'a');
  const pkgB = join(root, 'b');
  const ref = join(root, 'ref.mov');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkgA, { recursive: true });
  await cp(pkgA, pkgB, { recursive: true });
  await cp(join(pkgA, 'reference.mov'), ref);

  const singleLines: string[] = [];
  const reviewPkg = await loadReview(pkgA);
  const single = await startServer(reviewPkg, {
    port: 0,
    stateDir: join(root, 'state-single'),
    graceMs: 120,
    unopenedTimeoutMs: 5_000,
    log: line => singleLines.push(line),
  });
  activeServers.push(single);
  const singleOrigin = `http://127.0.0.1:${single.port}`;

  // Non-upgrade same-origin GET is refused with 426; missing/foreign Origin is refused with 403
  expect((await fetch(singleOrigin + LIVE_PATH)).status).toBe(403);
  expect((await fetch(singleOrigin + LIVE_PATH, { headers: { Origin: singleOrigin } })).status).toBe(426);

  // Tab 1 opens
  const tab1 = await openLiveSocket(singleOrigin + LIVE_PATH);
  expect(tab1.firstMessage).toContain('live');
  expect(single.live.connections).toBe(1);

  // Tab 2 opens
  const tab2 = await openLiveSocket(singleOrigin + LIVE_PATH);
  expect(single.live.connections).toBe(2);

  // Closing Tab 1 leaves Tab 2 connected; server must stay alive past graceMs
  tab1.abort();
  await Bun.sleep(180);
  expect(single.live.connections).toBe(1);
  expect(singleLines).toEqual([]);
  expect((await fetch(singleOrigin + '/api/review')).status).toBe(200);

  // Reload simulation on Tab 2: disconnect, fetch page/API inside grace window, reconnect
  tab2.abort();
  await waitForConnections(() => single.live.connections, 0);
  expect(single.live.connections).toBe(0);
  expect((await fetch(singleOrigin + '/')).status).toBe(200);
  expect((await fetch(singleOrigin + '/api/review')).status).toBe(200);
  const tab2Reloaded = await openLiveSocket(singleOrigin + LIVE_PATH);
  expect(single.live.connections).toBe(1);
  await Bun.sleep(160);
  expect(singleLines).toEqual([]);

  // Closing the last tab exits after graceMs and prints the reason line
  tab2Reloaded.abort();
  const exitInfo = await single.live.exited;
  expect(exitInfo?.reason).toBe('last-window-closed');
  expect(singleLines).toEqual(['review: exiting — last review window closed (0 live connections for 120ms).']);

  // Repeat for compare server
  const compareLines: string[] = [];
  const comparePkg = await loadCompare({ a: pkgA, b: pkgB, reference: ref, animation: 'inspect' });
  const compare = await startCompareServer(comparePkg, {
    port: 0,
    stateDir: join(root, 'state-compare'),
    graceMs: 120,
    unopenedTimeoutMs: 5_000,
    log: line => compareLines.push(line),
  });
  activeServers.push(compare);
  const compareOrigin = `http://127.0.0.1:${compare.port}`;

  expect((await fetch(compareOrigin + LIVE_PATH)).status).toBe(403);
  expect((await fetch(compareOrigin + LIVE_PATH, { headers: { Origin: compareOrigin } })).status).toBe(426);
  const cTab1 = await openLiveSocket(compareOrigin + LIVE_PATH);
  const cTab2 = await openLiveSocket(compareOrigin + LIVE_PATH);
  expect(compare.live.connections).toBe(2);
  cTab1.abort();
  await Bun.sleep(180);
  expect(compare.live.connections).toBe(1);
  expect(compareLines).toEqual([]);
  cTab2.abort();
  const cExit = await compare.live.exited;
  expect(cExit?.reason).toBe('last-window-closed');
  expect(compareLines).toEqual(['review compare: exiting — last review window closed (0 live connections for 120ms).']);
});

test('foreign and missing Origin headers are refused on the managed front and on both direct servers without raising connections, while same-origin connects', async () => {
  const root = await makeTempRoot();
  const pkgA = join(root, 'a');
  const pkgB = join(root, 'b');
  const ref = join(root, 'ref.mov');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkgA, { recursive: true });
  await cp(pkgA, pkgB, { recursive: true });
  await cp(join(pkgA, 'reference.mov'), ref);

  const single = await startServer(await loadReview(pkgA), {
    port: 0,
    stateDir: join(root, 'state-single'),
    graceMs: 300,
    unopenedTimeoutMs: 5_000,
    log: () => {},
  });
  activeServers.push(single);
  const singleOrigin = `http://127.0.0.1:${single.port}`;

  const compare = await startCompareServer(
    await loadCompare({ a: pkgA, b: pkgB, reference: ref, animation: 'inspect' }),
    {
      port: 0,
      stateDir: join(root, 'state-compare'),
      graceMs: 300,
      unopenedTimeoutMs: 5_000,
      log: () => {},
    },
  );
  activeServers.push(compare);
  const compareOrigin = `http://127.0.0.1:${compare.port}`;

  // 1. Direct single server: foreign and missing Origin refused with 403 and 0 connections
  for (const badOrigin of ['http://evil.test', `http://localhost:${single.port}`, 'null', null]) {
    const httpRes = await fetch(singleOrigin + LIVE_PATH, {
      headers: badOrigin !== null ? { Origin: badOrigin } : {},
    });
    expect(httpRes.status).toBe(403);
    expect(await httpRes.json()).toEqual({ error: 'Same-origin Origin required' });
    await expect(openLiveSocket(singleOrigin + LIVE_PATH, badOrigin)).rejects.toThrow();
    expect(single.live.connections).toBe(0);
    expect(single.live.everConnected).toBe(false);
  }
  const sOk = await openLiveSocket(singleOrigin + LIVE_PATH, singleOrigin);
  expect(single.live.connections).toBe(1);
  sOk.abort();

  // 2. Direct compare server: foreign and missing Origin refused with 403 and 0 connections
  for (const badOrigin of ['http://evil.test', `http://localhost:${compare.port}`, 'null', null]) {
    const httpRes = await fetch(compareOrigin + LIVE_PATH, {
      headers: badOrigin !== null ? { Origin: badOrigin } : {},
    });
    expect(httpRes.status).toBe(403);
    expect(await httpRes.json()).toEqual({ error: 'Same-origin Origin required' });
    await expect(openLiveSocket(compareOrigin + LIVE_PATH, badOrigin)).rejects.toThrow();
    expect(compare.live.connections).toBe(0);
    expect(compare.live.everConnected).toBe(false);
  }
  const cOk = await openLiveSocket(compareOrigin + LIVE_PATH, compareOrigin);
  expect(compare.live.connections).toBe(1);
  cOk.abort();

  // 3. Managed front: foreign and missing Origin refused with 403 FRONT_SAME_ORIGIN_REQUIRED before touching worker
  const frontStateDir = join(root, 'state-front');
  const frontPort = freePort();
  const opened = await openReview(
    { input: pkgA, animation: 'inspect' },
    { stateDir: frontStateDir, frontPort, graceMs: 300, idleMs: 5_000 },
  );
  const frontOrigin = new URL(opened.url).origin;
  const frontLiveUrl = frontOrigin + new URL(opened.url).pathname + 'api/live';
  const workerKey = new URL(opened.url).pathname.split('/')[2]!;
  const workerRecord = JSON.parse(await readFile(join(frontStateDir, 'open', `${workerKey}.json`), 'utf8')) as { origin: string };

  for (const badOrigin of ['http://evil.test', `http://localhost:${frontPort}`, 'null', null]) {
    const httpRes = await fetch(frontLiveUrl, {
      headers: badOrigin !== null ? { Origin: badOrigin } : {},
    });
    expect(httpRes.status).toBe(403);
    expect(await httpRes.json()).toEqual({ error: 'FRONT_SAME_ORIGIN_REQUIRED' });
    await expect(openLiveSocket(frontLiveUrl, badOrigin)).rejects.toThrow();
  }
  // Also verify direct foreign-Origin attempt against the managed worker's own port is refused
  await expect(openLiveSocket(workerRecord.origin + LIVE_PATH, 'http://evil.test')).rejects.toThrow();
  await expect(openLiveSocket(workerRecord.origin + LIVE_PATH, null)).rejects.toThrow();

  // Same-origin on the front connects cleanly (front relays to worker with nonce and no browser Origin)
  const fOk = await openLiveSocket(frontLiveUrl, frontOrigin);
  expect(fOk.firstMessage).toContain('live');
  fOk.abort();
});

test('when a live WebSocket drops while the only window is still open, connectLiveWindow reconnects within graceMs and the server survives', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkg, { recursive: true });
  const lines: string[] = [];
  const graceMs = 600;
  const server = await startServer(await loadReview(pkg), {
    port: 0,
    stateDir: join(root, 'state'),
    graceMs,
    unopenedTimeoutMs: 5_000,
    log: line => lines.push(line),
  });
  activeServers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  // In a browser, `new WebSocket(url)` always sends the page's Origin header automatically.
  // In Bun's non-DOM test runner, wrap WebSocket to attach `Origin: origin` like a browser page does.
  const NativeWebSocket = globalThis.WebSocket;
  class BrowserLikeWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, (protocols ?? { headers: { Origin: origin } }) as unknown as string[]);
    }
  }
  globalThis.WebSocket = BrowserLikeWebSocket;

  const dispose = connectLiveWindow({
    route: path => origin + path,
  });
  try {
    expect(await waitForConnections(() => server.live.connections, 1, 2_000)).toBe(1);

    // Drop the active server socket while the window remains open
    const dropped = server.live.dropSockets();
    expect(dropped).toBe(1);
    expect(server.live.connections).toBe(0);

    // Client must reconnect within graceMs (~200ms) and keep the server alive past graceMs
    expect(await waitForConnections(() => server.live.connections, 1, graceMs - 50)).toBe(1);
    await Bun.sleep(graceMs + 200);
    expect(server.live.connections).toBe(1);
    expect(lines).toEqual([]);
    expect((await fetch(origin + '/api/review')).status).toBe(200);
  } finally {
    dispose();
    globalThis.WebSocket = NativeWebSocket;
  }

  const exitInfo = await server.live.exited;
  expect(exitInfo?.reason).toBe('last-window-closed');
});

test('managed front relays 8 concurrent WebSocket windows across 2 instances and completes session save on the 8th + loads a 9th page', async () => {
  const root = await makeTempRoot();
  const pkgA = join(root, 'pkg-a');
  const pkgB = join(root, 'pkg-b');
  await mkdir(pkgA, { recursive: true });
  await mkdir(pkgB, { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(pkgA, 'build'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/motion.json'), join(pkgA, 'motion.json'));
  await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(pkgB, 'build'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/motion.json'), join(pkgB, 'motion.json'));
  await writeFile(join(pkgB, 'report.json'), JSON.stringify({ spec: 'rig-pose-report/1', animation: 'inspect', frameTimes: [0, 0.5, 1] }));

  const stateDir = join(root, 'state');
  const frontPort = freePort();
  const instA = await openReview({ input: pkgA, animation: 'inspect' }, { stateDir, frontPort, graceMs: 600, idleMs: 5_000 });
  const instB = await openReview({ input: pkgB, animation: 'inspect' }, { stateDir, frontPort, graceMs: 600, idleMs: 5_000 });

  const urlA = new URL(instA.url);
  const urlB = new URL(instB.url);
  const frontOrigin = urlA.origin;
  const baseA = frontOrigin + urlA.pathname;
  const baseB = frontOrigin + urlB.pathname;
  const capB = urlB.hash.slice(5);

  // Non-upgrade same-origin GET to front /api/live is refused with 426 FRONT_UPGRADE_REQUIRED
  const nonWs = await fetch(baseA + 'api/live', { headers: { Origin: frontOrigin } });
  expect(nonWs.status).toBe(426);
  expect((await nonWs.json()).error).toBe('FRONT_UPGRADE_REQUIRED');

  // Open 8 windows across the 2 instances through the same front origin
  const windows = await Promise.all(
    Array.from({ length: 8 }, (_, idx) => openLiveSocket((idx < 4 ? baseA : baseB) + 'api/live')),
  );
  expect(windows).toHaveLength(8);

  // On the 8th window (instance B), read and save feedback session through the front
  const sessionB = await (await fetch(baseB + 'api/session')).json();
  const saveRes = await fetch(baseB + 'api/session', {
    method: 'PUT',
    headers: {
      Origin: frontOrigin,
      'Content-Type': 'application/json',
      'X-Review-Capability': capB,
    },
    body: JSON.stringify({
      ...sessionB,
      status: 'approved',
      notes: 'Saved from window 8 while 8 live WebSockets are open',
    }),
  });
  expect(saveRes.status).toBe(200);
  expect((await saveRes.json()).status).toBe('approved');

  // Open a 9th page and live socket through the front while all 8 are still connected
  const ninthLanding = await fetch(instA.url);
  expect(ninthLanding.status).toBe(200);
  const ninthReview = await fetch(baseA + 'api/review');
  expect(ninthReview.status).toBe(200);
  const window9 = await openLiveSocket(baseA + 'api/live');
  expect(window9.firstMessage).toContain('live');

  // Close all 9 windows and wait for both workers to exit cleanly
  window9.abort();
  for (const w of windows) w.abort();

  for (let i = 0; i < 80; i++) {
    const openFiles = (await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (openFiles.length === 0) break;
    await Bun.sleep(50);
  }
  expect((await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n))).toEqual([]);
}, 30_000);

test('a server that never receives any page connection exits after unopenedTimeoutMs and prints why', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkg, { recursive: true });
  const lines: string[] = [];
  const server = await startServer(await loadReview(pkg), {
    port: 0,
    stateDir: join(root, 'state'),
    graceMs: 100,
    unopenedTimeoutMs: 120,
    log: line => lines.push(line),
  });
  activeServers.push(server);
  const exitInfo = await server.live.exited;
  expect(exitInfo?.reason).toBe('unopened-timeout');
  expect(lines).toEqual(['review: exiting — no review window connected within 120ms.']);
});

test('a SIGKILLed client process is detected via socket teardown without pagehide or sendBeacon, exiting 0 and freeing the port', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkg, { recursive: true });

  // Spawn real foreground CLI server
  const srvProc = Bun.spawn([process.execPath, 'src/cli.ts', pkg, '--port', '0'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, RIG_REVIEW_STATE_DIR: join(root, 'state') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  subprocs.push(srvProc);

  const reader = srvProc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  while (!/Review ready: (\S+)/.test(stdout)) {
    const step = await reader.read();
    if (step.done) throw new Error('CLI server exited before ready');
    stdout += decoder.decode(step.value);
  }
  const url = new URL(/Review ready: (\S+)/.exec(stdout)![1]!);
  const origin = url.origin;
  const wsUrl = origin.replace(/^http/i, 'ws') + LIVE_PATH;

  // Spawn a separate process that holds /api/live WebSocket open and never sends pagehide/sendBeacon
  const clientProc = Bun.spawn([
    process.execPath,
    '-e',
    `const ws = new WebSocket(${JSON.stringify(wsUrl)}, { headers: { Origin: ${JSON.stringify(origin)} } }); ws.onmessage = () => console.log('CONNECTED'); await new Promise(() => {});`,
  ], { stdout: 'pipe', stderr: 'pipe' });
  subprocs.push(clientProc);

  const cReader = clientProc.stdout.getReader();
  let cOut = '';
  while (!cOut.includes('CONNECTED')) {
    const step = await cReader.read();
    if (step.done) throw new Error('Client exited before connecting');
    cOut += decoder.decode(step.value);
  }
  cReader.releaseLock();

  // Kill the client with SIGKILL (-9): no pagehide, no sendBeacon
  const killAt = performance.now();
  process.kill(clientProc.pid, 'SIGKILL');
  await clientProc.exited;

  // Read remaining stdout and wait for CLI server to exit 0
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    stdout += decoder.decode(step.value);
  }
  const exitCode = await srvProc.exited;
  const elapsedMs = performance.now() - killAt;

  expect(exitCode).toBe(0);
  expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_CLOSE_GRACE_MS - 150);
  expect(elapsedMs).toBeLessThan(DEFAULT_CLOSE_GRACE_MS + 1_500);
  expect(stdout).toContain('review: exiting — last review window closed (0 live connections for 3000ms).');

  // Verify the port is free
  await expect(fetch(origin + '/api/review', { signal: AbortSignal.timeout(300) })).rejects.toThrow();
}, 15_000);

test('in-flight Apply finishes before exit when the last tab closes, and re-checks the connection count after finishing', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  const bust = { name: 'bust', shape: 'circle' as const, cx: 414, cy: 342, r: 50, bone: 'chest_jiggle', spacing: 13, band: 30 };
  const config = { key: 'k', meshes: { topwear: { contour: { tolerance: 2, margin: 2, spacing: 28, maxEdge: 45, stray: 300, bridges: true, regions: [bust] }, r: 15, segments: [['chest', [416, 230], [416, 600]]] } } };

  await mkdir(join(pkg, 'rig/out/rig'), { recursive: true });
  await mkdir(join(pkg, 'rig/out/parts'), { recursive: true });
  await writeFile(join(pkg, 'rig/config.json'), JSON.stringify(config, null, 1));
  await writeFile(join(pkg, 'rig/out/parts.json'), '{}');
  for (const name of ['rig.json', 'motion.json', 'mesh_report.json']) {
    await writeFile(join(pkg, 'rig/out/rig', name), '{}');
  }
  await writeFile(join(pkg, 'motion.json'), '{}');

  // Stand-in producer that takes ~350ms to remesh so the last tab closes while Apply is mid-flight
  const fakeParts = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='--version'){console.log('1.42.0');process.exit(0);}
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));console.log('rig-parts rig: wrote '+out);process.exit(0);}
setTimeout(()=>{
  const out=f('--out');fs.mkdirSync(out,{recursive:true});const mesh=fs.readFileSync(f('--mesh'),'utf8');
  fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify({mesh:JSON.parse(mesh)}));fs.writeFileSync(path.join(out,'motion.json'),'{}');
  fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part:f('--part'),page_edges:'free',pack_shape:'polygon'},target:{before:{vertices:178,triangles:296,hull:58},after:{vertices:181,triangles:302,hull:58}}}));
  console.log('rig-parts remesh: wrote 3 file(s) under '+out+', the provenance in remesh.json');
}, 350);`;
  const fakeRigc = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],regions:rig.mesh.contour.regions}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote '+path.join(out,'skeleton.model.json'));`;

  await mkdir(join(root, 'node_modules/@rig-c/parts/bin'), { recursive: true });
  await mkdir(join(root, 'node_modules/rig-c/bin'), { recursive: true });
  await writeFile(join(root, 'node_modules/@rig-c/parts/package.json'), JSON.stringify({ name: '@rig-c/parts', version: '1.42.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }));
  await writeFile(join(root, 'node_modules/@rig-c/parts/bin/rig-parts.cjs'), fakeParts);
  await writeFile(join(root, 'node_modules/rig-c/package.json'), JSON.stringify({ name: 'rig-c', version: '2.64.1', bin: { rigc: './bin/rigc.cjs' } }));
  await writeFile(join(root, 'node_modules/rig-c/bin/rigc.cjs'), fakeRigc);

  const stateDir = join(root, 'state');
  const lines: string[] = [];
  const server = await startServer(await loadReview(pkg), {
    port: 0,
    stateDir,
    graceMs: 100,
    unopenedTimeoutMs: 5_000,
    log: line => lines.push(line),
  });
  activeServers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  const tab = await openLiveSocket(origin + LIVE_PATH);
  const cfgHash = sha256(await readFile(join(pkg, 'rig/config.json')));

  // Start an Apply (returns 202 running while fakeParts takes 350ms)
  const startRes = await fetch(origin + '/api/rebuild', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ part: 'topwear', regions: [{ ...bust, r: 54 }], configHash: cfgHash }),
  });
  expect(startRes.status).toBe(202);
  const startedJob = await startRes.json() as { id: string; status: string };
  expect(startedJob.status).toBe('running');

  // Close the last tab immediately while Apply is still running
  tab.abort();
  await Bun.sleep(160);
  // Grace period (100ms) has elapsed, but Apply is still running -> server must NOT have exited yet
  expect(lines).toEqual([]);

  // Wait for server to finish the in-flight Apply and exit
  const exitInfo = await server.live.exited;
  expect(exitInfo?.reason).toBe('last-window-closed');
  expect(lines).toEqual(['review: exiting — last review window closed (0 live connections for 100ms).']);

  // Verify the in-flight Apply completed fully on disk (`result.json` status === 'built' and compiled model written)
  const reviewPkg = await loadReview(pkg);
  const builtDir = rebuildDir(stateDir, reviewPkg.sourceHash, startedJob.id);
  const resultJson = JSON.parse(await readFile(join(builtDir, 'result.json'), 'utf8'));
  expect(resultJson.status).toBe('built');
  expect(resultJson.producerLine).toContain('rig-parts remesh: wrote 3 file(s)');
  const builtModel = JSON.parse(await readFile(join(builtDir, 'build/skeleton.model.json'), 'utf8'));
  expect(builtModel.spec).toBe('rigc-compiled/3');

  // Also verify: if a window reconnects while Apply is in flight, the re-check sees connections > 0 and does NOT exit
  const linesReconnected: string[] = [];
  const server2 = await startServer(await loadReview(pkg), {
    port: 0,
    stateDir: join(root, 'state-2'),
    graceMs: 80,
    unopenedTimeoutMs: 5_000,
    log: line => linesReconnected.push(line),
  });
  activeServers.push(server2);
  const origin2 = `http://127.0.0.1:${server2.port}`;
  const tabA = await openLiveSocket(origin2 + LIVE_PATH);
  const startRes2 = await fetch(origin2 + '/api/rebuild', {
    method: 'POST',
    headers: { Origin: origin2, 'Content-Type': 'application/json' },
    body: JSON.stringify({ part: 'topwear', regions: [{ ...bust, r: 58 }], configHash: cfgHash }),
  });
  expect(startRes2.status).toBe(202);
  // Close tabA while Apply is running, wait past graceMs, then open tabB before Apply finishes
  tabA.abort();
  await Bun.sleep(120);
  const tabB = await openLiveSocket(origin2 + LIVE_PATH);
  await Bun.sleep(350);
  expect(linesReconnected).toEqual([]);
  expect((await fetch(origin2 + '/api/review')).status).toBe(200);
  tabB.abort();
  expect((await server2.live.exited)?.reason).toBe('last-window-closed');
});

test('saved feedback and session files survive exit byte-identically when the same inputs are reopened', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  await mkdir(pkg, { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(pkg, 'build'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/motion.json'), join(pkg, 'motion.json'));
  const stateDir = join(root, 'state');

  const first = await openReview({ input: pkg, animation: 'inspect', direct: true }, { stateDir, graceMs: 100, idleMs: 5_000 });
  const firstOrigin = new URL(first.url).origin;
  const cap = new URL(first.url).hash.slice(5);

  const tab = await openLiveSocket(firstOrigin + LIVE_PATH);
  const session = await (await fetch(firstOrigin + '/api/session')).json();
  const updated = {
    ...session,
    status: 'changes-requested',
    notes: 'Persist across window close',
    feedback: [{
      id: 'fb-survive-1',
      frameStart: 0,
      frameEnd: 1,
      target: { kind: 'bone', name: 'rigid' },
      category: 'quality',
      summary: 'Keep exact bytes after auto-exit',
      context: { animation: 'inspect' },
    }],
  };
  const putRes = await fetch(firstOrigin + '/api/session', {
    method: 'PUT',
    headers: { Origin: firstOrigin, 'Content-Type': 'application/json', 'X-Review-Capability': cap },
    body: JSON.stringify(updated),
  });
  expect(putRes.status).toBe(200);
  const savedPayload = await putRes.json();

  // Close the only tab and wait for the worker to exit and clean up its open record
  tab.abort();
  for (let i = 0; i < 60; i++) {
    const openFiles = (await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (openFiles.length === 0) break;
    await Bun.sleep(50);
  }
  expect((await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n))).toEqual([]);

  // Hash every session file on disk after exit
  const sessionFiles = (await readdir(stateDir)).filter(n => n.endsWith('.json')).sort();
  expect(sessionFiles.length).toBeGreaterThan(0);
  const bytesAfterExit = await Promise.all(sessionFiles.map(async f => ({ name: f, sha256: sha256(await readFile(join(stateDir, f))) })));

  // Reopen the exact same inputs and verify byte-identical session files and restored API response
  const reopened = await openReview({ input: pkg, animation: 'inspect', direct: true }, { stateDir, graceMs: 100, idleMs: 5_000 });
  expect(reopened.reused).toBe(false);
  const secondOrigin = new URL(reopened.url).origin;
  const tab2 = await openLiveSocket(secondOrigin + LIVE_PATH);
  const restoredSession = await (await fetch(secondOrigin + '/api/session')).json();
  const bytesOnReopen = await Promise.all(sessionFiles.map(async f => ({ name: f, sha256: sha256(await readFile(join(stateDir, f))) })));

  expect(bytesOnReopen).toEqual(bytesAfterExit);
  expect(restoredSession).toEqual(savedPayload);
  tab2.abort();
  for (let i = 0; i < 60; i++) {
    const openFiles = (await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (openFiles.length === 0) break;
    await Bun.sleep(50);
  }
});

test('reusing a worker inside its close grace window re-arms it as an unopened server so the printed link stays alive', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  await mkdir(pkg, { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(pkg, 'build'), { recursive: true });
  await cp(join(import.meta.dir, 'fixtures/strip-probe/motion.json'), join(pkg, 'motion.json'));
  const stateDir = join(root, 'state');

  const graceMs = 250;
  const idleMs = 900;
  const first = await openReview({ input: pkg, animation: 'inspect', direct: true }, { stateDir, graceMs, idleMs });
  expect(first.reused).toBe(false);
  const origin = new URL(first.url).origin;

  // Connect a window and then close it so the worker enters its 250ms grace window
  const tab1 = await openLiveSocket(origin + LIVE_PATH);
  tab1.abort();
  await Bun.sleep(70);

  // Reuse the worker inside the 250ms grace period
  const reused = await openReview({ input: pkg, animation: 'inspect', direct: true }, { stateDir, graceMs, idleMs });
  expect(reused.reused).toBe(true);
  expect(reused.url).toBe(first.url);

  // Wait 380ms (well past the 250ms close grace, still within the 900ms unopened timeout): the printed link must still be alive
  await Bun.sleep(380);
  const landingRes = await fetch(reused.url);
  expect(landingRes.status).toBe(200);

  // If no window connects within the fresh unopened timeout (900ms from the last request), the worker exits and removes its record
  for (let i = 0; i < 50; i++) {
    const openFiles = (await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
    if (openFiles.length === 0) break;
    await Bun.sleep(50);
  }
  expect((await readdir(join(stateDir, 'open'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n))).toEqual([]);
});

test('wall-clock sleep jump resets pending countdown instead of exiting prematurely on wake', async () => {
  let fakeNow = 1_000;
  const lines: string[] = [];
  const life = createLiveLifecycle({
    label: 'review',
    graceMs: 200,
    unopenedTimeoutMs: 500,
    now: () => fakeNow,
    log: line => lines.push(line),
  });
  try {
    const handle = life.attachSocket();
    expect(life.connections).toBe(1);
    handle.close();
    expect(life.connections).toBe(0);

    // Simulate a 10-second machine sleep jump on the next tick: zeroSince must reset to wake time (11_000)
    fakeNow = 11_000;
    await Bun.sleep(60);
    expect(lines).toEqual([]);

    // Advancing 150ms (< 200ms graceMs) after wake still does not exit
    fakeNow = 11_150;
    await Bun.sleep(60);
    expect(lines).toEqual([]);

    // Advancing past 200ms after wake exits cleanly
    fakeNow = 11_250;
    const info = await life.exited;
    expect(info?.reason).toBe('last-window-closed');
    expect(lines).toHaveLength(1);
  } finally {
    life.stop();
  }
});

test('a front stays up while its control directory has a live record and exits within a bound when the control directory is deleted, while the planted .catch(()=>{}) form fails', async () => {
  const root = await makeTempRoot();
  const pkg = join(root, 'pkg');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), pkg, { recursive: true });
  const stateDir = join(root, 'state');
  const frontPort = freePort();
  const idleMs = 120;

  await openReview(
    { input: pkg, animation: 'inspect' },
    { stateDir, frontPort, frontIdleMs: idleMs, graceMs: 300, idleMs: 5_000 },
  );
  await collectOpenDaemons(root);

  const control = join(stateDir, 'open');
  const frontRec = JSON.parse(await readFile(join(control, `front-${frontPort}.json`), 'utf8')) as {
    pid: number;
    origin: string;
    nonce: string;
  };

  // Bar 3: while the control directory exists with a live instance record, the front stays up past idleMs.
  await Bun.sleep(idleMs * 3);
  expect(running(frontRec.pid)).toBe(true);
  const statusRes = await fetch(frontRec.origin + '/api/front-status', {
    headers: { authorization: `Bearer ${frontRec.nonce}` },
  });
  expect(statusRes.status).toBe(200);

  // Any other read error (such as ENOTDIR) stays as it is and does not stop the front.
  await rm(control, { recursive: true, force: true });
  await writeFile(control, 'not-a-directory');
  await Bun.sleep(idleMs * 3);
  expect(running(frontRec.pid)).toBe(true);

  // Bar 1: deleting the control directory causes the front to exit within the bound.
  await rm(control, { force: true });
  const deadline = performance.now() + 1_500;
  while (performance.now() < deadline && running(frontRec.pid)) {
    await Bun.sleep(25);
  }
  expect(running(frontRec.pid)).toBe(false);

  // Planted pre-#287 control: unguarded readdir(control) swallowed by .catch(()=>{}) fails the exit bound.
  const plantedControl = join(root, 'planted-open');
  await mkdir(plantedControl, { recursive: true, mode: 0o700 });
  const plantedPort = freePort();
  const plantedNonce = crypto.randomUUID();
  const plantedReq = join(plantedControl, `front-${plantedPort}.${plantedNonce}.request.json`);
  const plantedRecPath = join(plantedControl, `front-${plantedPort}.json`);
  const frontSrc = await readFile(new URL('../src/front.ts', import.meta.url), 'utf8');
  const plantedFrontSrc = frontSrc.replace(
    /async function liveInstances\(control:string\):Promise<boolean>\{[^\n]*\}/,
    'async function liveInstances(control:string):Promise<boolean>{for(const name of await readdir(control)){if(/^[a-f0-9]{64}\\.claim$/.test(name))return true;}return false;}',
  );
  const plantedDir = join(root, 'planted-src');
  await mkdir(plantedDir, { recursive: true });
  for (const name of [
    'open.ts',
    'open-protocol.ts',
    'live-lifecycle.ts',
    'control.ts',
    'reference.ts',
    'manifest.ts',
    'compare.ts',
    'server.ts',
    'compare-server.ts',
    'animation-selection.ts',
    'versions.ts',
    'handoff.ts',
    'state-dir.ts',
  ]) {
    await writeFile(join(plantedDir, name), `export * from ${JSON.stringify(join(import.meta.dir, '../src', name))};\n`);
  }
  await writeFile(join(plantedDir, 'front.ts'), plantedFrontSrc);
  await writeFile(
    plantedReq,
    JSON.stringify({
      schema: 'rig-review-front-request/1',
      control: plantedControl,
      request: plantedReq,
      record: plantedRecPath,
      port: plantedPort,
      nonce: plantedNonce,
      fingerprint: await openFingerprint(),
      idleMs,
    }),
    { mode: 0o600 },
  );
  const plantedProc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {runFront} from ${JSON.stringify(join(plantedDir, 'front.ts'))}; await runFront(process.argv[1]);`,
      plantedReq,
    ],
    { cwd: plantedControl, stdout: 'ignore', stderr: 'ignore' },
  );
  subprocs.push(plantedProc);
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${plantedPort}/api/front-status`, {
        headers: { authorization: `Bearer ${plantedNonce}` },
      });
      if (r.ok) break;
    } catch {}
    await Bun.sleep(25);
  }
  await rm(plantedControl, { recursive: true, force: true });
  await Bun.sleep(idleMs * 4);
  expect(running(plantedProc.pid)).toBe(true);
});
