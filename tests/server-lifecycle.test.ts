import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { createLiveLifecycle, DEFAULT_CLOSE_GRACE_MS, DEFAULT_UNOPENED_TIMEOUT_MS, LIVE_PATH } from '../src/live-lifecycle.ts';
import { loadReview } from '../src/manifest.ts';
import { openReview } from '../src/open.ts';
import { rebuildDir } from '../src/rebuild.ts';
import { startServer } from '../src/server.ts';

const roots: string[] = [];
const subprocs: Bun.Subprocess[] = [];
const activeServers: { stop(close?: boolean): void }[] = [];

afterEach(async () => {
  for (const s of activeServers.splice(0)) {
    try { s.stop(true); } catch {}
  }
  for (const p of subprocs.splice(0)) {
    try { p.kill('SIGTERM'); } catch {}
    await p.exited.catch(() => {});
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

async function openLiveStream(url: string): Promise<{ abort: () => void; firstChunk: string }> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const first = await reader.read();
  const firstChunk = new TextDecoder().decode(first.value);
  return {
    firstChunk,
    abort: () => {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
}

test('defaults state the measured 3s close grace and 30m unopened timeout', () => {
  expect(LIVE_PATH).toBe('/api/live');
  expect(DEFAULT_CLOSE_GRACE_MS).toBe(3_000);
  expect(DEFAULT_UNOPENED_TIMEOUT_MS).toBe(30 * 60 * 1_000);
});

test('single and compare servers count live connections, survive reload and 2->1 tab close, and exit after last window closes', async () => {
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

  // Tab 1 opens
  const tab1 = await openLiveStream(singleOrigin + LIVE_PATH);
  expect(tab1.firstChunk).toContain(': live');
  expect(single.live.connections).toBe(1);

  // Tab 2 opens
  const tab2 = await openLiveStream(singleOrigin + LIVE_PATH);
  expect(single.live.connections).toBe(2);

  // Closing Tab 1 leaves Tab 2 connected; server must stay alive past graceMs
  tab1.abort();
  await Bun.sleep(180);
  expect(single.live.connections).toBe(1);
  expect(singleLines).toEqual([]);
  expect((await fetch(singleOrigin + '/api/review')).status).toBe(200);

  // Reload simulation on Tab 2: disconnect, fetch page/API inside grace window, reconnect
  tab2.abort();
  await Bun.sleep(40);
  expect(single.live.connections).toBe(0);
  expect((await fetch(singleOrigin + '/')).status).toBe(200);
  expect((await fetch(singleOrigin + '/api/review')).status).toBe(200);
  const tab2Reloaded = await openLiveStream(singleOrigin + LIVE_PATH);
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

  const cTab1 = await openLiveStream(compareOrigin + LIVE_PATH);
  const cTab2 = await openLiveStream(compareOrigin + LIVE_PATH);
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

  // Spawn a separate process that holds /api/live open and never sends pagehide/sendBeacon
  const clientProc = Bun.spawn([
    process.execPath,
    '-e',
    `const res = await fetch(${JSON.stringify(origin + LIVE_PATH)}); const r = res.body.getReader(); await r.read(); console.log('CONNECTED'); await new Promise(() => {});`,
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

  const tab = await openLiveStream(origin + LIVE_PATH);
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
  const tabA = await openLiveStream(origin2 + LIVE_PATH);
  const startRes2 = await fetch(origin2 + '/api/rebuild', {
    method: 'POST',
    headers: { Origin: origin2, 'Content-Type': 'application/json' },
    body: JSON.stringify({ part: 'topwear', regions: [{ ...bust, r: 58 }], configHash: cfgHash }),
  });
  expect(startRes2.status).toBe(202);
  // Close tabA while Apply is running, wait past graceMs, then open tabB before Apply finishes
  tabA.abort();
  await Bun.sleep(120);
  const tabB = await openLiveStream(origin2 + LIVE_PATH);
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

  const tab = await openLiveStream(firstOrigin + LIVE_PATH);
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
  const tab2 = await openLiveStream(secondOrigin + LIVE_PATH);
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
  const tab1 = await openLiveStream(origin + LIVE_PATH);
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
    const ctrl = new AbortController();
    const res = life.connect(new Request('http://127.0.0.1/api/live', { signal: ctrl.signal }), {});
    expect(res.status).toBe(200);
    expect(life.connections).toBe(1);
    ctrl.abort();
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
