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
npm i -D @rig-c/review@0.8.0 @rig-c/parts@1.49.1 rig-c@2.64.1 @rig-c/pose@0.37.0
cd "$BASE"
```

Bump a version here when a card needs a newer producer. Review refuses an older one by name where a flag needs it, for example `MODELING_PRODUCER_TOO_OLD` for `check --environment`.

## 2. The package, built in scratch

The example's heavy inputs live in rig-c/parts-examples. A parts clone copies them in with `bun run fetch-examples`:

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

The build takes about two minutes and ends with `build: PASS`. `out/parts.json`, `out/rig/motion.json` and `out/rig/mesh_report.json` are byte-equal to `expected/`.

## 3. Open it with the handoff

From the bench folder:

```sh
cd "$BASE/review-producer"
npx rig-review open "$P" --config "$P/config.json" --parts "$P/out" \
  --source "$P/inputs/painting.png" --full "$P/inputs/layers/full" --head "$P/inputs/layers/head" \
  --keypoints "$P/keypoints.json" --animation idle
```

Inside a review clone, `bun src/cli.ts open …` is the same command. Once the session baseline settles (about two minutes), the editor bar reads:

```
baseline: reproduced — rig.json d19892a32cec… = inspected d19892a32cec…
```

`--parts` is the build's output root (`out/`), not `out/parts`.

**Shorter form (#149).** `rig-review open "$P/out"` opens the build root directly, without copying `out/check/build` to `build/`. Review opens `out/check` and discovers the build's own `config.json` beside `out/`, and the open line prints its path and sha256. `--source`, `--full`, `--head` and `--keypoints` are not recorded by the build, so declare them when a card needs them, as in step 3 (`--source "$P/inputs/painting.png"`, and so on).

## Routes worth knowing

- **Whole rig.** On a reproduced baseline, a physics patch runs `rig --config` (#136).
- **Retune.** To exercise retune (#136, #139), change one number in `$P/out/rig/rig.json` (a +0.001 nudge is enough), so the baseline is not reproduced. Then a patch inside retune's scope routes to `rig-parts retune`. Keep the file the writer's text (edit the number in place, or re-serialise with `JSON.stringify(value, null, 1)` and a closing newline): any other text refuses `RETUNE_INPUT_WRITTEN` (#148). A nudge in an image, not in rig.json, refuses every retune `RETUNE_REQUEST_HELD` instead.
- **Density strip (#173).** Select `bottomwear` (a `grid` 31 entry) in the Mesh panel and build grid 40 → 120 with N 5: grid 120 refuses `REMESH_CHECK_HELD` (TIP_OVER_ROOT), the other four build. Each candidate is a whole remesh (its own baseline rig, input check and revision check), so a strip of five costs about five Applies of CPU; on a shared machine its wall clock follows the free cores.
- **Build.** A patch under `/assemble`, `/limbs`, or `/bones` on a config with `limbs` runs `rig-parts build` (#115). So does a cloth Apply (#111).
