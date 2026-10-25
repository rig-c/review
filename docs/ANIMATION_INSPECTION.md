# Read-only animation inspection

Animate → Transport offers a timeline, a stored-curve view and a bone tree for the current compiled build. These are inspection controls: no key authoring, motion.json writes, producer operations or output/patch schema changes. Two-build comparison is outside this feature.

The timeline lists bone groups followed by slot groups, one lane per stored timeline, with a mark per key including simultaneous keys. Key times remain exact seconds. Clicking a mark seeks through the existing transport; transport movement updates its playhead. No FPS is inferred. A selected bone filters its direct bone tracks; a selected slot filters that slot's tracks. Whole rig clears the filter.

Tree, Parts and stage share selection. Enable Bone points in Animate to pick bones on stage. A bone highlights its directly attached Parts rows, including an empty set for a bone without slots; it does not select an arbitrary child slot. Clicking drawn part geometry selects its slot. Picking uses the held drawn primitives and their resolved clip. Overlapping bone points pick the last active bone in compiled source order; the tree offers exact targets. Pan gestures remain pan; the existing Setup editors keep their own handles. Bone selection is page-local; existing slot identity/bookmark behavior is unchanged.

## Curve values

Rotate, translation x/y and scale x/y read the compiled model's original numeric keys. Linear and stepped segments are drawn directly; cubic paths and handles use the stored absolute control points. Nothing refits, retimes or replaces the curve.

The **Runtime evaluation** cursor is separate. Play evaluates Bézier segments with ten pieces whose nine interior points use Float32 rounding. Its scalar can therefore sit off the exact stored cubic. Only the held scalar is drawn; there is no second generated curve. The evaluator is derived from [rig-c's implementation](https://github.com/rig-c/core/blob/v2.67.0/src/core/animation.ts), verified against the source map shipped in published Play 1.14.0. This helper is not imported from a private Play API.

The readout shows a selected track contribution and the final authored local for that property, including later overlapping timelines. The evaluator also recognizes shear channels, with the same exact numeric checks. Rotation, translation and shear add to setup; scale multiplies setup. Missing channels remain at setup. Local rotation is unwrapped: 350 → 10 passes through 180, not 0. These locals precede constraints, sliders that run later, physics and editor previews; they do not certify the final world pose or visible image. Zero setup scale is valid for forward multiplication and has no invertible channel factor. Inspect time seeks seconds only and never changes key timing.

## Validation and reproduction

The focused suite uses the published Play loader and real player, capturing locals through its public read-only adjust hook. Evaluation compares Float64 bytes at zero tolerance at fixed interval fractions and raw/Float32 key boundaries, including adjacent representable times and non-Float32-exact key values. All ten recognized timeline kinds run with linear, stepped and Bézier controls; the supported-kind table must equal the independently declared test matrix. A recurrence-constant mutation must disagree with installed Play. It covers setup transforms, overlapping timelines, zero/negative scale, holds, linear and asymmetric Bézier controls. Dropped keys and swapped controls must be detected. The sine-preview sampling bound is not used as a keyed-curve tolerance.

```sh
bun test tests/animation-inspection.test.ts tests/preview.test.ts tests/part-selection.test.ts tests/animation-selection.test.ts tests/theme.test.ts
```

`scripts/animation-inspection-fixture.ts --prepare` downloads pinned public getting-started inputs, reads installed producer signatures and checks input paths without solving. Without `--prepare`, it bootstraps the guide's hand-placed-joint route through step 9b using published parts 1.64.0 and core 2.70.0. It records commands, exits, source pins and compiled-model SHA-256 beneath `.review-state/215/guide-fixture/`. Heavy bootstrap and full suites follow the contributor Nova policy. Intermediate render/build files are removed after the checked package and receipt are retained.

`scripts/animation-inspection-browser.ts` is an explicit browser acceptance runner, separate from `bun test`. It accepts `--playwright-module`, `--browser-executable`, `--out`, and optionally `--package`/`--animation`. Without a package it uses clearly synthetic original test art. With the bootstrap's public package it checks rendered key marks, drives the actual curve readout against an independent published Play instance, exercises selection, verifies source identity and captures each view. Local reports record the exact commands and screenshot paths; screenshots alone are not numeric validation. No older-runtime matrix is added.

Public guide pin: [ce926769373977558da470973afb52fe7c32d7fc](https://github.com/rig-c/getting-started/tree/ce926769373977558da470973afb52fe7c32d7fc). Public input pin and its license: [exam 01436ee3f02c189fe1a1e9656fe62068889837f5](https://github.com/rig-c/exam/tree/01436ee3f02c189fe1a1e9656fe62068889837f5). Keep that input's LICENSE and NOTICE beside the checked package and credit its artwork when sharing captures. Producer gate success, numeric inspection equivalence and browser acceptance are separate receipts.

## Public capture receipt

[Public screenshots and the installed-package provenance receipt](https://github.com/rig-c/review/tree/main/docs/images/animation-inspection) use one checked getting-started model. The hello is linear-only; the curve capture selects its existing idle Bézier keys. Stepped interpolation is absent from that public build and is covered by explicit synthetic controls. No screenshot motion or keys were manufactured.
