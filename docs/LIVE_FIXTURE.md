# Live fixture

Unit tests use fake producers. A card that changes what an Apply runs also needs one **live** run against the installed producers. This page is the package and the setup that run uses, so a session does not have to find them again.

## The package: parts `examples/wind`

The public [`examples/wind`](https://github.com/rig-c/parts/tree/v1.49.1/examples/wind) in rig-c/parts fits every editor block:

- cloth recipes for three tags (bottomwear, back hair, front hair), for the Cloth block;
- limbs on arms and legs, for the Cuts block and the leg lines of Retarget (FEET, STANCE, LEG-SCALE, REACH);
- `keypoints.json`, for the `--keypoints` handoff input;
- a painting and the `full` and `head` See-through layer sets, for `--source`, `--full` and `--head`;
- `expected/`, the files a build must reproduce.

It is public, so a PR may name it. Pin it to a parts tag; `examples/wind` is unchanged from v1.49.1 to v1.49.2.

## 1. The producer bench

The blocks below run in order in one shell. Start in an empty folder; every later path hangs off `BASE`, so a block works wherever the previous one left the shell.

```sh
BASE="$(pwd)"
```

Review runs the installed producers and never installs them. Keep one folder that holds the versions a card needs, and start review from it (`rig-review open` resolves the producers from its working directory):

```sh
mkdir "$BASE/review-producer" && cd "$BASE/review-producer"
npm init -y
npm i -D @rig-c/review@0.13.0 @rig-c/parts@1.78.0 @rig-c/core@2.81.0 @rig-c/pose@1.5.3
cd "$BASE"
```

**Scoped compiler prerequisite (#221).** Published Review 0.13.0 still resolves
only `rig-c`; the scoped-only bench above needs the fixed Review checkout
containing #221, or a later release that includes it. Until that release, run
`bun /absolute/path/to/review/src/cli.ts open …` from the bench in step 3 instead
of `npx rig-review open …` (install that checkout's dependencies first). After
release, replace the Review pin with that released version. The producer pins
above were checked against npm on 2026-10-30; both parts and pose depend on
`@rig-c/core`.

Bump a version here when a card needs a newer producer. Review refuses an older one by name where a flag needs it, for example `MODELING_PRODUCER_TOO_OLD` for `check --environment`.

## 2. The package, built in scratch

The pinned parts checkout fetches the example's heavy inputs with `bun run fetch-examples`:

```sh
git clone --branch v1.49.1 https://github.com/rig-c/parts.git "$BASE/parts"
cd "$BASE/parts" && bun install && bun run fetch-examples
cd "$BASE"
```

Copy the example into a scratch folder, because review refuses handoff paths outside the folder it opens. `pose.json` is needed: the config names it as `generation.control.skeleton`, and `assemble` refuses `CONFIG_FILE_PRESENT` without it.

```sh
W="$BASE/parts/examples/wind"
P="$BASE/scratch/wind"
mkdir -p "$P"
cp "$W/config.json" "$W/keypoints.json" "$W/pose.json" "$P/"
cp -R "$W/inputs" "$P/inputs"
```

Build it from the bench, then put the checked compiled model where the folder adapter looks (`build/skeleton.model.json`):

```sh
cd "$BASE/review-producer"
npx rig-parts build --config "$P/config.json" --source "$P/inputs/painting.png" \
  --full "$P/inputs/layers/full" --head "$P/inputs/layers/head" --out "$P/out"
cp -R "$P/out/check/build" "$P/build"
```

The original measurement with parts 1.49.1 and rig-c 2.64.1 took about two
minutes and ended with `build: PASS`; `out/parts.json`, `out/rig/motion.json` and
`out/rig/mesh_report.json` were byte-equal to `expected/`. That timing and byte
comparison have not been re-measured for the current producer pins.

## 3. Open it with the handoff

From the bench folder:

```sh
cd "$BASE/review-producer"
npx rig-review open "$P" --config "$P/config.json" --parts "$P/out" \
  --source "$P/inputs/painting.png" --full "$P/inputs/layers/full" --head "$P/inputs/layers/head" \
  --keypoints "$P/keypoints.json" --animation idle
```

Inside a review clone, `bun src/cli.ts open …` is the same command. In the original measurement, once the session baseline settled (about two
minutes), the editor bar read (re-measure with the current pins):

```
baseline: reproduced — rig.json d19892a32cec… = inspected d19892a32cec…
```

`--parts` is the build's output root (`out/`), not `out/parts`.

**Shorter form (#149).** `rig-review open "$P/out"` opens the build root directly, without copying `out/check/build` to `build/`. Review opens `out/check` and discovers the build's own `config.json` beside `out/`, and the open line prints its path and sha256. `--source`, `--full`, `--head` and `--keypoints` are not recorded by the build, so declare them when a card needs them, as in step 3 (`--source "$P/inputs/painting.png"`, and so on).

## Routes worth knowing

- **Whole rig.** On a reproduced baseline, a physics patch runs `rig --config` (#136).
- **Retune.** To exercise retune (#136, #139), change one number in `$P/out/rig/rig.json` (a +0.001 nudge is enough), so the baseline is not reproduced. Then a patch inside retune's scope routes to `rig-parts retune`. Keep the file the writer's text (edit the number in place, or re-serialise with `JSON.stringify(value, null, 1)` and a closing newline): any other text refuses `RETUNE_INPUT_WRITTEN` (#148). A nudge in an image, not in rig.json, refuses every retune `RETUNE_REQUEST_HELD` instead.
- **Density strip (#173).** Select `bottomwear` (a `grid` 31 entry) in the Mesh panel and build grid 40 → 120 with N 5: grid 120 refuses `REMESH_CHECK_HELD` (TIP_OVER_ROOT), the other four build. With parts 1.55.0 or later (#179), the first successful remesh records the input check and the remaining candidates reuse it over the same inspected directories; every candidate still runs its own remesh and revision check. At most four candidates run at once, including the seed. Older producers measure the input independently for each candidate. Re-measure the five-value strip against one fresh grid-40 Apply immediately before it, with wall time, CPU and machine load recorded; the acceptance bar is at most 1.3 times that Apply, or a measured blocker report. Sharing the input check alone does not establish that bar.
- **Build.** A patch under `/assemble`, `/limbs`, or `/bones` on a config with `limbs` runs `rig-parts build` (#115). So does a cloth Apply (#111).
