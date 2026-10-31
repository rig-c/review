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
      if (!track.bone || track.property === 'inherit' || typeof track.lag === 'number') continue;
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
      if (!track.bone || track.property === 'inherit' || typeof track.lag === 'number') continue;
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
    await session.setViewport(1440, 960);
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
      await new Promise((r) => setTimeout(r, 50));
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

      // Switch back to 'tilt'
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      return {
        tiltGate,
        tiltEditableTracks,
        tiltReadOnlyBadges,
        readOnlySelectRefused: readOnlySelectOk === false,
        readOnlyStatusText,
        idleGate,
        idleEditableLanes,
        idleReadOnlyBadges,
      };
    })()`);

    if (!bar5Result.tiltGate.editable || bar5Result.tiltEditableTracks !== 3) {
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

    // Bar 1 & Bar 2: Dopesheet key select, pointer drag in time, inspector channel value edit, add key, delete key
    // First click key 1 on track 0 (head.rotate) and drag it horizontally in the dopesheet
    const key1Coords = await session.evaluate<{ x: number; y: number; laneLeft: number; laneWidth: number }>(`(() => {
      const pane = document.querySelector('[data-inspector-panel="playback"]');
      const mark = document.querySelector('.animation-key[data-source-track="0"][data-key-index="1"]');
      mark.scrollIntoView({ block: 'center' });
      const r = mark.getBoundingClientRect();
      const lane = mark.parentElement.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        laneLeft: lane.left,
        laneWidth: lane.width,
      };
    })()`);

    // Drag key 1 from t=0.35s to ~t=0.45s across two pointermove steps to verify real pointer drag + coalescing
    const targetX1 = key1Coords.laneLeft + (0.42 / 1.6) * key1Coords.laneWidth;
    const targetX2 = key1Coords.laneLeft + (0.45 / 1.6) * key1Coords.laneWidth;
    await session.dispatchMouseEvent({ type: 'mousePressed', x: key1Coords.x, y: key1Coords.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: targetX1, y: key1Coords.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseMoved', x: targetX2, y: key1Coords.y, button: 'left', buttons: 1 });
    await session.dispatchMouseEvent({ type: 'mouseReleased', x: targetX2, y: key1Coords.y, button: 'left', buttons: 0 });

    const bar1And2Result = await session.evaluate<{
      afterDragOps: any[];
      selectedAfterDrag: any;
      afterExactTimeOps: any[];
      afterInspectorValOps: any[];
      afterInsertOps: any[];
      afterDeleteOps: any[];
      previewBadgeVisible: boolean;
      previewBadgeText: string;
    }>(`(async () => {
      const ed = window.rigReviewEditor.animation;
      const afterDragOps = ed.ops();
      const selectedAfterDrag = ed.selectedKey();

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
      const afterDeleteOps = ed.ops();

      const badge = document.querySelector('[data-animation-preview-badge]');
      return {
        afterDragOps,
        selectedAfterDrag,
        afterExactTimeOps,
        afterInspectorValOps,
        afterInsertOps,
        afterDeleteOps,
        previewBadgeVisible: badge ? !badge.hidden : false,
        previewBadgeText: badge?.textContent ?? '',
      };
    })()`);

    if (
      bar1And2Result.afterDragOps.length !== 1 ||
      bar1And2Result.afterDragOps[0].op !== 'set_key_time' ||
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
      throw new Error(`Bar 1 / Bar 2 verification failed: ${JSON.stringify(bar1And2Result, null, 2)}`);
    }

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3-dopesheet-preview.png'), await session.screenshot());
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
          for (const f of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY', 'worldX', 'worldY', 'a', 'b', 'c', 'd']) {
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

    // Bar 8: Producer/compiler refusal verbatim (t > duration -> CE_COMPILE_KEY_AFTER_DURATION) and no client auto-duration
    const bar8Result = await session.evaluate<{
      durationUnchangedAfterEdit: boolean;
      clipDuration: number;
      statusAfterRefusedApply: string;
      stageBuildPreserved: boolean;
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'tilt';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

      const buildBefore = ed.stage().modelHash;
      // Move last key (index 3 after earlier delete/insert) on track 0 past duration 1.6s -> 2.5s
      ed.animation.setKeyTime(0, 4, 2.5);
      // Duration of tilt must remain 1.6s (no auto-duration!)
      const scrubMax = Number(document.getElementById('scrub').max);
      await ed.animation.apply();
      const statusAfterRefusedApply = ed.animation.status();
      const buildAfter = ed.stage().modelHash;

      // Discard the unapplied out-of-bounds edit
      ed.animation.clearPending();

      return {
        durationUnchangedAfterEdit: Math.abs(scrubMax - 1.6) < 1e-6,
        clipDuration: scrubMax,
        statusAfterRefusedApply,
        stageBuildPreserved: buildAfter === buildBefore,
      };
    })()`);

    if (
      !bar8Result.durationUnchangedAfterEdit ||
      !bar8Result.statusAfterRefusedApply.includes('CE_COMPILE_KEY_AFTER_DURATION') ||
      !bar8Result.stageBuildPreserved
    ) {
      throw new Error(`Bar 8 verification failed: ${JSON.stringify(bar8Result, null, 2)}`);
    }

    // Bar 7: U2 measurement (MAX_ANIMATION_OPS = 200 on 'hello': 16 tracks × 115 keys = 1,840 keys)
    const bar7Result = await session.evaluate<{
      totalTracks: number;
      editableTracks: number;
      readOnlyTracks: number;
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
    }>(`(async () => {
      const ed = window.rigReviewEditor;
      // Reset to clean state before measuring on hello
      await ed.animation.reset();
      const animSelect = document.getElementById('animation-select');
      animSelect.value = 'hello';
      animSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 40));

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

      return {
        totalTracks: clss.length,
        editableTracks: editable.length,
        readOnlyTracks: readOnly.length,
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
      };
    })()`);

    if (
      bar7Result.totalTracks !== 16 ||
      bar7Result.editableTracks !== 14 ||
      bar7Result.readOnlyTracks !== 2 ||
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
      bar7Result.opsAfterRefusals !== 0
    ) {
      throw new Error(`Bar 7 verification failed: ${JSON.stringify(bar7Result, null, 2)}`);
    }

    if (screenshotDir) {
      await writeFile(join(screenshotDir, 'slice3-hello-cap-refusal.png'), await session.screenshot());
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
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
