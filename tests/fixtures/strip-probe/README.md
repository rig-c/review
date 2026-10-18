# Original strip probe

Synthetic red rigid region and green unweighted mesh, with a known moving region
and rotating mesh over the one-second `inspect` animation. `still` is a wrong-motion
control; `short` tests an actual decoded video sample outside a shorter clip.
The mesh-only rig is a separately compiled omission control, never a forged model.

`generate.ts` creates original solid-color PNGs, compiles both rigs through
published `rig-c@2.59.0` with the real core validation gate, and uses ffmpeg to
encode three original reference images as lossless PNG video in a MOV container
at timestamps 0, 0.5 and 1 seconds. A second original 3840×2160 flat-color
video checks reduction to the output cell before native image decode. No private
artwork, video or rig is used.

Generate on the coordinated Nova snapshot with:

```sh
bun tests/fixtures/strip-probe/generate.ts
```

The emitted gate JSON records measured/skipped rules honestly. An official
spine-core roundtrip is not claimed when the published compiler reports it skipped.
Generation and renderer acceptance evidence will be reported separately; the
presence of this source script alone is not proof a model or PNG was tested.
