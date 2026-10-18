# review

A reusable local workspace for a person to inspect an agent's rig output, compare source references, and export feedback ready to become an issue. The person receives a package or opens an existing output folder; the agent does not build a new viewer for each rig.

The first foundation provides modeling and motion inspection workspaces, compiled-model playback through `@rig-c/play`, local image/video/Nova pose references, checkpoints, audio audition, and saved structured feedback. **Motion is view, annotate and export only.** Navigation changes inspection time; it never retimes, authors keys, or writes `motion.json`. Modeling touch-up remains a design goal; this starter does not edit meshes, weights or source art.

## Start

Requires Bun 1.3 or later. From this checkout:

```sh
bun install
bun run demo
```

Open the printed loopback URL. The bundled original lantern study has source art, an explicitly synthetic canonical pose-sequence sample and an original synthetic chime. It has no compiled model: playback remains unavailable until a real model is supplied.

## Existing output handoff

Open the current output folder directly, without changing the producing agent or inserting a manifest:

```sh
bun run check -- /absolute/path/to/output
bun run review -- /absolute/path/to/output
```

The adapter recognizes root `skeleton.model.json` or the fixed rigc build layout `build/skeleton.model.json` (root model takes precedence), root `motion.json`, `report.json`, `skeleton.json`/`.skel`/`.atlas`, source videos (`.mp4`, `.webm`, `.mov`), image filenames containing `strip`, `contact`, `sheet`, `filmstrip` or `띠`, and canonical `*pose*.json` sequences. Model discovery checks only those two named paths; it never recursively searches directories. Model page images resolve relative to the selected model, while motion and references remain relative to the opened folder. It builds the normalized review manifest in memory and reads source files without changing them. Motion/report/skeleton evidence links are read only. A recognized `rig-pose-report/1` also supplies read-only event markers: frame-only events retain their producer interval and explicitly lack seek until a declared clock is present; explicit event seconds can seek. Empty reported categories show none, while missing fields remain missing. Report markers prefill known feedback coordinates and actual bone/slot names without creating a review decision or motion keys. It exposes each matching video/strip separately, without guessing synchronization or source-to-rig bindings.

When the report declares `fps` plus `frame0` (seconds offset) and a frame count, or exact `frameTimes[]`, the matching animation also shows a producer-frame readout and frame seek controls. Without a bounded declared clock it shows `rate unknown`; current unchanged v19 has no clock. Sample times come only from the report, and feedback context records the recalculated frame or null.

A raw `skeleton.json`/`.skel` can still be inspected as evidence, but cannot play through the compiled-model runtime. Playback requires an upstream gated rigc build's `skeleton.model.json` with portable local page images inside the opened folder. `check` validates the delivery contract and model envelope, not the upstream compiler gate or visual quality.

For a curated handoff, [REVIEW_PACKAGE.md](docs/REVIEW_PACKAGE.md) documents optional `review.json` with named checkpoints, references and angle axes:

```sh
bun run review -- /absolute/path/to/package/review.json --checkpoint silhouette
```

The server prints the exact link, for example `http://127.0.0.1:4317/?checkpoint=silhouette`. `--port 0` selects a free port. It binds only `127.0.0.1` and never opens a browser automatically. A folder containing `review.json` uses that explicit manifest.

## Feedback ownership

Opening leaves status **pending**. The person explicitly saves **approved**, **changes-requested**, or **pending**, checkpoint outcomes/notes, and feedback containing an inclusive frame interval, a bone/slot/rig target, defect/quality category and one-line summary. Frame numbers are entered explicitly; the app does not invent a source FPS. The primary **리뷰 제출** action saves that explicit status and feedback. JSON and issue-ready Markdown exports carry the original source binding and reproducible inspection context. Each submission records `reviewedSource`: package revision, actual viewer/runtime versions, and separate exact-byte SHA-256 plus path for the reviewed rig and motion; an absent artifact stays null. An active compiled model is the rig identity; raw skeleton JSON is evidence with playback unavailable.

Feedback lives under `~/.local/state/rig-c-review/`, separate from delivered files. Identity, revision and a streaming SHA-256 of the normalized manifest plus declared files/model pages bind each saved session. Changed content starts a new pending session, even without a revision bump. Restart the server after changing inputs. Saving or exporting feedback never modifies a model, authors correction keys, writes motion output or publishes an issue automatically.

After the person submits, the producing agent retrieves the stored review without needing the hashed state filename:

```sh
bun run feedback -- /absolute/path/to/output
# Or the same explicit review.json originally opened:
bun run feedback -- /absolute/path/to/package/review.json
```

This read-only command prints the session JSON, including reviewed artifact identity and feedback. It prints pending with `updatedAt: null` when no saved review exists for these exact inputs and tool versions. It neither submits a review nor changes source. A changed input gets its own pending state; use the submitted export to inspect a prior revision.

## Development

```sh
bun run typecheck
bun test
bun run build
```

The server bundles `web/main.ts` at startup using the pinned installed runtime, with no CDN. `build` verifies that browser bundle in memory. CI checks types, focused path/state/API tests, bundling and the demo package. Follow AGENTS.md and the global nova-run policy for full verification bundles. [DESIGN.md](docs/DESIGN.md) distinguishes the runnable foundation from future modeling touch-up and preserves the illustrative screen concept.
