import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { loadModel, RigPlayer, type ModelAssets } from '@rig-c/play';
import { commonDomain, compareSeekStep, feedbackTrace, inspectionFrame, seekAfterReference, seekSynchronizedPair, type CompareTrace, type ReferenceSample } from '../src/compare-playhead.ts';

async function fixture(): Promise<ModelAssets> {
  const bytes = await readFile(new URL('./fixtures/compare-probe/skeleton.model.json', import.meta.url), 'utf8');
  // Keep fetch's actual public type/properties; only this fixture's file IO is
  // substituted. The published loader/parser and player/poser run unchanged.
  const fileFetch = new Proxy(fetch, { apply: () => Promise.resolve(new Response(bytes)) });
  return loadModel({ modelUrl: 'http://fixture.invalid/probe.model.json', fetch: fileFetch, setsUrl: null });
}

function player(assets: ModelAssets): RigPlayer {
  // Bone-only fixture has no slots/pages. This is a layout boundary, not a
  // player, bone, time, seek, renderer or core-method mock.
  const root = { style: { clipPath: '' } } as unknown as HTMLElement;
  const value = new RigPlayer(root, assets, { seekStep: compareSeekStep, meshBackend: 'canvas2d' });
  value.environment(null); value.play('inspect', { loop: false }); value.pause(); return value;
}

describe('reference-locked compare playhead', () => {
  test('feedback requires a current successful pair and becomes ineligible after a seek or failure', () => {
    const success: CompareTrace = { reference: .25, a: .25, b: .25, source: 'video-frame' };
    expect(feedbackTrace(false, false, null)).toBeNull();
    expect(feedbackTrace(true, false, success)).toBe(success);
    expect(feedbackTrace(true, true, success)).toBeNull();
    // A failed pair clears its trace and readiness; the previous success cannot
    // supply feedback context even if retained in the diagnostic history.
    expect(feedbackTrace(false, false, null)).toBeNull();
    expect(feedbackTrace(false, false, success)).toBeNull();
    expect(feedbackTrace(true, false, null)).toBeNull();
  });

  test('frame badges interpret the validated reference timestamp, preserving actual runtime ULP separately', () => {
    const mediaTime = 100 / 24;
    const success: CompareTrace = { reference: mediaTime, a: mediaTime - 1e-14, b: mediaTime - 1e-14, source: 'video-frame' };
    expect(inspectionFrame({ kind: 'uniform', fps: 24, frame0: 0, frameCount: 101 }, success)).toBe(100);
    expect(inspectionFrame({ kind: 'samples', frameTimes: [0, mediaTime] }, success)).toBe(1);
    expect(success.a).toBeLessThan(success.reference);
    expect(inspectionFrame(null, success)).toBeNull();
    expect(inspectionFrame({ kind: 'uniform', fps: 24, frame0: 0, frameCount: 101 }, null)).toBeNull();
  });

  test('shared domain is the intersection and never accepts an individual overrun', async () => {
    const assets = await fixture(), a = player(assets), b = player(assets);
    try {
      const domain = commonDomain(2.4, 2, 1.5); expect(domain).toEqual({ start: 0, end: 1.5 });
      expect(() => commonDomain(Infinity, 2, 2)).toThrow('finite');
      expect(() => commonDomain(2, -1, 2)).toThrow('finite');
      expect(() => seekSynchronizedPair({ time: 1.501, source: 'video-frame' }, a, b, domain)).toThrow('outside shared domain');
      expect(a.time).toBe(0); expect(b.time).toBe(0);
      expect(() => seekSynchronizedPair({ time: -.001, source: 'current-time' }, a, b, domain)).toThrow('outside shared domain');
      expect(a.time).toBe(0); expect(b.time).toBe(0);
    } finally { a.dispose(); b.dispose(); assets.dispose(); }
  });

  test('actual public RigPlayers seek equal media times with fresh-control bone poses, including backward/repeated/end samples', async () => {
    const assetsA = await fixture(), assetsB = await fixture(), a = player(assetsA), b = player(assetsB);
    const traces: { reference: number; a: number; b: number; source: string }[] = [];
    try {
      const durationA = assetsA.animations.find(value => value.name === 'inspect')!.duration;
      const durationB = assetsB.animations.find(value => value.name === 'inspect')!.duration;
      const domain = commonDomain(2.4, durationA, durationB);
      const poses = new Map<number, ReturnType<RigPlayer['bone']>>();
      for (const time of [0, .037, 1.001, .25, 1.001, 0, domain.end]) {
        const trace = seekSynchronizedPair({ time, source: 'video-frame' }, a, b, domain); traces.push(trace);
        expect(trace.reference).toBe(time); expect(trace.a).toBeCloseTo(time, 12); expect(trace.b).toBe(trace.a);
        const control = player(assetsA);
        try {
          control.seek(time); control.draw();
          expect(a.bone('probe')).toEqual(control.bone('probe'));
          expect(b.bone('probe')).toEqual(control.bone('probe'));
          expect(a.posedFrame().order).toHaveLength(0);
          const previous = poses.get(time);
          if (previous !== undefined) expect(a.bone('probe')).toEqual(previous);
          poses.set(time, { ...a.bone('probe') });
        } finally { control.dispose(); }
      }
      expect(poses.get(0)).not.toEqual(poses.get(1.001));
      console.log('compare public-runtime traces (reference / a / b):', JSON.stringify(traces));
    } finally { a.dispose(); b.dispose(); assetsA.dispose(); assetsB.dispose(); }
  });

  test('both real players wait for reference seek completion and use decoded mediaTime, not requested time', async () => {
    const assets = await fixture(), a = player(assets), b = player(assets);
    let finish!: (sample: ReferenceSample) => void;
    try {
      const reference = new Promise<ReferenceSample>(resolve => { finish = resolve; });
      const pending = seekAfterReference(.05, () => reference, a, b, commonDomain(2.4, 2, 2));
      await Promise.resolve(); expect(a.time).toBe(0); expect(b.time).toBe(0);
      finish({ time: .037, source: 'video-frame' });
      const trace = await pending; expect(trace.reference).toBe(.037); expect(trace.a).toBeCloseTo(.037, 12); expect(trace.b).toBe(trace.a); expect(trace.source).toBe('video-frame');
      console.log('compare after-seeked decoded-time trace:', JSON.stringify(trace));
    } finally { a.dispose(); b.dispose(); assets.dispose(); }
  });

  test('reference rejection and a real player seek refusal produce no successful pair', async () => {
    const assets = await fixture(), a = player(assets), b = player(assets);
    try {
      await expect(seekAfterReference(.2, () => Promise.reject(new Error('video seek failed')), a, b, commonDomain(2, 2, 2))).rejects.toThrow('video seek failed');
      expect(a.time).toBe(0); expect(b.time).toBe(0);
      b.play('inspect', { track: 1, loop: false });
      expect(b.composed).toBe(true);
      expect(() => seekSynchronizedPair({ time: .2, source: 'video-frame' }, a, b, commonDomain(2, 2, 2))).toThrow('seek');
    } finally { a.dispose(); b.dispose(); assets.dispose(); }
  });
});
