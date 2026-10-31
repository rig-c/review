/**
 * Browser verification for issue #234:
 * - One shell: top switch reads Setup · Animate · Compare.
 * - Single session with no second build disables Compare with the required tooltip.
 * - Comparison session starts in Compare mode, switches Setup → Animate → Compare → Setup with no reload and time/selection preserved.
 * - Setup and Animate mount the shared panel modules on the picked build (Build A, then Build B):
 *   timeline, curve view, bone tree, parts editing panels (chest regions, mesh editor, mesh panel, density strip, weights,
 *   bones, rig fields, cuts, cloth), and animate blocks (physics, idle tracks, retarget, readings, requirements).
 * - Apply through the managed front rebuilds only the picked build in scratch while leaving both input packages on disk unchanged.
 * - Stage comments placed in Setup, Animate and Compare carry mode: 'setup' | 'animate' | 'compare'.
 * - Legacy compare deep link without selection.mode opens in Compare mode.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';
import { openReview } from '../src/open.ts';
import { encodeBookmark, type InspectionBookmark } from '../web/inspection-persistence.ts';

const PROBE_MP4_BASE64 =
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAA3Jtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACnXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAIAAAACAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAhVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAADAAAAAwAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAHAbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABgHN0YmwAAACoc3RzZAAAAAAAAAABAAAAmHZwMDkAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAIAAgAEgAAABIAAAAAAAAAAEXTGF2YzYzLjEuMTAyIGxpYnZweC12cDkAAAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAB9AAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAGAAAAgAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAGAAAAAEAAAB0c3RzegAAAAAAAAAAAAAAGAAAACgAAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADgAAAA8AAAAPAAAADwAAABRzdGNvAAAAAAAAAAEAAAOeAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAABiG1kYXSCSYNCAAHwAfYAOCQcGEIAADBgAAAQ3//81M3/////sUwf////joAAhgBAkpwASUAAAyAAAENAhgBAkpwASsAAAyAAAENAhgBAkpwAScAAAyAAAENAhgBAkpwASKAAAyAAAENAhgBAkpwAR4AAAyAAAENAhgBAkpwARuAAAyAAAENAhgBAkpwARkAAAyAAAENAhgBAkpwARcAAAyAAAENAhgBAkpwARUAAAyAAAENAhgDAkpwAQQAAAyAAAENAhgBAkpwAROAAAyAAAENAhgBAkpwARGAAAyAAAENAhgBAkpwARAAAAyAAAENAhgBAkpwAQ6AAAyAAAENAhgBAkpwAQ0AAAyAAAENAhgBAkpwAQwAAAyAAAENAhgBAkpwAQsAAAyAAAENAhgBAkpwAQoAAAyAAAENAhgBAkpwAQkAAAyAAAENAhgDAkpwAQAAAAgAAQ0CGAECSnABCAAADIAAAQ0CGAECSnABB4AADIAAAQ0CGAECSnABBwAADIAAAQ0A=';

interface CdpSession {
  setViewport(width: number, height: number): Promise<void>;
  goto(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
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

async function launchCdpSession(profileDir: string): Promise<CdpSession> {
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
    { stdout: 'ignore', stderr: 'pipe', env: childEnv },
  );

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let wsEndpoint: string | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !wsEndpoint) {
    const readResult = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
    ]);
    if (readResult.value) {
      buffer += decoder.decode(readResult.value, { stream: true });
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
      if (match) {
        wsEndpoint = match[1]!;
        break;
      }
    }
  }
  if (!wsEndpoint) {
    try { proc.kill(); } catch {}
    throw new Error(`Failed to obtain DevTools WebSocket from ${bin}. stderr=${buffer}`);
  }

  const wsUrl = new URL(wsEndpoint);
  const listRes = await fetch(`http://${wsUrl.host}/json/list`);
  const targets = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pageTarget?.webSocketDebuggerUrl) {
    try { proc.kill(); } catch {}
    throw new Error('No page target found in DevTools JSON list');
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = err => reject(err);
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    }
  };

  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`CDP ${method} timed out after 60s`));
        }
      }, 60_000);
      pending.set(id, {
        resolve: val => { clearTimeout(timer); resolve(val); },
        reject: err => { clearTimeout(timer); reject(err); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    async setViewport(width: number, height: number) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },
    async goto(url: string) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) {
        const res = await send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        if (res?.result?.value === 'complete') break;
        await new Promise(r => setTimeout(r, 50));
      }
    },
    async evaluate<T>(expression: string): Promise<T> {
      const res = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res?.exceptionDetails) {
        throw new Error(
          `Runtime.evaluate exception: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`,
        );
      }
      return res?.result?.value as T;
    },
    async close() {
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
    },
  };
}

async function treeHash(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const full = join(dir, name);
    try {
      h.update(name);
      h.update(await readFile(full));
    } catch {}
  }
  return h.digest('hex');
}

export async function runCompareModeBrowserVerification() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-compare-mode-browser-')));
  const profileDir = join(root, 'chrome-profile');
  await mkdir(profileDir, { recursive: true });
  const stateDir = join(root, 'state');
  let session: CdpSession | null = null;
  let singleServer: Awaited<ReturnType<typeof startServer>> | null = null;

  try {
    const stripProbeDir = new URL('./fixtures/strip-probe/build/', import.meta.url);
    const baseModel = JSON.parse(await readFile(new URL('skeleton.model.json', stripProbeDir), 'utf8'));
    const rigidPng = await readFile(new URL('rigid.png', stripProbeDir));
    const meshPng = await readFile(new URL('mesh.png', stripProbeDir));

    // Stand-in producers in root/node_modules for Apply · Rebuild
    const fakeParts = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='--version'){console.log('1.42.0');process.exit(0);}
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));console.log('rig-parts rig: wrote '+out);process.exit(0);}
if(a[0]==='check'){const out=f('--out'),rig=JSON.parse(fs.readFileSync(path.join(f('--rig'),'rig.json'),'utf8'));fs.mkdirSync(out,{recursive:true});const fail=!!(rig.mesh&&rig.mesh.r===9);fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:!fail,TEXTURE_STRETCH:{status:fail?'FAIL':'PASS'},gate_spine_html_green:!fail}));console.log(fail?'check: FAIL (TEXTURE_STRETCH)':'check: PASS');process.exit(fail?1:0);}
const out=f('--out');fs.mkdirSync(out,{recursive:true});const mesh=fs.readFileSync(f('--mesh'),'utf8');
fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify({mesh:JSON.parse(mesh)}));fs.writeFileSync(path.join(out,'motion.json'),'{}');
fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part:f('--part'),page_edges:'free',pack_shape:'polygon'},target:{before:{vertices:4,triangles:2,hull:4},after:{vertices:4,triangles:2,hull:4}}}));
console.log('rig-parts remesh: wrote 3 file(s) under '+out);`;

    const srcBuildDir = join(root, 'a/build');
    const fakeRigc = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='--version'){console.log('2.64.1');process.exit(0);}
const out=f('--out');fs.mkdirSync(out,{recursive:true});
const rigPath=f('--rig');const srcBuild=${JSON.stringify(srcBuildDir)};
for(const n of ['skeleton.model.json','rigid.png','mesh.png']){if(fs.existsSync(path.join(srcBuild,n)))fs.copyFileSync(path.join(srcBuild,n),path.join(out,n));}
const model=JSON.parse(fs.readFileSync(path.join(out,'skeleton.model.json'),'utf8'));
const rig=JSON.parse(fs.readFileSync(rigPath,'utf8'));
model.rig={...model.rig,rebuilt:rig,rebuiltRegions:rig.mesh?rig.mesh.contour.regions:null};
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify(model));
console.log('rigc: wrote '+path.join(out,'skeleton.model.json'));`;

    const fakePose = `const fs=require('fs');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('0.37.0');process.exit(0);}process.exit(0);`;

    await mkdir(join(root, 'node_modules/@rig-c/parts/bin'), { recursive: true });
    await mkdir(join(root, 'node_modules/rig-c/bin'), { recursive: true });
    await mkdir(join(root, 'node_modules/@rig-c/pose/bin'), { recursive: true });
    await writeFile(join(root, 'node_modules/@rig-c/parts/package.json'), JSON.stringify({ name: '@rig-c/parts', version: '1.42.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }));
    await writeFile(join(root, 'node_modules/@rig-c/parts/bin/rig-parts.cjs'), fakeParts);
    await writeFile(join(root, 'node_modules/rig-c/package.json'), JSON.stringify({ name: 'rig-c', version: '2.64.1', bin: { rigc: './bin/rigc.cjs' } }));
    await writeFile(join(root, 'node_modules/rig-c/bin/rigc.cjs'), fakeRigc);
    await writeFile(join(root, 'node_modules/@rig-c/pose/package.json'), JSON.stringify({ name: '@rig-c/pose', version: '0.37.0', bin: { 'rig-pose': './bin/rig-pose.cjs' } }));
    await writeFile(join(root, 'node_modules/@rig-c/pose/bin/rig-pose.cjs'), fakePose);

    const sequence = {
      spec: 'rig-pose-sequence/1',
      space: { units: 'picture-px', origin: 'top-left', y: 'down' },
      width: 80,
      height: 64,
      source: 'test',
      frames: [0, 1, 2].map(i => ({
        t: i * 0.1,
        people: [{ id: 'a', joints: { neck: { state: 'observed', at: [40, 20 + i], score: 0.9 }, r_shoulder: { state: 'observed', at: [30, 25], score: 0.9 }, r_elbow: { state: 'observed', at: [25, 35], score: 0.9 }, r_wrist: { state: 'observed', at: [20, 45], score: 0.9 } } }],
      })),
    };

    for (const [side, cx, strength] of [['a', 10, 100], ['b', 14, 140]] as const) {
      const pkg = join(root, side);
      await mkdir(join(pkg, 'build'), { recursive: true });
      await mkdir(join(pkg, 'images'), { recursive: true });
      await mkdir(join(pkg, 'rig/out/rig'), { recursive: true });
      await mkdir(join(pkg, 'rig/out/parts'), { recursive: true });

      const bust = { name: 'bust_r', shape: 'circle' as const, cx, cy: 10, r: 8, bone: 'mesh', spacing: 4, band: 6 };
      const cfg = {
        key: `rig-${side}`,
        bones: [
          { name: 'rigid', parent: 'root', at: [-18, 0], tip: [-18, 12] },
          { name: 'mesh', parent: 'root', at: [18, 0], points: [[18, 0], [18, 6]], tip: [18, 12] },
        ],
        regions: { rigid: 'rigid' },
        meshes: {
          mesh: {
            contour: { tolerance: 2, margin: 2, spacing: 8, maxEdge: 16, stray: 40, bridges: true, regions: [bust] },
            r: 6,
            segments: [['mesh', [10, 2], [10, 18]]],
          },
        },
        constraints: [
          { type: 'physics', name: 'mesh_physics', bone: 'mesh', x: 1, inertia: 1, rotate: 1, strength, damping: 0.85, wind: 1, gravity: 2 },
        ],
        motion: {
          duration: 1,
          tracks: [{ bone: 'mesh', prop: 'rotate', amp: 5, period: 1, phase: 0 }],
        },
        cloth: {
          hem: { parts: ['mesh'], chains: 2, links: 3, spacing: 8 },
        },
      };
      const model = structuredClone(baseModel);
      const meshBone = model.bones.find((b: { name?: string }) => b.name === 'mesh');
      if (meshBone) meshBone.length = 12;
      model.constraints = [
        { kind: 'physics', declaredIn: 'rig', name: 'mesh_physics', bone: 'mesh', x: 1, inertia: 1, rotate: 1, strength, damping: 0.85, wind: 1, gravity: 2 },
      ];

      await writeFile(join(pkg, 'rig/config.json'), JSON.stringify(cfg, null, 2));
      await writeFile(join(pkg, 'rig/out/parts.json'), JSON.stringify({ parts: [{ name: 'mesh', box: [0, 0, 20, 20] }, { name: 'rigid', box: [0, 0, 20, 20] }] }));
      await writeFile(join(pkg, 'rig/out/rig/rig.json'), JSON.stringify({ bones: [{ name: 'root' }, { name: 'rigid' }, { name: 'mesh' }] }));
      await writeFile(join(pkg, 'rig/out/rig/motion.json'), JSON.stringify({ animations: { inspect: { duration: 1, bones: {} } } }));
      await writeFile(join(pkg, 'rig/out/rig/mesh_report.json'), '{}');
      await writeFile(join(pkg, 'build/skeleton.model.json'), JSON.stringify(model, null, 2));
      await writeFile(join(pkg, 'build/rigid.png'), rigidPng);
      await writeFile(join(pkg, 'build/mesh.png'), meshPng);
      await writeFile(join(pkg, 'images/rigid.png'), rigidPng);
      await writeFile(join(pkg, 'images/mesh.png'), meshPng);
      await writeFile(join(pkg, 'motion.json'), JSON.stringify({ side, animations: { inspect: { duration: 1 } } }));
      await writeFile(join(pkg, 'dance.pose.json'), JSON.stringify(sequence));
    }

    const refPath = join(root, 'ref.mp4');
    await writeFile(refPath, Buffer.from(PROBE_MP4_BASE64, 'base64'));

    const beforeHashA = await treeHash(join(root, 'a'));
    const beforeHashB = await treeHash(join(root, 'b'));

    // 1. Start single-review server on Build A and launch headless browser first
    const singlePkg = await loadReview(join(root, 'a'));
    singleServer = await startServer(singlePkg, { port: 0, stateDir: join(stateDir, 'single') });

    session = await launchCdpSession(profileDir);
    await session.setViewport(1440, 900);

    // Verify single-review top switch
    await session.goto(`http://127.0.0.1:${singleServer.port}/`);
    const singleCheck = await session.evaluate<{
      modes: Array<{ mode: string | null; text: string; disabled: boolean; pressed: string | null; title: string }>;
    }>(`(() => {
      const buttons = [...document.querySelectorAll('.mode-switch button')].map(b => ({
        mode: b.getAttribute('data-mode'),
        text: (b.textContent || '').trim(),
        disabled: b.disabled,
        pressed: b.getAttribute('aria-pressed'),
        title: b.getAttribute('title') || '',
      }));
      return { modes: buttons };
    })()`);

    // 2. Open comparison session through the managed front and navigate immediately
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const frontPort = probe.port!;
    probe.stop(true);
    const opened = await openReview(
      { input: join(root, 'a'), compare: join(root, 'b'), reference: refPath, animation: 'inspect' },
      { stateDir, frontPort },
    );

    // Verify comparison session in browser
    await session.goto(opened.url);
    const compareCheck = await session.evaluate<any>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // Wait for comparison session and both players + side tools to finish loading
      for (let i = 0; i < 200; i++) {
        const playBtn = document.getElementById('play');
        const aCanvas = document.querySelector('#a-root canvas, #a-root img');
        const bCanvas = document.querySelector('#b-root canvas, #b-root img');
        const handoff = document.getElementById('handoff-line');
        if (playBtn && !playBtn.disabled && aCanvas && bCanvas && handoff && handoff.textContent && !handoff.textContent.includes('Reading')) break;
        await sleep(25);
      }

      window.__compareBootSentinel = 'no-reload-1';

      const modeButtons = [...document.querySelectorAll('.mode-switch button')].map(b => ({
        mode: b.getAttribute('data-mode'),
        text: (b.textContent || '').trim(),
        disabled: b.disabled,
        pressed: b.getAttribute('aria-pressed'),
      }));

      const initialMode = {
        comparePressed: document.querySelector('.mode-switch [data-mode="compare"]')?.getAttribute('aria-pressed'),
        pickerHidden: document.getElementById('mode-build-picker')?.hidden,
        refHidden: document.getElementById('reference-pane')?.hidden,
        aHidden: document.getElementById('a-pane')?.hidden,
        bHidden: document.getElementById('b-pane')?.hidden,
      };

      // Seek to t = 0.25s and select the 'mesh' slot in Parts explorer
      const scrub = document.getElementById('scrub');
      scrub.value = '0.25';
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(120);
      const timeBeforeSwitch = Number(scrub.value);

      const meshPartBtn = document.querySelector('[data-part-list] button[data-side="a"][data-slot="mesh"]');
      if (meshPartBtn) meshPartBtn.click();
      await sleep(80);

      // Switch Setup -> Animate -> Compare -> Setup with no reload, time and selection preserved
      const readScreenState = (m) => {
        const pressedPart = document.querySelector('[data-part-list] button[aria-pressed="true"]');
        return {
          mode: m,
          sentinel: window.__compareBootSentinel,
          time: Number(document.getElementById('scrub').value),
          selectedPart: pressedPart ? pressedPart.getAttribute('data-side') + ':' + pressedPart.getAttribute('data-slot') : null,
          pickerHidden: document.getElementById('mode-build-picker').hidden,
          pickedLabel: document.getElementById('picked-build-label').textContent,
          refHidden: document.getElementById('reference-pane').hidden,
          aHidden: document.getElementById('a-pane').hidden,
          bHidden: document.getElementById('b-pane').hidden,
          rigPanelHidden: document.getElementById('inspector-rig').hidden,
          playbackPanelHidden: document.getElementById('inspector-playback').hidden,
          partRows: [...document.querySelectorAll('[data-part-list] button')].map(b => b.getAttribute('data-side') + ':' + b.getAttribute('data-slot')),
          texts: {
            toolbar: document.getElementById('toolbar-mode-hint')?.textContent || '',
            status: document.getElementById('message')?.textContent || '',
            inputs: document.querySelector('#workspace-left .workspace-sources > p.hint, #workspace-left > p.hint')?.textContent || '',
            rigInspector: document.getElementById('rig-inspector-hint')?.textContent || '',
            playbackInspector: document.getElementById('playback-inspector-hint')?.textContent || '',
            partDetail: document.getElementById('selected-part')?.textContent || '',
          },
        };
      };

      const clickMode = async (m) => {
        document.querySelector('.mode-switch [data-mode="' + m + '"]').click();
        await sleep(80);
        return readScreenState(m);
      };

      const stepSetup1 = await clickMode('rig');
      const stepAnimate = await clickMode('playback');
      const stepCompare = await clickMode('compare');
      const stepSetup2 = await clickMode('rig');

      // Inspect Setup and Animate modules on Build A, then Build B
      const inspectPickedBuild = async (side) => {
        document.querySelector('#mode-build-picker [data-build-side="' + side + '"]').click();
        await sleep(120);
        await clickMode('rig');
        // Ensure 'mesh' slot on the picked side is selected (without toggling it off if already pressed)
        const partBtn = document.querySelector('[data-part-list] button[data-side="' + side + '"][data-slot="mesh"]');
        if (partBtn && partBtn.getAttribute('aria-pressed') !== 'true') {
          partBtn.click();
          await sleep(100);
        }
        const setupScreen = readScreenState('rig');

        const chestCx = document.getElementById('chest-0-cx')?.value;
        const chestEditHidden = document.getElementById('chest-edit')?.hidden;
        const meshEditHidden = document.getElementById('mesh-edit')?.hidden;
        const meshParamCount = document.querySelectorAll('#mesh-params input').length;
        const densityBuildDisabled = document.getElementById('density-strip-build')?.disabled;
        const weightsShowDisabled = document.getElementById('weights-show')?.disabled;
        const bonesOptions = [...document.querySelectorAll('#bones-select option')].map(o => o.value).filter(Boolean);
        const rigFieldsRegionCount = document.querySelectorAll('#rig-fields-region select').length;
        const clothTags = [...document.querySelectorAll('#cloth-tag option')].map(o => o.value).filter(Boolean);
        const cutsPanelPresent = !!document.getElementById('cuts-panel');

        await clickMode('playback');
        const animateScreen = readScreenState('playback');
        // Select Whole rig so bone tracks (rigid, mesh) are shown in timeline and curve views
        const wholeBtn = document.querySelector('[data-part-whole]');
        if (wholeBtn && wholeBtn.getAttribute('aria-pressed') !== 'true') {
          wholeBtn.click();
          await sleep(80);
        }
        // Timeline, Curve view, Bone tree inside #animation-inspection
        document.querySelector('[data-animation-view="timeline"]')?.click();
        await sleep(40);
        const timelineLanes = document.querySelectorAll('#animation-inspection .animation-lane').length;
        const timelineKeys = document.querySelectorAll('#animation-inspection .animation-key').length;
        const editableLanes = document.querySelectorAll('#animation-inspection .animation-lane[data-editable="true"]').length;
        const gateEl = document.querySelector('#animation-inspection [data-animation-gate]');
        const gateCode = gateEl?.getAttribute('data-gate-code') || '';
        const gateEditable = gateEl?.getAttribute('data-editable') || '';
        const gateText = gateEl?.textContent || '';
        const animApplyDisabled = document.querySelector('#animation-inspection [data-animation-apply]')?.disabled ?? false;
        const dockPanelPresent = !!document.getElementById('animation-dock');
        const animateBlocksPresent = !!document.getElementById('animate-blocks');

        document.querySelector('[data-animation-view="curve"]')?.click();
        await sleep(40);
        const curvePaths = document.querySelectorAll('#animation-inspection svg[data-curve-plot] path.animation-curve').length;
        const curveReadout = document.querySelector('#animation-inspection [data-curve-readout]')?.textContent || '';

        document.querySelector('[data-animation-view="tree"]')?.click();
        await sleep(40);
        const treeBones = [...document.querySelectorAll('#animation-inspection .animation-tree [data-tree-kind="bone"]')].map(b => b.getAttribute('data-tree-name'));

        // Physics, Idle tracks, Retarget, Readings, Requirements
        const physicsText = document.getElementById('physics-rows')?.textContent || '';
        const idleText = document.getElementById('idle-track-list')?.textContent || '';
        const retargetSequences = [...document.querySelectorAll('#retarget-sequence option')].map(o => o.value).filter(Boolean);
        const readingsPresent = !!document.getElementById('readings');
        const requirementsPresent = !!document.getElementById('requirements');

        return {
          side,
          pickedLabel: document.getElementById('picked-build-label')?.textContent,
          setupScreen,
          animateScreen,
          setup: {
            chestCx,
            chestEditHidden,
            meshEditHidden,
            meshParamCount,
            densityBuildDisabled,
            weightsShowDisabled,
            bonesOptions,
            rigFieldsRegionCount,
            clothTags,
            cutsPanelPresent,
          },
          animate: {
            timelineLanes,
            timelineKeys,
            editableLanes,
            gateCode,
            gateEditable,
            gateText,
            animApplyDisabled,
            dockPanelPresent,
            animateBlocksPresent,
            curvePaths,
            curveReadout,
            treeBones,
            physicsHasStrength: physicsText.includes(side === 'a' ? '100' : '140'),
            idleHasMesh: idleText.includes('mesh'),
            retargetSequences,
            readingsPresent,
            requirementsPresent,
          },
        };
      };

      const buildA = await inspectPickedBuild('a');
      const buildB = await inspectPickedBuild('b');
      const backToCompare = await clickMode('compare');

      // Place stage comments in Setup, Animate and Compare modes (before Apply · Rebuild puts a scratch build on stage)
      const placeStageComment = async (modeKey, noteText, offset) => {
        await clickMode(modeKey);
        const commentBtn = document.getElementById('stage-comment');
        if (commentBtn.getAttribute('aria-pressed') !== 'true') commentBtn.click();
        await sleep(40);
        const vp = !document.getElementById('a-pane').hidden
          ? document.getElementById('a-viewport')
          : document.getElementById('b-viewport');
        const rect = vp.getBoundingClientRect();
        const pt = {
          bubbles: true,
          clientX: rect.left + 40 + offset * 15,
          clientY: rect.top + 40 + offset * 15,
          pointerId: 1,
          button: 0,
          buttons: 1,
          isPrimary: true,
        };
        vp.dispatchEvent(new PointerEvent('pointerdown', pt));
        vp.dispatchEvent(new PointerEvent('pointerup', { ...pt, buttons: 0 }));
        for (let i = 0; i < 60; i++) {
          if (document.querySelector('.stage-comment-composer input[type="text"]')) break;
          await sleep(25);
        }
        const noteInput = document.querySelector('.stage-comment-composer input[type="text"]');
        if (noteInput) {
          noteInput.value = noteText;
          noteInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const form = document.querySelector('.stage-comment-composer');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await sleep(100);
      };

      await placeStageComment('rig', 'comment in setup', 0);
      await placeStageComment('playback', 'comment in animate', 1);
      await placeStageComment('compare', 'comment in compare', 2);
      const commentBtnAfter = document.getElementById('stage-comment');
      if (commentBtnAfter && commentBtnAfter.getAttribute('aria-pressed') === 'true') commentBtnAfter.click();
      document.getElementById('submit').click();
      await sleep(200);

      // Trigger Apply · Rebuild on Build B in Setup mode
      document.querySelector('#mode-build-picker [data-build-side="b"]').click();
      await sleep(80);
      await clickMode('rig');
      const cxInput = document.getElementById('chest-0-cx');
      cxInput.value = '16';
      cxInput.dispatchEvent(new Event('input', { bubbles: true }));
      cxInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(60);
      document.getElementById('bust-apply').click();

      for (let i = 0; i < 200; i++) {
        const items = document.querySelectorAll('#applied-list li');
        if (items.length > 0 && window.rigReviewEditor.stage('b').applied) break;
        await sleep(40);
      }
      await sleep(80);
      const bAppliedCount = document.querySelectorAll('#applied-list li').length;
      const chestStatusAfterRegionsApply = document.getElementById('chest-editor-status')?.textContent || '';

      // Switch back to Build A and verify Build A was NOT modified
      document.querySelector('#mode-build-picker [data-build-side="a"]').click();
      await sleep(100);
      const aAppliedCount = document.querySelectorAll('#applied-list li').length;
      const aChestCxAfterBApply = document.getElementById('chest-0-cx')?.value;

      // Bar 1a: After Apply on picked Build B, adding feedback for B carries B's applied record while A carries null
      const addFormFeedback = async (sideVal, catVal, summaryText) => {
        const sideSel = document.getElementById('side');
        sideSel.value = sideVal;
        sideSel.dispatchEvent(new Event('change', { bubbles: true }));
        const startIn = document.getElementById('frame-start');
        const endIn = document.getElementById('frame-end');
        startIn.value = '0';
        endIn.value = '2';
        const kindSel = document.getElementById('target-kind');
        kindSel.value = 'bone';
        kindSel.dispatchEvent(new Event('change', { bubbles: true }));
        const nameIn = document.getElementById('target-name');
        nameIn.value = 'mesh';
        const catSel = document.getElementById('category');
        catSel.value = catVal;
        const sumIn = document.getElementById('summary');
        sumIn.value = summaryText;
        document.getElementById('add-feedback').click();
        await sleep(60);
      };

      await addFormFeedback('b', 'quality', 'feedback on applied B');
      await addFormFeedback('a', 'quality', 'feedback on unapplied A');
      document.getElementById('submit').click();
      await sleep(200);

      const sessionAfterRegionsApply = await (await fetch(new URL('api/compare/session', location.href))).json();
      const fbAppliedB = (sessionAfterRegionsApply.feedback || []).find(f => f.summary === 'feedback on applied B');
      const fbUnappliedA = (sessionAfterRegionsApply.feedback || []).find(f => f.summary === 'feedback on unapplied A');
      const stageBApplied = window.rigReviewEditor.stage('b').applied;

      // Bar 1b: A patch Apply whose check FAILs on Build B is refused on Submit with EDIT_SUBMIT_UNCHECKED
      document.querySelector('#mode-build-picker [data-build-side="b"]').click();
      await sleep(80);
      await clickMode('rig');
      window.rigReviewEditor.mesh.select('mesh');
      window.rigReviewEditor.mesh.set(['r'], 9);
      await window.rigReviewEditor.mesh.apply();
      await sleep(80);
      const stageBFailedPatch = window.rigReviewEditor.stage('b').applied;
      await addFormFeedback('b', 'defect', 'feedback on failed-check B');
      document.getElementById('submit').click();
      await sleep(200);
      const failedCheckMessage = document.getElementById('message')?.textContent || '';
      const failedCheckIsError = document.getElementById('message')?.classList.contains('error') ?? false;

      // Clean up the unsubmitted failed-check feedback item so the session stays valid
      const deleteButtons = [...document.querySelectorAll('#feedback-list .feedback-item button')];
      if (deleteButtons.length > 0) {
        deleteButtons[deleteButtons.length - 1].click();
        await sleep(60);
      }

      // Bar 2: With environment applied, playing after Gust and after Jolt moves the picked build's pose
      // away from the same run without them (read as a number), while the unpicked build's pose does not change.
      document.querySelector('#mode-build-picker [data-build-side="a"]').click();
      await sleep(80);
      await clickMode('playback');

      const runEnvPlayback = async (trigger) => {
        document.getElementById('physics-reset').click();
        await sleep(60);
        scrub.value = '0';
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < 120; i++) {
          if (!document.getElementById('add-feedback').disabled && Number(document.getElementById('scrub').value) < 0.01) break;
          await sleep(25);
        }
        const windBase = document.getElementById('wind-base');
        windBase.value = '0';
        windBase.dispatchEvent(new Event('input', { bubbles: true }));
        const gustPeak = document.getElementById('wind-gust-peak');
        gustPeak.value = '3';
        gustPeak.dispatchEvent(new Event('change', { bubbles: true }));
        const gustDur = document.getElementById('wind-gust-duration');
        gustDur.value = '1.2';
        gustDur.dispatchEvent(new Event('change', { bubbles: true }));
        if (trigger === 'gust') {
          document.getElementById('wind-gust').click();
        } else if (trigger === 'jolt') {
          document.getElementById('jolt').click();
        }
        document.getElementById('play').click();
        for (let i = 0; i < 200; i++) {
          const v = document.getElementById('reference-video');
          const t = Number(document.getElementById('scrub').value);
          const msg = document.getElementById('message')?.textContent || '';
          const settled = v.paused && !document.getElementById('add-feedback').disabled && t >= 0.95 && msg.includes('Playback stopped at the last supported decoded reference frame');
          if (settled) break;
          await sleep(25);
        }
        await sleep(40);
        return {
          time: Number(document.getElementById('scrub').value),
          windReadout: document.getElementById('wind-readout')?.textContent || '',
          a: window.rigReviewEditor.bone('mesh', 'a'),
          b: window.rigReviewEditor.bone('mesh', 'b'),
        };
      };

      const envBaseline = await runEnvPlayback('none');
      const envGust = await runEnvPlayback('gust');
      const envJolt = await runEnvPlayback('jolt');

      // #247: Enable environment in Animate, trigger Gust, return to Compare and play:
      // neither build receives the picked environment in Compare, and returning to Animate restores the state left.
      const seekZero = async () => {
        scrub.value = '0';
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < 120; i++) {
          if (!document.getElementById('add-feedback').disabled && Number(document.getElementById('scrub').value) < 0.01) break;
          await sleep(25);
        }
      };
      const playCurrentModeToEnd = async () => {
        document.getElementById('play').click();
        for (let i = 0; i < 200; i++) {
          const v = document.getElementById('reference-video');
          const t = Number(document.getElementById('scrub').value);
          const msg = document.getElementById('message')?.textContent || '';
          const settled = v.paused && !document.getElementById('add-feedback').disabled && t >= 0.95 && msg.includes('Playback stopped at the last supported decoded reference frame');
          if (settled) break;
          await sleep(25);
        }
        await sleep(40);
        return {
          mode: window.rigReviewEditor.mode(),
          time: Number(document.getElementById('scrub').value),
          windReadout: document.getElementById('wind-readout')?.textContent || '',
          a: window.rigReviewEditor.bone('mesh', 'a'),
          b: window.rigReviewEditor.bone('mesh', 'b'),
        };
      };

      document.getElementById('physics-reset').click();
      await sleep(60);
      await clickMode('compare');
      await seekZero();
      const compareBaseline = await playCurrentModeToEnd();

      await seekZero();
      await clickMode('playback');
      document.getElementById('wind-base').value = '0';
      document.getElementById('wind-base').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('wind-gust-peak').value = '3';
      document.getElementById('wind-gust-peak').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('wind-gust-duration').value = '1.2';
      document.getElementById('wind-gust-duration').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('wind-gust').click();
      await sleep(40);

      await clickMode('compare');
      const compareAfterAnimateGust = await playCurrentModeToEnd();

      await clickMode('playback');
      const animateRestoredControls = {
        applied: document.getElementById('environment-applied')?.checked ?? false,
        gustPressed: document.getElementById('wind-gust')?.getAttribute('aria-pressed') ?? null,
        gustPeak: document.getElementById('wind-gust-peak')?.value ?? '',
        gustDuration: document.getElementById('wind-gust-duration')?.value ?? '',
        windReadoutBeforePlay: document.getElementById('wind-readout')?.textContent || '',
      };
      await seekZero();
      const animateRestoredPlay = await playCurrentModeToEnd();

      await clickMode('compare');
      const comparePausedAfterAnimateGust = {
        a: window.rigReviewEditor.bone('mesh', 'a'),
        b: window.rigReviewEditor.bone('mesh', 'b'),
      };

      document.getElementById('physics-reset').click();
      await sleep(60);

      const poseDelta = (p1, p2) => Math.hypot((p1?.x ?? 0) - (p2?.x ?? 0), (p1?.y ?? 0) - (p2?.y ?? 0), (p1?.rotationX ?? 0) - (p2?.rotationX ?? 0));
      const environmentPlayback = {
        baseline: envBaseline,
        gust: envGust,
        jolt: envJolt,
        gustPickedDelta: poseDelta(envGust.a, envBaseline.a),
        joltPickedDelta: poseDelta(envJolt.a, envBaseline.a),
        gustUnpickedDelta: poseDelta(envGust.b, envBaseline.b),
        joltUnpickedDelta: poseDelta(envJolt.b, envBaseline.b),
        compareBaseline,
        compareAfterAnimateGust: {
          play: compareAfterAnimateGust,
          deltaA: poseDelta(compareAfterAnimateGust.a, compareBaseline.a),
          deltaB: poseDelta(compareAfterAnimateGust.b, compareBaseline.b),
          pausedAfterSwitchDeltaA: poseDelta(comparePausedAfterAnimateGust.a, compareBaseline.a),
          pausedAfterSwitchDeltaB: poseDelta(comparePausedAfterAnimateGust.b, compareBaseline.b),
        },
        animateRestored: {
          controls: animateRestoredControls,
          play: animateRestoredPlay,
          deltaA: poseDelta(animateRestoredPlay.a, compareBaseline.a),
          deltaAFromWindZeroBaseline: poseDelta(animateRestoredPlay.a, envBaseline.a),
          deltaB: poseDelta(animateRestoredPlay.b, compareBaseline.b),
        },
      };

      const [compareRes, sessionRes] = await Promise.all([
        fetch(new URL('api/compare', location.href)),
        fetch(new URL('api/compare/session', location.href)),
      ]);
      const compareData = await compareRes.json();
      const sessionData = await sessionRes.json();
      const commentModes = (sessionData.feedback || []).map(f => f.context?.comment?.mode).filter(Boolean);

      return {
        modeButtons,
        initialMode,
        timeBeforeSwitch,
        switches: [stepSetup1, stepAnimate, stepCompare, stepSetup2],
        buildA,
        buildB,
        backToCompare,
        applyIsolation: {
          bAppliedCount,
          aAppliedCount,
          aChestCxAfterBApply,
        },
        appliedFeedbackCheck: {
          chestStatusAfterRegionsApply,
          bFeedbackApplied: fbAppliedB?.context?.applied ?? null,
          aFeedbackApplied: fbUnappliedA?.context?.applied ?? null,
          stageBApplied,
          stageBFailedPatchCheck: stageBFailedPatch?.check ?? null,
          failedCheckMessage,
          failedCheckIsError,
        },
        environmentPlayback,
        commentModes,
        binding: {
          sourceHash: compareData.sourceHash,
          aRigSha256: compareData.a.reviewedSource.rig.sha256,
          bRigSha256: compareData.b.reviewedSource.rig.sha256,
          referenceSha256: compareData.reference.sha256,
        },
      };
    })()`);

    // Also verify an old compare deep link (without selection.mode) opens in Compare mode
    const legacyBookmark: InspectionBookmark = {
      schema: 'rig-review-inspection/1',
      binding: {
        mode: 'compare',
        sourceHash: compareCheck.binding.sourceHash,
        rigs: [compareCheck.binding.aRigSha256, compareCheck.binding.bRigSha256],
      },
      animation: 'inspect',
      time: 0.4,
      theme: 'dark',
      layers: { images: true, meshes: false, bones: false },
      view: {
        schema: 'rig-review-view/1',
        cameraSync: true,
        activeCamera: 'a',
        cameras: {
          rig: null,
          a: { space: 'world', center: { x: 0, y: 0 }, zoom: 1, viewport: { width: 100, height: 100 }, visible: { x: -50, y: -50, width: 100, height: 100 } },
          b: { space: 'world', center: { x: 0, y: 0 }, zoom: 1, viewport: { width: 100, height: 100 }, visible: { x: -50, y: -50, width: 100, height: 100 } },
          reference: { space: 'image', center: { x: 40, y: 32 }, zoom: 1, viewport: { width: 100, height: 100 }, visible: { x: -10, y: -18, width: 100, height: 100 } },
        },
      },
      selection: { reference: compareCheck.binding.referenceSha256, inspector: 'view' },
    };
    const legacyUrl = new URL(opened.url);
    legacyUrl.hash = encodeBookmark(legacyBookmark);
    await session.goto(legacyUrl.toString());
    const legacyDeepLinkCheck = await session.evaluate<{ comparePressed: string | null; time: number }>(`(async () => {
      for (let i = 0; i < 150; i++) {
        const playBtn = document.getElementById('play');
        const scrubVal = Number(document.getElementById('scrub')?.value || 0);
        if (playBtn && !playBtn.disabled && Math.abs(scrubVal - 0.4) < 0.05) break;
        await new Promise(r => setTimeout(r, 25));
      }
      return {
        comparePressed: document.querySelector('.mode-switch [data-mode="compare"]')?.getAttribute('aria-pressed') ?? null,
        time: Number(document.getElementById('scrub').value),
      };
    })()`);

    const afterHashA = await treeHash(join(root, 'a'));
    const afterHashB = await treeHash(join(root, 'b'));
    const diskUnchanged = {
      aUnchanged: beforeHashA === afterHashA,
      bUnchanged: beforeHashB === afterHashB,
    };

    const failures: string[] = [];
    if (singleCheck.modes.map(m => m.text).join(' · ') !== 'Setup · Animate · Compare')
      failures.push(`single mode switch labels mismatch: ${JSON.stringify(singleCheck.modes)}`);
    const singleCompareBtn = singleCheck.modes[2];
    if (!singleCompareBtn?.disabled || singleCompareBtn.title !== 'No second build supplied: reopen with --compare <built> --reference <video>')
      failures.push(`single Compare button state mismatch: ${JSON.stringify(singleCompareBtn)}`);

    if (compareCheck.modeButtons.map((m: any) => m.text).join(' · ') !== 'Setup · Animate · Compare')
      failures.push(`compare mode switch labels mismatch: ${JSON.stringify(compareCheck.modeButtons)}`);
    if (compareCheck.initialMode.comparePressed !== 'true' || !compareCheck.initialMode.pickerHidden)
      failures.push(`compare initial mode state mismatch: ${JSON.stringify(compareCheck.initialMode)}`);

    for (const step of compareCheck.switches) {
      if (step.sentinel !== 'no-reload-1')
        failures.push(`mode switch ${step.mode} reloaded page`);
      if (Math.abs(step.time - compareCheck.timeBeforeSwitch) > 0.02)
        failures.push(`mode switch ${step.mode} lost time: expected ${compareCheck.timeBeforeSwitch}, got ${step.time}`);
      if (step.selectedPart !== 'a:mesh')
        failures.push(`mode switch ${step.mode} lost selection: expected a:mesh, got ${step.selectedPart}`);
    }

    if (
      compareCheck.switches[2].aHidden !== false ||
      compareCheck.switches[2].bHidden !== false ||
      compareCheck.switches[2].refHidden !== false ||
      compareCheck.switches[2].partRows.length !== 4
    ) {
      failures.push(`Compare step in round-trip did not restore both panes and all 4 slots: ${JSON.stringify(compareCheck.switches[2])}`);
    }

    for (const b of [compareCheck.buildA, compareCheck.buildB]) {
      const label = `build_${b.side}`;
      const sideUpper = b.side.toUpperCase();
      const expectedBuildName = `Build ${sideUpper}`;
      for (const [modeName, screen] of [['setup', b.setupScreen], ['animate', b.animateScreen]] as const) {
        if (screen.refHidden !== false || screen.aHidden !== (b.side !== 'a') || screen.bHidden !== (b.side !== 'b')) {
          failures.push(`${label} (${modeName}): expected only picked pane (${b.side}) and reference visible, got refHidden=${screen.refHidden}, aHidden=${screen.aHidden}, bHidden=${screen.bHidden}`);
        }
        if (screen.partRows.length !== 2 || !screen.partRows.every((r: string) => r.startsWith(`${b.side}:`))) {
          failures.push(`${label} (${modeName}): expected parts explorer scoped to ${b.side} slots only, got ${JSON.stringify(screen.partRows)}`);
        }
        for (const [field, val] of Object.entries(screen.texts) as [string, string][]) {
          if (!val.includes(expectedBuildName)) {
            failures.push(`${label} (${modeName}) text.${field} does not name ${expectedBuildName}: ${JSON.stringify(val)}`);
          }
          if (val.includes('This inspector does not author geometry or motion') || val.includes('This inspection changes no source art, geometry or motion')) {
            failures.push(`${label} (${modeName}) text.${field} still contains stale read-only claim: ${JSON.stringify(val)}`);
          }
        }
      }
      if (b.setup.chestCx !== (b.side === 'a' ? '10' : '14'))
        failures.push(`${label}: expected chestCx ${b.side === 'a' ? '10' : '14'}, got ${b.setup.chestCx}`);
      if (b.setup.chestEditHidden || b.setup.meshEditHidden)
        failures.push(`${label}: chest-edit or mesh-edit hidden on mesh slot`);
      if (b.setup.meshParamCount < 1 || b.setup.densityBuildDisabled || b.setup.weightsShowDisabled)
        failures.push(`${label}: mesh/density/weights tools not active: ${JSON.stringify(b.setup)}`);
      if (!b.setup.bonesOptions.includes('mesh') || b.setup.rigFieldsRegionCount < 1 || !b.setup.clothTags.includes('hem') || !b.setup.cutsPanelPresent)
        failures.push(`${label}: bones/rigFields/cloth/cuts panels not populated: ${JSON.stringify(b.setup)}`);
      if (b.animate.timelineLanes < 1 || b.animate.timelineKeys < 1 || b.animate.curvePaths < 1 || !b.animate.treeBones.includes('mesh'))
        failures.push(`${label}: animation timeline/curve/tree not populated: ${JSON.stringify(b.animate)}`);
      if (
        b.animate.gateCode !== 'ANIMATION_COMPARE_READ_ONLY' ||
        b.animate.gateEditable !== 'false' ||
        b.animate.editableLanes !== 0 ||
        !b.animate.animApplyDisabled ||
        !b.animate.dockPanelPresent ||
        !b.animate.animateBlocksPresent
      ) {
        failures.push(`${label}: compare timeline read-only gate or split dock failed: ${JSON.stringify(b.animate)}`);
      }
      if (!b.animate.physicsHasStrength || !b.animate.idleHasMesh || !b.animate.retargetSequences.includes('pose-1'))
        failures.push(`${label}: physics/idle/retarget panels not populated: ${JSON.stringify(b.animate)}`);
    }

    if (
      compareCheck.backToCompare.refHidden !== false ||
      compareCheck.backToCompare.aHidden !== false ||
      compareCheck.backToCompare.bHidden !== false ||
      compareCheck.backToCompare.partRows.length !== 4 ||
      compareCheck.backToCompare.texts.toolbar !== 'Inspect A and B at the reference video time' ||
      compareCheck.backToCompare.texts.status !== 'Inspecting both rigs at the actual reference video time.'
    ) {
      failures.push(`Returning to Compare did not restore both panes, all 4 slots, and Compare copy: ${JSON.stringify(compareCheck.backToCompare)}`);
    }

    if (compareCheck.applyIsolation.bAppliedCount !== 1 || compareCheck.applyIsolation.aAppliedCount !== 0 || compareCheck.applyIsolation.aChestCxAfterBApply !== '10')
      failures.push(`Apply isolation failed: ${JSON.stringify(compareCheck.applyIsolation)}`);

    const afc = compareCheck.appliedFeedbackCheck;
    if (
      !afc?.bFeedbackApplied ||
      afc.bFeedbackApplied.schema !== 'rig-review-applied/1' ||
      afc.bFeedbackApplied.buildId !== afc.stageBApplied?.buildId ||
      afc.aFeedbackApplied !== null
    ) {
      failures.push(`Feedback applied record mismatch: ${JSON.stringify(afc)}`);
    }
    if (
      afc?.stageBFailedPatchCheck?.pass !== false ||
      !afc.failedCheckIsError ||
      !afc.failedCheckMessage.includes('EDIT_SUBMIT_UNCHECKED: applied build failed check — check: FAIL (TEXTURE_STRETCH)')
    ) {
      failures.push(`Failed check refusal mismatch: ${JSON.stringify(afc)}`);
    }

    const envPlay = compareCheck.environmentPlayback;
    if (
      !envPlay ||
      !(envPlay.gustPickedDelta > 1) ||
      !(envPlay.joltPickedDelta > 0.1) ||
      envPlay.gustUnpickedDelta !== 0 ||
      envPlay.joltUnpickedDelta !== 0 ||
      envPlay.compareAfterAnimateGust?.deltaA !== 0 ||
      envPlay.compareAfterAnimateGust?.deltaB !== 0 ||
      envPlay.compareAfterAnimateGust?.pausedAfterSwitchDeltaA !== 0 ||
      envPlay.compareAfterAnimateGust?.pausedAfterSwitchDeltaB !== 0 ||
      !envPlay.animateRestored?.controls?.applied ||
      envPlay.animateRestored?.controls?.gustPressed !== 'true' ||
      envPlay.animateRestored?.controls?.gustPeak !== '3' ||
      envPlay.animateRestored?.controls?.gustDuration !== '1.2' ||
      !(envPlay.animateRestored?.deltaA > 1) ||
      envPlay.animateRestored?.deltaB !== 0
    ) {
      failures.push(`Environment Gust/Jolt playback mismatch: ${JSON.stringify(envPlay)}`);
    }

    if (!diskUnchanged.aUnchanged || !diskUnchanged.bUnchanged)
      failures.push(`Input package bytes on disk changed after Apply: ${JSON.stringify(diskUnchanged)}`);

    if (JSON.stringify(compareCheck.commentModes) !== JSON.stringify(['setup', 'animate', 'compare']))
      failures.push(`Stage comment modes mismatch: ${JSON.stringify(compareCheck.commentModes)}`);

    if (legacyDeepLinkCheck.comparePressed !== 'true' || Math.abs(legacyDeepLinkCheck.time - 0.4) > 0.02)
      failures.push(`Legacy compare deep link failed: ${JSON.stringify(legacyDeepLinkCheck)}`);

    return {
      singleCheck,
      compareCheck,
      legacyDeepLinkCheck,
      diskUnchanged,
      failures,
    };
  } finally {
    await session?.close();
    await singleServer?.stop(true);
    for (const name of await readdir(join(stateDir, 'open')).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(stateDir, 'open', name), 'utf8'));
        if (rec.pid) process.kill(rec.pid, 'SIGTERM');
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runCompareModeBrowserVerification();
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) {
    console.error(`Compare mode browser checks failed (${result.failures.length}):\n` + result.failures.join('\n'));
    process.exit(1);
  }
  process.exit(0);
}
