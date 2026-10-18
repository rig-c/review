# Compare runtime control

Original synthetic bone-only rig: no source art, slots or pages. The `probe` bone rotates and translates over the two-second `inspect` animation. `skeleton.model.json` is the unmodified result emitted by published `rig-c@2.58.1`; it is not a hand-written model envelope.

Reproduce in a temporary directory after copying rig.json and motion.json there:

```sh
mkdir images
bun add rig-c@2.58.1
bun node_modules/rig-c/bin/rigc.cjs build --rig rig.json --motion motion.json --out build --report gate.json
```

Generation gate: 52 rules, 8 measured and passed, 30 skipped for absent data, 14 outside the spine profile; zero failed. The published core entry does not link spine-core and reports official A00 roundtrip parse as SKIP. This fixture proves public runtime time/bone operations, not raster, video decode or physical deformation. Generation evidence: Nova `20261018T000642Z-d1fc76f343e642d69f831e209018f772`. Model SHA-256: `f9bdc3a428a112b7f1ca8c7578fdf1f723cf3fb2a4f56ec1772c9ee7b9113b14`.
