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

## Compare two outputs

Open two compiled packages against one explicitly selected local reference video:

```sh
bun run review -- compare /absolute/output-a /absolute/output-b --reference /absolute/reference.mp4 --animation dance
bun run check -- compare /absolute/output-a /absolute/output-b --reference /absolute/reference.mp4 --animation dance
bun run feedback -- compare /absolute/output-a /absolute/output-b --reference /absolute/reference.mp4 --animation dance
```

Both models must contain the named animation. The video is a separate read-only CLI input, served only through a fixed endpoint; it is never inserted into either package. A separate compare page uses one video playhead to seek both rigs at the same time. Frame readouts use each side's explicit producer clock; no video FPS or missing clock is inferred.

Compare feedback requires side `a` or `b` and carries both package source hashes, both exact rig/motion identities, the shared video hash and animation. A changed input on either side or in the video refuses saved feedback until restart. State stays outside all source inputs. Single-package commands and sessions retain their existing contract. See [the comparison contract](docs/REVIEW_PACKAGE.md#two-package-comparison).

## Feedback ownership

Opening leaves status **pending**. The person explicitly saves **approved**, **changes-requested**, or **pending**, checkpoint outcomes/notes, and feedback containing an inclusive frame interval, a bone/slot/rig target, defect/quality category and one-line summary. Frame numbers are entered explicitly; the app does not invent a source FPS. The primary **리뷰 제출** action saves that explicit status and feedback. JSON and issue-ready Markdown exports carry the original source binding and reproducible inspection context. Each submission records `reviewedSource`: package revision, actual viewer/runtime versions, and separate exact-byte SHA-256 plus path for the reviewed rig and motion; an absent artifact stays null. An active compiled model is the rig identity; raw skeleton JSON is evidence with playback unavailable.

New submissions validate bone/slot names against the exact loaded model; the target field offers those names. A rig target names the package id. Source-only packages cannot validate a bone/slot target and say so explicitly. When a matching animation has a declared producer clock, the inclusive interval cannot end beyond the last declared sample at or before the actual clip end. Unknown clocks keep manual frame intervals without inventing a limit. `context.interval` records the chosen interval; inspection `time`/`frame` remain separate. Older invalid feedback stays readable with per-row warnings and exports its original evidence, but cannot be resubmitted until corrected or removed.

Feedback lives under `~/.local/state/rig-c-review/`, separate from delivered files. Identity, revision and a streaming SHA-256 of the normalized manifest plus declared files/model pages bind each saved session. Changed content starts a new pending session, even without a revision bump. Restart the server after changing inputs. Saving or exporting feedback never modifies a model, authors correction keys, writes motion output or publishes an issue automatically.

After the person submits, the producing agent retrieves the stored review without needing the hashed state filename:

```sh
bun run feedback -- /absolute/path/to/output
# Or the same explicit review.json originally opened:
bun run feedback -- /absolute/path/to/package/review.json
```

This read-only command prints the session JSON, including reviewed artifact identity and feedback. The exact current-tool session wins when present. After a viewer/runtime upgrade, if that exact session is absent, the CLI can retrieve the latest saved submission over the same content with its original recorded versions and `retrieval: {kind:"prior-tools", toolsChangedSince:true, matchingSubmissions, currentTools}`. It does not migrate approval into the current UI or change saved bytes. Changed inputs still return a fresh pending session; a prior submission is never borrowed across content, revision or reviewed-artifact changes. The same lookup applies to `feedback compare`, preserving both recorded side bindings, reference identity and animation. See [historical retrieval](docs/REVIEW_PACKAGE.md#historical-feedback-retrieval) for selection and validation rules.

## Development

```sh
bun run typecheck
bun test
bun run build
```

The server bundles `web/main.ts` at startup using the pinned installed runtime, with no CDN. `build` verifies that browser bundle in memory. CI checks types, focused path/state/API tests, bundling and the demo package. Follow AGENTS.md and the global nova-run policy for full verification bundles. [DESIGN.md](docs/DESIGN.md) distinguishes the runnable foundation from future modeling touch-up and preserves the illustrative screen concept.

## Frame strip export

The strip panel exports the explicitly entered inclusive feedback interval, or all current in-memory feedback intervals, as a PNG or JSON download. Batch selections include unsaved annotations; they do not submit or approve a review. Choose a declared reference video in single-package mode and an explicit clock basis A/B in compare mode. Every selected feedback interval must identify the selected animation. Separate intervals remain separate strip groups, including overlaps.

The same export is available without a browser:

```sh
bun src/cli.ts strip /absolute/package/review.json --reference source-video --animation dance --frames 176:184 --out /absolute/external/strip.png
bun src/cli.ts strip compare /absolute/a /absolute/b --reference /absolute/reference.mp4 --animation dance --basis b --frames 176:184 --out /absolute/external/compare.png
bun src/cli.ts strip /absolute/package/review.json --reference source-video --animation dance --all-feedback --json
```

Single `--reference` is a declared video **id**; compare uses the explicitly selected local video path. `--all-feedback` reads only the exact current saved session, and retains each item's side/interval. `--json` produces a selection/provenance plan without rendering; optionally add `--out`. PNG writes an additional `.png.json` provenance sidecar with the actual decoded samples and PNG hash. Destinations must be new files outside every input package, in existing directories without symlink parents. The server exposes download blobs, never a destination-path API.

Strip times require the selected report's exact `frameTimes` and matching animation. Missing or uniform-only clocks refuse PNG with `report에 frameTimes 없음 — pose 0.30.0 이상으로 재생성`; JSON retains requested frames with `time:null`. The other compare side may lack a clock: it can still be posed at the common seconds, while its frame label stays unknown. No frame rate is inferred from frame count, duration or video metadata.

PNG export uses the pinned published `@rig-c/play` canvas player and real Node Canvas2D, with `ffmpeg` and `ffprobe` available on PATH for reference decoding. Missing capabilities fail by name. Each requested sample chooses the nearest actual decoded reference PTS (ties earlier); both rigs seek that actual PTS using the viewer's fixed step. JSON distinguishes requested time, actual PTS, delta, decoded frame index, actual player times and independently known producer frames. Requests outside the common domain refuse instead of clamping. The PNG shows source rows, chronological frame columns, and full source hashes/revisions/tool and renderer versions. Batch groups stack vertically. Exports are bounded to64 intervals,256 total frames,64 megapixels and16384 pixels per dimension; larger selections must be split.

The footer fits its measured text while retaining full hashes. RGB/dark-tint features unsupported by the published Canvas2D path refuse with `STRIP_UNSUPPORTED_TINT`; they are not silently omitted.

## One-command owner handoff

`open` validates and hashes an existing folder, starts a background loopback
instance or reuses the exact matching one, prints its hash-bound URL, and exits:

```sh
bun run open -- /absolute/output --reference /absolute/original.mp4
# Installed executable mapping:
rig-review open /absolute/output --reference /absolute/original.mp4 --animation dance
rig-review feedback /absolute/output --reference /absolute/original.mp4
rig-review open /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance
rig-review feedback /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance
```

`open` chooses an explicit `--animation` first, then the normalized report's
`animation` after validating actual model membership, then a unique actual clip
(or unique common clip in compare). Thus `rig-review open /absolute/output
--reference /absolute/original.mp4` opens a report-bound `dance` without the flag
and prints `animation: dance (from report.json)` on stderr. Conflicting A/B reports,
a stale report name or multiple clips without a report refuse by name; no first
entry, filename or frame rate supplies a guess. Explicit invalid names never fall
back. The selected clip actually initializes single playback, while an explicit
checkpoint link or later manual choice takes priority. Incompatible automatic
checkpoints do not apply another clip's time or axis. Static/source-only packages
remain inspectable without claiming clip selection; explicit unvalidatable clips
refuse. Single review sessions remain package-wide; animation selection does not
create an animation-specific approval identity. Opening never
approves a review. The command prints the matching feedback retrieval command on
stderr; stdout contains the URL alone. A selected external video takes precedence
at automatic startup; an explicit checkpoint link or manual checkpoint selection
still chooses that checkpoint's reference.

The selected video is a separate CLI capability, not a manifest path escape or a
file copied into the source package. Its name and streaming byte hash, plus the
base package hash, appear as `referenceBinding` in single review responses,
sessions and feedback exports. Use the same `--reference` when retrieving that
submission; omitting it reads the separate reference-free identity. Changed
package or reference bytes start pending state. Existing historical retrieval
preserves earlier recorded tool versions over exactly the same reference content.

The single strip panel can export the selected external video using that same
binding. Headless equivalent (the original declared-reference form stays valid):

```sh
rig-review strip /absolute/output --reference-video /absolute/original.mp4 --animation dance --frames 176:184 --out /absolute/external/strip.png
```

Only tool-owned instances with matching content, canonical input locations, tool
fingerprint and a private capability handshake are reused. The URL hash is
checked before serving the app; a stale link never selects another instance's
package. Input hashes are freshly computed, not trusted from mtime caches. Idle
open-managed workers stop after 30 minutes. Their private registry, requests and
logs live beside feedback under `~/.local/state/rig-c-review/open/`; nothing is
written into supplied folders. `RIG_REVIEW_STATE_DIR` selects another state root
outside all input packages. Existing foreground review commands still work.

No browser is opened, no LAN listener is added, and no misleading phone/QR URL is
printed: every current instance binds only `127.0.0.1`.

The printed feedback retrieval command uses POSIX shell quoting for literal path
arguments. It is not a PowerShell or cmd.exe command string.
