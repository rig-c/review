import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { evaluateBoneLocals, readAnimationInspection } from '../src/animation-inspection.ts';
import {
  animationOpsText,
  applyAnimationOps,
  draftTrackToInspectionTrack,
  MAX_ANIMATION_OPS,
  overlayDraftOnInspection,
  type AnimationSourceOp,
} from '../src/animation-ops.ts';
import { animationPreviewAdjust } from '../web/preview.ts';
import {
  APPLIED_ANIMATION_SCHEMA,
  appliedCheckRefusal,
  appliedSummary,
  parseAppliedContext,
} from '../src/applied-context.ts';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { loadReview } from '../src/manifest.ts';
import { animationId } from '../src/rebuild.ts';
import { startServer } from '../src/server.ts';
import {
  animationAppliedRecord,
  animationOutcomeLine,
  parseApplied,
  recordFor,
  type AnimationJobView,
  type UndoView,
} from '../web/rebuild-client.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Stand-in producer (`@rig-c/parts@2.0.0` + `rig-c@3.0.0`) for hermetic CI tests.
 *
 * What this stand-in proves:
 * - Review's server contract (`POST /api/rebuild` and `/api/compare/:side/rebuild` with `{animation}`),
 *   required `animationsFromHash` verification against the handoff file, cumulative `ops` splicing onto
 *   the handoff `animations_from` text, `ANIMATION_OPS_EMPTY` / `ANIMATION_OPS_NOOP` pre-flight refusals,
 *   deterministic `animationId`, pack-flag forwarding (`--idle-keys`, `--page-edges`, `--pack-shape`),
 *   producer refusal propagation (`CE_COMPILE_KEY_AFTER_DURATION`), H5 channel/handle projection,
 *   and session Undo (both kept-build restore and evicted-build re-execution).
 *
 * What this stand-in cannot prove:
 * - Real `rig-parts rig` merging `config.motion.animations_from` with config-generated idle/physics tracks,
 *   real `rigc build` atlas packing and binary/JSON model compilation, and real `rig-parts check` gates.
 * - Live end-to-end proof against the installed `@rig-c/parts` and `rig-c` binaries on the public
 *   `examples/demo` package is run via `$TMPDIR/run-live-slice2.ts` and `$TMPDIR/run-live-compare.ts`
 *   and recorded in the issue's `slice2-receipt.json`.
 */
const STANDIN_RIG_PARTS = `const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const f = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
if (a[0] === '--version') { console.log('2.0.0'); process.exit(0); }
if (a[0] === 'check') {
  const out = f('--out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'check.json'), JSON.stringify({
    PASS: true,
    gate_spine_html_green: true,
    MESH_CLEAN: { status: 'PASS' }
  }));
  console.log('check: PASS (1 of 1 bar(s) met)');
  process.exit(0);
}
if (a[0] === 'rig') {
  const cfgPath = f('--config');
  const out = f('--out');
  const pageEdges = f('--page-edges') || 'free';
  const packShape = f('--pack-shape') || 'polygon';
  const cfgDir = path.dirname(path.resolve(cfgPath));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const animRel = cfg.motion && cfg.motion.animations_from;
  if (!animRel) {
    console.log('  FAIL  ANIMATION_SOURCE_MISSING: config.motion.animations_from missing');
    console.log('refused: 1 problem(s)');
    process.exit(1);
  }
  const animPath = path.resolve(cfgDir, animRel);
  const animDoc = JSON.parse(fs.readFileSync(animPath, 'utf8'));
  for (const [animName, anim] of Object.entries(animDoc.animations || {})) {
    const dur = anim.duration;
    for (const track of anim.tracks || []) {
      if (!track.bone) continue;
      for (const k of track.keys || []) {
        if (typeof k.t === 'number' && k.t > dur) {
          console.log('  FAIL  RIG_RIGC_GREEN: rigc build --profile rig-play --pack --page-edges ' + pageEdges + ' --pack-shape ' + packShape + ' — exited 1: rigc compile error: motion.json: animation "' + animName + '" bone "' + track.bone + '" ' + track.property + ': key at ' + k.t + 's is past the declared duration ' + dur + 's (see rigc guide CE_COMPILE_KEY_AFTER_DURATION)');
          console.log('refused: 1 problem(s)');
          process.exit(1);
        }
      }
    }
  }
  fs.mkdirSync(out, { recursive: true });
  const bones = [
    { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'brow_r', parent: 'head', x: -5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'brow_l', parent: 'head', x: 5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'mouth', parent: 'head', x: 0, y: -5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l0', parent: 'chest', x: -10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l1', parent: 'sleeve_l0', x: -10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l2', parent: 'sleeve_l1', x: -10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
  ];
  fs.writeFileSync(path.join(out, 'rig.json'), JSON.stringify({ spec: 'rigc-rig/1', bones, slots: [], skins: { default: {} } }, null, 2));
  fs.writeFileSync(path.join(out, 'motion.json'), JSON.stringify(animDoc, null, 2));
  fs.writeFileSync(path.join(out, 'mesh_report.json'), JSON.stringify({ spec: 'rig-parts-mesh-report/1', parts: {} }, null, 2));
  console.log('rig-parts rig: wrote ' + out + ' (page-edges=' + pageEdges + ', pack-shape=' + packShape + ')');
  process.exit(0);
}
process.exit(1);
`;

const STANDIN_RIGC = `const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const f = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const f32 = n => Math.fround(n);
const CHANNELS = {
  rotate: ['value'],
  translate: ['x', 'y'],
  translatex: ['value'],
  translatey: ['value'],
  scale: ['x', 'y'],
  scalex: ['value'],
  scaley: ['value'],
  shear: ['x', 'y'],
  shearx: ['value'],
  sheary: ['value']
};
if (a[0] === 'build') {
  const rig = JSON.parse(fs.readFileSync(f('--rig'), 'utf8'));
  const motion = JSON.parse(fs.readFileSync(f('--motion'), 'utf8'));
  const out = f('--out');
  const pageEdges = f('--page-edges') || 'free';
  const packShape = f('--pack-shape') || 'polygon';
  fs.mkdirSync(out, { recursive: true });
  const easings = motion.easings || {};
  const animations = [];
  for (const [name, anim] of Object.entries(motion.animations || {})) {
    const bonesMap = {};
    for (const track of anim.tracks || []) {
      if (!track.bone || !CHANNELS[track.property] || track.lag !== undefined) continue;
      if ((track.keys || []).some(k => k.derive !== undefined)) continue;
      const fields = CHANNELS[track.property];
      const keys = (track.keys || []).map((k, idx, arr) => {
        const next = arr[idx + 1];
        const entry = { time: f32(k.t) };
        fields.forEach((field, c) => { entry[field] = f32(k.v[c]); });
        if (next) {
          if (k.curve === 'stepped' || k.ease === 'stepped') {
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
    animations.push({ name, duration: f32(anim.duration || 0), bones: animBones, slots: [] });
  }
  const model = {
    spec: 'rigc-compiled/3',
    skeleton: { width: 100, height: 100 },
    pages: [{ name: 'skeleton.png', size: [64, 64] }],
    bones: rig.bones || [],
    slots: [],
    skins: [{ name: 'default', attachments: {} }],
    animations
  };
  fs.writeFileSync(path.join(out, 'skeleton.model.json'), JSON.stringify(model));
  fs.writeFileSync(path.join(out, 'skeleton.png'), 'png');
  console.log('rigc: wrote ' + path.join(out, 'skeleton.model.json') + ' (page-edges=' + pageEdges + ', pack-shape=' + packShape + ')');
  process.exit(0);
}
process.exit(1);
`;

function treeSha256(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        h.update(relative(dir, full));
        h.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

function assertCompiledMatchesDraftUnderH5(
  compiledModel: unknown,
  editedAnimText: string,
  animName: string,
  trackIndex: number,
): void {
  const doc = JSON.parse(editedAnimText) as {
    easings?: Record<string, readonly [number, number, number, number]>;
    animations: Record<
      string,
      {
        tracks: Array<{
          bone: string;
          property: string;
          keys: Array<{ t: number; v: number[]; ease?: string; curve?: number[] | 'stepped' }>;
        }>;
      }
    >;
  };
  const rawTrack = doc.animations[animName]!.tracks[trackIndex]!;
  const expected = draftTrackToInspectionTrack(rawTrack, '/expected', doc.easings);
  const inspection = readAnimationInspection(compiledModel, animName);
  expect(inspection).not.toBeNull();
  const actual = inspection!.tracks.find(
    (t) => t.kind === 'bone' && t.target === rawTrack.bone && t.name === rawTrack.property,
  );
  expect(actual).toBeDefined();
  expect(actual!.keys).toHaveLength(expected.keys.length);
  for (let i = 0; i < expected.keys.length; i++) {
    const ak = actual!.keys[i]!;
    const ek = expected.keys[i]!;
    expect(Math.fround(ak.time)).toBe(Math.fround(ek.time));
    for (const field of ['value', 'x', 'y'] as const) {
      if (ek[field] !== undefined || ak[field] !== undefined) {
        expect(Math.fround(Number(ak[field] ?? 0))).toBe(Math.fround(Number(ek[field] ?? 0)));
      }
    }
    if (ek.curve === 'stepped' || ak.curve === 'stepped') {
      expect(ak.curve).toBe(ek.curve);
    } else if (Array.isArray(ek.curve) || Array.isArray(ak.curve)) {
      expect(Array.isArray(ak.curve)).toBe(true);
      expect((ak.curve as number[]).map((n) => Math.fround(n))).toEqual(
        (ek.curve as number[]).map((n) => Math.fround(n)),
      );
    } else {
      expect(ak.curve).toBeUndefined();
    }
  }
}

function createAnimationApplyFixture(root: string, pkgName = 'pkg'): {
  pkgDir: string;
  configHash: string;
  animationsFromHash: string;
  demoAnimText: string;
} {
  const pkgDir = join(root, pkgName);
  mkdirSync(join(pkgDir, 'out', 'rig'), { recursive: true });
  mkdirSync(join(pkgDir, 'out', 'parts'), { recursive: true });
  const demoAnimText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
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
    { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'brow_r', parent: 'head', x: -5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'brow_l', parent: 'head', x: 5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'mouth', parent: 'head', x: 0, y: -5, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l0', parent: 'chest', x: -10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l1', parent: 'sleeve_l0', x: -10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    { name: 'sleeve_l2', parent: 'sleeve_l1', x: -10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  ];
  writeFileSync(
    join(pkgDir, 'out', 'rig', 'rig.json'),
    JSON.stringify({ spec: 'rigc-rig/1', bones, slots: [], skins: { default: {} } }, null, 2),
  );
  writeFileSync(join(pkgDir, 'out', 'rig', 'motion.json'), JSON.stringify(JSON.parse(demoAnimText), null, 2));
  writeFileSync(
    join(pkgDir, 'out', 'rig', 'mesh_report.json'),
    JSON.stringify({ spec: 'rig-parts-mesh-report/1', parts: {} }, null, 2),
  );
  const motionDoc = JSON.parse(demoAnimText) as {
    easings?: Record<string, readonly [number, number, number, number]>;
    animations: Record<string, { duration?: number; tracks?: Array<{ bone?: string; property: string; keys: Array<{ t: number; v: number[]; curve?: number[] | 'stepped'; ease?: string }> }> }>;
  };
  const f32 = (n: number) => Math.fround(Number(n));
  const keyTime = (n: number) => f32(Math.round(Number(n) * 360000) / 360000);
  const initialAnimations = Object.entries(motionDoc.animations).map(([name, anim]) => {
    const bonesMap: Record<string, Array<{ name: string; keys: unknown[] }>> = {};
    for (const track of anim.tracks ?? []) {
      if (!track.bone) continue;
      const keys = track.keys.map((k, idx) => {
        const entry: Record<string, unknown> = { time: keyTime(k.t) };
        if (track.property === 'translate' || track.property === 'scale' || track.property === 'shear') {
          entry.x = f32(k.v[0]!);
          entry.y = f32(k.v[1]!);
        } else {
          entry.value = f32(k.v[0]!);
        }
        const next = track.keys[idx + 1];
        if (next) {
          if (k.curve === 'stepped') entry.curve = 'stepped';
          else if (Array.isArray(k.curve)) entry.curve = k.curve.map(f32);
          else if (typeof k.ease === 'string' && motionDoc.easings?.[k.ease]) {
            const [hx1, hy1, hx2, hy2] = motionDoc.easings[k.ease]!;
            const dt = next.t - k.t;
            const cArr: number[] = [];
            for (let c = 0; c < k.v.length; c++) {
              const v1 = k.v[c]!, dv = next.v[c]! - v1;
              cArr.push(f32(k.t + dt * hx1), f32(v1 + dv * hy1), f32(k.t + dt * hx2), f32(v1 + dv * hy2));
            }
            entry.curve = cArr;
          }
        }
        return entry;
      });
      (bonesMap[track.bone] ??= []).push({ name: track.property, keys });
    }
    return {
      name,
      duration: f32(anim.duration ?? 0),
      bones: Object.entries(bonesMap).map(([bName, timelines]) => ({ name: bName, timelines })),
      slots: [],
    };
  });
  const initialModel = {
    spec: 'rigc-compiled/3',
    skeleton: { width: 100, height: 100 },
    pages: [{ name: 'skeleton.png', size: [64, 64] }],
    bones,
    slots: [],
    skins: [{ name: 'default', attachments: {} }],
    animations: initialAnimations,
  };
  writeFileSync(join(pkgDir, 'skeleton.model.json'), JSON.stringify(initialModel));
  writeFileSync(join(pkgDir, 'skeleton.png'), 'png');

  return {
    pkgDir,
    configHash: sha256(configText),
    animationsFromHash: sha256(demoAnimText),
    demoAnimText,
  };
}

function installStandinProducer(root: string): void {
  mkdirSync(join(root, 'node_modules', '@rig-c', 'parts', 'bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'rig-c', 'bin'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '@rig-c', 'parts', 'package.json'),
    JSON.stringify({ name: '@rig-c/parts', version: '2.0.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }),
  );
  writeFileSync(join(root, 'node_modules', '@rig-c', 'parts', 'bin', 'rig-parts.cjs'), STANDIN_RIG_PARTS);
  writeFileSync(
    join(root, 'node_modules', 'rig-c', 'package.json'),
    JSON.stringify({ name: 'rig-c', version: '3.0.0', bin: { rigc: './bin/rigc.cjs' } }),
  );
  writeFileSync(join(root, 'node_modules', 'rig-c', 'bin', 'rigc.cjs'), STANDIN_RIGC);
}

test('Slice 2 Apply: retime, delete, insert, value, curve match H5; cumulative second Apply vs control [op2]; kept and evicted Undo restore scratch text and build byte-for-byte; pack flags, no-op, stale hash and t > duration; compare mode isolates sides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-anim-apply-'));
  try {
    installStandinProducer(root);
    const { pkgDir, configHash, animationsFromHash, demoAnimText } = createAnimationApplyFixture(root, 'pkg');
    const stateDir = join(root, 'state');
    const beforePkgTree = treeSha256(pkgDir);

    const pkg = await loadReview(pkgDir);
    const server = await startServer(pkg, { port: 0, stateDir, cwd: root });
    const base = `http://127.0.0.1:${server.port}`;

    try {
      const api = async <T = any>(path: string, body?: unknown): Promise<T> => {
        const res = await fetch(`${base}${path}`, {
          method: body !== undefined ? 'POST' : 'GET',
          headers: { Origin: base, 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return (await res.json()) as T;
      };
      const settle = async (job: AnimationJobView): Promise<AnimationJobView> => {
        let cur = job;
        for (let i = 0; cur.status === 'running' && i < 200; i++) {
          await Bun.sleep(20);
          cur = await api<AnimationJobView>(`/api/rebuild/${cur.id}`);
        }
        return cur;
      };

      // 0. GET /api/rebuild returns animations source status (path, sha256, text) for Slice 3 dopesheet editing
      const rebuildDescribe = await api<{
        animations: { available: boolean; reason: string | null; path: string | null; sha256: string | null; text: string | null };
      }>('/api/rebuild');
      expect(rebuildDescribe.animations.available).toBe(true);
      expect(rebuildDescribe.animations.reason).toBeNull();
      expect(rebuildDescribe.animations.path).toBe('animations.json');
      expect(rebuildDescribe.animations.sha256).toBe(animationsFromHash);
      expect(rebuildDescribe.animations.text).toBe(demoAnimText);

      // 1. Required animationsFromHash validation, stale hash refusal, MAX_ANIMATION_OPS cap, and no-op Apply refusals
      const tooManyOpsReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: {
          configHash,
          animationsFromHash,
          ops: Array.from({ length: MAX_ANIMATION_OPS + 1 }, (_, i) => ({
            op: 'set_key_value' as const,
            animation: 'tilt',
            track: 0,
            key: 1,
            channel: 0,
            value: 5 + i * 0.01,
          })),
        },
      });
      expect(tooManyOpsReply.status).toBe('refused');
      expect(tooManyOpsReply.error).toStartWith('ANIMATION_OPS_TOO_MANY:');
      const missingHashReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: {
          configHash,
          ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 }],
        },
      });
      expect(missingHashReply.status).toBe('refused');
      expect(missingHashReply.error).toStartWith('REBUILD_REQUEST_INVALID:');

      const staleHashReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: {
          configHash,
          animationsFromHash: '0'.repeat(64),
          ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 }],
        },
      });
      expect(staleHashReply.status).toBe('refused');
      expect(staleHashReply.error).toStartWith('REBUILD_ANIMATIONS_STALE:');

      const emptyReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: { configHash, animationsFromHash, ops: [] },
      });
      expect(emptyReply.status).toBe('refused');
      expect(emptyReply.error).toStartWith('ANIMATION_OPS_EMPTY:');

      const sameTimeReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: {
          configHash,
          animationsFromHash,
          ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.35 }],
        },
      });
      expect(sameTimeReply.status).toBe('refused');
      expect(sameTimeReply.error).toStartWith('ANIMATION_OPS_NOOP:');

      const coalescedNoopReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: {
          configHash,
          animationsFromHash,
          ops: [
            { op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.48 },
            { op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.35 },
          ],
        },
      });
      expect(coalescedNoopReply.status).toBe('refused');
      expect(coalescedNoopReply.error).toStartWith('ANIMATION_OPS_NOOP:');
      expect(existsSync(join(stateDir, 'rebuild'))).toBe(false);
      expect(treeSha256(pkgDir)).toBe(beforePkgTree);

      // 2. Out-of-bounds key (t > duration) is refused by name with nothing landed
      const oobJob = await settle(
        await api<AnimationJobView>('/api/rebuild', {
          animation: {
            configHash,
            animationsFromHash,
            ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 4, time: 2.5 }],
          },
        }),
      );
      expect(oobJob.status).toBe('refused');
      expect(oobJob.producerLine).toContain('CE_COMPILE_KEY_AFTER_DURATION');
      expect(existsSync(join(stateDir, 'rebuild', pkg.sourceHash, oobJob.id))).toBe(false);
      expect((await api<{ depth: number }>('/api/rebuild/history')).depth).toBe(0);

      // 3. Each of retime, delete, insert, value, and curve builds a revision matching H5 via readAnimationInspection
      const cases: Array<{ label: string; op: AnimationSourceOp; anim: string; track: number }> = [
        {
          label: 'retime',
          op: { op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 },
          anim: 'tilt',
          track: 0,
        },
        {
          label: 'delete',
          op: { op: 'delete_key', animation: 'tilt', track: 0, key: 2 },
          anim: 'tilt',
          track: 0,
        },
        {
          label: 'insert',
          op: {
            op: 'insert_key',
            animation: 'tilt',
            track: 0,
            time: 0.68,
            value: [6.25],
            curve: [0.75, 6.25, 0.85, 8.5],
          },
          anim: 'tilt',
          track: 0,
        },
        {
          label: 'value',
          op: { op: 'set_key_value', animation: 'hop', track: 2, key: 1, channel: 0, value: 1.08 },
          anim: 'hop',
          track: 2,
        },
        {
          label: 'curve',
          op: { op: 'set_key_curve', animation: 'tilt', track: 0, key: 0, curve: 'stepped' },
          anim: 'tilt',
          track: 0,
        },
      ];

      for (const item of cases) {
        const histBefore = await api<{ depth: number; records: Array<{ id: string }> }>('/api/rebuild/history');
        if (histBefore.depth > 0) {
          await api('/api/rebuild/undo', { from: histBefore.records.at(-1)!.id });
        }
        const job = await settle(
          await api<AnimationJobView>('/api/rebuild', {
            animation: { configHash, animationsFromHash, ops: [item.op] },
          }),
        );
        expect(job.status, item.label).toBe('built');
        expect(job.kind).toBe('animation');
        expect(job.op).toBe('rig');
        expect(job.check?.pass).toBe(true);
        expect(job.id).toBe(
          animationId({
            sourceHash: pkg.sourceHash,
            configHash,
            animationsFromHash,
            opsText: animationOpsText([item.op]),
            producer: '@rig-c/parts@2.0.0',
            compiler: 'rig-c@3.0.0',
          }),
        );

        const expectedText = applyAnimationOps(demoAnimText, [item.op]).text;
        const scratchAnimPath = join(stateDir, 'rebuild', pkg.sourceHash, job.id, 'animations.json');
        expect(readFileSync(scratchAnimPath, 'utf8')).toBe(expectedText);

        const compiledModel = await (await fetch(`${base}${job.build!.modelUrl}`)).json();
        assertCompiledMatchesDraftUnderH5(compiledModel, expectedText, item.anim, item.track);

        // Slice 3 Bar 3: Pending preview pose (overlayDraftOnInspection + animationPreviewAdjust on the base model)
        // matches the post-Apply compiled model's bone locals within Math.fround (0 ULP difference) at all sample times
        const baseModel = JSON.parse(readFileSync(join(pkgDir, 'skeleton.model.json'), 'utf8'));
        const baseInsp = readAnimationInspection(baseModel, item.anim);
        const overlaidInsp = overlayDraftOnInspection(baseInsp, expectedText);
        const compiledInsp = readAnimationInspection(compiledModel, item.anim);
        const previewAdjust = animationPreviewAdjust(
          overlaidInsp,
          new Set(compiledInsp.bones.map((b) => b.name)),
          false,
        )!;
        expect(previewAdjust).toBeFunction();
        for (let stepIdx = 0; stepIdx <= 20; stepIdx++) {
          const sampleT = Number(((stepIdx / 20) * 1.2).toFixed(4));
          const previewBones = new Map(
            baseInsp.bones.map((b) => [
              b.name,
              {
                rotation: b.rotation ?? 0,
                x: b.x ?? 0,
                y: b.y ?? 0,
                scaleX: b.scaleX ?? 1,
                scaleY: b.scaleY ?? 1,
                shearX: b.shearX ?? 0,
                shearY: b.shearY ?? 0,
              },
            ]),
          );
          previewAdjust(
            {
              names: [...previewBones.keys()],
              bone: (name: string) => previewBones.get(name)!,
            },
            { animation: item.anim, trackTime: sampleT, globalTime: sampleT },
          );
          for (const b of compiledInsp.bones) {
            const pLocals = previewBones.get(b.name)!;
            const cLocals = evaluateBoneLocals(compiledInsp, b.name, sampleT);
            for (const ch of ['rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearX', 'shearY'] as const) {
              expect(Math.fround(pLocals[ch]), `${item.label} ${b.name}.${ch} at t=${sampleT}`).toBe(
                Math.fround(cLocals[ch]),
              );
            }
          }
        }

        // Verify AppliedAnimation schema ('rig-review-applied/5') & client helpers
        const record = animationAppliedRecord(job);
        expect(record.schema).toBe(APPLIED_ANIMATION_SCHEMA);
        expect(record.args).toEqual([]);
        expect(recordFor(job)).toEqual(record);
        expect(parseApplied(JSON.stringify(record))).toEqual(record);
        expect(() => parseAppliedContext(record)).not.toThrow();
        expect(appliedSummary(record)).toContain(`(1 op(s) on ${item.anim}; animations.json`);
        expect(appliedCheckRefusal(record)).toBeNull();
        expect(animationOutcomeLine(job).error).toBe(false);
      }

      // Reset stack before testing cumulative 2nd Apply, control [op2], and kept/evicted Undo
      {
        const h = await api<{ depth: number; records: Array<{ id: string }> }>('/api/rebuild/history');
        if (h.depth > 0) await api('/api/rebuild/undo', { from: h.records.at(-1)!.id });
      }

      // 4. Second Apply with cumulative [op1, op2] preserves first; control with [op2] alone builds only second;
      //    Undo restores kept build byte-for-byte, and evicted Undo re-runs pred.body and restores byte-for-byte
      const op1: AnimationSourceOp = { op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 };
      const op2: AnimationSourceOp = {
        op: 'set_key_value',
        animation: 'hop',
        track: 2,
        key: 1,
        channel: 0,
        value: 1.08,
      };

      const job1 = await settle(
        await api<AnimationJobView>('/api/rebuild', {
          animation: { configHash, animationsFromHash, ops: [op1] },
        }),
      );
      expect(job1.status).toBe('built');
      const scratch1Text = readFileSync(join(stateDir, 'rebuild', pkg.sourceHash, job1.id, 'animations.json'), 'utf8');
      const build1Bytes = readFileSync(
        join(stateDir, 'rebuild', pkg.sourceHash, job1.id, 'build', 'skeleton.model.json'),
      );

      // Second Apply sends cumulative ops [op1, op2] against handoff animationsFromHash
      const job2 = await settle(
        await api<AnimationJobView>('/api/rebuild', {
          animation: { configHash, animationsFromHash, ops: [op1, op2] },
        }),
      );
      expect(job2.status).toBe('built');
      expect(job2.request.ops).toEqual([op1, op2]);
      const expectedCombinedText = applyAnimationOps(demoAnimText, [op1, op2]).text;
      const scratch2Text = readFileSync(join(stateDir, 'rebuild', pkg.sourceHash, job2.id, 'animations.json'), 'utf8');
      expect(scratch2Text).toBe(expectedCombinedText);
      const compiledModel2 = await (await fetch(`${base}${job2.build!.modelUrl}`)).json();
      assertCompiledMatchesDraftUnderH5(compiledModel2, expectedCombinedText, 'tilt', 0);
      assertCompiledMatchesDraftUnderH5(compiledModel2, expectedCombinedText, 'hop', 2);

      // Kept Undo from job2 -> restores job1 scratch text and build byte-for-byte
      const undoKept = await api<UndoView>('/api/rebuild/undo', {
        from: job2.id,
      });
      expect(undoKept.status).toBe('built');
      if (undoKept.status === 'built') {
        expect(undoKept.undone).toBe(job2.id);
        expect(undoKept.job.id).toBe(job1.id);
      }
      expect(readFileSync(join(stateDir, 'rebuild', pkg.sourceHash, job1.id, 'animations.json'), 'utf8')).toBe(
        scratch1Text,
      );
      expect(
        readFileSync(join(stateDir, 'rebuild', pkg.sourceHash, job1.id, 'build', 'skeleton.model.json')).equals(
          build1Bytes,
        ),
      ).toBe(true);

      // Control: a request carrying only [op2] builds only the second edit (tilt track 0 stays at base 0.35s, not 0.42s)
      const jobControl = await settle(
        await api<AnimationJobView>('/api/rebuild', {
          animation: { configHash, animationsFromHash, ops: [op2] },
        }),
      );
      expect(jobControl.status).toBe('built');
      expect(jobControl.request.ops).toEqual([op2]);
      const expectedOnlyOp2Text = applyAnimationOps(demoAnimText, [op2]).text;
      const scratchControlText = readFileSync(
        join(stateDir, 'rebuild', pkg.sourceHash, jobControl.id, 'animations.json'),
        'utf8',
      );
      expect(scratchControlText).toBe(expectedOnlyOp2Text);
      expect(scratchControlText).not.toBe(expectedCombinedText);
      const compiledControl = await (await fetch(`${base}${jobControl.build!.modelUrl}`)).json();
      assertCompiledMatchesDraftUnderH5(compiledControl, demoAnimText, 'tilt', 0);
      assertCompiledMatchesDraftUnderH5(compiledControl, expectedOnlyOp2Text, 'hop', 2);

      // Evict job1 from rebuild-kept, then Undo from jobControl -> server re-runs job1's recorded body and restores it byte-for-byte
      const keptJob1Dir = join(stateDir, 'rebuild-kept', pkg.sourceHash, job1.id);
      expect(existsSync(keptJob1Dir)).toBe(true);
      rmSync(keptJob1Dir, { recursive: true, force: true });
      const histWithEvicted = await api<{ records: Array<{ id: string; kept: boolean }> }>('/api/rebuild/history');
      expect(histWithEvicted.records[0]!.id).toBe(job1.id);
      expect(histWithEvicted.records[0]!.kept).toBe(false);

      const undoEvicted = await api<UndoView>('/api/rebuild/undo', { from: jobControl.id });
      expect(undoEvicted.status === 'running' || undoEvicted.status === 'built').toBe(true);
      if (undoEvicted.status === 'running' || undoEvicted.status === 'built') {
        expect(undoEvicted.undone).toBe(jobControl.id);
        const rerunJob1 = await settle(undoEvicted.job as AnimationJobView);
        expect(rerunJob1.id).toBe(job1.id);
        expect(rerunJob1.status).toBe('built');
        expect(readFileSync(join(stateDir, 'rebuild', pkg.sourceHash, job1.id, 'animations.json'), 'utf8')).toBe(
          scratch1Text,
        );
        expect(
          readFileSync(join(stateDir, 'rebuild', pkg.sourceHash, job1.id, 'build', 'skeleton.model.json')).equals(
            build1Bytes,
          ),
        ).toBe(true);
      }

      // Undo from job1 -> returns to inspected build, leaving package byte-identical
      const undoToInspected = await api<{ status: string; undone: string; history: { depth: number } }>(
        '/api/rebuild/undo',
        { from: job1.id },
      );
      expect(undoToInspected.status).toBe('inspected');
      expect(undoToInspected.history.depth).toBe(0);
      expect(treeSha256(pkgDir)).toBe(beforePkgTree);

      // 5. Pack flags (args) are validated against PATCH_FLAGS and forwarded to both rig-parts rig and rigc build
      const badArgsReply = await api<{ status: string; error: string }>('/api/rebuild', {
        animation: {
          configHash,
          animationsFromHash,
          ops: [op1],
          args: ['--unknown-flag', 'val'],
        },
      });
      expect(badArgsReply.status).toBe('refused');
      expect(badArgsReply.error).toStartWith('REBUILD_REQUEST_INVALID:');

      const customFlagsJob = await settle(
        await api<AnimationJobView>('/api/rebuild', {
          animation: {
            configHash,
            animationsFromHash,
            ops: [op1],
            args: ['--page-edges', 'pot', '--pack-shape', 'rect'],
          },
        }),
      );
      expect(customFlagsJob.status).toBe('built');
      expect(customFlagsJob.request.args).toEqual(['--page-edges', 'pot', '--pack-shape', 'rect']);
      expect(customFlagsJob.lines.some((l) => l.includes('page-edges=pot, pack-shape=rect'))).toBe(true);
      const customRecord = animationAppliedRecord(customFlagsJob);
      expect(customRecord.args).toEqual(['--page-edges', 'pot', '--pack-shape', 'rect']);
      expect(parseApplied(JSON.stringify(customRecord))).toEqual(customRecord);
      await api('/api/rebuild/undo', { from: customFlagsJob.id });
    } finally {
      server.stop();
    }

    // 6. Compare mode (/api/compare/a/rebuild) runs on side A and leaves side B untouched
    const sideA = createAnimationApplyFixture(root, 'cmp-a');
    const sideB = createAnimationApplyFixture(root, 'cmp-b');
    const refVideo = join(root, 'ref.mp4');
    writeFileSync(refVideo, 'mp4');
    const cmpState = join(root, 'cmp-state');
    const beforeATree = treeSha256(sideA.pkgDir);
    const beforeBTree = treeSha256(sideB.pkgDir);

    const cmpPkg = await loadCompare({
      a: sideA.pkgDir,
      b: sideB.pkgDir,
      reference: refVideo,
      animation: 'tilt',
    });
    const cmpServer = await startCompareServer(cmpPkg, { port: 0, stateDir: cmpState, cwd: root });
    const cmpBase = `http://127.0.0.1:${cmpServer.port}`;
    try {
      const cmpApi = async <T = any>(path: string, body?: unknown): Promise<T> => {
        const res = await fetch(`${cmpBase}${path}`, {
          method: body !== undefined ? 'POST' : 'GET',
          headers: { Origin: cmpBase, 'Content-Type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return (await res.json()) as T;
      };
      const opA: AnimationSourceOp = { op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 };
      let jobA = await cmpApi<AnimationJobView>('/api/compare/a/rebuild', {
        animation: {
          configHash: sideA.configHash,
          animationsFromHash: sideA.animationsFromHash,
          ops: [opA],
        },
      });
      for (let i = 0; jobA.status === 'running' && i < 200; i++) {
        await Bun.sleep(20);
        jobA = await cmpApi<AnimationJobView>(`/api/compare/a/rebuild/${jobA.id}`);
      }
      expect(jobA.status).toBe('built');
      expect(jobA.build!.modelUrl).toStartWith(`/compare-rebuild/a/${jobA.id}/`);

      const histA = await cmpApi<{ depth: number }>('/api/compare/a/rebuild/history');
      const histB = await cmpApi<{ depth: number }>('/api/compare/b/rebuild/history');
      expect(histA.depth).toBe(1);
      expect(histB.depth).toBe(0);
      expect(existsSync(join(cmpState, 'compare', 'b'))).toBe(false);

      const undoA = await cmpApi<{ status: string }>('/api/compare/a/rebuild/undo', { from: jobA.id });
      expect(undoA.status).toBe('inspected');
      expect(treeSha256(sideA.pkgDir)).toBe(beforeATree);
      expect(treeSha256(sideB.pkgDir)).toBe(beforeBTree);
    } finally {
      cmpServer.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an animations_from alias inside the package applies to its canonical handoff file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-anim-alias-'));
  try {
    installStandinProducer(root);
    const { pkgDir, animationsFromHash, demoAnimText } = createAnimationApplyFixture(root, 'pkg');
    symlinkSync('animations.json', join(pkgDir, 'alias.json'));
    const configText = JSON.stringify({ key: 'demo', motion: { animations_from: 'alias.json' }, meshes: {} }, null, 2) + '\n';
    writeFileSync(join(pkgDir, 'config.json'), configText);

    const pkg = await loadReview(pkgDir);
    const server = await startServer(pkg, { port: 0, stateDir: join(root, 'state'), cwd: root });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const res = await fetch(`${base}/api/rebuild`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          animation: {
            configHash: sha256(configText),
            animationsFromHash,
            ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 }],
          },
        }),
      });
      let job = (await res.json()) as AnimationJobView;
      for (let i = 0; job.status === 'running' && i < 200; i++) {
        await Bun.sleep(20);
        job = (await (await fetch(`${base}/api/rebuild/${job.id}`, { headers: { Origin: base } })).json()) as AnimationJobView;
      }
      expect((job as unknown as { error?: string }).error).toBeUndefined();
      expect(job.status).toBe('built');
      expect(job.request.animationsFrom.path).toBe('animations.json');
      expect(readFileSync(join(pkgDir, 'animations.json'), 'utf8')).toBe(demoAnimText);
    } finally {
      server.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
