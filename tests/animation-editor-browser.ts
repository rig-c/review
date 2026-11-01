/**
 * Browser verification for issue #235 (Slice 3: Dopesheet Editing):
 * - Bar 1 (Dopesheet): select a key, drag it in time, add a key, delete a key; all edits extend the single client-held pending op list.
 * - Bar 2 (Inspector): edit a selected key's channel values -> set_key_value op (including multi-channel coalescing).
 * - Bar 3 (Pending preview): stage pose reflects pending edits before Apply without a build; measured pre-Apply preview pose vs post-Apply compiled build pose matches within Math.fround (0 ULP difference across bone locals, world transforms, and posed slot geometry).
 * - Bar 4 (Apply): sends the entire cumulative pending op list with handoff animationsFromHash; a second Apply sends the first edits too ([op1, op2]).
 * - Bar 5 (Read-only tracks): idle clip (ANIMATION_IDLE_GOVERNED_BY_TURN_PAD) and read-only tracks (bone.inherit, derive, lag, slot, group, physics, path, slider) state their reason by name and never look editable.
 * - Bar 6 (Apply control note, Ruling H2): states that an animation Apply builds from the handoff config.json and animations_from file into scratch and does not carry another kind's Apply on the stage.
 * - Bar 7 (U2 measurement, MAX_ANIMATION_OPS = 200 on hello): 16 tracks × 115 keys = 1,840 keys (14 editable bone tracks = 1,610 keys, 2 read-only group tracks = 230 keys); moving <= 200 keys (115 or 196 keys) succeeds, moving > 200 keys (210, 230, or 1,610 keys) refuses by name with ANIMATION_OPS_TOO_MANY and rolls back atomically.
 * - Bar 8 (Producer/compiler refusals): t > duration is not auto-extended by the client and is refused by the compiler verbatim (CE_COMPILE_KEY_AFTER_DURATION), leaving the stage build intact.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';
import { ANIMATION_APPLY_ISOLATION_NOTE } from '../web/animation-inspection.ts';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

interface CdpSession {
  setViewport(width: number, height: number): Promise<void>;
  goto(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  dispatchMouseEvent(params: {
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased';
    x: number;
    y: number;
    button?: 'left' | 'none';
    buttons?: number;
    clickCount?: number;
    modifiers?: number;
  }): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer>;
  close(): Promise<void>;
}

function findBrowserBinary(): string {
  const pwRoot = join(homedir(), '.cache', 'ms-playwright');
  const pwCandidates: string[] = [];
  if (existsSync(pwRoot)) {
    try {
      const entries = readdirSync(pwRoot).sort();
      for (const entry of [
        ...entries.filter((e) => e.startsWith('chromium-')),
        ...entries.filter((e) => e.startsWith('chromium_headless_shell')),
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
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for DevTools listening URL: ' + stderrTail)),
      15000,
    );
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
    const timer = setTimeout(() => reject(new Error('Timed out opening CDP WebSocket')), 15000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { method: string; timer: ReturnType<typeof setTimeout>; resolve: (val: any) => void; reject: (err: Error) => void }
  >();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else entry.resolve(msg.result);
      }
    }
  };
  ws.onclose = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`WebSocket closed during ${entry.method} (bin=${bin}): ${stderrTail}`));
    }
    pending.clear();
  };

  // Every CDP command has an explicit 15s timeout
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout (15000ms) on ${method}`));
      }, 15000);
      pending.set(id, { method, timer, resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetInfos } = await send('Target.getTargets');
  const pageTarget =
    targetInfos.find((t: any) => t.type === 'page') ?? (await send('Target.createTarget', { url: 'about:blank' }));
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
          {
            expression: 'document.readyState === "complete" && window.location.href === ' + JSON.stringify(url),
            returnByValue: true,
          },
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
    async dispatchMouseEvent(params) {
      await send(
        'Input.dispatchMouseEvent',
        {
          type: params.type,
          x: params.x,
          y: params.y,
          button: params.button ?? 'left',
          buttons: params.buttons ?? (params.type === 'mouseReleased' ? 0 : 1),
          clickCount: params.clickCount ?? 1,
          modifiers: params.modifiers ?? 0,
        },
        sessionId,
      );
    },
    async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
      const res = await send(
        'Page.captureScreenshot',
        {
          format: 'png',
          ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
        },
        sessionId,
      );
      return Buffer.from(res.data, 'base64');
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

function buildMotionAnimations(
  motionDoc: {
    easings?: Record<string, readonly [number, number, number, number]>;
    animations: Record<
      string,
      {
        duration?: number;
        tracks?: Array<{
          bone?: string;
          slot?: string;
          property: string;
          lag?: number;
          keys: Array<{
            t: number;
            v?: unknown;
            derive?: unknown;
            curve?: number[] | 'stepped';
            ease?: string;
          }>;
        }>;
      }
    >;
  },
) {
  const f32 = (n: number) => Math.fround(Number(n));
  const keyTime = (n: number) => f32(Math.round(Number(n) * 360000) / 360000);
  const animations = [];
  for (const [name, anim] of Object.entries(motionDoc.animations || {})) {
    const bonesMap: Record<string, Array<{ name: string; keys: unknown[] }>> = {};
    for (const track of anim.tracks || []) {
      if (!track.bone || track.property === 'inherit') continue;
      if (track.keys.some((k) => k && typeof k === 'object' && 'derive' in k)) continue;
      const keys = track.keys.map((k, idx) => {
        const vArr = Array.isArray(k.v) ? (k.v as number[]) : [0];
        const entry: Record<string, unknown> = { time: keyTime(k.t) };
        if (track.property === 'translate' || track.property === 'scale' || track.property === 'shear') {
          entry.x = f32(vArr[0]!);
          entry.y = f32(vArr[1]!);
        } else {
          entry.value = f32(vArr[0]!);
        }
        const next = track.keys[idx + 1];
        if (next && Array.isArray(next.v)) {
          const nextV = next.v as number[];
          if (k.curve === 'stepped') {
            entry.curve = 'stepped';
          } else if (Array.isArray(k.curve)) {
            entry.curve = k.curve.map(f32);
          } else if (typeof k.ease === 'string' && motionDoc.easings?.[k.ease]) {
            const [hx1, hy1, hx2, hy2] = motionDoc.easings[k.ease]!;
            const dt = next.t - k.t;
            const cArr: number[] = [];
            for (let c = 0; c < vArr.length; c++) {
              const v1 = vArr[c]!,
                dv = nextV[c]! - v1;
              cArr.push(f32(k.t + dt * hx1), f32(v1 + dv * hy1), f32(k.t + dt * hx2), f32(v1 + dv * hy2));
            }
            entry.curve = cArr;
          }
        }
        return entry;
      });
      (bonesMap[track.bone] ??= []).push({ name: track.property, keys });
    }
    const animBones = Object.entries(bonesMap).map(([bName, timelines]) => ({ name: bName, timelines }));
    animations.push({
      name,
      duration: f32(anim.duration || 0),
      bones: animBones,
      slots: [],
      constraints: { ik: [], transform: [], path: [], physics: [], slider: [] },
      attachments: [],
      drawOrder: [],
      events: [],
    });
  }
  return animations;
}

export async function setupBrowserFixture(root: string) {
  const pkgDir = join(root, 'pkg');
  mkdirSync(join(pkgDir, 'out', 'rig'), { recursive: true });
  mkdirSync(join(pkgDir, 'out', 'parts'), { recursive: true });
  mkdirSync(join(pkgDir, 'images'), { recursive: true });

  const baseProbeModel = JSON.parse(
    readFileSync(new URL('./fixtures/strip-probe/build/skeleton.model.json', import.meta.url), 'utf8'),
  );
  const rigidPng = readFileSync(new URL('./fixtures/strip-probe/build/rigid.png', import.meta.url));
  const meshPng = readFileSync(new URL('./fixtures/strip-probe/build/mesh.png', import.meta.url));
  writeFileSync(join(pkgDir, 'rigid.png'), rigidPng);
  writeFileSync(join(pkgDir, 'mesh.png'), meshPng);
  writeFileSync(join(pkgDir, 'images', 'rigid.png'), rigidPng);
  writeFileSync(join(pkgDir, 'images', 'mesh.png'), meshPng);

  const demoAnimObj = JSON.parse(readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8'));
  demoAnimObj.easings = { ...(demoAnimObj.easings || {}), easeOutQuad: [0.25, 0.46, 0.45, 0.94] };
  // Add read-only tracks to 'tilt' for Bar 5 verification, plus 'idle' and the 16-track × 115-key (1,840-key) 'hello' clip for Bar 7
  demoAnimObj.animations.tilt.tracks.push(
    {
      bone: 'head',
      property: 'translate',
      keys: [
        { t: 0, v: [0, 0] },
        { t: 0.8, v: [4, -2] },
        { t: 1.6, v: [0, 0] },
      ],
    },
    {
      bone: 'chest',
      property: 'rotate',
      keys: [
        { t: 0, v: [0] },
        { t: 0.5, v: [3] },
        { t: 1.1, v: [-2] },
        { t: 1.6, v: [0] },
      ],
    },
    { bone: 'head', property: 'inherit', keys: [{ t: 0, v: 'noScale' }] },
    {
      bone: 'brow_r',
      property: 'translatex',
      keys: [
        { t: 0, derive: { kind: 'turn', degrees: -10, depth: 3 } },
        { t: 1.6, derive: { kind: 'turn', degrees: 10, depth: 3 } },
      ],
    },
    {
      bone: 'sleeve_l0',
      property: 'rotate',
      lag: 0.05,
      keys: [
        { t: 0, v: [0] },
        { t: 1.6, v: [8] },
      ],
    },
    {
      slot: 'rigid',
      property: 'attachment',
      keys: [
        { t: 0, v: 'rigid' },
        { t: 0.8, v: 'rigid' },
      ],
    },
    {
      group: 'brows',
      property: 'translatey',
      keys: [
        { t: 0, v: [0] },
        { t: 1.6, v: [2] },
      ],
    },
  );
  demoAnimObj.animations.idle = {
    duration: 2.0,
    loop: true,
    tracks: [
      {
        bone: 'chest',
        property: 'translatey',
        keys: [
          { t: 0, v: [0] },
          { t: 1.0, v: [2] },
          { t: 2.0, v: [0] },
        ],
      },
    ],
  };

  const makeHelloKeys = (dim: 1 | 2) =>
    Array.from({ length: 115 }, (_, k) => ({
      t: Number((k / 24).toFixed(4)),
      v: dim === 1 ? [Number((Math.sin(k * 0.2) * 5).toFixed(4))] : [Number((k * 0.1).toFixed(4)), 0],
    }));
  demoAnimObj.animations.hello = {
    duration: 4.75,
    loop: false,
    tracks: [
      { bone: 'hip', property: 'translate', keys: makeHelloKeys(2) },
      { bone: 'chest', property: 'rotate', keys: makeHelloKeys(1) },
      { bone: 'head', property: 'rotate', keys: makeHelloKeys(1) },
      { group: 'brows', property: 'translatey', keys: makeHelloKeys(1) },
      { group: 'eyes', property: 'scaley', keys: makeHelloKeys(1) },
      { bone: 'brow_r', property: 'rotate', keys: makeHelloKeys(1) },
      { bone: 'brow_l', property: 'rotate', keys: makeHelloKeys(1) },
      { bone: 'mouth', property: 'translatey', keys: makeHelloKeys(1) },
      { bone: 'sleeve_l0', property: 'rotate', keys: makeHelloKeys(1) },
      { bone: 'sleeve_l1', property: 'rotate', keys: makeHelloKeys(1) },
      { bone: 'sleeve_l2', property: 'rotate', keys: makeHelloKeys(1) },
      { bone: 'chest', property: 'translatex', keys: makeHelloKeys(1) },
      { bone: 'chest', property: 'translatey', keys: makeHelloKeys(1) },
      { bone: 'head', property: 'translatex', keys: makeHelloKeys(1) },
      { bone: 'head', property: 'translatey', keys: makeHelloKeys(1) },
      { bone: 'hip', property: 'rotate', keys: makeHelloKeys(1) },
    ],
  };

  const demoAnimText = JSON.stringify(demoAnimObj, null, 2) + '\n';
  writeFileSync(join(pkgDir, 'animations.json'), demoAnimText);

  const config = {
    key: 'demo',
    motion: { animations_from: 'animations.json' },
    meshes: {},
  };
  const configText = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(join(pkgDir, 'config.json'), configText);
  writeFileSync(join(pkgDir, 'out', 'parts.json'), '{}\n');

  const bones = [
    { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'hip', parent: 'root', x: 0, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'chest', parent: 'hip', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'head', parent: 'chest', x: 0, y: 15, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'rigid', parent: 'head', x: -18, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'mesh', parent: 'chest', x: 18, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'brow_r', parent: 'head', x: -5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'brow_l', parent: 'head', x: 5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'eye_r', parent: 'head', x: -4, y: 2, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'eye_l', parent: 'head', x: 4, y: 2, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'mouth', parent: 'head', x: 0, y: -5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l0', parent: 'chest', x: -10, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l1', parent: 'sleeve_l0', x: -10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l2', parent: 'sleeve_l1', x: -10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_r0', parent: 'chest', x: 10, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_r1', parent: 'sleeve_r0', x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'leg_r0', parent: 'hip', x: 6, y: -10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'leg_r1', parent: 'leg_r0', x: 0, y: -12, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'leg_l0', parent: 'hip', x: -6, y: -10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'leg_l1', parent: 'leg_l0', x: 0, y: -12, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'skirt_r0', parent: 'hip', x: 8, y: -4, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'skirt_c0', parent: 'hip', x: 0, y: -4, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'skirt_l0', parent: 'hip', x: -8, y: -4, rotation: 0, scaleX: 1, scaleY: 1 },
  ];

  const baseModelTemplate = {
    ...baseProbeModel,
    bones,
    constraints: [
      {
        kind: 'physics',
        name: 'skirt_phys',
        declaredIn: 'rig',
        bone: 'skirt_c0',
        rotate: 1,
        strength: 100,
        damping: 0.85,
        inertia: 0.5,
        mass: 1,
        wind: 0,
        gravity: 0,
        mix: 1,
      },
    ],
    animations: buildMotionAnimations(demoAnimObj),
    editorOrder: {
      ...baseProbeModel.editorOrder,
      animations: Object.keys(demoAnimObj.animations),
    },
  };

  writeFileSync(
    join(pkgDir, 'out', 'rig', 'rig.json'),
    JSON.stringify({ spec: 'rigc-rig/1', bones, slots: baseProbeModel.slots, skins: { default: {} } }, null, 1) + '\n',
  );
  writeFileSync(join(pkgDir, 'out', 'rig', 'motion.json'), JSON.stringify(demoAnimObj, null, 1) + '\n');
  writeFileSync(
    join(pkgDir, 'out', 'rig', 'mesh_report.json'),
    JSON.stringify({ spec: 'rig-parts-mesh-report/1', parts: {} }, null, 1) + '\n',
  );
  writeFileSync(join(pkgDir, 'skeleton.model.json'), JSON.stringify(baseModelTemplate));
  writeFileSync(join(root, 'template.model.json'), JSON.stringify(baseModelTemplate));

  // Stand-in producer (@rig-c/parts@2.0.0 + rig-c@3.0.0) that compiles motion.json into skeleton.model.json + rigid.png + mesh.png
  mkdirSync(join(root, 'node_modules', '@rig-c', 'parts', 'bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'rig-c', 'bin'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '@rig-c', 'parts', 'package.json'),
    JSON.stringify({ name: '@rig-c/parts', version: '2.0.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }),
  );
  writeFileSync(
    join(root, 'node_modules', 'rig-c', 'package.json'),
    JSON.stringify({ name: 'rig-c', version: '3.0.0', bin: { rigc: './bin/rigc.cjs' } }),
  );

  const standinPartsCjs = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

if (cmd === '--version') {
  console.log('2.0.0');
  process.exit(0);
}
if (cmd === 'rig') {
  const cfgPath = arg('--config');
  const outDir = arg('--out');
  const cfgDir = path.dirname(path.resolve(cfgPath));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const animFromRel = cfg.motion && cfg.motion.animations_from;
  const animFromPath = path.resolve(cfgDir, animFromRel);
  const animDoc = JSON.parse(fs.readFileSync(animFromPath, 'utf8'));
  for (const [animName, anim] of Object.entries(animDoc.animations || {})) {
    const dur = Number(anim.duration || 0);
    for (const track of (anim.tracks || [])) {
      if (!track.bone) continue;
      for (const k of (track.keys || [])) {
        if (typeof k.t === 'number' && k.t > dur + 1e-9) {
          console.log('  FAIL  RIG_RIGC_GREEN: rigc compile error: motion.json: animation "' + animName + '" bone "' + track.bone + '" ' + track.property + ': key at ' + k.t + 's is past the declared duration ' + dur + 's (see rigc guide CE_COMPILE_KEY_AFTER_DURATION)');
          console.log('refused: 1 problem(s)');
          process.exit(1);
        }
      }
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const srcRigDir = ${JSON.stringify(join(pkgDir, 'out', 'rig'))};
  fs.copyFileSync(path.join(srcRigDir, 'rig.json'), path.join(outDir, 'rig.json'));
  fs.copyFileSync(path.join(srcRigDir, 'mesh_report.json'), path.join(outDir, 'mesh_report.json'));
  fs.writeFileSync(path.join(outDir, 'motion.json'), JSON.stringify(animDoc, null, 1) + '\\n');
  console.log('rig-parts rig: wrote ' + outDir);
  process.exit(0);
}
if (cmd === 'check') {
  const outDir = arg('--out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'check.json'), JSON.stringify({
    PASS: true,
    gate_spine_html_green: true,
    MESH_CLEAN: { status: 'PASS' }
  }));
  console.log('check: PASS (1 of 1 bar(s) met)');
  process.exit(0);
}
process.exit(1);
`;

  const standinRigcCjs = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const f32 = (n) => Math.fround(Number(n));
const keyTime = (n) => f32(Math.round(Number(n) * 360000) / 360000);

if (cmd === '--version') {
  console.log('3.0.0');
  process.exit(0);
}
if (cmd === 'build') {
  const motionPath = arg('--motion');
  const out = arg('--out');
  const motion = JSON.parse(fs.readFileSync(motionPath, 'utf8'));
  const easings = motion.easings || {};
  const animations = [];
  for (const [name, anim] of Object.entries(motion.animations || {})) {
    const dur = Number(anim.duration || 0);
    const bonesMap = {};
    for (const track of (anim.tracks || [])) {
      for (const k of (track.keys || [])) {
        if (k.t > dur + 1e-9) {
          console.error('CE_COMPILE_KEY_AFTER_DURATION: animation "' + name + '" key at t=' + k.t + 's exceeds duration ' + dur + 's');
          process.exit(1);
        }
      }
      if (!track.bone || track.property === 'inherit') continue;
      if ((track.keys || []).some((k) => k && typeof k === 'object' && 'derive' in k)) continue;
      const keys = track.keys.map((k, idx) => {
        const entry = { time: keyTime(k.t) };
        if (track.property === 'translate' || track.property === 'scale' || track.property === 'shear') {
          entry.x = f32(k.v[0]);
          entry.y = f32(k.v[1]);
        } else {
          entry.value = f32(k.v[0]);
        }
        const next = track.keys[idx + 1];
        if (next && Array.isArray(next.v)) {
          if (k.curve === 'stepped') {
            entry.curve = 'stepped';
          } else if (Array.isArray(k.curve)) {
            entry.curve = k.curve.map(f32);
          } else if (typeof k.ease === 'string' && Array.isArray(easings[k.ease])) {
            const [hx1, hy1, hx2, hy2] = easings[k.ease];
            const dt = next.t - k.t;
            const cArr = [];
            for (let c = 0; c < k.v.length; c++) {
              const v1 = k.v[c], dv = next.v[c] - v1;
              cArr.push(f32(k.t + dt * hx1), f32(v1 + dv * hy1), f32(k.t + dt * hx2), f32(v1 + dv * hy2));
            }
            entry.curve = cArr;
          }
        }
        return entry;
      });
      if (!bonesMap[track.bone]) bonesMap[track.bone] = [];
      bonesMap[track.bone].push({ name: track.property, keys });
    }
    const animBones = Object.entries(bonesMap).map(([bName, timelines]) => ({ name: bName, timelines }));
    animations.push({
      name,
      duration: f32(dur),
      bones: animBones,
      slots: [],
      constraints: { ik: [], transform: [], path: [], physics: [], slider: [] },
      attachments: [],
      drawOrder: [],
      events: [],
    });
  }
  const pkgRoot = ${JSON.stringify(pkgDir)};
  const tpl = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'template.model.json'))}, 'utf8'));
  tpl.animations = animations;
  tpl.editorOrder.animations = animations.map((a) => a.name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'skeleton.model.json'), JSON.stringify(tpl));
  fs.copyFileSync(path.join(pkgRoot, 'rigid.png'), path.join(out, 'rigid.png'));
  fs.copyFileSync(path.join(pkgRoot, 'mesh.png'), path.join(out, 'mesh.png'));
  console.log('rigc: wrote ' + path.join(out, 'skeleton.model.json'));
  process.exit(0);
}
process.exit(1);
`;

  writeFileSync(join(root, 'node_modules', '@rig-c', 'parts', 'bin', 'rig-parts.cjs'), standinPartsCjs, {
    mode: 0o755,
  });
  writeFileSync(join(root, 'node_modules', 'rig-c', 'bin', 'rigc.cjs'), standinRigcCjs, { mode: 0o755 });

  return { pkgDir, demoAnimText };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'review-anim-browser-'));
  const profileDir = join(root, 'chrome-profile');
  await mkdir(profileDir, { recursive: true });
  const screenshotDir = process.env.SCREENSHOT_DIR || null;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

  const { pkgDir } = await setupBrowserFixture(root);
  const pkg = await loadReview(pkgDir);
  const server = await startServer(pkg, { port: 0, stateDir: join(root, 'state'), cwd: root });
  const session = await launchCdpSession(profileDir);

  try {
    // Slice 3b Bar 2: Exact 1440x900 viewport
    await session.setViewport(1440, 900);
    await session.goto(`http://127.0.0.1:${server.port}`);

    // Wait for player and rebuild status (animations_from source) to load, and switch to Animate (playback) inspector
    const initDiag = await session.evaluate<{
      playerState: string;
      message: string;
      animOptions: string[];
      sourceAvailable: boolean;
    }>(`(async () => {
      for (let i = 0; i < 400; i++) {
        const ed = window.rigReviewEditor;
        const pState = document.getElementById('player-state')?.textContent ?? '';
        if (pState === 'Rig load failed') break;
        const rigReady = document.querySelector('#rig-root canvas, #rig-root img');
        const animSelect = document.getElementById('animation-select');
        if (ed && rigReady && animSelect?.options?.length > 0 && ed.animation.source()?.available) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const playbackTab = document.querySelector('[data-inspector="playback"]');
      if (playbackTab) playbackTab.click();
      const animSelect = document.getElementById('animation-select');
      if (animSelect && animSelect.value !== 'tilt') {
        animSelect.value = 'tilt';
        animSelect.dispatchEvent(new Event('change'));
      }
      await new Promise((r) => setTimeout(r, 60));
      return {
        playerState: document.getElementById('player-state')?.textContent ?? '',
        rigEmpty: document.getElementById('rig-empty')?.textContent ?? '',
        message: document.getElementById('message')?.textContent ?? '',
        animOptions: animSelect ? [...animSelect.options].map((o) => o.value) : [],
        sourceAvailable: !!window.rigReviewEditor?.animation?.source()?.available,
      };
    })()`);
    if (initDiag.playerState === 'Rig load failed' || !initDiag.animOptions.includes('tilt')) {
      throw new Error(`Player initialization failed: ${JSON.stringify(initDiag)}`);
    }

    // Slice 3b Bar 1, Bar 2, Bar 7: Verify at 1440x900 with zero page/inspector scroll:
    // - stage is visible above the dock
    // - Play, scrub, time ruler with ticks, playhead, track names column, key lanes, key inspector fields, pending/Apply bar are ALL in viewport without scrolling
    // - time labels have zero Float32 noise
    const slice3bDockCheck = await session.evaluate<{
      viewportWidth: number;
      viewportHeight: number;
      windowScrollY: number;
      docScrollTop: number;
      inspectorScrollTop: number;
      stageRect: { top: number; bottom: number; height: number };
      dockRect: { top: number; bottom: number; height: number };
      visibleLanesAtDefaultHeight: number;
      totalLanesOnTilt: number;
      allInViewport: boolean;
      rects: Record<string, { left: number; top: number; right: number; bottom: number; width: number; height: number } | null>;
      axisText: string;
      rulerTicks: string[];
      keyTitles: string[];
      hasFloat32Noise: boolean;
    }>(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left * 100) / 100,
          top: Math.round(r.top * 100) / 100,
          right: Math.round(r.right * 100) / 100,
          bottom: Math.round(r.bottom * 100) / 100,
          width: Math.round(r.width * 100) / 100,
          height: Math.round(r.height * 100) / 100,
        };
      };
      const selectors = {
        stage: '#stage-layout',
        dock: '.inspector',
        play: '#play',
        scrub: '#scrub',
        ruler: '[data-animation-ruler]',
        rulerTick: '[data-ruler-tick]',
        playhead: '.animation-key-lane [data-playhead]',
        trackHead: '[data-lane-head]',
        keyLane: '.animation-key-lane',
        keyMark: '.animation-key[data-source-track="0"][data-key-index="1"]',
        keyInspector: '[data-key-inspector]',
        keyTimeInput: '[data-key-time-input]',
        keyChannelInput: '[data-key-channel="0"]',
        pendingSummary: '[data-animation-ops-summary]',
        applyButton: '[data-animation-apply]',
      };
      const rects = {};
      let allInViewport = true;
      for (const [k, sel] of Object.entries(selectors)) {
        const r = box(sel);
        rects[k] = r;
        if (!r || r.width <= 0 || r.height <= 0 || r.left < 0 || r.top < 0 || r.right > 1440 || r.bottom > 900) {
          allInViewport = false;
        }
      }
      const lanesBox = document.querySelector('.animation-lanes').getBoundingClientRect();
      const rulerBox = document.querySelector('[data-animation-ruler]').getBoundingClientRect();
      const allLaneEls = [...document.querySelectorAll('.animation-lanes .animation-lane, .animation-lanes .animation-readonly-lane')];
      const visibleLanesAtDefaultHeight = allLaneEls.filter((el) => {
        const lr = el.getBoundingClientRect();
        return lr.height > 0 && lr.top >= rulerBox.bottom - 1.5 && lr.bottom <= lanesBox.bottom + 1.5;
      }).length;
      const inspPanel = document.querySelector('[data-inspector-panel="playback"]');
      const axisText = document.querySelector('.animation-axis')?.textContent ?? '';
      const rulerTicks = [...document.querySelectorAll('[data-ruler-tick]')].map((n) => n.textContent ?? '');
      const keyTitles = [...document.querySelectorAll('.animation-key')].map((n) => n.getAttribute('title') ?? '');
      const hasFloat32Noise = [axisText, ...rulerTicks, ...keyTitles].some((s) => /\\d\\.\\d{5,}/.test(s));
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        windowScrollY: window.scrollY,
        docScrollTop: document.documentElement.scrollTop,
        inspectorScrollTop: inspPanel?.scrollTop ?? -1,
        stageRect: rects.stage,
        dockRect: rects.dock,
        visibleLanesAtDefaultHeight,
        totalLanesOnTilt: allLaneEls.length,
        allInViewport,
        rects,
        axisText,
        rulerTicks,
        keyTitles,
        hasFloat32Noise,
      };
    })()`);

    if (
      slice3bDockCheck.viewportWidth !== 1440 ||
      slice3bDockCheck.viewportHeight !== 900 ||
      slice3bDockCheck.windowScrollY !== 0 ||
      slice3bDockCheck.docScrollTop !== 0 ||
      slice3bDockCheck.inspectorScrollTop !== 0 ||
      !slice3bDockCheck.allInViewport ||
      slice3bDockCheck.stageRect.height < slice3bDockCheck.dockRect.height ||
      slice3bDockCheck.visibleLanesAtDefaultHeight < 6 ||
      slice3bDockCheck.stageRect.bottom > slice3bDockCheck.dockRect.top ||
      slice3bDockCheck.hasFloat32Noise
    ) {
      throw new Error(`Slice 3b/3c 1440x900 dock verification failed: ${JSON.stringify(slice3bDockCheck, null, 2)}`);
    }

    // Slice 3c Bar 1 & Bar 2:
    // - Timeline is its own panel (#animation-dock), not a child of any inspector block tab (#animate-blocks).
    // - Switching across all 9 tabs ('Transport', 'Sound', 'Environment', 'Physics', 'Idle tracks', 'Readings', 'Requirements', 'Retarget', 'Report')
    //   leaves play, scrub, ruler, lanes, and Apply in the exact same bounding rect (0 px change) while scrolling #animate-blocks to each block.
    const slice3cTabsResult = await session.evaluate<{
      timelineIsOwnPanel: boolean;
      timelineInsideAnimateBlocks: boolean;
      baselineRects: Record<string, { left: number; top: number; width: number; height: number }>;
      tabsMeasured: Array<{
        label: string;
        targetId: string;
        ariaCurrent: string | null;
        targetVisibleInBlocksPanel: boolean;
        animateBlocksScrollTop: number;
        maxDeltaPx: number;
        deltas: Record<string, number>;
      }>;
      maxDeltaAcrossAllTabsPx: number;
    }>(`(async () => {
      const dockPanel = document.getElementById('animation-dock');
      const blocksPanel = document.getElementById('animate-blocks');
      const animInsp = document.getElementById('animation-inspection');
      const timelineIsOwnPanel =
        !!dockPanel &&
        !!blocksPanel &&
        dockPanel.parentElement?.id === 'inspector-playback' &&
        blocksPanel.parentElement?.id === 'inspector-playback' &&
        dockPanel.contains(animInsp);
      const timelineInsideAnimateBlocks = !!blocksPanel && blocksPanel.contains(animInsp);

      const tracked = {
        play: '#play',
        scrub: '#scrub',
        ruler: '[data-animation-ruler]',
        lanes: '.animation-lanes',
        apply: '[data-animation-apply]',
      };
      const measureTracked = () => {
        const out = {};
        for (const [k, sel] of Object.entries(tracked)) {
          const r = document.querySelector(sel).getBoundingClientRect();
          out[k] = {
            left: Math.round(r.left * 100) / 100,
            top: Math.round(r.top * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
          };
        }
        return out;
      };
      const baselineRects = measureTracked();
      const buttons = [...blocksPanel.querySelectorAll('.block-row button[data-block-target]')];
      const tabsMeasured = [];
      let maxDeltaAcrossAllTabsPx = 0;

      for (const btn of buttons) {
        btn.click();
        // Wait for smooth/auto scroll on blocksPanel to settle
        const targetId = btn.getAttribute('data-block-target') || '';
        const targetEl = document.getElementById(targetId);
        const rowRect = blocksPanel.querySelector('.block-row').getBoundingClientRect();
        const panelRect = blocksPanel.getBoundingClientRect();
        if (targetEl) {
          const desiredOffset = targetEl.getBoundingClientRect().top - panelRect.top - rowRect.height - 6;
          blocksPanel.scrollTo({ top: Math.max(0, blocksPanel.scrollTop + desiredOffset), behavior: 'auto' });
        }
        await new Promise((r) => setTimeout(r, 30));
        const nowRects = measureTracked();
        const deltas = {};
        let tabMax = 0;
        for (const k of Object.keys(tracked)) {
          const b = baselineRects[k];
          const n = nowRects[k];
          const d = Math.max(
            Math.abs(n.left - b.left),
            Math.abs(n.top - b.top),
            Math.abs(n.width - b.width),
            Math.abs(n.height - b.height),
          );
          deltas[k] = Math.round(d * 100) / 100;
          if (d > tabMax) tabMax = d;
        }
        if (tabMax > maxDeltaAcrossAllTabsPx) maxDeltaAcrossAllTabsPx = tabMax;
        const tr = targetEl.getBoundingClientRect();
        const pr = blocksPanel.getBoundingClientRect();
        tabsMeasured.push({
          label: btn.textContent?.trim() || '',
          targetId,
          ariaCurrent: btn.getAttribute('aria-current'),
          targetVisibleInBlocksPanel: tr.bottom > pr.top && tr.top < pr.bottom,
          animateBlocksScrollTop: Math.round(blocksPanel.scrollTop),
          maxDeltaPx: Math.round(tabMax * 100) / 100,
          deltas,
        });
      }

      // Leave Physics tab selected briefly so we can capture a screenshot showing Physics next to Timeline
      const physicsBtn = buttons.find((b) => b.getAttribute('data-block-target') === 'physics-panel');
      if (physicsBtn) {
        physicsBtn.click();
        const targetEl = document.getElementById('physics-panel');
        const rowRect = blocksPanel.querySelector('.block-row').getBoundingClientRect();
        const panelRect = blocksPanel.getBoundingClientRect();
        const desiredOffset = targetEl.getBoundingClientRect().top - panelRect.top - rowRect.height - 6;
        blocksPanel.scrollTo({ top: Math.max(0, blocksPanel.scrollTop + desiredOffset), behavior: 'auto' });
        await new Promise((r) => setTimeout(r, 30));
      }

      return {
        timelineIsOwnPanel,
        timelineInsideAnimateBlocks,
        baselineRects,
        tabsMeasured,
        maxDeltaAcrossAllTabsPx: Math.round(maxDeltaAcrossAllTabsPx * 100) / 100,
      };
    })()`);

    if (
      !slice3cTabsResult.timelineIsOwnPanel ||
      slice3cTabsResult.timelineInsideAnimateBlocks ||
      slice3cTabsResult.tabsMeasured.length !== 9 ||
      slice3cTabsResult.maxDeltaAcrossAllTabsPx !== 0 ||
      slice3cTabsResult.tabsMeasured.some((t) => t.ariaCurrent !== 'true' || !t.targetVisibleInBlocksPanel)
    ) {
      throw new Error(`Slice 3c Bar 1/2 tab switch verification failed: ${JSON.stringify(slice3cTabsResult, null, 2)}`);
    }

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3c-dock-physics-tab-1440x900.png'), await session.screenshot());
    }

    // Bar 6: Verify Apply isolation note (Ruling H2)
    const bar6Note = await session.evaluate<{ text: string; matchesConstant: boolean }>(`(() => {
      const el = document.querySelector('[data-animation-apply-note]');
      const text = el?.textContent ?? '';
      return {
        text,
        matchesConstant: text === ${JSON.stringify(ANIMATION_APPLY_ISOLATION_NOTE)},
      };
    })()`);
    if (!bar6Note.matchesConstant) {
      throw new Error(`Bar 6 failed: expected "${ANIMATION_APPLY_ISOLATION_NOTE}", got "${bar6Note.text}"`);
    }

    // Bar 5: Verify read-only tracks on 'tilt' and 'idle' gate
    const bar5Result = await session.evaluate<{
      tiltGate: any;
      tiltEditableTracks: number;
      tiltReadOnlyBadges: string[];
      readOnlySelectRefused: boolean;
      readOnlyStatusText: string;
      idleGate: any;
      idleEditableLanes: number;
      idleReadOnlyBadges: string[];
    }>(`(async () => {
      const ed = window.rigReviewEditor.animation;
      const tiltGate = ed.gate();
      const tiltEditableTracks = document.querySelectorAll('.animation-lane[data-editable="true"]').length;
      const tiltReadOnlyBadges = [...document.querySelectorAll('[data-readonly-badge]')].map((n) => n.textContent ?? '');
      // Attempt to select a key on read-only track 3 (head.inherit)
      const readOnlySelectOk = ed.selectKey(3, 0);
      const readOnlyStatusText = ed.status();

      // Switch to 'idle' clip and verify ANIMATION_IDLE_GOVERNED_BY_TURN_PAD gate
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'idle';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));
      const idleGate = ed.gate();
      const idleEditableLanes = document.querySelectorAll('.animation-lane[data-editable="true"]').length;
      const idleReadOnlyBadges = [...document.querySelectorAll('[data-readonly-badge]')].map((n) => n.textContent ?? '');
      const idleBadgesInsideKeyLane = document.querySelectorAll('.animation-key-lane [data-readonly-badge]').length;
      const gateEl = document.querySelector('[data-animation-gate]');
      const emptyEl = document.querySelector('[data-key-inspector-empty]');
      const readable = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.textOverflow !== 'ellipsis' && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 2;
      };
      const idleRefusalReadable = readable(gateEl) && readable(emptyEl) && idleBadgesInsideKeyLane === 0;

      return {
        tiltGate,
        tiltEditableTracks,
        tiltReadOnlyBadges,
        readOnlySelectRefused: readOnlySelectOk === false,
        readOnlyStatusText,
        idleGate,
        idleEditableLanes,
        idleReadOnlyBadges,
        idleRefusalReadable,
      };
    })()`);

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3c-dock-idle-1440x900.png'), await session.screenshot());
    }

    await session.evaluate(`(async () => {
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));
    })()`);

    if (!bar5Result.tiltGate.editable || bar5Result.tiltEditableTracks !== 3 || !(bar5Result as any).idleRefusalReadable) {
      throw new Error(`Bar 5 failed on tilt: ${JSON.stringify(bar5Result)}`);
    }
    if (
      !bar5Result.readOnlySelectRefused ||
      !bar5Result.readOnlyStatusText.startsWith('ANIMATION_TRACK_READ_ONLY:') ||
      bar5Result.idleGate.code !== 'ANIMATION_IDLE_GOVERNED_BY_TURN_PAD' ||
      bar5Result.idleEditableLanes !== 0
    ) {
      throw new Error(`Bar 5 failed on read-only / idle checks: ${JSON.stringify(bar5Result)}`);
    }

    // Slice 3b Bar 5 & Bar 6 + Slice 3 Bar 1 & Bar 2:
    // - Confirm selectedKey is currently null (unselected!).
    // - Record bounding rects of stage, dock, key inspector, lanes, ruler, and EVERY .animation-key BEFORE gesture.
    // - Perform a SINGLE-GESTURE press-and-drag on unselected key 1 of track 0 without any scrollIntoView or pre-click.
    // - Measure bounding rects AFTER drag and AFTER inspector value edit: prove 0.00px layout jitter!
    const preDragSnapshot = await session.evaluate<{
      selectedKeyBefore: any;
      inspectorScrollTop: number;
      x: number;
      y: number;
      laneLeft: number;
      laneWidth: number;
      stageRect: any;
      lanesRect: any;
      keyInspectorRect: any;
      keyRects: Array<{ id: string; left: number; top: number; width: number; height: number }>;
    }>(`(() => {
      const ed = window.rigReviewEditor.animation;
      const inspPanel = document.querySelector('[data-inspector-panel="playback"]');
      const mark = document.querySelector('.animation-key[data-source-track="0"][data-key-index="1"]');
      const r = mark.getBoundingClientRect();
      const lane = mark.parentElement.getBoundingClientRect();
      const rectOf = (el) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, width: b.width, height: b.height };
      };
      const keyRects = [...document.querySelectorAll('.animation-key')].map((k) => ({
        id: (k.dataset.sourceTrack ?? k.dataset.track) + ':' + k.dataset.keyIndex,
        ...rectOf(k),
      }));
      return {
        selectedKeyBefore: ed.selectedKey(),
        inspectorScrollTop: inspPanel?.scrollTop ?? -1,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        laneLeft: lane.left,
        laneWidth: lane.width,
        stageRect: rectOf(document.getElementById('stage-layout')),
        lanesRect: rectOf(document.querySelector('.animation-lanes')),
        keyInspectorRect: rectOf(document.querySelector('[data-key-inspector]')),
        keyRects,
      };
    })()`);

    if (preDragSnapshot.selectedKeyBefore !== null || preDragSnapshot.inspectorScrollTop !== 0) {
      throw new Error(`Expected unselected state with scrollTop=0 before single-gesture drag: ${JSON.stringify(preDragSnapshot)}`);
    }

    // Single-gesture press-and-drag on UNSELECTED key 1 from t=0.35s to ~t=0.45s across two pointermove steps
    const targetX1 = preDragSnapshot.laneLeft + (0.42 / 1.6) * preDragSnapshot.laneWidth;
    const targetX2 = preDragSnapshot.laneLeft + (0.45 / 1.6) * preDragSnapshot.laneWidth;
    await session.dispatchMouseEvent({ type: 'mousePressed', x: preDragSnapshot.x, y: preDragSnapshot.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: targetX1, y: preDragSnapshot.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: targetX2, y: preDragSnapshot.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: targetX2, y: preDragSnapshot.y, button: 'left', buttons: 0 });

    const bar1And2Result = await session.evaluate<{
      afterDragOps: any[];
      selectedAfterDrag: any;
      jitterAfterDrag: {
        stageDeltaPx: number;
        lanesDeltaPx: number;
        keyInspectorDeltaPx: number;
        maxUneditedKeyDeltaPx: number;
        draggedKeyVerticalDeltaPx: number;
        inspectorScrollTop: number;
      };
      afterExactTimeOps: any[];
      afterInspectorValOps: any[];
      jitterAfterValueEdit: {
        stageDeltaPx: number;
        lanesDeltaPx: number;
        keyInspectorDeltaPx: number;
        maxUneditedKeyDeltaPx: number;
      };
      afterInsertOps: any[];
      afterDeleteOps: any[];
      previewBadgeVisible: boolean;
      previewBadgeText: string;
    }>(`(async () => {
      const pre = ${JSON.stringify(preDragSnapshot)};
      const ed = window.rigReviewEditor.animation;
      const afterDragOps = ed.ops();
      const selectedAfterDrag = ed.selectedKey();
      const rectOf = (el) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, width: b.width, height: b.height };
      };
      const boxDiff = (a, b) =>
        Math.max(
          Math.abs(a.left - b.left),
          Math.abs(a.top - b.top),
          Math.abs(a.width - b.width),
          Math.abs(a.height - b.height),
        );
      const measureJitter = () => {
        const stageDeltaPx = boxDiff(pre.stageRect, rectOf(document.getElementById('stage-layout')));
        const lanesDeltaPx = boxDiff(pre.lanesRect, rectOf(document.querySelector('.animation-lanes')));
        const keyInspectorDeltaPx = boxDiff(pre.keyInspectorRect, rectOf(document.querySelector('[data-key-inspector]')));
        let maxUneditedKeyDeltaPx = 0;
        let draggedKeyVerticalDeltaPx = 0;
        const currentKeys = [...document.querySelectorAll('.animation-key')];
        for (let i = 0; i < pre.keyRects.length; i++) {
          const pk = pre.keyRects[i];
          const ck = rectOf(currentKeys[i]);
          if (pk.id === '0:1') {
            draggedKeyVerticalDeltaPx = Math.max(Math.abs(pk.top - ck.top), Math.abs(pk.height - ck.height));
          } else {
            const d = boxDiff(pk, ck);
            if (d > maxUneditedKeyDeltaPx) maxUneditedKeyDeltaPx = d;
          }
        }
        const inspPanel = document.querySelector('[data-inspector-panel="playback"]');
        return {
          stageDeltaPx: Math.round(stageDeltaPx * 1000) / 1000,
          lanesDeltaPx: Math.round(lanesDeltaPx * 1000) / 1000,
          keyInspectorDeltaPx: Math.round(keyInspectorDeltaPx * 1000) / 1000,
          maxUneditedKeyDeltaPx: Math.round(maxUneditedKeyDeltaPx * 1000) / 1000,
          draggedKeyVerticalDeltaPx: Math.round(draggedKeyVerticalDeltaPx * 1000) / 1000,
          inspectorScrollTop: inspPanel?.scrollTop ?? -1,
        };
      };

      const jitterAfterDrag = measureJitter();

      // Set exact key time via inspector [data-key-time-input] to 0.42s (coalesces with the drag set_key_time!)
      const timeInput = document.querySelector('[data-key-time-input]');
      timeInput.value = '0.42';
      timeInput.dispatchEvent(new Event('change'));
      const afterExactTimeOps = ed.ops();

      // Bar 2: Edit channel 0 value via inspector [data-key-channel="0"] to 14.5 deg
      const chInput = document.querySelector('[data-key-channel="0"]');
      chInput.value = '14.5';
      chInput.dispatchEvent(new Event('change'));
      const afterInspectorValOps = ed.ops();
      const jitterAfterValueEdit = measureJitter();

      // Bar 1: Add a key on track 1 (head.translate) at t=0.65s via [+ Add key] in inspector
      const trackSel = document.querySelector('[data-insert-track]');
      const timeIn = document.querySelector('[data-insert-time]');
      const addBtn = document.querySelector('[data-insert-key]');
      trackSel.value = '1';
      timeIn.value = '0.65';
      addBtn.click();
      const afterInsertOps = ed.ops();

      // Bar 1: Delete key #2 on track 2 (chest.rotate) by selecting it and clicking [Delete key]
      ed.selectKey(2, 2);
      const delBtn = document.querySelector('[data-delete-key]');
      delBtn.click();
      // Re-select track 0 key 1 so the screenshot shows its active fields in the key bar
      ed.selectKey(0, 1);
      const afterDeleteOps = ed.ops();

      const badge = document.querySelector('[data-animation-preview-badge]');
      return {
        afterDragOps,
        selectedAfterDrag,
        jitterAfterDrag,
        afterExactTimeOps,
        afterInspectorValOps,
        jitterAfterValueEdit,
        afterInsertOps,
        afterDeleteOps,
        previewBadgeVisible: badge ? !badge.hidden : false,
        previewBadgeText: badge?.textContent ?? '',
      };
    })()`);

    if (
      bar1And2Result.afterDragOps.length !== 1 ||
      bar1And2Result.afterDragOps[0].op !== 'set_key_time' ||
      bar1And2Result.selectedAfterDrag?.trackIndex !== 0 ||
      bar1And2Result.selectedAfterDrag?.keyIndex !== 1 ||
      bar1And2Result.jitterAfterDrag.stageDeltaPx !== 0 ||
      bar1And2Result.jitterAfterDrag.lanesDeltaPx !== 0 ||
      bar1And2Result.jitterAfterDrag.keyInspectorDeltaPx !== 0 ||
      bar1And2Result.jitterAfterDrag.maxUneditedKeyDeltaPx !== 0 ||
      bar1And2Result.jitterAfterDrag.draggedKeyVerticalDeltaPx !== 0 ||
      bar1And2Result.jitterAfterDrag.inspectorScrollTop !== 0 ||
      bar1And2Result.jitterAfterValueEdit.stageDeltaPx !== 0 ||
      bar1And2Result.jitterAfterValueEdit.lanesDeltaPx !== 0 ||
      bar1And2Result.jitterAfterValueEdit.keyInspectorDeltaPx !== 0 ||
      bar1And2Result.jitterAfterValueEdit.maxUneditedKeyDeltaPx !== 0 ||
      bar1And2Result.afterExactTimeOps.length !== 1 ||
      bar1And2Result.afterExactTimeOps[0].time !== 0.42 ||
      bar1And2Result.afterInspectorValOps.length !== 2 ||
      bar1And2Result.afterInspectorValOps[1].op !== 'set_key_value' ||
      bar1And2Result.afterInspectorValOps[1].value !== 14.5 ||
      bar1And2Result.afterInsertOps.length !== 3 ||
      bar1And2Result.afterInsertOps[2].op !== 'insert_key' ||
      bar1And2Result.afterDeleteOps.length !== 4 ||
      bar1And2Result.afterDeleteOps[3].op !== 'delete_key' ||
      !bar1And2Result.previewBadgeVisible
    ) {
      throw new Error(`Bar 1 / Bar 2 / Slice 3b Bar 5 & 6 verification failed: ${JSON.stringify(bar1And2Result, null, 2)}`);
    }

    if (screenshotDir) {
      const demoPng = await session.screenshot();
      await writeFile(join(screenshotDir, 'slice3-dopesheet-preview.png'), demoPng);
      await writeFile(join(screenshotDir, 'slice3b-dock-demo-1440x900.png'), demoPng);
    }

    // Bar 3: Measure pending preview stage pose BEFORE Apply vs compiled build pose AFTER Apply across sample times
    const bar3And4Result = await session.evaluate<{
      sampleTimes: number[];
      comparedBoneFields: number;
      comparedSlotVertices: number;
      maxFroundDiff: number;
      firstApplyOpsCount: number;
      firstApplySchema: string;
      hasPreviewAfterFirstApply: boolean;
      secondApplyOps: any[];
      secondApplySchema: string;
      hasPreviewAfterSecondApply: boolean;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const sampleTimes = [0, 0.2, 0.42, 0.65, 0.8, 1.1, 1.4, 1.6];
      const boneNames = ['root', 'hip', 'chest', 'head', 'rigid', 'mesh'];
      const scrub = document.getElementById('scrub');
      const seekTo = (t) => {
        scrub.value = String(t);
        scrub.dispatchEvent(new Event('input'));
      };

      // Capture pending preview poses before Apply
      const previewSnapshots = [];
      for (const t of sampleTimes) {
        seekTo(t);
        const bones = {};
        for (const b of boneNames) bones[b] = ed.bone(b);
        previewSnapshots.push({
          t,
          bones,
          rigidSlot: ed.posed('rigid'),
          meshSlot: ed.posed('mesh'),
        });
      }

      // Click Apply · Rebuild for the 4 pending ops on 'tilt'
      const applyBtn = document.querySelector('[data-animation-apply]');
      applyBtn.click();
      for (let i = 0; i < 400; i++) {
        if (!ed.stage().busy && ed.stage().applied?.schema === 'rig-review-applied/5') break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const hasPreviewAfterFirstApply = ed.animation.hasPreview();
      const firstApplied = ed.stage().applied;

      // Capture compiled build poses after Apply at the exact same sample times
      let maxFroundDiff = 0;
      let comparedBoneFields = 0;
      let comparedSlotVertices = 0;

      for (let idx = 0; idx < sampleTimes.length; idx++) {
        const t = sampleTimes[idx];
        seekTo(t);
        const prev = previewSnapshots[idx];
        for (const b of boneNames) {
          const pb = prev.bones[b];
          const cb = ed.bone(b);
          for (const f of ['x', 'y', 'rotationX', 'rotationY', 'scaleX', 'scaleY', 'a', 'b', 'c', 'd']) {
            if (typeof pb?.[f] === 'number' && typeof cb?.[f] === 'number') {
              const diff = Math.abs(Math.fround(pb[f]) - Math.fround(cb[f]));
              if (diff > maxFroundDiff) maxFroundDiff = diff;
              comparedBoneFields++;
            }
          }
        }
        const pRigid = prev.rigidSlot?.corners ?? [];
        const cRigid = ed.posed('rigid')?.corners ?? [];
        for (let k = 0; k < pRigid.length; k++) {
          const diff = Math.abs(Math.fround(pRigid[k]) - Math.fround(cRigid[k]));
          if (diff > maxFroundDiff) maxFroundDiff = diff;
          comparedSlotVertices++;
        }
        const pMesh = prev.meshSlot?.vertices ?? [];
        const cMesh = ed.posed('mesh')?.vertices ?? [];
        for (let k = 0; k < pMesh.length; k++) {
          const diff = Math.abs(Math.fround(pMesh[k]) - Math.fround(cMesh[k]));
          if (diff > maxFroundDiff) maxFroundDiff = diff;
          comparedSlotVertices++;
        }
      }

      // Bar 4: Make a second edit on 'hop' track 2 (hip.scale) and press Apply · Rebuild a second time
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'hop';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      ed.animation.selectKey(2, 1);
      const ch0 = document.querySelector('[data-key-channel="0"]');
      const ch1 = document.querySelector('[data-key-channel="1"]');
      ch0.value = '1.08';
      ch0.dispatchEvent(new Event('change'));
      ch1.value = '0.94';
      ch1.dispatchEvent(new Event('change'));

      applyBtn.click();
      const firstBuildId = firstApplied.buildId;
      for (let i = 0; i < 400; i++) {
        const st = ed.stage();
        if (!st.busy && st.applied?.buildId && st.applied.buildId !== firstBuildId) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const secondApplied = ed.stage().applied;
      const hasPreviewAfterSecondApply = ed.animation.hasPreview();

      return {
        sampleTimes,
        comparedBoneFields,
        comparedSlotVertices,
        maxFroundDiff,
        firstApplyOpsCount: firstApplied?.ops?.length ?? 0,
        firstApplySchema: firstApplied?.schema ?? '',
        hasPreviewAfterFirstApply,
        secondApplyOps: secondApplied?.ops ?? [],
        secondApplySchema: secondApplied?.schema ?? '',
        hasPreviewAfterSecondApply,
      };
    })()`);

    if (
      bar3And4Result.maxFroundDiff !== 0 ||
      bar3And4Result.comparedBoneFields === 0 ||
      bar3And4Result.hasPreviewAfterFirstApply !== false ||
      bar3And4Result.firstApplyOpsCount !== 4 ||
      bar3And4Result.secondApplyOps.length !== 5 ||
      bar3And4Result.hasPreviewAfterSecondApply !== false
    ) {
      throw new Error(`Bar 3 / Bar 4 verification failed: ${JSON.stringify(bar3And4Result, null, 2)}`);
    }

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3-applied-cumulative.png'), await session.screenshot());
    }

    // Bar 8 + Slice 3c Bar 4: Producer/compiler refusal verbatim (t > duration -> CE_COMPILE_KEY_AFTER_DURATION),
    // readable in full without hovering, and 0 px shift of stage and lanes!
    const bar8Result = await session.evaluate<{
      durationUnchangedAfterEdit: boolean;
      clipDuration: number;
      statusAfterRefusedApply: string;
      stageBuildPreserved: boolean;
      refusalReadableInFull: boolean;
      refusalLines: number;
      stageShiftPx: number;
      lanesShiftPx: number;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      const rectOf = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      const deltaOf = (a, b) =>
        Math.round(
          Math.max(
            Math.abs(a.left - b.left),
            Math.abs(a.top - b.top),
            Math.abs(a.width - b.width),
            Math.abs(a.height - b.height),
          ) * 100,
        ) / 100;

      const stageBefore = rectOf('#stage-layout');
      const lanesBefore = rectOf('.animation-lanes');
      const buildBefore = ed.stage().modelHash;
      // Move last key (index 4) on track 0 past duration 1.6s -> 2.5s
      ed.animation.setKeyTime(0, 4, 2.5);
      // Duration of tilt must remain 1.6s (no auto-duration!)
      const scrubMax = Number(document.getElementById('scrub').max);
      await ed.animation.apply();
      const statusAfterRefusedApply = ed.animation.status();
      const buildAfter = ed.stage().modelHash;
      const stageDuring = rectOf('#stage-layout');
      const lanesDuring = rectOf('.animation-lanes');
      const statusEl = document.querySelector('[data-animation-editor-status]');
      const dockStatusEl = document.querySelector('.animation-dock-status');
      const cs = getComputedStyle(statusEl);
      const refusalReadableInFull =
        !!statusEl &&
        cs.textOverflow !== 'ellipsis' &&
        statusEl.scrollWidth <= statusEl.clientWidth + 1 &&
        statusEl.scrollHeight <= statusEl.clientHeight + 2 &&
        dockStatusEl.scrollHeight <= dockStatusEl.clientHeight + 2;
      const refusalLines = Math.round(statusEl.getBoundingClientRect().height / 11);

      return {
        durationUnchangedAfterEdit: Math.abs(scrubMax - 1.6) < 1e-6,
        clipDuration: scrubMax,
        statusAfterRefusedApply,
        stageBuildPreserved: buildAfter === buildBefore,
        refusalReadableInFull,
        refusalLines,
        stageShiftPx: deltaOf(stageBefore, stageDuring),
        lanesShiftPx: deltaOf(lanesBefore, lanesDuring),
      };
    })()`);

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3c-dock-refusal-1440x900.png'), await session.screenshot());
    }

    await session.evaluate(`(() => { window.rigReviewEditor.animation.clearPending(); })()`);

    if (
      !bar8Result.durationUnchangedAfterEdit ||
      !bar8Result.statusAfterRefusedApply.includes('CE_COMPILE_KEY_AFTER_DURATION') ||
      !bar8Result.stageBuildPreserved ||
      !bar8Result.refusalReadableInFull ||
      bar8Result.stageShiftPx !== 0 ||
      bar8Result.lanesShiftPx !== 0
    ) {
      throw new Error(`Bar 8 / Slice 3c Bar 4 verification failed: ${JSON.stringify(bar8Result, null, 2)}`);
    }

    // PR #255 Review Findings 1 & 2 live browser verification:
    // - Reset to clean baseline, edit head.rotate key 1 on 'tilt' from 10 to 22.5, and Apply.
    // - Finding 1: Click [data-animation-undo-op] so builder returns to baseText (0 ops, builder.dirty=false) while
    //   stage still holds the applied build (22.5). Verify hasPreview()===true and stage head local rotation at t=0.35s
    //   immediately previews the undone original value (10) instead of staying at 22.5!
    // - Finding 2: Re-edit key 1 to 22.5 and Apply, then displace the stage build via ed.reset() (stage returns to
    //   inspected build, appliedOnStage=null). Verify ops() still holds the edit (not wiped!), hasPreview()===true,
    //   [data-animation-apply] is enabled, opsSummary does NOT say 'applied on stage', and stage previews 22.5!
    const pr255Findings = await session.evaluate<{
      finding1: {
        appliedRotationAt035: number;
        opsAfterUndoOp: number;
        hasPreviewAfterUndoOp: boolean;
        undoneRotationAt035: number;
        inspectorChannelVal: string;
      };
      finding2: {
        opsAfterStageDisplaced: number;
        hasPreviewAfterStageDisplaced: boolean;
        applyBtnDisabled: boolean;
        opsSummaryText: string;
        previewRotationAt035: number;
      };
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      await ed.animation.reset();
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      const scrub = document.getElementById('scrub');
      const seekTo = (t) => {
        scrub.value = String(t);
        scrub.dispatchEvent(new Event('input'));
      };
      const headLocalRot = () =>
        Math.round((ed.bone('head').rotationX - ed.bone('chest').rotationX) * 100) / 100;

      ed.animation.selectKey(0, 1);
      ed.animation.setKeyValue(0, 1, 0, 22.5);
      await ed.animation.apply();
      seekTo(0.35);
      const appliedRotationAt035 = headLocalRot();

      // Finding 1: Undo op after Apply
      const undoOpBtn = document.querySelector('[data-animation-undo-op]');
      undoOpBtn.click();
      seekTo(0.35);
      const opsAfterUndoOp = ed.animation.ops().length;
      const hasPreviewAfterUndoOp = ed.animation.hasPreview();
      const undoneRotationAt035 = headLocalRot();
      const inspectorChannelVal = document.querySelector('[data-key-channel="0"]')?.value ?? '';

      // Finding 2: Re-apply 22.5 on stage, then displace the stage build so appliedOnStage becomes null
      ed.animation.setKeyValue(0, 1, 0, 22.5);
      await ed.animation.apply();
      await ed.reset();
      seekTo(0.35);
      const opsAfterStageDisplaced = ed.animation.ops().length;
      const hasPreviewAfterStageDisplaced = ed.animation.hasPreview();
      const applyBtnDisabled = document.querySelector('[data-animation-apply]').disabled;
      const opsSummaryText = document.querySelector('[data-animation-ops-summary]')?.textContent ?? '';
      const previewRotationAt035 = headLocalRot();

      ed.animation.clearPending();
      return {
        finding1: {
          appliedRotationAt035,
          opsAfterUndoOp,
          hasPreviewAfterUndoOp,
          undoneRotationAt035,
          inspectorChannelVal,
        },
        finding2: {
          opsAfterStageDisplaced,
          hasPreviewAfterStageDisplaced,
          applyBtnDisabled,
          opsSummaryText,
          previewRotationAt035,
        },
      };
    })()`);

    if (
      pr255Findings.finding1.appliedRotationAt035 !== 22.5 ||
      pr255Findings.finding1.opsAfterUndoOp !== 0 ||
      pr255Findings.finding1.hasPreviewAfterUndoOp !== true ||
      pr255Findings.finding1.undoneRotationAt035 !== 10 ||
      pr255Findings.finding1.inspectorChannelVal !== '10' ||
      pr255Findings.finding2.opsAfterStageDisplaced !== 1 ||
      pr255Findings.finding2.hasPreviewAfterStageDisplaced !== true ||
      pr255Findings.finding2.applyBtnDisabled !== false ||
      pr255Findings.finding2.opsSummaryText.includes('applied on stage') ||
      pr255Findings.finding2.previewRotationAt035 !== 22.5
    ) {
      throw new Error(`PR #255 Finding 1 / Finding 2 browser verification failed: ${JSON.stringify(pr255Findings, null, 2)}`);
    }

    // PR #257 Findings 2 & 3 live browser verification:
    // - Finding 2: Retime key (0, 1) on 'tilt' in place from 0.35s to 0.5s, then click the retained .animation-key button
    //   and verify the player seeks to 0.5s (not stale 0.35s).
    // - Finding 3: Retime the last key (0, 4) on 'tilt' in place from 1.6s to 3.2s, and verify .animation-axis updates
    //   to '0 s → 3.2 s' and the last .animation-ruler-tick updates to '3.2 s'.
    const pr257Findings = await session.evaluate<{
      finding2SeekTimeAfterClick: number;
      finding3AxisAfterStretch: string;
      finding3LastTickAfterStretch: string;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      await ed.animation.reset();
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      const mark1 = document.querySelector('.animation-key[data-source-track="0"][data-key-index="1"]');
      ed.animation.setKeyTime(0, 1, 0.5);
      mark1.click();
      const finding2SeekTimeAfterClick = Math.round(Number(document.getElementById('scrub').value) * 1000) / 1000;

      ed.animation.setKeyTime(0, 4, 3.2);
      const finding3AxisAfterStretch = document.querySelector('.animation-axis')?.textContent ?? '';
      const ticks = [...document.querySelectorAll('.animation-ruler-tick')].map((t) => t.textContent ?? '');
      const finding3LastTickAfterStretch = ticks.at(-1) ?? '';

      ed.animation.clearPending();
      return {
        finding2SeekTimeAfterClick,
        finding3AxisAfterStretch,
        finding3LastTickAfterStretch,
      };
    })()`);

    if (
      pr257Findings.finding2SeekTimeAfterClick !== 0.5 ||
      pr257Findings.finding3AxisAfterStretch !== '0 s → 3.2 s' ||
      pr257Findings.finding3LastTickAfterStretch !== '3.2 s'
    ) {
      throw new Error(`PR #257 Findings 2 & 3 browser verification failed: ${JSON.stringify(pr257Findings, null, 2)}`);
    }

    // Bar 7 + Slice 3c Bar 3 & Bar 4 on 'hello': U2 measurement (MAX_ANIMATION_OPS = 200 on 'hello': 16 tracks × 115 keys = 1,840 keys),
    // visible lanes >= 6 at default 1440x900 height, and ANIMATION_OPS_TOO_MANY + dense-track refusal readable in full with 0 px shift!
    const bar7Result = await session.evaluate<{
      totalTracks: number;
      editableTracks: number;
      readOnlyTracks: number;
      visibleHelloLanesAtDefaultHeight: number;
      move115Ok: boolean;
      move115OpsCount: number;
      move196Ok: boolean;
      move196OpsCount: number;
      move210Ok: boolean;
      move210Error: string;
      move230Ok: boolean;
      move230Error: string;
      move1610Ok: boolean;
      move1610Error: string;
      opsAfterRefusals: number;
      opsCapRefusalReadableInFull: boolean;
      denseTrackBadgeReadableInFull: boolean;
      stageShiftPxOnCapRefusal: number;
      lanesShiftPxOnCapRefusal: number;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      // Reset to clean state before measuring on hello
      await ed.animation.reset();
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'hello';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      const rectOf = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      const deltaOf = (a, b) =>
        Math.round(
          Math.max(
            Math.abs(a.left - b.left),
            Math.abs(a.top - b.top),
            Math.abs(a.width - b.width),
            Math.abs(a.height - b.height),
          ) * 100,
        ) / 100;

      const stageBefore = rectOf('#stage-layout');
      const lanesBefore = rectOf('.animation-lanes');
      const dockBox = document.querySelector('.inspector').getBoundingClientRect();
      const lanesBox = document.querySelector('.animation-lanes').getBoundingClientRect();
      const rulerBox = document.querySelector('[data-animation-ruler]').getBoundingClientRect();
      const visibleBottom = Math.min(lanesBox.bottom, dockBox.bottom);
      const allHelloLanes = [...document.querySelectorAll('.animation-lanes .animation-lane, .animation-lanes .animation-readonly-lane')];
      const visibleHelloLanesAtDefaultHeight = allHelloLanes.filter((el) => {
        const lr = el.getBoundingClientRect();
        return lr.height > 0 && lr.top >= rulerBox.bottom - 1.5 && lr.bottom <= visibleBottom + 1.5;
      }).length;

      const clss = ed.animation.tracks();
      const editable = clss.filter((c) => c.editable);
      const readOnly = clss.filter((c) => !c.editable);

      // 1. Move 1 editable track (115 keys <= 200)
      const sel115 = Array.from({ length: 115 }, (_, k) => ({ track: editable[0].trackIndex, key: k }));
      const res115 = ed.animation.moveSelection(sel115, 0.005);
      const move115OpsCount = ed.animation.ops().length;
      ed.animation.clearPending();

      // 2. Move 14-frame window across all 14 editable tracks (14 × 14 = 196 keys <= 200)
      const sel196 = editable.flatMap((et) =>
        Array.from({ length: 14 }, (_, i) => ({ track: et.trackIndex, key: 10 + i })),
      );
      const res196 = ed.animation.moveSelection(sel196, 0.005);
      const move196OpsCount = ed.animation.ops().length;
      ed.animation.clearPending();

      // 3. Move 15-frame window across all 14 editable tracks (14 × 15 = 210 keys > 200) -> refused
      const sel210 = editable.flatMap((et) =>
        Array.from({ length: 15 }, (_, i) => ({ track: et.trackIndex, key: 10 + i })),
      );
      const res210 = ed.animation.moveSelection(sel210, 0.005);

      // 4. Move 2 full editable tracks (2 × 115 = 230 keys > 200) -> refused
      const sel230 = [editable[0], editable[1]].flatMap((et) =>
        Array.from({ length: 115 }, (_, k) => ({ track: et.trackIndex, key: k })),
      );
      const res230 = ed.animation.moveSelection(sel230, 0.005);

      // 5. Move all 14 editable tracks (14 × 115 = 1,610 keys > 200) -> refused
      const sel1610 = editable.flatMap((et) =>
        Array.from({ length: 115 }, (_, k) => ({ track: et.trackIndex, key: k })),
      );
      const res1610 = ed.animation.moveSelection(sel1610, 0.005);

      const stageDuring = rectOf('#stage-layout');
      const lanesDuring = rectOf('.animation-lanes');
      const statusEl = document.querySelector('[data-animation-editor-status]');
      const dockStatusEl = document.querySelector('.animation-dock-status');
      const badgeEl = document.querySelector('[data-readonly-badge]');
      const opsCapRefusalReadableInFull =
        !!statusEl &&
        getComputedStyle(statusEl).textOverflow !== 'ellipsis' &&
        statusEl.scrollWidth <= statusEl.clientWidth + 1 &&
        statusEl.scrollHeight <= statusEl.clientHeight + 2 &&
        dockStatusEl.scrollHeight <= dockStatusEl.clientHeight + 2;
      const denseTrackBadgeReadableInFull =
        !!badgeEl &&
        getComputedStyle(badgeEl).textOverflow !== 'ellipsis' &&
        badgeEl.scrollWidth <= badgeEl.clientWidth + 1 &&
        badgeEl.scrollHeight <= badgeEl.clientHeight + 2;

      return {
        totalTracks: clss.length,
        editableTracks: editable.length,
        readOnlyTracks: readOnly.length,
        visibleHelloLanesAtDefaultHeight,
        move115Ok: res115.ok,
        move115OpsCount,
        move196Ok: res196.ok,
        move196OpsCount,
        move210Ok: res210.ok,
        move210Error: res210.error ?? '',
        move230Ok: res230.ok,
        move230Error: res230.error ?? '',
        move1610Ok: res1610.ok,
        move1610Error: res1610.error ?? '',
        opsAfterRefusals: ed.animation.ops().length,
        opsCapRefusalReadableInFull,
        denseTrackBadgeReadableInFull,
        stageShiftPxOnCapRefusal: deltaOf(stageBefore, stageDuring),
        lanesShiftPxOnCapRefusal: deltaOf(lanesBefore, lanesDuring),
      };
    })()`);

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3c-dock-hello-1440x900.png'), await session.screenshot());
    }

    if (
      bar7Result.totalTracks !== 16 ||
      bar7Result.editableTracks !== 14 ||
      bar7Result.readOnlyTracks !== 2 ||
      bar7Result.visibleHelloLanesAtDefaultHeight < 6 ||
      !bar7Result.move115Ok ||
      bar7Result.move115OpsCount !== 115 ||
      !bar7Result.move196Ok ||
      bar7Result.move196OpsCount !== 196 ||
      bar7Result.move210Ok !== false ||
      !bar7Result.move210Error.startsWith('ANIMATION_OPS_TOO_MANY:') ||
      bar7Result.move230Ok !== false ||
      !bar7Result.move230Error.startsWith('ANIMATION_OPS_TOO_MANY:') ||
      bar7Result.move1610Ok !== false ||
      !bar7Result.move1610Error.startsWith('ANIMATION_OPS_TOO_MANY:') ||
      bar7Result.opsAfterRefusals !== 0 ||
      !bar7Result.opsCapRefusalReadableInFull ||
      !bar7Result.denseTrackBadgeReadableInFull ||
      bar7Result.stageShiftPxOnCapRefusal !== 0 ||
      bar7Result.lanesShiftPxOnCapRefusal !== 0
    ) {
      throw new Error(`Bar 7 / Slice 3c Bar 3/4 verification failed: ${JSON.stringify(bar7Result, null, 2)}`);
    }

    // Slice 3b Bar 3, Bar 4, Bar 9 on 'hello' (16 lanes × 115 keys):
    // - Test horizontal zoom 4×, internal lane vertical & horizontal scroll, sticky ruler at top, sticky track head at left.
    // - Test dragging the dock separator (.workspace-inspectorHeight) upward by 70px and verify dock + lanes height grow and preference saves.
    const sepBefore = await session.evaluate<{
      sepX: number;
      sepY: number;
      dockHeightBefore: number;
      lanesHeightBefore: number;
    }>(`(() => {
      const sep = document.querySelector('.workspace-inspectorHeight');
      const r = sep.getBoundingClientRect();
      const dock = document.querySelector('.inspector').getBoundingClientRect();
      const lanes = document.querySelector('.animation-lanes').getBoundingClientRect();
      return {
        sepX: r.left + r.width / 2,
        sepY: r.top + r.height / 2,
        dockHeightBefore: Math.round(dock.height),
        lanesHeightBefore: Math.round(lanes.height),
      };
    })()`);

    await session.dispatchMouseEvent({ type: 'mousePressed', x: sepBefore.sepX, y: sepBefore.sepY, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: sepBefore.sepX, y: sepBefore.sepY - 70, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: sepBefore.sepX, y: sepBefore.sepY - 70, button: 'left', buttons: 0 });

    const slice3bHelloResult = await session.evaluate<{
      totalRenderedLanes: number;
      zoomLevel: number;
      lanesScrollTop: number;
      lanesScrollLeft: number;
      inspectorScrollTop: number;
      rulerStickyTopDiffPx: number;
      headStickyLeftDiffPx: number;
      lastLaneVisibleInLanesBox: boolean;
      dockHeightBefore: number;
      dockHeightAfter: number;
      lanesHeightBefore: number;
      lanesHeightAfter: number;
      savedInspectorHeight: number;
    }>(`(async () => {
      const ed = window.rigReviewEditor.animation;
      // Click 4× horizontal zoom button
      const zoom4Btn = document.querySelector('[data-animation-zoom="4"]');
      zoom4Btn.click();
      ed.selectKey(0, 10);
      await new Promise((r) => setTimeout(r, 40));

      const lanes = document.querySelector('.animation-lanes');
      const allLanes = [...lanes.querySelectorAll('.animation-lane, .animation-readonly-lane')];
      // Scroll lanes vertically to bottom and horizontally by 160px
      lanes.scrollTop = lanes.scrollHeight;
      lanes.scrollLeft = 160;
      await new Promise((r) => setTimeout(r, 20));

      const lanesRect = lanes.getBoundingClientRect();
      const rulerRect = lanes.querySelector('[data-animation-ruler]').getBoundingClientRect();
      const lastLane = allLanes.at(-1);
      const lastLaneRect = lastLane.getBoundingClientRect();
      const lastHeadRect = lastLane.querySelector('[data-lane-head]').getBoundingClientRect();
      const dockRect = document.querySelector('.inspector').getBoundingClientRect();
      const inspPanel = document.querySelector('[data-inspector-panel="playback"]');
      const savedPrefs = JSON.parse(localStorage.getItem('rig-review-preferences/1') || '{}');

      return {
        totalRenderedLanes: allLanes.length,
        zoomLevel: ed.zoom(),
        lanesScrollTop: Math.round(lanes.scrollTop),
        lanesScrollLeft: Math.round(lanes.scrollLeft),
        inspectorScrollTop: inspPanel?.scrollTop ?? -1,
        rulerStickyTopDiffPx: Math.round(Math.abs(rulerRect.top - lanesRect.top) * 100) / 100,
        headStickyLeftDiffPx: Math.round(Math.abs(lastHeadRect.left - lanesRect.left) * 100) / 100,
        lastLaneVisibleInLanesBox: lastLaneRect.bottom <= lanesRect.bottom + 2 && lastLaneRect.top >= lanesRect.top,
        dockHeightBefore: ${sepBefore.dockHeightBefore},
        dockHeightAfter: Math.round(dockRect.height),
        lanesHeightBefore: ${sepBefore.lanesHeightBefore},
        lanesHeightAfter: Math.round(lanesRect.height),
        savedInspectorHeight: Math.round(savedPrefs?.panels?.inspectorHeight ?? 0),
      };
    })()`);

    if (
      slice3bHelloResult.totalRenderedLanes !== 16 ||
      slice3bHelloResult.zoomLevel !== 4 ||
      slice3bHelloResult.lanesScrollTop <= 0 ||
      slice3bHelloResult.lanesScrollLeft <= 0 ||
      slice3bHelloResult.inspectorScrollTop !== 0 ||
      slice3bHelloResult.rulerStickyTopDiffPx > 2 ||
      slice3bHelloResult.headStickyLeftDiffPx > 2 ||
      !slice3bHelloResult.lastLaneVisibleInLanesBox ||
      slice3bHelloResult.dockHeightAfter < slice3bHelloResult.dockHeightBefore + 50 ||
      slice3bHelloResult.lanesHeightAfter < slice3bHelloResult.lanesHeightBefore + 50 ||
      slice3bHelloResult.savedInspectorHeight !== slice3bHelloResult.dockHeightAfter
    ) {
      throw new Error(`Slice 3b Bar 3/4/9 hello verification failed: ${JSON.stringify(slice3bHelloResult, null, 2)}`);
    }

    if (screenshotDir) {
      const helloPng = await session.screenshot();
      await writeFile(join(screenshotDir, 'slice3-hello-cap-refusal.png'), helloPng);
      await writeFile(join(screenshotDir, 'slice3b-dock-hello-1440x900.png'), helloPng);
    }

    // Slice 4a Browser Verification:
    // - Restore default 272px dock height and 1x zoom
    // - Defect 2: Loading state shows ANIMATION_SOURCE_LOADING ('Reading the producer handoff…'), never ANIMATION_SOURCE_MISSING
    // - Defect 3: Zero .animation-readonly-badge elements inside .animation-key-lane and 0 px overlap between badges and keys across idle, tilt, hello
    // - Defect 1: Apply succeeds when environment schedule (#environment-use) is active, carrying {animation, environment}
    // - Defect 4: After Apply, .animation-dock-status has 0 clipping at top and bottom (gateRect.top >= dockStatusRect.top, editorStatusRect.bottom <= dockStatusRect.bottom)
    // - Curves view: Switch to Curves view, test segment/mode/ease controls, drag [data-curve-handle="1"] across 3 mouseMoved steps (coalesced to 1 set_key_curve op), live stage pose preview, and compiled parity (maxFroundDiff === 0)
    const slice4aPreDrag = await session.evaluate<{
      defect2LoadingGateCode: string;
      defect2LoadingAttr: string | null;
      defect2LoadingText: string;
      defect3: {
        idleBadgesInKeyLane: number;
        tiltBadgesInKeyLane: number;
        helloBadgesInKeyLane: number;
        tiltLagTrackKeyMarks: number;
        tiltSubrowBadges: number;
        maxBadgeKeyOverlapPx: number;
      };
      defect1And4: {
        envApplyBusy: boolean;
        envAppliedSchema: string;
        envAppliedSteps: number;
        envAppliedSha256Len: number;
        statusAfterEnvApply: string;
        dockStatusTopClipPx: number;
        dockStatusBottomClipPx: number;
        dockStatusOverflowPx: number;
      };
      curveEaseOp: any;
      curveHandle1Start: { x: number; y: number };
      curvePlotRect: { left: number; top: number; width: number; height: number };
      rotBeforeHandleDrag: number;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const sep = document.querySelector('.workspace-inspectorHeight');
      if (sep) sep.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const zoom1Btn = document.querySelector('[data-animation-zoom="1"]');
      if (zoom1Btn) zoom1Btn.click();
      await ed.animation.reset();

      // Defect 2: Verify loading state does not show false ANIMATION_SOURCE_MISSING refusal
      const fullStatus = await ed.status();
      ed.animation.setSourceLoading();
      const defect2LoadingGateCode = ed.animation.gate().code;
      const gateBanner = document.querySelector('[data-animation-gate]');
      const defect2LoadingAttr = gateBanner?.getAttribute('data-loading') ?? null;
      const defect2LoadingText = gateBanner?.textContent ?? '';
      ed.animation.setSource(fullStatus.animations, fullStatus.reason);

      // Defect 3: Check read-only badges vs key marks across idle, hello, and tilt
      const animSelect = document.getElementById('animation-select');
      const selectClip = async (name) => {
        animSelect.value = name;
        animSelect.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 40));
      };
      const measureOverlap = () => {
        const badges = [...document.querySelectorAll('[data-readonly-badge]')];
        const keys = [...document.querySelectorAll('.animation-key')];
        let maxOverlap = 0;
        for (const b of badges) {
          const br = b.getBoundingClientRect();
          for (const k of keys) {
            const kr = k.getBoundingClientRect();
            const ox = Math.max(0, Math.min(br.right, kr.right) - Math.max(br.left, kr.left));
            const oy = Math.max(0, Math.min(br.bottom, kr.bottom) - Math.max(br.top, kr.top));
            const area = ox * oy;
            if (area > maxOverlap) maxOverlap = area;
          }
        }
        return Math.round(maxOverlap * 100) / 100;
      };

      await selectClip('idle');
      const idleBadgesInKeyLane = document.querySelectorAll('.animation-key-lane:not(.readonly-lane-track) [data-readonly-badge]').length;
      let maxBadgeKeyOverlapPx = measureOverlap();

      await selectClip('hello');
      const helloBadgesInKeyLane = document.querySelectorAll('.animation-key-lane:not(.readonly-lane-track) [data-readonly-badge]').length;
      maxBadgeKeyOverlapPx = Math.max(maxBadgeKeyOverlapPx, measureOverlap());

      await selectClip('tilt');
      const tiltBadgesInKeyLane = document.querySelectorAll('.animation-key-lane:not(.readonly-lane-track) [data-readonly-badge]').length;
      const tiltSubrowBadges = document.querySelectorAll('.animation-lane .animation-readonly-subrow[data-readonly-badge]').length;
      const lagLane = document.querySelector('.animation-lane[data-source-track="5"]');
      const tiltLagTrackKeyMarks = lagLane ? lagLane.querySelectorAll('.animation-key-lane .animation-key').length : 0;
      maxBadgeKeyOverlapPx = Math.max(maxBadgeKeyOverlapPx, measureOverlap());

      // Defect 1 & Defect 4: Engage environment + enable environment schedule (#environment-use), edit key on tilt, and Apply
      const windBase = document.getElementById('wind-base');
      windBase.value = '1.2';
      windBase.dispatchEvent(new Event('input'));
      ed.world.use(true);
      ed.animation.selectKey(0, 1);
      ed.animation.setKeyValue(0, 1, 0, 16);
      await ed.animation.apply();

      const applied = ed.stage().applied;
      const statusAfterEnvApply = ed.animation.status();
      const dockStatusEl = document.querySelector('.animation-dock-status');
      const gateEl = document.querySelector('[data-animation-gate]');
      const editorStatusEl = document.querySelector('[data-animation-editor-status]');
      const dsr = dockStatusEl.getBoundingClientRect();
      const gr = gateEl.getBoundingClientRect();
      const esr = editorStatusEl.getBoundingClientRect();
      const dockStatusTopClipPx = Math.max(0, Math.round((dsr.top - gr.top) * 100) / 100);
      const dockStatusBottomClipPx = Math.max(0, Math.round((esr.bottom - dsr.bottom) * 100) / 100);
      const dockStatusOverflowPx = Math.max(0, dockStatusEl.scrollHeight - dockStatusEl.clientHeight);

      // Prepare Curves view on tilt (reset environment & animation to clean baseline first)
      ed.world.use(false);
      document.getElementById('physics-reset').click();
      await ed.animation.reset();
      await selectClip('tilt');

      const curveBtn = document.querySelector('[data-animation-view="curve"]');
      curveBtn.click();
      ed.animation.selectKey(0, 0);

      // Test ease mode & preset selector in Curves view
      const easeSel = document.querySelector('[data-curve-ease]');
      easeSel.value = 'ease:easeOutQuad';
      easeSel.dispatchEvent(new Event('change'));
      const curveEaseOp = ed.animation.ops()[0];
      ed.animation.clearPending();

      // Switch segment 0 to cubic mode via [data-curve-ease] (creates 1 set_key_curve op that the handle drag will coalesce into!)
      easeSel.value = 'cubic';
      easeSel.dispatchEvent(new Event('change'));

      const scrub = document.getElementById('scrub');
      scrub.value = '0.175';
      scrub.dispatchEvent(new Event('input'));
      const rotBeforeHandleDrag = Math.round((ed.bone('head').rotationX - ed.bone('chest').rotationX) * 1000) / 1000;

      const h1 = document.querySelector('[data-curve-handle="1"]');
      const hr = h1.getBoundingClientRect();
      const plot = document.querySelector('[data-curve-plot]').getBoundingClientRect();

      return {
        defect2LoadingGateCode,
        defect2LoadingAttr,
        defect2LoadingText,
        defect3: {
          idleBadgesInKeyLane,
          tiltBadgesInKeyLane,
          helloBadgesInKeyLane,
          tiltLagTrackKeyMarks,
          tiltSubrowBadges,
          maxBadgeKeyOverlapPx,
        },
        defect1And4: {
          envApplyBusy: ed.stage().busy,
          envAppliedSchema: applied?.schema ?? '',
          envAppliedSteps: applied?.environment?.steps ?? 0,
          envAppliedSha256Len: applied?.environment?.sha256?.length ?? 0,
          statusAfterEnvApply,
          dockStatusTopClipPx,
          dockStatusBottomClipPx,
          dockStatusOverflowPx,
        },
        curveEaseOp,
        curveHandle1Start: { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 },
        curvePlotRect: { left: plot.left, top: plot.top, width: plot.width, height: plot.height },
        rotBeforeHandleDrag,
      };
    })()`);

    // Drag [data-curve-handle="1"] across 3 mouseMoved steps on the curve SVG plot to a measured target point
    const hx0 = slice4aPreDrag.curveHandle1Start.x;
    const hy0 = slice4aPreDrag.curveHandle1Start.y;
    const targetCurveHx = Math.round(hx0 + 28);
    const targetCurveHy = Math.round(hy0 - 24);
    await session.dispatchMouseEvent({ type: 'mousePressed', x: hx0, y: hy0, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: hx0 + 10, y: hy0 - 9, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: hx0 + 20, y: hy0 - 17, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: targetCurveHx, y: targetCurveHy, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: targetCurveHx, y: targetCurveHy, button: 'left', buttons: 0 });

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice4a-curves-drag-1440x900.png'), await session.screenshot());
    }

    const slice4aPostDrag = await session.evaluate<{
      curveHandleLandingErrorPx: number;
      curveHandleLandedCenter: { x: number; y: number };
      opsAfterHandleDrag: any[];
      rotAfterHandleDrag: number;
      curveApplyMaxFroundDiff: number;
      curveReadOnlyBannerVisible: boolean;
      curveReadOnlyText: string;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const h1After = document.querySelector('[data-curve-handle="1"]').getBoundingClientRect();
      const landedX = h1After.left + h1After.width / 2;
      const landedY = h1After.top + h1After.height / 2;
      const curveHandleLandingErrorPx =
        Math.round(Math.hypot(landedX - ${targetCurveHx}, landedY - ${targetCurveHy}) * 1000) / 1000;
      const opsAfterHandleDrag = ed.animation.ops();
      const scrub = document.getElementById('scrub');
      const seekTo = (t) => {
        scrub.value = String(t);
        scrub.dispatchEvent(new Event('input'));
      };
      seekTo(0.175);
      const rotAfterHandleDrag = Math.round((ed.bone('head').rotationX - ed.bone('chest').rotationX) * 1000) / 1000;

      // Measure preview vs compiled pose parity across segment 0 sample times
      const sampleTimes = [0, 0.08, 0.175, 0.26, 0.35];
      const previewRots = sampleTimes.map((t) => {
        seekTo(t);
        return Math.fround(ed.bone('head').rotationX);
      });
      await ed.animation.apply();
      let curveApplyMaxFroundDiff = 0;
      for (let i = 0; i < sampleTimes.length; i++) {
        seekTo(sampleTimes[i]);
        const diff = Math.abs(previewRots[i] - Math.fround(ed.bone('head').rotationX));
        if (diff > curveApplyMaxFroundDiff) curveApplyMaxFroundDiff = diff;
      }

      // Select read-only track 5 (sleeve_l0.rotate, lag) in Curves view via [data-curve-channel] and verify read-only notice
      const chSel = document.querySelector('[data-curve-channel]');
      const lagOpt = [...chSel.options].find((o) => o.textContent?.includes('sleeve_l0'));
      if (lagOpt) {
        chSel.value = lagOpt.value;
        chSel.dispatchEvent(new Event('change'));
      }
      const roBanner = document.querySelector('[data-curve-readonly]');
      const curveReadOnlyBannerVisible = !!roBanner && !roBanner.hidden;
      const curveReadOnlyText = roBanner?.textContent ?? '';

      // Switch back to Timeline view on tilt so we can capture Defect 3 + Defect 4 screenshot cleanly
      const timelineBtn = document.querySelector('[data-animation-view="timeline"]');
      timelineBtn.click();
      const lanes = document.querySelector('.animation-lanes');
      lanes.scrollTop = lanes.scrollHeight;
      await new Promise((r) => setTimeout(r, 25));

      return {
        curveHandleLandingErrorPx,
        curveHandleLandedCenter: { x: Math.round(landedX * 100) / 100, y: Math.round(landedY * 100) / 100 },
        opsAfterHandleDrag,
        rotAfterHandleDrag,
        curveApplyMaxFroundDiff,
        curveReadOnlyBannerVisible,
        curveReadOnlyText,
      };
    })()`);

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice4a-defect3-4-dopesheet-1440x900.png'), await session.screenshot());
    }

    if (
      slice4aPostDrag.curveHandleLandingErrorPx >= 1 ||
      slice4aPreDrag.defect2LoadingGateCode !== 'ANIMATION_SOURCE_LOADING' ||
      slice4aPreDrag.defect2LoadingAttr !== 'true' ||
      !slice4aPreDrag.defect2LoadingText.includes('Reading the producer handoff') ||
      slice4aPreDrag.defect3.idleBadgesInKeyLane !== 0 ||
      slice4aPreDrag.defect3.tiltBadgesInKeyLane !== 0 ||
      slice4aPreDrag.defect3.helloBadgesInKeyLane !== 0 ||
      slice4aPreDrag.defect3.tiltLagTrackKeyMarks < 2 ||
      slice4aPreDrag.defect3.tiltSubrowBadges < 1 ||
      slice4aPreDrag.defect3.maxBadgeKeyOverlapPx !== 0 ||
      slice4aPreDrag.defect1And4.envApplyBusy !== false ||
      slice4aPreDrag.defect1And4.envAppliedSchema !== 'rig-review-applied/5' ||
      slice4aPreDrag.defect1And4.envAppliedSteps < 1 ||
      slice4aPreDrag.defect1And4.envAppliedSha256Len !== 64 ||
      !slice4aPreDrag.defect1And4.statusAfterEnvApply.startsWith('Applied ') ||
      !slice4aPreDrag.defect1And4.statusAfterEnvApply.includes('under the exported world') ||
      slice4aPreDrag.defect1And4.dockStatusTopClipPx > 0.5 ||
      slice4aPreDrag.defect1And4.dockStatusBottomClipPx > 0.5 ||
      slice4aPreDrag.defect1And4.dockStatusOverflowPx > 1 ||
      slice4aPreDrag.curveEaseOp?.op !== 'set_key_ease' ||
      slice4aPreDrag.curveEaseOp?.ease !== 'easeOutQuad' ||
      slice4aPostDrag.opsAfterHandleDrag.length !== 1 ||
      slice4aPostDrag.opsAfterHandleDrag[0].op !== 'set_key_curve' ||
      slice4aPostDrag.rotAfterHandleDrag === slice4aPreDrag.rotBeforeHandleDrag ||
      slice4aPostDrag.curveApplyMaxFroundDiff !== 0 ||
      !slice4aPostDrag.curveReadOnlyBannerVisible ||
      !slice4aPostDrag.curveReadOnlyText.includes('ANIMATION_TRACK_READ_ONLY') ||
      !slice4aPostDrag.curveReadOnlyText.includes('sleeve_l0.rotate')
    ) {
      throw new Error(
        `Slice 4a browser verification failed: ${JSON.stringify({ slice4aPreDrag, slice4aPostDrag }, null, 2)}`,
      );
    }

    // -------------------------------------------------------------------------
    // Slice 4b Browser Verification:
    // Part 1: Multi-key selection in the dopesheet (Shift-click, box drag >= 3 px,
    //         group drag retime + 1-step undo + Apply readback, group delete + 1-step undo
    //         + ANIMATION_TRACK_MIN_KEYS refusal, read-only tracks skipped & named in status,
    //         empty lane click < 3 px seeks playhead).
    // Part 2: Bone drag on stage (Pose: Rotate & Pose: Move, existing key vs unkeyed playhead
    //         insert+set as 1 undo step, parent bone world-matrix inversion on unrotated and
    //         rotated parents landing within < 1 px of cursor, Apply parity maxFroundDiff === 0,
    //         ANIMATION_BONE_CONSTRAINED / ANIMATION_BONE_NO_TRACK / ANIMATION_TRACK_READ_ONLY refusals).
    // -------------------------------------------------------------------------
    const slice4bBoxCoords = await session.evaluate<{
      k01: { x: number; y: number };
      k11: { x: number; y: number };
      k21: { x: number; y: number };
      boxStart: { x: number; y: number };
      boxEnd: { x: number; y: number };
      lane0Left: number;
      lane0Width: number;
      emptyLaneClick: { x: number; y: number };
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      await ed.animation.reset();
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      const timelineBtn = document.querySelector('[data-animation-view="timeline"]');
      timelineBtn.click();
      const zoom1Btn = document.querySelector('[data-animation-zoom="1"]');
      zoom1Btn.click();
      const lanes = document.querySelector('.animation-lanes');
      lanes.scrollTop = 0;
      lanes.scrollLeft = 0;
      await new Promise((r) => setTimeout(r, 40));

      const centerOf = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const k01 = centerOf('.animation-key[data-source-track="0"][data-key-index="1"]');
      const k11 = centerOf('.animation-key[data-source-track="1"][data-key-index="1"]');
      const k21 = centerOf('.animation-key[data-source-track="2"][data-key-index="1"]');
      const lane0 = document.querySelector('.animation-lane[data-source-track="0"] .animation-key-lane').getBoundingClientRect();
      const lane5 = document.querySelector('.animation-lane[data-source-track="5"] .animation-key-lane').getBoundingClientRect();

      // Box drag from t=0.2s above track 0 down to t=1.05s across track 5 (includes editable tracks 0,1,2 and read-only lag track 5)
      const boxStart = {
        x: Math.round(lane0.left + (0.2 / 1.6) * lane0.width),
        y: Math.round(lane0.top + 3),
      };
      const boxEnd = {
        x: Math.round(lane0.left + (1.05 / 1.6) * lane0.width),
        y: Math.round(lane5.bottom - 2),
      };
      const emptyLaneClick = {
        x: Math.round(lane0.left + (0.65 / 1.6) * lane0.width),
        y: Math.round(lane0.top + lane0.height / 2),
      };
      return {
        k01,
        k11,
        k21,
        boxStart,
        boxEnd,
        lane0Left: lane0.left,
        lane0Width: lane0.width,
        emptyLaneClick,
      };
    })()`);

    // 1. Click key (0,1), then Shift-click (1,1) and (2,1) -> 3 keys selected; Shift-click (2,1) again -> 2 keys selected
    await session.dispatchMouseEvent({ type: 'mousePressed', x: slice4bBoxCoords.k01.x, y: slice4bBoxCoords.k01.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: slice4bBoxCoords.k01.x, y: slice4bBoxCoords.k01.y, button: 'left', buttons: 0 });
    await session.dispatchMouseEvent({ type: 'mousePressed', x: slice4bBoxCoords.k11.x, y: slice4bBoxCoords.k11.y, button: 'left', buttons: 1, modifiers: 8 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: slice4bBoxCoords.k11.x, y: slice4bBoxCoords.k11.y, button: 'left', buttons: 0, modifiers: 8 });
    await session.dispatchMouseEvent({ type: 'mousePressed', x: slice4bBoxCoords.k21.x, y: slice4bBoxCoords.k21.y, button: 'left', buttons: 1, modifiers: 8 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: slice4bBoxCoords.k21.x, y: slice4bBoxCoords.k21.y, button: 'left', buttons: 0, modifiers: 8 });

    const shiftClickCount3 = await session.evaluate<number>('window.rigReviewEditor.animation.selectedKeys().length');
    await session.dispatchMouseEvent({ type: 'mousePressed', x: slice4bBoxCoords.k21.x, y: slice4bBoxCoords.k21.y, button: 'left', buttons: 1, modifiers: 8 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: slice4bBoxCoords.k21.x, y: slice4bBoxCoords.k21.y, button: 'left', buttons: 0, modifiers: 8 });
    const shiftClickCount2 = await session.evaluate<number>('window.rigReviewEditor.animation.selectedKeys().length');

    // 2. Box-drag selection (>= 3 px) starting on empty lane space at t=0.2s on track 0 down to t=1.6s on track 5
    //    (encloses editable keys on tracks 0..2 AND read-only lag track 5 key at t=1.6s!)
    const boxX0 = slice4bBoxCoords.boxStart.x;
    const boxY0 = slice4bBoxCoords.boxStart.y;
    const boxX1 = Math.round(slice4bBoxCoords.lane0Left + slice4bBoxCoords.lane0Width + 4);
    const boxY1 = slice4bBoxCoords.boxEnd.y;
    await session.dispatchMouseEvent({ type: 'mousePressed', x: boxX0, y: boxY0, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: Math.round((boxX0 + boxX1) / 2), y: Math.round((boxY0 + boxY1) / 2), button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: boxX1, y: boxY1, button: 'left', buttons: 1 });

    const activeBoxRect = await session.evaluate<{ present: boolean; width: number; height: number }>(`(() => {
      const el = document.querySelector('[data-selection-box]');
      if (!el) return { present: false, width: 0, height: 0 };
      const r = el.getBoundingClientRect();
      return { present: true, width: Math.round(r.width), height: Math.round(r.height) };
    })()`);

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice4b-box-select-1440x900.png'), await session.screenshot());
    }

    await session.dispatchMouseEvent({ type: 'mouseReleased', x: boxX1, y: boxY1, button: 'left', buttons: 0 });

    const afterBoxSelect = await session.evaluate<{
      selectedKeys: Array<{ trackIndex: number; keyIndex: number }>;
      hasReadOnlyInSelection: boolean;
      statusAfterBoxWithReadOnly: string;
      inspectorTitle: string;
    }>(`(() => {
      const ed = window.rigReviewEditor.animation;
      const sel = ed.selectedKeys();
      const tracks = ed.tracks();
      const hasReadOnlyInSelection = sel.some((s) => !tracks[s.trackIndex]?.editable);
      return {
        selectedKeys: sel.map((s) => ({ trackIndex: s.trackIndex, keyIndex: s.keyIndex })),
        hasReadOnlyInSelection,
        statusAfterBoxWithReadOnly: ed.status(),
        inspectorTitle: document.querySelector('[data-key-inspector-title]')?.textContent ?? '',
      };
    })()`);

    // 3. Plain click (< 3 px) on empty editable lane seeks playhead and clears multi-selection,
    //    then select middle keys (0,1), (1,1), (2,1) via box drag [0.25s..0.9s] and drag key (0,1) right by +0.05s!
    await session.dispatchMouseEvent({ type: 'mousePressed', x: slice4bBoxCoords.emptyLaneClick.x, y: slice4bBoxCoords.emptyLaneClick.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: slice4bBoxCoords.emptyLaneClick.x, y: slice4bBoxCoords.emptyLaneClick.y, button: 'left', buttons: 0 });
    const afterEmptyLaneClick = await session.evaluate<{ selectedCount: number; scrubValue: number }>(`(() => ({
      selectedCount: window.rigReviewEditor.animation.selectedKeys().length,
      scrubValue: Number(document.getElementById('scrub').value),
    }))()`);

    // Box-select the middle keys in [0.25s..0.85s] across tracks 0, 1, 2:
    // Track 0 key 1 (0.35s), Track 1 key 1 (0.8s), Track 2 key 1 (0.5s) -> 3 keys across 3 tracks!
    const midBoxX0 = Math.round(slice4bBoxCoords.lane0Left + (0.25 / 1.6) * slice4bBoxCoords.lane0Width);
    const midBoxX1 = Math.round(slice4bBoxCoords.lane0Left + (0.85 / 1.6) * slice4bBoxCoords.lane0Width);
    const midBoxY0 = slice4bBoxCoords.boxStart.y;
    const midBoxY1 = Math.round(slice4bBoxCoords.k21.y + 6);
    await session.dispatchMouseEvent({ type: 'mousePressed', x: midBoxX0, y: midBoxY0, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: midBoxX1, y: midBoxY1, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: midBoxX1, y: midBoxY1, button: 'left', buttons: 0 });

    // Drag selected key (0,1) from t=0.35s to t=0.40s (+0.05s) across 2 mouseMoved steps
    const dragK01Target1 = slice4bBoxCoords.lane0Left + (0.38 / 1.6) * slice4bBoxCoords.lane0Width;
    const dragK01Target2 = slice4bBoxCoords.lane0Left + (0.40 / 1.6) * slice4bBoxCoords.lane0Width;
    await session.dispatchMouseEvent({ type: 'mousePressed', x: slice4bBoxCoords.k01.x, y: slice4bBoxCoords.k01.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: dragK01Target1, y: slice4bBoxCoords.k01.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: dragK01Target2, y: slice4bBoxCoords.k01.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: dragK01Target2, y: slice4bBoxCoords.k01.y, button: 'left', buttons: 0 });

    const slice4bDopesheetResult = await session.evaluate<{
      groupDragOps: any[];
      opsCountAfterSingleUndo: number;
      deleteGroupOpsCount: number;
      opsCountAfterDeleteUndo: number;
      minKeysRefusalError: string;
      groupApplyRebuiltTimes: number[];
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const groupDragOps = ed.animation.ops();
      // 1-step Undo op unwinds all 3 retimed keys at once!
      document.querySelector('[data-animation-undo-op]').click();
      const opsCountAfterSingleUndo = ed.animation.ops().length;

      // Group delete of the 3 selected middle keys via [data-delete-key] + 1-step Undo op
      document.querySelector('[data-delete-key]').click();
      const deleteGroupOpsCount = ed.animation.ops().length;
      document.querySelector('[data-animation-undo-op]').click();
      const opsCountAfterDeleteUndo = ed.animation.ops().length;

      // Refusal when deleting all 3 keys of track 1 (head.translate) -> ANIMATION_TRACK_MIN_KEYS
      ed.animation.selectKeys([{ track: 1, key: 0 }, { track: 1, key: 1 }, { track: 1, key: 2 }]);
      const minKeysRes = ed.animation.deleteSelection();
      const minKeysRefusalError = minKeysRes.ok ? '' : minKeysRes.error;

      // Group move + Apply · Rebuild readback
      ed.animation.selectKeys([{ track: 0, key: 1 }, { track: 2, key: 1 }]);
      ed.animation.moveSelection([{ track: 0, key: 1 }, { track: 2, key: 1 }], 0.05);
      await ed.animation.apply();
      const insp = ed.animation.overlaid();
      const t0k1 = Math.round(insp.tracks.find((t) => t.target === 'head' && t.name === 'rotate').keys[1].time * 1000) / 1000;
      const t2k1 = Math.round(insp.tracks.find((t) => t.target === 'chest' && t.name === 'rotate').keys[1].time * 1000) / 1000;
      await ed.animation.reset();

      return {
        groupDragOps,
        opsCountAfterSingleUndo,
        deleteGroupOpsCount,
        opsCountAfterDeleteUndo,
        minKeysRefusalError,
        groupApplyRebuiltTimes: [t0k1, t2k1],
      };
    })()`);

    // Part 2: Stage bone drag (rotate & translate on unrotated and rotated parents, unkeyed insert+set 1-step undo, refusals)
    const stageSetup = await session.evaluate<{
      headPickAt035: { x: number; y: number };
      rotBeforeExistingDrag: number;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      // Ensure Bone points (#layer-bones) is active on the stage
      const layerBones = document.getElementById('layer-bones');
      if (layerBones && layerBones.getAttribute('aria-pressed') !== 'true') layerBones.click();
      // Select Pose: Rotate mode
      document.querySelector('[data-stage-pose-mode="rotate"]').click();
      const scrub = document.getElementById('scrub');
      scrub.value = '0.35';
      scrub.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 30));
      const pick = document.querySelector('.animation-bone-pick[data-bone="head"]').getBoundingClientRect();
      return {
        headPickAt035: { x: pick.left + pick.width / 2, y: pick.top + pick.height / 2 },
        rotBeforeExistingDrag: ed.bone('head').rotationX,
      };
    })()`);

    // 2a. Stage rotate drag on `head` at existing key t=0.35s across 2 mouseMoved steps + 1-step undo
    await session.dispatchMouseEvent({ type: 'mousePressed', x: stageSetup.headPickAt035.x, y: stageSetup.headPickAt035.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: stageSetup.headPickAt035.x + 25, y: stageSetup.headPickAt035.y - 15, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: stageSetup.headPickAt035.x + 45, y: stageSetup.headPickAt035.y - 25, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: stageSetup.headPickAt035.x + 45, y: stageSetup.headPickAt035.y - 25, button: 'left', buttons: 0 });

    const afterExistingRotDrag = await session.evaluate<{
      ops: any[];
      rotAfter: number;
      opsAfterUndo: number;
      headPickAt060: { x: number; y: number };
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const ops = ed.animation.ops();
      const rotAfter = ed.bone('head').rotationX;
      document.querySelector('[data-animation-undo-op]').click();
      const opsAfterUndo = ed.animation.ops().length;

      // Seek to unkeyed time t=0.60s on tilt
      const scrub = document.getElementById('scrub');
      scrub.value = '0.6';
      scrub.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 25));
      const pick = document.querySelector('.animation-bone-pick[data-bone="head"]').getBoundingClientRect();
      return {
        ops,
        rotAfter,
        opsAfterUndo,
        headPickAt060: { x: pick.left + pick.width / 2, y: pick.top + pick.height / 2 },
      };
    })()`);

    // 2b. Stage rotate drag on `head` at UNKEYED playhead t=0.60s -> inserts + sets key in 1 gesture, 1 undo step
    await session.dispatchMouseEvent({ type: 'mousePressed', x: afterExistingRotDrag.headPickAt060.x, y: afterExistingRotDrag.headPickAt060.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: afterExistingRotDrag.headPickAt060.x + 30, y: afterExistingRotDrag.headPickAt060.y - 20, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: afterExistingRotDrag.headPickAt060.x + 50, y: afterExistingRotDrag.headPickAt060.y - 30, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: afterExistingRotDrag.headPickAt060.x + 50, y: afterExistingRotDrag.headPickAt060.y - 30, button: 'left', buttons: 0 });

    const afterUnkeyedRotDrag = await session.evaluate<{
      ops: any[];
      opsAfterSingleUndo: number;
      headPickAt0: { x: number; y: number };
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const ops = ed.animation.ops();
      document.querySelector('[data-animation-undo-op]').click();
      const opsAfterSingleUndo = ed.animation.ops().length;

      // Seek to t=0s on tilt (chest.rotate = 0, unrotated parent) and switch to Pose: Move (translate)
      const scrub = document.getElementById('scrub');
      scrub.value = '0';
      scrub.dispatchEvent(new Event('input'));
      document.querySelector('[data-stage-pose-mode="translate"]').click();
      await new Promise((r) => setTimeout(r, 25));
      const pick = document.querySelector('.animation-bone-pick[data-bone="head"]').getBoundingClientRect();
      return {
        ops,
        opsAfterSingleUndo,
        headPickAt0: { x: pick.left + pick.width / 2, y: pick.top + pick.height / 2 },
      };
    })()`);

    // 2c. Stage translate drag on UNROTATED parent (`head` under `chest` at t=0s on `tilt`) -> lands within < 1 px of cursor
    const unrotTargetX = Math.round(afterUnkeyedRotDrag.headPickAt0.x + 24);
    const unrotTargetY = Math.round(afterUnkeyedRotDrag.headPickAt0.y - 18);
    await session.dispatchMouseEvent({ type: 'mousePressed', x: afterUnkeyedRotDrag.headPickAt0.x, y: afterUnkeyedRotDrag.headPickAt0.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: Math.round(afterUnkeyedRotDrag.headPickAt0.x + 12), y: Math.round(afterUnkeyedRotDrag.headPickAt0.y - 9), button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: unrotTargetX, y: unrotTargetY, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: unrotTargetX, y: unrotTargetY, button: 'left', buttons: 0 });

    const afterUnrotTranslate = await session.evaluate<{
      unrotatedParentCursorErrorPx: number;
      opsAfterUndo: number;
      browPickOnRotatedHead: { x: number; y: number };
      headRotDeg: number;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const pickAfter = document.querySelector('.animation-bone-pick[data-bone="head"]').getBoundingClientRect();
      const landedX = pickAfter.left + pickAfter.width / 2;
      const landedY = pickAfter.top + pickAfter.height / 2;
      const unrotatedParentCursorErrorPx =
        Math.round(Math.hypot(landedX - ${unrotTargetX}, landedY - ${unrotTargetY}) * 1000) / 1000;
      document.querySelector('[data-animation-undo-op]').click();
      const opsAfterUndo = ed.animation.ops().length;

      // Stay on 'tilt' clip, seek to t=0.8s (where 'head.translate' has key 1), and rotate parent 'chest' (track 2, keys 1 & 2) to 35 deg!
      const scrub = document.getElementById('scrub');
      scrub.value = '0.8';
      scrub.dispatchEvent(new Event('input'));
      ed.animation.setKeyValue(2, 1, 0, 35);
      ed.animation.setKeyValue(2, 2, 0, 35);
      document.querySelector('[data-stage-pose-mode="translate"]').click();
      await new Promise((r) => setTimeout(r, 25));

      const headPick = document.querySelector('.animation-bone-pick[data-bone="head"]').getBoundingClientRect();
      return {
        unrotatedParentCursorErrorPx,
        opsAfterUndo,
        browPickOnRotatedHead: { x: headPick.left + headPick.width / 2, y: headPick.top + headPick.height / 2 },
        headRotDeg: Math.round(ed.bone('chest').rotationX * 100) / 100,
      };
    })()`);

    // 2d. Stage translate drag on ROTATED parent (`head` under `chest` rotated 35 deg on `tilt`) -> lands within < 1 px of cursor!
    const rotTargetX = Math.round(afterUnrotTranslate.browPickOnRotatedHead.x + 22);
    const rotTargetY = Math.round(afterUnrotTranslate.browPickOnRotatedHead.y - 16);
    await session.dispatchMouseEvent({
      type: 'mousePressed',
      x: afterUnrotTranslate.browPickOnRotatedHead.x,
      y: afterUnrotTranslate.browPickOnRotatedHead.y,
      button: 'left',
      buttons: 1,
    });
    await session.dispatchMouseEvent({
      type: 'mouseMoved',
      x: Math.round(afterUnrotTranslate.browPickOnRotatedHead.x + 11),
      y: Math.round(afterUnrotTranslate.browPickOnRotatedHead.y - 8),
      button: 'left',
      buttons: 1,
    });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: rotTargetX, y: rotTargetY, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: rotTargetX, y: rotTargetY, button: 'left', buttons: 0 });

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice4b-bone-drag-1440x900.png'), await session.screenshot());
    }

    const slice4bStageResult = await session.evaluate<{
      rotatedParentCursorErrorPx: number;
      stageApplyMaxFroundDiff: number;
      constrainedRefusal: string;
      noTrackRefusal: string;
      readOnlyTrackRefusal: string;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const headAfter = document.querySelector('.animation-bone-pick[data-bone="head"]').getBoundingClientRect();
      const landedX = headAfter.left + headAfter.width / 2;
      const landedY = headAfter.top + headAfter.height / 2;
      const rotatedParentCursorErrorPx =
        Math.round(Math.hypot(landedX - ${rotTargetX}, landedY - ${rotTargetY}) * 1000) / 1000;

      // Verify Apply · Rebuild parity (maxFroundDiff === 0) for the stage-dragged pose
      const scrub = document.getElementById('scrub');
      const seekTo = (t) => {
        scrub.value = String(t);
        scrub.dispatchEvent(new Event('input'));
      };
      const sampleTimes = [0, 0.35, 0.5, 0.8, 1.1];
      const previewSnap = sampleTimes.map((t) => {
        seekTo(t);
        const c = ed.bone('chest');
        const h = ed.bone('head');
        return [Math.fround(h.x), Math.fround(h.y), Math.fround(c.rotationX)];
      });
      await ed.animation.apply();
      let stageApplyMaxFroundDiff = 0;
      for (let i = 0; i < sampleTimes.length; i++) {
        seekTo(sampleTimes[i]);
        const c = ed.bone('chest');
        const h = ed.bone('head');
        const cur = [Math.fround(h.x), Math.fround(h.y), Math.fround(c.rotationX)];
        for (let k = 0; k < cur.length; k++) {
          const diff = Math.abs(previewSnap[i][k] - cur[k]);
          if (diff > stageApplyMaxFroundDiff) stageApplyMaxFroundDiff = diff;
        }
      }
      await ed.animation.reset();

      // Stage bone drag named refusals:
      // 1. Constrained bone ('skirt_c0' driven by 'skirt_phys') -> ANIMATION_BONE_CONSTRAINED
      const rConst = ed.animation.poseBone('skirt_c0', 10, 10, 'rotate');
      const constrainedRefusal = rConst.ok ? '' : rConst.error;
      // 2. Unkeyed bone ('leg_r0' has no track in 'smile') -> ANIMATION_BONE_NO_TRACK
      const rNoTrack = ed.animation.poseBone('leg_r0', 10, 10, 'rotate');
      const noTrackRefusal = rNoTrack.ok ? '' : rNoTrack.error;
      // 3. Read-only track ('sleeve_l0.rotate' has lag on 'tilt') -> ANIMATION_TRACK_READ_ONLY
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 30));
      const rReadOnly = ed.animation.poseBone('sleeve_l0', 10, 10, 'rotate');
      const readOnlyTrackRefusal = rReadOnly.ok ? '' : rReadOnly.error;

      return {
        rotatedParentCursorErrorPx,
        stageApplyMaxFroundDiff,
        constrainedRefusal,
        noTrackRefusal,
        readOnlyTrackRefusal,
      };
    })()`);

    if (
      shiftClickCount3 !== 3 ||
      shiftClickCount2 !== 2 ||
      !activeBoxRect.present ||
      activeBoxRect.width < 3 ||
      activeBoxRect.height < 3 ||
      afterBoxSelect.selectedKeys.length < 4 ||
      afterBoxSelect.hasReadOnlyInSelection ||
      !afterBoxSelect.statusAfterBoxWithReadOnly.includes('ANIMATION_TRACK_READ_ONLY') ||
      !afterBoxSelect.inspectorTitle.includes('keys selected') ||
      afterEmptyLaneClick.selectedCount !== 0 ||
      Math.abs(afterEmptyLaneClick.scrubValue - 0.65) > 0.05 ||
      slice4bDopesheetResult.groupDragOps.length !== 3 ||
      slice4bDopesheetResult.opsCountAfterSingleUndo !== 0 ||
      slice4bDopesheetResult.deleteGroupOpsCount !== 3 ||
      slice4bDopesheetResult.opsCountAfterDeleteUndo !== 0 ||
      !slice4bDopesheetResult.minKeysRefusalError.startsWith('ANIMATION_TRACK_MIN_KEYS:') ||
      slice4bDopesheetResult.groupApplyRebuiltTimes[0] !== 0.4 ||
      slice4bDopesheetResult.groupApplyRebuiltTimes[1] !== 0.55 ||
      afterExistingRotDrag.ops.length !== 1 ||
      afterExistingRotDrag.ops[0].op !== 'set_key_value' ||
      afterExistingRotDrag.rotAfter === stageSetup.rotBeforeExistingDrag ||
      afterExistingRotDrag.opsAfterUndo !== 0 ||
      afterUnkeyedRotDrag.ops.length !== 1 ||
      afterUnkeyedRotDrag.ops[0].op !== 'insert_key' ||
      afterUnkeyedRotDrag.opsAfterSingleUndo !== 0 ||
      afterUnrotTranslate.unrotatedParentCursorErrorPx >= 1 ||
      afterUnrotTranslate.opsAfterUndo !== 0 ||
      slice4bStageResult.rotatedParentCursorErrorPx >= 1 ||
      slice4bStageResult.stageApplyMaxFroundDiff !== 0 ||
      !slice4bStageResult.constrainedRefusal.startsWith('ANIMATION_BONE_CONSTRAINED:') ||
      !slice4bStageResult.noTrackRefusal.startsWith('ANIMATION_BONE_NO_TRACK:') ||
      !slice4bStageResult.readOnlyTrackRefusal.startsWith('ANIMATION_TRACK_READ_ONLY:')
    ) {
      throw new Error(
        `Slice 4b browser verification failed: ${JSON.stringify(
          {
            shiftClickCount3,
            shiftClickCount2,
            activeBoxRect,
            afterBoxSelect,
            afterEmptyLaneClick,
            slice4bDopesheetResult,
            afterExistingRotDrag,
            afterUnkeyedRotDrag,
            afterUnrotTranslate,
            slice4bStageResult,
          },
          null,
          2,
        )}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          slice4a: {
            defect1And4: slice4aPreDrag.defect1And4,
            defect2: {
              gateCode: slice4aPreDrag.defect2LoadingGateCode,
              loadingAttr: slice4aPreDrag.defect2LoadingAttr,
              loadingText: slice4aPreDrag.defect2LoadingText,
            },
            defect3: slice4aPreDrag.defect3,
            curves: {
              easeOp: slice4aPreDrag.curveEaseOp,
              curveHandleLandingErrorPx: slice4aPostDrag.curveHandleLandingErrorPx,
              curveHandleLandedCenter: slice4aPostDrag.curveHandleLandedCenter,
              opsAfterHandleDrag: slice4aPostDrag.opsAfterHandleDrag,
              rotBeforeHandleDrag: slice4aPreDrag.rotBeforeHandleDrag,
              rotAfterHandleDrag: slice4aPostDrag.rotAfterHandleDrag,
              curveApplyMaxFroundDiff: slice4aPostDrag.curveApplyMaxFroundDiff,
              curveReadOnlyBannerVisible: slice4aPostDrag.curveReadOnlyBannerVisible,
            },
          },
          slice4b: {
            shiftClickCount3,
            shiftClickCount2,
            activeBoxRect,
            afterBoxSelect,
            afterEmptyLaneClick,
            dopesheet: slice4bDopesheetResult,
            stageExistingRotateOp: afterExistingRotDrag.ops[0],
            stageUnkeyedRotateOp: afterUnkeyedRotDrag.ops[0],
            unrotatedParentCursorErrorPx: afterUnrotTranslate.unrotatedParentCursorErrorPx,
            rotatedParentHeadDeg: afterUnrotTranslate.headRotDeg,
            rotatedParentCursorErrorPx: slice4bStageResult.rotatedParentCursorErrorPx,
            stageApplyMaxFroundDiff: slice4bStageResult.stageApplyMaxFroundDiff,
            refusals: {
              constrained: slice4bStageResult.constrainedRefusal,
              noTrack: slice4bStageResult.noTrackRefusal,
              readOnlyTrack: slice4bStageResult.readOnlyTrackRefusal,
            },
          },
          slice3bDock1440x900: {
            viewport: `${slice3bDockCheck.viewportWidth}x${slice3bDockCheck.viewportHeight}`,
            windowScrollY: slice3bDockCheck.windowScrollY,
            inspectorScrollTop: slice3bDockCheck.inspectorScrollTop,
            allInViewport: slice3bDockCheck.allInViewport,
            stageRect: slice3bDockCheck.stageRect,
            dockRect: slice3bDockCheck.dockRect,
            visibleLanesAtDefaultHeight: slice3bDockCheck.visibleLanesAtDefaultHeight,
            totalLanesOnTilt: slice3bDockCheck.totalLanesOnTilt,
            axisText: slice3bDockCheck.axisText,
            hasFloat32Noise: slice3bDockCheck.hasFloat32Noise,
          },
          slice3cTabsResult,
          pr257Findings,
          slice3bZeroJitterAndSingleGestureDrag: {
            selectedKeyBefore: preDragSnapshot.selectedKeyBefore,
            selectedAfterDrag: bar1And2Result.selectedAfterDrag,
            jitterAfterDrag: bar1And2Result.jitterAfterDrag,
            jitterAfterValueEdit: bar1And2Result.jitterAfterValueEdit,
          },
          slice3bHelloScrollStickyZoomResize: slice3bHelloResult,
          pr255Findings,
          bar1And2: {
            dragCoalescedOps: bar1And2Result.afterDragOps.length,
            exactTimeVal: bar1And2Result.afterExactTimeOps[0].time,
            inspectorVal: bar1And2Result.afterInspectorValOps[1].value,
            cumulativePendingOps: bar1And2Result.afterDeleteOps.map((o) => o.op),
            previewBadgeText: bar1And2Result.previewBadgeText,
          },
          bar3: {
            sampleTimes: bar3And4Result.sampleTimes,
            comparedBoneFields: bar3And4Result.comparedBoneFields,
            comparedSlotVertices: bar3And4Result.comparedSlotVertices,
            maxFroundDiff: bar3And4Result.maxFroundDiff,
          },
          bar4: {
            firstApplyOpsCount: bar3And4Result.firstApplyOpsCount,
            secondApplyOpsCount: bar3And4Result.secondApplyOps.length,
            secondApplyAnimations: [...new Set(bar3And4Result.secondApplyOps.map((o: any) => o.animation))],
          },
          bar5: {
            tiltEditableTracks: bar5Result.tiltEditableTracks,
            tiltReadOnlyBadgesCount: bar5Result.tiltReadOnlyBadges.length,
            idleGateCode: bar5Result.idleGate.code,
            idleEditableLanes: bar5Result.idleEditableLanes,
          },
          bar6: bar6Note,
          bar7: bar7Result,
          bar8: bar8Result,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
