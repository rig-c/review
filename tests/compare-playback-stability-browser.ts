/**
 * Browser verification for issue #232:
 * - Samples every animation frame across one full playback loop and seeks at 1440x900
 *   and at every compare CSS width breakpoint (1600, 1440, 1100, 1050, 850, 780, 700, 550, 540, 460).
 * - Also checks the single-review page in Animate mode.
 * - Asserts that #a-viewport, #b-viewport, #reference-viewport, the reference pane, and every .pane-foot
 *   each have exactly one height (new Set(heights).size === 1), and that the rig's framing
 *   (left, top, transform, and drawn canvas/image width, height, top) does not change across frames at a fixed camera.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';

const PROBE_MP4_BASE64 =
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAA3Jtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACnXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAIAAAACAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAhVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAADAAAAAwAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAHAbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABgHN0YmwAAACoc3RzZAAAAAAAAAABAAAAmHZwMDkAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAIAAgAEgAAABIAAAAAAAAAAEXTGF2YzYzLjEuMTAyIGxpYnZweC12cDkAAAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAB9AAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAGAAAAgAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAGAAAAAEAAAB0c3RzegAAAAAAAAAAAAAAGAAAACgAAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADgAAAA8AAAAPAAAADwAAABRzdGNvAAAAAAAAAAEAAAOeAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAABiG1kYXSCSYNCAAHwAfYAOCQcGEIAADBgAAAQ3//81M3/////sUwf////joAAhgBAkpwASUAAAyAAAENAhgBAkpwASsAAAyAAAENAhgBAkpwAScAAAyAAAENAhgBAkpwASKAAAyAAAENAhgBAkpwAR4AAAyAAAENAhgBAkpwARuAAAyAAAENAhgBAkpwARkAAAyAAAENAhgBAkpwARcAAAyAAAENAhgBAkpwARUAAAyAAAENAhgDAkpwAQQAAAyAAAENAhgBAkpwAROAAAyAAAENAhgBAkpwARGAAAyAAAENAhgBAkpwARAAAAyAAAENAhgBAkpwAQ6AAAyAAAENAhgBAkpwAQ0AAAyAAAENAhgBAkpwAQwAAAyAAAENAhgBAkpwAQsAAAyAAAENAhgBAkpwAQoAAAyAAAENAhgBAkpwAQkAAAyAAAENAhgDAkpwAQAAAAgAAQ0CGAECSnABCAAADIAAAQ0CGAECSnABB4AADIAAAQ0CGAECSnABBwAADIAAAQ0A=';

export const COMPARE_WIDTH_BREAKPOINTS = [1600, 1440, 1100, 1050, 850, 780, 700, 550, 540, 460] as const;

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
      // Prefer full chromium with in-process SwiftShader WebGL first, then headless_shell
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
    const timer = setTimeout(() => reject(new Error('Timed out waiting for DevTools listening URL: ' + stderrTail)), 15000);
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
        reject(new Error(`Browser exited before printing DevTools URL: ${stderrTail}`));
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
      entry.reject(new Error(`WebSocket closed during ${entry.method} (bin=${bin}): ${stderrTail}`));
    }
    pending.clear();
  };

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetInfos } = await send('Target.getTargets');
  const pageTarget = targetInfos.find((t: any) => t.type === 'page') ?? (await send('Target.createTarget', { url: 'about:blank' }));
  const targetId = pageTarget.targetId;
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  return {
    async setViewport(width: number, height: number) {
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
    },
    async goto(url: string) {
      await send('Page.navigate', { url }, sessionId);
      await Bun.sleep(100);
      for (let i = 0; i < 100; i++) {
        const res = await send(
          'Runtime.evaluate',
          { expression: 'document.readyState === "complete" && window.location.href === ' + JSON.stringify(url), returnByValue: true },
          sessionId,
        );
        if (res?.result?.value === true) break;
        await Bun.sleep(50);
      }
    },
    async evaluate<T>(expression: string): Promise<T> {
      const res = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (res?.exceptionDetails) {
        const desc =
          res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          JSON.stringify(res.exceptionDetails);
        throw new Error(`Browser evaluate error: ${desc}`);
      }
      return res?.result?.value as T;
    },
    async close() {
      try {
        ws.close();
      } catch {}
      try {
        proc.kill(9);
      } catch {}
    },
  };
}

async function buildDualMeshModel(variant: 'a' | 'b' = 'a'): Promise<string> {
  const raw = JSON.parse(
    await readFile(new URL('./fixtures/strip-probe/build/skeleton.model.json', import.meta.url), 'utf8'),
  );
  // Keep a static region slot on "root" ("static_region") whose drawn <img> has constant world geometry,
  // plus two mesh slots:
  // 1) "rigid" (mesh on bone "rigid"): rotates during t=0..0.3, then holds constant during t=0.3..1.0.
  // 2) "mesh" (mesh on bone "mesh"): rotates throughout t=0..1.0.
  // Thus every playback loop transitions from "Fresh meshes · WebGL" (t=0..0.3, 0 reused)
  // to "Fresh meshes · WebGL · Cached rasters also reused" (t=0.3..1.0, 1 fresh + 1 reused).
  const regionAttachment = structuredClone(raw.skins[0].attachments.rigid.rigid);
  const meshAttachment = structuredClone(raw.skins[0].attachments.mesh.mesh);
  meshAttachment.path = 'rigid';
  raw.skins[0].attachments.rigid.rigid = meshAttachment;
  raw.slots.unshift({
    name: 'static_region',
    bone: 'root',
    setup: 'rigid',
  });
  raw.skins[0].attachments.static_region = { rigid: regionAttachment };
  raw.editorOrder.skins[0].slots = ['static_region', 'mesh', 'rigid'];
  raw.rig.slotOrder = ['static_region', 'rigid', 'mesh'];
  raw.meshBones = ['rigid', 'mesh'];
  raw.meshes.push({
    slot: 'rigid',
    kind: 'authored',
    attachments: ['rigid'],
    vertices: 4,
    triangles: 2,
    bones: ['rigid'],
    coverage: 1,
    overshoot: 0,
  });
  raw.rig.meshKinds.rigid = 'authored';
  raw.rig.meshDeclaredBones.rigid = ['rigid'];

  // In animation "inspect", make bone "rigid" rotate from 0 to 25 during 0..0.3s, then hold 25 until 1.0s
  const inspectAnim = raw.animations.find((a: any) => a.name === 'inspect');
  const rigidBoneTrack = inspectAnim.bones.find((b: any) => b.name === 'rigid');
  rigidBoneTrack.timelines = [
    {
      name: 'rotate',
      keys: [
        { time: 0, value: 0 },
        { time: 0.3, value: variant === 'a' ? 25 : 28 },
        { time: 1, value: variant === 'a' ? 25 : 28 },
      ],
    },
  ];
  return JSON.stringify(raw, null, variant === 'a' ? 2 : 0);
}

export interface BreakpointMeasurement {
  width: number;
  height: number;
  frameSamples: number;
  distinct: {
    aViewportHeights: number[];
    bViewportHeights: number[];
    refViewportHeights: number[];
    refPaneHeights: number[];
    paneFoot0Heights: number[];
    paneFoot1Heights: number[];
    paneFoot2Heights: number[];
    allPaneFootHeights: number[];
    footerHeights: number[];
    refTimeWidths: number[];
    aTimeWidths: number[];
    bTimeWidths: number[];
    aRootLefts: string[];
    aRootTops: string[];
    aRootTransforms: string[];
    aCanvasWidths: number[];
    aCanvasHeights: number[];
    aCanvasTops: number[];
    aCanvasRelTops: number[];
    bRootLefts: string[];
    bRootTops: string[];
    bRootTransforms: string[];
    bCanvasWidths: number[];
    bCanvasHeights: number[];
    bCanvasTops: number[];
    bCanvasRelTops: number[];
  };
  seenRendererLabels: string[];
  seenFrameLabels: string[];
  seenTimeLabels: string[];
  tabularNums: {
    refTime: string;
    aTime: string;
    bTime: string;
  };
  singleLineEllipsisOk: boolean;
  titlesMatchTextOk: boolean;
  titleMismatches: string[];
  wrappingItems: string[];
}

export interface SingleReviewMeasurement {
  width: number;
  height: number;
  frameSamples: number;
  distinct: {
    rigViewportHeights: number[];
    refViewportHeights: number[];
    stageFooterHeights: number[];
    footerHeights: number[];
    rigRootLefts: string[];
    rigRootTops: string[];
    rigRootTransforms: string[];
    rigCanvasWidths: number[];
    rigCanvasHeights: number[];
    rigCanvasTops: number[];
  };
  tabularNums: {
    timeLabel: string;
    frameLabel: string;
  };
}

export async function runPlaybackStabilityMeasurement(): Promise<{
  compare: BreakpointMeasurement[];
  single: SingleReviewMeasurement[];
  failures: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'review-232-'));
  const profileDir = join(root, 'chrome-profile');
  await mkdir(profileDir, { recursive: true });

  const modelJsonA = await buildDualMeshModel('a');
  const modelJsonB = await buildDualMeshModel('b');
  const rigidPng = await readFile(new URL('./fixtures/strip-probe/images/rigid.png', import.meta.url));
  const meshPng = await readFile(new URL('./fixtures/strip-probe/images/mesh.png', import.meta.url));
  const motionJson = await readFile(new URL('./fixtures/strip-probe/motion.json', import.meta.url), 'utf8');
  const gateRaw = JSON.parse(await readFile(new URL('./fixtures/strip-probe/gate.json', import.meta.url), 'utf8'));
  // Set 313 frames at 24fps on gate.json so frame labels match Review F0 / 312 · video #0..
  gateRaw.summary = { ...(gateRaw.summary ?? {}), frames: 313, fps: 24, duration: 1 };

  for (const side of ['a', 'b'] as const) {
    await mkdir(join(root, side, 'build'), { recursive: true });
    await mkdir(join(root, side, 'images'), { recursive: true });
    await writeFile(join(root, side, 'build/skeleton.model.json'), side === 'a' ? modelJsonA : modelJsonB);
    await writeFile(join(root, side, 'build/rigid.png'), rigidPng);
    await writeFile(join(root, side, 'build/mesh.png'), meshPng);
    await writeFile(join(root, side, 'images/rigid.png'), rigidPng);
    await writeFile(join(root, side, 'images/mesh.png'), meshPng);
    await writeFile(join(root, side, 'motion.json'), motionJson);
    await writeFile(join(root, side, 'gate.json'), JSON.stringify(gateRaw));
  }

  const refPath = join(root, 'ref.mp4');
  await writeFile(refPath, Buffer.from(PROBE_MP4_BASE64, 'base64'));

  // Also create a single-review manifest package in root/single
  const singleDir = join(root, 'single');
  await mkdir(join(singleDir, 'build'), { recursive: true });
  await mkdir(join(singleDir, 'images'), { recursive: true });
  await writeFile(join(singleDir, 'build/skeleton.model.json'), modelJsonA);
  await writeFile(join(singleDir, 'build/rigid.png'), rigidPng);
  await writeFile(join(singleDir, 'build/mesh.png'), meshPng);
  await writeFile(join(singleDir, 'images/rigid.png'), rigidPng);
  await writeFile(join(singleDir, 'images/mesh.png'), meshPng);
  await writeFile(join(singleDir, 'motion.json'), motionJson);
  await writeFile(join(singleDir, 'gate.json'), JSON.stringify(gateRaw));
  await writeFile(join(singleDir, 'ref.mp4'), Buffer.from(PROBE_MP4_BASE64, 'base64'));
  await writeFile(
    join(singleDir, 'review.json'),
    JSON.stringify({
      schema: 'rig-review/1',
      id: 'single-probe-232',
      title: 'Single Probe #232',
      revision: '1',
      model: 'build/skeleton.model.json',
      motion: 'motion.json',
      animations: [{ id: 'inspect', label: 'Inspect' }],
      references: [{ id: 'ref-video', label: 'Reference Video', type: 'video', path: 'ref.mp4' }],
      checkpoints: [],
      axes: [],
    }),
  );

  const comparePkg = await loadCompare({
    a: join(root, 'a'),
    b: join(root, 'b'),
    reference: refPath,
    animation: 'inspect',
  });
  const compareServer = await startCompareServer(comparePkg, { port: 0, stateDir: join(root, 'state-compare') });

  const singlePkg = await loadReview(singleDir);
  const singleServer = await startServer(singlePkg, { port: 0, stateDir: join(root, 'state-single') });

  let session: CdpSession | null = null;
  try {
    session = await launchCdpSession(profileDir);
    const compareResults: BreakpointMeasurement[] = [];

    await session.setViewport(1600, 900);
    await session.goto(`http://127.0.0.1:${compareServer.port}/`);

    for (const width of COMPARE_WIDTH_BREAKPOINTS) {
      console.error(`[step] measuring compare@${width}x900`);
      const height = 900;
      await session.setViewport(width, height);

      const measurement = await session.evaluate<BreakpointMeasurement>(`(async () => {
        const waitReady = async () => {
          for (let i = 0; i < 650; i++) {
            const playBtn = document.getElementById('play');
            const aCanvas = document.querySelector('#a-root canvas, #a-root img');
            const bCanvas = document.querySelector('#b-root canvas, #b-root img');
            if (playBtn && !playBtn.disabled && aCanvas && bCanvas) return;
            const msg = document.getElementById('message')?.textContent || '';
            if (msg.includes('Comparison unavailable')) break;
            await new Promise(r => setTimeout(r, 25));
          }
          const v = document.getElementById('reference-video');
          const msg = document.getElementById('message')?.textContent;
          const aEmp = document.getElementById('a-empty')?.textContent;
          const bEmp = document.getElementById('b-empty')?.textContent;
          const rEmp = document.getElementById('reference-empty')?.textContent;
          const rHidden = document.getElementById('reference-empty')?.hidden;
          const aHidden = document.getElementById('a-empty')?.hidden;
          const bHidden = document.getElementById('b-empty')?.hidden;
          const vInfo = v ? { src: v.currentSrc, duration: v.duration, readyState: v.readyState, networkState: v.networkState, errCode: v.error?.code, errMsg: v.error?.message, rHidden, aHidden, bHidden } : null;
          throw new Error('Timed out waiting for compare page readiness at ' + ${width} + ': msg=' + msg + ' a=' + aEmp + ' b=' + bEmp + ' ref=' + rEmp + ' v=' + JSON.stringify(vInfo));
        };
        await waitReady();
        // First let viewport resize, workspace-ui apply(), ResizeObserver, and fit() settle completely
        window.dispatchEvent(new Event('resize'));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
        await new Promise(r => setTimeout(r, 80));

        const waitSettled = async () => {
          for (let i = 0; i < 200; i++) {
            const addFb = document.getElementById('add-feedback');
            const v = document.getElementById('reference-video');
            if (addFb && !addFb.disabled && v && !v.seeking && v.paused) return true;
            await new Promise(r => setTimeout(r, 15));
          }
          return false;
        };
        const settledBeforeReset = await waitSettled();
        // Reset to t=0 before starting this breakpoint's measurement if not already at 0
        const scrubReset = document.getElementById('scrub');
        if (document.getElementById('a-time')?.textContent !== '0.000000 s') {
          scrubReset.value = '0';
          scrubReset.dispatchEvent(new Event('input', { bubbles: true }));
          await waitSettled();
        }
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));

        const r1 = (n) => Math.round(n * 100) / 100;
        const aViewportHeights = new Set();
        const bViewportHeights = new Set();
        const refViewportHeights = new Set();
        const refPaneHeights = new Set();
        const paneFoot0Heights = new Set();
        const paneFoot1Heights = new Set();
        const paneFoot2Heights = new Set();
        const allPaneFootHeights = new Set();
        const footerHeights = new Set();
        const refTimeWidths = new Set();
        const aTimeWidths = new Set();
        const bTimeWidths = new Set();

        const aRootLefts = new Set();
        const aRootTops = new Set();
        const aRootTransforms = new Set();
        const aCanvasWidths = new Set();
        const aCanvasHeights = new Set();
        const aCanvasTops = new Set();
        const aCanvasRelTops = new Set();

        const bRootLefts = new Set();
        const bRootTops = new Set();
        const bRootTransforms = new Set();
        const bCanvasWidths = new Set();
        const bCanvasHeights = new Set();
        const bCanvasTops = new Set();
        const bCanvasRelTops = new Set();

        const seenRendererLabels = new Set();
        const seenFrameLabels = new Set();
        const seenTimeLabels = new Set();
        const titleMismatches = new Set();
        const wrappingItems = new Set();

        let frameSamples = 0;

        const aVp = document.getElementById('a-viewport');
        const bVp = document.getElementById('b-viewport');
        const refVp = document.getElementById('reference-viewport');
        const refPane = refVp.closest('.pane');
        const paneFoots = [...document.querySelectorAll('.pane-foot')];
        const footer = document.querySelector('footer');
        const refTime = document.getElementById('reference-time');
        const aTime = document.getElementById('a-time');
        const bTime = document.getElementById('b-time');
        const aFrame = document.getElementById('a-frame');
        const bFrame = document.getElementById('b-frame');
        const aRenderer = document.getElementById('a-renderer');
        const bRenderer = document.getElementById('b-renderer');
        const aRoot = document.getElementById('a-root');
        const bRoot = document.getElementById('b-root');

        const statusItems = [refTime, aTime, aFrame, aRenderer, bTime, bFrame, bRenderer];

        const sample = () => {
          frameSamples++;
          const aVpRect = aVp.getBoundingClientRect();
          const bVpRect = bVp.getBoundingClientRect();
          const refVpRect = refVp.getBoundingClientRect();
          const refPaneRect = refPane.getBoundingClientRect();

          aViewportHeights.add(r1(aVpRect.height));
          bViewportHeights.add(r1(bVpRect.height));
          refViewportHeights.add(r1(refVpRect.height));
          refPaneHeights.add(r1(refPaneRect.height));

          const pf0 = r1(paneFoots[0].getBoundingClientRect().height);
          const pf1 = r1(paneFoots[1].getBoundingClientRect().height);
          const pf2 = r1(paneFoots[2].getBoundingClientRect().height);
          paneFoot0Heights.add(pf0);
          paneFoot1Heights.add(pf1);
          paneFoot2Heights.add(pf2);
          allPaneFootHeights.add(pf0);
          allPaneFootHeights.add(pf1);
          allPaneFootHeights.add(pf2);

          footerHeights.add(r1(footer.getBoundingClientRect().height));

          refTimeWidths.add(r1(refTime.getBoundingClientRect().width));
          aTimeWidths.add(r1(aTime.getBoundingClientRect().width));
          bTimeWidths.add(r1(bTime.getBoundingClientRect().width));

          aRootLefts.add(aRoot.style.left);
          aRootTops.add(aRoot.style.top);
          aRootTransforms.add(aRoot.style.transform);

          bRootLefts.add(bRoot.style.left);
          bRootTops.add(bRoot.style.top);
          bRootTransforms.add(bRoot.style.transform);

          // Sample static drawn image (or canvas) inside #a-root and #b-root
          const aDrawn = aRoot.querySelector('img') || aRoot.querySelector('canvas');
          const bDrawn = bRoot.querySelector('img') || bRoot.querySelector('canvas');
          if (aDrawn) {
            const rect = aDrawn.getBoundingClientRect();
            aCanvasWidths.add(r1(rect.width));
            aCanvasHeights.add(r1(rect.height));
            aCanvasTops.add(r1(rect.top));
            aCanvasRelTops.add(r1(rect.top - aVpRect.top));
          }
          if (bDrawn) {
            const rect = bDrawn.getBoundingClientRect();
            bCanvasWidths.add(r1(rect.width));
            bCanvasHeights.add(r1(rect.height));
            bCanvasTops.add(r1(rect.top));
            bCanvasRelTops.add(r1(rect.top - bVpRect.top));
          }

          seenRendererLabels.add(aRenderer.textContent || '');
          seenFrameLabels.add(aFrame.textContent || '');
          seenTimeLabels.add(aTime.textContent || '');

          for (const item of statusItems) {
            const txt = item.textContent || '';
            const title = item.getAttribute('title') || '';
            if (txt && title !== txt) {
              titleMismatches.add(item.id + ': text=' + JSON.stringify(txt) + ' title=' + JSON.stringify(title));
            }
            const cs = getComputedStyle(item);
            if (cs.whiteSpace !== 'nowrap' || cs.textOverflow !== 'ellipsis' || cs.overflow !== 'hidden') {
              wrappingItems.add(item.id + ': whiteSpace=' + cs.whiteSpace + ' textOverflow=' + cs.textOverflow + ' overflow=' + cs.overflow);
            }
          }
        };

        // Observe DOM mutations on pane-foots and footer so even synchronous intermediate states are sampled
        const mo = new MutationObserver(() => sample());
        for (const pf of paneFoots) mo.observe(pf, { childList: true, subtree: true, characterData: true });
        mo.observe(footer, { childList: true, subtree: true, characterData: true });

        let sampling = true;
        sample();
        const rafLoop = () => {
          if (!sampling) return;
          sample();
          requestAnimationFrame(rafLoop);
        };
        requestAnimationFrame(rafLoop);

        // 1. Sample initial paused state at t=0
        await new Promise(r => setTimeout(r, 80));

        // 2. Play one full loop
        const video = document.getElementById('reference-video');
        const playBtn = document.getElementById('play');
        playBtn.click();

        // Wait for playback to advance through frames and complete one loop (or wrap around)
        const startWait = performance.now();
        while (performance.now() - startWait < 1300) {
          if (video.paused && performance.now() - startWait > 300) break;
          await new Promise(r => setTimeout(r, 20));
        }
        if (!video.paused) playBtn.click();
        await new Promise(r => setTimeout(r, 50));

        // 3. Perform seeks across both t<0.3 (both meshes fresh) and t>=0.3 (rigid mesh cached, mesh fresh)
        // plus #seek button (triggers synchronizing state + decoded timestamp message)
        const scrub = document.getElementById('scrub');
        for (const seekT of ['0.08', '0.16', '0.45', '0.65', '0.85']) {
          scrub.value = seekT;
          scrub.dispatchEvent(new Event('input', { bubbles: true }));
          await waitSettled();
          sample();
        }

        const timeInput = document.getElementById('time-input');
        const seekBtn = document.getElementById('seek');
        timeInput.value = '0.1234';
        seekBtn.click();
        await waitSettled();
        sample();

        // Also check the initial placeholder '— s' width vs numeric time width on #reference-time, #a-time, #b-time
        const prevRefText = refTime.textContent;
        refTime.textContent = '— s';
        refTime.title = '— s';
        sample();
        refTime.textContent = prevRefText;
        refTime.title = prevRefText || '';
        sample();

        sampling = false;
        mo.disconnect();

        return {
          width: ${width},
          height: ${height},
          frameSamples,
          distinct: {
            aViewportHeights: [...aViewportHeights],
            bViewportHeights: [...bViewportHeights],
            refViewportHeights: [...refViewportHeights],
            refPaneHeights: [...refPaneHeights],
            paneFoot0Heights: [...paneFoot0Heights],
            paneFoot1Heights: [...paneFoot1Heights],
            paneFoot2Heights: [...paneFoot2Heights],
            allPaneFootHeights: [...allPaneFootHeights],
            footerHeights: [...footerHeights],
            refTimeWidths: [...refTimeWidths],
            aTimeWidths: [...aTimeWidths],
            bTimeWidths: [...bTimeWidths],
            aRootLefts: [...aRootLefts],
            aRootTops: [...aRootTops],
            aRootTransforms: [...aRootTransforms],
            aCanvasWidths: [...aCanvasWidths],
            aCanvasHeights: [...aCanvasHeights],
            aCanvasTops: [...aCanvasTops],
            aCanvasRelTops: [...aCanvasRelTops],
            bRootLefts: [...bRootLefts],
            bRootTops: [...bRootTops],
            bRootTransforms: [...bRootTransforms],
            bCanvasWidths: [...bCanvasWidths],
            bCanvasHeights: [...bCanvasHeights],
            bCanvasTops: [...bCanvasTops],
            bCanvasRelTops: [...bCanvasRelTops],
          },
          seenRendererLabels: [...seenRendererLabels],
          seenFrameLabels: [...seenFrameLabels],
          seenTimeLabels: [...seenTimeLabels],
          tabularNums: {
            refTime: getComputedStyle(refTime).fontVariantNumeric,
            aTime: getComputedStyle(aTime).fontVariantNumeric,
            bTime: getComputedStyle(bTime).fontVariantNumeric,
          },
          singleLineEllipsisOk: wrappingItems.size === 0,
          titlesMatchTextOk: titleMismatches.size === 0,
          titleMismatches: [...titleMismatches].slice(0, 5),
          wrappingItems: [...wrappingItems].slice(0, 5),
        };
      })()`);

      compareResults.push(measurement);
    }

    // Measure Single-review page in Animate mode at 1440x900 and 780x900
    const singleResults: SingleReviewMeasurement[] = [];
    await session.setViewport(1440, 900);
    await session.goto(`http://127.0.0.1:${singleServer.port}/`);
    for (const width of [1440, 780]) {
      const height = 900;
      await session.setViewport(width, height);

      const singleMeasurement = await session.evaluate<SingleReviewMeasurement>(`(async () => {
        for (let i = 0; i < 200; i++) {
          const playBtn = document.getElementById('play');
          const canvas = document.querySelector('#rig-root canvas, #rig-root img');
          const refEmpty = document.getElementById('reference-empty');
          if (playBtn && !playBtn.disabled && canvas && refEmpty && refEmpty.hidden) break;
          await new Promise(r => setTimeout(r, 25));
        }
        // Switch to Animate mode (Playback inspector)
        const animateBtn = document.querySelector('[data-mode="playback"], [data-inspector="playback"]');
        if (animateBtn instanceof HTMLElement) animateBtn.click();
        await new Promise(r => setTimeout(r, 80));
        const scrubReset = document.getElementById('scrub');
        scrubReset.value = '0';
        scrubReset.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 80));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));

        const r1 = (n) => Math.round(n * 100) / 100;
        const rigViewportHeights = new Set();
        const refViewportHeights = new Set();
        const stageFooterHeights = new Set();
        const footerHeights = new Set();
        const rigRootLefts = new Set();
        const rigRootTops = new Set();
        const rigRootTransforms = new Set();
        const rigCanvasWidths = new Set();
        const rigCanvasHeights = new Set();
        const rigCanvasTops = new Set();

        let frameSamples = 0;
        const rigVp = document.getElementById('rig-viewport');
        const refVp = document.getElementById('reference-viewport');
        const stageFooter = document.querySelector('.stage-footer');
        const footer = document.querySelector('footer');
        const rigRoot = document.getElementById('rig-root');
        const timeLabel = document.getElementById('time-label');
        const frameLabel = document.getElementById('frame-label');

        const sample = () => {
          frameSamples++;
          rigViewportHeights.add(r1(rigVp.getBoundingClientRect().height));
          refViewportHeights.add(r1(refVp.getBoundingClientRect().height));
          if (stageFooter) stageFooterHeights.add(r1(stageFooter.getBoundingClientRect().height));
          footerHeights.add(r1(footer.getBoundingClientRect().height));

          rigRootLefts.add(rigRoot.style.left);
          rigRootTops.add(rigRoot.style.top);
          rigRootTransforms.add(rigRoot.style.transform);

          const drawn = rigRoot.querySelector('img') || rigRoot.querySelector('canvas');
          if (drawn) {
            const rect = drawn.getBoundingClientRect();
            rigCanvasWidths.add(r1(rect.width));
            rigCanvasHeights.add(r1(rect.height));
            rigCanvasTops.add(r1(rect.top));
          }
        };

        let sampling = true;
        sample();
        const rafLoop = () => {
          if (!sampling) return;
          sample();
          requestAnimationFrame(rafLoop);
        };
        requestAnimationFrame(rafLoop);

        await new Promise(r => setTimeout(r, 60));
        const playBtn = document.getElementById('play');
        playBtn.click();
        await new Promise(r => setTimeout(r, 1200));
        if (playBtn.getAttribute('aria-pressed') === 'true' || playBtn.textContent?.includes('Pause')) playBtn.click();
        await new Promise(r => setTimeout(r, 60));

        const scrub = document.getElementById('scrub');
        scrub.value = '0.5';
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));

        sampling = false;
        return {
          width: ${width},
          height: ${height},
          frameSamples,
          distinct: {
            rigViewportHeights: [...rigViewportHeights],
            refViewportHeights: [...refViewportHeights],
            stageFooterHeights: [...stageFooterHeights],
            footerHeights: [...footerHeights],
            rigRootLefts: [...rigRootLefts],
            rigRootTops: [...rigRootTops],
            rigRootTransforms: [...rigRootTransforms],
            rigCanvasWidths: [...rigCanvasWidths],
            rigCanvasHeights: [...rigCanvasHeights],
            rigCanvasTops: [...rigCanvasTops],
          },
          tabularNums: {
            timeLabel: getComputedStyle(timeLabel).fontVariantNumeric,
            frameLabel: getComputedStyle(frameLabel).fontVariantNumeric,
          },
        };
      })()`);
      singleResults.push(singleMeasurement);
    }

    const failures: string[] = [];
    for (const m of compareResults) {
      const prefix = `compare@${m.width}x${m.height}`;
      if (m.distinct.aViewportHeights.length !== 1)
        failures.push(`${prefix}: #a-viewport height changed: ${JSON.stringify(m.distinct.aViewportHeights)}`);
      if (m.distinct.bViewportHeights.length !== 1)
        failures.push(`${prefix}: #b-viewport height changed: ${JSON.stringify(m.distinct.bViewportHeights)}`);
      if (m.distinct.refViewportHeights.length !== 1)
        failures.push(`${prefix}: #reference-viewport height changed: ${JSON.stringify(m.distinct.refViewportHeights)}`);
      if (m.distinct.refPaneHeights.length !== 1)
        failures.push(`${prefix}: reference pane height changed: ${JSON.stringify(m.distinct.refPaneHeights)}`);
      if (m.distinct.paneFoot0Heights.length !== 1)
        failures.push(`${prefix}: .pane-foot[0] height changed: ${JSON.stringify(m.distinct.paneFoot0Heights)}`);
      if (m.distinct.paneFoot1Heights.length !== 1)
        failures.push(`${prefix}: .pane-foot[1] height changed: ${JSON.stringify(m.distinct.paneFoot1Heights)}`);
      if (m.distinct.paneFoot2Heights.length !== 1)
        failures.push(`${prefix}: .pane-foot[2] height changed: ${JSON.stringify(m.distinct.paneFoot2Heights)}`);
      if (m.distinct.allPaneFootHeights.length !== 1)
        failures.push(`${prefix}: .pane-foot heights differ across panes/frames: ${JSON.stringify(m.distinct.allPaneFootHeights)}`);
      if (m.distinct.aRootLefts.length !== 1 || m.distinct.aRootTops.length !== 1 || m.distinct.aRootTransforms.length !== 1)
        failures.push(`${prefix}: #a-root framing shook: left=${JSON.stringify(m.distinct.aRootLefts)} top=${JSON.stringify(m.distinct.aRootTops)} transform=${JSON.stringify(m.distinct.aRootTransforms)}`);
      if (m.distinct.bRootLefts.length !== 1 || m.distinct.bRootTops.length !== 1 || m.distinct.bRootTransforms.length !== 1)
        failures.push(`${prefix}: #b-root framing shook: left=${JSON.stringify(m.distinct.bRootLefts)} top=${JSON.stringify(m.distinct.bRootTops)} transform=${JSON.stringify(m.distinct.bRootTransforms)}`);
      if (m.distinct.aCanvasWidths.length !== 1 || m.distinct.aCanvasHeights.length !== 1 || m.distinct.aCanvasTops.length !== 1)
        failures.push(`${prefix}: #a-root drawn canvas shook: width=${JSON.stringify(m.distinct.aCanvasWidths)} height=${JSON.stringify(m.distinct.aCanvasHeights)} top=${JSON.stringify(m.distinct.aCanvasTops)}`);
      if (m.distinct.bCanvasWidths.length !== 1 || m.distinct.bCanvasHeights.length !== 1 || m.distinct.bCanvasTops.length !== 1)
        failures.push(`${prefix}: #b-root drawn canvas shook: width=${JSON.stringify(m.distinct.bCanvasWidths)} height=${JSON.stringify(m.distinct.bCanvasHeights)} top=${JSON.stringify(m.distinct.bCanvasTops)}`);
      if (m.tabularNums.refTime !== 'tabular-nums' || m.tabularNums.aTime !== 'tabular-nums' || m.tabularNums.bTime !== 'tabular-nums')
        failures.push(`${prefix}: time readouts missing tabular-nums: ${JSON.stringify(m.tabularNums)}`);
      if (m.distinct.refTimeWidths.length !== 1)
        failures.push(`${prefix}: #reference-time width changed across '— s' and playback: ${JSON.stringify(m.distinct.refTimeWidths)}`);
      if (!m.singleLineEllipsisOk)
        failures.push(`${prefix}: .pane-foot items not single-line ellipsis: ${JSON.stringify(m.wrappingItems)}`);
      if (!m.titlesMatchTextOk)
        failures.push(`${prefix}: .pane-foot items missing full text in title: ${JSON.stringify(m.titleMismatches)}`);
      if (m.seenTimeLabels.length < 5 || m.seenRendererLabels.length < 2)
        failures.push(`${prefix}: playback/seek did not sample multiple times/renderer states: times=${m.seenTimeLabels.length} renderers=${JSON.stringify(m.seenRendererLabels)}`);
    }

    for (const s of singleResults) {
      const prefix = `single@${s.width}x${s.height}`;
      if (s.distinct.rigViewportHeights.length !== 1)
        failures.push(`${prefix}: #rig-viewport height changed: ${JSON.stringify(s.distinct.rigViewportHeights)}`);
      if (s.distinct.refViewportHeights.length !== 1)
        failures.push(`${prefix}: #reference-viewport height changed: ${JSON.stringify(s.distinct.refViewportHeights)}`);
      if (s.distinct.rigRootLefts.length !== 1 || s.distinct.rigRootTops.length !== 1 || s.distinct.rigRootTransforms.length !== 1)
        failures.push(`${prefix}: #rig-root framing shook: left=${JSON.stringify(s.distinct.rigRootLefts)} top=${JSON.stringify(s.distinct.rigRootTops)} transform=${JSON.stringify(s.distinct.rigRootTransforms)}`);
      if (s.distinct.rigCanvasWidths.length !== 1 || s.distinct.rigCanvasHeights.length !== 1 || s.distinct.rigCanvasTops.length !== 1)
        failures.push(`${prefix}: #rig-root drawn canvas shook: width=${JSON.stringify(s.distinct.rigCanvasWidths)} height=${JSON.stringify(s.distinct.rigCanvasHeights)} top=${JSON.stringify(s.distinct.rigCanvasTops)}`);
      if (s.tabularNums.timeLabel !== 'tabular-nums' || s.tabularNums.frameLabel !== 'tabular-nums')
        failures.push(`${prefix}: single transport readouts missing tabular-nums: ${JSON.stringify(s.tabularNums)}`);
    }

    return { compare: compareResults, single: singleResults, failures };
  } finally {
    await session?.close();
    await compareServer.stop(true);
    await singleServer.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runPlaybackStabilityMeasurement();
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length > 0) {
    console.error(`Playback stability checks failed (${result.failures.length}):\n` + result.failures.join('\n'));
    process.exit(1);
  }
  process.exit(0);
}
