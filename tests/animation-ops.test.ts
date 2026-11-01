import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CHANNELS,
  evaluateBoneLocals,
  type AnimationInspection,
} from '../src/animation-inspection.ts';
import {
  AnimationOpBuilder,
  applyAnimationOp,
  applyAnimationOps,
  checkAnimationEditGate,
  classifyAnimationTracks,
  cleanMotionNumber,
  draftTrackToInspectionTrack,
  findBoneConstraint,
  jsonValueSpan,
  MAX_ANIMATION_OPS,
  overlayDraftOnInspection,
  retimeCurveX,
  seedCubicCurve,
  translateCurveY,
} from '../src/animation-ops.ts';
import { animationPreviewAdjust } from '../web/preview.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const PUBLIC_MOTION_FIXTURES = [
  {
    name: 'tests/fixtures/motion/demo.json',
    url: new URL('./fixtures/motion/demo.json', import.meta.url),
    expectedBytes: 12405,
    expectedSha256: '06cd485f2b8a2a3ecd998578a40ab7c89017c85120bc801bf802bf7cb452e321',
  },
  {
    name: 'tests/fixtures/motion/scarf.json',
    url: new URL('./fixtures/motion/scarf.json', import.meta.url),
    expectedBytes: 12408,
    expectedSha256: '6871fbda0ca807ad9329d0cc8087135a6f3d825b27a99569757b10ee84e2f66d',
  },
  {
    name: 'tests/fixtures/motion/reference-sample.json',
    url: new URL('./fixtures/motion/reference-sample.json', import.meta.url),
    expectedBytes: 486,
    expectedSha256: '7cc99657a0f98c566a8c127cb1b04fe85bf590fe1f81c9834aea589557ef8f58',
  },
  {
    name: 'tests/fixtures/motion/hello.anim.json',
    url: new URL('./fixtures/motion/hello.anim.json', import.meta.url),
    expectedBytes: 43193,
    expectedSha256: 'd3cf89e7f0a7a94a080e0f0cd4fd50aee2ff0fb00935af6bbbecf318e6edcbec',
  },
] as const;

function loadPublicMotionFiles(): Array<{
  name: string;
  text: string;
  expectedBytes: number;
  expectedSha256: string;
}> {
  return PUBLIC_MOTION_FIXTURES.map((fixture) => ({
    name: fixture.name,
    text: readFileSync(fixture.url, 'utf8'),
    expectedBytes: fixture.expectedBytes,
    expectedSha256: fixture.expectedSha256,
  }));
}

test('round-trip, edit-and-revert, and inverse op chains are byte-identical across all 4 public files', () => {
  const files = loadPublicMotionFiles();
  expect(files).toHaveLength(4);

  for (const file of files) {
    expect(Buffer.byteLength(file.text, 'utf8')).toBe(file.expectedBytes);
    expect(sha256(file.text)).toBe(file.expectedSha256);

    // 1. Unedited round-trip
    const unedited = applyAnimationOps(file.text, []);
    expect(unedited.text).toBe(file.text);
    expect(unedited.changedSpans).toEqual([]);
    expect(sha256(unedited.text)).toBe(file.expectedSha256);

    const doc = JSON.parse(file.text) as {
      animations: Record<
        string,
        {
          duration: number;
          tracks: Array<{
            bone?: string;
            property: string;
            keys: Array<{ t: number; v: number[]; curve?: number[] | 'stepped'; ease?: string }>;
          }>;
        }
      >;
    };

    for (const [animName, anim] of Object.entries(doc.animations)) {
      const classifications = classifyAnimationTracks(doc, animName);
      for (const cls of classifications) {
        if (!cls.editable) continue;
        const track = anim.tracks[cls.trackIndex]!;
        const keys = track.keys;
        const kIdx = Math.min(1, keys.length - 1);
        const key = keys[kIdx]!;
        const prevT = kIdx > 0 ? keys[kIdx - 1]!.t : 0;
        const nextT = kIdx + 1 < keys.length ? keys[kIdx + 1]!.t : key.t + 0.5;
        const midT = cleanMotionNumber(((kIdx > 0 ? prevT : key.t) + nextT) / 2);

        // 2. set_key_time + inverse set_key_time
        if (midT > prevT && (kIdx + 1 >= keys.length || midT < nextT) && midT !== key.t) {
          const retimed = applyAnimationOps(file.text, [
            { op: 'set_key_time', animation: animName, track: cls.trackIndex, key: kIdx, time: midT },
            { op: 'set_key_time', animation: animName, track: cls.trackIndex, key: kIdx, time: key.t },
          ]);
          expect(sha256(retimed.text), `${file.name} ${animName}#${cls.trackIndex} time inverse`).toBe(
            file.expectedSha256,
          );
        }

        // 3. set_key_value (fractional delta +2.5) + inverse set_key_value
        const shiftedV = key.v.map((v) => cleanMotionNumber(v + 2.5));
        const revalued = applyAnimationOps(file.text, [
          { op: 'set_key_value', animation: animName, track: cls.trackIndex, key: kIdx, value: shiftedV },
          { op: 'set_key_value', animation: animName, track: cls.trackIndex, key: kIdx, value: key.v },
        ]);
        expect(sha256(revalued.text), `${file.name} ${animName}#${cls.trackIndex} value inverse`).toBe(
          file.expectedSha256,
        );

        // 4. set_key_curve + inverse set_key_curve on key 0
        if (keys.length >= 2) {
          const k0 = keys[0]!;
          const k1 = keys[1]!;
          const seeded = seedCubicCurve(k0.t, k0.v, k1.t, k1.v);
          const origCurve = k0.curve ?? null;
          const recurved = applyAnimationOps(file.text, [
            { op: 'set_key_curve', animation: animName, track: cls.trackIndex, key: 0, curve: 'stepped' },
            { op: 'set_key_curve', animation: animName, track: cls.trackIndex, key: 0, curve: seeded },
            { op: 'set_key_curve', animation: animName, track: cls.trackIndex, key: 0, curve: origCurve },
          ]);
          expect(sha256(recurved.text), `${file.name} ${animName}#${cls.trackIndex} curve inverse`).toBe(
            file.expectedSha256,
          );
        }

        // 5. insert_key + inverse delete_key
        if (keys.length >= 2) {
          const insT = cleanMotionNumber((keys[0]!.t + keys[1]!.t) / 2);
          if (insT > keys[0]!.t && insT < keys[1]!.t) {
            const insDel = applyAnimationOps(file.text, [
              {
                op: 'insert_key',
                animation: animName,
                track: cls.trackIndex,
                time: insT,
                value: keys[0]!.v,
              },
              {
                op: 'delete_key',
                animation: animName,
                track: cls.trackIndex,
                key: 1,
              },
            ]);
            expect(sha256(insDel.text), `${file.name} ${animName}#${cls.trackIndex} insert/delete`).toBe(
              file.expectedSha256,
            );
          }
        }

        // 6. OpBuilder multi-step undo & revert
        const builder = new AnimationOpBuilder(file.text);
        expect(builder.dirty).toBe(false);
        builder.apply({
          op: 'set_key_value',
          animation: animName,
          track: cls.trackIndex,
          key: kIdx,
          channel: 0,
          value: cleanMotionNumber(key.v[0]! - 3.25),
        });
        expect(builder.dirty).toBe(true);
        const afterFirst = builder.text;
        expect(afterFirst).not.toBe(file.text);

        if (keys.length >= 2) {
          builder.apply({
            op: 'set_key_curve',
            animation: animName,
            track: cls.trackIndex,
            key: 0,
            curve: 'stepped',
          });
          expect(builder.ops).toHaveLength(2);
          expect(builder.undo()).toBe(true);
          expect(builder.text).toBe(afterFirst);
        }
        expect(builder.undo()).toBe(true);
        expect(builder.dirty).toBe(false);
        expect(sha256(builder.text)).toBe(file.expectedSha256);

        builder.apply({
          op: 'set_key_value',
          animation: animName,
          track: cls.trackIndex,
          key: 0,
          value: keys[0]!.v.map((v) => v + 10),
        });
        expect(sha256(builder.revert())).toBe(file.expectedSha256);
      }
    }
  }
});

test('ops touch only their target spans: all bytes outside the edited key/curve span remain untouched', () => {
  const fixture = `{
  "spec": "rigc-motion/1",
  "note": "top-level generator note — must remain untouched",
  "easings": {
    "quadOut": [0.25, 0.46, 0.45, 0.94]
  },
  "animations": {
    "untouched_before": {
      "duration": 1.0,
      "loop": false,
      "tracks": [
        {"bone": "head", "property": "rotate", "keys": [{"t": 0.0, "v": [0.0]}, {"t": 1.0, "v": [5.0]}]}
      ]
    },
    "target_clip": {
      "duration": 1.4,
      "loop": false,
      "note": "clip note with trailing 1.0 formatting",
      "tracks": [
        {
          "bone": "brow_r",
          "property": "translate",
          "keys": [
            {"t": 0, "v": [0.0, 1.0], "curve": [0.0625, 0.0, 0.1875, 4.0, 0.0625, 1.0, 0.1875, 2.0]},
            {"t": 0.25, "v": [4.0, 2.0], "curve": [0.45, 4.0, 0.85, 4.0, 0.45, 2.0, 0.85, 2.0]},
            {"t": 1.05, "v": [4.0, 2.0]}
          ]
        }
      ]
    },
    "untouched_after": {
      "duration": 2.0,
      "loop": true,
      "tracks": [
        {"bone": "neck", "property": "rotate", "keys": [{"t": 0, "v": [0]}, {"t": 2.0, "v": [0]}]}
      ]
    }
  }
}
`;

  // 1. set_key_time on key 1 touches ONLY key 0's cx1/cx2, key 1's t, and key 1's cx1/cx2.
  // Key 0's cy1/cy2 ("0.0", "4.0", "1.0", "2.0") and key 1's v ("[4.0, 2.0]") must not be touched!
  const k0CurveBefore = jsonValueSpan(fixture, [
    'animations',
    'target_clip',
    'tracks',
    0,
    'keys',
    0,
    'curve',
  ])!;
  const k1CurveBefore = jsonValueSpan(fixture, [
    'animations',
    'target_clip',
    'tracks',
    0,
    'keys',
    1,
    'curve',
  ])!;

  const timeRes = applyAnimationOp(fixture, {
    op: 'set_key_time',
    animation: 'target_clip',
    track: 0,
    key: 1,
    time: 0.5,
  });

  const k1CurveAfter = jsonValueSpan(timeRes.text, [
    'animations',
    'target_clip',
    'tracks',
    0,
    'keys',
    1,
    'curve',
  ])!;

  // Prefix before key 0's curve and suffix after key 1's curve are 100% identical
  expect(timeRes.text.slice(0, k0CurveBefore.start)).toBe(fixture.slice(0, k0CurveBefore.start));
  expect(timeRes.text.slice(k1CurveAfter.end)).toBe(fixture.slice(k1CurveBefore.end));
  // Inside key 1, "v": [4.0, 2.0] and cy values "4.0", "2.0" remain untouched with their .0 formatting
  expect(timeRes.text).toContain('"v": [4.0, 2.0]');
  expect(timeRes.text).toContain('0.0, 0.375, 4.0');

  // 2. set_key_value on key 1 channel 0 only touches key 1's v[0], key 1's curve[1] (cy1_0),
  // and key 0's curve[3] (cy2_0). Channel 1 (v[1] = 2.0 and curve indices 4..7) is untouched!
  const valRes = applyAnimationOp(fixture, {
    op: 'set_key_value',
    animation: 'target_clip',
    track: 0,
    key: 1,
    channel: 0,
    value: 7.5,
  });
  expect(valRes.changedSpans).toHaveLength(3); // k0.curve[3], k1.v[0], k1.curve[1]
  const parsedAfterVal = JSON.parse(valRes.text);
  const editedKeys = parsedAfterVal.animations.target_clip.tracks[0].keys;
  expect(editedKeys[0].curve).toEqual([0.0625, 0, 0.1875, 7.5, 0.0625, 1, 0.1875, 2]);
  expect(editedKeys[1].v).toEqual([7.5, 2]);
  expect(editedKeys[1].curve).toEqual([0.45, 7.5, 0.85, 4, 0.45, 2, 0.85, 2]);
});

test('the two curve laws are independent, clamp-free, and commute under composition', () => {
  // Law 1: identity when endpoints do not move, and no clamp when control points overshoot [t0, t1]
  const overshootCurve = [-0.05, 10, 0.35, -20, 0.02, 5, 0.28, 15];
  expect(retimeCurveX(overshootCurve, 2, 0, 0.25, 0, 0.25)).toEqual(overshootCurve);

  const retimed = retimeCurveX(overshootCurve, 2, 0, 0.25, 0.1, 0.6);
  // u1_0 = -0.05 / 0.25 = -0.2 -> 0.1 + (-0.2)*0.5 = 0 (unclamped relative to [0.1, 0.6])
  // u2_0 = 0.35 / 0.25 = 1.4 -> 0.1 + 1.4*0.5 = 0.8 (> 0.6, unclamped!)
  expect(retimed[0]).toBe(0);
  expect(retimed[2]).toBe(0.8);
  // cy values are untouched
  expect(retimed[1]).toBe(10);
  expect(retimed[3]).toBe(-20);
  expect(retimed[5]).toBe(5);
  expect(retimed[7]).toBe(15);

  const restored = retimeCurveX(retimed, 2, 0.1, 0.6, 0, 0.25);
  expect(restored).toEqual(overshootCurve);

  // Law 2: outgoing shifts only cy1 (4*c + 1), incoming shifts only cy2 (4*c + 3); cx untouched
  const outShifted = translateCurveY(overshootCurve, 2, 'outgoing', [3.5, -1.5]);
  expect(outShifted).toEqual([-0.05, 13.5, 0.35, -20, 0.02, 3.5, 0.28, 15]);
  const inShifted = translateCurveY(overshootCurve, 2, 'incoming', [3.5, -1.5]);
  expect(inShifted).toEqual([-0.05, 10, 0.35, -16.5, 0.02, 5, 0.28, 13.5]);

  // Commutativity of Law 1 (set_key_time) and Law 2 (set_key_value) on demo.json
  const baseText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
  const animName = 'smile';

  const timeOp = {
    op: 'set_key_time' as const,
    animation: animName,
    track: 0,
    key: 1,
    time: 0.21,
  };
  const valueOp = {
    op: 'set_key_value' as const,
    animation: animName,
    track: 0,
    key: 1,
    channel: 0,
    value: 12.75,
  };

  const timeThenValue = applyAnimationOps(baseText, [timeOp, valueOp]);
  const valueThenTime = applyAnimationOps(baseText, [valueOp, timeOp]);
  expect(timeThenValue.text).toBe(valueThenTime.text);
  expect(sha256(timeThenValue.text)).toBe(sha256(valueThenTime.text));
});

test('generated fixtures verify ease XOR curve (Rule R6), stepped curve vs ease refusal, last-key refusals, read-only track refusals, and duration invariance', () => {
  const generated = JSON.stringify(
    {
      spec: 'rigc-motion/1',
      note: 'generated fixture for all track families and easing transitions',
      easings: {
        quadIn: [0.55, 0.085, 0.68, 0.53],
        quadOut: [0.25, 0.46, 0.45, 0.94],
        sineInOut: [0.445, 0.05, 0.55, 0.95],
      },
      animations: {
        test_clip: {
          duration: 1.0,
          loop: false,
          tracks: [
            {
              bone: 'head',
              property: 'rotate',
              keys: [
                { t: 0, v: [0], ease: 'quadOut' },
                { t: 0.5, v: [15], curve: [0.65, 15, 0.85, 0] },
                { t: 1.0, v: [0] },
              ],
            },
            {
              bone: 'head',
              property: 'inherit',
              keys: [{ t: 0, v: 'noScale' }],
            },
            {
              bone: 'eye_l',
              property: 'translatex',
              keys: [
                { t: 0, derive: { kind: 'turn', degrees: -15, depth: 4 } },
                { t: 1.0, derive: { kind: 'turn', degrees: 15, depth: 4 } },
              ],
            },
            {
              bone: 'hair_0',
              property: 'rotate',
              lag: 0.05,
              keys: [
                { t: 0, v: [0] },
                { t: 1.0, v: [5] },
              ],
            },
            {
              slot: 'mouth',
              property: 'attachment',
              keys: [
                { t: 0, v: 'smile' },
                { t: 0.5, v: 'open' },
              ],
            },
            {
              group: 'brows',
              property: 'translatey',
              keys: [
                { t: 0, v: [0] },
                { t: 1.0, v: [3] },
              ],
            },
            {
              physics: 'hair_phys',
              property: 'wind',
              keys: [
                { t: 0, v: [0] },
                { t: 1.0, v: [2] },
              ],
            },
            {
              path: 'ribbon_path',
              property: 'position',
              keys: [
                { t: 0, v: [0] },
                { t: 1.0, v: [1] },
              ],
            },
            {
              slider: 'head_turn',
              property: 'time',
              keys: [
                { t: 0, v: [0] },
                { t: 1.0, v: [1] },
              ],
            },
          ],
        },
      },
    },
    null,
    2,
  );

  // 1. Gate checks
  expect(checkAnimationEditGate('idle', 'animations.json').code).toBe(
    'ANIMATION_IDLE_GOVERNED_BY_TURN_PAD',
  );
  expect(checkAnimationEditGate('test_clip', null).code).toBe('ANIMATION_SOURCE_MISSING');
  const gate = checkAnimationEditGate('test_clip', 'animations.json', JSON.parse(generated));
  expect(gate.editable).toBe(true);
  expect(gate.note).toContain('generated fixture');

  // 2. Track classification: only track 0 (bone head.rotate) is editable
  const classes = classifyAnimationTracks(JSON.parse(generated), 'test_clip');
  expect(classes).toHaveLength(9);
  expect(classes[0]!.editable).toBe(true);
  for (let i = 1; i < classes.length; i++) {
    expect(classes[i]!.editable).toBe(false);
    expect(classes[i]!.reason).toBeTruthy();
    expect(() =>
      applyAnimationOp(generated, {
        op: 'set_key_time',
        animation: 'test_clip',
        track: i,
        key: 0,
        time: 0.1,
      }),
    ).toThrow('ANIMATION_TRACK_READ_ONLY');
  }

  // 3. Rule R6: ease -> curve -> ease -> revert is byte-identical and never writes both
  const seeded0 = seedCubicCurve(0, [0], 0.5, [15]);
  const toCurve = applyAnimationOp(generated, {
    op: 'set_key_curve',
    animation: 'test_clip',
    track: 0,
    key: 0,
    curve: seeded0,
  });
  const key0AfterCurve = JSON.parse(toCurve.text).animations.test_clip.tracks[0].keys[0];
  expect(key0AfterCurve.ease).toBeUndefined();
  expect(key0AfterCurve.curve).toEqual(seeded0);

  const backToEase = applyAnimationOp(toCurve.text, {
    op: 'set_key_ease',
    animation: 'test_clip',
    track: 0,
    key: 0,
    ease: 'quadOut',
  });
  expect(backToEase.text).toBe(generated);
  expect(sha256(backToEase.text)).toBe(sha256(generated));

  // 3b. ease: "stepped" is refused on set_key_ease and insert_key (use curve: "stepped")
  expect(() =>
    applyAnimationOp(generated, {
      op: 'set_key_ease',
      animation: 'test_clip',
      track: 0,
      key: 0,
      ease: 'stepped',
    }),
  ).toThrow('ANIMATION_EASING_STEPPED_USE_CURVE');
  expect(() =>
    applyAnimationOp(generated, {
      op: 'insert_key',
      animation: 'test_clip',
      track: 0,
      time: 0.25,
      value: [5],
      ease: 'stepped',
    }),
  ).toThrow('ANIMATION_EASING_STEPPED_USE_CURVE');

  // 4. Last-key easing/curve refusals + automatic strip when deleting last key
  expect(() =>
    applyAnimationOp(generated, {
      op: 'set_key_curve',
      animation: 'test_clip',
      track: 0,
      key: 2,
      curve: 'stepped',
    }),
  ).toThrow('ANIMATION_LAST_KEY_CURVE');
  expect(() =>
    applyAnimationOp(generated, {
      op: 'set_key_ease',
      animation: 'test_clip',
      track: 0,
      key: 2,
      ease: 'quadIn',
    }),
  ).toThrow('ANIMATION_LAST_KEY_EASING');

  const afterDeleteLast = applyAnimationOp(generated, {
    op: 'delete_key',
    animation: 'test_clip',
    track: 0,
    key: 2,
  });
  const remainingKeys = JSON.parse(afterDeleteLast.text).animations.test_clip.tracks[0].keys;
  expect(remainingKeys).toHaveLength(2);
  expect(remainingKeys[1].curve).toBeUndefined();
  expect(remainingKeys[1].ease).toBeUndefined();

  // 5. Key order refusals and Ruling U4 (moving last key past duration is allowed in source op without mutating duration)
  expect(() =>
    applyAnimationOp(generated, {
      op: 'set_key_time',
      animation: 'test_clip',
      track: 0,
      key: 1,
      time: 1.0,
    }),
  ).toThrow('ANIMATION_KEY_ORDER');

  const pastDuration = applyAnimationOp(generated, {
    op: 'set_key_time',
    animation: 'test_clip',
    track: 0,
    key: 2,
    time: 1.25,
  });
  const parsedPast = JSON.parse(pastDuration.text).animations.test_clip;
  expect(parsedPast.duration).toBe(1.0);
  expect(parsedPast.tracks[0].keys[2].t).toBe(1.25);
});

test('pending preview adapter projects draft tracks into InspectionTrack for evaluateStoredChannel and evaluateBoneLocals', () => {
  const easings = {
    quadOut: [0.25, 0.46, 0.45, 0.94] as const,
  };
  const baseInspection: AnimationInspection = {
    name: 'wave',
    duration: 1.0,
    bones: [
      { name: 'root' },
      { name: 'arm', parent: 'root', rotation: 10, x: 5, y: -2, scaleX: 1, scaleY: 1 },
    ],
    slots: [],
    tracks: [
      draftTrackToInspectionTrack(
        {
          bone: 'arm',
          property: 'rotate',
          keys: [
            { t: 0, v: [0] },
            { t: 1.0, v: [30] },
          ],
        },
        '/animations/0/bones/0/timelines/0',
        easings,
      ),
    ],
  };

  expect(evaluateBoneLocals(baseInspection, 'arm', 0.5).rotation).toBe(25); // 10 setup + 15 linear

  const draftMotion = JSON.stringify({
    spec: 'rigc-motion/1',
    easings,
    animations: {
      wave: {
        duration: 1.0,
        tracks: [
          {
            bone: 'arm',
            property: 'rotate',
            keys: [
              { t: 0, v: [0], curve: 'stepped' },
              { t: 1.0, v: [30] },
            ],
          },
          {
            bone: 'arm',
            property: 'translate',
            keys: [
              { t: 0, v: [0, 0], ease: 'quadOut' },
              { t: 1.0, v: [20, -10] },
            ],
          },
        ],
      },
    },
  });

  const overlaid = overlayDraftOnInspection(baseInspection, draftMotion);
  expect(overlaid.tracks).toHaveLength(2);
  // Stepped rotation holds 0 at t=0.5 -> setup 10 + 0 = 10
  expect(evaluateBoneLocals(overlaid, 'arm', 0.5).rotation).toBe(10);
  // Ease quadOut on translate is faster than linear at t=0.5 (> 10 on x, < -5 on y)
  const localsMid = evaluateBoneLocals(overlaid, 'arm', 0.5);
  expect(localsMid.x).toBeGreaterThan(5 + 10);
  expect(localsMid.y).toBeLessThan(-2 - 5);
  // Endpoints match exactly
  const localsEnd = evaluateBoneLocals(overlaid, 'arm', 1.0);
  expect(localsEnd.rotation).toBe(40);
  expect(localsEnd.x).toBe(25);
  expect(localsEnd.y).toBe(-12);
  expect(Object.keys(CHANNELS)).toHaveLength(10);
});

test('a number past twelve significant digits survives a retime that does not change it, and retiming back restores the bytes', () => {
  const text = `{
  "spec": "rigc-motion/1",
  "animations": {
    "a": {
      "duration": 3,
      "loop": false,
      "tracks": [
        {
          "bone": "b",
          "property": "rotate",
          "keys": [
            {"t": 0, "v": [0], "curve": [0.2, 0.123456789012345, 0.8, 0.987654321098765]},
            {"t": 1, "v": [1], "curve": [1.5, 1, 2.5, 2]},
            {"t": 3, "v": [2]}
          ]
        }
      ]
    }
  }
}
`;
  const retime = (time: number) => ({ op: 'set_key_time' as const, animation: 'a', track: 0, key: 1, time });
  const moved = applyAnimationOps(text, [retime(2)]).text;
  expect(moved).toContain('0.123456789012345');
  expect(moved).toContain('0.987654321098765');
  expect(sha256(applyAnimationOps(text, [retime(2), retime(1)]).text)).toBe(sha256(text));
});

test('AnimationOpBuilder coalesces consecutive set_key_time and set_key_value on the same key, replays from before the first, and drops ops returning to base with >12-digit handles', () => {
  const text = `{
  "spec": "rigc-motion/1",
  "animations": {
    "a": {
      "duration": 3,
      "loop": false,
      "tracks": [
        {
          "bone": "b",
          "property": "translate",
          "keys": [
            {"t": 0, "v": [0, 0], "curve": [0.212345678901234, 0.123456789012345, 0.876543210987654, 0.987654321098765, 0.312345678901234, 1.123456789012345, 0.776543210987654, 2.987654321098765]},
            {"t": 1, "v": [1, 2], "curve": [1.512345678901234, 1.111111111111111, 2.512345678901234, 2.222222222222222, 1.612345678901234, 2.111111111111111, 2.612345678901234, 3.222222222222222]},
            {"t": 3, "v": [2, 4]}
          ]
        }
      ]
    }
  }
}
`;
  const baseHash = sha256(text);
  const builder = new AnimationOpBuilder(text);

  // 1. Consecutive set_key_time on key 1: 1 -> 1.7 -> 2.1 replaces the first op and replays from before it
  builder.apply({ op: 'set_key_time', animation: 'a', track: 0, key: 1, time: 1.7 });
  expect(builder.ops).toHaveLength(1);
  builder.apply({ op: 'set_key_time', animation: 'a', track: 0, key: 1, time: 2.1 });
  expect(builder.ops).toEqual([{ op: 'set_key_time', animation: 'a', track: 0, key: 1, time: 2.1 }]);
  expect(builder.text).toBe(
    applyAnimationOp(text, { op: 'set_key_time', animation: 'a', track: 0, key: 1, time: 2.1 }, text).text,
  );

  // Dragging back to original time 1 drops the op and restores >12-digit cx handles byte-identically
  builder.apply({ op: 'set_key_time', animation: 'a', track: 0, key: 1, time: 1 });
  expect(builder.ops).toEqual([]);
  expect(builder.dirty).toBe(false);
  expect(builder.text).toBe(text);
  expect(sha256(builder.text)).toBe(baseHash);

  // 2. Consecutive set_key_value on key 1: dragging value away and back drops the op and restores >12-digit cy handles
  builder.apply({ op: 'set_key_value', animation: 'a', track: 0, key: 1, channel: 0, value: 4.3 });
  expect(builder.ops).toHaveLength(1);
  builder.apply({ op: 'set_key_value', animation: 'a', track: 0, key: 1, channel: 0, value: 6.7 });
  expect(builder.ops).toEqual([{ op: 'set_key_value', animation: 'a', track: 0, key: 1, channel: 0, value: 6.7 }]);
  builder.apply({ op: 'set_key_value', animation: 'a', track: 0, key: 1, channel: 0, value: 1 });
  expect(builder.ops).toEqual([]);
  expect(builder.dirty).toBe(false);
  expect(builder.text).toBe(text);
  expect(sha256(builder.text)).toBe(baseHash);

  // 3. Multi-channel set_key_value coalescing on the same key across channels 0 and 1, then returning to [1, 2]
  builder.apply({ op: 'set_key_value', animation: 'a', track: 0, key: 1, channel: 0, value: 5 });
  builder.apply({ op: 'set_key_value', animation: 'a', track: 0, key: 1, channel: 1, value: 9 });
  expect(builder.ops).toEqual([{ op: 'set_key_value', animation: 'a', track: 0, key: 1, value: [5, 9] }]);
  builder.apply({ op: 'set_key_value', animation: 'a', track: 0, key: 1, value: [1, 2] });
  expect(builder.ops).toEqual([]);
  expect(builder.dirty).toBe(false);
  expect(sha256(builder.text)).toBe(baseHash);
});

test('MAX_ANIMATION_OPS = 200 cap and moveSelection on a 16-track × 115-key (1,840-key) hello clip refuse >200 keys atomically', () => {
  expect(MAX_ANIMATION_OPS).toBe(200);
  // Build a 16-track × 115-key = 1,840-key motion fixture (same dimensions as hello.anim.json: 14 bone tracks + 2 group tracks at indices 3 and 4, 115 keys each, no curves)
  const makeKeys = (dim: 1 | 2) =>
    Array.from({ length: 115 }, (_, k) => ({
      t: Number((k / 24).toFixed(4)),
      v: dim === 1 ? [k * 0.5] : [k * 0.25, -k * 0.25],
    }));
  const tracks = [
    { bone: 'hip', property: 'translate', keys: makeKeys(2) },
    { bone: 'chest', property: 'rotate', keys: makeKeys(1) },
    { bone: 'head', property: 'rotate', keys: makeKeys(1) },
    { group: 'brows', property: 'translatey', keys: makeKeys(1) },
    { group: 'eyes', property: 'scaley', keys: makeKeys(1) },
    { bone: 'arm_r0', property: 'rotate', keys: makeKeys(1) },
    { bone: 'arm_r1', property: 'rotate', keys: makeKeys(1) },
    { bone: 'arm_l0', property: 'rotate', keys: makeKeys(1) },
    { bone: 'arm_l1', property: 'rotate', keys: makeKeys(1) },
    { bone: 'hair_0', property: 'rotate', keys: makeKeys(1) },
    { bone: 'hair_1', property: 'rotate', keys: makeKeys(1) },
    { bone: 'skirt_0', property: 'rotate', keys: makeKeys(1) },
    { bone: 'skirt_1', property: 'rotate', keys: makeKeys(1) },
    { bone: 'leg_r', property: 'rotate', keys: makeKeys(1) },
    { bone: 'leg_l', property: 'rotate', keys: makeKeys(1) },
    { bone: 'ribbon', property: 'translate', keys: makeKeys(2) },
  ];
  const helloText = JSON.stringify({
    spec: 'rigc-motion/1',
    animations: {
      hello: {
        duration: 4.75,
        loop: false,
        tracks,
      },
    },
  });
  expect(tracks).toHaveLength(16);
  expect(tracks.reduce((sum, tr) => sum + tr.keys.length, 0)).toBe(1840);
  const clss = classifyAnimationTracks(JSON.parse(helloText), 'hello');
  const editable = clss.filter((c) => c.editable);
  expect(editable).toHaveLength(14);

  const builder = new AnimationOpBuilder(helloText);

  // 1. Moving 1 full editable track (115 keys <= 200) forward by +0.005s succeeds without neighbor collision
  const sel115 = Array.from({ length: 115 }, (_, k) => ({ track: 0, key: k }));
  builder.moveSelection('hello', sel115, 0.005);
  expect(builder.ops).toHaveLength(115);

  // Moving those 115 keys back by -0.005s coalesces all 115 ops back to base (0 ops!)
  builder.moveSelection('hello', sel115, -0.005);
  expect(builder.ops).toHaveLength(0);
  expect(builder.dirty).toBe(false);
  expect(builder.text).toBe(helloText);

  // 2. Moving a 14-frame window across all 14 editable tracks (14 × 14 = 196 keys <= 200) succeeds
  const sel196: Array<{ track: number; key: number }> = [];
  for (const et of editable) {
    for (let k = 10; k < 24; k++) sel196.push({ track: et.trackIndex, key: k });
  }
  expect(sel196).toHaveLength(196);
  builder.moveSelection('hello', sel196, 0.005);
  expect(builder.ops).toHaveLength(196);
  builder.revert();

  // 3. Moving a 15-frame window across all 14 editable tracks (14 × 15 = 210 keys > 200) refuses with ANIMATION_OPS_TOO_MANY
  const sel210: Array<{ track: number; key: number }> = [];
  for (const et of editable) {
    for (let k = 10; k < 25; k++) sel210.push({ track: et.trackIndex, key: k });
  }
  expect(sel210).toHaveLength(210);
  expect(() => builder.moveSelection('hello', sel210, 0.005)).toThrow(/ANIMATION_OPS_TOO_MANY/);
  expect(builder.ops).toHaveLength(0);
  expect(builder.text).toBe(helloText);

  // 4. Moving 2 full editable tracks (2 × 115 = 230 keys > 200) or all 14 editable tracks (1,610 keys > 200) refuses
  const sel230 = [
    ...Array.from({ length: 115 }, (_, k) => ({ track: 0, key: k })),
    ...Array.from({ length: 115 }, (_, k) => ({ track: 1, key: k })),
  ];
  expect(() => builder.moveSelection('hello', sel230, 0.005)).toThrow(/ANIMATION_OPS_TOO_MANY/);
  const sel1610 = editable.flatMap((et) => Array.from({ length: 115 }, (_, k) => ({ track: et.trackIndex, key: k })));
  expect(sel1610).toHaveLength(1610);
  expect(() => builder.moveSelection('hello', sel1610, 0.005)).toThrow(/ANIMATION_OPS_TOO_MANY/);
  expect(builder.ops).toHaveLength(0);
  expect(builder.text).toBe(helloText);
});

test('animationPreviewAdjust writes overlaid bone locals within Math.fround and leaves unedited bones untouched', () => {
  const baseText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
  const baseInspection: AnimationInspection = {
    name: 'smile',
    duration: 0.7,
    bones: [
      { name: 'head', rotation: 5, x: 10, y: -4, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
      { name: 'neck', rotation: -2, x: 0, y: 12, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
    ],
    slots: [],
    tracks: [],
  };
  const builder = new AnimationOpBuilder(baseText);
  // Track 0 on smile is head.rotate
  builder.apply({ op: 'set_key_value', animation: 'smile', track: 0, key: 1, channel: 0, value: 18.5 });
  const overlaid = overlayDraftOnInspection(baseInspection, builder.text);
  const adjust = animationPreviewAdjust(overlaid, new Set(['head']), false)!;
  expect(adjust).toBeFunction();

  const poseHead = { rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
  const poseNeck = { rotation: -2, x: 0, y: 12, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
  adjust(
    {
      names: ['head', 'neck'],
      bone: (name: string) => (name === 'head' ? poseHead : poseNeck),
    },
    { animation: 'smile', trackTime: 0.25, globalTime: 0.25 },
  );
  const expectedHead = evaluateBoneLocals(overlaid, 'head', 0.25);
  expect(Math.fround(poseHead.rotation)).toBe(Math.fround(expectedHead.rotation));
  expect(Math.fround(poseHead.x)).toBe(Math.fround(expectedHead.x));
  expect(Math.fround(poseHead.y)).toBe(Math.fround(expectedHead.y));
  expect(poseNeck).toEqual({ rotation: -2, x: 0, y: 12, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 });
});

class StubElement extends EventTarget {
  tagName: string;
  id = '';
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  step = '';
  min = '';
  max = '';
  title = '';
  textContent = '';
  selected = false;
  selectedIndex = 0;
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 800;
  clientHeight = 200;
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  classes = new Set<string>();
  children: StubElement[] = [];
  parentElement: StubElement | null = null;
  onclick: ((e?: Event) => void) | null = null;
  onchange: (() => void) | null = null;
  style: Record<string, string> = { left: '', top: '', width: '', height: '', zIndex: '' };
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
  }
  override dispatchEvent(event: Event): boolean {
    const res = super.dispatchEvent(event);
    if (event.type === 'click' && !event.defaultPrevented) this.onclick?.(event);
    return res;
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }
  classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string) => this.classes.has(name),
  };
  get options(): StubElement[] {
    return this.children.filter((c) => c.tagName === 'OPTION');
  }
  append(...nodes: (StubElement | string)[]) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.textContent += n;
        continue;
      }
      n.remove();
      n.parentElement = this;
      this.children.push(n);
    }
  }
  prepend(...nodes: StubElement[]) {
    for (const n of [...nodes].reverse()) {
      n.remove();
      n.parentElement = this;
      this.children.unshift(n);
    }
  }
  replaceChildren(...nodes: StubElement[]) {
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    this.textContent = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[camel] = v;
    }
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      delete this.dataset[camel];
    }
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  set innerHTML(html: string) {
    this.replaceChildren();
    const tagRe = /<([a-zA-Z0-9]+)\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      const tag = m[1]!;
      const attrStr = m[2]!;
      const el = new StubElement(tag);
      for (const am of attrStr.matchAll(/([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g)) {
        const ak = am[1]!;
        const av = am[2] ?? '';
        if (ak === 'class') el.className = av;
        else if (ak === 'hidden') el.hidden = true;
        else if (ak === 'disabled') el.disabled = true;
        else el.setAttribute(ak, av);
      }
      this.append(el);
    }
  }
  all(): StubElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  matches(sel: string): boolean {
    if (sel.includes(',')) return sel.split(',').some((s) => this.matches(s.trim()));
    if (sel.startsWith('.')) return this.classes.has(sel.slice(1));
    const attrM = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (attrM) {
      const k = attrM[1]!;
      const v = attrM[2];
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        if (!(camel in this.dataset)) return false;
        return v === undefined || this.dataset[camel] === v;
      }
      return v === undefined ? this.attrs.has(k) : this.attrs.get(k) === v;
    }
    return this.tagName === sel.toUpperCase();
  }
  closest<T = StubElement>(sel: string): T | null {
    let cur: StubElement | null = this;
    while (cur) {
      if (cur.matches(sel)) return cur as unknown as T;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelector<T = StubElement>(sel: string): T | null {
    return (this.all().find((el) => el.matches(sel)) as unknown as T) ?? null;
  }
  querySelectorAll<T = StubElement>(sel: string): T[] {
    return this.all().filter((el) => el.matches(sel)) as unknown as T[];
  }
}

test('AnimationInspectionPanel: Undo op after Apply previews the undone original value, and non-animation stage replacement demotes appliedOps back to pending', async () => {
  const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: null,
      createElement: (tag: string) => new StubElement(tag),
      createElementNS: (_ns: string, tag: string) => new StubElement(tag),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
    const demoHash = sha256(demoText);
    const makeModel = (headRotAt035: number) => ({
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_r', parent: 'head', x: -5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_l', parent: 'head', x: 5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'tilt',
          duration: 1.6,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 0.35, value: headRotAt035 },
                    { time: 0.95, value: 6 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    });

    const host = new StubElement('section');
    const stage = new StubElement('div');
    let lastPreviewAdjust: ReturnType<typeof animationPreviewAdjust> = null;
    let lastPreviewActive = false;

    const panel = new AnimationInspectionPanel({
      host: host as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      select: () => {},
      seek: () => {},
      project: (x, y) => ({ x, y }),
      enabled: () => true,
      preview: (adj, active) => {
        lastPreviewAdjust = adj;
        lastPreviewActive = active;
      },
      apply: async () => {},
    });

    panel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {
        sineInOut: [0.37, 0, 0.63, 1],
        quadOut: [0.25, 0.46, 0.45, 0.94],
      },
    });
    const origModel = makeModel(10);
    panel.model(origModel, 'tilt');
    panel.update(0.35, 1.6);

    // Select key 1 on track 0 (head.rotate at t=0.35, original value 10) and edit to 14.5
    expect(panel.selectKey(0, 1)).toBe(true);
    expect(panel.selectedKeyInfo()?.values[0]).toBe(10);
    const editRes = panel.setKeyValue(0, 1, 0, 14.5);
    expect(editRes.ok).toBe(true);
    expect(panel.hasUnappliedPreview()).toBe(true);
    expect(lastPreviewActive).toBe(true);
    expect(panel.overlaidInspection()!.tracks[0]!.keys[1]!.value).toBe(14.5);

    // Simulate Apply completing and swapping the stage model to rebuiltModel (value 14.5)
    const appliedOps = [...panel.ops()];
    const rebuiltModel = makeModel(14.5);
    panel.markApplied(appliedOps, 'Built');
    panel.model(rebuiltModel, 'tilt');
    expect(panel.hasUnappliedPreview()).toBe(false);
    expect(lastPreviewActive).toBe(false);
    expect(panel.overlaidInspection()!.tracks[0]!.keys[1]!.value).toBe(14.5);

    // Finding 1: Click Undo op after Apply. Builder returns to baseText (0 ops, builder.dirty === false),
    // while the stage still holds the applied build (14.5). Both the key inspector AND the overlaid
    // inspection / stage preview must reflect the undone original value (10), not the applied 14.5!
    expect(panel.undoOp()).toBe(true);
    expect(panel.ops()).toHaveLength(0);
    expect(panel.hasUnappliedPreview()).toBe(true);
    expect(panel.selectedKeyInfo()?.values[0]).toBe(10);
    expect(panel.overlaidInspection()!.tracks[0]!.keys[1]!.value).toBe(10);
    expect(lastPreviewActive).toBe(true);
    expect(lastPreviewAdjust).toBeFunction();

    // Even if a background refreshApplied() re-runs reconcileStageApplied with the stage's applied record,
    // the undone 0-op draft in this.builder must NOT be overwritten by appliedOps!
    panel.reconcileStageApplied({
      schema: 'rig-review-applied/5',
      buildId: 'b1',
      modelHash: 'h1',
      configHash: 'c1',
      animationsFrom: { path: 'animations.json', beforeSha256: demoHash, afterSha256: demoHash },
      ops: appliedOps,
      opsSha256: demoHash,
      args: [],
      producer: { package: '@rig-c/parts', version: '2.0.0' },
      compiler: { package: 'rig-c', version: '3.0.0' },
      line: null,
      check: null,
      files: null,
    });
    expect(panel.ops()).toHaveLength(0);
    expect(panel.hasUnappliedPreview()).toBe(true);
    expect(panel.overlaidInspection()!.tracks[0]!.keys[1]!.value).toBe(10);

    panel.dispose();
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('AnimationInspectionPanel: non-animation stage replacement clears stale appliedOps while preserving pending edits and re-enabling preview/Apply', async () => {
  const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: null,
      createElement: (tag: string) => new StubElement(tag),
      createElementNS: (_ns: string, tag: string) => new StubElement(tag),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
    const demoHash = sha256(demoText);
    const makeModel = (headRotAt035: number) => ({
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_r', parent: 'head', x: -5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_l', parent: 'head', x: 5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'tilt',
          duration: 1.6,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 0.35, value: headRotAt035 },
                    { time: 0.95, value: 6 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    });

    const host = new StubElement('section');
    const stage = new StubElement('div');
    let lastPreviewActive = false;

    const panel = new AnimationInspectionPanel({
      host: host as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      select: () => {},
      seek: () => {},
      project: (x, y) => ({ x, y }),
      enabled: () => true,
      preview: (_adj, active) => {
        lastPreviewActive = active;
      },
      apply: async () => {},
    });

    panel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {
        sineInOut: [0.37, 0, 0.63, 1],
        quadOut: [0.25, 0.46, 0.45, 0.94],
      },
    });
    const origModel = makeModel(10);
    const rebuiltModel = makeModel(14.5);
    panel.model(origModel, 'tilt');

    // Edit key 1 to 14.5 and mark it applied on stage
    panel.setKeyValue(0, 1, 0, 14.5);
    panel.markApplied(panel.ops(), 'Built');
    panel.model(rebuiltModel, 'tilt');
    expect(panel.hasUnappliedPreview()).toBe(false);
    const applyBtn = host.querySelector('[data-animation-apply]')!;
    const opsSummary = host.querySelector('[data-animation-ops-summary]')!;
    expect(applyBtn.disabled).toBe(true);
    expect(opsSummary.textContent).toContain('applied on stage');

    // Finding 2: Another kind of Apply (e.g. Bones/Mesh/Idle) rebuilds from the handoff and replaces
    // the stage with origModel (10), so appliedOnStage for animation is now null.
    (panel as unknown as { reconcileStageApplied?: (a: null) => void }).reconcileStageApplied?.(null);
    panel.model(origModel, 'tilt');

    // The user's animation edit (14.5) must NOT be wiped out, and the stale "applied on stage" marker
    // must be cleared so the edit is pending with preview active and Apply enabled!
    expect(panel.ops()).toHaveLength(1);
    expect(panel.hasUnappliedPreview()).toBe(true);
    expect(applyBtn.disabled).toBe(false);
    expect(opsSummary.textContent).not.toContain('applied on stage');
    expect(lastPreviewActive).toBe(true);
    expect(panel.overlaidInspection()!.tracks[0]!.keys[1]!.value).toBe(14.5);

    panel.dispose();
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Slice 3b: formatSeconds, buildRulerTicks, horizontal zoom, unselected key single-gesture drag, and planted mutants for PR #255 findings', async () => {
  const { AnimationInspectionPanel, formatSeconds, buildRulerTicks } = await import('../web/animation-inspection.ts');

  // Bar 7: Clean human-readable time labels (no Float32 noise)
  expect(formatSeconds(1.600000023841858)).toBe('1.6');
  expect(formatSeconds(0.3500000238418579)).toBe('0.35');
  expect(formatSeconds(-0)).toBe('0');
  expect(formatSeconds(NaN)).toBe('0');

  // Bar 2 & 9: Ruler ticks scale with horizontal zoom and always include 0 and clean end
  const ticks1x = buildRulerTicks(1.600000023841858, 1);
  const ticks4x = buildRulerTicks(1.600000023841858, 4);
  expect(ticks1x[0]).toBe(0);
  expect(ticks1x.at(-1)).toBe(1.6);
  expect(ticks4x.length).toBeGreaterThan(ticks1x.length);
  expect(ticks4x.at(-1)).toBe(1.6);

  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: null,
      createElement: (tag: string) => new StubElement(tag),
      createElementNS: (_ns: string, tag: string) => new StubElement(tag),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
    const demoHash = sha256(demoText);
    const model = {
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'tilt',
          duration: 1.600000023841858,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 0.3500000238418579, value: 10 },
                    { time: 0.95, value: 8.5 },
                    { time: 1.3, value: -1.2 },
                    { time: 1.600000023841858, value: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    };

    const host = new StubElement('section');
    const stage = new StubElement('div');
    const panel = new AnimationInspectionPanel({
      host: host as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      select: () => {},
      seek: () => {},
      project: (x, y) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    panel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {},
    });
    panel.model(model, 'tilt');
    panel.update(0, 1.600000023841858);

    // Verify clean time labels in ruler axis and key titles (no Float32 noise)
    const axis = host.querySelector('.animation-axis')!;
    expect(axis.textContent).toBe('0 s → 1.6 s');
    const marksBefore = host.querySelectorAll('.animation-key');
    expect(marksBefore.length).toBe(5);
    expect(marksBefore[1]!.title).toContain('0.35 s');
    expect(marksBefore[4]!.title).toContain('1.6 s');
    expect(marksBefore[4]!.title).not.toContain('1.600000');

    // Bar 6: Single-gesture press-and-drag on an UNSELECTED key (selectedKey starts null)
    expect(panel.selectedKeyInfo()).toBeNull();
    const unselectedMark = marksBefore[1]!;
    const emitPointer = (type: string, clientX: number) => {
      const ev = new Event(type, { cancelable: true });
      Object.assign(ev, { isPrimary: true, button: 0, pointerId: 7, clientX });
      unselectedMark.dispatchEvent(ev);
    };
    emitPointer('pointerdown', 175);
    // Immediately selected on pointerdown without recreating .animation-key DOM nodes
    expect(panel.selectedKeyInfo()?.keyIndex).toBe(1);
    expect(host.querySelectorAll('.animation-key')[1]).toBe(unselectedMark);

    emitPointer('pointermove', 250); // 250 / 800 * 1.6 = 0.5 s
    emitPointer('pointerup', 250);
    expect(panel.ops()).toEqual([{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.5 }]);
    expect(host.querySelectorAll('.animation-key')[1]).toBe(unselectedMark);

    // Bar 9: Horizontal zoom updates zoomLevel and ruler ticks
    panel.setZoom(4);
    expect(panel.zoomLevel()).toBe(4);
    const zoomedLane = host.querySelector('.animation-lane')!;
    expect(zoomedLane.style.width).toContain('* 4');

    panel.dispose();

    // Planted mutants for PR #255 Finding 1 & Finding 2
    const srcText = readFileSync(new URL('../web/animation-inspection.ts', import.meta.url), 'utf8');
    expect(srcText).toContain('if(hasPreview&&this.builder){');

    const mutant1Ts = srcText.replace('if(hasPreview&&this.builder){', 'if(hasPreview&&this.builder&&this.builder.dirty){');
    const mutant1Js = new Bun.Transpiler({ loader: 'ts' }).transformSync(mutant1Ts);
    // Rewrite relative imports to absolute file URLs so data: module resolves cleanly
    const resolvedMutant1Js = mutant1Js
      .replaceAll('../src/', new URL('../src/', import.meta.url).href)
      .replaceAll('./', new URL('../web/', import.meta.url).href);
    const mod1 = await import('data:text/javascript;base64,' + Buffer.from(resolvedMutant1Js).toString('base64'));
    const mHost1 = new StubElement('section');
    const mStage1 = new StubElement('div');
    const mPanel1 = new mod1.AnimationInspectionPanel({
      host: mHost1,
      stage: mStage1,
      select: () => {},
      seek: () => {},
      project: (x: number, y: number) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    mPanel1.loadSource({ available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} });
    mPanel1.model(model, 'tilt');
    mPanel1.setKeyValue(0, 1, 0, 14.5);
    mPanel1.markApplied(mPanel1.ops(), 'Built');
    const rebuiltModel = structuredClone(model);
    rebuiltModel.animations[0]!.bones[0]!.timelines[0]!.keys[1]!.value = 14.5;
    mPanel1.model(rebuiltModel, 'tilt');
    mPanel1.undoOp();
    // Mutant 1 fails to overlay baseText onto baseInspection, leaving 14.5 instead of 10!
    expect(mPanel1.overlaidInspection().tracks[0].keys[1].value).toBe(14.5);
    mPanel1.dispose();
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('PR #257 review findings 1-3 (compare read-only gate, retained key live track lookup, ruler/scrub/drag domain after end moves) and planted controls', async () => {
  const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: null,
      createElement: (tag: string) => new StubElement(tag),
      createElementNS: (_ns: string, tag: string) => new StubElement(tag),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
    const demoHash = sha256(demoText);
    const model = {
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'tilt',
          duration: 1.6,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 0.35, value: 10 },
                    { time: 0.95, value: 8.5 },
                    { time: 1.3, value: -1.2 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    };

    // -------------------------------------------------------------------------
    // Finding 1: Compare mode without preview/apply is read-only by name
    // -------------------------------------------------------------------------
    const compareHost = new StubElement('section');
    const compareStage = new StubElement('div');
    const comparePanel = new AnimationInspectionPanel({
      host: compareHost as unknown as HTMLElement,
      stage: compareStage as unknown as HTMLElement,
      select: () => {},
      seek: () => {},
      project: (x, y) => ({ x, y }),
      enabled: () => true,
    });
    comparePanel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {},
    });
    comparePanel.model(model, 'tilt');
    comparePanel.update(0, 1.6);

    const compareGate = comparePanel.gateInfo();
    expect(compareGate.editable).toBe(false);
    expect(compareGate.code).toBe('ANIMATION_COMPARE_READ_ONLY');
    expect(compareGate.reason).toContain('read-only in comparison sessions');
    expect(compareHost.querySelector('[data-animation-gate]')?.textContent).toContain('ANIMATION_COMPARE_READ_ONLY');
    expect(compareHost.querySelector('[data-animation-apply]')?.disabled).toBe(true);
    expect(compareHost.querySelector('[data-insert-key]')?.disabled).toBe(true);
    expect(compareHost.querySelectorAll('.animation-lane').every((l) => l.dataset.editable === 'false')).toBe(true);

    const rTime = comparePanel.setKeyTime(0, 1, 0.5);
    expect(rTime.ok).toBe(false);
    if (!rTime.ok) expect(rTime.error).toContain('ANIMATION_COMPARE_READ_ONLY');
    const rVal = comparePanel.setKeyValue(0, 1, 0, 12);
    expect(rVal.ok).toBe(false);
    const rIns = comparePanel.insertKey(0, 0.5);
    expect(rIns.ok).toBe(false);
    const rDel = comparePanel.deleteKey(0, 1);
    expect(rDel.ok).toBe(false);
    const rMove = comparePanel.moveSelection([{ track: 0, key: 1 }], 0.1);
    expect(rMove.ok).toBe(false);
    expect(comparePanel.selectKey(0, 1)).toBe(false);
    expect(comparePanel.ops()).toHaveLength(0);
    expect(comparePanel.hasUnappliedPreview()).toBe(false);
    expect(compareHost.querySelector('[data-animation-editor-status]')?.textContent).toContain('ANIMATION_COMPARE_READ_ONLY');
    comparePanel.dispose();

    // -------------------------------------------------------------------------
    // Finding 2 & Finding 3: Retained key live track lookup & dynamic end domain
    // -------------------------------------------------------------------------
    const editHost = new StubElement('section');
    const editStage = new StubElement('div');
    const seekedTimes: number[] = [];
    const editPanel = new AnimationInspectionPanel({
      host: editHost as unknown as HTMLElement,
      stage: editStage as unknown as HTMLElement,
      select: () => {},
      seek: (t) => seekedTimes.push(t),
      project: (x, y) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    editPanel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {},
    });
    editPanel.model(model, 'tilt');
    editPanel.update(0, 1.6);

    const retainedMark = editHost.querySelectorAll('.animation-key')[1]!;
    // Retime key (0, 1) from 0.35s to 0.5s in place (skipTimelineDomRebuild: true)
    expect(editPanel.setKeyTime(0, 1, 0.5).ok).toBe(true);
    expect(editHost.querySelectorAll('.animation-key')[1]).toBe(retainedMark);

    // Finding 2: Clicking the retained key button must seek to 0.5s (not stale 0.35s)
    // and assign the live overlaid track (not the initial track with 0.35s)
    seekedTimes.length = 0;
    retainedMark.dispatchEvent(new Event('click'));
    expect(seekedTimes).toEqual([0.5]);
    const internalTrack = (editPanel as unknown as { track: { keys: Array<{ time: number }> } }).track;
    expect(internalTrack.keys[1]!.time).toBe(0.5);

    // Finding 3: Stretch the 1.6s timeline to 3.2s by retiming the last key (0, 4) in place
    expect(editPanel.setKeyTime(0, 4, 3.2).ok).toBe(true);
    expect(editHost.querySelector('.animation-axis')?.textContent).toBe('0 s → 3.2 s');
    const rulerTicksAfterStretch = editHost.querySelectorAll('.animation-ruler-tick');
    expect(rulerTicksAfterStretch.at(-1)?.textContent).toBe('3.2 s');

    // Scrubbing halfway across the 800px ruler (clientX = 400 => ratio = 0.5 => 0.5 * 3.2 = 1.6s, NOT 0.8s)
    const rulerTrack = editHost.querySelector('[data-animation-ruler-track]')!;
    seekedTimes.length = 0;
    const scrubDown = new Event('pointerdown', { cancelable: true });
    Object.assign(scrubDown, { isPrimary: true, button: 0, pointerId: 11, clientX: 400 });
    rulerTrack.dispatchEvent(scrubDown);
    const scrubUp = new Event('pointerup', { cancelable: true });
    Object.assign(scrubUp, { isPrimary: true, button: 0, pointerId: 11, clientX: 400 });
    rulerTrack.dispatchEvent(scrubUp);
    expect(seekedTimes).toEqual([1.6]);

    // Dragging retainedMark (key 1) to clientX = 200 on the 800px lane (ratio = 0.25 => 0.25 * 3.2 = 0.8s, NOT 0.4s)
    const dragDown = new Event('pointerdown', { cancelable: true });
    Object.assign(dragDown, { isPrimary: true, button: 0, pointerId: 12, clientX: 125 });
    retainedMark.dispatchEvent(dragDown);
    const dragMove = new Event('pointermove', { cancelable: true });
    Object.assign(dragMove, { isPrimary: true, button: 0, pointerId: 12, clientX: 200 });
    retainedMark.dispatchEvent(dragMove);
    const dragUp = new Event('pointerup', { cancelable: true });
    Object.assign(dragUp, { isPrimary: true, button: 0, pointerId: 12, clientX: 200 });
    retainedMark.dispatchEvent(dragUp);
    expect(editPanel.selectedKeyInfo()?.time).toBe(0.8);
    editPanel.dispose();

    // -------------------------------------------------------------------------
    // Controls (planted mutants) for Findings 1, 2, and 3
    // -------------------------------------------------------------------------
    const srcText = readFileSync(new URL('../web/animation-inspection.ts', import.meta.url), 'utf8');
    const loadMutant = async (mutatedTs: string) => {
      const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(mutatedTs);
      const resolved = js
        .replaceAll('../src/', new URL('../src/', import.meta.url).href)
        .replaceAll('./', new URL('../web/', import.meta.url).href);
      return import('data:text/javascript;base64,' + Buffer.from(resolved).toString('base64'));
    };

    // Control 1 (Finding 1 mutant: omit !this.options.apply||!this.options.preview gate check)
    expect(srcText).toContain('if(ro||!this.options.apply||!this.options.preview){');
    const modF1 = await loadMutant(
      srcText.replace('if(ro||!this.options.apply||!this.options.preview){', 'if(false){'),
    );
    const c1Host = new StubElement('section');
    const c1Panel = new modF1.AnimationInspectionPanel({
      host: c1Host,
      stage: new StubElement('div'),
      select: () => {},
      seek: () => {},
      project: (x: number, y: number) => ({ x, y }),
      enabled: () => true,
    });
    c1Panel.loadSource({ available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} });
    c1Panel.model(model, 'tilt');
    expect(c1Panel.gateInfo().editable).toBe(true); // Mutant wrongly opens editable in compare mode!
    expect(c1Panel.setKeyTime(0, 1, 0.5).ok).toBe(true); // Mutant allows fake preview edits!
    c1Panel.dispose();

    // Control 2 (Finding 2 mutant: capture stale track & key in mark click handler)
    expect(srcText).toContain('const liveTrack=this.inspection?.tracks.find(t=>t.pointer===trackPointer)??track;');
    const modF2 = await loadMutant(
      srcText
        .replaceAll('const liveTrack=this.inspection?.tracks.find(t=>t.pointer===trackPointer)??track;', 'const liveTrack=track;')
        .replaceAll('const liveKey=liveTrack.keys[liveIdx]??key;', 'const liveKey=key;'),
    );
    const c2Host = new StubElement('section');
    const c2Seeked: number[] = [];
    const c2Panel = new modF2.AnimationInspectionPanel({
      host: c2Host,
      stage: new StubElement('div'),
      select: () => {},
      seek: (t: number) => c2Seeked.push(t),
      project: (x: number, y: number) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    c2Panel.loadSource({ available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} });
    c2Panel.model(model, 'tilt');
    c2Panel.update(0, 1.6);
    const c2Mark = c2Host.querySelectorAll('.animation-key')[1]!;
    c2Panel.setKeyTime(0, 1, 0.5);
    c2Mark.dispatchEvent(new Event('click'));
    expect(c2Seeked).toEqual([0.35]); // Mutant seeks to stale 0.35s instead of retimed 0.5s!
    expect(c2Panel.track.keys[1].time).toBe(0.35); // Mutant restores stale track!
    c2Panel.dispose();

    // Control 3 (Finding 3 mutant: skip syncRulerInPlace and freeze end at 1.6 in scrub/drag)
    expect(srcText).toContain('this.syncRulerInPlace(end);');
    const modF3 = await loadMutant(
      srcText
        .replace('this.syncRulerInPlace(end);', '')
        .replace('const end=this.effectiveEnd();\n   const ratio=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));', 'const end=this.runtimeDuration;\n   const ratio=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));')
        .replace('end:this.effectiveEnd(),', 'end:this.runtimeDuration,'),
    );
    const c3Host = new StubElement('section');
    const c3Seeked: number[] = [];
    const c3Panel = new modF3.AnimationInspectionPanel({
      host: c3Host,
      stage: new StubElement('div'),
      select: () => {},
      seek: (t: number) => c3Seeked.push(t),
      project: (x: number, y: number) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    c3Panel.loadSource({ available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} });
    c3Panel.model(model, 'tilt');
    c3Panel.update(0, 1.6);
    c3Panel.setKeyTime(0, 4, 3.2);
    expect(c3Host.querySelector('.animation-axis')?.textContent).toBe('0 s → 1.6 s'); // Mutant leaves ruler at 1.6s!
    const c3Ruler = c3Host.querySelector('[data-animation-ruler-track]')!;
    const c3Scrub = new Event('pointerdown', { cancelable: true });
    Object.assign(c3Scrub, { isPrimary: true, button: 0, pointerId: 19, clientX: 400 });
    c3Ruler.dispatchEvent(c3Scrub);
    expect(c3Seeked).toEqual([0.8]); // Mutant seeks halfway to 0.8s instead of 1.6s!
    c3Panel.dispose();
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Slice 4a: loading gate before /api/rebuild resolves, read-only badge subrow separation, and Curves view Bezier handle editing + coalescing', async () => {
  const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: null,
      createElement: (tag: string) => new StubElement(tag),
      createElementNS: (_ns: string, tag: string) => new StubElement(tag),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
    const demoHash = sha256(demoText);
    const model = {
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_r', parent: 'head', x: -5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_l', parent: 'head', x: 5, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'idle',
          duration: 3.0,
          bones: [
            {
              name: 'chest',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 1.5, value: 2 },
                    { time: 3.0, value: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
        {
          name: 'tilt',
          duration: 1.6,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0, curve: [0.1, 0, 0.25, 10] },
                    { time: 0.35, value: 10, curve: [0.55, 10, 0.75, 8.5] },
                    { time: 0.95, value: 8.5 },
                    { time: 1.3, value: -1.2 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
            {
              name: 'brow_r',
              timelines: [
                {
                  name: 'translate',
                  keys: [
                    { time: 0, x: 0, y: 0 },
                    { time: 0.35, x: 0, y: -1.8 },
                    { time: 1.3, x: 0, y: -1.8 },
                    { time: 1.6, x: 0, y: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    };

    const host = new StubElement('section');
    const stage = new StubElement('div');
    const panel = new AnimationInspectionPanel({
      host: host as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      select: () => {},
      seek: () => {},
      project: (x, y) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });

    // 1. Defect 2: Before loadSource() resolves, model() shows ANIMATION_SOURCE_LOADING ("Reading the producer handoff…"), never ANIMATION_SOURCE_MISSING
    panel.model(model, 'tilt');
    expect(panel.gateInfo().code).toBe('ANIMATION_SOURCE_LOADING');
    expect(panel.gateInfo().reason).toBe('Reading the producer handoff…');
    expect(host.querySelector('[data-animation-gate]')?.textContent).toBe('Reading the producer handoff…');
    expect(host.querySelector('[data-animation-gate]')?.dataset.loading).toBe('true');

    // Once loadSource() resolves, gate becomes editable
    panel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {
        sineInOut: [0.37, 0, 0.63, 1],
        quadOut: [0.25, 0.46, 0.45, 0.94],
      },
    });
    expect(panel.gateInfo().editable).toBe(true);
    expect(host.querySelector('[data-animation-gate]')?.dataset.loading).toBeUndefined();

    // Calling setSourceLoading() returns the panel to ANIMATION_SOURCE_LOADING
    panel.setSourceLoading();
    expect(panel.gateInfo().code).toBe('ANIMATION_SOURCE_LOADING');
    panel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: demoHash,
      text: demoText,
      easings: {
        sineInOut: [0.37, 0, 0.63, 1],
        quadOut: [0.25, 0.46, 0.45, 0.94],
      },
    });

    // 2. Defect 3: On read-only clip 'idle', key lanes with keys have ZERO .animation-readonly-badge children
    panel.model(model, 'idle');
    expect(panel.gateInfo().editable).toBe(false);
    expect(panel.gateInfo().code).toBe('ANIMATION_IDLE_GOVERNED_BY_TURN_PAD');
    const idleKeyLanes = host.querySelectorAll('.animation-key-lane');
    expect(idleKeyLanes.length).toBeGreaterThan(0);
    for (const kl of idleKeyLanes) {
      expect(kl.querySelectorAll('.animation-readonly-badge')).toHaveLength(0);
    }

    // On editable clip 'tilt', brow_r.translate in compiled model is read-only with keys (not in demo.json tilt),
    // so it renders its reason in .animation-readonly-subrow below .animation-key-lane (0 badges inside .animation-key-lane)
    panel.model(model, 'tilt');
    const tiltKeyLanes = host.querySelectorAll('.animation-key-lane');
    for (const kl of tiltKeyLanes) {
      expect(kl.querySelectorAll('.animation-readonly-badge')).toHaveLength(0);
    }
    const subrows = host.querySelectorAll('.animation-readonly-subrow');
    expect(subrows).toHaveLength(1);
    expect(subrows[0]!.parentElement?.classList.contains('has-readonly-note')).toBe(true);
    expect(subrows[0]!.textContent).toContain('ANIMATION_TRACK_READ_ONLY');

    // 3. Curves view: setKeyCurve & setKeyEase + coalescing consecutive set_key_curve ops during drag
    panel.show('curves');

    // Curve controls are enabled on editable track 0 (head.rotate)
    const segSelect = host.querySelector('[data-curve-segment]')!;
    const easeSelect = host.querySelector('[data-curve-ease]')!;
    const roBadge = host.querySelector('[data-curve-readonly]')!;
    expect(segSelect.disabled).toBe(false);
    expect(easeSelect.disabled).toBe(false);
    expect(roBadge.hidden).toBe(true);

    // Switch segment 0 to named ease 'quadOut', then 'stepped', then cubic, then drag handle 1 across multiple steps
    expect(panel.setKeyEase(0, 0, 'quadOut').ok).toBe(true);
    expect(panel.ops()).toEqual([{ op: 'set_key_ease', animation: 'tilt', track: 0, key: 0, ease: 'quadOut' }]);
    expect(panel.setKeyCurve(0, 0, 'stepped').ok).toBe(true);
    expect(panel.ops()).toEqual([{ op: 'set_key_curve', animation: 'tilt', track: 0, key: 0, curve: 'stepped' }]);
    expect(panel.setKeyCurve(0, 0, [0.08, 2.0, 0.25, 8.0]).ok).toBe(true);
    expect(panel.setKeyCurve(0, 0, [0.12, 3.5, 0.28, 9.0]).ok).toBe(true);
    // Coalesced into a single set_key_curve op on (tilt, track 0, key 0)!
    expect(panel.ops()).toEqual([
      { op: 'set_key_curve', animation: 'tilt', track: 0, key: 0, curve: [0.12, 3.5, 0.28, 9] },
    ]);

    // Dragging [data-curve-handle="1"] on [data-curve-plot] updates the cubic curve in place
    const plotEl = host.querySelector('[data-curve-plot]')!;
    const setScreenMatrix = (scale: number, x: number, y: number) => {
      Object.assign(plotEl, { getScreenCTM: () => ({ inverse: () => ({ a: 1 / scale, b: 0, c: 0, d: 1 / scale, e: -x / scale, f: -y / scale }) }) });
    };
    setScreenMatrix(1, 0, 0);
    const h1 = host.querySelector('[data-curve-handle="1"]')!;
    expect(h1).toBeTruthy();
    expect(h1.dataset.editable).toBe('true');
    const pDown = new Event('pointerdown', { cancelable: true });
    Object.assign(pDown, { isPrimary: true, button: 0, pointerId: 21, clientX: 120, clientY: 80 });
    h1.dispatchEvent(pDown);
    const pMove1 = new Event('pointermove', { cancelable: true });
    Object.assign(pMove1, { isPrimary: true, button: 0, pointerId: 21, clientX: 180, clientY: 60 });
    plotEl.dispatchEvent(pMove1);
    const pMove2 = new Event('pointermove', { cancelable: true });
    Object.assign(pMove2, { isPrimary: true, button: 0, pointerId: 21, clientX: 210, clientY: 50 });
    plotEl.dispatchEvent(pMove2);
    const pUp = new Event('pointerup', { cancelable: true });
    Object.assign(pUp, { isPrimary: true, button: 0, pointerId: 21, clientX: 210, clientY: 50 });
    plotEl.dispatchEvent(pUp);
    expect(panel.ops()).toHaveLength(1);
    expect(panel.ops()[0]!.op).toBe('set_key_curve');

    // A letterboxed plot: the same viewBox point under another screen matrix writes the same curve.
    const firstCurve = () => {
      const op = panel.ops()[0];
      if (op?.op !== 'set_key_curve') throw new Error('expected a set_key_curve op');
      return op.curve;
    };
    const curveAtIdentity = firstCurve();
    setScreenMatrix(0.5, 100, 20);
    const again = host.querySelector('[data-curve-handle="1"]')!;
    const pDown2 = new Event('pointerdown', { cancelable: true });
    Object.assign(pDown2, { isPrimary: true, button: 0, pointerId: 22, clientX: 160, clientY: 60 });
    again.dispatchEvent(pDown2);
    const pMove3 = new Event('pointermove', { cancelable: true });
    Object.assign(pMove3, { isPrimary: true, button: 0, pointerId: 22, clientX: 210 * 0.5 + 100, clientY: 50 * 0.5 + 20 });
    plotEl.dispatchEvent(pMove3);
    const pUp2 = new Event('pointerup', { cancelable: true });
    Object.assign(pUp2, { isPrimary: true, button: 0, pointerId: 22, clientX: 205, clientY: 45 });
    plotEl.dispatchEvent(pUp2);
    expect(firstCurve()).toEqual(curveAtIdentity);

    // The curve selector follows both busy transitions rather than the render an Apply left behind.
    const curveSelect = host.querySelector('[data-curve-ease]') as unknown as { disabled: boolean };
    panel.busy(true);
    expect(curveSelect.disabled).toBe(true);
    panel.busy(false);
    expect(curveSelect.disabled).toBe(false);

    panel.dispose();
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Slice 4b: multi-key selection (Shift-click, box drag, group move + 1-step undo, group delete + ANIMATION_TRACK_MIN_KEYS), stage bone drag (rotate/translate on rotated & unrotated parent, unkeyed insert+set 1-step undo, named refusals), and planted mutants', async () => {
  const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      activeElement: null,
      createElement: (tag: string) => new StubElement(tag),
      createElementNS: (_ns: string, tag: string) => new StubElement(tag),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
    const demoHash = sha256(demoText);

    // 1. AnimationOpBuilder: moveSelection 1-step undo + coalescing + named refusals
    const builder = new AnimationOpBuilder(demoText);
    builder.moveSelection('smile', [{ track: 0, key: 1 }, { track: 1, key: 1 }], 0.05);
    builder.moveSelection('smile', [{ track: 0, key: 1 }, { track: 1, key: 1 }], 0.05);
    // Coalesced across consecutive moves of the same selection into 2 ops (1 per key)
    expect(builder.ops).toHaveLength(2);
    expect(builder.ops[0]).toEqual({ op: 'set_key_time', animation: 'smile', track: 0, key: 1, time: 0.35 });
    expect(builder.ops[1]).toEqual({ op: 'set_key_time', animation: 'smile', track: 1, key: 1, time: 0.35 });
    // Single undo() unwinds the entire group move back to exact baseText
    expect(builder.undo()).toBe(true);
    expect(builder.ops).toHaveLength(0);
    expect(builder.text).toBe(demoText);

    // Refusals name the target object and offending value while restoring prior state
    builder.moveSelection('smile', [{ track: 0, key: 1 }, { track: 1, key: 1 }], 0.1);
    expect(() => builder.moveSelection('smile', [{ track: 0, key: 1 }, { track: 1, key: 1 }], 2.0)).toThrow(
      /ANIMATION_KEY_ORDER: animation "smile" track 0 \("mouth\.scale"\) key 1 time 2\.35/,
    );
    expect(() => builder.moveSelection('smile', [{ track: 0, key: 1 }, { track: 1, key: 1 }], -5.0)).toThrow(
      /ANIMATION_KEY_TIME_INVALID: animation "smile" track 0 \("mouth\.scale"\) key 1 time must be a finite number >= 0, got -4\.65/,
    );
    expect(builder.ops).toHaveLength(2);
    builder.revert();

    // 2. AnimationOpBuilder: deleteSelection 1-step undo + descending index order + ANIMATION_TRACK_MIN_KEYS refusal
    builder.deleteSelection('smile', [{ track: 0, key: 1 }, { track: 0, key: 2 }, { track: 1, key: 1 }]);
    expect(builder.ops).toHaveLength(3);
    // Track 0 deleted key 2 before key 1 so indices stayed valid
    expect(builder.ops[0]).toEqual({ op: 'delete_key', animation: 'smile', track: 0, key: 2 });
    expect(builder.ops[1]).toEqual({ op: 'delete_key', animation: 'smile', track: 0, key: 1 });
    expect(builder.ops[2]).toEqual({ op: 'delete_key', animation: 'smile', track: 1, key: 1 });
    // Single undo() restores all 3 deleted keys and exact baseText
    expect(builder.undo()).toBe(true);
    expect(builder.ops).toHaveLength(0);
    expect(builder.text).toBe(demoText);

    // Deleting too many keys on a track refuses with ANIMATION_TRACK_MIN_KEYS naming track and remaining count
    expect(() =>
      builder.deleteSelection('smile', [
        { track: 1, key: 0 },
        { track: 1, key: 1 },
        { track: 1, key: 2 },
        { track: 1, key: 3 },
      ]),
    ).toThrow(/ANIMATION_TRACK_MIN_KEYS: animation "smile" track 1 \("mouth\.translatey"\) cannot delete 4 of 4 key\(s\)/);
    expect(builder.ops).toHaveLength(0);
    expect(builder.text).toBe(demoText);

    // 3. AnimationOpBuilder: insert_key + set_key_value coalescing as 1 op and 1 undo step
    const groupId = builder.beginUndoGroup();
    builder.withUndoGroup(groupId, () => {
      builder.apply({ op: 'insert_key', animation: 'tilt', track: 0, time: 0.6, value: [2.0] });
      builder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 2, channel: 0, value: 7.25 });
      builder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 2, channel: 0, value: 9.5 });
    });
    expect(builder.ops).toEqual([
      { op: 'insert_key', animation: 'tilt', track: 0, time: 0.6, value: [9.5] },
    ]);
    expect(builder.undo()).toBe(true);
    expect(builder.ops).toHaveLength(0);
    expect(builder.text).toBe(demoText);

    // 4. findBoneConstraint: identifies physics, ik, and transform constraints on bones
    const constrainedModel = {
      physics: [{ name: 'scarf_phys', bone: 'scarf2' }],
      ik: [{ name: 'leg_ik', bones: ['thigh_l', 'shin_l'], target: 'foot_goal' }],
      transform: [{ name: 'eye_aim', bones: ['pupil_l'], target: 'eye_ctrl' }],
    };
    expect(findBoneConstraint(constrainedModel, 'scarf2')).toEqual({ kind: 'physics', name: 'scarf_phys' });
    expect(findBoneConstraint(constrainedModel, 'shin_l')).toEqual({ kind: 'ik', name: 'leg_ik' });
    expect(findBoneConstraint(constrainedModel, 'pupil_l')).toEqual({ kind: 'transform', name: 'eye_aim' });
    expect(findBoneConstraint(constrainedModel, 'head')).toBeNull();
    // Verify findBoneConstraint also handles @rig-c/play's parsed constraints[].record shape
    const playParsedDoc = {
      constraints: [
        { name: 'scarf_phys', kind: 'physics', record: { name: 'scarf_phys', bone: 'scarf2' } },
        { name: 'leg_ik', kind: 'ik', record: { name: 'leg_ik', bones: ['thigh_l', 'shin_l'] } },
      ],
    };
    expect(findBoneConstraint(playParsedDoc, 'scarf2')).toEqual({ kind: 'physics', name: 'scarf_phys' });
    expect(findBoneConstraint(playParsedDoc, 'shin_l')).toEqual({ kind: 'ik', name: 'leg_ik' });

    // 5. AnimationInspectionPanel: multi-key selection, box drag, group move, group delete, and stage bone drag
    const model = {
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 30, rotation: 90, scaleX: 1, scaleY: 1 },
        { name: 'brow_r', parent: 'head', x: 10, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_l', parent: 'head', x: 10, y: -5, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'scarf2', parent: 'chest', x: 0, y: -10, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'jaw', parent: 'head', x: -5, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      physics: [{ name: 'scarf_phys', bone: 'scarf2' }],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'smile',
          duration: 1.6,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 0.3, value: 3 },
                    { time: 0.9, value: 2.5 },
                    { time: 1.3, value: -0.4 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
            {
              name: 'brow_r',
              timelines: [
                {
                  name: 'translate',
                  keys: [
                    { time: 0, x: 0, y: 0 },
                    { time: 0.3, x: 0, y: 2.2 },
                    { time: 0.9, x: 0, y: 1.8 },
                    { time: 1.3, x: 0, y: -0.3 },
                    { time: 1.6, x: 0, y: 0 },
                  ],
                },
              ],
            },
            {
              name: 'brow_l',
              timelines: [
                {
                  name: 'translate',
                  keys: [
                    { time: 0, x: 0, y: 0 },
                    { time: 0.3, x: 0, y: 2.2 },
                    { time: 0.9, x: 0, y: 1.8 },
                    { time: 1.3, x: 0, y: -0.3 },
                    { time: 1.6, x: 0, y: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    };

    const smileSourceText = JSON.stringify(
      {
        spec: 'rigc-motion/1',
        animations: {
          smile: {
            duration: 1.6,
            loop: false,
            tracks: [
              {
                bone: 'head',
                property: 'rotate',
                keys: [
                  { t: 0, v: [0] },
                  { t: 0.3, v: [3] },
                  { t: 0.9, v: [2.5] },
                  { t: 1.3, v: [-0.4] },
                  { t: 1.6, v: [0] },
                ],
              },
              {
                bone: 'brow_r',
                property: 'translate',
                keys: [
                  { t: 0, v: [0, 0] },
                  { t: 0.3, v: [0, 2.2] },
                  { t: 0.9, v: [0, 1.8] },
                  { t: 1.3, v: [0, -0.3] },
                  { t: 1.6, v: [0, 0] },
                ],
              },
              {
                bone: 'brow_l',
                property: 'translate',
                keys: [
                  { t: 0, v: [0, 0] },
                  { t: 0.3, v: [0, 2.2] },
                  { t: 0.9, v: [0, 1.8] },
                  { t: 1.3, v: [0, -0.3] },
                  { t: 1.6, v: [0, 0] },
                ],
              },
            ],
          },
        },
      },
      null,
      2,
    );
    const smileSourceHash = sha256(smileSourceText);

    const host = new StubElement('section');
    const stage = new StubElement('div');
    const seeked: number[] = [];
    const panel = new AnimationInspectionPanel({
      host: host as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      select: () => {},
      seek: (t) => seeked.push(t),
      project: (x, y) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    panel.loadSource({
      available: true,
      reason: null,
      path: 'animations.json',
      sha256: smileSourceHash,
      text: smileSourceText,
      easings: {},
    });
    panel.model(model, 'smile');
    panel.update(0.3, 1.6);

    // Shift-click multi-key selection
    expect(panel.selectKey(0, 1)).toBe(true);
    expect(panel.selectedKeysInfo()).toHaveLength(1);
    const track1Marks = host.querySelectorAll('.animation-key').filter((m) => m.dataset.sourceTrack === '1');
    const shiftClickEv = new Event('click', { cancelable: true });
    Object.assign(shiftClickEv, { shiftKey: true });
    track1Marks[1]!.dispatchEvent(shiftClickEv);
    expect(panel.selectedKeysInfo()).toHaveLength(2);
    expect(host.querySelector('[data-key-inspector-title]')?.textContent).toContain('2 keys selected');

    // Shift-clicking again toggles the key off
    track1Marks[1]!.dispatchEvent(shiftClickEv);
    expect(panel.selectedKeysInfo()).toHaveLength(1);

    // selectKeys across tracks + multi-key delete as 1 undo step
    expect(panel.selectKeys([{ track: 0, key: 1 }, { track: 1, key: 1 }])).toBe(true);
    expect(panel.selectedKeysInfo()).toHaveLength(2);
    expect(panel.deleteSelection().ok).toBe(true);
    expect(panel.ops()).toHaveLength(2);
    expect(panel.undoOp()).toBe(true);
    expect(panel.ops()).toHaveLength(0);

    // Stage bone pose: supply a live player pose snapshot where `head` is rotated +90 deg at (0, 60)
    // and `brow_r` has setup (x=10, y=5) under `head` (so world is (-5, 70)).
    const rad90 = Math.PI / 2;
    const cos90 = Math.cos(rad90); // ~0
    const sin90 = Math.sin(rad90); // 1
    const boneMap: Record<string, { x: number; y: number; active: boolean; a: number; b: number; c: number; d: number }> = {
      root: { x: 0, y: 0, active: true, a: 1, b: 0, c: 0, d: 1 },
      hip: { x: 0, y: 10, active: true, a: 1, b: 0, c: 0, d: 1 },
      chest: { x: 0, y: 30, active: true, a: 1, b: 0, c: 0, d: 1 },
      head: { x: 0, y: 60, active: true, a: cos90, b: -sin90, c: sin90, d: cos90 },
      brow_r: { x: -5, y: 70, active: true, a: cos90, b: -sin90, c: sin90, d: cos90 },
      brow_l: { x: 5, y: 70, active: true, a: cos90, b: -sin90, c: sin90, d: cos90 },
      scarf2: { x: 0, y: 20, active: true, a: 1, b: 0, c: 0, d: 1 },
      jaw: { x: 0, y: 55, active: true, a: cos90, b: -sin90, c: sin90, d: cos90 },
    };
    const mockPlayer = {
      bone: (name: string) => boneMap[name] ?? { x: 0, y: 0, active: false, a: 1, b: 0, c: 0, d: 1 },
    } as unknown as import('@rig-c/play').RigPlayer;
    const mockFrame = {} as unknown as import('@rig-c/play').PosedFrame;
    panel.capture(mockPlayer, mockFrame);

    // Stage translate on ROTATED parent (`head` at 90 deg) at existing key t=0.3s:
    // Move `brow_r` to world (2, 85).
    // Parent `head` is at (0, 60) with 90 deg rotation (a=0, b=-1, c=1, d=0).
    // World offset from `head`: wx = 2 - 0 = 2, wy = 85 - 60 = 25.
    // Inverse parent matrix gives local (lx, ly) = (25, -2).
    // Subtracting brow_r setup (x=10, y=5) gives key (dx, dy) = (15, -7).
    const rotParentRes = panel.poseBoneOnStage('brow_r', 'translate', 2, 85);
    expect(rotParentRes.ok).toBe(true);
    const browKeyAfter = panel.overlaidInspection()!.tracks.find((t) => t.target === 'brow_r')!.keys[1]!;
    expect(browKeyAfter.x).toBeCloseTo(15, 4);
    expect(browKeyAfter.y).toBeCloseTo(-7, 4);
    // Forward world position from head's matrix + (setup + key) must land within 1e-4 of (2, 85)!
    const lx = 10 + Number(browKeyAfter.x ?? 0);
    const ly = 5 + Number(browKeyAfter.y ?? 0);
    const worldX = cos90 * lx - sin90 * ly + 0;
    const worldY = sin90 * lx + cos90 * ly + 60;
    expect(Math.hypot(worldX - 2, worldY - 85)).toBeLessThan(1e-3);
    expect(panel.undoOp()).toBe(true);

    // Stage rotate at UNKEYED playhead t=0.6s inserts a key and sets its value in 1 op / 1 undo step
    panel.update(0.6, 1.6);
    const unkeyedRes = panel.poseBoneOnStage('head', 'rotate', -20, 80);
    expect(unkeyedRes.ok).toBe(true);
    expect(panel.ops()).toHaveLength(1);
    expect(panel.ops()[0]!.op).toBe('insert_key');
    expect(panel.undoOp()).toBe(true);
    expect(panel.ops()).toHaveLength(0);

    // Stage refusals:
    // - Constrained bone (`scarf2` has physics constraint `scarf_phys`) -> ANIMATION_BONE_CONSTRAINED
    const rConst = panel.poseBoneOnStage('scarf2', 'rotate', 10, 20);
    expect(rConst.ok).toBe(false);
    if (!rConst.ok) expect(rConst.error).toContain('ANIMATION_BONE_CONSTRAINED');
    // - Unkeyed bone (`jaw` has no rotate or translate track in `smile`) -> ANIMATION_BONE_NO_TRACK
    const rNoTrack = panel.poseBoneOnStage('jaw', 'rotate', 10, 55);
    expect(rNoTrack.ok).toBe(false);
    if (!rNoTrack.ok) expect(rNoTrack.error).toContain('ANIMATION_BONE_NO_TRACK');

    panel.dispose();

    // 6. Planted mutants for Slice 4b
    const opsSrc = readFileSync(new URL('../src/animation-ops.ts', import.meta.url), 'utf8');
    expect(opsSrc).toContain('this.history.at(-1)!.undoGroupId === last.undoGroupId');
    // Mutant A: disable undoGroupId loop in AnimationOpBuilder.undo() -> multi-key move/delete fails 1-step undo!
    const mutantOpsTs = opsSrc.replace(
      'this.history.at(-1)!.undoGroupId === last.undoGroupId',
      'false',
    );
    const mutantOpsJs = new Bun.Transpiler({ loader: 'ts' })
      .transformSync(mutantOpsTs)
      .replaceAll('./', new URL('../src/', import.meta.url).href);
    const modOpsMutant = await import(
      'data:text/javascript;base64,' + Buffer.from(mutantOpsJs).toString('base64')
    );
    const mBuilder = new modOpsMutant.AnimationOpBuilder(demoText);
    mBuilder.moveSelection('smile', [{ track: 0, key: 1 }, { track: 1, key: 1 }], 0.05);
    mBuilder.undo();
    // Mutant leaves 1 op still pending after 1 undo() instead of unwinding the whole group!
    expect(mBuilder.ops.length).toBe(1);

    // Mutant B: ignore parent rotation in poseBoneOnStage -> rotated parent translate lands far from cursor!
    const webSrc = readFileSync(new URL('../web/animation-inspection.ts', import.meta.url), 'utf8');
    expect(webSrc).toContain('const localX=Math.abs(det)>1e-8?(parentWorld.d*dx-parentWorld.b*dy)/det:dx;');
    const mutantWebTs = webSrc
      .replace('const localX=Math.abs(det)>1e-8?(parentWorld.d*dx-parentWorld.b*dy)/det:dx;', 'const localX=dx;')
      .replace('const localY=Math.abs(det)>1e-8?(-parentWorld.c*dx+parentWorld.a*dy)/det:dy;', 'const localY=dy;');
    const mutantWebJs = new Bun.Transpiler({ loader: 'ts' })
      .transformSync(mutantWebTs)
      .replaceAll('../src/', new URL('../src/', import.meta.url).href)
      .replaceAll('./', new URL('../web/', import.meta.url).href);
    const modWebMutant = await import(
      'data:text/javascript;base64,' + Buffer.from(mutantWebJs).toString('base64')
    );
    const mHost = new StubElement('section');
    const mStage = new StubElement('div');
    const mPanel = new modWebMutant.AnimationInspectionPanel({
      host: mHost,
      stage: mStage,
      select: () => {},
      seek: () => {},
      project: (x: number, y: number) => ({ x, y }),
      enabled: () => true,
      preview: () => {},
      apply: async () => {},
    });
    mPanel.loadSource({ available: true, reason: null, path: 'animations.json', sha256: smileSourceHash, text: smileSourceText, easings: {} });
    mPanel.model(model, 'smile');
    mPanel.update(0.3, 1.6);
    mPanel.capture(mockPlayer, mockFrame);
    mPanel.poseBoneOnStage('brow_r', 'translate', 2, 85);
    const mKey = mPanel.overlaidInspection().tracks.find((t: { target: string }) => t.target === 'brow_r').keys[1];
    const mLx = 10 + Number(mKey.x ?? 0);
    const mLy = 5 + Number(mKey.y ?? 0);
    const mWorldX = cos90 * mLx - sin90 * mLy + 0;
    const mWorldY = sin90 * mLx + cos90 * mLy + 60;
    // Mutant misses target (2, 85) by > 20 world units on a 90-degree rotated parent!
    expect(Math.hypot(mWorldX - 2, mWorldY - 85)).toBeGreaterThan(20);
    mPanel.dispose();
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('PR #260 findings: Shift-click 150ms hold does not undo selection, and distinct undo gestures never merge across apply, moveSelection, or deleteSelection', async () => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const winTarget = new EventTarget();
  const docTarget = new EventTarget();
  Object.assign(docTarget, {
    createElement: (tag: string) => new StubElement(tag),
    createElementNS: (_ns: string, tag: string) => new StubElement(tag),
  });
  Object.defineProperty(globalThis, 'document', {
    value: docTarget,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: winTarget,
    configurable: true,
    writable: true,
  });

  try {
    const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');

    // Finding 2a: Two withUndoGroup() calls with values 10 and 20 must undo to 10, not to the base value (0)
    {
      const builder = new AnimationOpBuilder(demoText);
      const g1 = builder.beginUndoGroup();
      builder.withUndoGroup(g1, () => {
        builder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 0, value: [10] });
      });
      const g2 = builder.beginUndoGroup();
      builder.withUndoGroup(g2, () => {
        builder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 0, value: [20] });
      });
      expect(builder.undo()).toBe(true);
      const afterFirstUndo = JSON.parse(builder.text).animations.tilt.tracks[0].keys[0].v;
      expect(afterFirstUndo).toEqual([10]);
      expect(builder.undo()).toBe(true);
      expect(builder.text).toBe(demoText);
    }

    // Finding 2b: Stage drag (withUndoGroup) after a numeric edit (ungrouped) on the same key must undo only the stage drag
    {
      const builder = new AnimationOpBuilder(demoText);
      builder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 0, value: [10] });
      const g1 = builder.beginUndoGroup();
      builder.withUndoGroup(g1, () => {
        builder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 0, value: [20] });
      });
      expect(builder.undo()).toBe(true);
      const afterFirstUndo = JSON.parse(builder.text).animations.tilt.tracks[0].keys[0].v;
      expect(afterFirstUndo).toEqual([10]);
      expect(builder.undo()).toBe(true);
      expect(builder.text).toBe(demoText);
    }

    // Finding 2c: moveSelection across two distinct explicit undo groups (or after a single-key move) must not merge
    {
      const builder = new AnimationOpBuilder(demoText);
      const sel = [
        { track: 0, key: 1 },
        { track: 1, key: 1 },
      ];
      const g1 = builder.beginUndoGroup();
      builder.withUndoGroup(g1, () => {
        builder.moveSelection('smile', sel, 0.05); // 0.25 -> 0.30
      });
      const g2 = builder.beginUndoGroup();
      builder.withUndoGroup(g2, () => {
        builder.moveSelection('smile', sel, 0.05); // 0.30 -> 0.35
      });
      expect(builder.undo()).toBe(true);
      const parsedAfterUndo1 = JSON.parse(builder.text).animations.smile.tracks;
      expect(parsedAfterUndo1[0].keys[1].t).toBe(0.3);
      expect(parsedAfterUndo1[1].keys[1].t).toBe(0.3);
      expect(builder.undo()).toBe(true);
      expect(builder.text).toBe(demoText);

      // Single-key move on (0, 1) followed by group move on [(0, 1), (1, 1)] must not coalesce the single-key move into the group move
      builder.apply({ op: 'set_key_time', animation: 'smile', track: 0, key: 1, time: 0.3 });
      builder.moveSelection('smile', sel, 0.05);
      expect(builder.undo()).toBe(true);
      const parsedAfterGroupUndo = JSON.parse(builder.text).animations.smile.tracks;
      expect(parsedAfterGroupUndo[0].keys[1].t).toBe(0.3);
      expect(parsedAfterGroupUndo[1].keys[1].t).toBe(0.25);
      expect(builder.undo()).toBe(true);
      expect(builder.text).toBe(demoText);
    }

    // Finding 2d: deleteSelection (and apply) returning text to baseText after an earlier gesture must not wipe earlier history
    {
      const builder = new AnimationOpBuilder(demoText);
      const g1 = builder.beginUndoGroup();
      builder.withUndoGroup(g1, () => {
        builder.apply({ op: 'insert_key', animation: 'smile', track: 0, time: 0.6, value: [1, 1] });
        builder.apply({ op: 'insert_key', animation: 'smile', track: 1, time: 0.6, value: [0] });
      });
      const textAfterInsert = builder.text;
      // Now deleteSelection removes the two newly inserted keys at index 2, returning text to demoText
      builder.deleteSelection('smile', [
        { track: 0, key: 2 },
        { track: 1, key: 2 },
      ]);
      expect(builder.text).toBe(demoText);
      // Undo must undo the deleteSelection and restore the two inserted keys!
      expect(builder.undo()).toBe(true);
      expect(builder.text).toBe(textAfterInsert);
      expect(builder.undo()).toBe(true);
      expect(builder.text).toBe(demoText);
    }

    // Finding 1: Holding Shift+pointerdown for 150ms before pointerup+click must NOT double-toggle and undo selection
    {
      const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
      const model = {
        spec: 'rigc-compiled/3',
        skeleton: { width: 100, height: 100 },
        pages: [],
        bones: [
          { name: 'head', x: 0, y: 30, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'brow_r', parent: 'head', x: 10, y: 5, rotation: 0, scaleX: 1, scaleY: 1 },
        ],
        slots: [],
        skins: [{ name: 'default', attachments: {} }],
        animations: [
          {
            name: 'smile',
            duration: 1.6,
            bones: [
              {
                name: 'head',
                timelines: [{ name: 'rotate', keys: [{ time: 0, value: 0 }, { time: 0.3, value: 3 }, { time: 1.6, value: 0 }] }],
              },
              {
                name: 'brow_r',
                timelines: [{ name: 'translate', keys: [{ time: 0, x: 0, y: 0 }, { time: 0.3, x: 0, y: 2.2 }, { time: 1.6, x: 0, y: 0 }] }],
              },
            ],
            slots: [],
          },
        ],
      };
      const smileSourceText = JSON.stringify(
        {
          spec: 'rigc-motion/1',
          animations: {
            smile: {
              duration: 1.6,
              loop: false,
              tracks: [
                { bone: 'head', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 0.3, v: [3] }, { t: 1.6, v: [0] }] },
                { bone: 'brow_r', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 0.3, v: [0, 2.2] }, { t: 1.6, v: [0, 0] }] },
              ],
            },
          },
        },
        null,
        2,
      );
      const host = new StubElement('section');
      const stage = new StubElement('div');
      const panel = new AnimationInspectionPanel({
        host: host as unknown as HTMLElement,
        stage: stage as unknown as HTMLElement,
        select: () => {},
        seek: () => {},
        project: (x, y) => ({ x, y }),
        enabled: () => true,
        preview: () => {},
        apply: async () => {},
      });
      panel.loadSource({
        available: true,
        reason: null,
        path: 'animations.json',
        sha256: sha256(smileSourceText),
        text: smileSourceText,
        easings: {},
      });
      panel.model(model, 'smile');
      panel.update(0.3, 1.6);

      expect(panel.selectKey(0, 1)).toBe(true);
      expect(panel.selectedKeysInfo()).toHaveLength(1);

      const track1Marks = host.querySelectorAll('.animation-key').filter((m) => m.dataset.sourceTrack === '1');
      const mark = track1Marks[1]!;

      const downEv = Object.assign(new Event('pointerdown', { cancelable: true }), {
        isPrimary: true,
        button: 0,
        pointerId: 11,
        shiftKey: true,
        clientX: 50,
      });
      mark.dispatchEvent(downEv);
      expect(panel.selectedKeysInfo()).toHaveLength(2);

      // Hold the mouse button for 150ms (realistic human press duration)
      await new Promise((r) => setTimeout(r, 150));

      const upEv = Object.assign(new Event('pointerup', { cancelable: true }), {
        isPrimary: true,
        button: 0,
        pointerId: 11,
        shiftKey: true,
        clientX: 50,
      });
      mark.dispatchEvent(upEv);
      const clickEv = Object.assign(new Event('click', { cancelable: true }), {
        shiftKey: true,
      });
      mark.dispatchEvent(clickEv);

      // Selection must still have 2 keys (not undone by the click on release)!
      expect(panel.selectedKeysInfo()).toHaveLength(2);
      panel.dispose();

      // Planted mutant for Finding 1: re-introduce setTimeout(..., 0) in if(e.shiftKey) -> 150ms hold undoes selection!
      const webSrc = readFileSync(new URL('../web/animation-inspection.ts', import.meta.url), 'utf8');
      expect(webSrc).toContain('if(e.shiftKey){\n    this.toggleKeySelection(trackIndex,liveIdx,trackPointer);\n    this.renderChannels();\n    return;\n   }');
      const mutantWebTs = webSrc
        .replace(
          'if(this.suppressNextKeyClick||(isEditable&&cls&&(e?.detail??0)>0)){',
          'if(this.suppressNextKeyClick){',
        )
        .replace(
          'if(e.shiftKey){\n    this.toggleKeySelection(trackIndex,liveIdx,trackPointer);\n    this.renderChannels();\n    return;\n   }',
          'if(e.shiftKey){\n    this.toggleKeySelection(trackIndex,liveIdx,trackPointer);\n    this.renderChannels();\n    setTimeout(()=>{this.suppressNextKeyClick=false;},0);\n    return;\n   }',
        );
      const mutantWebJs = new Bun.Transpiler({ loader: 'ts' })
        .transformSync(mutantWebTs)
        .replaceAll('../src/', new URL('../src/', import.meta.url).href)
        .replaceAll('./', new URL('../web/', import.meta.url).href);
      const modWebMutant = await import(
        'data:text/javascript;base64,' + Buffer.from(mutantWebJs).toString('base64')
      );
      const mHost = new StubElement('section');
      const mStage = new StubElement('div');
      const mPanel = new modWebMutant.AnimationInspectionPanel({
        host: mHost,
        stage: mStage,
        select: () => {},
        seek: () => {},
        project: (x: number, y: number) => ({ x, y }),
        enabled: () => true,
        preview: () => {},
        apply: async () => {},
      });
      mPanel.loadSource({
        available: true,
        reason: null,
        path: 'animations.json',
        sha256: sha256(smileSourceText),
        text: smileSourceText,
        easings: {},
      });
      mPanel.model(model, 'smile');
      mPanel.update(0.3, 1.6);
      mPanel.selectKey(0, 1);
      const mMark = mHost.querySelectorAll('.animation-key').filter((m) => m.dataset.sourceTrack === '1')[1]!;
      mMark.dispatchEvent(Object.assign(new Event('pointerdown', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 12, shiftKey: true, clientX: 50 }));
      await new Promise((r) => setTimeout(r, 150));
      mMark.dispatchEvent(Object.assign(new Event('pointerup', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 12, shiftKey: true, clientX: 50 }));
      mMark.dispatchEvent(Object.assign(new Event('click', { cancelable: true }), { shiftKey: true }));
      expect(mPanel.selectedKeysInfo()).toHaveLength(1);
      mPanel.dispose();

      // Planted mutant for Finding 2: remove last.undoGroupId === this.activeUndoGroupId check -> undo merges 10 and 20 to 0!
      const opsSrc = readFileSync(new URL('../src/animation-ops.ts', import.meta.url), 'utf8');
      expect(opsSrc).toContain('last.undoGroupId === this.activeUndoGroupId &&');
      const mutantOpsTs = opsSrc.replaceAll('last.undoGroupId === this.activeUndoGroupId &&', '');
      const mutantOpsJs = new Bun.Transpiler({ loader: 'ts' })
        .transformSync(mutantOpsTs)
        .replaceAll('./', new URL('../src/', import.meta.url).href);
      const modOpsMutant = await import(
        'data:text/javascript;base64,' + Buffer.from(mutantOpsJs).toString('base64')
      );
      const mBuilder = new modOpsMutant.AnimationOpBuilder(demoText);
      const mg1 = mBuilder.beginUndoGroup();
      mBuilder.withUndoGroup(mg1, () => {
        mBuilder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 0, value: [10] });
      });
      const mg2 = mBuilder.beginUndoGroup();
      mBuilder.withUndoGroup(mg2, () => {
        mBuilder.apply({ op: 'set_key_value', animation: 'tilt', track: 0, key: 0, value: [20] });
      });
      mBuilder.undo();
      expect(JSON.parse(mBuilder.text).animations.tilt.tracks[0].keys[0].v).toEqual([0]);
    }

    // Slice 4c Eye Defect 1 control: overlapping bone points on stage reach an editable bone in current mode,
    // and when two editable bones share a point, clicking cycles to the second editable bone so dragging edits it
    {
      const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
      const overlapModel = {
        spec: 'rigc-compiled/3',
        skeleton: { width: 100, height: 100 },
        pages: [],
        bones: [
          { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'neck', parent: 'root', x: -1, y: 988, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head_ctl', parent: 'neck', x: 0, y: 31, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head', parent: 'head_ctl', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head_alt', parent: 'head_ctl', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head_up', parent: 'head_ctl', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        ],
        slots: [],
        skins: [{ name: 'default', attachments: {} }],
        animations: [
          {
            name: 'tilt',
            duration: 1.6,
            bones: [
              {
                name: 'head',
                timelines: [{ name: 'rotate', keys: [{ time: 0, value: 0 }, { time: 0.35, value: 10 }, { time: 1.6, value: 0 }] }],
              },
              {
                name: 'head_alt',
                timelines: [{ name: 'rotate', keys: [{ time: 0, value: 0 }, { time: 0.35, value: -5 }, { time: 1.6, value: 0 }] }],
              },
            ],
            slots: [],
          },
        ],
      };
      const overlapSourceText = JSON.stringify(
        {
          spec: 'rigc-motion/1',
          animations: {
            tilt: {
              duration: 1.6,
              loop: false,
              tracks: [
                { bone: 'head', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 0.35, v: [10] }, { t: 1.6, v: [0] }] },
                { bone: 'head_alt', property: 'rotate', keys: [{ t: 0, v: [0] }, { t: 0.35, v: [-5] }, { t: 1.6, v: [0] }] },
              ],
            },
          },
        },
        null,
        2,
      );
      const host = new StubElement('section');
      const stage = new StubElement('div');
      let selectedBoneName = '';
      const panel = new AnimationInspectionPanel({
        host: host as unknown as HTMLElement,
        stage: stage as unknown as HTMLElement,
        select: (s) => {
          selectedBoneName = s?.kind === 'bone' ? s.name : '';
        },
        seek: () => {},
        project: (x, y) => ({ x, y }),
        enabled: () => true,
        preview: () => {},
        apply: async () => {},
      });
      panel.loadSource({
        available: true,
        reason: null,
        path: 'animations.json',
        sha256: sha256(overlapSourceText),
        text: overlapSourceText,
        easings: {},
      });
      panel.model(overlapModel, 'tilt');
      panel.update(0.35, 1.6);

      const boneMap: Record<string, { x: number; y: number; active: boolean; a: number; b: number; c: number; d: number }> = {
        root: { x: 0, y: 0, active: true, a: 1, b: 0, c: 0, d: 1 },
        neck: { x: -1, y: 988, active: true, a: 1, b: 0, c: 0, d: 1 },
        head_ctl: { x: -1, y: 1019, active: true, a: 1, b: 0, c: 0, d: 1 },
        head: { x: -1, y: 1019, active: true, a: 1, b: 0, c: 0, d: 1 },
        head_alt: { x: -1, y: 1019, active: true, a: 1, b: 0, c: 0, d: 1 },
        head_up: { x: -1, y: 1019, active: true, a: 1, b: 0, c: 0, d: 1 },
      };
      const mockPlayer = {
        bone: (name: string) => boneMap[name] ?? { x: 0, y: 0, active: false, a: 1, b: 0, c: 0, d: 1 },
      } as unknown as import('@rig-c/play').RigPlayer;
      panel.capture(mockPlayer, {} as unknown as import('@rig-c/play').PosedFrame);

      // 1. Even if pointerdown lands on `head_up` (top in source order, no track), dragging poses the first editable bone `head` (track 0) instead of refusing with ANIMATION_BONE_NO_TRACK!
      const headUpBtn = stage.querySelectorAll('.animation-bone-pick').find((b) => b.dataset.bone === 'head_up')!;
      expect(headUpBtn).toBeTruthy();
      headUpBtn.dispatchEvent(Object.assign(new Event('pointerdown', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 31, clientX: -1, clientY: 1019 }));
      headUpBtn.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 31, clientX: 25, clientY: 1040 }));
      headUpBtn.dispatchEvent(Object.assign(new Event('pointerup', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 31, clientX: 25, clientY: 1040 }));
      expect(panel.ops()).toHaveLength(1);
      expect(panel.ops()[0]!.track).toBe(0); // `head.rotate`
      expect(selectedBoneName).toBe('head');
      expect(panel.undoOp()).toBe(true);

      // 2. When two editable bones (`head` and `head_alt`) share (-1, 1019), clicking the overlapping point cycles selection from `head` to `head_alt`, and the next drag edits `head_alt` (track 1)!
      await new Promise((r) => setTimeout(r, 10));
      headUpBtn.dispatchEvent(new Event('click', { cancelable: true }));
      expect(selectedBoneName).toBe('head_alt');
      headUpBtn.dispatchEvent(Object.assign(new Event('pointerdown', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 32, clientX: -1, clientY: 1019 }));
      headUpBtn.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 32, clientX: -25, clientY: 1040 }));
      headUpBtn.dispatchEvent(Object.assign(new Event('pointerup', { cancelable: true }), { isPrimary: true, button: 0, pointerId: 32, clientX: -25, clientY: 1040 }));
      expect(panel.ops()).toHaveLength(1);
      expect(panel.ops()[0]!.track).toBe(1); // `head_alt.rotate`
      panel.dispose();
    }

    // 4. Compare per-side editing isolation (failing control first: switching sides without per-side state leaks Side B's pending ops, preview, and undo onto Side A)
    {
      const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
      const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
      const demoHash = sha256(demoText);
      const makeCompiled = (tag: string) => ({
        spec: 'rigc-compiled/3',
        skeleton: { width: 100, height: 100, tag },
        pages: [],
        bones: [
          { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head', parent: 'root', x: 0, y: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        ],
        slots: [],
        skins: [{ name: 'default', attachments: {} }],
        animations: [
          {
            name: 'tilt',
            duration: 1.6,
            bones: [
              {
                name: 'head',
                timelines: [
                  {
                    name: 'rotate',
                    keys: [
                      { time: 0, value: 0, curve: [0.1, 0, 0.25, 10] },
                      { time: 0.35, value: 10, curve: [0.55, 10, 0.75, 8.5] },
                      { time: 0.95, value: 8.5 },
                      { time: 1.3, value: -1.2 },
                      { time: 1.6, value: 0 },
                    ],
                  },
                ],
              },
            ],
            slots: [],
          },
        ],
      });
      const modelA = makeCompiled('A');
      const modelB = makeCompiled('B');
      const sourceA = { available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} };
      const sourceB = { available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} };

      const host = new StubElement('section');
      const stage = new StubElement('div');
      let picked: 'a' | 'b' = 'b';
      let readOnlyDynamic: string | null = null;
      const previews: Record<'a' | 'b', unknown> = { a: null, b: null };
      const sideStates: Record<'a' | 'b', import('../web/animation-inspection.ts').AnimationSideState | null> = { a: null, b: null };
      const panel = new AnimationInspectionPanel({
        host: host as unknown as HTMLElement,
        stage: stage as unknown as HTMLElement,
        select: () => {},
        seek: () => {},
        project: (x, y) => ({ x, y }),
        enabled: () => true,
        readOnlyReason: () => readOnlyDynamic,
        preview: (fn) => {
          previews[picked] = fn;
        },
        apply: async () => {},
      });

      // Start on Side B and perform two distinct edits on key 1 (20 deg, then 25 deg via stage pose)
      panel.loadSource(sourceB);
      panel.model(modelB, 'tilt');
      panel.update(0.35, 1.6);
      expect(panel.gateInfo().editable).toBe(true);
      const editB1 = panel.setKeyValue(0, 1, 0, 20);
      expect(editB1.ok).toBe(true);
      const editB2 = panel.poseBoneOnStage('head', 'rotate', 25, 85);
      expect(editB2.ok).toBe(true);
      expect(panel.ops()).toHaveLength(2);
      expect(previews.b).toBeTruthy();
      expect(previews.a).toBeNull();

      // Switch to Side A with per-side state export/import: Side A has 0 pending ops, base key 1 = 10 deg, and undoOp() returns false without touching Side B
      sideStates.b = panel.exportSideState();
      picked = 'a';
      panel.importSideState(sideStates.a);
      panel.loadSource(sourceA);
      panel.model(modelA, 'tilt');
      sideStates.a = panel.exportSideState();
      expect(panel.ops()).toHaveLength(0);
      expect(previews.a).toBeNull();
      expect(previews.b).toBeTruthy(); // Side B's preview stays intact on Side B
      expect((panel.overlaidInspection()?.tracks[0]?.keys[1] as { value?: number } | undefined)?.value).toBe(10);
      expect(panel.undoOp()).toBe(false);

      // Switch back to Side B: Side B's 2 ops and undo history are restored intact; one undoOp() steps back to 20 deg!
      sideStates.a = panel.exportSideState();
      picked = 'b';
      panel.importSideState(sideStates.b);
      panel.loadSource(sourceB);
      panel.model(modelB, 'tilt');
      expect(panel.ops()).toHaveLength(2);
      expect(panel.undoOp()).toBe(true);
      expect(panel.ops()).toHaveLength(1);
      expect((panel.overlaidInspection()?.tracks[0]?.keys[1] as { value?: number } | undefined)?.value).toBe(20);

      // Dynamic readOnlyReason function also gates editing when set
      readOnlyDynamic = 'READ_ONLY_SESSION: comparison is locked';
      expect(panel.gateInfo().editable).toBe(false);
      expect(panel.gateInfo().code).toBe('ANIMATION_COMPARE_READ_ONLY');

      // Planted mutant control: omitting importSideState leaks Side B's pending ops onto Side A
      readOnlyDynamic = null;
      picked = 'a';
      panel.loadSource(sourceA);
      panel.model(modelA, 'tilt');
      expect(panel.ops()).toHaveLength(1); // Mutant leaks Side B's op onto Side A!
      panel.dispose();
    }

    // 9. PR #262 Finding 1 (P1): importSideState with different bones across builds (b_only_bone on Build B)
    //    must not evaluate Build B's preview against Build A's baseInspection, nor fail with
    //    ANIMATION_INSPECTION_UNAVAILABLE: unknown bone when Build B's model is loaded on switch.
    {
      const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
      const docA = {
        spec: 'rigc-motion/1',
        animations: {
          tilt: {
            duration: 1,
            tracks: [
              {
                bone: 'head',
                property: 'rotate',
                keys: [
                  { t: 0, v: [0] },
                  { t: 0.5, v: [10] },
                  { t: 1, v: [0] },
                ],
              },
            ],
          },
        },
      };
      const docB = {
        spec: 'rigc-motion/1',
        animations: {
          tilt: {
            duration: 1,
            tracks: [
              {
                bone: 'head',
                property: 'rotate',
                keys: [
                  { t: 0, v: [0] },
                  { t: 0.5, v: [10] },
                  { t: 1, v: [0] },
                ],
              },
              {
                bone: 'b_only_bone',
                property: 'rotate',
                keys: [
                  { t: 0, v: [0] },
                  { t: 0.5, v: [15] },
                  { t: 1, v: [0] },
                ],
              },
            ],
          },
        },
      };
      const textA = JSON.stringify(docA, null, 2) + '\n';
      const textB = JSON.stringify(docB, null, 2) + '\n';
      const sourceA = { available: true, reason: null, path: 'animations.json', sha256: sha256(textA), text: textA, easings: {} };
      const sourceB = { available: true, reason: null, path: 'animations.json', sha256: sha256(textB), text: textB, easings: {} };
      const modelA = {
        spec: 'rigc-compiled/3',
        skeleton: { width: 100, height: 100 },
        pages: [],
        bones: [
          { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head', parent: 'root', x: 0, y: 60, rotation: 0, scaleX: 1, scaleY: 1 },
        ],
        slots: [],
        skins: [{ name: 'default', attachments: {} }],
        animations: [
          {
            name: 'tilt',
            duration: 1,
            bones: [
              {
                name: 'head',
                timelines: [
                  {
                    name: 'rotate',
                    keys: [
                      { time: 0, value: 0 },
                      { time: 0.5, value: 10 },
                      { time: 1, value: 0 },
                    ],
                  },
                ],
              },
            ],
            slots: [],
          },
        ],
      };
      const modelB = {
        spec: 'rigc-compiled/3',
        skeleton: { width: 100, height: 100 },
        pages: [],
        bones: [
          { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'head', parent: 'root', x: 0, y: 60, rotation: 0, scaleX: 1, scaleY: 1 },
          { name: 'b_only_bone', parent: 'head', x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        ],
        slots: [],
        skins: [{ name: 'default', attachments: {} }],
        animations: [
          {
            name: 'tilt',
            duration: 1,
            bones: [
              {
                name: 'head',
                timelines: [
                  {
                    name: 'rotate',
                    keys: [
                      { time: 0, value: 0 },
                      { time: 0.5, value: 10 },
                      { time: 1, value: 0 },
                    ],
                  },
                ],
              },
              {
                name: 'b_only_bone',
                timelines: [
                  {
                    name: 'rotate',
                    keys: [
                      { time: 0, value: 0 },
                      { time: 0.5, value: 15 },
                      { time: 1, value: 0 },
                    ],
                  },
                ],
              },
            ],
            slots: [],
          },
        ],
      };

      const host = new StubElement('section');
      const stage = new StubElement('div');
      let picked: 'a' | 'b' = 'b';
      const activeBones: Record<'a' | 'b', Record<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number; shearX: number; shearY: number }>> = {
        a: {
          root: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
          head: { x: 0, y: 60, rotation: 10, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
        },
        b: {
          root: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
          head: { x: 0, y: 60, rotation: 10, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
          b_only_bone: { x: 10, y: 20, rotation: 15, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 },
        },
      };
      const sideStates: Record<'a' | 'b', import('../web/animation-inspection.ts').AnimationSideState | null> = { a: null, b: null };
      const panel = new AnimationInspectionPanel({
        host: host as unknown as HTMLElement,
        stage: stage as unknown as HTMLElement,
        select: () => {},
        seek: () => {},
        project: (x, y) => ({ x, y }),
        enabled: () => true,
        preview: (fn) => {
          if (!fn) return;
          fn(
            {
              bone: (name: string) => {
                const b = activeBones[picked][name];
                if (!b) throw new Error(`ANIMATION_INSPECTION_UNAVAILABLE: unknown bone "${name}"`);
                return b;
              },
            } as unknown as Parameters<import('@rig-c/play').BoneAdjust>[0],
            { trackTime: 0.5, animation: 'tilt' } as unknown as Parameters<import('@rig-c/play').BoneAdjust>[1],
          );
        },
        apply: async () => {},
      });

      // Edit b_only_bone (track 1, key 1 -> 42 deg) on Build B at t = 0.5
      panel.loadSource(sourceB);
      panel.model(modelB, 'tilt');
      panel.update(0.5, 1);
      const editBOnly = panel.setKeyValue(1, 1, 0, 42);
      expect(editBOnly.ok).toBe(true);
      expect(activeBones.b.b_only_bone.rotation).toBe(42);
      sideStates.b = panel.exportSideState();

      // Switch to Build A (which has no b_only_bone)
      picked = 'a';
      panel.importSideState(sideStates.a);
      panel.loadSource(sourceA);
      panel.model(modelA, 'tilt');
      sideStates.a = panel.exportSideState();
      expect(panel.ops()).toHaveLength(0);

      // Planted mutant control first: if importSideState leaves baseInspection pointing at Build A's skeleton
      // (which lacks b_only_bone) and immediately runs syncEffectiveInspection(true), it throws
      // ANIMATION_INSPECTION_UNAVAILABLE: unknown bone "b_only_bone".
      expect(() =>
        panel.importSideState({
          ...sideStates.b!,
          baseInspection: sideStates.a!.baseInspection,
        }),
      ).toThrow(/ANIMATION_INSPECTION_UNAVAILABLE: unknown bone b_only_bone/);
      // Restore clean Side A state after mutant control
      panel.importSideState(sideStates.a);

      // Reset b_only_bone pose to 15 before switching back to Build B
      activeBones.b.b_only_bone.rotation = 15;
      picked = 'b';
      // Case 1: Destination baseInspection restored by importSideState before model() runs
      expect(() => panel.importSideState(sideStates.b)).not.toThrow();
      panel.loadSource(sourceB);
      panel.model(modelB, 'tilt');
      expect(panel.ops()).toHaveLength(1);
      expect(activeBones.b.b_only_bone.rotation).toBe(42);

      // Case 2: Destination model changed while B was unpicked (baseInspection cleared to null before importSideState)
      picked = 'a';
      panel.importSideState(sideStates.a);
      panel.loadSource(sourceA);
      panel.model(modelA, 'tilt');
      activeBones.b.b_only_bone.rotation = 15;
      picked = 'b';
      const invalidatedStateB: import('../web/animation-inspection.ts').AnimationSideState = {
        ...sideStates.b!,
        document: null,
        baseInspection: null,
      };
      expect(() => panel.importSideState(invalidatedStateB)).not.toThrow();
      panel.loadSource(sourceB);
      panel.model(modelB, 'tilt');
      expect(panel.ops()).toHaveLength(1);
      expect(activeBones.b.b_only_bone.rotation).toBe(42);
      panel.dispose();
    }

    // 10. PR #262 Finding 2 (P2): Resetting an applied Build A and picking Build B during the async
    //     resetRebuild() await must not wipe Build B's pending edits or copy Build B's builder into Build A.
    const compiledTilt6Bones = {
      spec: 'rigc-compiled/3',
      skeleton: { width: 100, height: 100 },
      pages: [],
      bones: [
        { name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'hip', parent: 'root', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'chest', parent: 'hip', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'head', parent: 'chest', x: 0, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_r', parent: 'head', x: 6, y: 6, rotation: 0, scaleX: 1, scaleY: 1 },
        { name: 'brow_l', parent: 'head', x: -6, y: 6, rotation: 0, scaleX: 1, scaleY: 1 },
      ],
      slots: [],
      skins: [{ name: 'default', attachments: {} }],
      animations: [
        {
          name: 'tilt',
          duration: 1.6,
          bones: [
            {
              name: 'head',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0, curve: [0.1, 0, 0.25, 10] },
                    { time: 0.35, value: 10, curve: [0.55, 10, 0.75, 8.5] },
                    { time: 0.95, value: 8.5 },
                    { time: 1.3, value: -1.2 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
            {
              name: 'chest',
              timelines: [
                {
                  name: 'rotate',
                  keys: [
                    { time: 0, value: 0 },
                    { time: 0.45, value: 3.5 },
                    { time: 1.6, value: 0 },
                  ],
                },
              ],
            },
          ],
          slots: [],
        },
      ],
    };
    {
      const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
      const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
      const demoHash = sha256(demoText);
      const source = { available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} };
      const compiled = compiledTilt6Bones;

      // Planted mutant control first: unconditional resetEdits() + exportSideState() after await wipes B and corrupts A
      {
        const hostM = new StubElement('section');
        const stageM = new StubElement('div');
        let pickedM: 'a' | 'b' = 'a';
        const sideStatesM: Record<'a' | 'b', import('../web/animation-inspection.ts').AnimationSideState | null> = { a: null, b: null };
        const panelM = new AnimationInspectionPanel({
          host: hostM as unknown as HTMLElement,
          stage: stageM as unknown as HTMLElement,
          select: () => {},
          seek: () => {},
          project: (x, y) => ({ x, y }),
          enabled: () => true,
          preview: () => {},
          apply: async () => {},
        });
        panelM.loadSource(source);
        panelM.model(compiled, 'tilt');
        panelM.setKeyValue(0, 1, 0, 18);
        panelM.reconcileStageApplied({ ops: [...panelM.ops()] } as unknown as Parameters<typeof panelM.reconcileStageApplied>[0]);
        sideStatesM.a = panelM.exportSideState();

        // Simulate user starting reset on A, then switching to B and editing B during await
        pickedM = 'b';
        panelM.importSideState(sideStatesM.b);
        panelM.loadSource(source);
        panelM.model(compiled, 'tilt');
        panelM.setKeyValue(0, 1, 0, 33);
        sideStatesM.b = panelM.exportSideState();
        expect(panelM.ops()).toHaveLength(1);

        // Mutant completion of A's reset touches shared panelM unconditionally and exports into A:
        panelM.resetEdits();
        sideStatesM.a = panelM.exportSideState();
        expect(panelM.ops()).toHaveLength(0); // Mutant wiped B's pending edit!
        panelM.dispose();
      }

      // Fixed side-bound completion: reset on A updates A's sideState and only touches the shared panel if pickedSide === 'a'
      {
        const host = new StubElement('section');
        const stage = new StubElement('div');
        let picked: 'a' | 'b' = 'a';
        const sideStates: Record<'a' | 'b', import('../web/animation-inspection.ts').AnimationSideState | null> = { a: null, b: null };
        const panel = new AnimationInspectionPanel({
          host: host as unknown as HTMLElement,
          stage: stage as unknown as HTMLElement,
          select: () => {},
          seek: () => {},
          project: (x, y) => ({ x, y }),
          enabled: () => true,
          preview: () => {},
          apply: async () => {},
        });
        panel.loadSource(source);
        panel.model(compiled, 'tilt');
        panel.setKeyValue(0, 1, 0, 18);
        panel.reconcileStageApplied({ ops: [...panel.ops()] } as unknown as Parameters<typeof panel.reconcileStageApplied>[0]);
        sideStates.a = panel.exportSideState();

        let resolveReset!: () => void;
        const resetPromise = new Promise<void>((r) => {
          resolveReset = r;
        });

        const resetAnimationBuildForSide = async () => {
          const side = picked;
          panel.resetEdits();
          sideStates[side] = panel.exportSideState();
          await resetPromise;
          if (sideStates[side]) {
            sideStates[side] = {
              ...sideStates[side]!,
              appliedOps: [],
              editorStatus: { text: 'Showing inspected build.', error: false },
            };
          }
          if (picked === side) {
            panel.resetEdits();
            panel.setEditorStatus('Showing inspected build.', false);
            sideStates[side] = panel.exportSideState();
          }
        };

        const inflight = resetAnimationBuildForSide();

        // While A's resetRebuild is awaiting, switch to B and make a pending edit (33 deg)
        picked = 'b';
        panel.importSideState(sideStates.b);
        panel.loadSource(source);
        panel.model(compiled, 'tilt');
        const editB = panel.setKeyValue(0, 1, 0, 33);
        expect(editB.ok).toBe(true);
        sideStates.b = panel.exportSideState();

        // Complete A's resetRebuild while B is still picked
        resolveReset();
        await inflight;

        // B's pending edit on the visible panel is untouched, and A's sideState has 0 ops!
        expect(panel.ops()).toHaveLength(1);
        expect((panel.ops()[0] as { value?: number }).value).toBe(33);
        expect(sideStates.a?.appliedOps).toEqual([]);
        expect(sideStates.a?.builder?.ops).toEqual([]);

        // Switching back to A shows 0 ops on A
        sideStates.b = panel.exportSideState();
        picked = 'a';
        panel.importSideState(sideStates.a);
        panel.loadSource(source);
        panel.model(compiled, 'tilt');
        expect(panel.ops()).toHaveLength(0);
        panel.dispose();
      }
    }

    // 11. PR #262 Finding 3 (P2): redraw() during playback must not re-parse the motion document
    //     on every frame per bone (0 JSON.parse calls per presented playback frame, whether bonePoints
    //     are hidden or shown).
    {
      const { AnimationInspectionPanel } = await import('../web/animation-inspection.ts');
      const demoText = readFileSync(new URL('./fixtures/motion/demo.json', import.meta.url), 'utf8');
      const demoHash = sha256(demoText);
      const source = { available: true, reason: null, path: 'animations.json', sha256: demoHash, text: demoText, easings: {} };
      const compiled = compiledTilt6Bones;
      const boneNames = ['root', 'hip', 'chest', 'head', 'brow_r', 'brow_l'];

      const host = new StubElement('section');
      const stage = new StubElement('div');
      const panel = new AnimationInspectionPanel({
        host: host as unknown as HTMLElement,
        stage: stage as unknown as HTMLElement,
        select: () => {},
        seek: () => {},
        project: (x, y) => ({ x, y }),
        enabled: () => true,
        preview: () => {},
        apply: async () => {},
      });

      panel.loadSource(source);
      panel.model(compiled, 'tilt');

      const stubPlayer = {
        bone: (_name: string) => ({ x: 0, y: 10, active: true, a: 1, b: 0, c: 0, d: 1 }),
      } as unknown as Pick<import('@rig-c/play').RigPlayer, 'bone'>;
      const stubFrame = {} as unknown as import('@rig-c/play').PosedFrame;

      // Warm initial render / classification cache once outside the frame loop
      panel.capture(stubPlayer, stubFrame);
      panel.redraw(true);

      const origParse = JSON.parse;
      let parseCountHidden = 0;
      let parseCountVisible = 0;

      // Planted mutant control: uncached per-bone classification in redraw() parses (4*B + E) = 26 times per redraw
      // (52 times per 2-redraw presented playback frame on the 6-bone tilt rig where B=6, E=2).
      const runUncachedMutantRedraw = () => {
        let mutantParses = 0;
        for (const bName of boneNames) {
          // isBoneEditableInMode(bName, 'rotate'): gateInfo (1 parse) + tracksInfo (1 parse) = 2 parses
          origParse(demoText);
          origParse(demoText);
          // isBoneEditableInMode(bName, 'translate'): gateInfo (1 parse) + tracksInfo (1 parse) = 2 parses
          origParse(demoText);
          origParse(demoText);
          mutantParses += 4;
          if (bName === 'head' || bName === 'chest') {
            // firstEditableTrackIndexForBone(bName, 'rotate'): tracksInfo (1 parse)
            origParse(demoText);
            mutantParses += 1;
          }
        }
        return mutantParses;
      };
      expect(runUncachedMutantRedraw() * 2).toBe(52);

      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        parseCountHidden++;
        return origParse(...args);
      }) as typeof JSON.parse;
      try {
        for (let frame = 0; frame < 10; frame++) {
          const t = (frame * 0.1) % 1.6;
          panel.update(t, 1.6);
          panel.capture(stubPlayer, stubFrame);
          panel.redraw(false);
        }
      } finally {
        JSON.parse = origParse;
      }
      expect(parseCountHidden).toBe(0);

      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        parseCountVisible++;
        return origParse(...args);
      }) as typeof JSON.parse;
      try {
        for (let frame = 0; frame < 10; frame++) {
          const t = (frame * 0.1) % 1.6;
          panel.update(t, 1.6);
          panel.capture(stubPlayer, stubFrame);
          panel.redraw(true);
        }
      } finally {
        JSON.parse = origParse;
      }
      expect(parseCountVisible).toBe(0);

      // When an edit mutates builder.text, subsequent redraw(true) calls reuse the cached draftDocument/gate/tracks (0 parses)
      const res = panel.setKeyValue(0, 1, 0, 22);
      expect(res.ok).toBe(true);
      let parseCountAfterEditRedraw = 0;
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        parseCountAfterEditRedraw++;
        return origParse(...args);
      }) as typeof JSON.parse;
      try {
        panel.redraw(true);
        panel.redraw(true);
      } finally {
        JSON.parse = origParse;
      }
      expect(parseCountAfterEditRedraw).toBe(0);
      panel.dispose();
    }
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});




