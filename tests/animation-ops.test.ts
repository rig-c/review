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
  jsonValueSpan,
  overlayDraftOnInspection,
  retimeCurveX,
  seedCubicCurve,
  translateCurveY,
} from '../src/animation-ops.ts';

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
